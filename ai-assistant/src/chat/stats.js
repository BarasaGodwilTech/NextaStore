/**
 * WIP 93 Tier 3.3: in-memory counters for /api/assistant/health. Numbers only: no message text, no ids, no IPs, nothing that could be PII.
 * They reset when the service restarts (they are a health signal, not a record).
 */
const REASONS = ['user_request', 'not_in_context', 'language_guard', 'safety'];
const state = { since: new Date().toISOString(), turns: 0, handoffs: { total: 0, other: 0 }, languageGuardHits: 0, invariantRecoveries: 0, translatorFailures: { partial: 0, error: 0 }, modelErrors: 0 };
for (const r of REASONS) state.handoffs[r] = 0;

function handoff(reason) {
    state.handoffs.total += 1;
    if (REASONS.includes(reason)) state.handoffs[reason] += 1; else state.handoffs.other += 1;
    if (reason === 'language_guard') state.languageGuardHits += 1;
}
const turn = () => { state.turns += 1; };
const translatorFailure = (kind) => { state.translatorFailures[kind === 'error' ? 'error' : 'partial'] += 1; };
const modelError = () => { state.modelErrors += 1; };
const recovery = () => { state.invariantRecoveries += 1; };
function snapshot() { return JSON.parse(JSON.stringify(state)); }
function resetForTests() { state.turns = 0; state.handoffs = { total: 0, other: 0 }; for (const r of REASONS) state.handoffs[r] = 0; state.languageGuardHits = 0; state.invariantRecoveries = 0; state.translatorFailures = { partial: 0, error: 0 }; state.modelErrors = 0; }
module.exports = { handoff, turn, translatorFailure, modelError, recovery, snapshot, resetForTests, REASONS };
