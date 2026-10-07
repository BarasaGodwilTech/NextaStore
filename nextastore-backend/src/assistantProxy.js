/**
 * Forwards Nexi (AI assistant) requests from the browser to the separate
 * assistant service (config.assistantUrl). Plain Node + global fetch only, so
 * it is unit-testable without Express.
 *
 * Why a proxy: the browser keeps using one API origin, there is no extra CORS
 * setup, the assistant service can stay private, and the limits in app.js
 * protect an expensive endpoint.
 */
const config = require('./config');
const crypto = require('crypto');

const MAX_MESSAGE = 600;

function visitorIdentity(req) {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+\S+$/i.test(auth)) {
        try {
            const token = auth.slice(7);
            const parts = token.split('.');
            if (parts.length === 3) {
                const [header, payload, signature] = parts;
                const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
                if (parsedHeader.alg !== 'HS256') throw new Error('unsupported jwt algorithm');
                const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
                const a = Buffer.from(signature);
                const b = Buffer.from(expected);
                if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad jwt signature');
                const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
                if (body && typeof body.userId === 'string' && body.userId) return `user:${body.userId}`;
            }
        } catch (e) { /* guest fallback */ }
    }
    return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function visitorKey(req) {
    return crypto.createHash('sha256').update(visitorIdentity(req)).digest('hex');
}


function send(res, status, obj) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
}

/** Only pass on the fields the assistant understands, trimmed to sane sizes. */
function cleanBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) return { error: 'Please type a question.' };
    if (message.length > MAX_MESSAGE) return { error: `Please keep your question under ${MAX_MESSAGE} characters.` };
    const history = (Array.isArray(b.history) ? b.history : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    return {
        value: {
            message,
            history,
            lang: ['en', 'lg', 'sw'].includes(b.lang) ? b.lang : undefined,
            context: b.context && typeof b.context === 'object' ? { audience: b.context.audience, page: b.context.page } : undefined,
        },
    };
}

async function callUpstream(path, init, signal) {
    const headers = { ...(init.headers || {}) };
    if (config.assistantToken) headers['x-assistant-token'] = config.assistantToken;
    return fetch(`${config.assistantUrl}${path}`, { ...init, headers, signal });
}

function unavailable(res, err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    send(res, timedOut ? 504 : 503, { message: timedOut ? 'The assistant took too long to answer. Please try again.' : 'The assistant is not available right now. Please try again shortly.' });
}

async function chat(req, res) {
    const parsed = cleanBody(req.body);
    if (parsed.error) return send(res, 400, { message: parsed.error });
    try {
        const up = await callUpstream('/api/assistant/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nexi-visitor-key': visitorKey(req) },
            body: JSON.stringify(parsed.value),
        }, AbortSignal.timeout(config.assistantTimeoutMs));
        const text = await up.text();
        res.statusCode = up.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(text);
    } catch (err) {
        unavailable(res, err);
    }
}

async function chatStream(req, res) {
    const parsed = cleanBody(req.body);
    if (parsed.error) return send(res, 400, { message: parsed.error });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.assistantTimeoutMs);
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
        const up = await callUpstream('/api/assistant/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-nexi-visitor-key': visitorKey(req) },
            body: JSON.stringify(parsed.value),
        }, ac.signal);
        if (!up.ok || !up.body) {
            const text = await up.text().catch(() => '');
            res.statusCode = up.status >= 400 ? up.status : 502;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(text || JSON.stringify({ message: 'The assistant is not available right now.' }));
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform'); // stops compression middleware buffering the stream
        res.setHeader('X-Accel-Buffering', 'no');
        if (res.flushHeaders) res.flushHeaders();
        for await (const chunk of up.body) res.write(chunk);
        res.end();
    } catch (err) {
        if (res.headersSent) {
            // Mid-stream failure: tell the browser in-band, then close.
            try { res.write(JSON.stringify({ type: 'error', message: 'The assistant was interrupted. Please try again.' }) + '\n'); } catch (e) { /* closed */ }
            res.end();
        } else {
            unavailable(res, err);
        }
    } finally {
        clearTimeout(timer);
    }
}

let startersCache = { at: 0, body: null };
async function starters(req, res) {
    if (startersCache.body && Date.now() - startersCache.at < 5 * 60 * 1000) {
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(startersCache.body); return;
    }
    try {
        const up = await callUpstream('/api/assistant/starters', {}, AbortSignal.timeout(5000));
        const text = await up.text();
        if (up.ok) startersCache = { at: Date.now(), body: text };
        res.statusCode = up.status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(text);
    } catch (err) {
        unavailable(res, err);
    }
}

module.exports = { chat, chatStream, starters, cleanBody, _visitorKey: visitorKey, _resetStartersCache: () => { startersCache = { at: 0, body: null }; } };
