#!/usr/bin/env node
/*
 * WIP 97: the English answer-change table. Runs every question of the English differential through the real pipeline.run()
 * (stub model, offline) and compares with the committed golden snapshot. A changed row is classified by MEASURED question-term
 * coverage (how many of the question's content words each answer speaks to):
 *   improved     the new answer covers more of the question, or the old one was off-topic (covered ~nothing) / a raw dump (4+ sentences)
 *   same-topic   coverage equal and not a dump: wording changed only
 *   REGRESSION?  the new answer covers LESS of the question: needs a human look (never auto-accepted)
 * Usage: node scripts/wip97-answer-changes.js [--md out.md] [--accept]   (--accept rewrites ONLY the changed rows that are not REGRESSION?)
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
const H = require('./lib/harness');
const { queryPlan, ensureFresh } = require('../src/rag/retrieve');
const { questionCoverage } = require('../src/chat/postprocess');
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const Q = require('./golden/en-questions.json').questions;
const GOLD_PATH = path.resolve(arg('--gold') || path.join(ROOT, 'scripts/golden/en-differential.json'));   // --gold <file>: compare against another snapshot (e.g. the WIP 96 one)
const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/en-change-reviews.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));
const sentences = (t) => (String(t).replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+(?=\s|$)/g) || []).length;
(async () => {
  H.config.catalogCards = false; H.config.logFlagged = false; const stub = H.installModel();
  const rows = []; const next = {};
  for (const q of Q) {
    const isStr = typeof q === 'string';
    const body = isStr ? { message: q, context: { audience: 'guest', page: 'marketplace' } } : { message: q.message, history: q.history, context: { audience: 'guest', page: 'marketplace' } };
    const key = isStr ? q : `${q.message} || ${q.history.map((m) => m.content).join(' / ')}`;
    const { result: r } = await H.runTurn(body);
    const old = golden.answers[key]; next[key] = { ...(old || {}), reply: r.reply, source: r.source, ...(r.handoff ? { handoff: r.handoff } : {}) };
    if (old && old.reply === r.reply && old.source === r.source) continue;
    const groups = queryPlan(isStr ? q : q.message, ensureFresh()).norm.groups;
    const co = questionCoverage((old && old.reply) || '', groups); const cn = questionCoverage(r.reply, groups);
    const dump = sentences((old && old.reply) || '') >= 4 || /^\s*(?:#|\*\*[^*]+\*\*\s*$|1\.\*\*)/.test((old && old.reply) || '');
    const reviewed = reviews[isStr ? q : q.message];
    // WIP 98: a row whose ONLY change is the removed "About {heading}:" / "Here is what applies:" lead (the answer sentences are identical) is classed 'lead-removed': the lead's heading words used to count as coverage.
    const stripLead = (t) => String(t || '').replace(/^(?:About [^:]{3,120}:|Here is what applies:)\s+/, '').replace(/\s+/g, ' ').trim();
    const leadOnly = old && stripLead(old.reply) === stripLead(r.reply) && stripLead(old.reply) !== String(old.reply || '').replace(/\s+/g, ' ').trim() && stripLead(r.reply) === String(r.reply || '').replace(/\s+/g, ' ').trim();
    const klass = leadOnly ? 'lead-removed' : reviewed ? 'improved' : cn + 0.001 < co && !(co < 0.2) ? 'REGRESSION?' : (co < 0.2 || dump || cn > co + 0.001) ? 'improved' : 'same-topic';
    const why = leadOnly ? 'only the "About ...:" / "Here is what applies:" lead was removed (WIP 98 Item 4); the answer sentences are identical' : reviewed ? `reviewed: ${reviewed}` : klass === 'improved' ? (co < 0.2 ? 'old answer off-topic (speaks to none of the question words)' : dump ? 'old answer was a raw section dump' : `new answer covers more of the question (${co.toFixed(2)} -> ${cn.toFixed(2)})`) : klass === 'same-topic' ? 'wording only (same coverage)' : `new answer covers less of the question (${co.toFixed(2)} -> ${cn.toFixed(2)})`;
    rows.push({ q: key, before: (old && old.reply || '').replace(/\s+/g, ' ').slice(0, +(arg('--width') || 110)), beforeSource: old && old.source, after: r.reply.replace(/\s+/g, ' ').slice(0, +(arg('--width') || 110)), afterSource: r.source, klass, why });
  }
  stub.restore();
  const by = (k) => rows.filter((r) => r.klass === k).length;
  console.log(`rows differing: ${rows.length} of ${Q.length}  improved ${by('improved')}  lead-removed ${by('lead-removed')}  same-topic ${by('same-topic')}  REGRESSION? ${by('REGRESSION?')}`);
  const md = ['| question | before | after | class | why |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.q.replace(/\|/g, '/')} | [${r.beforeSource}] ${r.before.replace(/\|/g, '/')} | [${r.afterSource}] ${r.after.replace(/\|/g, '/')} | ${r.klass} | ${r.why} |`)].join('\n');
  if (arg('--md')) fs.writeFileSync(arg('--md'), md + '\n');
  if (process.argv.includes('--list-regressions')) rows.filter((r) => r.klass === 'REGRESSION?').forEach((r) => console.log(`\nQ: ${r.q}\n  BEFORE [${r.beforeSource}] ${r.before}\n  AFTER  [${r.afterSource}] ${r.after}\n  ${r.why}`));
  if (process.argv.includes('--accept')) {
    const changed = new Set(rows.filter((r) => r.klass !== 'REGRESSION?').map((r) => r.q)); const merged = { ...golden, answers: { ...golden.answers } };
    for (const k of changed) merged.answers[k] = next[k];
    fs.writeFileSync(GOLD_PATH, JSON.stringify(merged, null, 1) + '\n'); console.log(`accepted ${changed.size} rows (regression candidates left untouched)`);
  }
  process.exit(0);
})();
