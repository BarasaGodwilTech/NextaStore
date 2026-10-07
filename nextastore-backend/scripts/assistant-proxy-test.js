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

(async () => {
    let lastUpstreamBody = null;
    let lastToken = null;
    let lastVisitorKey = null;
    const upstream = await listen(async (req, res) => {
        lastToken = req.headers['x-assistant-token'] || null;
        lastVisitorKey = req.headers['x-nexi-visitor-key'] || null;
        if (req.url === '/api/assistant/starters') { res.setHeader('Content-Type', 'application/json'); res.end('{"en":{"guest":["x"]}}'); return; }
        const body = await readBody(req); lastUpstreamBody = body;
        if (req.url === '/api/assistant/chat') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ reply: 'hello', echoedHistory: body.history.length })); return; }
        if (req.url === '/api/assistant/chat/stream') {
            res.setHeader('Content-Type', 'application/x-ndjson');
            res.write('{"type":"token","text":"a"}\n'); await new Promise((r) => setTimeout(r, 120));
            res.end('{"type":"done","reply":"a"}\n'); return;
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
        res.statusCode = 404; res.end();
    });
    const port = front.address().port;

    let r = await post(port, '/chat', { message: 'hi', history: [{ role: 'system', content: 'evil' }, { role: 'user', content: 'a' }], lang: 'zz', context: { audience: 'seller', page: 'dashboard' } });
    check('chat forwarded and answered', r.status === 200 && JSON.parse(r.text).reply === 'hello');
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

    r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/starters' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); }));
    check('starters proxied', r.status === 200 && JSON.parse(r.text).en.guest[0] === 'x');

    upstream.close();
    r = await post(port, '/chat', { message: 'hi' });
    check('service down -> friendly 503 (chat)', r.status === 503 && /not available/.test(JSON.parse(r.text).message));
    r = await post(port, '/chat/stream', { message: 'hi' });
    check('service down -> friendly 503 (stream)', r.status === 503);

    front.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
