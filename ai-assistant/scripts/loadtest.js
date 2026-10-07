#!/usr/bin/env node
'use strict';

/**
 * Nexi load test. Mock mode boots the real assistant Express app plus a tiny
 * local Ollama stub, so it exercises routing, FAQ/small-talk/cache/limiter
 * behaviour without needing a model. Real mode targets --url directly.
 */
const http = require('http');
const { randomUUID } = require('crypto');

const USERS = Number(process.argv.find((x) => x.startsWith('--users='))?.split('=')[1]) || 20;
const MOCK = process.argv.includes('--mock');
const URL_ARG = process.argv.find((x) => x.startsWith('--url='))?.split('=')[1] || process.env.LOADTEST_URL || 'http://127.0.0.1:4100';
const TOKEN = process.argv.find((x) => x.startsWith('--token='))?.split('=')[1] || process.env.ASSISTANT_TOKEN || '';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mixFor(i) {
    const n = i % 20;
    if (n < 8) return ['hello', 'thanks', 'good morning', 'who are you', 'bye', 'hi there', 'asante sana', 'oli otya'][n];
    if (n < 15) return ['How do I open a store?', 'How much is Seller Pass?', 'How do I cancel an order?', 'What payment methods are available?', 'How do I buy safely?', 'How do I contact a seller?', 'Does NextaStore support delivery?'][n - 8];
    return ['How should I price my products?', 'How can I get my first customers?', 'What makes a good product photo?', 'How should I choose what to sell?', 'How can I improve my store description?'][n - 15];
}

async function post(base, user, message) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
        // Direct assistant mode uses this to model distinct visitors. The
        // production backend derives this value itself from auth/IP.
        'x-nexi-visitor-key': `loadtest-${user}`,
    };
    if (TOKEN) headers['x-assistant-token'] = TOKEN;

    const start = performance.now();
    const res = await fetch(`${base}/api/assistant/chat/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, history: [], context: { audience: 'guest', page: 'marketplace' } }),
    });
    const first = [];
    let source = 'unknown';
    let reply = '';
    let error = null;
    if (!res.ok) {
        error = `HTTP ${res.status}`;
        return { source, reply, firstWordMs: null, totalMs: performance.now() - start, error };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstWordAt = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === 'meta' && ev.source) source = ev.source;
            if (ev.type === 'token' && ev.text) {
                if (firstWordAt == null && /\S/.test(ev.text)) firstWordAt = performance.now();
                first.push(ev.text);
            }
            if (ev.type === 'done') {
                if (ev.source) source = ev.source;
                reply = typeof ev.reply === 'string' ? ev.reply : first.join('');
            }
            if (ev.type === 'error') error = ev.message || 'stream error';
        }
    }
    if (!reply) reply = first.join('');
    return {
        source,
        reply,
        firstWordMs: firstWordAt == null ? null : firstWordAt - start,
        totalMs: performance.now() - start,
        error,
    };
}

async function startMock() {
    const ollama = http.createServer(async (req, res) => {
        if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
        let body = ''; for await (const c of req) body += c;
        const b = JSON.parse(body || '{}');
        const user = b.messages?.[b.messages.length - 1]?.content || '';
        const answer = `MOCK answer for ${user}.`;
        if (b.stream) {
            res.setHeader('Content-Type', 'application/x-ndjson');
            await sleep(20);
            res.write(JSON.stringify({ message: { content: answer } }) + '\n');
            res.end(JSON.stringify({ done: true, prompt_eval_count: 20 }) + '\n');
        } else {
            await sleep(20);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ message: { content: answer }, prompt_eval_count: 20 }));
        }
    });
    await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;
    const app = require('../src/app');
    const assistant = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => assistant.once('listening', resolve));
    return { ollama, assistant, base: `http://127.0.0.1:${assistant.address().port}` };
}

function percentile(values, p) {
    const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!xs.length) return null;
    return xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
}

(async () => {
    let servers = null;
    if (MOCK) servers = await startMock();
    const base = servers ? servers.base : URL_ARG;
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: USERS }, (_, i) => post(base, i, mixFor(i))));
    const elapsed = performance.now() - started;

    const bySource = {};
    let errors = 0, forbidden = 0;
    const first = [], total = [];
    for (const r of results) {
        bySource[r.source] = (bySource[r.source] || 0) + 1;
        if (r.error) errors++;
        if (/\b(busy|queue|in line|try again)\b/i.test(r.reply || '')) forbidden++;
        if (r.firstWordMs != null) first.push(r.firstWordMs);
        if (r.totalMs != null) total.push(r.totalMs);
    }

    console.log(`loadtest users=${USERS} mode=${MOCK ? 'mock' : 'real'} elapsed=${elapsed.toFixed(0)}ms`);
    console.log('answers by source:', JSON.stringify(bySource));
    console.log(`time to first word: p50=${percentile(first, 50)?.toFixed(0) ?? 'n/a'}ms p95=${percentile(first, 95)?.toFixed(0) ?? 'n/a'}ms`);
    console.log(`total time: p50=${percentile(total, 50)?.toFixed(0) ?? 'n/a'}ms p95=${percentile(total, 95)?.toFixed(0) ?? 'n/a'}ms`);
    console.log(`answers containing forbidden load text: ${forbidden}`);
    console.log(`errors: ${errors}`);

    if (servers) { servers.assistant.close(); servers.ollama.close(); }
    process.exit(errors || forbidden ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
