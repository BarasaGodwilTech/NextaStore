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

function record({ type, reason, message, conversation, page, audience, lang, source }) {
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
        fs.appendFileSync(file(), JSON.stringify(row) + '\n');
    } catch (err) { console.warn('[assistant] could not write flag log:', err.message); }
}

module.exports = { record, file };
