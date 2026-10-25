'use strict';
/**
 * WIP 97: turns a messy question into a clean search plan. Deterministic, no model, no network.
 *   1. lowercase, join multi-word spellings ("sign up" -> "signup"), expand text-speak ("hw" -> "how")
 *   2. drop filler ("pls", "kindly")
 *   3. fix typos by edit distance (<= 2, 1 for short words) against the words the help guides really use
 *   4. add synonyms and whole-phrase intents (all editable in query-normalisation.json, no code needed)
 * The result is a Map of search terms with weights, plus the question's "content groups" which the
 * retriever uses to measure how much of the question a chunk actually explains (coverage).
 */
const fs = require('fs');
const path = require('path');
const { rawTokens, terms, stem, STOPWORDS } = require('./bm25');

const DATA_PATH = path.join(__dirname, 'query-normalisation.json');
let data = null; let dataStamp = '';

function loadData() {
    let stamp = 'none';
    try { const st = fs.statSync(DATA_PATH); stamp = `${st.mtimeMs}:${st.size}`; } catch (e) { /* missing file = no normalisation extras */ }
    if (data && stamp === dataStamp) return data;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) { raw = {}; }
    const lower = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k.toLowerCase(), v]));
    data = {
        fillers: new Set((raw.fillers || []).map((x) => String(x).toLowerCase())),
        slang: lower(raw.slang),
        phrases: Object.entries(lower(raw.phrases)).sort((a, b) => b[0].length - a[0].length),
        synonyms: lower(raw.synonyms),
        intents: (raw.intents || []).filter((i) => i && Array.isArray(i.when) && i.add),
        curated: (raw.curated_words || []).map((x) => String(x).toLowerCase()),
        weak: lower(raw.weak_words),
        gaps: (raw.gaps || []).filter((g) => g && g.topic && Array.isArray(g.when)),
        neverFix: new Set((raw.never_fix || []).map((x) => String(x).toLowerCase())),
        // WIP 98: evidence-based "is this in the guides?" check (see retrieve.js evidenceGap) and platform-concept nouns (never product searches).
        concepts: (raw.platform_concepts || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean),
        scaffold: new Set((raw.scaffold_words || []).map((x) => String(x).toLowerCase())),
        factAsks: (raw.fact_asks || []).map((x) => { try { return new RegExp(String(x), 'i'); } catch (e) { return null; } }).filter(Boolean),
        factKinds: (raw.fact_kinds || []).filter((k) => k && k.topic && Array.isArray(k.when)).map((k) => ({ topic: k.topic, needs: (k.needs || []).map((x) => String(x).toLowerCase()), when: k.when.map((x) => { try { return new RegExp(String(x), 'i'); } catch (e) { return null; } }).filter(Boolean) })),
    };
    dataStamp = stamp;
    return data;
}

function dataStampNow() { try { const st = fs.statSync(DATA_PATH); return `${st.mtimeMs}:${st.size}`; } catch (e) { return 'none'; } }

/** Damerau-Levenshtein (adjacent swap = 1), abandoned early once it must exceed `max`. */
function editDistance(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev2 = null; let prev = Array.from({ length: lb + 1 }, (_, j) => j);
    for (let i = 1; i <= la; i++) {
        const cur = [i]; let rowMin = i;
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v; if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
        prev2 = prev; prev = cur;
    }
    return prev[lb];
}

const firstLetterCache = new WeakMap();
/** Words of the vocabulary that start with `letter` (typos rarely change the first letter), cached per vocabulary. */
function byFirstLetter(vocab, letter) {
    let idx = firstLetterCache.get(vocab);
    if (!idx) { idx = new Map(); for (const entry of vocab) { const k = entry[0][0]; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(entry); } firstLetterCache.set(vocab, idx); }
    return idx.get(letter) || [];
}

/** Closest known word, or null. `vocab` is Map(word -> count) of words the guides use. */
function fixTypo(token, vocab, d) {
    if (token.length < 5 || /\d/.test(token) || d.neverFix.has(token)) return null;
    if (vocab.has(token) || STOPWORDS.has(token) || d.slang[token] !== undefined || d.synonyms[token] !== undefined) return null;
    const max = token.length >= 8 ? 2 : 1;
    let best = null; let bestDist = max + 1; let bestCount = -1;
    for (const [w, count] of byFirstLetter(vocab, token[0])) {
        if (Math.abs(w.length - token.length) > max || w.length < 4) continue;
        if (w[0] !== token[0]) continue;           // typos almost never change the first letter
        const dist = editDistance(token, w, max);
        if (dist > max) continue;
        if (dist < bestDist || (dist === bestDist && count > bestCount)) { best = w; bestDist = dist; bestCount = count; }
    }
    return best;
}

/**
 * @param {string} query
 * @param {{vocab?: Map<string, number>}} [opts]
 * @returns {{text: string, tokens: string[], groups: {word: string, terms: string[]}[], weights: Map<string, number>, corrections: object[], intentsHit: string[]}}
 */
function normalise(query, { vocab = new Map() } = {}) {
    const d = loadData();
    let s = ' ' + String(query || '').toLowerCase().normalize('NFC').replace(/['’`]/g, '').replace(/[^a-z0-9ŋ]+/g, ' ') + ' ';
    for (const [from, to] of d.phrases) s = s.split(` ${from} `).join(` ${to} `);
    let toks = s.trim().split(/\s+/).filter(Boolean);

    const out = []; const corrections = [];
    for (let i = 0; i < toks.length; i++) {
        let t = toks[i];
        if (t === '2' && ['how', 'want', 'wants', 'need', 'way', 'ways', 'wanted', 'trying', 'try'].includes(out[out.length - 1])) t = 'to';
        const expanded = d.slang[t] !== undefined ? String(d.slang[t]).split(/\s+/) : [t];
        if (d.slang[t] !== undefined && expanded.join(' ') !== t) corrections.push({ from: t, to: expanded.join(' '), kind: 'slang' });
        for (let w of expanded) {
            if (d.fillers.has(w)) continue;
            const fixed = fixTypo(w, vocab, d);
            if (fixed && fixed !== w) { corrections.push({ from: w, to: fixed, kind: 'typo' }); w = fixed; }
            out.push(w);
        }
    }
    const tokens = out;

    const present = new Set(tokens);
    const presentStems = new Set(tokens.map(stem));
    const weights = new Map();
    const put = (term, w) => { if (term && (weights.get(term) || 0) < w) weights.set(term, w); };
    const groups = [];
    for (const tok of tokens) {
        // Small words that still carry a meaning ("how much" = a price question) add their synonyms but are not searched for themselves.
        if (STOPWORDS.has(tok) && d.synonyms[tok]) { const extra = d.synonyms[tok].flatMap((x) => terms(x)); extra.forEach((t) => put(t, 0.8)); if (extra.length) groups.push({ word: tok, weak: 0.6, terms: [...new Set(extra)] }); continue; }
        if (STOPWORDS.has(tok) || d.fillers.has(tok)) continue;
        const own = terms(tok);
        if (!own.length) continue;
        const weak = typeof d.weak[tok] === 'number' ? d.weak[tok] : 1;
        own.forEach((t) => put(t, weak));
        const syn = (d.synonyms[tok] || []).flatMap((x) => terms(x));
        syn.forEach((t) => put(t, 0.8 * weak));
        groups.push({ word: tok, weak, own: [...new Set(own)], terms: [...new Set([...own, ...syn])] });
    }
    const intentsHit = [];
    for (const intent of d.intents) {
        const hit = intent.when.some((phrase) => Array.isArray(phrase) && phrase.length && phrase.every((w) => present.has(String(w).toLowerCase()) || presentStems.has(stem(String(w).toLowerCase()))));
        if (hit) { intentsHit.push(intent.add); terms(intent.add).forEach((t) => put(t, 0.6)); }
    }
    // Platform-specific topics the guides do not cover (closed again by retrieve.js when a section about it exists).
    const gapsHit = [];
    for (const g of d.gaps) {
        // gap phrases must be the words next to each other, in order ("how many sellers"), unlike intents which accept any order
        const stemsAll = tokens.map(stem);
        const stemsContent = tokens.filter((t) => !STOPWORDS.has(t)).map(stem);      // "change MY shop name" == "change shop name"
        const adjacent = (stems, want) => { for (let i = 0; i + want.length <= stems.length; i++) { if (want.every((w, j) => stems[i + j] === w)) return true; } return false; };
        const phrase = g.when.find((ph) => { if (!Array.isArray(ph) || !ph.length) return false; const want = ph.map((w) => stem(String(w).toLowerCase())); const wantContent = ph.filter((w) => !STOPWORDS.has(String(w).toLowerCase())).map((w) => stem(String(w).toLowerCase())); return adjacent(stemsAll, want) || (wantContent.length === want.length && adjacent(stemsContent, wantContent)); });
        if (phrase) gapsHit.push({ topic: g.topic, phrase: phrase.map((w) => String(w).toLowerCase()) });
    }
    return { text: tokens.join(' '), tokens, groups, weights, corrections, intentsHit, gapsHit };
}

/** WIP 98: does the text name a platform concept (discount, shipping, warranty ...)? Returns the concept or null. Admin-editable list in query-normalisation.json. */
function platformConcept(text) {
    const d = loadData();
    const t = ' ' + String(text || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9ŋ]+/g, ' ').trim() + ' ';
    const tStems = new Set(t.trim().split(/\s+/).map(stem));
    for (const c of d.concepts) {
        const words = c.split(/\s+/);
        if (words.length === 1 ? tStems.has(stem(words[0])) : t.includes(' ' + c + ' ')) return c;
    }
    return null;
}

/** Same phrase joining the questions get, applied to guide text so "Log out" and "logout" meet. Lowercases. */
function joinPhrases(text) {
    const d = loadData();
    let s = ' ' + String(text || '').toLowerCase().normalize('NFC').replace(/['’`]/g, '').replace(/[^a-z0-9ŋ]+/g, ' ') + ' ';
    for (const [from, to] of d.phrases) s = s.split(` ${from} `).join(` ${to} `);
    return s.trim();
}

/** Curated spellings plus every word the guides use, for typo fixing. Counts decide ties. */
function buildVocab(textSources) {
    const d = loadData();
    const vocab = new Map();
    for (const src of textSources) for (const w of rawTokens(src)) vocab.set(w, (vocab.get(w) || 0) + 1);
    for (const w of d.curated) vocab.set(w, (vocab.get(w) || 0) + 1);
    return vocab;
}

module.exports = { platformConcept, normalise, buildVocab, joinPhrases, editDistance, fixTypo, loadData, dataStampNow, DATA_PATH };
