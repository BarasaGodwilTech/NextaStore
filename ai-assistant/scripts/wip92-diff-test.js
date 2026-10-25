#!/usr/bin/env node
/**
 * WIP 92d Part 4.4: English differential through the REAL pipeline.run() with a deterministic stub model.
 *
 *   node scripts/wip92-diff-test.js            compare against scripts/golden/en-differential.json
 *   node scripts/wip92-diff-test.js --write    (re)write the snapshot from the current code
 *
 * The stub model is EXTRACTIVE (it only restates the retrieved context), so any change to the English
 * reply text means a gate/validator/router changed behaviour. Small talk is skipped (random variants).
 * The snapshot was first taken from the 92c code (verified identical to WIP 91 on English text); the only
 * deliberate change since is the handoff metadata on the contact_support FAQ (text is unchanged).
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const { isSmallTalk } = require('../src/chat/smalltalk');

const QUESTIONS = require('./golden/en-questions.json').questions;
const GOLDEN_PATH = path.join(__dirname, 'golden', 'en-differential.json');
const write = process.argv.includes('--write');

let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass += 1; if (process.env.VERBOSE) console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } }
const bodyOf = (q) => (typeof q === 'string' ? { message: q, context: { audience: 'guest', page: 'marketplace' } } : { message: q.message, history: q.history, context: { audience: 'guest', page: 'marketplace' } });
const keyOf = (q) => (typeof q === 'string' ? q : `${q.message} || ${q.history.map((m) => m.content).join(' / ')}`);

(async () => {
    H.config.catalogCards = false;          // offline and deterministic: no catalog lookups
    H.config.logFlagged = false;
    const stub = H.installModel();
    const snap = {};
    const mismatchStream = [];
    try {
        check('the question list has at least 150 entries', QUESTIONS.length >= 150, String(QUESTIONS.length));
        check('no question is small talk (random variants)', QUESTIONS.every((q) => !isSmallTalk(typeof q === 'string' ? q : q.message)));
        for (const q of QUESTIONS) {
            const { result: r } = await H.runTurn(bodyOf(q));
            const again = (await H.runTurn(bodyOf(q))).result;
            check(`deterministic: ${keyOf(q)}`, again.reply === r.reply && again.source === r.source);
            snap[keyOf(q)] = { reply: r.reply, bubbles: r.bubbles, source: r.source, faqId: r.faqId || null, handoff: r.handoff || null, flag: r.flag ? r.flag.type : null, language: r.language && r.language.code };
            const s = await H.runTurn(bodyOf(q), { stream: true });
            if (s.streamed.trim() !== r.reply.trim() && H.flat(s.streamed) !== H.flat(s.result.reply)) mismatchStream.push(keyOf(q));
            check(`English turn is never replaced by the Luganda handoff: ${keyOf(q)}`, !/NextaStore akuyambe/.test(r.reply));
            check(`non-empty reply and bubble: ${keyOf(q)}`, r.reply.trim().length > 0 && r.bubbles.length >= 1);
        }
        check('streamed text equals the final reply on every question', mismatchStream.length === 0, mismatchStream.slice(0, 5).join(' | '));
    } finally { stub.restore(); }

    if (write) {
        fs.writeFileSync(GOLDEN_PATH, JSON.stringify({ _note: 'WIP 92d golden snapshot (extractive stub model, catalog cards off). Regenerate with --write only after reviewing every diff.', count: Object.keys(snap).length, answers: snap }, null, 1));
        console.log(`wrote ${GOLDEN_PATH} (${Object.keys(snap).length} answers)`);
    } else {
        const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')).answers;
        const keys = Object.keys(golden);
        check('golden and current cover the same questions', keys.length === Object.keys(snap).length && keys.every((k) => k in snap));
        const diffs = keys.filter((k) => snap[k] && JSON.stringify(snap[k]) !== JSON.stringify(golden[k]));
        check(`every English answer matches the golden snapshot (${keys.length - diffs.length}/${keys.length})`, diffs.length === 0, diffs.slice(0, 5).map((k) => `${k} => ${JSON.stringify(snap[k]).slice(0, 160)} vs ${JSON.stringify(golden[k]).slice(0, 160)}`).join('\n'));
    }
    console.log(`\nwip92-diff-test: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
