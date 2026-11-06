#!/usr/bin/env node
// Scores a generated MOC against the agreed answer for a test meeting.
//
//   node ops/eval-moc.js tests/moc-cases/0335.json "C:\Users\...\MOC_Detailed_MOC-2026-0335.docx"
//
// Each case lists the actions, decisions and figures a correct MOC must carry,
// as keyword groups (any spelling in a group counts), plus phrases that must
// never appear. The script reads the Word file and prints a score card, so a
// prompt change can be judged on numbers across all test meetings.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const unxml = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
let ROWS = [];
async function docxText(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('word/document.xml').async('string');
  // Table rows kept whole — "1 | task | owner | timeline | status" — for owner/status checks
  ROWS = (xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []).map(r => unxml(r.replace(/<\/w:p>/g, ' ').replace(/<\/w:tc>/g, ' | ')));
  return unxml(xml.replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | '));
}

// Rows of 4+ cells — the action plan / tracker tables
function actionRows() {
  return ROWS.filter(l => (l.match(/\|/g) || []).length >= 4);
}

// true when every group has at least one of its alternatives in the text
const has = (text, groups) => groups.every(g => [].concat(g).some(w => text.toLowerCase().includes(String(w).toLowerCase())));

(async () => {
  const [caseFile, docFile] = process.argv.slice(2);
  if (!caseFile || !docFile) { console.log('Usage: node ops/eval-moc.js <case.json> <MOC.docx>'); process.exit(1); }
  const c = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  const text = await docxText(docFile);
  const rows = actionRows().join('\n');
  let pass = 0, total = 0;
  const line = (ok, label, note = '') => { total++; if (ok) pass++; console.log(`${ok ? '  ✓' : '  ✗'} ${label}${note ? '  — ' + note : ''}`); };

  console.log(`\n${c.name}  (${path.basename(docFile)})\n`);
  console.log('Actions');
  (c.actions || []).forEach(a => {
    const found = has(rows, a.keywords);
    let note = '';
    if (found && a.owner) {
      const row = actionRows().find(r => has(r, a.keywords)) || '';
      if (!has(row, [a.owner])) note = `found, but owner is not ${[].concat(a.owner).join('/')}`;
    }
    if (found && a.status) {
      const row = actionRows().find(r => has(r, a.keywords)) || '';
      if (!row.toLowerCase().includes(a.status.toLowerCase())) note = (note ? note + '; ' : 'found, but ') + `status is not ${a.status}`;
    }
    line(found && !note, a.label, found ? note : 'missing');
  });
  if (c.decisions?.length) { console.log('Decisions'); c.decisions.forEach(d => line(has(text, d.keywords), d.label, has(text, d.keywords) ? '' : 'missing')); }
  if (c.figures?.length) { console.log('Figures'); c.figures.forEach(f => line(has(text, f.keywords), f.label, has(text, f.keywords) ? '' : 'missing or wrong unit')); }
  if (c.must_not_contain?.length) {
    console.log('Must not appear');
    c.must_not_contain.forEach(p => { const hit = text.toLowerCase().includes(p.toLowerCase()); line(!hit, `"${p}"`, hit ? 'present' : ''); });
  }
  const pct = total ? Math.round((pass / total) * 100) : 0;
  console.log(`\nScore: ${pass}/${total}  (${pct}%)\n`);
  process.exit(pass === total ? 0 : 2);
})().catch(e => { console.error(e.message); process.exit(1); });
