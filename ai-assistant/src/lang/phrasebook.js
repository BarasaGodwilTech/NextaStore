const fs = require('fs');
const config = require('../config');

let cached = null;
function load() {
    if (!cached) {
        cached = JSON.parse(fs.readFileSync(config.phrasebookPath, 'utf8'));
    }
    return cached;
}

/**
 * Looks for a phrasebook entry whose patterns appear in the user's message.
 * This exists as an accuracy safety net: general open models are genuinely
 * weak at Luganda (see README.md), so for the handful of things users ask
 * about most often, we'd rather answer from a fixed, reviewable string than
 * from a model guessing in a language it barely knows. Anything that
 * doesn't match falls through to the normal RAG + model pipeline.
 *
 * @param {string} text
 * @returns {{id: string, lg_answer: string, en_reference: string}|null}
 */
function matchPhrasebook(text) {
    const lower = (text || '').toLowerCase();
    const { entries } = load();
    let best = null;
    let bestHits = 0;
    for (const entry of entries) {
        if (entry.disabled) continue; // switched off until a Luganda speaker updates it (see disabled_reason)
        const hits = entry.patterns.filter((p) => lower.includes(p.toLowerCase())).length;
        if (hits > bestHits) {
            bestHits = hits;
            best = entry;
        }
    }
    return bestHits > 0 ? best : null;
}

module.exports = { matchPhrasebook };
