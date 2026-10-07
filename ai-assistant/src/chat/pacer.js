'use strict';
/**
 * WIP 63: makes the stream feel like someone typing.
 * Everything the assistant says goes through one queue per answer:
 *  - instant answers (FAQ, small talk, product cards, fallback) wait a beat, then appear word by word,
 *    with a short "typing" pause between bubbles;
 *  - live model text is passed on as it arrives (the model is already slow enough);
 *  - a backlog is flushed faster, so pacing never makes an answer feel stuck.
 * The client shows typing dots while the newest bubble is still empty.
 */
function sleep(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
        if (signal) { if (signal.aborted) return done(); signal.addEventListener('abort', done, { once: true }); }
    });
}

const INSTANT_SOURCES = new Set(['faq', 'smalltalk', 'phrasebook', 'flag', 'fallback', 'cache', 'cards']);

// How long the "typing" dots show before the next bubble starts: longer bubbles take longer, within 0.4 to 1.1 s.
function typingPause(len) { return Math.max(400, Math.min(1100, 300 + len * 5)); }

// pauseScale 0 removes the pauses between bubbles (tests); firstDelayMs 0 and a huge wordsPerSecond remove the rest.
function createPacer(send, { signal, wordsPerSecond = 28, firstDelayMs = 450, pauseScale = 1 } = {}) {
    const queue = [];
    let running = false;
    let instant = false;
    let first = true;
    let waiters = [];

    function setSource(source) { if (INSTANT_SOURCES.has(source)) instant = true; }

    function lengthUntilBreak() {
        let n = 0;
        for (const ev of queue) { if (ev.type === 'break' || ev.type === 'cards') break; if (ev.type === 'token') n += ev.text.length; }
        return n;
    }

    async function pump() {
        if (running) return;
        running = true;
        try {
            while (queue.length && !(signal && signal.aborted)) {
                const ev = queue.shift();
                if (ev.type === 'token') {
                    if (instant && first) { first = false; await sleep(firstDelayMs, signal); }
                    first = false;
                    const words = ev.text.match(/\S+\s*|\s+/g) || [ev.text];
                    for (const w of words) {
                        if (signal && signal.aborted) break;
                        send({ type: 'token', text: w });
                        if (instant) await sleep(queue.length > 60 ? 4 : Math.round(1000 / wordsPerSecond), signal);
                    }
                } else if (ev.type === 'break') {
                    send(ev);
                    if (instant && queue.length) await sleep(typingPause(lengthUntilBreak()) * pauseScale, signal);
                } else if (ev.type === 'cards') {
                    if (instant) { send({ type: 'typing' }); await sleep(600 * pauseScale, signal); }
                    send(ev);
                    if (instant && queue.length) await sleep(typingPause(lengthUntilBreak()) * pauseScale, signal);
                } else {
                    send(ev);
                }
            }
        } finally {
            running = false;
            if (!queue.length) { const w = waiters; waiters = []; w.forEach((r) => r()); }
            else if (!(signal && signal.aborted)) pump();
            else { const w = waiters; waiters = []; w.forEach((r) => r()); }
        }
    }

    return {
        setSource,
        /** Forget everything queued and start fresh (used when partial model text is thrown away). */
        reset() { queue.length = 0; first = true; instant = false; },
        token(text) { if (text) { queue.push({ type: 'token', text }); pump(); } },
        brk() { queue.push({ type: 'break' }); pump(); },
        cards(payload) { queue.push({ type: 'cards', ...payload }); pump(); },
        event(ev) { queue.push(ev); pump(); },
        drain() { if (!running && !queue.length) return Promise.resolve(); return new Promise((r) => { waiters.push(r); pump(); }); },
    };
}

module.exports = { createPacer, typingPause, INSTANT_SOURCES };
