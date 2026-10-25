#!/usr/bin/env node
'use strict';
// Usage: node scripts/chat-eval.js [baseURL] [token]
// Requires the assistant to be running (with whatever CHAT_MODEL you want to judge); this script does not start Ollama or the backend.
//   node scripts/chat-eval.js [baseURL] [token]              question sets: gold + held-out + out-of-knowledge (WIP 97), per-question pass/fail + summary
//   node scripts/chat-eval.js [baseURL] [token] --scenarios  the older multi-turn scenarios (JSON rows)
//   --limit N   only the first N questions of each set (quick smoke run)
// To judge a new model: change ONLY CHAT_MODEL in the assistant's .env, restart it, run this again and compare the summary tables.
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] === '--limit'));
const base = (positional[0] || 'http://127.0.0.1:4100').replace(/\/$/, '');
const token = positional[1] || process.env.ASSISTANT_TOKEN || '';
const fs = require('fs');
const factsPath = require('path').join(__dirname, '../src/knowledge/90-project-facts.generated.md');
let factsNumbers = new Set(); try { const factsText = fs.readFileSync(factsPath, 'utf8'); factsNumbers = new Set((factsText.match(/\b(?:UGX\s*)?[\d,]+(?:\.\d+)?\b/g) || []).map((n) => n.replace(/\D/g, ''))); } catch { /* missing snapshot is reported as no number baseline */ }
const cases = [
  ['store link follow-up', ['how do i create an account to sell', 'i want the link']],
  ['store opening', ['how do I open a store', 'yes', 'link please', 'take me there', 'where is it']],
  ['seller pass follow-up', ['how much is seller pass', 'and the trial?', 'how long?']],
  ['order cancellation', ['how do I cancel an order', 'within how long']],
  ['mobile money follow-up', ['can I pay with mobile money', 'and card?']],
  ['verification link', ['I did not get my verification email', 'link']],
  ['Luganda identity', ['bakuyita ani', 'gwe ani', 'oliwawa', 'oli mukulembeze', 'luganda', 'nsaba omuyambi', 'ndi ani']],
  ['platform questions', ['how do I track an order', 'is Seller Pass refundable', 'what are the password rules', 'how do I contact support']],
  ['outside-world business registration', ['how do I register a business in Uganda']],
  ['outside-world market price', ['what is a fair price for a used phone', 'mobile money withdrawal charges']],
];
function flags(text, scenario) {
  const platformCase = !/outside-world/i.test(String(scenario));
  const numbers = String(text).match(/\b(?:UGX\s*)?[\d,]+(?:\.\d+)?\b/g) || [];
  const numberNotInFacts = platformCase && numbers.some((n) => { const digits = n.replace(/\D/g, ''); return digits && factsNumbers.size && !factsNumbers.has(digits); });
  return {
    rawAllowedPath: /\/(?:signup|orders|subscription|messages|safety|login|marketplace)\b/.test(text) && !(/\[[^\]]+\]\(\//.test(text)),
    wrongTopicOrMaintainerWording: /omukulembeze|knowledge base|facts file|generated|authority/i.test(text),
    linkCount: (text.match(/\[[^\]]+\]\(\//g) || []).length,
    numberNotInFacts: Boolean(numberNotInFacts),
  };
}
async function ask(message, history) {
  const start = Date.now(); let firstTokenMs = null; let done = null; let buffer = '';
  const response = await fetch(`${base}/api/assistant/chat/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-assistant-token': token } : {}) },
    body: JSON.stringify({ message, history }),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  while (true) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'token' && firstTokenMs === null) firstTokenMs = Date.now() - start;
      if (event.type === 'done') done = event;
      if (event.type === 'error') throw new Error(event.message || 'stream error');
    }
  }
  const totalMs = Date.now() - start;
  const reply = String(done?.reply || (Array.isArray(done?.bubbles) ? done.bubbles.join('\n\n') : ''));
  return { reply, firstTokenMs, totalMs, source: done?.source || 'unknown' };
}
// ---------- WIP 97: question sets ----------
const path = require('path');
const loadSet = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', f), 'utf8'));
const limitArg = process.argv.indexOf('--limit'); const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
const take = (arr) => (LIMIT ? arr.slice(0, LIMIT) : arr);
async function runSets() {
  process.chdir(path.join(__dirname, '..'));
  const { ensureFresh } = require('../src/rag/retrieve');
  const { terms } = require('../src/rag/bm25');
  const { splitSentences } = require('../src/chat/compose');
  const { numbersSupported } = require('../src/chat/numbers');
  const chunks = ensureFresh().chunks; const kb = chunks.map((c) => c.text).join(' ');
  const accepted = (labels) => chunks.filter((c) => labels.some((l) => l.startsWith('src:') ? c.source.startsWith(l.slice(4)) : (c.heading || '').toLowerCase().includes(l.toLowerCase())));
  const sets = [['gold', take(loadSet('retrieval-gold.json')), false], ['held-out', take(loadSet('retrieval-heldout.json')), false], ['out-of-knowledge', take(loadSet('retrieval-oos.json')).map((q) => [q, []]), true]];
  const stats = {}; const all = [];
  console.log('set'.padEnd(17) + 'question'.padEnd(52) + 'src'.padEnd(9) + 'topic fact dump hand  ttft   total');
  for (const [setName, rows, oos] of sets) {
    stats[setName] = { n: 0, topic: 0, fact: 0, nodump: 0, handoffOk: 0, ttft: [], total: [], errors: 0 };
    for (const [question, labels] of rows) {
      let r; try { r = await ask(question, []); } catch (e) { stats[setName].n++; stats[setName].errors++; console.log(setName.padEnd(17) + question.slice(0, 50).padEnd(52) + 'ERROR ' + e.message); continue; }
      const reply = r.reply; const st = stats[setName]; st.n++;
      const acc = oos ? [] : accepted(labels);
      const qTerms = new Set(terms(question)); const rTerms = new Set(terms(reply));
      const handedOff = r.source === 'handoff' || /not sure|connect you|team/i.test(reply);
      const topic = oos ? true : [...qTerms].some((t) => rTerms.has(t)) || acc.some((c) => terms(c.heading).some((t) => rTerms.has(t)));
      const fact = oos ? true : acc.some((c) => { const g = new Set(splitSentences(c.text).flatMap((x) => terms(x))); return [...rTerms].filter((t) => g.has(t)).length >= 3; }) || handedOff;
      const dumped = chunks.some((c) => { const ss = splitSentences(c.text); return ss.length >= 4 && ss.filter((x) => reply.replace(/\s+/g, ' ').includes(x.replace(/\s+/g, ' ').slice(0, 60))).length / ss.length >= 0.8; }) || reply.split(/\s+/).length > 140 || (!oos && !numbersSupported(reply, kb + ' 24 hours'));
      const handoffOk = oos ? handedOff : r.source !== 'handoff' && r.source !== 'clarify';
      if (topic) st.topic++; if (fact) st.fact++; if (!dumped) st.nodump++; if (handoffOk) st.handoffOk++;
      if (Number.isFinite(r.firstTokenMs)) st.ttft.push(r.firstTokenMs); if (Number.isFinite(r.totalMs)) st.total.push(r.totalMs);
      const yn = (b) => (b ? 'ok  ' : 'FAIL');
      console.log(setName.padEnd(17) + question.slice(0, 50).padEnd(52) + String(r.source).padEnd(9) + `${yn(topic)} ${yn(fact)} ${yn(!dumped)} ${yn(handoffOk)} ${String(r.firstTokenMs ?? '-').padStart(5)} ${String(r.totalMs ?? '-').padStart(6)}`);
      all.push({ setName, question, reply, source: r.source });
    }
  }
  const pct = (a, p) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))] : '-'; };
  console.log('\nSUMMARY (every column is the number of questions that passed; "handoff" = answered when it should be, handed off when it should be)');
  console.log('set'.padEnd(18) + 'n'.padStart(4) + 'on-topic'.padStart(10) + 'key fact'.padStart(10) + 'no dump'.padStart(9) + 'handoff'.padStart(9) + 'errors'.padStart(8) + 'ttft p50/p95'.padStart(15) + 'total p50/p95'.padStart(16));
  for (const [k, v] of Object.entries(stats)) console.log(k.padEnd(18) + String(v.n).padStart(4) + String(v.topic).padStart(10) + String(v.fact).padStart(10) + String(v.nodump).padStart(9) + String(v.handoffOk).padStart(9) + String(v.errors).padStart(8) + `${pct(v.ttft, .5)}/${pct(v.ttft, .95)}`.padStart(15) + `${pct(v.total, .5)}/${pct(v.total, .95)}`.padStart(16));
  if (process.argv.includes('--json')) fs.writeFileSync('chat-eval-last.json', JSON.stringify(all, null, 1));
}
async function runScenarios() {
  const rows = [];
  for (const [scenario, turns] of cases) {
    const history = [];
    for (const message of turns) {
      try {
        const result = await ask(message, history);
        rows.push({ scenario, turn: message, source: result.source, firstTokenMs: result.firstTokenMs, totalMs: result.totalMs, flags: flags(result.reply, scenario), reply: result.reply });
        history.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply });
      } catch (error) {
        rows.push({ scenario, turn: message, source: 'error', firstTokenMs: null, totalMs: null, flags: { error: true }, reply: String(error.message || error) });
      }
    }
  }
  console.log(JSON.stringify(rows, null, 2));
  for (const field of ['firstTokenMs', 'totalMs']) {
    const values = rows.map((r) => r[field]).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (p) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
    console.log(JSON.stringify({ metric: field, samples: values.length, p50: pct(0.5), p95: pct(0.95) }));
  }
}
(async () => { if (process.argv.includes('--scenarios')) await runScenarios(); else await runSets(); })().catch((error) => { console.error(error); process.exitCode = 1; });
