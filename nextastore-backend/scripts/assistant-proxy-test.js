/**
 * Tests the Nexi proxy (src/assistantProxy.js) against a fake assistant
 * service using plain Node http - no database or Express needed.
 * Run: node scripts/assistant-proxy-test.js
 */
const http = require('http');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const listen = (h) => new Promise((r) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r(s)); });
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

function post(port, path, body, authorization) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(authorization ? { Authorization: authorization } : {}) } }, (res) => {
            const chunks = []; const times = [];
            res.on('data', (c) => { chunks.push(c.toString()); times.push(Date.now()); });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, times, text: chunks.join('') }));
        });
        req.on('error', reject); req.end(data);
    });
}

// WIP 93: handoff / needs_review shapes the real assistant produces. The proxy must pass every field through unchanged and add none.
const PAYLOADS = {
    'wip93 en handoff': { reply: 'I need to connect you with a human team member so they can help with this. You can contact our team on WhatsApp.', bubbles: ['I need to connect you with a human team member so they can help with this. You can contact our team on WhatsApp.'], language: { code: 'en', label: 'English', confidence: 'forced' }, source: 'model', retrieved: [], handoff: { reason: 'not_in_context' }, needs_review: false },
    'wip93 lg handoff': { reply: 'Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe. Osobola okwogera n’ekibinja kyaffe ku WhatsApp.', bubbles: ['Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe. Osobola okwogera n’ekibinja kyaffe ku WhatsApp.'], language: { code: 'lg', label: 'Luganda', confidence: 'forced' }, source: 'handoff', retrieved: [], handoff: { reason: 'language_guard' }, needs_review: true },
    'wip93 user request': { reply: 'I need to connect you with a human team member.', bubbles: ['I need to connect you with a human team member.'], language: { code: 'en' }, source: 'handoff', retrieved: [], handoff: { reason: 'user_request' }, needs_review: false },
    'wip93 plain answer': { reply: 'Open the Marketplace page.', bubbles: ['Open the Marketplace page.'], language: { code: 'en' }, source: 'faq', retrieved: [] },
};

(async () => {
    let lastUpstreamBody = null;
    let lastToken = null;
    let lastVisitorKey = null;
    const upstream = await listen(async (req, res) => {
        lastToken = req.headers['x-assistant-token'] || null;
        lastVisitorKey = req.headers['x-nexi-visitor-key'] || null;
        if (req.url === '/api/assistant/handoffs') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ enabled: true, handoffs: [{ at: '2026-10-12T08:00:00.000Z', reason: 'language_guard', language: 'lg', question: 'order 123456 [email redacted]' }] })); return; }
        if (req.url === '/api/assistant/starters') { res.setHeader('Content-Type', 'application/json'); res.end('{"en":{"guest":["x"]}}'); return; }
        const body = await readBody(req); lastUpstreamBody = body;
        // WIP 93: fixed payloads whose metadata must come through the proxy byte-for-byte (see the 'unchanged' checks below).
        const fixed = PAYLOADS[body.message];
        if (fixed && req.url === '/api/assistant/chat') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixed)); return; }
        if (fixed && req.url === '/api/assistant/chat/stream') {
            res.setHeader('Content-Type', 'application/x-ndjson');
            res.write(JSON.stringify({ type: 'meta', source: fixed.source, ...(fixed.handoff ? { handoff: fixed.handoff, needs_review: fixed.needs_review } : {}) }) + '\n');
            res.write(JSON.stringify({ type: 'token', text: fixed.reply }) + '\n');
            res.end(JSON.stringify({ type: 'done', ...fixed }) + '\n'); return;
        }
        if (req.url === '/api/assistant/chat') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ reply: 'hello', echoedHistory: body.history.length, handoff: { reason: 'user_request' }, needs_review: true })); return; }
        if (req.url === '/api/assistant/chat/stream') {
            res.setHeader('Content-Type', 'application/x-ndjson');
            res.write('{"type":"token","text":"a"}\n'); await new Promise((r) => setTimeout(r, 120));
            res.end('{"type":"done","reply":"a","handoff":{"reason":"not_in_context"},"needs_review":true}\n'); return;
        }
        res.statusCode = 404; res.end('{}');
    });
    process.env.ASSISTANT_URL = `http://127.0.0.1:${upstream.address().port}`;
    process.env.ASSISTANT_TIMEOUT_MS = '3000';
    process.env.ASSISTANT_TOKEN = 'proxy-test-token';
    delete require.cache[require.resolve('../src/config')];
    const proxy = require('../src/assistantProxy');

    // Minimal glue standing in for Express: parse JSON, then call the handler.
    const front = await listen(async (req, res) => {
        req.body = await readBody(req);
        if (req.url === '/chat') return proxy.chat(req, res);
        if (req.url === '/chat/stream') return proxy.chatStream(req, res);
        if (req.url === '/starters') return proxy.starters(req, res);
        if (req.url === '/handoffs') return proxy.handoffs(req, res);
        res.statusCode = 404; res.end();
    });
    const port = front.address().port;

    let r = await post(port, '/chat', { message: 'hi', history: [{ role: 'system', content: 'evil' }, { role: 'user', content: 'a' }], lang: 'zz', context: { audience: 'seller', page: 'dashboard' } });
    check('chat forwarded and answered', r.status === 200 && JSON.parse(r.text).reply === 'hello');
    check('chat preserves handoff and needs_review response metadata untouched', JSON.parse(r.text).handoff.reason === 'user_request' && JSON.parse(r.text).needs_review === true);
    check('shared secret (ASSISTANT_TOKEN) is sent to the assistant', lastToken === 'proxy-test-token', String(lastToken));
    check('proxy sends a hashed visitor key', /^[a-f0-9]{64}$/.test(lastVisitorKey || ''), String(lastVisitorKey));
    check('system-role history dropped before forwarding', lastUpstreamBody.history.length === 1 && lastUpstreamBody.history[0].role === 'user');
    check('unknown lang dropped, context forwarded', lastUpstreamBody.lang === undefined && lastUpstreamBody.context.audience === 'seller');
    const backendConfig = require('../src/config');
    const crypto = require('crypto');
    function tokenFor(userId) {
        const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const h = enc({ alg: 'HS256', typ: 'JWT' });
        const p = enc({ userId, tv: 0, at: Math.floor(Date.now() / 1000) });
        const s = crypto.createHmac('sha256', backendConfig.jwtSecret).update(`${h}.${p}`).digest('base64url');
        return `${h}.${p}.${s}`;
    }
    const userToken = tokenFor('proxy-user-1');
    const userKey1 = proxy._visitorKey({ headers: { authorization: `Bearer ${userToken}` }, ip: '127.0.0.1' });
    const userKey2 = proxy._visitorKey({ headers: { authorization: `Bearer ${userToken}` }, ip: '127.0.0.1' });
    check('same signed-in user gets the same hashed visitor key', userKey1 === userKey2);
    const userToken2 = tokenFor('proxy-user-2');
    const userKey3 = proxy._visitorKey({ headers: { authorization: `Bearer ${userToken2}` }, ip: '127.0.0.1' });
    check('different signed-in users get different hashed visitor keys', userKey1 !== userKey3);

    r = await post(port, '/chat', { message: '' });
    check('empty message -> 400 with message field', r.status === 400 && JSON.parse(r.text).message);
    r = await post(port, '/chat', { message: 'x'.repeat(601) });
    check('over-long message -> 400', r.status === 400);

    r = await post(port, '/chat/stream', { message: 'hi' });
    check('stream passes NDJSON through', r.status === 200 && /ndjson/.test(r.headers['content-type']) && /no-transform/.test(r.headers['cache-control']));
    check('stream arrives incrementally, not buffered', r.chunks.length >= 2 && r.times[r.times.length - 1] - r.times[0] >= 80, `chunks=${r.chunks.length}`);
    check('stream ends with done event', /"type":"done"/.test(r.text));
    check('stream preserves handoff and needs_review fields in done event', /"handoff":\{"reason":"not_in_context"\}/.test(r.text) && /"needs_review":true/.test(r.text));

    // WIP 93: handoff and needs_review pass through /chat and /chat/stream UNCHANGED (deep-equal / byte-equal), and nothing is added when absent.
    const assert = require('assert');
    for (const [message, payload] of Object.entries(PAYLOADS)) {
        let rr = await post(port, '/chat', { message });
        let same = false; try { assert.deepStrictEqual(JSON.parse(rr.text), payload); same = true; } catch (e) { /* reported below */ }
        check(`/chat passes the "${message}" response through unchanged (every field, no additions)`, rr.status === 200 && same, rr.text.slice(0, 200));
        rr = await post(port, '/chat/stream', { message });
        const expected = JSON.stringify({ type: 'meta', source: payload.source, ...(payload.handoff ? { handoff: payload.handoff, needs_review: payload.needs_review } : {}) }) + '\n' + JSON.stringify({ type: 'token', text: payload.reply }) + '\n' + JSON.stringify({ type: 'done', ...payload }) + '\n';
        check(`/chat/stream passes the "${message}" events through byte-for-byte`, rr.status === 200 && rr.text === expected, rr.text.slice(0, 200));
    }
    {
        const lgChat = JSON.parse((await post(port, '/chat', { message: 'wip93 lg handoff' })).text);
        check('Luganda handoff keeps handoff.reason=language_guard and needs_review=true; the Luganda text has no review note', lgChat.handoff.reason === 'language_guard' && lgChat.needs_review === true && !/DRAFT|needs_review/i.test(lgChat.reply));
        const plain = JSON.parse((await post(port, '/chat', { message: 'wip93 plain answer' })).text);
        check('a plain answer gets no handoff or needs_review injected by the proxy', !('handoff' in plain) && !('needs_review' in plain));
    }

    // WIP 93: the public GET /api/assistant/handoff-contact has the SAME rate limiting as the other public assistant reads (/starters, /facts):
    // it is mounted AFTER the baseline /api limiter (300/min/IP) in app.js and the router defines no bypass. Static check: the backend app cannot be
    // loaded here without express-rate-limit/Prisma.
    {
        const fs = require('fs'); const path = require('path');
        const appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
        const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/assistant.js'), 'utf8');
        const general = appSrc.indexOf("app.use('/api', generalApiLimiter)");
        const mount = appSrc.indexOf("app.use('/api/assistant', assistantRoutes)");
        check('handoff-contact is covered by the baseline /api rate limiter: it is mounted after app.use("/api", generalApiLimiter)', general > 0 && mount > general);
        check('handoff-contact, /starters and /facts live in the same router, with no per-route limiter bypass', /router\.get\('\/handoff-contact'/.test(routeSrc) && /router\.get\('\/starters'/.test(routeSrc) && /router\.get\('\/facts'/.test(routeSrc) && !/skip\s*:|rateLimit/.test(routeSrc));
        check('handoff-contact is read-only, allowlisted and cacheable (Cache-Control public, short max-age)', /Cache-Control', 'public, max-age=\d+/.test(routeSrc));
        // The chat limiters (12/min, 100/h) are for /chat and /chat/stream only; the assistant reads must not be starved by them.
        check('the tighter chat limiters are mounted on /api/assistant/chat only (they do not apply to handoff-contact)', /app\.use\('\/api\/assistant\/chat', assistantMinuteLimiter, assistantHourLimiter\)/.test(appSrc));
    }

    r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/starters' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }));
    check('starters proxied', r.status === 200 && JSON.parse(r.text).en.guest[0] === 'x');

    r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/handoffs' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); }));
    check('WIP 93: handoffs list proxied unchanged, with the shared secret, never cached', r.status === 200 && JSON.parse(r.text).handoffs[0].reason === 'language_guard' && JSON.parse(r.text).handoffs[0].question === 'order 123456 [email redacted]' && lastToken === 'proxy-test-token' && /no-store/.test(r.headers['cache-control'] || ''), r.text);

    upstream.close();
    r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/handoffs' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }));
    check('WIP 93: handoffs list with the assistant down -> friendly 503', r.status === 503 && /not available/.test(JSON.parse(r.text).message));
    r = await post(port, '/chat', { message: 'hi' });
    check('service down -> friendly 503 (chat)', r.status === 503 && /not available/.test(JSON.parse(r.text).message));
    r = await post(port, '/chat/stream', { message: 'hi' });
    check('service down -> friendly 503 (stream)', r.status === 503);

    front.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
