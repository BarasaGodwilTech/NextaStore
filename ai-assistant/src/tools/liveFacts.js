/**
 * "Live facts" — a small, deliberately narrow bridge to the REAL
 * nextastore-backend API for the handful of things that change from the
 * admin console rather than from a code deploy or a knowledge-file edit.
 *
 * Payment methods are the prototype case: `GET /api/payments/methods` is
 * public/unauthenticated (see nextastore-backend/src/routes/payments.js)
 * and reflects whatever an admin has toggled on right now. Rather than
 * hedge in the knowledge base forever ("we can't say what's enabled"), the
 * assistant can just ask the real API and answer with today's actual list.
 *
 * This is intentionally NOT a general "call any endpoint" tool. Add a new
 * function here per fact you trust the assistant to fetch and surface, so
 * every capability is reviewed and scoped on purpose — never let the model
 * construct its own URLs against your real backend.
 */

const config = require('../config');

const PAYMENT_KEYWORDS = ['pay', 'momo', 'airtel', 'card', 'checkout', 'sasul', 'ssente', 'sente'];

function isPaymentQuestion(text) {
    const lower = (text || '').toLowerCase();
    return PAYMENT_KEYWORDS.some((k) => lower.includes(k));
}

/** @returns {Promise<string|null>} a short context block, or null if unavailable/irrelevant. */
async function getLivePaymentMethodsContext(userMessage) {
    if (!isPaymentQuestion(userMessage)) return null;

    try {
        const res = await fetch(`${config.nextastoreApiBase}/payments/methods`, {
            signal: AbortSignal.timeout(2500), // don't let a slow/down backend stall the whole answer
        });
        if (!res.ok) return null;
        const body = await res.json();
        const methods = Array.isArray(body?.data) ? body.data : [];
        if (!methods.length) return null;

        const list = methods.map((m) => `- ${m.label}${m.currency ? ` (${m.currency})` : ''}`).join('\n');
        return `### Live data: payment methods enabled platform-wide right now\n(Fetched just now from NextaStore's own API — this overrides anything said elsewhere about which methods exist. A specific store may still accept only some of these.)\n${list}`;
    } catch {
        return null; // real backend not running / not reachable — fall back to the static knowledge base silently
    }
}

// WIP 93 Tier 3.2: the admin-set support hours ("Mon-Fri 9am-5pm EAT"), from the same public, allowlisted endpoint the widget uses.
// Cached for a minute (and a failure is cached for 30 s) so a slow or down backend never delays a handoff by more than one short attempt.
let hoursCache = { at: 0, value: '', ttl: 0 };
async function getSupportHoursNote() {
    const now = Date.now();
    if (now - hoursCache.at < hoursCache.ttl) return hoursCache.value;
    let value = '';
    try {
        const res = await fetch(`${config.nextastoreApiBase}/assistant/handoff-contact`, { signal: AbortSignal.timeout(1200) });
        if (res.ok) { const body = await res.json(); value = typeof body?.hoursNote === 'string' ? body.hoursNote.trim().slice(0, 240) : ''; hoursCache = { at: now, value, ttl: 60000 }; return value; }
    } catch { /* backend not reachable: no hours, the handoff is complete without them */ }
    hoursCache = { at: now, value: '', ttl: 30000 };
    return '';
}
function resetSupportHoursForTests() { hoursCache = { at: 0, value: '', ttl: 0 }; }

module.exports = { getLivePaymentMethodsContext, getSupportHoursNote, resetSupportHoursForTests };
