// ─────────────────────────────────────────────────────────────────────────────
// Project intelligence — the combined, versioned "project brief" built from
// every MOC in a project, plus the features that read it:
//   • brief merge (incremental) and full rebuild, with versions and approval
//   • action register and decision log that carry across meetings
//   • source citations (every item points back to the meeting(s) it came from)
//   • contradiction / drift flags, risks, open questions, key figures, timeline
//   • glossary and people list the user can edit (fed into every MOC)
//   • Ask the project (answers only from the project's meetings, with citations)
//   • Reports (status report, client update email, board note)
//   • Exports (action register CSV, printable brief) and a client-safe share view
// The approved brief is what MOC generation reads; a pending version waits for
// the user's review so nothing unreviewed becomes "project truth".
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BRIEF_MODEL = 'gpt-4o';
const BATCH_MOCS  = 4;          // MOCs merged per model call
const MOC_CHARS   = 5000;       // compact MOC text per meeting
const BRIEF_CTX_CHARS = 16000;   // brief text passed into MOC generation

const PROJECT_TYPES = {
  general:         { label: 'General',                 guide: '' },
  statutory_audit: { label: 'Statutory audit',         guide: 'Statutory audit engagement. Track the PBC (prepared-by-client) list, audit observations, management responses, adjustments proposed, materiality points and sign-off milestones. Treat document requests as actions with the client as owner.' },
  vcfo_review:     { label: 'Virtual CFO review',      guide: 'Virtual CFO engagement. Track MIS delivery, cash flow position, budget vs actual, profitability points, compliance calendar items, fund planning and decisions needing founder or board approval. Capture key figures with their dates.' },
  due_diligence:   { label: 'Due diligence',           guide: 'Due diligence engagement. Track the information request list, red flags, open queries, findings by area (financial, tax, legal, HR, commercial) and items that affect valuation or deal terms.' },
  gst_compliance:  { label: 'GST / compliance',        guide: 'GST / compliance engagement. Track returns and filings, reconciliations (GSTR-2B vs books, e-invoice, e-way bill), notices and replies, ITC issues and due dates stated in the meetings. Do not invent due dates.' },
  ecom_ops:        { label: 'E-commerce operations',   guide: 'E-commerce operations engagement. Track marketplace settlements and reconciliation, returns, TCS/TDS, GST by channel, inventory, BI reporting and integration tasks.' },
  internal_audit:  { label: 'Internal audit / ICFR',   guide: 'Internal audit / ICFR engagement. Track processes reviewed, controls (maker, checker, approver), observations with risk rating, management action plans, owners and target dates, and evidence still required.' },
};
const typeOf = k => PROJECT_TYPES[k] ? k : 'general';

const PROFILE_FIELDS = ['client_name', 'engagement', 'period', 'scope', 'our_team', 'client_team', 'standing_notes'];
const EMPTY_BRIEF = () => ({
  profile: {}, overview: '', status: 'unknown', status_reason: '',
  stakeholders: [], glossary: [], decisions: [], actions: [], risks: [],
  open_questions: [], contradictions: [], key_figures: [], timeline: [],
});

module.exports = function registerProjectIntel(app, deps) {
  const { pool, requireAuth, ownedProject, safeArr, safeObj, logUsage, COST, axios } = deps;

  // ── Tables ────────────────────────────────────────────────────────────────
  async function ensureTables() {
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'general'`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS brief_review BOOLEAN DEFAULT TRUE`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE moc_prompt_log ADD COLUMN IF NOT EXISTS context_input TEXT`);
    await pool.query(`ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS session_glossary JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS session_people JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE mom_sessions ADD COLUMN IF NOT EXISTS session_context TEXT DEFAULT ''`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_brief_versions (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL,
        user_email  TEXT NOT NULL,
        brief       JSONB NOT NULL,
        merged      JSONB DEFAULT '{}',
        status      TEXT DEFAULT 'pending',
        source      TEXT DEFAULT 'merge',
        note        TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        decided_at  TIMESTAMPTZ
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS project_brief_versions_idx ON project_brief_versions (project_id, id DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_questions (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL,
        user_email  TEXT NOT NULL,
        question    TEXT NOT NULL,
        answer      TEXT,
        citations   JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS project_questions_idx ON project_questions (project_id, id DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_reports (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL,
        user_email  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        body        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS project_reports_idx ON project_reports (project_id, id DESC)`);
  }

  // ── Model call (JSON or text) ─────────────────────────────────────────────
  async function callModel({ system, user, json = true, maxTokens = 8000, email, detail }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('The MOC engine is not configured on this server.');
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: BRIEF_MODEL, temperature: 0.1, max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 180000 });
    const u = r.data.usage || {};
    const inT = u.prompt_tokens || 0, outT = u.completion_tokens || 0;
    if (inT || outT) {
      await logUsage({ service: 'openai', userEmail: email, sessionId: null, detail: `Project ${detail} (${BRIEF_MODEL})`,
        units: inT + outT, unitType: 'tokens',
        costUsd: inT * COST.openai_input_per_token + outT * COST.openai_output_per_token }).catch(() => {});
    }
    const content = r.data.choices?.[0]?.message?.content || '';
    if (!json) return content;
    try { return JSON.parse(content); } catch { throw new Error('The engine returned an unreadable result. Please try again.'); }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const txt = (x, n = 300) => String(typeof x === 'string' ? x
    : (x?.task || x?.decision || x?.requirement || x?.item || x?.text || x?.point || x?.topic || JSON.stringify(x ?? '')))
    .replace(/\s+/g, ' ').trim().slice(0, n);
  const hashOf = s => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
  const sessionFingerprint = m => hashOf([m.summary, JSON.stringify(m.decisions), JSON.stringify(m.action_items),
    JSON.stringify(m.action_items_done), JSON.stringify(m.pending_tracker)].join('|'));

  async function projectSessions(pid, email, withTranscript = false) {
    const r = await pool.query(`
      SELECT id, meeting_title, file_name, meeting_date, created_at, client_name, subject, attendees, summary,
             executive_summary, discussion_points, decisions, action_items, action_items_done, pending_tracker,
             next_agenda, next_meeting, moc_quality, tags ${withTranscript ? ', transcript' : ''}
        FROM mom_sessions
       WHERE project_id = $1 AND user_email = $2
       ORDER BY created_at ASC`, [pid, email]);
    return r.rows;
  }

  function compactMoc(m) {
    const done = safeObj(m.action_items_done);
    const lines = [
      `=== MEETING S${m.id}: "${m.meeting_title || m.file_name || 'Conversation'}" | date: ${m.meeting_date || new Date(m.created_at).toISOString().slice(0, 10)}`,
      (m.client_name || m.subject) ? `Client / subject: ${[m.client_name, m.subject].filter(Boolean).join(' — ')}` : '',
      safeArr(m.attendees).length ? `Attendees: ${safeArr(m.attendees).map(a => txt(a, 80)).join(' · ')}` : '',
      `Summary: ${safeArr(m.executive_summary).length ? safeArr(m.executive_summary).map(x => txt(x, 400)).join(' ') : txt(m.summary, 1200)}`,
      safeArr(m.discussion_points).length ? `Discussion:\n${safeArr(m.discussion_points).slice(0, 12).map(d => '  - ' + txt(d, 260)).join('\n')}` : '',
      safeArr(m.decisions).length ? `Decisions:\n${safeArr(m.decisions).map(d => '  - ' + txt(d)).join('\n')}` : '',
      safeArr(m.action_items).length ? `Actions:\n${safeArr(m.action_items).map((a, j) => {
        const isDone = !!done[String(j)] || /^(done|closed|completed)$/i.test(String(a?.status || ''));
        const meta = [a?.owner || a?.responsibility, a?.due_date || a?.due || a?.timeline, a?.priority].filter(Boolean).join(' · ');
        return `  - [${isDone ? 'DONE' : 'OPEN'}] ${txt(a)}${meta ? ` (${meta})` : ''}`;
      }).join('\n')}` : '',
      safeArr(m.pending_tracker).length ? `Pending tracker:\n${safeArr(m.pending_tracker).map(t =>
        `  - ${t?.area ? t.area + ': ' : ''}${txt(t?.requirement || t)}${t?.responsible ? ` [${t.responsible}]` : ''}${t?.status ? ` (${t.status})` : ''}`).join('\n')}` : '',
      safeArr(safeObj(m.moc_quality).key_figures).length ? `Key figures:\n${safeArr(safeObj(m.moc_quality).key_figures).slice(0, 12).map(k => '  - ' + txt(k, 200)).join('\n')}` : '',
      safeArr(m.next_agenda).length ? `Next agenda: ${safeArr(m.next_agenda).map(a => txt(a, 120)).join('; ')}` : '',
    ].filter(Boolean).join('\n');
    return lines.slice(0, MOC_CHARS);
  }

  async function latestBrief(pid, status) {
    const r = await pool.query(
      `SELECT * FROM project_brief_versions WHERE project_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY id DESC LIMIT 1`,
      status ? [pid, status] : [pid]);
    return r.rows[0] || null;
  }

  // ── Brief merge ───────────────────────────────────────────────────────────
  const MERGE_SYSTEM = `You maintain the PROJECT BRIEF: the combined, evidence-based memory of every meeting in one client project, for a professional advisory firm (finance, audit, compliance, Virtual CFO, e-commerce).

You receive the CURRENT BRIEF (JSON, may be empty) and one or more NEW MEETINGS (oldest first). Return the UPDATED BRIEF as JSON with exactly these keys:
{
 "profile": {"client_name":"legal / trade name as stated", "engagement":"what the work is", "period":"financial year or period covered", "scope":"areas in scope", "our_team":"advising firm people and roles", "client_team":"client people and roles", "standing_notes":"recurring arrangements, preferences or constraints stated in meetings"},
 "overview": "4-6 sentences: what the project is, where it stands now, what is next",
 "status": "on_track | at_risk | off_track | unknown",
 "status_reason": "one sentence, evidence-based",
 "stakeholders": [{"name":"", "role":"role only if stated", "side":"client | firm | third_party | unknown", "sources":["S12"]}],
 "glossary": [{"term":"", "meaning":"", "sources":["S12"]}],
 "decisions": [{"id":"D1", "text":"", "date":"", "status":"active | revised | reversed", "supersedes":"", "sources":["S12"], "history":[{"source":"S14","note":"what changed"}]}],
 "actions": [{"id":"A1", "task":"", "owner":"", "due":"", "status":"open | in_progress | done | dropped", "sources":["S12"], "updates":[{"source":"S14","note":"progress stated"}]}],
 "risks": [{"id":"R1", "text":"", "severity":"high | medium | low", "status":"open | mitigated | closed", "sources":["S12"]}],
 "open_questions": [{"id":"Q1", "text":"", "status":"open | answered", "answer":"", "sources":["S12"]}],
 "contradictions": [{"topic":"", "detail":"what was stated differently and when", "sources":["S12","S14"]}],
 "key_figures": [{"label":"", "value":"", "date":"", "sources":["S12"]}],
 "timeline": [{"date":"", "source":"S12", "event":"one line: the main outcome of that meeting"}]
}

Rules — accuracy over completeness:
1. Use only what the meetings state. Never invent people, roles, figures, dates, laws, due dates or progress. If something is unclear, leave it out or add an open question.
2. Every item carries "sources": the meeting ids (S<number>) that support it. Use only ids that appear in the NEW MEETINGS or already in the CURRENT BRIEF.
3. Keep existing ids (A1, D3, R2, Q1). New items get the next free number. Never renumber.
4. When a new meeting reports progress or closure of an existing action, update that action's status and add an entry to "updates". Do not create a duplicate. Mark "done" only when completion is stated.
5. Decision changes — this applies also when both the original and the change are in the NEW MEETINGS of this same call. When a later meeting changes an earlier decision, keep the earlier decision as its own item with status "revised" (or "reversed" if dropped), add the new decision as a separate item with "supersedes" set to the earlier id, and add a history note on the earlier one. Example: S1 "Inventory count at Pune", S2 "count at Nashik instead of Pune" → D1 Pune (revised, history: "Changed to Nashik in S2"), D2 Nashik (active, supersedes "D1").
6. Record a contradiction when two meetings state different figures, dates, owners or positions on the same matter and the later meeting does not explain the change.
7. Items with "user_edited": true were corrected by the user. Keep their text, owner, due and status exactly as given; you may only append to "updates"/"history"/"sources".
8. Keep every existing item unless a new meeting clearly supersedes it. Do not drop items because they were not discussed again.
9. One timeline entry per meeting, ordered by date.
10. profile: fill only from what is stated; keep existing values unless a meeting clearly corrects them; leave unknown fields empty.
11. Clear, simple professional English. Use "not documented", "not evidenced", "to be confirmed" where relevant.`;

  function normaliseBrief(b, validIds, prev) {
    const out = EMPTY_BRIEF();
    b = b && typeof b === 'object' ? b : {};
    const valid = s => validIds.has(String(s).toUpperCase());
    const srcs = v => [...new Set(safeArr(v).map(s => String(s).trim().toUpperCase()).filter(valid))];
    const str = (v, n = 600) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    out.profile = {};
    for (const f of PROFILE_FIELDS) out.profile[f] = str(safeObj(b.profile)[f], 600);
    out.overview = str(b.overview, 2000);
    out.status = ['on_track', 'at_risk', 'off_track', 'unknown'].includes(b.status) ? b.status : 'unknown';
    out.status_reason = str(b.status_reason, 400);
    const list = (key, map) => { out[key] = safeArr(b[key]).map(map).filter(Boolean).slice(0, 300); };
    list('stakeholders', s => s?.name ? { name: str(s.name, 80), role: str(s.role, 120), side: str(s.side, 20) || 'unknown', sources: srcs(s.sources), ...(s.user_edited ? { user_edited: true } : {}) } : null);
    list('glossary', g => g?.term ? { term: str(g.term, 80), meaning: str(g.meaning, 300), sources: srcs(g.sources), ...(g.user_edited ? { user_edited: true } : {}) } : null);
    list('decisions', d => d?.text ? { id: str(d.id, 8), text: str(d.text), date: str(d.date, 40), status: ['active', 'revised', 'reversed'].includes(d.status) ? d.status : 'active',
      supersedes: str(d.supersedes, 8), sources: srcs(d.sources), history: safeArr(d.history).map(h => ({ source: valid(h?.source) ? String(h.source).toUpperCase() : '', note: str(h?.note, 300) })).filter(h => h.note),
      ...(d.user_edited ? { user_edited: true } : {}) } : null);
    list('actions', a => a?.task ? { id: str(a.id, 8), task: str(a.task), owner: str(a.owner, 120), due: str(a.due, 60),
      status: ['open', 'in_progress', 'done', 'dropped'].includes(a.status) ? a.status : 'open', sources: srcs(a.sources),
      updates: safeArr(a.updates).map(h => ({ source: valid(h?.source) ? String(h.source).toUpperCase() : '', note: str(h?.note, 300) })).filter(h => h.note),
      ...(a.user_edited ? { user_edited: true } : {}) } : null);
    list('risks', r => r?.text ? { id: str(r.id, 8), text: str(r.text), severity: ['high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium',
      status: ['open', 'mitigated', 'closed'].includes(r.status) ? r.status : 'open', sources: srcs(r.sources) } : null);
    list('open_questions', q => q?.text ? { id: str(q.id, 8), text: str(q.text), status: q.status === 'answered' ? 'answered' : 'open', answer: str(q.answer), sources: srcs(q.sources) } : null);
    list('contradictions', c => c?.detail ? { topic: str(c.topic, 120), detail: str(c.detail), sources: srcs(c.sources) } : null);
    list('key_figures', k => k?.label ? { label: str(k.label, 120), value: str(k.value, 120), date: str(k.date, 40), sources: srcs(k.sources) } : null);
    list('timeline', t => t?.event ? { date: str(t.date, 40), source: valid(t.source) ? String(t.source).toUpperCase() : '', event: str(t.event, 400) } : null);

    // Give every item an id when the model left one out, without colliding with existing ones
    for (const [key, p] of [['decisions', 'D'], ['actions', 'A'], ['risks', 'R'], ['open_questions', 'Q']]) {
      const used = new Set(out[key].map(x => x.id).filter(Boolean));
      let n = Math.max(0, ...[...used].map(id => parseInt(String(id).replace(/\D/g, ''), 10) || 0));
      const seen = new Set();
      out[key].forEach(x => { if (!x.id || seen.has(x.id)) x.id = p + (++n); seen.add(x.id); });
    }
    // The user's corrections always win, whatever the model returned
    if (prev) {
      const pp = safeObj(prev.profile), locked = safeArr(pp.user_edited_fields);
      for (const f of locked) out.profile[f] = pp[f] || '';
      if (locked.length) out.profile.user_edited_fields = locked;
      for (const key of ['actions', 'decisions']) {
        const fixed = new Map(safeArr(prev[key]).filter(x => x.user_edited).map(x => [x.id, x]));
        out[key] = out[key].map(x => {
          const u = fixed.get(x.id); if (!u) return x;
          fixed.delete(x.id);
          return { ...x, ...(key === 'actions' ? { task: u.task, owner: u.owner, due: u.due, status: u.status } : { text: u.text, status: u.status }), user_edited: true };
        });
        fixed.forEach(u => out[key].push(u));   // never lose a corrected item
      }
      for (const key of ['glossary', 'stakeholders']) {
        const k = key === 'glossary' ? 'term' : 'name';
        const have = new Set(out[key].map(x => x[k].toLowerCase()));
        safeArr(prev[key]).filter(x => x.user_edited).forEach(u => {
          if (have.has(String(u[k]).toLowerCase())) out[key] = out[key].map(x => x[k].toLowerCase() === u[k].toLowerCase() ? u : x);
          else out[key].push(u);
        });
      }
    }
    return out;
  }

  // Merge the meetings not yet in the brief (or changed since). full=true rebuilds from nothing.
  async function mergeBrief(pid, email, { full = false, source = 'merge' } = {}) {
    const p = await ownedProject(email, pid);
    if (!p) throw new Error('Project not found.');
    const sessions = (await projectSessions(pid, email)).filter(m => String(m.summary || '').trim());
    const base = full ? null : await latestBrief(pid);           // newest, pending or approved
    const merged = full ? {} : { ...safeObj(base?.merged) };
    const inProject = new Set(sessions.map(m => String(m.id)));
    // A meeting moved out of the project → its items must go, so rebuild
    const removed = Object.keys(merged).some(id => !inProject.has(id));
    if (removed && !full) return mergeBrief(pid, email, { full: true, source: 'rebuild' });

    const todo = sessions.filter(m => merged[String(m.id)] !== sessionFingerprint(m));
    if (!todo.length) return { changed: false, version: base };

    let brief;
    if (full) {
      // A rebuild starts clean but keeps everything the user corrected by hand
      const last = safeObj((await latestBrief(pid))?.brief);
      brief = EMPTY_BRIEF();
      const lp = safeObj(last.profile);
      if (safeArr(lp.user_edited_fields).length) {
        brief.profile = { user_edited_fields: lp.user_edited_fields };
        lp.user_edited_fields.forEach(f => { brief.profile[f] = lp[f] || ''; });
      }
      for (const k of ['actions', 'decisions', 'glossary', 'stakeholders'])
        brief[k] = safeArr(last[k]).filter(x => x.user_edited).map(x => ({ ...x, sources: safeArr(x.sources).filter(s => inProject.has(String(s).replace(/^S/i, ''))) }));
    } else {
      brief = base ? safeObj(base.brief) : EMPTY_BRIEF();
    }
    const validIds = new Set([...sessions.map(m => 'S' + m.id)]);
    const typeGuide = PROJECT_TYPES[typeOf(p.project_type)].guide;
    const system = MERGE_SYSTEM + (typeGuide ? `\n\nPROJECT TYPE GUIDANCE: ${typeGuide}` : '') +
      `\n\nProject: ${p.name}${p.description ? ` — ${p.description}` : ''}` +
      (p.context_notes ? `\nUser's project instructions (names and terms here are the correct spellings):\n${String(p.context_notes).slice(0, 3000)}` : '');

    for (let i = 0; i < todo.length; i += BATCH_MOCS) {
      const batch = todo.slice(i, i + BATCH_MOCS);
      const updated = batch.filter(m => merged[String(m.id)]);
      const user = `CURRENT BRIEF:\n${JSON.stringify(brief)}\n\n` +
        (updated.length ? `NOTE: these meetings were already merged earlier but their MOC was edited or regenerated — replace what the brief says from them: ${updated.map(m => 'S' + m.id).join(', ')}\n\n` : '') +
        `NEW MEETINGS (oldest first):\n\n${batch.map(compactMoc).join('\n\n')}`;
      const raw = await callModel({ system, user, email, detail: full ? 'brief rebuild' : 'brief merge', maxTokens: 12000 });
      brief = normaliseBrief(raw, validIds, brief);
      batch.forEach(m => { merged[String(m.id)] = sessionFingerprint(m); });
    }

    const autoApprove = p.brief_review === false;
    // One pending version at a time: a newer merge replaces the older pending one
    await pool.query(`UPDATE project_brief_versions SET status = 'superseded', decided_at = NOW() WHERE project_id = $1 AND status = 'pending'`, [pid]);
    const r = await pool.query(
      `INSERT INTO project_brief_versions (project_id, user_email, brief, merged, status, source, note, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${autoApprove ? 'NOW()' : 'NULL'}) RETURNING *`,
      [pid, email, JSON.stringify(brief), JSON.stringify(merged), autoApprove ? 'approved' : 'pending', source,
       `${todo.length} meeting(s): ${todo.map(m => 'S' + m.id).join(', ')}`]);
    console.log(`[brief] Project #${pid} ${source}: ${todo.length} meeting(s) → v${r.rows[0].id} (${r.rows[0].status})`);
    return { changed: true, version: r.rows[0] };
  }

  // Background merge after a meeting is filed or moved — debounced per project
  const timers = new Map(), running = new Set();
  function scheduleMerge(pid, email, delayMs = 15000) {
    pid = parseInt(pid, 10);
    if (!pid || !email) return;
    clearTimeout(timers.get(pid));
    timers.set(pid, setTimeout(async () => {
      timers.delete(pid);
      if (running.has(pid)) return scheduleMerge(pid, email, 30000);
      running.add(pid);
      try { await mergeBrief(pid, email); }
      catch (e) { console.warn(`[brief] Background merge for project #${pid} failed:`, e.message); }
      finally { running.delete(pid); }
    }, delayMs));
  }

  // ── Brief → text for MOC generation ───────────────────────────────────────
  async function briefContextFor(pid) {
    try {
      const v = await latestBrief(pid, 'approved');
      if (!v) return '';
      const b = safeObj(v.brief), pf = safeObj(b.profile);
      const src = x => safeArr(x.sources).length ? ` [${safeArr(x.sources).join(',')}]` : '';
      const live = safeArr(b.actions).filter(a => a.status === 'open' || a.status === 'in_progress');
      const done = safeArr(b.actions).filter(a => a.status === 'done').slice(-15);
      const sec = (title, rows) => rows.length ? `${title}:\n${rows.join('\n')}` : '';
      const LABEL = { client_name: 'Client', engagement: 'Engagement', period: 'Period', scope: 'Scope', our_team: 'Our team', client_team: 'Client team', standing_notes: 'Standing notes' };
      const parts = [
        `\n\n${'═'.repeat(60)}\nPROJECT BRIEF — reviewed combined memory of every meeting in this project (approved by the user)\n${'═'.repeat(60)}`,
        `How to use the brief:
  1. Names, roles, client name and terms: use the spellings below (people list and glossary) everywhere in this MOC unless this transcript clearly corrects them.
  2. Actions: when this meeting gives progress on an open action below, use the same id (A1, A2 …) and state the new status only if the transcript says so. Do not repeat open actions that were not discussed.
  3. Decisions: superseded decisions are listed so you do not restate them as current. If this meeting changes an active decision, say which one it revises.
  4. Points to reconcile and open questions: if this meeting settles one, record the answer; otherwise do not mention it.
  5. Key figures are for spelling and context only — record figures in this MOC only as stated in this transcript.
  6. The brief is background. Record only what THIS transcript discusses.`,
        sec('Project profile', PROFILE_FIELDS.filter(f => pf[f]).map(f => `  ${LABEL[f]}: ${pf[f]}`)),
        b.overview ? `Where the project stands: ${b.overview}` : '',
        sec('People (correct spellings and roles)', safeArr(b.stakeholders).map(p => `  ${p.name}${p.role ? ' — ' + p.role : ''}${p.side && p.side !== 'unknown' ? ` [${p.side}]` : ''}`)),
        sec('Glossary / correct terms', safeArr(b.glossary).map(g => `  ${g.term} = ${g.meaning}`)),
        sec('Open actions', live.map(a => `  ${a.id} ${a.task}${a.owner ? ' — ' + a.owner : ''}${a.due ? ' — due ' + a.due : ''} (${a.status})${src(a)}${safeArr(a.updates).length ? ` · last update: ${a.updates[a.updates.length - 1].note}` : ''}`)),
        sec('Recently completed actions (do not reopen unless discussed)', done.map(a => `  ${a.id} ${a.task}`)),
        sec('Active decisions', safeArr(b.decisions).filter(d => d.status === 'active').map(d => `  ${d.id} ${d.text}${d.date ? ` (${d.date})` : ''}${d.supersedes ? ` — replaces ${d.supersedes}` : ''}`)),
        sec('Superseded decisions (no longer current)', safeArr(b.decisions).filter(d => d.status !== 'active').map(d => `  ${d.id} ${d.text} — ${d.status}`)),
        sec('Points to reconcile', safeArr(b.contradictions).map(c => `  ${c.topic}: ${c.detail}`)),
        sec('Open questions', safeArr(b.open_questions).filter(q => q.status === 'open').map(q => `  ${q.id} ${q.text}`)),
        sec('Open risks', safeArr(b.risks).filter(r => r.status === 'open').map(r => `  ${r.id} [${r.severity}] ${r.text}`)),
        sec('Key figures stated so far', safeArr(b.key_figures).slice(-20).map(k => `  ${k.label}: ${k.value}${k.date ? ` (${k.date})` : ''}`)),
        '═'.repeat(60),
      ].filter(Boolean).join('\n\n');
      return parts.slice(0, BRIEF_CTX_CHARS);
    } catch (e) { console.warn('[brief] Context unavailable:', e.message); return ''; }
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  const own = async (req, res) => {
    const p = await ownedProject(req.session.user.email, req.params.id);
    if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
    return p;
  };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (err) { console.error('[project-intel]', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  };

  app.get('/api/project-types', requireAuth, (req, res) =>
    res.json({ types: Object.entries(PROJECT_TYPES).map(([key, v]) => ({ key, label: v.label, guide: v.guide })) }));

  // Brief: approved + pending + list of meetings not yet merged
  app.get('/api/projects/:id/brief', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const email = req.session.user.email;
    const [approved, pending, sessions] = await Promise.all([
      latestBrief(p.id, 'approved'), latestBrief(p.id, 'pending'), projectSessions(p.id, email)]);
    const newest = pending || approved;
    const merged = safeObj(newest?.merged);
    const withMoc = sessions.filter(m => String(m.summary || '').trim());
    const unmerged = withMoc.filter(m => merged[String(m.id)] !== sessionFingerprint(m)).map(m => ({ id: m.id, title: m.meeting_title || m.file_name }));
    const removed = Object.keys(merged).filter(id => !withMoc.some(m => String(m.id) === id));
    res.json({
      project: { id: p.id, name: p.name, project_type: typeOf(p.project_type), brief_review: p.brief_review !== false, shared: !!p.share_token },
      approved: approved ? { id: approved.id, brief: approved.brief, created_at: approved.created_at, note: approved.note, source: approved.source } : null,
      pending:  pending  ? { id: pending.id,  brief: pending.brief,  created_at: pending.created_at,  note: pending.note,  source: pending.source }  : null,
      meetings: sessions.map(m => ({ id: m.id, ref: 'S' + m.id, title: m.meeting_title || m.file_name || 'Conversation #' + m.id, date: m.meeting_date || '', created_at: m.created_at })),
      unmerged, removed_count: removed.length,
      updating: running.has(p.id) || timers.has(p.id),
    });
  }));

  app.post('/api/projects/:id/brief/rebuild', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    if (running.has(p.id)) return res.status(409).json({ error: 'The brief is already being updated. Please wait a moment.' });
    running.add(p.id);
    try {
      const out = await mergeBrief(p.id, req.session.user.email, { full: !!req.body?.full, source: req.body?.full ? 'rebuild' : 'merge' });
      res.json({ success: true, changed: out.changed, status: out.version?.status || null });
    } finally { running.delete(p.id); }
  }));

  app.post('/api/projects/:id/brief/:vid/decide', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const approve = req.body?.decision === 'approve';
    const r = await pool.query(
      `UPDATE project_brief_versions SET status = $1, decided_at = NOW() WHERE id = $2 AND project_id = $3 AND status = 'pending' RETURNING id`,
      [approve ? 'approved' : 'rejected', req.params.vid, p.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'That version is no longer waiting for review.' });
    res.json({ success: true });
  }));

  app.get('/api/projects/:id/brief/versions', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const r = await pool.query(
      `SELECT id, status, source, note, created_at, decided_at, brief FROM project_brief_versions WHERE project_id = $1 ORDER BY id DESC LIMIT 50`, [p.id]);
    res.json({ versions: r.rows });
  }));

  // Restore an older version as the new approved brief
  app.post('/api/projects/:id/brief/:vid/restore', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const r = await pool.query('SELECT brief, merged FROM project_brief_versions WHERE id = $1 AND project_id = $2', [req.params.vid, p.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Version not found.' });
    await pool.query(`UPDATE project_brief_versions SET status = 'superseded', decided_at = NOW() WHERE project_id = $1 AND status = 'pending'`, [p.id]);
    await pool.query(`INSERT INTO project_brief_versions (project_id, user_email, brief, merged, status, source, note, decided_at)
                      VALUES ($1,$2,$3,$4,'approved','restore',$5,NOW())`,
      [p.id, req.session.user.email, JSON.stringify(r.rows[0].brief), JSON.stringify(r.rows[0].merged), `Restored from v${req.params.vid}`]);
    res.json({ success: true });
  }));

  // User edits (actions, decisions, glossary, people) — saved as a new approved version
  app.patch('/api/projects/:id/brief', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const base = (await latestBrief(p.id, 'pending')) || (await latestBrief(p.id, 'approved'));
    if (!base) return res.status(400).json({ error: 'Build the project brief first.' });
    const brief = { ...EMPTY_BRIEF(), ...safeObj(base.brief) };
    const ops = safeArr(req.body?.ops);
    const S = (v, n = 600) => String(v ?? '').trim().slice(0, n);
    for (const op of ops) {
      if (op.type === 'action' || op.type === 'decision') {
        const key = op.type === 'action' ? 'actions' : 'decisions';
        if (op.delete) { brief[key] = brief[key].filter(x => x.id !== op.id); continue; }
        let item = brief[key].find(x => x.id === op.id);
        if (!item) {
          const n = Math.max(0, ...brief[key].map(x => parseInt(String(x.id).replace(/\D/g, ''), 10) || 0)) + 1;
          item = op.type === 'action'
            ? { id: 'A' + n, task: '', owner: '', due: '', status: 'open', sources: [], updates: [] }
            : { id: 'D' + n, text: '', date: '', status: 'active', supersedes: '', sources: [], history: [] };
          brief[key].push(item);
        }
        const f = op.fields || {};
        if (op.type === 'action') {
          if (f.task !== undefined) item.task = S(f.task);
          if (f.owner !== undefined) item.owner = S(f.owner, 120);
          if (f.due !== undefined) item.due = S(f.due, 60);
          if (f.status !== undefined && ['open', 'in_progress', 'done', 'dropped'].includes(f.status)) item.status = f.status;
          if (f.note) item.updates = [...safeArr(item.updates), { source: 'USER', note: S(f.note, 300) }];
        } else {
          if (f.text !== undefined) item.text = S(f.text);
          if (f.status !== undefined && ['active', 'revised', 'reversed'].includes(f.status)) item.status = f.status;
        }
        item.user_edited = true;
      } else if (op.type === 'glossary' || op.type === 'stakeholder') {
        const key = op.type === 'glossary' ? 'glossary' : 'stakeholders';
        const k = op.type === 'glossary' ? 'term' : 'name';
        const name = S(op.fields?.[k], 80);
        if (!name) continue;
        brief[key] = brief[key].filter(x => String(x[k]).toLowerCase() !== name.toLowerCase());
        if (!op.delete) brief[key].push(op.type === 'glossary'
          ? { term: name, meaning: S(op.fields.meaning, 300), sources: [], user_edited: true }
          : { name, role: S(op.fields.role, 120), side: S(op.fields.side, 20) || 'unknown', sources: [], user_edited: true });
      } else if (op.type === 'profile') {
        const pr = { ...safeObj(brief.profile) };
        const locked = new Set(safeArr(pr.user_edited_fields));
        for (const f of PROFILE_FIELDS) if (op.fields && op.fields[f] !== undefined) { pr[f] = S(op.fields[f], 600); locked.add(f); }
        pr.user_edited_fields = [...locked];
        brief.profile = pr;
      } else if (op.type === 'overview') {
        brief.overview = S(op.text, 2000);
      }
    }
    // An edit on a pending version edits that draft; on an approved one it creates the next approved version
    if (base.status === 'pending') {
      await pool.query('UPDATE project_brief_versions SET brief = $1 WHERE id = $2', [JSON.stringify(brief), base.id]);
    } else {
      await pool.query(`INSERT INTO project_brief_versions (project_id, user_email, brief, merged, status, source, note, decided_at)
                        VALUES ($1,$2,$3,$4,'approved','edit',$5,NOW())`,
        [p.id, req.session.user.email, JSON.stringify(brief), JSON.stringify(safeObj(base.merged)), `${ops.length} manual change(s)`]);
    }
    res.json({ success: true, brief });
  }));

  // Settings that belong to this feature
  app.patch('/api/projects/:id/intel-settings', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    if (req.body?.project_type !== undefined)
      await pool.query('UPDATE projects SET project_type = $1 WHERE id = $2', [typeOf(req.body.project_type), p.id]);
    if (req.body?.brief_review !== undefined)
      await pool.query('UPDATE projects SET brief_review = $1 WHERE id = $2', [!!req.body.brief_review, p.id]);
    res.json({ success: true });
  }));

  // ── Ask the project ───────────────────────────────────────────────────────
  const STOP = new Set('the a an and or of to in on for with is are was were be by at as it this that what who when which how did does do from has have had will would about any our we they their there'.split(' '));
  const terms = s => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w));

  app.post('/api/projects/:id/ask', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const email = req.session.user.email;
    const question = String(req.body?.question || '').trim().slice(0, 1000);
    if (question.length < 3) return res.status(400).json({ error: 'Type a question.' });
    const sessions = await projectSessions(p.id, email, true);
    if (!sessions.length) return res.status(400).json({ error: 'This project has no meetings yet.' });
    const brief = safeObj((await latestBrief(p.id, 'approved'))?.brief);
    const q = new Set(terms(question));

    // Pull the transcript passages that best match the question
    const chunks = [];
    for (const m of sessions) {
      const t = String(m.transcript || '');
      for (let i = 0; i < t.length; i += 900) {
        const part = t.slice(i, i + 1100);
        const words = terms(part);
        let score = 0; for (const w of words) if (q.has(w)) score++;
        if (score) chunks.push({ id: m.id, score: score / Math.sqrt(words.length + 20), part });
      }
    }
    chunks.sort((a, b) => b.score - a.score);
    const excerpts = chunks.slice(0, 10).map(c => `[S${c.id} transcript excerpt]\n${c.part}`).join('\n\n');
    const mocs = sessions.filter(m => m.summary).map(m => compactMoc(m).slice(0, 2200)).join('\n\n').slice(0, 40000);

    const system = `You answer questions about one client project using ONLY the material given: the project brief, the meeting MOCs and transcript excerpts. Cite every statement with the meeting id in square brackets, e.g. [S12]. If the material does not answer the question, say "Not evidenced in the project's meetings" and say what is missing. Do not use outside knowledge for facts, laws, rates or dates. Reply as JSON: {"answer": "clear professional answer, short paragraphs or bullets, with [S..] citations", "citations": ["S12"], "confidence": "high | medium | low"}`;
    const user = `PROJECT: ${p.name}\n\nPROJECT BRIEF:\n${JSON.stringify(brief).slice(0, 20000)}\n\nMEETING MOCs:\n${mocs}\n\nTRANSCRIPT EXCERPTS:\n${excerpts || '(no matching passages)'}\n\nQUESTION: ${question}`;
    const out = await callModel({ system, user, email, detail: 'ask', maxTokens: 2000 });
    const valid = new Set(sessions.map(m => 'S' + m.id));
    const citations = [...new Set(safeArr(out.citations).map(c => String(c).toUpperCase()).filter(c => valid.has(c)))];
    const answer = String(out.answer || '').slice(0, 8000);
    const r = await pool.query(
      'INSERT INTO project_questions (project_id, user_email, question, answer, citations) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
      [p.id, email, question, answer, JSON.stringify(citations)]);
    res.json({ id: r.rows[0].id, question, answer, citations, confidence: out.confidence || 'medium', created_at: r.rows[0].created_at });
  }));

  app.get('/api/projects/:id/questions', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const r = await pool.query('SELECT id, question, answer, citations, created_at FROM project_questions WHERE project_id = $1 AND user_email = $2 ORDER BY id DESC LIMIT 50',
      [p.id, req.session.user.email]);
    res.json({ questions: r.rows });
  }));

  // ── Reports ───────────────────────────────────────────────────────────────
  const REPORTS = {
    status_report: { label: 'Project status report', ask: 'Write a project status report with sections: Summary, Progress since last update, Decisions taken, Open actions (table-like list with id, task, owner, due, status), Risks and issues, Items needing client input, Next steps. Professional, balanced tone.' },
    client_email:  { label: 'Client update email',   ask: 'Write a client update email: subject line, greeting, short summary of where things stand, what was completed, what is pending from the client (with owners/dates where stated), next steps and a polite close. Keep internal-only matters and risk wording out. Plain text.' },
    board_note:    { label: 'Board / management note', ask: 'Write a concise board or management note: Purpose, Background, Current position, Key decisions taken, Matters requiring attention or approval, Risks, Recommendation / next steps. Formal, neutral tone.' },
    action_summary:{ label: 'Action register summary', ask: 'Write an action register summary: counts by status, overdue or undated items, items by owner, and the three items needing follow-up first, with reasons.' },
  };
  app.post('/api/projects/:id/report', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const kind = REPORTS[req.body?.kind] ? req.body.kind : 'status_report';
    const email = req.session.user.email;
    const brief = safeObj((await latestBrief(p.id, 'approved'))?.brief);
    if (!Object.keys(brief).length) return res.status(400).json({ error: 'Approve a project brief first — reports are written from it.' });
    const sessions = (await projectSessions(p.id, email)).filter(m => m.summary).slice(-4);
    const system = `You draft professional documents for an advisory firm from a project's reviewed brief. Use only the facts given. Do not invent figures, dates, laws or commitments. Where something is not documented, say "to be confirmed". Cite meeting ids like (S12) after facts where helpful. Today is ${new Date().toISOString().slice(0, 10)}. Output Markdown.`;
    const user = `${REPORTS[kind].ask}\n\nPROJECT: ${p.name}${p.description ? ' — ' + p.description : ''}\n\nPROJECT BRIEF:\n${JSON.stringify(brief).slice(0, 24000)}\n\nMOST RECENT MEETINGS:\n${sessions.map(m => compactMoc(m).slice(0, 2500)).join('\n\n')}`;
    const body = await callModel({ system, user, json: false, email, detail: 'report', maxTokens: 3000 });
    const r = await pool.query('INSERT INTO project_reports (project_id, user_email, kind, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [p.id, email, kind, body]);
    res.json({ id: r.rows[0].id, kind, label: REPORTS[kind].label, body, created_at: r.rows[0].created_at });
  }));
  app.get('/api/projects/:id/reports', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const r = await pool.query('SELECT id, kind, body, created_at FROM project_reports WHERE project_id = $1 AND user_email = $2 ORDER BY id DESC LIMIT 30', [p.id, req.session.user.email]);
    res.json({ reports: r.rows.map(x => ({ ...x, label: REPORTS[x.kind]?.label || x.kind })), kinds: Object.entries(REPORTS).map(([k, v]) => ({ key: k, label: v.label })) });
  }));

  // ── Exports ───────────────────────────────────────────────────────────────
  const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  app.get('/api/projects/:id/export/actions.csv', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const b = safeObj((await latestBrief(p.id, 'approved'))?.brief);
    const rows = [['ID', 'Task', 'Owner', 'Due', 'Status', 'Source meetings', 'Latest update', 'Edited by user']];
    safeArr(b.actions).forEach(a => rows.push([a.id, a.task, a.owner, a.due, a.status, safeArr(a.sources).join(' '),
      safeArr(a.updates).slice(-1)[0]?.note || '', a.user_edited ? 'Yes' : '']));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^\w\- ]+/g, '').trim() || 'project'} - action register.csv"`);
    res.send('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
  }));

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function briefHtml(p, b, meetings, clientView) {
    const ref = new Map(meetings.map(m => ['S' + m.id, m]));
    const src = x => safeArr(x.sources).map(s => { const m = ref.get(s); return `<span class="src">${esc(m ? (m.meeting_date || new Date(m.created_at).toLocaleDateString('en-IN')) : s)}</span>`; }).join(' ');
    const table = (head, rows) => rows.length ? `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>` : '<p class="muted">None recorded.</p>';
    const sec = (t, body) => `<h2>${t}</h2>${body}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Project brief</title>
<style>body{font-family:Roboto,Arial,sans-serif;color:#18182C;max-width:960px;margin:24px auto;padding:0 16px;line-height:1.5}h1{font-size:26px;margin:0}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#E0621A;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f2ec}.muted{color:#888}.src{font-size:11px;color:#2870C0;white-space:nowrap}.pill{display:inline-block;padding:1px 8px;border-radius:9px;font-size:11px;background:#eee}
.done{background:#dff3e8}.open{background:#fdebdc}.in_progress{background:#e3edf9}.dropped{background:#eee}@media print{.noprint{display:none}}</style></head><body>
<div class="noprint" style="text-align:right"><button onclick="print()">Print / Save as PDF</button></div>
<h1>${esc(p.name)}</h1><div class="muted">${clientView ? 'Project update' : 'Project brief'} · prepared ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · ${meetings.length} meeting(s)</div>
${sec('Overview', `<p>${esc(b.overview || 'Not documented.')}</p>`)}
${sec('Open actions', table(['ID', 'Task', 'Owner', 'Due', 'Status', 'From'], safeArr(b.actions).filter(a => a.status !== 'dropped').map(a =>
      `<tr><td>${esc(a.id)}</td><td>${esc(a.task)}</td><td>${esc(a.owner || 'To be confirmed')}</td><td>${esc(a.due || '—')}</td><td><span class="pill ${esc(a.status)}">${esc(a.status.replace('_', ' '))}</span></td><td>${src(a)}</td></tr>`)))}
${sec('Decisions', table(['ID', 'Decision', 'Status', 'From'], safeArr(b.decisions).map(d =>
      `<tr><td>${esc(d.id)}</td><td>${esc(d.text)}${d.supersedes ? ` <span class="muted">(replaces ${esc(d.supersedes)})</span>` : ''}</td><td>${esc(d.status)}</td><td>${src(d)}</td></tr>`)))}
${clientView ? '' : sec('Risks', table(['ID', 'Risk', 'Severity', 'Status', 'From'], safeArr(b.risks).map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.text)}</td><td>${esc(r.severity)}</td><td>${esc(r.status)}</td><td>${src(r)}</td></tr>`)))}
${clientView ? '' : sec('Points needing reconciliation', table(['Topic', 'Detail', 'From'], safeArr(b.contradictions).map(c => `<tr><td>${esc(c.topic)}</td><td>${esc(c.detail)}</td><td>${src(c)}</td></tr>`)))}
${sec('Open questions', table(['ID', 'Question', 'Status'], safeArr(b.open_questions).filter(q => q.status === 'open').map(q => `<tr><td>${esc(q.id)}</td><td>${esc(q.text)}</td><td>${esc(q.status)}</td></tr>`)))}
${sec('Timeline', table(['Date', 'Meeting outcome'], safeArr(b.timeline).map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.event)}</td></tr>`)))}
<p class="muted" style="margin-top:30px;font-size:11px">Prepared from meeting records using the MOC engine and reviewed by the project owner. Facts are limited to what the meetings record; verify figures, dates and regulatory points with the responsible professional before relying on them.</p>
</body></html>`;
  }

  app.get('/api/projects/:id/export/brief.html', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const b = safeObj((await latestBrief(p.id, 'approved'))?.brief);
    const meetings = await projectSessions(p.id, req.session.user.email);
    res.type('html').send(briefHtml(p, b, meetings, req.query.client === '1'));
  }));

  // Client-safe share link (no risks, contradictions, glossary or internal notes)
  app.post('/api/projects/:id/share', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    const token = p.share_token || crypto.randomBytes(18).toString('base64url');
    await pool.query('UPDATE projects SET share_token = $1 WHERE id = $2', [token, p.id]);
    res.json({ success: true, url: `${process.env.APP_URL || ''}/p/${token}` });
  }));
  app.delete('/api/projects/:id/share', requireAuth, wrap(async (req, res) => {
    const p = await own(req, res); if (!p) return;
    await pool.query(`UPDATE projects SET share_token = '' WHERE id = $1`, [p.id]);
    res.json({ success: true });
  }));
  app.get('/p/:token', wrap(async (req, res) => {
    const t = String(req.params.token || '');
    if (t.length < 20) return res.status(404).send('Link not found.');
    const r = await pool.query(`SELECT * FROM projects WHERE share_token = $1 AND share_token <> ''`, [t]);
    const p = r.rows[0];
    if (!p) return res.status(404).send('This link is no longer active.');
    const b = safeObj((await latestBrief(p.id, 'approved'))?.brief);
    const meetings = await projectSessions(p.id, p.user_email);
    res.setHeader('X-Robots-Tag', 'noindex');
    res.type('html').send(briefHtml(p, b, meetings, true));
  }));

  // ── Meeting view: everything behind one conversation ─────────────────────
  app.get('/api/history/:id/prompt-trail', requireAuth, wrap(async (req, res) => {
    const email = req.session.user.email;
    const s = await pool.query('SELECT id, session_prompt, project_id FROM mom_sessions WHERE id = $1 AND user_email = $2', [req.params.id, email]);
    if (!s.rows.length) return res.status(404).json({ error: 'Conversation not found.' });
    const isAdmin = ['admin', 'developer'].includes(req.session.user.role);
    const r = await pool.query(`
      SELECT id, flow, composer_model, moc_model, composer_prompt, composer_error, user_instructions, context_input,
             ${isAdmin ? 'final_system_prompt,' : ''} created_at
        FROM moc_prompt_log WHERE session_id = $1 ORDER BY id DESC LIMIT 10`, [s.rows[0].id]);
    let project = null;
    if (s.rows[0].project_id) {
      const pr = await ownedProject(email, s.rows[0].project_id);
      if (pr) project = { id: pr.id, name: pr.name, color: pr.color };
    }
    res.json({ session_prompt: s.rows[0].session_prompt || '', project, runs: r.rows, admin: isAdmin });
  }));

  // ── Meeting-level glossary, people and context (used on regenerate) ──────
  const cleanList = (v, keys) => safeArr(v).map(x => {
    const o = {};
    for (const k of keys) o[k] = k === 'heard_as'
      ? [...new Set(safeArr(Array.isArray(x?.heard_as) ? x.heard_as : String(x?.heard_as || '').split(','))
          .map(s => String(s).trim()).filter(s => s && s.length <= 60))].slice(0, 8)
      : String(x?.[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, k === 'meaning' || k === 'role' ? 300 : 80);
    return o;
  }).filter(x => x[keys[0]]).slice(0, 150);
  const PEOPLE_KEYS = ['name', 'role', 'heard_as'], TERM_KEYS = ['term', 'meaning', 'heard_as'];

  // Correct spellings straight into the transcript the MOC engine reads (saved transcript is untouched)
  function applyHeardAs(transcript, m) {
    let t = String(transcript || ''), n = 0;
    const pairs = [...cleanList(m.session_people, PEOPLE_KEYS).map(p => [p.name, p.heard_as]),
                   ...cleanList(m.session_glossary, TERM_KEYS).map(g => [g.term, g.heard_as])];
    for (const [right, wrongs] of pairs) for (const w of wrongs) {
      if (!w || w.toLowerCase() === right.toLowerCase()) continue;
      const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // "Ravi" → "Ravi Menon" must not turn an existing "Ravi Menon" into "Ravi Menon Menon"
      const rest = right.toLowerCase().startsWith(w.toLowerCase()) ? right.slice(w.length).trim() : '';
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(w)}(?=$|[^\\p{L}\\p{N}])${rest ? `(?!\\s*${escRe(rest)})` : ''}`, 'giu');
      t = t.replace(re, (_, pre) => { n++; return pre + right; });
    }
    return { transcript: t, replaced: n };
  }

  function sessionContextBlock(m) {
    const people = cleanList(m.session_people, PEOPLE_KEYS), terms = cleanList(m.session_glossary, TERM_KEYS);
    const ctx = String(m.session_context || '').trim();
    if (!people.length && !terms.length && !ctx) return '';
    return [
      `${'═'.repeat(60)}\nMEETING GLOSSARY & CONTEXT — checked and corrected by the user for THIS meeting (highest priority after the transcript)\n${'═'.repeat(60)}`,
      'Speech-to-text mishears names and terms. Use exactly the spellings below everywhere in the MOC (attendees, owners, discussion, actions). Where a "heard as" variant appears in the transcript, it means the correct form given here.',
      people.length ? `People in this meeting:\n${people.map(p => `  ${p.name}${p.role ? ' — ' + p.role : ''}${p.heard_as.length ? `  (transcript may show: ${p.heard_as.join(', ')})` : ''}`).join('\n')}` : '',
      terms.length ? `Terms, companies, products and abbreviations:\n${terms.map(g => `  ${g.term}${g.meaning ? ' = ' + g.meaning : ''}${g.heard_as.length ? `  (transcript may show: ${g.heard_as.join(', ')})` : ''}`).join('\n')}` : '',
      ctx ? `Background for this meeting (from the user — use it to understand the discussion; record only what the transcript says):\n${ctx}` : '',
      '═'.repeat(60),
    ].filter(Boolean).join('\n\n');
  }

  app.get('/api/history/:id/context', requireAuth, wrap(async (req, res) => {
    const email = req.session.user.email;
    const r = await pool.query('SELECT id, project_id, session_glossary, session_people, session_context, attendees FROM mom_sessions WHERE id = $1 AND user_email = $2', [req.params.id, email]);
    const m = r.rows[0]; if (!m) return res.status(404).json({ error: 'Conversation not found.' });
    let project = null;
    if (m.project_id) {
      const p = await ownedProject(email, m.project_id);
      const b = safeObj((await latestBrief(m.project_id, 'approved'))?.brief);
      if (p) project = { id: p.id, name: p.name, glossary: safeArr(b.glossary), people: safeArr(b.stakeholders), has_brief: !!Object.keys(b).length };
    }
    res.json({ people: cleanList(m.session_people, PEOPLE_KEYS), glossary: cleanList(m.session_glossary, TERM_KEYS),
      context: m.session_context || '', project });
  }));

  app.put('/api/history/:id/context', requireAuth, wrap(async (req, res) => {
    const email = req.session.user.email;
    const people = cleanList(req.body?.people, PEOPLE_KEYS), glossary = cleanList(req.body?.glossary, TERM_KEYS);
    const context = String(req.body?.context || '').slice(0, 6000);
    const r = await pool.query(`UPDATE mom_sessions SET session_people = $1, session_glossary = $2, session_context = $3
                                WHERE id = $4 AND user_email = $5 RETURNING project_id`,
      [JSON.stringify(people), JSON.stringify(glossary), context, req.params.id, email]);
    if (!r.rows.length) return res.status(404).json({ error: 'Conversation not found.' });
    // Optionally carry the corrections into the project brief so every later MOC uses them too
    let toProject = 0;
    const pid = r.rows[0].project_id;
    if (req.body?.save_to_project && pid && (await ownedProject(email, pid))) {
      const base = (await latestBrief(pid, 'pending')) || (await latestBrief(pid, 'approved'));
      if (base) {
        const brief = { ...EMPTY_BRIEF(), ...safeObj(base.brief) };
        const up = (key, k, item) => {
          brief[key] = safeArr(brief[key]).filter(x => String(x[k]).toLowerCase() !== item[k].toLowerCase());
          brief[key].push(item); toProject++;
        };
        people.forEach(p => up('stakeholders', 'name', { name: p.name, role: p.role, side: 'unknown', sources: ['S' + req.params.id], user_edited: true }));
        glossary.forEach(g => up('glossary', 'term', { term: g.term, meaning: g.meaning + (g.heard_as.length ? ` (may be transcribed as ${g.heard_as.join(', ')})` : ''), sources: ['S' + req.params.id], user_edited: true }));
        if (base.status === 'pending') await pool.query('UPDATE project_brief_versions SET brief = $1 WHERE id = $2', [JSON.stringify(brief), base.id]);
        else await pool.query(`INSERT INTO project_brief_versions (project_id, user_email, brief, merged, status, source, note, decided_at)
                               VALUES ($1,$2,$3,$4,'approved','edit',$5,NOW())`,
          [pid, email, JSON.stringify(brief), JSON.stringify(safeObj(base.merged)), `Glossary from meeting S${req.params.id}`]);
      }
    }
    res.json({ success: true, people, glossary, context, saved_to_project: toProject });
  }));

  // Proposes people and terms from the transcript, with the misheard spellings found in it
  app.post('/api/history/:id/context/suggest', requireAuth, wrap(async (req, res) => {
    const email = req.session.user.email;
    const r = await pool.query('SELECT id, project_id, transcript, attendees, session_people, session_glossary FROM mom_sessions WHERE id = $1 AND user_email = $2', [req.params.id, email]);
    const m = r.rows[0]; if (!m) return res.status(404).json({ error: 'Conversation not found.' });
    const t = String(m.transcript || '');
    if (t.trim().length < 50) return res.status(400).json({ error: 'No transcript to read.' });
    let known = '';
    if (m.project_id) {
      const b = safeObj((await latestBrief(m.project_id, 'approved'))?.brief);
      const p = await ownedProject(email, m.project_id);
      known = [p?.context_notes ? `Project instructions: ${String(p.context_notes).slice(0, 2000)}` : '',
        safeArr(b.stakeholders).length ? `Known people: ${b.stakeholders.map(x => x.name + (x.role ? ` (${x.role})` : '')).join('; ')}` : '',
        safeArr(b.glossary).length ? `Known terms: ${b.glossary.map(g => g.term).join('; ')}` : '',
        safeObj(b.profile).client_name ? `Client: ${b.profile.client_name}` : ''].filter(Boolean).join('\n');
    }
    const sample = t.length > 60000 ? t.slice(0, 40000) + '\n…\n' + t.slice(-20000) : t;
    const system = `You prepare a glossary so meeting minutes spell everything correctly. Read the transcript (speech-to-text, may contain Indian names, Hindi/Gujarati words, and misheard terms).
Return JSON: {"people":[{"name":"best correct spelling","role":"only if stated","heard_as":["other spellings of the same person seen in the transcript"]}],
"terms":[{"term":"correct form (company, product, place, tax/accounting term, abbreviation, software)","meaning":"short meaning; for abbreviations the expansion only if certain","heard_as":["misheard or variant forms seen in the transcript"]}]}
Rules: only people and terms actually present in the transcript. Prefer the spelling given in the known project details. heard_as lists only strings that literally appear in the transcript and differ from the correct form. Do not invent roles or meanings; leave empty when unsure. Max 25 people, 40 terms. Skip common words.`;
    const out = await callModel({ system, user: `${known ? 'KNOWN PROJECT DETAILS:\n' + known + '\n\n' : ''}ATTENDEES IN CURRENT MOC: ${safeArr(m.attendees).map(a => typeof a === 'string' ? a : a?.name).filter(Boolean).join('; ')}\n\nTRANSCRIPT:\n${sample}`,
      email, detail: 'glossary suggest', maxTokens: 4000 });
    const tl = t.toLowerCase();
    const keepSeen = x => ({ ...x, heard_as: x.heard_as.filter(h => tl.includes(h.toLowerCase())) });   // only variants that really occur
    res.json({ people: cleanList(out.people, PEOPLE_KEYS).map(keepSeen), glossary: cleanList(out.terms, TERM_KEYS).map(keepSeen) });
  }));

  return { ensureTables, scheduleMerge, briefContextFor, mergeBrief, PROJECT_TYPES, applyHeardAs, sessionContextBlock };
};
