// ════════════════════════════════════════════════════════════════════════════
//  MOC QUALITY GATES
//  Deterministic checks applied after the AI returns a MOC, so the record never
//  upgrades an idea into a decision or a task on the model's word alone.
//
//  - Approval gate: a decision stays "confirmed" only when its acceptance quote
//    is found in the transcript; otherwise it becomes "requires confirmation".
//  - Action gate: an action needs a commitment quote. Without one it is moved to
//    "Matters discussed / for future consideration". No invented priority,
//    due date, owner or "Done when" criterion survives.
//  - De-duplication of repeated actions and decisions.
//  - Reviewer warnings for causal claims and unqualified "agreed/approved" wording.
//
//  The result is stored alongside the MOC (moc_quality column) so the internal
//  MOC and the client MOM are both built from the same checked record.
// ════════════════════════════════════════════════════════════════════════════

const GATE_VERSION = 1;

const DECISION_STATUSES = ['confirmed', 'requires_confirmation', 'contested'];
const STATUS_LABEL = { requires_confirmation: 'Requires confirmation', contested: 'Contested' };

const str = v => (typeof v === 'string' ? v.trim() : '');
const arr = v => (Array.isArray(v) ? v : []);

// Lowercased words, letters/digits of any script, punctuation dropped
function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').split(' ').filter(t => t.length > 1);
}

// Builds a matcher over one transcript. A quote is "found" when it appears
// verbatim, or when 70%+ of its words occur together in one stretch of the
// transcript (speech-to-text punctuation and small wording drift are tolerated).
function makeQuoteMatcher(transcript) {
  const tx = tokens(transcript);
  const flat = ' ' + tx.join(' ') + ' ';
  return function quoteFound(quote) {
    const q = tokens(quote);
    if (q.length < 3) return false;                 // too short to evidence anything
    if (flat.includes(' ' + q.join(' ') + ' ')) return true;
    const need = new Map();
    for (const t of q) need.set(t, (need.get(t) || 0) + 1);
    const win = Math.ceil(q.length * 1.5);
    const target = Math.ceil(q.length * 0.7);
    const have = new Map();
    let hits = 0;
    const add = (t, d) => {
      if (!need.has(t)) return;
      const before = Math.min(have.get(t) || 0, need.get(t));
      have.set(t, (have.get(t) || 0) + d);
      hits += Math.min(have.get(t), need.get(t)) - before;
    };
    for (let i = 0; i < tx.length; i++) {
      add(tx[i], 1);
      if (i >= win) add(tx[i - win], -1);
      if (hits >= target) return true;
    }
    return false;
  };
}

function similar(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= 0.8;
}

function dedupe(list, textOf) {
  const out = [];
  let dropped = 0;
  for (const item of list) {
    if (out.some(o => similar(textOf(o), textOf(item)))) { dropped++; continue; }
    out.push(item);
  }
  return { out, dropped };
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const DONE_WHEN_RE = /\s*[—–-]+\s*Done when:.*$/i;
const CAUSAL_RE = /\b(was|were|is|are)\s+(caused|due)\b|\bbecause of\b|\bresulted from\b|\battributable to\b/i;
const APPROVAL_RE = /\b(agreed|approved|finali[sz]ed|accepted|confirmed)\b/i;

// Human-readable line for the decisions column (kept as plain strings so every
// existing screen keeps working)
function decisionLine(d) {
  const label = STATUS_LABEL[d.status];
  return label ? `[${label}] ${d.statement}` : d.statement;
}

/**
 * Applies the gates to a MOC in place and returns it.
 * mom.moc_quality = { version, decision_log, matters_discussed, key_figures, report }
 */
function applyQualityGates(mom, transcript) {
  if (!mom || typeof mom !== 'object') return mom;
  const found = makeQuoteMatcher(transcript || '');
  const report = {
    version: GATE_VERSION,
    checked_at: new Date().toISOString(),
    decisions: { confirmed: 0, requires_confirmation: 0, contested: 0, demoted: [] },
    actions: { kept: 0, requires_confirmation: 0, moved_to_matters: [], priority_removed: 0, due_cleared: 0, owner_cleared: 0, done_when_removed: 0, duplicates_removed: 0 },
    warnings: [],
  };

  const matters = arr(mom.matters_discussed)
    .map(m => (typeof m === 'string' ? { item: m } : m))
    .filter(m => m && str(m.item))
    .map(m => ({
      item: str(m.item),
      raised_by: str(m.raised_by),
      classification: ['PROPOSAL', 'OPINION', 'OPEN_QUESTION', 'WORKSTREAM', 'FACT_REPORTED'].includes(m.classification) ? m.classification : 'PROPOSAL',
      views: str(m.views),
      status: str(m.status) || 'For future consideration — not approved',
      topic: str(m.topic),
    }));

  // ── Approval gate ────────────────────────────────────────────────────────
  if (Array.isArray(mom.decision_log)) {
    const log = [];
    for (const raw of mom.decision_log) {
      if (!raw || !str(raw.statement)) continue;
      const d = {
        statement: str(raw.statement).replace(/^\[[^\]]+\]\s*/, ''),
        status: DECISION_STATUSES.includes(raw.status) ? raw.status : 'requires_confirmation',
        accepted_by: str(raw.accepted_by),
        acceptance_quote: str(raw.acceptance_quote),
        topic: str(raw.topic),
        evidence: 'not_checked',
      };
      if (d.acceptance_quote) d.evidence = found(d.acceptance_quote) ? 'found' : 'not_found';
      if (d.status === 'confirmed' && d.evidence !== 'found') {
        d.status = 'requires_confirmation';
        report.decisions.demoted.push({
          statement: d.statement,
          reason: d.acceptance_quote ? 'Acceptance quote not found in the transcript' : 'No attributable acceptance recorded',
        });
      }
      if (d.status === 'confirmed' && !d.accepted_by) d.accepted_by = 'Participants (not individually recorded)';
      log.push(d);
    }
    const { out, dropped } = dedupe(log, d => d.statement);
    if (dropped) report.warnings.push(`${dropped} repeated decision(s) removed.`);
    mom.decision_log = out;
    mom.decisions = out.map(decisionLine);
    for (const d of out) report.decisions[d.status]++;
  } else {
    // Older engine output without an evidence log — cannot be verified
    if (arr(mom.decisions).length) report.warnings.push('Decisions were not returned with evidence; review each before client circulation.');
    mom.decision_log = arr(mom.decisions).filter(s => typeof s === 'string').map(s => ({ statement: s, status: 'requires_confirmation', evidence: 'not_checked' }));
  }

  // ── Action gate ──────────────────────────────────────────────────────────
  const actions = [];
  for (const raw of arr(mom.action_items)) {
    if (!raw || !str(raw.task)) continue;
    const a = { ...raw };
    a.task = str(a.task);
    if (DONE_WHEN_RE.test(a.task)) { a.task = a.task.replace(DONE_WHEN_RE, '').trim(); report.actions.done_when_removed++; }

    const quote = str(a.commitment_quote);
    if (!quote) {
      // The suggested owner is not carried over — no one committed to it
      matters.push({ item: a.task, raised_by: '', classification: 'PROPOSAL', views: '',
        status: 'Raised in discussion — not agreed as an action', topic: str(a.topic) });
      report.actions.moved_to_matters.push(a.task);
      continue;
    }
    a.evidence = found(quote) ? 'found' : 'not_found';
    if (a.evidence !== 'found') {
      a.requires_confirmation = true;
      if (!a.status || /^(not started|pending|status not established)$/i.test(a.status)) a.status = 'Pending confirmation';
      report.actions.requires_confirmation++;
    }
    // An agreed next step is open until someone reports it done
    if (!str(a.status) || /^status not established$/i.test(a.status)) a.status = 'Pending';

    // Owner: only when the meeting named one
    if (a.owner_status === 'not_agreed' || !str(a.owner) || /^(not assigned|tbd|—|-)$/i.test(str(a.owner))) {
      if (str(a.owner) && !/^not agreed$/i.test(str(a.owner))) report.actions.owner_cleared++;
      a.owner = 'Not agreed';
    }
    // Due date: only an agreed, exact date
    const due = str(a.due_date);
    if (!(a.due_status === 'agreed' && DATE_RE.test(due))) {
      if (due && due !== 'TBD') report.actions.due_cleared++;
      a.due_date = 'TBD';
    }
    // Priority: only when stated in the meeting
    if (a.priority_source !== 'explicit') {
      if (str(a.priority)) report.actions.priority_removed++;
      a.priority = '';
    } else if (!['High', 'Medium', 'Low'].includes(a.priority)) {
      a.priority = /critical/i.test(a.priority || '') ? 'High' : '';
    }
    // Completion criterion: only when stated, with its own evidence
    if (str(a.acceptance_criteria) && !(str(a.acceptance_criteria_quote) && found(a.acceptance_criteria_quote))) {
      a.acceptance_criteria = '';
      report.actions.done_when_removed++;
    }
    actions.push(a);
  }
  const ad = dedupe(actions, a => a.task);
  report.actions.duplicates_removed = ad.dropped;
  mom.action_items = ad.out;
  report.actions.kept = ad.out.length;

  mom.matters_discussed = dedupe(matters, m => m.item).out;

  // ── Figures register ────────────────────────────────────────────────────
  mom.key_figures = arr(mom.key_figures).filter(f => f && str(f.label)).map(f => ({
    label: str(f.label), amount: str(String(f.amount ?? '')), unit: str(f.unit), basis: str(f.basis),
    period: str(f.period), approximate: !!f.approximate,
    source_type: ['participant_reported', 'dashboard', 'externally_verified'].includes(f.source_type) ? f.source_type : 'participant_reported',
    note: str(f.note),
  }));

  // ── Relevance tags on discussion entries ─────────────────────────────────
  mom.discussion_points = arr(mom.discussion_points).map(d => {
    if (!d || typeof d !== 'object') return d;
    const relevance = ['primary', 'secondary', 'incidental', 'internal'].includes(d.relevance) ? d.relevance
      : /^recommendations?$/i.test(str(d.topic)) ? 'internal' : 'primary';
    return { ...d, relevance };
  });

  // ── Reviewer warnings ───────────────────────────────────────────────────
  const scan = [str(mom.summary), ...arr(mom.executive_summary).map(str), ...arr(mom.decisions).map(str)];
  const causal = scan.filter(t => CAUSAL_RE.test(t));
  if (causal.length) report.warnings.push(`${causal.length} statement(s) state a cause; confirm the cause was established, not only suggested.`);
  if (!report.decisions.confirmed && scan.some(t => APPROVAL_RE.test(t) && !/not\s+(\w+\s+)?(agreed|approved|confirmed|finali[sz]ed)/i.test(t))) {
    report.warnings.push('Summary uses "agreed/approved" wording but no decision is confirmed by transcript evidence.');
  }
  const summaryText = [str(mom.summary), ...arr(mom.executive_summary).map(str)];
  const saysNone = summaryText.some(t => /\bno (formal |final )?decisions? (was|were)\b/i.test(t));
  if (saysNone && report.decisions.confirmed) {
    report.warnings.push('Summary says no decisions were made, but the decision log has confirmed decisions; reconcile before circulation.');
  }
  if (report.decisions.demoted.length) report.warnings.push(`${report.decisions.demoted.length} decision(s) moved to "requires confirmation".`);
  if (report.actions.moved_to_matters.length) report.warnings.push(`${report.actions.moved_to_matters.length} suggested item(s) moved from actions to matters for future consideration.`);

  mom.moc_quality = {
    version: GATE_VERSION,
    decision_log: mom.decision_log,
    matters_discussed: mom.matters_discussed,
    // Directions the discussion converged on — shown as working conclusions, not formal approvals
    working_conclusions: arr(mom.working_conclusions).map(str).filter(Boolean),
    key_figures: mom.key_figures,
    report,
  };
  return mom;
}

module.exports = { applyQualityGates, makeQuoteMatcher, decisionLine, GATE_VERSION };
