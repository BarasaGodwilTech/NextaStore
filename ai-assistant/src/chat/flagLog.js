/**
 * Opt-in (LOG_FLAGGED_MESSAGES=true). Keeps a short record of flagged messages (off-topic, abusive,
 * private details, manipulation attempts) so the team can see what people ask that Nexi should not
 * answer, and spot abuse. Stored only on this server, one JSON line each: no account id, no IP, no
 * history. Messages are cut to 200 characters, and for the "sensitive" type the text is NOT stored
 * at all (it may contain a password or card number).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function file() { return path.join(config.dataDir, 'flagged.jsonl'); }

function record({ type, reason, message, conversation, page, audience, lang, source, route, top }) {
    if (!config.logFlagged) return;
    try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        const row = {
            at: new Date().toISOString(),
            type,
            reason,
            source: source || 'rules',
            conversation: Boolean(conversation),
            page: page || '',
            audience: audience || '',
            lang: lang || '',
            text: type === 'sensitive' ? '[not stored]' : String(message || '').replace(/\s+/g, ' ').slice(0, 200),
        };
        // WIP 99: where the question went and which guide section it came closest to (for `npm run review:traffic`); only present on traffic rows
        if (route) row.route = String(route).slice(0, 60);
        if (top) row.top = String(top).slice(0, 120);
        fs.appendFileSync(file(), JSON.stringify(row) + '\n');
    } catch (err) { console.warn('[assistant] could not write flag log:', err.message); }
}

/**
 * WIP 93 Tier 3.3: handoffs ("a person should answer this") share the flag log: same opt-in (LOG_FLAGGED_MESSAGES), same file, same limits, type "handoff".
 * The question is scrubbed with the SAME rules as the widget's WhatsApp summary (chat/scrub.js) before it is written, then cut to 200 characters.
 */
function recordHandoff({ reason, message, lang, source, page, audience, route, top }) {
    if (!config.logFlagged) return;
    const { scrubSensitive } = require('./scrub');
    record({ type: 'handoff', reason: reason || 'unknown', message: scrubSensitive(message), page, audience, lang, source: source || 'handoff', route: route || `handoff:${reason || 'unknown'}`, top });
}

/**
 * WIP 99: a question the assistant did not simply answer, other than a handoff: it asked which topic was meant ("clarify") or said it was not sure
 * ("unsure"). Same opt-in, same file, same scrubbing and 200-character limit as a handoff. Read by `npm run review:traffic`.
 */
function recordTraffic({ type, reason, message, lang, source, page, audience, route, top }) {
    if (!config.logFlagged) return;
    const { scrubSensitive } = require('./scrub');
    record({ type: type === 'clarify' ? 'clarify' : 'unsure', reason: reason || '', message: scrubSensitive(message), page, audience, lang, source: source || type, route, top });
}
/** Last `limit` (max 50) handoff rows, newest first: time, reason, language, scrubbed question. Never throws. */
function readHandoffs(limit = 50) {
    const n = Math.max(1, Math.min(50, Number(limit) || 50));
    try {
        const lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
            let row; try { row = JSON.parse(lines[i]); } catch (e) { continue; }
            if (!row || row.type !== 'handoff') continue;
            out.push({ at: row.at, reason: row.reason, language: row.lang || '', question: String(row.text || '') });
        }
        return out;
    } catch (err) { return []; }
}

module.exports = { record, recordHandoff, recordTraffic, readHandoffs, file };
