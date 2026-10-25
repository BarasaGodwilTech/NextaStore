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
const { normalise, buildVocab, joinPhrases, dataStampNow, loadData } = require('./normalise');

const CHECK_EVERY_MS = 1000;       // how often we look at the files on disk (a few stat calls)
const CONFIDENCE_HALF_POINT = 8;   // raw BM25 score that maps to 0.5 (legacy) confidence
const W_COV = 0.5;               // share of the ranking score that comes from question-term coverage (rest: BM25)
const ALIAS_BONUS = 0.06;         // blended-score bonus for a section whose alias phrase holds every content word of the question
const BODY_ONLY = 0.4;             // coverage credit when a section only mentions a question word in its body, not its heading/aliases

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
    parts.push(`normalisation:${dataStampNow()}`);
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
    // The index sees phrase-joined text ("Log out" == "logout") but chunks keep their original wording for display.
    const docs = chunks.map((c) => ({ heading: joinPhrases(c.heading), title: joinPhrases(c.title || ''), text: joinPhrases(c.text), aliases: (c.aliases || []).map(joinPhrases) }));
    const vocab = buildVocab(docs.map((d) => `${d.heading} ${d.text} ${d.aliases.join(' ')}`));
    return { stamp, chunks, bm25: new BM25(docs), lexicon: loadLexicon(), vocab, maxIdf: 0 };
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

/** 0..1 "how sure is this match", easier to reason about than a raw BM25 number. (Legacy score; kept for old callers.) */
function confidence(raw) {
    return raw / (raw + CONFIDENCE_HALF_POINT);
}

/**
 * WIP 97: normalise a messy question into search terms (see rag/normalise.js), then add the
 * Luganda/Swahili lexicon expansions exactly as before.
 */
function queryPlan(query, st) {
    const norm = normalise(query, { vocab: st.vocab });
    const weights = new Map(norm.weights);
    const put = (term, w) => { if (term && (weights.get(term) || 0) < w) weights.set(term, w); };
    if (st.lexicon && st.lexicon.size) {
        for (const raw of rawTokens(query)) {
            const extra = st.lexicon.get(raw);
            if (extra) for (const t of terms(extra)) put(t, 0.8);
        }
    }
    return { norm, weights };
}

/**
 * How much of the question a chunk explains: share of the question's content words (idf-weighted) for which the chunk
 * has the word or one of its synonyms. A word that appears nowhere in the guides at all counts as not explained.
 */
function coverageOf(groups, docIndex, bm25) {
    if (!groups.length) return 0;
    const have = bm25.docTerms[docIndex];
    const about = bm25.headTerms[docIndex];
    const unknownIdf = Math.log(1 + (bm25.n + 0.5) / 0.5);
    let total = 0; let got = 0;
    for (const g of groups) {
        let w = 0; let strength = 0; let known = false;
        for (const t of g.terms) {
            if ((bm25.df.get(t) || 0) > 0) { known = true; w = Math.max(w, bm25.idf(t)); }
            if (about.has(t)) strength = 1;                       // the section is about this word
            else if (have.has(t) && strength < BODY_ONLY) strength = BODY_ONLY; // it only mentions it
        }
        if (!known) w = unknownIdf;
        w *= g.weak === undefined ? 1 : g.weak;
        total += w; got += w * strength;
    }
    return total ? got / total : 0;
}

/** Blend of coverage and how far ahead the best chunk is of the runner-up. Calibrated into bands by scripts/retrieval-calibrate.js. */
function combinedConfidence(coverage, margin) {
    const m = Math.max(0, Math.min(1, margin / 0.3));
    return Math.max(0, Math.min(1, 0.65 * coverage + 0.35 * m));
}

/** answer / clarify / none, from config thresholds. */
function bandOf(conf) {
    const t = config.retrievalBands;
    return conf >= t.answer ? 'answer' : conf >= t.clarify ? 'clarify' : 'none';
}

// ---- WIP 98: the "is this in the guides at all?" check, by evidence instead of by a list of known gaps ---------------------------
// General selling / shopping advice is never a gap (same idea as tiers.js).
const ADVICE_RE = /\b(?:price\s+(?:my|our|the|an?|your)\b|how\s+(?:do|can|should|to)\s+(?:i\s+)?price\b|what\s+(?:to|should\s+i)\s+sell|ideas?|tips?|advice|photos?|pictures?|describe|description|first\s+customers?|grow|gifts?|compare|small\s+(?:capital|budget)|capital|budget|which\s+(?:category|product|item)s?|best\s+things)\b/i;
const EXAMPLE_RE = /\b(?:like|such\s+as|e\.?g\.?|for\s+example)\s+([a-z0-9' ]{2,40})/gi;

/**
 * A question about a PLATFORM FACT (does it offer / have / cost / allow something; see "fact_asks" in query-normalisation.json) is a gap when
 *   1. the thing it is about (the question's rarest content word that is not ask-framing and not an example) appears in NONE of the best
 *      three sections, even counting the synonyms taught in query-normalisation.json, or
 *   2. it names a platform concept (discount, shipping, warranty ...) and no section is ABOUT that concept (named in a heading or alias), or
 *   3. it is a kind of fact (opening hours ...) that no section is about.
 * `sections` are the best chunks for the question (may be empty). Returns a short topic name for the "I'm not sure about ..." line, or null.
 */
function evidenceGap(query, norm, sections, st) {
    const d = loadData();
    const q = String(query || '');
    if (!d.factAsks.length || !d.factAsks.some((re) => re.test(q))) return null;
    const bm = st.bm25;
    const idxOf = (c) => st.chunks.indexOf(c);
    const have = (c) => bm.docTerms[idxOf(c)];
        // 3. kinds of fact
    for (const k of d.factKinds) {
        if (!k.when.some((re) => re.test(q.toLowerCase()))) continue;
        const need = k.needs.flatMap((w) => terms(w));
        const covered = need.length > 0 && bm.headTerms.some((set) => need.every((t) => set.has(t)));
        if (!covered) return k.topic;
    }
    // 2a. a platform concept written as a PHRASE ("gift card", "free returns") needs a section whose heading or aliases name every word of it.
    //     Checked before the advice exemption, because "gift" alone is advice ("gift ideas") while "gift cards" is something the platform may offer.
    const qTokens = ' ' + rawTokens(q).join(' ') + ' ';
    for (const c of d.concepts || []) {
        if (!/\s/.test(c) || !qTokens.includes(' ' + c + ' ')) continue;
        const words = c.split(/\s+/);
        const named = (sec) => { const have = new Set(rawTokens(`${sec.heading} ${(sec.aliases || []).join(' ')}`)); return words.every((w) => have.has(w)); };
        if (!sections.slice(0, 3).some(named)) return c;
    }
    if (ADVICE_RE.test(q)) return null;
    const examples = new Set(); let m; EXAMPLE_RE.lastIndex = 0;
    while ((m = EXAMPLE_RE.exec(q))) for (const w of m[1].toLowerCase().split(/\s+/)) examples.add(w);
    const unknownIdf = Math.log(1 + (bm.n + 0.5) / 0.5);
    const idfOf = (t) => ((bm.df.get(t) || 0) > 0 ? bm.idf(t) : unknownIdf);
    const groups = norm.groups
        .filter((g) => (g.weak === undefined ? 1 : g.weak) >= 0.5 && !d.scaffold.has(g.word) && !examples.has(g.word))
        .map((g) => ({ g, idf: Math.max(...(g.own && g.own.length ? g.own : g.terms).map(idfOf)) }))
        .sort((a, b) => b.idf - a.idf);
    if (!groups.length) return null;
    const top = sections.slice(0, 3);
    // 2. a platform concept needs a section that is ABOUT it
    for (const { g } of groups) {
        const own = g.own && g.own.length ? g.own : g.terms;
        if (!require('./normalise').platformConcept(g.word)) continue;
        const exact = (c) => rawTokens(`${c.heading} ${(c.aliases || []).join(' ')}`).includes(g.word);   // the word itself, not a stem that also fits "shipped"
        if (!top.some(exact)) return g.word;
    }
    // 1. the rarest thing asked about must appear somewhere in the best sections
    const target = groups[0].g;
    // (a section anywhere in the guides that is ABOUT one of its synonyms also counts: "danger" -> "safety")
    const named = (t) => bm.headTerms.some((set) => set.has(t));
    if (!top.some((c) => target.terms.some((t) => have(c).has(t))) && !target.terms.filter((t) => !(target.own || []).includes(t)).some(named)) return target.word;
    return null;
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
function rewriteQuery(query) {
    return String(query).replace(/\bpick[ -]up\b/gi, 'pickup');
}

async function retrieve(query, k = config.ragTopK) {
    const st = ensureFresh();
    const rewrittenQuery = rewriteQuery(query);
    const { norm, weights } = queryPlan(rewrittenQuery, st);
    const keywordHits = st.bm25.search(weights, Math.max(k, 12));

    // Re-rank the best keyword candidates by how much of the question each one actually explains.
    const top = keywordHits.length ? keywordHits[0].score : 0;
    // WIP 98: a section that has ONE alias phrase holding every content word of the question (the way people ask it, written down by the maintainers) beats a
    // section that only mentions those words somewhere in its text.
    const contentGroups = norm.groups.filter((g) => (g.weak === undefined || g.weak >= 0.5));
    const aliasHit = (chunk) => contentGroups.length >= 2 && (chunk.aliases || []).some((a) => {
        const have = new Set(terms(a)); const got = contentGroups.filter((g) => (g.own || g.terms).some((t) => have.has(t))).length;
        return got === contentGroups.length || (contentGroups.length >= 4 && got >= contentGroups.length - 1);     // all words, or all but one of four or more
    });
    const scored = keywordHits.map((h) => {
        const coverage = coverageOf(norm.groups, h.index, st.bm25);
        return { ...h, coverage, blended: (top ? (1 - W_COV) * (h.score / top) : 0) + W_COV * coverage + (aliasHit(st.chunks[h.index]) ? ALIAS_BONUS : 0) };
    }).sort((a, b) => b.blended - a.blended);

    let ranked = scored.map((h) => ({ chunk: st.chunks[h.index], score: confidence(h.score), coverage: h.coverage, raw: h.score, blended: h.blended }));
    if (config.retrieval === 'hybrid') {
        try { ranked = await fuse(rewrittenQuery, st, keywordHits); } catch (err) { /* keyword-only */ }
    }
    // A topic the guides do not cover: closed if some section has all the phrase's words in its heading or aliases.
    let gap = null;
    for (const g of norm.gapsHit) {
        const need = g.phrase.flatMap((w) => terms(w));
        // Phrases that contain small words ("you sell", "how many sellers") are never closed automatically: they are about
        // the platform itself, not a section topic. Everything else closes when ONE heading/alias phrase holds all its words.
        const allContent = g.phrase.every((w) => terms(w).length > 0);
        const covered = allContent && need.length > 0 && st.bm25.headSets.some((sets) => sets.some((set) => need.every((t) => set.has(t))));
        if (!covered) { gap = g.topic; break; }
    }
    if (!gap) gap = evidenceGap(rewrittenQuery, norm, ranked.slice(0, 3).map((r) => r.chunk), st);
    const margin = ranked.length > 1 && ranked[0].blended ? Math.max(0, (ranked[0].blended - ranked[1].blended) / ranked[0].blended) : (ranked.length ? 1 : 0);
    return ranked.slice(0, k).map(({ chunk, score, coverage }, i) => {
        const cov = coverage === undefined ? 0 : coverage;
        let confidenceNow = i === 0 ? combinedConfidence(cov, margin) : combinedConfidence(cov, 0);
        if (gap) confidenceNow = Math.min(confidenceNow, 0.2);
        return { source: chunk.source, heading: chunk.heading, text: chunk.text, aliases: chunk.aliases || [], score, coverage: cov, margin: i === 0 ? margin : 0, confidence: confidenceNow, band: bandOf(confidenceNow), normalised: norm.text, gap };
    });
}

/**
 * The platform gap (see query-normalisation.json "gaps") a question falls into, even when keyword retrieval found nothing at all
 * ("is there a warranty" matches no guide text, so there is no section to carry the gap). Returns the topic or null.
 */
function detectGap(query) {
    const st = ensureFresh();
    const norm = normalise(rewriteQuery(query), { vocab: st.vocab });
    const listed = detectListedGap(norm, st);
    if (listed) return listed;
    const hits = st.bm25.search(queryPlan(rewriteQuery(query), st).weights, 12);
    const sections = hits.slice(0, 12).map((h) => ({ h, cov: coverageOf(norm.groups, h.index, st.bm25) })).sort((a, b) => b.cov - a.cov).slice(0, 3).map((x) => st.chunks[x.h.index]);
    return evidenceGap(rewriteQuery(query), norm, sections, st);
}
function detectListedGap(norm, st) {
    for (const g of norm.gapsHit) {
        const need = g.phrase.flatMap((w) => terms(w));
        const allContent = g.phrase.every((w) => terms(w).length > 0);
        const covered = allContent && need.length > 0 && st.bm25.headSets.some((sets) => sets.some((set) => need.every((t) => set.has(t))));
        if (!covered) return g.topic;
    }
    return null;
}

/** For tests and health output. */
function stats() {
    const st = ensureFresh();
    return { mode: config.retrieval, chunks: st.chunks.length, files: new Set(st.chunks.map((c) => c.source)).size };
}

module.exports = { evidenceGap, detectGap, retrieve, invalidateCache, stats, queryTerms, ensureFresh, rewriteQuery, queryPlan, combinedConfidence, bandOf };
