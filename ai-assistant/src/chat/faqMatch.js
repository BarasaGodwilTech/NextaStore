'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { BM25, terms } = require('../rag/bm25');
const { expand, readFacts } = require('../knowledge/factsValues');

const FAQ_PATH = path.join(config.knowledgeDir, 'faq-instant.json');
const MATCH_THRESHOLD = 6.0;
const MATCH_MARGIN = 0.65;

let state = null;
let stamp = '';

function load() {
    const raw = fs.readFileSync(FAQ_PATH, 'utf8');
    const nextStamp = `${fs.statSync(FAQ_PATH).mtimeMs}:${raw.length}`;
    if (state && stamp === nextStamp) return state;
    const entries = JSON.parse(raw);
    const docs = [];
    const docEntry = [];
    const docQuestion = [];
    entries.forEach((e, entryIndex) => e.questions.forEach((question) => {
        docs.push({ heading: e.id, title: '', text: question });
        docEntry.push(entryIndex);
        docQuestion.push(question);
    }));
    state = { entries, bm25: new BM25(docs, { headingWeight: 1 }), docEntry, docQuestion };
    stamp = nextStamp;
    return state;
}

function queryTerms(text) {
    const m = new Map();
    for (const t of terms(text)) m.set(t, 1);
    return m;
}

function audienceAllowed(entry, audience) {
    return entry.audience === 'any' || entry.audience === audience || (audience === 'guest' && entry.audience === 'buyer');
}

function match(message, { audience = 'guest' } = {}) {
    const st = load();
    const hits = st.bm25.search(queryTerms(message), st.docEntry.length);
    const grouped = new Map();
    const normal = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
    for (const hit of hits) {
        const entryIndex = st.docEntry[hit.index];
        const exactBonus = normal(st.docQuestion[hit.index]) === normal(message) ? 10 : 0;
        const score = hit.score + exactBonus;
        const current = grouped.get(entryIndex);
        if (!current || score > current.score) grouped.set(entryIndex, { index: entryIndex, score });
    }
    const allowed = [...grouped.values()]
        .filter((h) => audienceAllowed(st.entries[h.index], audience))
        .sort((a, b) => b.score - a.score);
    const best = allowed[0];
    const second = allowed[1];
    if (!best) return null;
    const margin = best.score - (second ? second.score : 0);
    if (best.score < MATCH_THRESHOLD || margin < MATCH_MARGIN) return null;
    const entry = st.entries[best.index];
    return {
        id: entry.id,
        answer: expand(entry.answer, readFacts()),
        audience: entry.audience,
        score: best.score,
        margin,
    };
}

function describe() {
    return { threshold: MATCH_THRESHOLD, margin: MATCH_MARGIN, entries: load().entries.length };
}

module.exports = { match, describe, MATCH_THRESHOLD, MATCH_MARGIN, _load: load };
