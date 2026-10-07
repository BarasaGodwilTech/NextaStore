'use strict';
/**
 * Knowledge retrieval for the assistant.
 *
 * DEFAULT (RETRIEVAL=bm25): in-process keyword search over the markdown files in
 * src/knowledge/. No embedding model, no index file, no reindex step. The index lives
 * in memory and is rebuilt automatically whenever a knowledge file (or the Luganda/Swahili
 * lexicon) is added, edited or removed - so a new or changed file is live on the next
 * question, with no restart.
 *
 * OPTIONAL (RETRIEVAL=hybrid): the same keyword search, blended with embedding similarity from
 * the old index.json (needs the embedding model and `npm run reindex`). If the embedding side is
 * missing, stale or fails, it silently falls back to keyword-only.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { chunkMarkdown } = require('./chunk');
const { BM25, rawTokens, terms, STOPWORDS } = require('./bm25');

const CHECK_EVERY_MS = 1000;       // how often we look at the files on disk (a few stat calls)
const CONFIDENCE_HALF_POINT = 8;   // raw BM25 score that maps to 0.5 confidence

let state = null;                  // { stamp, chunks, bm25, lexicon }
let lastCheck = 0;

function listKnowledgeFiles() {
    return fs.readdirSync(config.knowledgeDir).filter((f) => f.endsWith('.md')).sort();
}

function fileStamp(p) {
    try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch (e) { return 'none'; }
}

/** Changes whenever any knowledge file or the lexicon is added, edited or removed. */
function currentStamp() {
    const parts = listKnowledgeFiles().map((f) => `${f}:${fileStamp(path.join(config.knowledgeDir, f))}`);
    parts.push(`lexicon:${fileStamp(config.retrievalLexiconPath)}`);
    return parts.join('|');
}

function loadLexicon() {
    const map = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(config.retrievalLexiconPath, 'utf8'));
        for (const group of Object.keys(raw)) {
            if (group.startsWith('_') || !raw[group] || typeof raw[group] !== 'object') continue;
            for (const [word, english] of Object.entries(raw[group])) {
                if (typeof english === 'string') map.set(word.toLowerCase(), english);
            }
        }
    } catch (e) { /* no lexicon (or a typo in it) just means no Luganda/Swahili expansion */ }
    return map;
}

function buildState(stamp) {
    const chunks = [];
    for (const file of listKnowledgeFiles()) {
        const raw = fs.readFileSync(path.join(config.knowledgeDir, file), 'utf8');
        const { title, chunks: fileChunks } = chunkMarkdown(file, raw);
        for (const c of fileChunks) chunks.push({ ...c, title });
    }
    return { stamp, chunks, bm25: new BM25(chunks), lexicon: loadLexicon() };
}

/** Returns the current in-memory index, rebuilding it first if the files changed. */
function ensureFresh(force = false) {
    const now = Date.now();
    if (state && !force && now - lastCheck < CHECK_EVERY_MS) return state;
    lastCheck = now;
    try {
        const stamp = currentStamp();
        if (!state || state.stamp !== stamp) state = buildState(stamp);
    } catch (err) {
        // A file caught half-written, or the folder briefly unreadable: keep serving the last good index.
        if (!state) throw err;
        console.warn('[assistant] knowledge reload skipped:', err.message);
    }
    return state;
}

/** Forget everything and rebuild on the next question. Kept for scripts and tests. */
function invalidateCache() {
    state = null;
    lastCheck = 0;
    embeddingIndex = null;
}

/** The user's own words (weight 1) plus English expansions of Luganda/Swahili words (weight 0.8). */
function queryTerms(query, lexicon) {
    const weights = new Map();
    const put = (term, w) => { if (term && (weights.get(term) || 0) < w) weights.set(term, w); };
    for (const raw of rawTokens(query)) {
        if (STOPWORDS.has(raw)) continue;
        for (const t of terms(raw)) put(t, 1);
        const extra = lexicon && lexicon.get(raw);
        if (extra) for (const t of terms(extra)) put(t, 0.8);
    }
    return weights;
}

/** 0..1 "how sure is this match", easier to reason about than a raw BM25 number. */
function confidence(raw) {
    return raw / (raw + CONFIDENCE_HALF_POINT);
}

// ---- optional hybrid mode (embeddings) -------------------------------------------------------

let embeddingIndex = null;
let embeddingMtime = 0;

function loadEmbeddingIndex() {
    if (!fs.existsSync(config.indexPath)) return null;
    const mtime = fs.statSync(config.indexPath).mtimeMs;
    if (embeddingIndex && mtime === embeddingMtime) return embeddingIndex;
    embeddingIndex = JSON.parse(fs.readFileSync(config.indexPath, 'utf8'));
    embeddingMtime = mtime;
    return embeddingIndex;
}

function cosine(a, b) {
    let dot = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
    return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

const keyOf = (c) => `${c.source}#${c.heading}`;

/** Reciprocal-rank fusion of keyword ranking and embedding ranking. Throws if embeddings are unusable. */
async function fuse(query, st, keywordHits) {
    const idx = loadEmbeddingIndex();
    if (!idx) throw new Error('no embedding index');
    const queryVector = await require('../ollama/client').embed(query);
    const byKey = new Map(st.chunks.map((c) => [keyOf(c), c]));
    const semantic = idx.chunks
        .filter((c) => byKey.has(keyOf(c)))
        .map((c) => ({ key: keyOf(c), cos: cosine(queryVector, c.vector) }))
        .sort((a, b) => b.cos - a.cos)
        .slice(0, 12);

    const fused = new Map();
    const bump = (key, rank) => fused.set(key, (fused.get(key) || 0) + 1 / (60 + rank));
    keywordHits.forEach((h, rank) => bump(keyOf(st.chunks[h.index]), rank));
    semantic.forEach((s, rank) => bump(s.key, rank));

    const kwScore = new Map(keywordHits.map((h) => [keyOf(st.chunks[h.index]), confidence(h.score)]));
    const cosScore = new Map(semantic.map((s) => [s.key, s.cos]));
    return [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => ({ chunk: byKey.get(key), score: Math.max(kwScore.get(key) || 0, cosScore.get(key) || 0) }));
}

// ---- public API ------------------------------------------------------------------------------

/**
 * Top-k knowledge chunks for `query`, best first: { source, heading, text, score }.
 * `score` is a 0..1 confidence. Returns [] when nothing in the knowledge base matches at all,
 * so the prompt can say "no matching knowledge" instead of being fed unrelated text.
 */
async function retrieve(query, k = config.ragTopK) {
    const st = ensureFresh();
    const keywordHits = st.bm25.search(queryTerms(query, st.lexicon), Math.max(k, 12));

    let ranked = keywordHits.map((h) => ({ chunk: st.chunks[h.index], score: confidence(h.score) }));
    if (config.retrieval === 'hybrid') {
        try { ranked = await fuse(query, st, keywordHits); } catch (err) { /* keyword-only */ }
    }
    return ranked.slice(0, k).map(({ chunk, score }) => ({ source: chunk.source, heading: chunk.heading, text: chunk.text, score }));
}

/** For tests and health output. */
function stats() {
    const st = ensureFresh();
    return { mode: config.retrieval, chunks: st.chunks.length, files: new Set(st.chunks.map((c) => c.source)).size };
}

module.exports = { retrieve, invalidateCache, stats, queryTerms, ensureFresh };
