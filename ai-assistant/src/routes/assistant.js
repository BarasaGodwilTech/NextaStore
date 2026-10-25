const express = require('express');
const config = require('../config');
const ollama = require('../ollama/client');
const { run } = require('../chat/pipeline');
const translator = require('../lang/translator');
const { sanitizeChatBody } = require('../chat/sanitize');
const { createLimiter } = require('../chat/limiter');
const fallback = require('../chat/fallback');
const { LG_HANDOFF, effectiveLang } = require('../lang/lgGuard');
const { isSmallTalk } = require('../chat/smalltalk');
const { matchPhrasebook } = require('../lang/phrasebook');
const faqMatch = require('../chat/faqMatch');
const answerCache = require('../chat/answerCache');
const { createDelivery } = require('../chat/deliver');

const fs = require('fs');

const router = express.Router();
const limiter = createLimiter(config.maxConcurrent, config.maxQueue, { maxWaitMs: config.queueWaitMs });
const LOAD_WAIT_MS = 6000;

function visitorKey(req) { return String(req.headers?.['x-nexi-visitor-key'] || req.ip || 'anonymous'); }

/** GET /api/assistant/health - is Ollama up, are the right models pulled. */
router.get('/health', async (req, res) => {
    const health = await ollama.checkHealth();
    res.status(health.reachable ? 200 : 503).json({ ...health, luganda: translator.describe(), queue: limiter.stats(), nexi: require('../chat/stats').snapshot() });
});

/** GET /api/assistant/handoffs - last 50 handoffs (time, reason, language, scrubbed question). Read-only; empty unless LOG_FLAGGED_MESSAGES is on. Same token gate as every assistant route. */
router.get('/handoffs', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: Boolean(config.logFlagged), handoffs: require('../chat/flagLog').readHandoffs(50) });
});

/** GET /api/assistant/starters - conversation starters (English + Luganda). */
function handleStarters(req, res) {
    try {
        res.json(JSON.parse(fs.readFileSync(config.startersPath, 'utf8')));
    } catch (e) {
        res.status(404).json({ error: 'starters not available' });
    }
}
router.get('/starters', handleStarters);

function instantPath(body) {
    const message = body.message;
    if (isSmallTalk(message)) return true;
    // WIP 92d: one language resolver everywhere (explicit toggle, then the message, then the conversation).
    const lang = effectiveLang(body.lang, message, body.history);
    if (lang === 'lg' && matchPhrasebook(message)) return true;
    if (faqMatch.match(message, { audience: body.context?.audience || 'guest' })) return true;
    const key = answerCache.keyOf(message, lang, body.context?.audience || 'guest');
    return Boolean(answerCache.get(key));
}

/** Load is never exposed to the visitor: when capacity is tight we answer from local knowledge. */
function makeStreamOut(res) {
    const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
    return {
        send,
        hooks: {
            onMeta: (m) => send({ type: 'meta', ...m }),
            onToken: (text) => send({ type: 'token', text }),
            onStatus: (stage) => send({ type: 'status', stage }),
            onBreak: () => send({ type: 'break' }),
            onTyping: () => send({ type: 'typing' }),
            onCards: (payload) => send({ type: 'cards', ...payload }),
            onReset: () => send({ type: 'reset' }),
        },
        done: (result) => send({ type: 'done', ...result, bubbles: Array.isArray(result.bubbles) ? result.bubbles : [] }),
    };
}

/** Load is never exposed to the visitor: when capacity is tight we answer from local knowledge. */
async function sendFallback(res, body, { stream = false, signal } = {}) {
    const langCode = effectiveLang(body.lang, body.message, body.history);
    const isLg = langCode === 'lg';
    const result = isLg ? { reply: LG_HANDOFF, source: 'handoff', retrieved: [], handoff: { reason: 'language_guard' }, needs_review: true } : await fallback.build(body.message, { audience: body.context?.audience || 'guest' });
    if (!stream) {
        const delivery = createDelivery({ signal });
        result.bubbles = await delivery.instant(result.reply, 'fallback');
        return res.json(result);
    }
    const out = makeStreamOut(res);
    out.send({ type: 'meta', language: { code: langCode }, source: result.source || 'fallback', retrieved: result.retrieved || [], ...(result.handoff ? { handoff: result.handoff, needs_review: true } : {}) });
    const delivery = createDelivery({
        onToken: out.hooks.onToken,
        onBreak: out.hooks.onBreak,
        onTyping: out.hooks.onTyping,
        onCards: out.hooks.onCards,
        onReset: out.hooks.onReset,
        signal,
    });
    result.bubbles = await delivery.instant(result.reply, 'fallback');
    if (!signal?.aborted) out.done(result);
    return result;
}


/** POST /api/assistant/chat - body: { message, history?, lang?, context? } */
async function handleChat(req, res, next) {
    const parsed = sanitizeChatBody(req.body);
    if (parsed.error) { res.status(400).json({ error: parsed.error }); return; }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    if (instantPath(parsed.value)) {
        try {
            const result = await run(parsed.value, { signal: ac.signal });
            if (!ac.signal.aborted) res.json(result);
        } catch (err) {
            if (!ac.signal.aborted) {
                try { await sendFallback(res, parsed.value, { signal: ac.signal }); }
                catch (fallbackErr) { next(fallbackErr); }
            }
        }
        return;
    }
    let release;
    try {
        const before = limiter.stats();
        if (before.active >= before.maxActive && before.waiting >= before.maxQueue) {
            await sendFallback(res, parsed.value, { signal: ac.signal });
            return;
        }
        release = await limiter.acquire({ signal: ac.signal, maxWaitMs: LOAD_WAIT_MS, visitorKey: visitorKey(req) });
        const loadAdaptive = before.active >= before.maxActive || before.waiting > 0;
        const body = { ...parsed.value, context: { ...(parsed.value.context || {}), loadAdaptive } };
        const result = await run(body, { signal: ac.signal });
        if (!ac.signal.aborted) res.json(result);
    } catch (err) {
        if (ac.signal.aborted) return;
        if (err.code === 'queue_full' || err.code === 'wait_timeout') {
            await sendFallback(res, parsed.value, { signal: ac.signal });
            return;
        }
        // Model failures are handled by the pipeline fallback. Keep a last-resort
        // local answer here for unexpected route-level failures too.
        try { await sendFallback(res, parsed.value, { signal: ac.signal }); }
        catch (fallbackErr) { next(fallbackErr); }
    } finally {
        if (release) release();
    }
}

router.post('/chat', handleChat);

/**
 * POST /api/assistant/chat/stream - same body, NDJSON response:
 *   {"type":"meta",...} {"type":"status","stage":"thinking|translating"} {"type":"token","text":"..."} ... {"type":"done","reply":"...",...}
 *   or {"type":"error","message":"..."}
 */
async function handleChatStream(req, res) {
    const parsed = sanitizeChatBody(req.body);
    if (parsed.error) { res.status(400).json({ error: parsed.error }); return; }

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const out = makeStreamOut(res);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    if (instantPath(parsed.value)) {
        try {
            const result = await run(parsed.value, { signal: ac.signal, ...out.hooks });
            out.done(result);
        } catch (err) {
            if (!ac.signal.aborted) await sendFallback(res, parsed.value, { stream: true, signal: ac.signal });
        } finally { res.end(); }
        return;
    }

    let release;
    try {
        const before = limiter.stats();
        if (before.active >= before.maxActive && before.waiting >= before.maxQueue) {
            await sendFallback(res, parsed.value, { stream: true, signal: ac.signal });
            res.end();
            return;
        }

        try {
            release = await limiter.acquire({
                signal: ac.signal,
                maxWaitMs: LOAD_WAIT_MS,
                visitorKey: visitorKey(req),
            });
        } catch (err) {
            if (err.code === 'queue_full' || err.code === 'wait_timeout') {
                await sendFallback(res, parsed.value, { stream: true, signal: ac.signal });
                res.end();
                return;
            }
            throw err;
        }

        const loadAdaptive = before.active >= before.maxActive || before.waiting > 0;
        const body = { ...parsed.value, context: { ...(parsed.value.context || {}), loadAdaptive } };
        const result = await run(body, { signal: ac.signal, ...out.hooks });
        out.done(result);
    } catch (err) {
        if (!ac.signal.aborted) {
            console.error('[assistant] stream error:', err.message);
            try {
                // T5: Ollama errors/timeouts and unexpected pipeline failures become
                // a useful local answer instead of a load/error message.
                await sendFallback(res, parsed.value, { stream: true, signal: ac.signal });
            } catch (fallbackErr) {
                console.error('[assistant] fallback error:', fallbackErr.message);
                const isLg = effectiveLang(parsed.value.lang, parsed.value.message, parsed.value.history) === 'lg'; const lastReply = isLg ? LG_HANDOFF : 'I can help with NextaStore buying, selling, orders, payments, and starting a store.'; out.done({ reply: lastReply, source: isLg ? 'handoff' : 'fallback', retrieved: [], bubbles: [lastReply], ...(isLg ? { handoff: { reason: 'language_guard' }, needs_review: true } : {}) });
            }
        }
    } finally {
        if (release) release();
        res.end();
    }
}

router.post('/chat/stream', handleChatStream);

module.exports = router;
module.exports.handleChat = handleChat;
module.exports.handleChatStream = handleChatStream;
module.exports.handleStarters = handleStarters;
module.exports.makeStreamOut = makeStreamOut;
module.exports._limiter = limiter; // exposed for the self-test
