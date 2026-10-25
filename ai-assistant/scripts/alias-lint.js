#!/usr/bin/env node
/*
 * Guards the rule "do not copy gold or held-out questions into aliases".
 * Fails when any `aliases:` phrase in src/knowledge/*.md is (near-)identical to a question in
 * scripts/golden/retrieval-gold.json or retrieval-heldout.json (same content words, Jaccard >= 0.6).
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { terms } = require(path.join(ROOT, 'src/rag/bm25'));
const { chunkMarkdown } = require(path.join(ROOT, 'src/rag/chunk'));
const set = (s) => new Set(terms(s));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const questions = [];
for (const f of ['retrieval-gold.json', 'retrieval-heldout.json', 'retrieval-blind2.json', 'retrieval-blind3.json', 'retrieval-blind-40.json', 'blind-4.json', 'retrieval-oos.json', 'oos-25.json', 'oos-25b.json', 'oos-15.txt']) {
  const p = path.join(ROOT, 'scripts/golden', f);
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, 'utf8');
  const rows = /\.txt$/.test(f) ? raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : JSON.parse(raw);
  for (const row of rows) questions.push([f, Array.isArray(row) ? row[0] : row.q || row]);
}
const FIX = process.argv.includes('--fix');
const dir = path.join(ROOT, 'src/knowledge'); const bad = []; let n = 0; let missing = 0; let removed = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  const full = path.join(dir, file); const raw = fs.readFileSync(full, 'utf8'); let next = raw;
  const { chunks } = chunkMarkdown(file, raw);
  for (const c of chunks) {
    if (!c.aliases.length) { missing++; bad.push(`${file} "${c.heading}": no aliases`); }
    for (const a of c.aliases) {
      n++; const sa = set(a); let flagged = false;
      for (const [f, q] of questions) { const sq = set(q); const j = jac(sa, sq); if (j >= 0.6 && Math.min(sa.size, sq.size) >= 3) { flagged = true; bad.push(`${file} "${c.heading}": alias "${a}" ~ ${f} "${q}" (${j.toFixed(2)})`); break; } }
      if (flagged && FIX) { next = next.split('\n').map((ln) => /^aliases:/i.test(ln) ? 'aliases: ' + ln.replace(/^aliases:\s*/i, '').split(/[|;]/).map((x) => x.trim()).filter((x) => x && x !== a).join(' | ') : ln).join('\n'); removed++; }
    }
  }
  if (FIX && next !== raw) fs.writeFileSync(full, next);
}
if (FIX) { console.log(`alias-lint --fix: removed ${removed} aliases that echoed gold/held-out questions`); process.exit(0); }
console.log(`alias-lint: ${n} aliases checked against ${questions.length} gold/held-out/blind/oos questions; ${missing} chunks without aliases`);
if (bad.length) { bad.forEach((b) => console.log('  ' + b)); process.exit(1); }
console.log('  ok');
