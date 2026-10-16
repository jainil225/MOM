// Regression checks for the MOC quality gates (moc-quality.js), modelled on the
// TTPL review cases T01-T08. No AI calls: each case feeds a model-style output
// and checks what the gates let through.  Run: node ops/test-moc-quality.js
const assert = require('assert');
const { applyQualityGates } = require('../moc-quality');

const TRANSCRIPT = `
Rajnikant: Our margin is around 12 percent now. Ideally we should reach at least 20 percent, maybe 15 percent as a first step.
Labh: Let us see, we have to first understand the platform costs.
Abhishek: Amazon panel shows around 17 lakh sales but GST return shows 15 lakh. Maybe cancellations explain it.
Nirja: I think we should stop Shopify ads, it is not giving returns.
Labh: No, Shopify ads are bringing direct customers, we should continue.
Rajnikant: Labh and Nirja can look at platform costs, Rajnikant and Abhishek can look at fabric to delivery.
Abhishek: Garba this year is at the club ground, the venue is very nice.
Labh: Yes, I will send the September sales file by Friday 17/10/2026.
Rajnikant: Okay approved, we will file the Haryana GST registration through the CA.
`;

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; console.log('  PASS', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const run = mom => applyQualityGates(JSON.parse(JSON.stringify(mom)), TRANSCRIPT);

console.log('MOC quality gate tests');

test('T01 profitability benchmark without assent is not a confirmed decision', () => {
  const out = run({ decision_log: [{ statement: 'An interim 20% profitability target was agreed.', status: 'confirmed', accepted_by: 'Rajnikant', acceptance_quote: 'we have agreed the 20 percent target for this year' }] });
  assert.strictEqual(out.decision_log[0].status, 'requires_confirmation');
  assert.ok(out.decisions[0].startsWith('[Requires confirmation]'));
  assert.strictEqual(out.moc_quality.report.decisions.confirmed, 0);
});

test('T01b confirmed decision with real assent survives', () => {
  const out = run({ decision_log: [{ statement: 'Haryana GST registration to be filed through the CA.', status: 'confirmed', accepted_by: 'Rajnikant', acceptance_quote: 'Okay approved, we will file the Haryana GST registration through the CA' }] });
  assert.strictEqual(out.decision_log[0].status, 'confirmed');
  assert.ok(!out.decisions[0].startsWith('['));
});

test('T02 review pairs without a commitment quote become matters, not tasks', () => {
  const out = run({ action_items: [
    { task: 'Labh/Nirja to prepare platform cost sheet with quantified action plan — Done when: sheet shared', owner: 'Labh, Nirja', due_date: '31/10/2026', priority: 'High' },
  ] });
  assert.strictEqual(out.action_items.length, 0);
  assert.strictEqual(out.matters_discussed.length, 1);
  assert.ok(!/Done when/.test(out.matters_discussed[0].item));
});

test('T03 cause stated in summary raises a reviewer warning', () => {
  const out = run({ summary: 'The 2 lakh difference was caused by cancellations.' });
  assert.ok(out.moc_quality.report.warnings.some(w => /cause/.test(w)));
});

test('T04 opposing views kept as a matter, no instruction to stop ads', () => {
  const out = run({ matters_discussed: [{ item: 'Shopify advertising', classification: 'OPINION', views: 'Nirja favoured stopping; Labh favoured continuing.' }], action_items: [{ task: 'Stop Shopify advertising', owner: 'Nirja' }] });
  assert.strictEqual(out.action_items.length, 0);
  assert.ok(out.matters_discussed.some(m => /Labh/.test(m.views)));
});

test('T06 incidental discussion entry is tagged for exclusion', () => {
  const out = run({ discussion_points: [{ topic: 'Garba venue', details: 'Brief social talk.', relevance: 'incidental' }, { topic: 'Recommendations', details: '...' }] });
  assert.strictEqual(out.discussion_points[0].relevance, 'incidental');
  assert.strictEqual(out.discussion_points[1].relevance, 'internal');
});

test('T08 no invented due date or priority on a real commitment', () => {
  const out = run({ action_items: [{ task: 'Hold a working session on costs', owner: 'Joint', owner_status: 'explicit', due_date: '20/10/2026', due_status: 'not_agreed', priority: 'High', priority_source: 'none', commitment_quote: 'Labh and Nirja can look at platform costs' }] });
  assert.strictEqual(out.action_items[0].due_date, 'TBD');
  assert.strictEqual(out.action_items[0].priority, '');
});

test('Genuine action with agreed date is kept intact (no over-suppression)', () => {
  const out = run({ action_items: [{ task: 'Send September sales file', owner: 'Labh', owner_status: 'explicit', due_date: '17/10/2026', due_status: 'agreed', priority: '', priority_source: 'none', commitment_quote: 'I will send the September sales file by Friday 17/10/2026' }] });
  assert.strictEqual(out.action_items.length, 1);
  assert.strictEqual(out.action_items[0].owner, 'Labh');
  assert.strictEqual(out.action_items[0].due_date, '17/10/2026');
  assert.strictEqual(out.action_items[0].evidence, 'found');
});

test('Commitment quote not in transcript marks the action for confirmation', () => {
  const out = run({ action_items: [{ task: 'Prepare MSME registration', owner: 'Abhishek', owner_status: 'explicit', commitment_quote: 'I will complete the MSME registration this week' }] });
  assert.strictEqual(out.action_items[0].requires_confirmation, true);
});

test('Repeated actions are de-duplicated', () => {
  const q = 'I will send the September sales file by Friday';
  const out = run({ action_items: [{ task: 'Send the September sales file', commitment_quote: q }, { task: 'Send September sales file', commitment_quote: q }] });
  assert.strictEqual(out.action_items.length, 1);
});

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
