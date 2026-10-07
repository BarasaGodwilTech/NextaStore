'use strict';

/**
 * Makes instant answers feel like normal Nexi replies instead of a zero-ms block.
 * The helper deliberately uses the existing onToken hook; no UI changes are needed.
 */
function sleep(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => finish(), ms);
        const onAbort = () => { clearTimeout(timer); finish(Object.assign(new Error('Request cancelled.'), { code: 'cancelled', status: 499 })); };
        if (signal) {
            if (signal.aborted) { clearTimeout(timer); return onAbort(); }
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

function chunksByWord(text) {
    const s = String(text || '');
    // Keep whitespace attached to the preceding word so streamed prose remains natural.
    return s.match(/\S+\s*/g) || [];
}

async function stream(text, onToken, {
    delayMs = 500,
    wordsPerSecond = 38,
    signal,
} = {}) {
    if (!onToken) return;
    await sleep(delayMs, signal);
    const chunks = chunksByWord(text);
    const gap = Math.max(1, Math.round(1000 / Math.max(30, Math.min(45, wordsPerSecond))));
    for (const chunk of chunks) {
        if (signal?.aborted) throw Object.assign(new Error('Request cancelled.'), { code: 'cancelled', status: 499 });
        onToken(chunk);
        await sleep(gap, signal);
    }
}

module.exports = { stream };
