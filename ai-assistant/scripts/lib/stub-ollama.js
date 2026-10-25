/**
 * WIP 93: a controllable stub Ollama (HTTP) for pipeline tests. No models, no network.
 * - main chat model: replies with `stub.script` (text, or chunks[] sent as separate NDJSON lines; `splitMultibyte` cuts a
 *   chunk's JSON line INSIDE a multi-byte character; `mode: 'down'` destroys the socket; `mode: 'hang'` never answers).
 * - ganda-test (the Luganda translator model): `stub.ganda` = 'ok' | 'echo' | 'http500' | 'partial' (fails sentences containing FAILME).
 * The fake "Luganda" appends 'a' to every English word (vowel-final, so the structural gate treats it as Luganda), exactly like selftest.js.
 */
const http = require('http');

function hashVec(text) {
    const v = new Array(256).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z]{3,}/g) || []) {
        let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 256] += 1;
    }
    return v;
}
function readBody(req) {
    return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
}

async function start() {
    const stub = { script: { text: 'MOCK ok.' }, ganda: 'ok', gandaCalls: 0, mainCalls: 0, lastUser: '', sockets: new Set() };
    stub.server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url === '/api/embeddings') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ embedding: hashVec(body.prompt) })); return; }
        if (req.url === '/api/chat' && body.model === 'ganda-test') {
            stub.gandaCalls += 1;
            const prompt = body.messages[0].content.replace(/^Translate to Luganda[^\n]*\n/, '');
            if (stub.ganda === 'http500') { res.statusCode = 500; res.end('{}'); return; }
            if (stub.ganda === 'echo' || (stub.ganda === 'partial' && /FAILME/.test(prompt))) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: { content: prompt } })); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ message: { content: 'LGA: ' + prompt.replace(/[A-Za-z]+/g, (w) => w.toLowerCase() + 'a') } })); return;
        }
        if (req.url === '/api/chat') {
            stub.mainCalls += 1;
            stub.lastUser = body.messages[body.messages.length - 1].content; stub.lastSystem = body.messages[0].content;
            const sc = stub.script;
            if (sc.mode === 'down') { req.socket.destroy(); return; }
            if (sc.mode === 'hang') return;
            const chunks = sc.chunks || [sc.text];
            if (body.stream) {
                res.setHeader('Content-Type', 'application/x-ndjson');
                for (const c of chunks) {
                    const buf = Buffer.from(JSON.stringify({ message: { content: c } }) + '\n');
                    const multi = sc.splitMultibyte && /[^\x00-\x7f]/.test(c);
                    if (multi) {
                        const at = buf.indexOf(Buffer.from(c.match(/[^\x00-\x7f]/)[0])) + 1; // inside the first multi-byte character
                        res.write(buf.slice(0, at)); await new Promise((r) => setTimeout(r, 8)); res.write(buf.slice(at));
                    } else res.write(buf);
                    await new Promise((r) => setTimeout(r, 4));
                }
                res.end(JSON.stringify({ done: true }) + '\n'); return;
            }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: { content: chunks.join('') } })); return;
        }
        res.statusCode = 404; res.end('{}');
    });
    stub.server.on('connection', (s) => { stub.sockets.add(s); s.on('close', () => stub.sockets.delete(s)); });
    await new Promise((r) => stub.server.listen(0, '127.0.0.1', r));
    stub.port = stub.server.address().port;
    stub.host = `http://127.0.0.1:${stub.port}`;
    stub.close = () => { for (const s of stub.sockets) s.destroy(); stub.server.close(); };
    return stub;
}
module.exports = { start, hashVec };
