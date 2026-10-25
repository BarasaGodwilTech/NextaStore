#!/usr/bin/env node
/*
 * Retrieval accuracy check for Nexi.
 * Run:  node scripts/retrieval-eval.js [--gold scripts/golden/retrieval-gold.json] [--min-top1 0.9] [--min-top3 0.97] [--min-top5 0.95] [--list]
 * Each gold row is [question, [accepted chunk heading fragments]]. A fragment "src:90" accepts any chunk from a
 * knowledge file whose name starts with 90. Rows starting with a capital letter are "clean grammar" controls, the
 * rest are "messy grammar". Needs no Ollama, no network.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const goldPath = path.resolve(arg('--gold', path.join(ROOT, 'scripts/golden/retrieval-gold.json')));
const minTop1 = Number(arg('--min-top1', 0)); const minTop3 = Number(arg('--min-top3', 0)); const minTop5 = Number(arg('--min-top5', 0));
const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
const { retrieve } = require(path.join(ROOT, 'src/rag/retrieve'));
const hit = (c, labels) => labels.some(l => l.startsWith('src:') ? c.source.startsWith(l.slice(4)) : (c.heading || '').toLowerCase().includes(l.toLowerCase()));
(async () => {
  const times = [];
  let n = 0, t1 = 0, t3 = 0, t5 = 0, cN = 0, c1 = 0, mN = 0, m1 = 0, mMiss5 = 0; const rows = [];
  for (const [q, labels] of gold) {
    const t0 = process.hrtime.bigint(); const r = await retrieve(q, 5); times.push(Number(process.hrtime.bigint() - t0) / 1e6); n++;
    const ok1 = !!(r[0] && hit(r[0], labels)), ok3 = r.slice(0, 3).some(c => hit(c, labels)), ok5 = r.some(c => hit(c, labels));
    if (ok1) t1++; if (ok3) t3++; if (ok5) t5++;
    if (/^[A-Z]/.test(q)) { cN++; if (ok1) c1++; } else { mN++; if (ok1) m1++; if (!ok5) mMiss5++; }
    if (!ok1) rows.push([ok3 ? 'top3' : ok5 ? 'top5' : 'MISS', q, r[0] ? `${r[0].heading} (${r[0].score.toFixed(2)})` : '(none)']);
  }
  const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : 'n/a';
  console.log(`retrieval-eval: n=${n}  top1 ${t1} (${pct(t1, n)})  top3 ${t3} (${pct(t3, n)})  top5 ${t5} (${pct(t5, n)})`);
  console.log(`  clean grammar top1 ${c1}/${cN} (${pct(c1, cN)})   messy grammar top1 ${m1}/${mN} (${pct(m1, mN)})   messy not in top5: ${mMiss5}`);
  const sorted = times.slice().sort((a, b) => a - b); const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(`  retrieval time per question: p50 ${at(0.5).toFixed(2)} ms, p95 ${at(0.95).toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms`);
  if (process.argv.includes('--list')) rows.forEach(x => console.log('  ' + x[0].padEnd(5), x[1].padEnd(48), '->', x[2]));
  const failed = (minTop1 && t1 / n < minTop1) || (minTop3 && t3 / n < minTop3) || (minTop5 && t5 / n < minTop5);
  if (failed) { console.log(`FAIL: thresholds top1>=${minTop1} top3>=${minTop3} top5>=${minTop5}`); process.exit(1); }
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
