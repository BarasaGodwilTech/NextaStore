#!/usr/bin/env node
/*
 * WIP 100: the 36 fresh answerable questions (scripts/golden/answerable-36.json). No Ollama, no network.
 *   node scripts/answerable-eval.js [--guard on|off] [--list]
 *
 * Two runs through the REAL pipeline.run():
 *   A. a well-behaved extractive stub model (restates the retrieved text): how many questions end as a handoff / clarify / "not in the guides"?
 *      That is a FALSE deflection, because the guides do answer every one of these questions.
 *   B. a stub that returns the hand-written NATURAL CORRECT reply stored with each question: how many come back unchanged?
 *      (a reply the guard or the claim check rewrites or replaces is a false positive on correct wording)
 * Also reports whether the expected section is among the top 3 retrieved (retrieval, independent of the guard).
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
// canned FAQ answers would short-circuit run B: switch the matcher off before the harness (and pipeline) load it, exactly as wip98-test does
const noFaq = process.argv.includes('--keep-faq') ? false : true;
if (noFaq) require('../src/chat/faqMatch').match = () => null;
const H = require('./lib/harness');
const { NOT_IN_GUIDES_RE } = require('../src/chat/gapLine');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const withoutLink = (s) => norm(String(s || '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/(?:^|\s)(?:Open|See|Visit)\b[^.\n]*?(?:\/[a-z0-9\-_/]+)\s*$/i, '').replace(/\s\/[a-z0-9\-_/]+\s*$/i, ''));
const ctx = { audience: 'guest', page: 'marketplace' };

async function evaluate({ guard = true, file = 'answerable-36.json' } = {}) {
  H.config.catalogCards = false; H.config.logFlagged = false;
  const saved = H.config.assertionGuard; H.config.assertionGuard = guard;
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden', file), 'utf8')).rows;
  const out = { n: rows.length, deflected: [], changed: [], retrievalMiss: [], gatedDeflected: 0, gatedChanged: 0, openDeflected: 0, openChanged: 0, gated: rows.filter((r) => r[3] === 'gated').length };
  try {
    // A: extractive stub
    const ex = H.installModel();
    try {
      for (const [q, heading, , shape] of rows) {
        const { result } = await H.runTurn({ message: q, context: ctx });
        const bad = result.source === 'handoff' || result.source === 'clarify' || NOT_IN_GUIDES_RE.test(result.reply || '');
        if (bad) { out.deflected.push([q, result.source]); if (shape === 'gated') out.gatedDeflected++; else out.openDeflected++; }
        const top = (result.retrieved || []).slice(0, 3).map((r) => String(r.heading || '').toLowerCase());
        if (result.retrieved && result.retrieved.length && !top.some((h) => h.includes(heading.toLowerCase().slice(0, 18)))) out.retrievalMiss.push([q, heading, top[0]]);
      }
    } finally { ex.restore(); }
    // B: natural correct replies
    for (const [q, , text, shape] of rows) {
      const s = H.installModel(() => text);
      try {
        const { result } = await H.runTurn({ message: q, context: ctx });
        if (!(s.calls.length && withoutLink(result.reply) === norm(text))) { out.changed.push([q, result.source, norm(result.reply).slice(0, 110)]); if (shape === 'gated') out.gatedChanged++; else out.openChanged++; }
      } finally { s.restore(); }
    }
  } finally { H.config.assertionGuard = saved; }
  return out;
}

module.exports = { evaluate };

if (require.main === module) {
  (async () => {
    const guard = String(arg('--guard', 'on')) !== 'off';
    const file = arg('--file', 'answerable-36.json');
    const r = await evaluate({ guard, file });
    const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
    console.log(`${file} (guard ${guard ? 'ON' : 'OFF'}):`);
    console.log(`  A. false handoff / clarify / not-in-guides with a well-behaved model: ${r.deflected.length}/${r.n} = ${pct(r.deflected.length, r.n)}  (gated-shape ${r.gatedDeflected}/${r.gated}, open ${r.openDeflected}/${r.n - r.gated})`);
    console.log(`  B. natural correct replies changed by the pipeline: ${r.changed.length}/${r.n} = ${pct(r.changed.length, r.n)}  (gated-shape ${r.gatedChanged}/${r.gated}, open ${r.openChanged}/${r.n - r.gated})`);
    console.log(`  retrieval: expected section missing from the top 3 for ${r.retrievalMiss.length}/${r.n}`);
    if (process.argv.includes('--list')) {
      r.deflected.forEach((x) => console.log(`   A-deflect  ${x[0]}  [${x[1]}]`));
      r.changed.forEach((x) => console.log(`   B-changed  ${x[0]}  [${x[1]}] -> ${x[2]}`));
      r.retrievalMiss.forEach((x) => console.log(`   R-miss     ${x[0]}  want "${x[1]}"  got "${x[2]}"`));
    }
  })().catch((e) => { console.error('FATAL', e); process.exit(2); });
}
