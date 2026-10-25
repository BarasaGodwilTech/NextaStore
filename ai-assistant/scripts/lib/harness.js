'use strict';
/**
 * WIP 92d: shared test harness for the pipeline tests (differential, hallucination guard, matrix).
 * Everything is deterministic and offline: the Ollama chat functions are replaced on the real client
 * module, so the REAL pipeline.run() (routing, retrieval, gates, delivery, caches) is what runs.
 */
const config = require('../../src/config');
const ollama = require('../../src/ollama/client');
const translator = require('../../src/lang/translator');
const localT = require('../../src/lang/localTranslate');
const answerCache = require('../../src/chat/answerCache');
const pipeline = require('../../src/chat/pipeline');

// Fast pacing: no typing pauses.
const FAST = { firstDelayMs: 0, wordsPerSecond: 100000, pauseScale: 0 };

function chunksOf(text, size = 7) { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; }

/** The "### heading\ntext" blocks of the Knowledge section inside the system prompt. */
function contextOf(systemPrompt) {
    const s = String(systemPrompt || '');
    // WIP 97: the facts block is now "Heading: sentences" lines after "Facts:"; present it to the stubs as the old "### heading" blocks.
    const f = s.indexOf('\nFacts:\n');
    if (f >= 0) {
        return s.slice(f + 8).split('\n').filter((l) => l.trim()).map((l) => {
            const m = /^([^:.\n]{2,90}):\s+(.*)$/.exec(l);
            return m ? `### ${m[1]}\n${m[2]}` : `### Facts\n${l}`;
        }).join('\n');
    }
    const i = s.indexOf('### ');
    return i >= 0 ? s.slice(i) : '';
}
function sentencesOf(text) { return String(text || '').replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+(?=\s|$)/g) || []; }

/**
 * Deterministic EXTRACTIVE stub: answers with the first two sentences of the first context block that
 * is not a heading-only block. It can only ever restate the retrieved context, so a sane claim check
 * must never alter its output. No context -> a fixed "not sure" sentence.
 */
function extractiveReply(messages) {
    const ctx = contextOf(messages[0] && messages[0].content);
    const blocks = ctx.split(/\n(?=### )/).map((b) => b.replace(/^### [^\n]*\n?/, '').trim()).filter(Boolean);
    for (const b of blocks) {
        const plain = b.replace(/^[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
        const sents = sentencesOf(plain);
        if (sents.length) return sents.slice(0, 2).join('').trim();
    }
    return 'I am not sure about that.';
}

/**
 * Install a stub model. `reply` is (messages, call) => string | string[] (array = exact chunks to stream).
 * Returns { restore, calls }.
 */
function installModel(reply = extractiveReply, { chunk = 7 } = {}) {
    const saved = { chat: ollama.chat, chatStream: ollama.chatStream };
    const calls = [];
    const produce = (messages) => { const call = { messages, system: messages[0].content, user: messages[messages.length - 1].content }; calls.push(call); return reply(messages, call); };
    ollama.chat = async (messages) => { const r = produce(messages); return Array.isArray(r) ? r.join('') : r; };
    ollama.chatStream = async (messages, onToken, opts = {}) => {
        const r = produce(messages);
        const parts = Array.isArray(r) ? r : chunksOf(r, chunk);
        for (const p of parts) { if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Request cancelled.'), { code: 'cancelled', status: 499 }); onToken(p); await Promise.resolve(); }
        return parts.join('');
    };
    return { calls, restore() { ollama.chat = saved.chat; ollama.chatStream = saved.chatStream; } };
}

/**
 * Translator modes for the Luganda path. The stub "Luganda" is vowel-final pseudo-Luganda (every English
 * word gets an "a" appended) so that the English-leak detector sees open syllables, like the real thing.
 *   on        every sentence translated
 *   partial   the sentence containing "FAILME" is returned in English (translator reports it untranslated)
 *   off       no translator at all (provider off)
 *   throwing  the translator throws on first use
 */
function pseudoLuganda(sentence) { return String(sentence).replace(/[A-Za-z]{2,}/g, (w) => w.toLowerCase() + 'a'); }
function installTranslator(mode) {
    const saved = { provider: config.lugandaProvider, ganda: config.gandaModel, create: translator.createStreaming, translate: localT.translate };
    const state = { mode, translateCalls: 0 };
    if (mode === 'off') { config.lugandaProvider = 'off'; config.gandaModel = ''; } else {
        config.lugandaProvider = 'local'; config.gandaModel = 'stub-ganda';
        const real = saved.create;
        translator.createStreaming = (opts) => {
            if (mode === 'on') {
                // real splitter + held queue, stub sentence translation through localT.translate below
            }
            return real(opts);
        };
        localT.translate = async (text, hooks = {}) => {
            state.translateCalls += 1;
            if (mode === 'throwing') throw new Error('translator exploded');
            const pieces = localT.splitPieces(text);
            let translated = 0, total = 0, out = '';
            for (const p of pieces) {
                if (!p.text) { out += p.suffix; continue; }
                if (!localT.hasTranslatableText(p.text)) { out += p.prefix + p.text + p.suffix; continue; }
                total += 1;
                if (mode === 'partial' && /FAILME/.test(p.text)) { out += p.prefix + p.text + p.suffix; continue; }
                translated += 1;
                out += p.prefix + pseudoLuganda(p.text) + p.suffix;
            }
            if (!translated) return null;
            return { text: out, translated, total };
        };
    }
    localT.resetForTests();
    return { state, restore() { config.lugandaProvider = saved.provider; config.gandaModel = saved.ganda; translator.createStreaming = saved.create; localT.translate = saved.translate; localT.resetForTests(); } };
}

/** Run one turn through the REAL pipeline.run(). Returns the result plus everything the stream saw. */
async function runTurn(body, { stream = false, signal } = {}) {
    answerCache.clear();
    const events = [];
    let tokens = '';
    const hooks = { pace: FAST, signal };
    if (stream) {
        hooks.onToken = (t) => { tokens += t; events.push('token'); };
        hooks.onBreak = () => { tokens += '\n\n'; events.push('break'); };
        hooks.onReset = () => { tokens = ''; events.push('reset'); };
        hooks.onStatus = (s) => events.push('status:' + s);
        hooks.onMeta = (m) => events.push({ meta: m });
    }
    const result = await pipeline.run(body, hooks);
    return { result, streamed: tokens, events };
}

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ENGLISH_RE = /\b(?:the|and|you|your|please|contact|delivery|refund|orders?|payments?|seller|store|account|password|support|team)\b/i;

module.exports = { FAST, chunksOf, contextOf, sentencesOf, extractiveReply, installModel, installTranslator, pseudoLuganda, runTurn, flat, ENGLISH_RE, config, ollama, translator, localT, answerCache, pipeline };
