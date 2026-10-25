#!/usr/bin/env node
/*
 * Confidence calibration for retrieval (WIP 97). Needs no model and no network.
 *   node scripts/retrieval-calibrate.js [--answer 0.6] [--clarify 0.4] [--json]
 * Uses the gold, held-out and blind-2 sets (answerable questions, top-1 right or wrong) and the out-of-knowledge
 * set (every one of those SHOULD land in the "none" band). Prints the confidence distribution for right vs wrong
 * top-1 answers and the precision of each band, so the thresholds in config.retrievalBands can be checked against data.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
const config = require(path.join(ROOT, 'src/config'));
const { retrieve, bandOf } = require(path.join(ROOT, 'src/rag/retrieve'));
if (arg('--answer')) config.retrievalBands.answer = Number(arg('--answer'));
if (arg('--clarify')) config.retrievalBands.clarify = Number(arg('--clarify'));
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden', f), 'utf8'));
const hit = (c, labels) => labels.some((l) => l.startsWith('src:') ? c.source.startsWith(l.slice(4)) : (c.heading || '').toLowerCase().includes(l.toLowerCase()));
const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : 'n/a';
const q = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN;
const f2 = (x) => Number.isFinite(x) ? x.toFixed(2) : ' n/a';
(async () => {
  const rows = []; // {set, right, conf, band}
  for (const set of ['retrieval-gold.json', 'retrieval-heldout.json', 'retrieval-blind2.json']) {
    for (const [question, labels] of load(set)) {
      const r = await retrieve(question, 3); const top = r[0];
      rows.push({ set: set.replace('retrieval-', '').replace('.json', ''), question, right: !!(top && hit(top, labels)), conf: top ? top.confidence : 0, band: top ? bandOf(top.confidence) : 'none', cov: top ? top.coverage : 0 });
    }
  }
  const oos = [];
  for (const question of load('retrieval-oos.json')) { const r = await retrieve(question, 3); const top = r[0]; oos.push({ question, conf: top ? top.confidence : 0, cov: top ? top.coverage : 0, band: top ? bandOf(top.confidence) : 'none' }); }
  const right = rows.filter((r) => r.right).map((r) => r.conf); const wrong = rows.filter((r) => !r.right).map((r) => r.conf);
  console.log(`thresholds: answer >= ${config.retrievalBands.answer}, clarify >= ${config.retrievalBands.clarify}, else none`);
  console.log(`\nconfidence of the top-1 chunk, answerable questions (${rows.length}):`);
  console.log('                 n    min   p10   p25   med   p75   max');
  for (const [name, arr] of [['correct top-1', right], ['wrong top-1', wrong], ['out-of-knowledge', oos.map((o) => o.conf)]]) {
    console.log(`  ${name.padEnd(16)} ${String(arr.length).padStart(3)}  ${[0, .1, .25, .5, .75, .999].map((p) => f2(q(arr, p))).join('  ')}`);
  }
  console.log('\nprecision per band (answerable sets; "right" = an accepted heading is top-1):');
  for (const b of ['answer', 'clarify', 'none']) {
    const inB = rows.filter((r) => r.band === b); const ok = inB.filter((r) => r.right).length;
    const top3 = b;
    console.log(`  ${b.padEnd(8)} ${String(inB.length).padStart(3)} questions (${pct(inB.length, rows.length)})  top-1 right ${ok}/${inB.length} = ${pct(ok, inB.length)}`);
  }
  const oosBands = { answer: 0, clarify: 0, none: 0 }; oos.forEach((o) => oosBands[o.band]++);
  console.log(`\nout-of-knowledge (${oos.length}): answer ${oosBands.answer}, clarify ${oosBands.clarify}, none ${oosBands.none}  (want: none, then handoff/clarify)`);
  if (process.argv.includes('--list')) { rows.filter((r) => !r.right).forEach((r) => console.log(`  WRONG ${f2(r.conf)} ${r.band.padEnd(7)} ${r.question}`)); oos.filter((o) => o.band !== 'none').forEach((o) => console.log(`  OOS-not-none ${f2(o.conf)} ${o.band} ${o.question}`)); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
