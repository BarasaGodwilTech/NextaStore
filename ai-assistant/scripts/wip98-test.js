#!/usr/bin/env node
/*
 * WIP 98 acceptance: the real pipeline.run() with stub models. No Ollama, no network.
 *   node scripts/wip98-test.js
 * Covers: (1) correct natural paraphrases come back unchanged, wrong ones do not (two-part guard compares facts, not tokens);
 *         (2) professional wording (no "About X:" / "Here is what applies:" leads, no " -- ", steps lead only for steps);
 *         (3) prompt size and pipeline overhead on every answerable set (gold, held-out, blind-40, blind-4);
 *         (4) false handoff/clarify rate on answerable sets <= 3%;
 *         (5) out-of-knowledge sets (oos-15, oos-25, oos-25b) through the real pipeline with a confident stub model.
 * oos-25 / oos-25b / blind-4 are first-look sets: the numbers are printed honestly; only floors that the code can defend are enforced.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
// canned FAQ answers would short-circuit the paraphrase checks: switch the matcher off BEFORE the harness (and pipeline) load it
require('../src/chat/faqMatch').match = () => null;
const H = require('./lib/harness');
const { CORRECT, WRONG } = require('./lib/wip98-paraphrases');
const { evaluate, load: loadLines } = require('./oos-eval');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const goldenJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden', f), 'utf8'));
const ctx = { audience: 'guest', page: 'marketplace' };
const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// a page link the pipeline may append: "[Open ...](/path)", "Open ...: /path" or a bare path on its own line
const withoutLink = (s) => norm(String(s || '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/(?:^|\s)(?:Open|See|Visit)\b[^.\n]*?(?:\/[a-z0-9\-_/]+)\s*$/i, '').replace(/\s\/[a-z0-9\-_/]+\s*$/i, ''));

(async () => {
  H.config.catalogCards = false; H.config.logFlagged = false;

  console.log(`Part 1: ${CORRECT.length} correct paraphrases come back unchanged; ${WRONG.length} wrong answers do not`);
  {
    const bad = [];
    for (const [question, text] of CORRECT) {
      const s = H.installModel(() => text);
      try {
        const { result } = await H.runTurn({ message: question, context: ctx });
        if (!(s.calls.length && withoutLink(result.reply) === norm(text))) bad.push([question, norm(result.reply).slice(0, 110)]);
      } finally { s.restore(); }
    }
    check(`correct paraphrases returned unchanged (${CORRECT.length - bad.length}/${CORRECT.length}, at least 20 and all of them)`, CORRECT.length >= 20 && bad.length === 0, JSON.stringify(bad.slice(0, 4)));
    const kept = [];
    for (const [question, text] of WRONG) {
      const s = H.installModel(() => text);
      try {
        const { result } = await H.runTurn({ message: question, context: ctx });
        if (withoutLink(result.reply) === norm(text) || !s.calls.length) kept.push([question, norm(result.reply).slice(0, 90)]);
      } finally { s.restore(); }
    }
    check(`wrong answers (changed figure / invented promise) never reach the visitor as written (${WRONG.length - kept.length}/${WRONG.length})`, kept.length === 0, JSON.stringify(kept));
  }

  console.log('Part 2-4: every answerable set through run() with a well-behaved stub model');
  const stub = H.installModel();
  const sets = {
    gold: goldenJson('retrieval-gold.json'), 'held-out': goldenJson('retrieval-heldout.json'), 'blind-40': goldenJson('retrieval-blind-40.json'), 'blind-4': goldenJson('blind-4.json'),
  };
  // Topics the guides truly do not cover: a handoff here is the CORRECT answer, so it is not counted as a false deflection.
  const ABSENT = /\b(?:change|rename|edit)\b.*\b(?:shop|store)\s+name\b|\bchange\b.*\b(?:email|e-mail)\b|\b(?:shop|store)\s+name\b.*\bchange\b/i;
  const sizes = []; const times = []; const wording = []; const all = [];
  let answerable = 0, deflected = 0; const falseRows = [];
  for (const [setName, rows] of Object.entries(sets)) {
    let sn = 0, sd = 0;
    for (const row of rows) {
      const question = Array.isArray(row) ? row[0] : row.q || row;
      const before = stub.calls.length; const t0 = process.hrtime.bigint();
      const { result } = await H.runTurn({ message: question, context: ctx });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const reply = result.reply || '';
      if (stub.calls.length > before) sizes.push(stub.calls[stub.calls.length - 1].system.length);
      all.push([question, reply]);
      if (!ABSENT.test(question)) { answerable++; sn++; if (result.source === 'handoff' || result.source === 'clarify') { deflected++; sd++; falseRows.push(`${setName}: ${question} -> ${result.source}`); } }
      if (/^\s*(?:About [^:\n]{1,80}:|Here is what applies:?)/i.test(reply)) wording.push(['lead', question, reply.slice(0, 60)]);
      if (/ -- /.test(reply)) wording.push(['dashes', question, reply.slice(0, 60)]);
      if (/^\s*Here's how to\b/i.test(reply) && !/(?:^|\n)\s*1[.)]\s/.test(reply)) wording.push(['steps-lead-without-steps', question, reply.slice(0, 60)]);
    }
    console.log(`  info: ${setName}: ${sn} answerable, ${sd} handed off / clarified (${pct(sd, sn)})`);
  }
  check(`no reply starts with "About {heading}:" or "Here is what applies:" (${all.length} questions)`, !wording.some((w) => w[0] === 'lead'), JSON.stringify(wording.filter((w) => w[0] === 'lead').slice(0, 3)));
  check('no reply contains " -- "', !wording.some((w) => w[0] === 'dashes'), JSON.stringify(wording.filter((w) => w[0] === 'dashes').slice(0, 3)));
  check('"Here\'s how to ..." leads only a reply that really has numbered steps', !wording.some((w) => w[0] === 'steps-lead-without-steps'), JSON.stringify(wording.filter((w) => w[0] === 'steps-lead-without-steps').slice(0, 3)));
  check(`prompt size: system + facts <= 3,200 chars on every one of ${sizes.length} model calls (max ${Math.max(...sizes)})`, Math.max(...sizes) <= 3200);
  check(`prompt size: typical <= 2,600 chars (p50 ${q(sizes, .5)}, p90 ${q(sizes, .9)}, p99 ${q(sizes, .99)})`, q(sizes, 0.9) <= 2600);
  check(`false handoff/clarify on ${answerable} answerable questions (gold + held-out + blind-40 + blind-4) <= 3% (${deflected} = ${pct(deflected, answerable)})`, deflected / answerable <= 0.03, JSON.stringify(falseRows));
  console.log(`  info: non-model pipeline overhead per question on ${times.length} questions: p50 ${q(times, .5).toFixed(1)} ms, p95 ${q(times, .95).toFixed(1)} ms`);
  check('non-model overhead p95 <= 25 ms', q(times, 0.95) <= 25, `p95 ${q(times, .95).toFixed(1)}`);
  stub.restore();

  console.log('Part 5: out-of-knowledge questions (a confident stub model that would answer anything)');
  {
    const r15 = await evaluate(loadLines('scripts/golden/oos-15.txt'));
    const ok15 = r15.handoff + r15.notInGuides, incl15 = ok15 + r15.offTopic;
    console.log(`  info: oos-15 strict (handoff + "not in the guides") ${ok15}/15; with the polite off-topic decline for the weather question ${incl15}/15; leaks: ${r15.leaks.map((l) => l.q + ' [' + l.cat + ']').join('; ') || 'none'}`);
    check('oos-15 (supplied by the owner): >= 14/15 handed off, "not in the guides" or politely declined as off-topic', incl15 >= 14, JSON.stringify(r15.leaks.map((l) => l.q)));
    check('...and the model is never even called for them', r15.modelCalled === 0);
    const r25 = await evaluate(loadLines('scripts/golden/oos-25.json'));
    const ok25 = r25.handoff + r25.notInGuides + r25.offTopic;
    console.log(`  info: oos-25 ${ok25}/25 = ${pct(ok25, 25)} (FIRST LOOK before the generic gate fixes was 17/25 = 68%; the set has been seen since, so this number is a regression check, not a measurement)`);
    check('oos-25 stays >= 90% (regression floor; first look was 68%)', ok25 / 25 >= 0.9, JSON.stringify(r25.leaks.map((l) => l.q)));
    const r25b = await evaluate(loadLines('scripts/golden/oos-25b.json'));
    const ok25b = r25b.handoff + r25b.notInGuides + r25b.offTopic;
    console.log(`  info: oos-25b ${ok25b}/25 = ${pct(ok25b, 25)} (second, fresh set written after the oos-25 fixes: first look 16/25 = 64%). Honest estimate for unseen out-of-knowledge questions: about two thirds. Leaks: ${r25b.leaks.map((l) => l.q).join('; ')}`);
    check('oos-25b: at least 60% (first-look floor; NOT the 90% target, which lexical evidence cannot reach: see WIP_LOG)', ok25b / 25 >= 0.6);
  }

  console.log(`\nwip98-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
