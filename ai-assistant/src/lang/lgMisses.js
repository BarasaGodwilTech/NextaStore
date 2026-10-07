/**
 * Opt-in (LOG_LUGANDA_MISSES=true). Keeps Luganda questions that the phrasebook could not
 * answer, so a Luganda speaker can review them weekly and turn the common ones into
 * curated phrasebook answers. Stored only on this server, one JSON line each, with no
 * account id, IP or history. Messages are cut to 300 characters.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function file() { return path.join(config.dataDir, 'lg-misses.jsonl'); }

function record(message) {
    if (!config.logLugandaMisses) return;
    try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.appendFileSync(file(), JSON.stringify({ at: new Date().toISOString(), text: String(message).slice(0, 300) }) + '\n');
    } catch (err) { console.warn('[assistant] could not write Luganda miss log:', err.message); }
}

module.exports = { record, file };
