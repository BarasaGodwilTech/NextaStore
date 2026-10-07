#!/usr/bin/env node
/**
 * npm run bench - measure how fast THIS machine really is, before you pay for a server.
 * Runs through the real pipeline (Ollama must be running with your models pulled):
 *   1. raw chat-model speed (words come out at X per second)
 *   2. an English question, start to finish
 *   3. a Luganda question that misses the phrasebook (uses your Luganda mode)
 * Then run `ollama ps` and `free -h` (Linux) in another terminal WHILE it works
 * and keep the output: that is the memory you actually need.
 */
const config = require('../src/config');
const translator = require('../src/lang/translator');
const { run } = require('../src/chat/pipeline');

const secs = (ms) => (ms / 1000).toFixed(1) + 's';

async function timed(label, message, lang, firstLabel = 'first words') {
    const t0 = Date.now();
    let first = null, tokens = 0;
    const res = await run({ message, lang, context: { audience: 'guest', page: 'marketplace' } }, {
        onToken: () => { if (first === null) first = Date.now() - t0; tokens += 1; },
        onStatus: (s) => console.log(`   [${secs(Date.now() - t0)}] ${s}`),
    });
    const total = Date.now() - t0;
    console.log(`${label}\n   ${firstLabel} after ${first === null ? 'n/a' : secs(first)}, finished in ${secs(total)}, ${res.reply.split(/\s+/).length} words, source=${res.source}`);
    console.log(`   ${res.reply.replace(/\s+/g, ' ').slice(0, 220)}${res.reply.length > 220 ? '...' : ''}\n`);
    return total;
}

(async () => {
    console.log(`Chat model: ${config.chatModel} | Luganda: ${JSON.stringify(translator.describe())} | LUGANDA_INTERLEAVE: ${config.lugandaInterleave}\n`);

    const t0 = Date.now();
    const r = await fetch(`${config.ollamaHost}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.chatModel, stream: false, keep_alive: config.keepAlive, messages: [{ role: 'user', content: 'Explain in about 80 words how to take good product photos with a phone.' }], options: { num_predict: 120 } }),
    }).catch((e) => { console.error('Cannot reach Ollama:', e.message); process.exit(1); });
    const d = await r.json();
    const tps = d.eval_count && d.eval_duration ? d.eval_count / (d.eval_duration / 1e9) : null;
    console.log(`1. Raw chat speed (includes model load on first run): ${tps ? tps.toFixed(1) + ' tokens/sec' : 'n/a'}, total ${secs(Date.now() - t0)}`);
    console.log('   Rule of thumb: ~1.3 tokens per English word. Under ~5 tokens/sec feels slow; 8+ feels fine with streaming.\n');

    await timed('2. English question', 'How do I start my first store and what should I sell?', 'en');
    await timed('2b. Same question again (warm)', 'How do I price my products?', 'en');
    await timed('3. Luganda question (not in the phrasebook)', 'Nnyinza ntya okufuna bakasitoma abangi ku edduuka lyange?', 'lg', 'first Luganda text');

    console.log('Now run `ollama ps` and `free -h` and send me both.');
})().catch((e) => { console.error(e); process.exit(1); });
