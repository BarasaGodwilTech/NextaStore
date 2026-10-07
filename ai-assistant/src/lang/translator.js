/**
 * One place that decides HOW Luganda is handled, so the pipeline does not care.
 *
 *   local - Ganda Gemma 1B on this machine. English -> Luganda only. Private: nothing leaves the server.
 *   off   - answer in English plus a short note.
 *
 * LUGANDA_PROVIDER=auto uses local when GANDA_MODEL is set, otherwise off.
 * Read from config on every call so tests and hot config changes work.
 */
const config = require('../config');
const local = require('./localTranslate');

function provider() {
    const want = config.lugandaProvider;
    if (want === 'off') return 'off';
    return local.enabled() ? 'local' : 'off';
}

/**
 * English -> Luganda.
 * @returns {Promise<{text: string, translated?: number, total?: number}|null>}
 */
async function toLuganda(text, hooks = {}) {
    if (provider() !== 'local') return null;
    return local.translate(text, hooks);
}

/**
 * Streaming English -> Luganda helper. It uses the same sentence/layout splitter and translation
 * checks as the normal path, but queues completed pieces so model chunks never run translations out of order.
 * hold: true (WIP 69) -> completed pieces are collected but NO translation starts until end() is called;
 * end() then translates them in order and emits each piece through onChunk as it finishes.
 * @returns {{push: (chunk: string) => void, end: () => Promise<{text: string, translated: number, total: number}|null>}}
 */
function createStreaming({ signal, onChunk, onProgress, hold = false } = {}) {
    let buffer = '';
    let result = '';
    let translated = 0;
    let total = 0;
    let started = false;
    let queue = Promise.resolve();
    let queuedError = null;
    let released = !hold;
    const held = [];

    const enqueue = (piece) => {
        if (!piece) return;
        if (!released) { held.push(piece); return; }
        queue = queue.then(async () => {
            if (signal?.aborted) throw Object.assign(new Error('Request cancelled.'), { code: 'cancelled', status: 499 });
            if (!started) { started = true; if (onProgress) onProgress(); }
            const t = await toLuganda(piece, { signal });
            const count = local.splitPieces(piece).filter((p) => p.text).length;
            total += count;
            if (t) {
                translated += t.translated || 0;
                result += t.text;
                if (onChunk) onChunk(t.text);
            } else {
                result += piece;
                if (onChunk) onChunk(piece);
            }
        }).catch((err) => { queuedError = err; });
    };

    const takeComplete = () => {
        let cut = 0;
        const lines = buffer.split('\n');
        if (lines.length > 1) cut = buffer.lastIndexOf('\n') + 1;
        const tail = buffer.slice(cut);
        const re = /(?<=[.!?])\s+/g;
        let match;
        let last = 0;
        while ((match = re.exec(tail))) last = match.index + match[0].length;
        if (last) cut += last;
        if (!cut) return '';
        const complete = buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        return complete;
    };

    return {
        push(chunk) {
            buffer += String(chunk || '');
            let complete;
            while ((complete = takeComplete())) enqueue(complete);
        },
        async end() {
            released = true;
            while (held.length) enqueue(held.shift());
            if (buffer) enqueue(buffer);
            await queue;
            if (queuedError) throw queuedError;
            return total ? { text: result, translated, total } : null;
        },
    };
}

function describe() {
    const p = provider();
    // Luganda questions are not translated: the phrasebook, the keyword lexicon and a prompt hint cover them.
    return { provider: p, model: p === 'local' ? config.gandaModel : null, understandsLugandaInput: false };
}

module.exports = { provider, toLuganda, createStreaming, describe };
