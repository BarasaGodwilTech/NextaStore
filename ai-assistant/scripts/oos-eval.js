#!/usr/bin/env node
/*
 * Out-of-knowledge evaluation (WIP 98). Needs no Ollama and no network.
 *   node scripts/oos-eval.js [--files scripts/golden/oos-15.txt,scripts/golden/oos-25.json] [--min 0.9] [--list]
 *
 * Each question is something the NextaStore guides do not say (platform facts / policy / offerings). It goes through the REAL
 * pipeline.run() with a "confident" stub model that would happily answer anything. The right outcome is:
 *   handoff        the team is offered (source "handoff")
 *   not-in-guides  the reply says plainly that it is not in the guides
 *   off-topic      a polite decline for something that is not about NextaStore at all (weather, shares ...). Counted separately.
 * Anything else is a LEAK: the question was answered from the model, shown as catalog cards, or turned into a clarify chip row.
 * Catalog cards are ON (as in production) so a "do you have X" question that is really about the platform is caught here.
 * Files: .txt = one question per line; .json = an array of strings.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const H = require('./lib/harness');

const load = (f) => { const p = path.resolve(ROOT, f); const raw = fs.readFileSync(p, 'utf8'); return /\.json$/i.test(p) ? JSON.parse(raw) : raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); };
const NOT_IN_GUIDES = /(?:isn't|is not|not) in the NextaStore guides|don't have (?:it|that) in the NextaStore guides|not in the guides/i;

function categorize(result) {
  if (result.handoff && /connect you with a human/i.test(result.reply || '')) return 'handoff';
  if (result.source === 'flag') return 'off-topic';
  if (NOT_IN_GUIDES.test(result.reply || '')) return 'not-in-guides';
  if (result.source === 'cards') return 'LEAK catalog-cards';
  if (result.source === 'clarify') return 'LEAK clarify';
  return 'LEAK answered:' + result.source;
}

async function evaluate(questions, { cards = true } = {}) {
  H.config.logFlagged = false;
  const saved = H.config.catalogCards; H.config.catalogCards = cards;
  // A confident model that knows nothing. Its text has no figure and no policy word, so the claim check cannot rescue it: if it reaches the person, that is a leak.
  const stub = H.installModel(() => 'Yes, you can do that on NextaStore. Open your dashboard and choose the option for it.');
  const rows = [];
  try {
    for (const q of questions) {
      const before = stub.calls.length;
      const { result } = await H.runTurn({ message: q, context: { audience: 'guest', page: 'marketplace' } });
      rows.push({ q, cat: categorize(result), source: result.source, modelCalled: stub.calls.length > before, reply: result.reply || '' });
    }
  } finally { stub.restore(); H.config.catalogCards = saved; }
  const count = (f) => rows.filter(f).length;
  return {
    rows, n: rows.length,
    handoff: count((r) => r.cat === 'handoff'), notInGuides: count((r) => r.cat === 'not-in-guides'), offTopic: count((r) => r.cat === 'off-topic'),
    leaks: rows.filter((r) => r.cat.startsWith('LEAK')), modelCalled: count((r) => r.modelCalled),
    // WIP 100: a catalog search that only says it cannot look the item up (or found nothing) makes no claim about the platform. It stays a LEAK in the strict and the
    // off-topic rulers (so every older number is unchanged) and is reported separately as a THIRD ruler, never mixed in silently.
    catalogNoClaim: count((r) => r.cat === 'LEAK catalog-cards' && /cannot look that up right now|could not find anything for/i.test(r.reply)),
  };
}

module.exports = { evaluate, categorize, load };

if (require.main === module) {
  (async () => {
    const files = String(arg('--files', 'scripts/golden/oos-15.txt,scripts/golden/oos-25.json')).split(',').map((s) => s.trim()).filter(Boolean);
    const min = Number(arg('--min', 0)); let failed = false;
    for (const f of files) {
      const r = await evaluate(load(f));
      const ok = r.handoff + r.notInGuides;
      const incl = ok + r.offTopic;
      console.log(`oos-eval ${path.basename(f)}: n=${r.n}  handoff ${r.handoff}  not-in-guides ${r.notInGuides}  off-topic decline ${r.offTopic}  LEAK ${r.leaks.length}   strict (handoff+not-in-guides) ${ok}/${r.n} = ${(100 * ok / r.n).toFixed(0)}%   incl. off-topic ${incl}/${r.n} = ${(100 * incl / r.n).toFixed(0)}%   model called ${r.modelCalled}   +catalog no-claim ${incl + r.catalogNoClaim}/${r.n} = ${(100 * (incl + r.catalogNoClaim) / r.n).toFixed(0)}%`);
      if (process.argv.includes('--list')) r.rows.forEach((x) => console.log(`  ${x.cat.padEnd(22)} ${x.q.padEnd(58)} ${x.reply.replace(/\s+/g, ' ').slice(0, 90)}`));
      else r.leaks.forEach((x) => console.log(`  ${x.cat.padEnd(22)} ${x.q}  ->  ${x.reply.replace(/\s+/g, ' ').slice(0, 80)}`));
      if (min && incl / r.n < min) { failed = true; console.log(`FAIL: ${path.basename(f)} below ${min}`); }
    }
    process.exit(failed ? 1 : 0);
  })().catch((e) => { console.error('FATAL', e); process.exit(2); });
}
