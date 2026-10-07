'use strict';

/**
 * Global CPU guard plus a silent per-visitor model lock.
 *
 * The queue is an internal resource-control mechanism only. Visitors never
 * receive a position or a load message; routes turn capacity/time-limit
 * outcomes into local knowledge answers.
 */
function busyError(message, code) {
    const err = new Error(message);
    err.status = 429;
    err.code = code;
    err.busy = true;
    return err;
}

function createLimiter(maxActive, maxQueue, defaults = {}) {
    let active = 0;
    const waiting = [];
    const visitorBusy = new Set();
    const totals = { served: 0, rejectedFull: 0, timedOut: 0, abandoned: 0 };
    const defaultWaitMs = Number(defaults.maxWaitMs) || 0;

    function remove(entry) {
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
        if (entry.timer) clearTimeout(entry.timer);
        entry.cleanup();
    }

    function pump() {
        while (active < maxActive && waiting.length) {
            const index = waiting.findIndex((entry) => !entry.visitorKey || !visitorBusy.has(entry.visitorKey));
            if (index === -1) return;
            const next = waiting.splice(index, 1)[0];
            if (next.timer) clearTimeout(next.timer);
            next.cleanup();
            active += 1;
            if (next.visitorKey) visitorBusy.add(next.visitorKey);
            totals.served += 1;
            next.grant(releaseOnce(next.visitorKey));
        }
    }

    function releaseOnce(visitorKey) {
        let done = false;
        return () => {
            if (done) return;
            done = true;
            active = Math.max(0, active - 1);
            if (visitorKey) visitorBusy.delete(visitorKey);
            pump();
        };
    }

    return {
        acquire(opts = {}) {
            const { signal, visitorKey } = opts;
            const maxWaitMs = opts.maxWaitMs !== undefined ? Number(opts.maxWaitMs) : defaultWaitMs;
            if (signal && signal.aborted) {
                totals.abandoned += 1;
                const err = new Error('Request cancelled.');
                err.status = 499; err.code = 'cancelled';
                return Promise.reject(err);
            }

            const canStart = active < maxActive && (!visitorKey || !visitorBusy.has(visitorKey));
            if (canStart) {
                active += 1;
                if (visitorKey) visitorBusy.add(visitorKey);
                totals.served += 1;
                return Promise.resolve(releaseOnce(visitorKey));
            }

            if (waiting.length >= maxQueue) {
                totals.rejectedFull += 1;
                return Promise.reject(busyError('capacity limit', 'queue_full'));
            }

            return new Promise((resolve, reject) => {
                const entry = {
                    grant: resolve,
                    reject,
                    visitorKey,
                    timer: null,
                    cleanup: () => {},
                };
                if (maxWaitMs > 0) {
                    entry.timer = setTimeout(() => {
                        if (!waiting.includes(entry)) return;
                        remove(entry);
                        totals.timedOut += 1;
                        reject(busyError('capacity wait limit', 'wait_timeout'));
                        pump();
                    }, maxWaitMs);
                    if (entry.timer.unref) entry.timer.unref();
                }
                if (signal) {
                    const onAbort = () => {
                        if (!waiting.includes(entry)) return;
                        remove(entry);
                        totals.abandoned += 1;
                        const err = new Error('Request cancelled.');
                        err.status = 499; err.code = 'cancelled';
                        reject(err);
                        pump();
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    entry.cleanup = () => signal.removeEventListener('abort', onAbort);
                }
                waiting.push(entry);
                pump();
            });
        },
        stats: () => ({ active, waiting: waiting.length, maxActive, maxQueue, visitorsActive: visitorBusy.size, ...totals }),
    };
}

module.exports = { createLimiter };
