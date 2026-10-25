'use strict';
/**
 * WIP 97: EVERY model-dependent setting lives here, driven by environment variables. No model name appears anywhere in the
 * logic of the assistant. The default profile ("small") is tuned for a 4 GB CPU server running a ~1.5B model.
 *
 * To upgrade to a smarter model: change CHAT_MODEL (and, if the server has more memory, optionally NUM_CTX / MAX_REPLY_TOKENS
 * or MODEL_PROFILE=medium|large). Everything else is automatic: retrieval, normalisation, tier decisions, the post-processor and
 * the safety checks do not depend on how smart the model is.
 *
 * Any single value can still be forced with its own env var (NUM_CTX, MAX_REPLY_TOKENS, RAG_TOP_K, ...).
 */
const PROFILES = {
    small: {                      // 4 GB CPU box, ~1.5B model
        numCtx: 2048,
        maxReplyTokens: 200,
        ragTopK: 3,               // chunks retrieved (the model is only shown the best `contextChunks`)
        contextChunks: 2,
        sentencesPerChunk: 3,     // best-matching sentences kept from each chunk
        contextCharBudget: { typical: 1000, max: 1600 },   // facts block; the ~1.6k system prompt + facts stays <= 2,600 typical / 3,200 max
        temperature: 0.3,
        fewShot: true,            // one compact example line in the prompt (helps small models keep the shape)
        streamPacingMs: 18,       // pause between streamed words (smoother on slow phones)
    },
    medium: {                     // 8 GB box, ~3B model
        numCtx: 3072,
        maxReplyTokens: 240,
        ragTopK: 4,
        contextChunks: 3,
        sentencesPerChunk: 4,
        contextCharBudget: { typical: 1500, max: 2200 },
        temperature: 0.3,
        fewShot: true,
        streamPacingMs: 12,
    },
    large: {                      // 16 GB+ box or hosted GPU, 7B+ model
        numCtx: 4096,
        maxReplyTokens: 320,
        ragTopK: 5,
        contextChunks: 3,
        sentencesPerChunk: 5,
        contextCharBudget: { typical: 2200, max: 3000 },
        temperature: 0.4,
        fewShot: false,
        streamPacingMs: 8,
    },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const flag = (v, dflt) => { const s = String(v === undefined ? '' : v).trim().toLowerCase(); if (!s) return dflt; return /^(1|true|yes|on)$/.test(s); };

function resolveProfile(env = process.env) {
    const name = PROFILES[String(env.MODEL_PROFILE || '').toLowerCase()] ? String(env.MODEL_PROFILE).toLowerCase() : 'small';
    const base = PROFILES[name];
    const temp = Number(env.CHAT_TEMPERATURE);
    return {
        name,
        numCtx: num(env.NUM_CTX) || base.numCtx,
        maxReplyTokens: num(env.MAX_REPLY_TOKENS) || base.maxReplyTokens,
        ragTopK: num(env.RAG_TOP_K) || base.ragTopK,
        contextChunks: num(env.CONTEXT_CHUNKS) || base.contextChunks,
        sentencesPerChunk: num(env.SENTENCES_PER_CHUNK) || base.sentencesPerChunk,
        contextCharBudget: { typical: num(env.CONTEXT_CHAR_BUDGET) || base.contextCharBudget.typical, max: num(env.CONTEXT_CHAR_BUDGET_MAX) || base.contextCharBudget.max },
        temperature: String(env.CHAT_TEMPERATURE || '').trim() !== '' && Number.isFinite(temp) ? temp : base.temperature,
        fewShot: flag(env.PROMPT_FEW_SHOT, base.fewShot),
        streamPacingMs: String(env.STREAM_PACING_MS || '').trim() !== '' && Number.isFinite(Number(env.STREAM_PACING_MS)) ? Number(env.STREAM_PACING_MS) : base.streamPacingMs,
    };
}

module.exports = { resolveProfile, PROFILES, profile: resolveProfile() };
