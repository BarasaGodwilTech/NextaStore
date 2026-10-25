'use strict';
/**
 * WIP 97: retrieval for the way people really ask. A two-part question ("how do I start selling and how much do I pay")
 * gets the best section for EACH part, so neither half is answered from the other half's section.
 */
const { retrieve, ensureFresh, queryPlan } = require('../rag/retrieve');
const { clauses } = require('./compose');

/**
 * @returns {Promise<{retrieved: object[], groups: object[], compound: boolean, parts: string[]}>}
 */
async function retrieveForMessage(message, k) {
    const st = ensureFresh();
    const plan = queryPlan(message, st);
    const parts = clauses(message);
    if (parts.length < 2) return { retrieved: await retrieve(message, k), groups: plan.norm.groups, compound: false, parts: [message] };
    const wanted = parts.slice(0, 2);
    const perPart = await Promise.all(wanted.map((p) => retrieve(p, 3)));
    const merged = []; const seen = new Set();
    const keyOf = (r) => `${r.source}#${r.heading}`;
    for (const list of perPart) { const first = list.find((r) => !seen.has(keyOf(r))); if (first) { merged.push(first); seen.add(keyOf(first)); } }
    const whole = await retrieve(message, k);
    for (const r of whole) { if (!seen.has(keyOf(r))) { merged.push(r); seen.add(keyOf(r)); } }
    // gap / band come from the first part's best match so the tier logic still sees a platform gap
    const gapHit = perPart.map((l) => l[0] && l[0].gap).find(Boolean) || null;
    if (gapHit && merged[0]) merged[0] = { ...merged[0], gap: gapHit, band: 'none', confidence: Math.min(merged[0].confidence, 0.2) };
    const groups = wanted.flatMap((p) => queryPlan(p, st).norm.groups);
    return { retrieved: merged.slice(0, Math.max(k, 3)), groups, compound: true, parts: wanted };
}

module.exports = { retrieveForMessage };
