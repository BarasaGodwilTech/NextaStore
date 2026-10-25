#!/usr/bin/env node
/*
 * WIP 97 Part 5.2: the pipeline must not depend on the model being smart. Nine stub "personalities" answer 15 questions
 * through the REAL pipeline.run(); for every one the final user-visible reply must be acceptable: right topic, no dump of a
 * guide section, no invented figure, no wrongful handoff, no empty bubble, inside the time budget.
 *   node scripts/model-personalities-test.js
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
const H = require('./lib/harness');
const { terms, rawTokens } = require('../src/rag/bm25');
const { ensureFresh } = require('../src/rag/retrieve');
const { numbersSupported } = require('../src/chat/numbers');
const { EN_HANDOFF } = require('../src/chat/handoff');

let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL ${name} ${extra}`); } };
const ctx = { audience: 'guest', page: 'marketplace' };
const ANSWERABLE = ['how do i open a store', 'how do i reset my password', 'what payment methods can i use', 'how do i track my order', 'how do i price my products', 'how much is seller pass', 'what is a seller badge', 'how do i report a suspicious seller', 'i want sell my things in nextastore what i do', 'how to know if price is fair', 'how do i follow a store', 'what should i write in a product description'];
const OUT_OF_KNOWLEDGE = ['what is the delivery fee', 'does nextastore give a warranty', 'how do i delete my account'];
const facts = (messages) => (messages[0].content.split('\nFacts:\n')[1] || '').trim();
const { splitSentences } = require('../src/chat/compose');
const grams = (text, n) => { const t = rawTokens(text); const out = new Set(); for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' ')); return out; };

const PERSONALITIES = {
  terse: () => 'Yes.',
  verbose: (m) => `${facts(m).replace(/^[^:\n]{2,90}:\s+/gm, '')} ${facts(m).replace(/^[^:\n]{2,90}:\s+/gm, '')} Also, there is a lot more to say about this topic, and I will keep going for quite a while so that the answer is very long indeed. `.repeat(2),
  parroting: (m) => facts(m).split('\n').map((l) => l.replace(/^[^:\n]{2,90}:\s+/, '')).join(' '),
  alwaysHandoff: () => '[HANDOFF] I need to connect you with the team.',
  hallucinating: () => 'It costs UGX 99,000 per month and takes 14 days to approve, and there is a 45% fee.',
  empty: () => '',
  markdownHeavy: (m) => `## Answer\n\n**Here is what you need:**\n\n- ${facts(m).split('\n')[0].replace(/^[^:\n]{2,90}:\s+/, '')}\n- Another point\n\n### Next steps\n\n1. Do this\n2. Do that`,
  repeats: (m) => { const s = (facts(m).split('\n')[0] || '').replace(/^[^:\n]{2,90}:\s+/, '').split(/(?<=[.!?])\s+/)[0] || 'Please check the page.'; return `${s} ${s} ${s} ${s} ${s}`; },
  hangs: null, // handled separately: never produces a token until aborted
};

let finished = false;
process.on('exit', (code) => { if (!finished) { console.log('model-personalities-test: INCOMPLETE (the run ended before the summary)'); process.exitCode = 3; } });
const keepAlive = setInterval(() => {}, 100);   // the pipeline's timeout timer is unref'd: without this a hanging stub would end the process silently
(async () => {
  H.config.catalogCards = false; H.config.logFlagged = false; H.config.modelFirstTokenTimeoutMs = 200;
  const chunks = ensureFresh().chunks;
  const kbText = chunks.map((c) => c.text).join(' ') + ' ' + EN_HANDOFF + ' 24 hours';
  const chunkGrams = chunks.map((c) => grams(c.text, 5));
  for (const [name, fn] of Object.entries(PERSONALITIES)) {
    let stub;
    if (name === 'hangs') {
      const saved = { chat: H.ollama.chat, chatStream: H.ollama.chatStream };
      const never = (messages, a, b) => { const opts = (typeof a === 'object' && a) || b || {}; return new Promise((_, rej) => { if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'timeout' }))); }); };
      H.ollama.chat = (m, o) => never(m, o, {}); H.ollama.chatStream = (m, onToken, o) => never(m, onToken, o);
      stub = { restore() { H.ollama.chat = saved.chat; H.ollama.chatStream = saved.chatStream; } };
    } else stub = H.installModel(fn);
    for (const question of [...ANSWERABLE, ...OUT_OF_KNOWLEDGE]) {
      const oos = OUT_OF_KNOWLEDGE.includes(question);
      const t0 = Date.now();
      const { result } = await H.runTurn({ message: question, context: ctx });
      const ms = Date.now() - t0; const reply = String(result.reply || '').trim(); const tag = `[${name}] "${question}"`;
      check(`${tag}: no empty bubble`, reply.length > 0 && (result.bubbles || []).every((b) => String(b).trim()));
      check(`${tag}: within the time budget (${ms} ms)`, ms < (name === 'hangs' ? 1500 : 800));
      check(`${tag}: no invented figure`, numbersSupported(reply, kbText));
      // A dump = most of a multi-sentence section pasted back (canned FAQ answers are curated and exempt).
      const dumped = result.source !== 'faq' && chunks.some((c) => { const ss = splitSentences(c.text); if (ss.length < 4) return false; const hit = ss.filter((x) => reply.replace(/\s+/g, ' ').includes(x.replace(/\s+/g, ' ').slice(0, 60))).length; return hit / ss.length >= 0.8; });
      check(`${tag}: no dump (<= 120 words and not most of a section pasted back)`, reply.split(/\s+/).length <= 120 && !dumped);
      check(`${tag}: no markdown heading or leading list marker`, !/^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/.test(reply));
      if (oos) check(`${tag}: out-of-knowledge question is handed off, not answered from a model figure`, result.source === 'handoff' || /not sure/i.test(reply), result.source);
      else {
        check(`${tag}: no wrongful handoff or clarify on an answerable question`, result.source !== 'handoff' && result.source !== 'clarify', result.source);
        const q = new Set(terms(question).filter((t) => !['tell', 'know', 'want', 'make'].includes(t)));
        const r = new Set(terms(reply)); const shared = [...q].filter((t) => r.has(t)).length;
        const key = ['store', 'password', 'payment', 'order', 'pric', 'seller', 'badge', 'report', 'follow', 'descript', 'fair'];
        // WIP 98: an answer no longer starts with a "About {heading}:" lead, so it may not repeat the question's words; it is on topic when it shares a word, names a key topic, OR comes from the section whose heading shares a word with the question.
        const headTerms = new Set(terms(((result.retrieved || [])[0] || {}).heading || ''));
        const fromTopicSection = [...q].some((t) => headTerms.has(t));
        check(`${tag}: on topic`, shared >= 1 || key.some((k) => [...r].some((t) => t.startsWith(k))) || fromTopicSection, reply.slice(0, 80));
      }
    }
    stub.restore();
    console.log(`  ${name.padEnd(14)} ${ANSWERABLE.length + OUT_OF_KNOWLEDGE.length} questions checked`);
  }
  finished = true; clearInterval(keepAlive);
  console.log(`\nmodel-personalities-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
