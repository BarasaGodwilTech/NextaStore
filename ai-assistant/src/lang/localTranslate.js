/**
 * English -> Luganda on THIS machine, using Ganda Gemma 1B (Crane AI Labs) served by Ollama.
 * Nothing is sent to a third party.
 *
 * Why it is built this way (a 1B model is small, so we fence it in):
 *  - Translate sentence by sentence, not whole answers: short inputs are far more reliable,
 *    and each finished sentence can be streamed to the browser straight away.
 *  - Markdown links are swapped for tokens first so paths like /signup cannot be mangled.
 *  - Numbers must survive. If a translated sentence changes, drops or invents a digit
 *    (prices, fees, days), that sentence is kept in English instead. Wrong money in
 *    Luganda is worse than a sentence of English.
 *  - If the model just echoes English or returns nothing, that sentence stays English too.
 *  - Approved pairs in translation-memory.json win over the model.
 * It is still machine translation: see README "Luganda" for the honest limits.
 */
const fs = require('fs');
const config = require('../config');
const ollama = require('../ollama/client');
const { protectLinks, restoreLinks } = require('./links');
const { looksEnglish } = require('./detect');

const CACHE_MAX = 500;
const cache = new Map();
let memory = null;

function enabled() { return Boolean(config.gandaModel); }

function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?:;,]+$/g, '').trim();
}

function loadMemory() {
    if (memory) return memory;
    memory = new Map();
    try {
        const data = JSON.parse(fs.readFileSync(config.translationMemoryPath, 'utf8'));
        for (const e of data.entries || []) if (e && e.en && e.lg) memory.set(norm(e.en), String(e.lg));
    } catch (err) { /* no file or bad JSON: model only */ }
    return memory;
}
/** Runtime helper (tests, or a future admin tool). */
function addMemory(en, lg) { loadMemory().set(norm(en), String(lg)); }
function resetForTests() { cache.clear(); memory = null; }

function remember(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
}

/** Digit sequences in order, e.g. "UGX 50,000 in 3 days" -> ["50000","3"]. */
function numbersOf(text) {
    return (String(text).replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) || []);
}
function sameNumbers(a, b) {
    const x = numbersOf(a).slice().sort().join('|');
    const y = numbersOf(b).slice().sort().join('|');
    return x === y;
}

/** Put real markdown links back in place of ⟦n⟧ tokens (used while streaming each piece). */
function inlineLinks(text, links) {
    return text.replace(/⟦\s*(\d+)\s*⟧/g, (m, i) => links[Number(i)] || '');
}

/** Remove things small models like to add around a translation. */
function cleanOutput(raw) {
    let t = String(raw || '').trim();
    t = t.replace(/^```[a-z]*\n?|```$/g, '').trim();
    t = t.replace(/^(luganda|translation|here is the translation)\s*[:\-]\s*/i, '');
    t = t.replace(/\*\*/g, ''); // bold markers are not trusted through a 1B model
    if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
    return t;
}

/**
 * Split an English answer into translatable pieces, keeping layout.
 * Each piece: { prefix, text, suffix } where prefix is "- " / "1. " and suffix the line break.
 */
function splitPieces(text) {
    const pieces = [];
    const lines = String(text).split('\n');
    lines.forEach((line, li) => {
        const nl = li < lines.length - 1 ? '\n' : '';
        if (!line.trim()) { pieces.push({ prefix: '', text: '', suffix: line + nl }); return; }
        const m = line.match(/^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/);
        const prefix = m ? m[1] : '';
        const body = m ? m[2] : line;
        const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
        sentences.forEach((s, si) => {
            const last = si === sentences.length - 1;
            pieces.push({ prefix: si === 0 ? prefix : '', text: s, suffix: last ? nl : ' ' });
        });
    });
    return pieces;
}

async function modelTranslate(sentence, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.translateChunkTimeoutMs);
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
        const out = await ollama.chat(
            [{ role: 'user', content: `Translate to Luganda:\n${sentence}` }],
            {
                model: config.gandaModel,
                temperature: 0.1,
                numPredict: Math.min(400, Math.max(48, Math.ceil(sentence.length * 0.8))),
                signal: ac.signal,
            }
        );
        return cleanOutput(out);
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/** Translate ONE sentence (links already tokenised). Returns Luganda, or null to keep English. */
async function translateSentence(sentence, signal) {
    const key = norm(sentence);
    const mem = loadMemory();
    if (mem.has(key)) return mem.get(key);
    if (cache.has(key)) return cache.get(key);
    // Nothing to translate: only tokens, digits or punctuation.
    if (!/[A-Za-z]{2,}/.test(sentence.replace(/⟦\d+⟧/g, ''))) return null;

    let out;
    try { out = await modelTranslate(sentence, signal); } catch (err) {
        if (signal && signal.aborted) throw err; // client left: stop work
        console.warn('[assistant] local Luganda translate failed:', err.message);
        return null;
    }
    if (!out) return null;
    if (looksEnglish(out)) return null;                       // model echoed English
    if (!sameNumbers(sentence, out)) return null;             // changed a figure: not safe
    const tokens = sentence.match(/⟦\d+⟧/g) || [];
    if (tokens.some((t) => !out.includes(t))) return null;    // lost a link token
    remember(key, out);
    return out;
}

/**
 * @param {string} text English answer (markdown-lite)
 * @param {{signal?: AbortSignal, onChunk?: (s: string) => void}} [hooks] onChunk gets each finished piece
 * @returns {Promise<{text: string, translated: number, total: number}|null>} null when nothing could be translated
 */
async function translate(text, hooks = {}) {
    if (!enabled() || !text || !text.trim()) return null;
    const { signal, onChunk } = hooks;
    const { out: protectedText, links } = protectLinks(text);
    const pieces = splitPieces(protectedText);
    let translated = 0, total = 0, result = '';

    for (const p of pieces) {
        let piece;
        if (!p.text) {
            piece = p.suffix;
        } else {
            total += 1;
            const lg = await translateSentence(p.text, signal);
            if (lg) translated += 1;
            piece = p.prefix + (lg || p.text) + p.suffix;
        }
        result += piece;
        if (onChunk) onChunk(inlineLinks(piece, links));
    }
    if (!translated) return null;
    return { text: restoreLinks(result, links), translated, total };
}

module.exports = { translate, enabled, addMemory, resetForTests, splitPieces, numbersOf, sameNumbers, cleanOutput };
