'use strict';
/**
 * WIP 97 Part 2: answer in the person's context, with the guides used to supply and check facts, never pasted back whole.
 * Pure functions, no model, no network. Used by the pipeline (context for the model) and by extractive.js (no-model answer).
 */
const { terms, stem } = require('../rag/bm25');
const { scrubFileNames } = require('./fallback');

// ---------- sentences ----------
const POINTER_RE = /(?:generated\s+(?:platform\s+)?facts\s+file|platform\s+facts\s+file|(?:supplied|provided|given|set)\s+by\s+the\s+live\s+platform\s+rules|\.md\b|`[^`]*\.(?:md|js|json)`)/i;
// Lines in the guides that are instructions TO the assistant. Useful to a model, never shown to a person.
const META_RE = /\b(?:this assistant|the assistant|quote those|never guess|don't guess|do not guess|do not assume|don't promise|do not promise|don't quote|do not quote|if you're not certain|say that the available|rather than naming)\b/i;

function cleanInline(s) {
    return scrubFileNames(String(s || ''))
        .replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Units of a guide section: paragraphs are split into sentences, list items stay whole. Hard-wrapped lines are rejoined. */
function splitSentences(text) {
    const lines = String(text || '').replace(/\r/g, '').replace(/(?<=\S[ \t])(\d{1,2})\.(?=\s+[A-Z])/gm, '$1\u2024').split('\n');   // "1. Store" is numbering, not a sentence end
    const units = []; let para = []; let bullets = []; let intro = '';
    const addSentences = (joined) => { for (const piece of joined.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[*])/)) { if (piece.trim()) units.push(piece.trim()); } };
    const flushBullets = () => {
        if (!bullets.length) return;
        // A short "-" list after a "...:" lead-in is ONE fact ("a store owner can set: logo; theme; ..."), so it keeps its lead-in.
        if (intro && bullets.length <= 6) units.push(`${intro.replace(/:\s*$/, '')}: ${bullets.map((b) => b.replace(/[.;]\s*$/, '')).join('; ')}.`);
        else { if (intro) units.push(intro); bullets.forEach((b) => units.push(b)); }
        bullets = []; intro = '';
    };
    const flushPara = () => {
        if (!para.length) return;
        const joined = para.join(' ').replace(/\s+/g, ' ').trim(); para = [];
        if (/:\s*$/.test(joined)) { const pieces = joined.split(/(?<=[.!?])\s+/); intro = pieces.pop(); if (pieces.length) addSentences(pieces.join(' ')); }
        else addSentences(joined);
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { flushPara(); flushBullets(); continue; }
        if (/^#{1,6}\s/.test(line) || /^>/.test(line) || /^aliases:/i.test(line)) { flushPara(); flushBullets(); continue; }
        if (/^\d+[.)]\s+/.test(line)) { flushPara(); flushBullets(); units.push(line.replace(/^\d+[.)]\s+/, '').trim()); continue; }   // numbered steps stay separate, in order
        if (/^[-*]\s+/.test(line)) { flushPara(); bullets.push(line.replace(/^[-*]\s+/, '').trim()); continue; }
        if (bullets.length && /^\s/.test(raw)) { bullets[bullets.length - 1] += ' ' + line; continue; }   // wrapped bullet line
        flushBullets(); para.push(line);
    }
    flushPara(); flushBullets();
    const merged = [];
    for (const u of units) { if (merged.length && (u.length < 14 || /^[a-z]/.test(u) || /^(?:e\.g|i\.e|etc)\b/i.test(u))) merged[merged.length - 1] += ' ' + u; else merged.push(u); }
    return merged.map((u) => cleanInline(u).replace(/\u2024/g, '.')).map((u) => (/[.!?:)"”]$/.test(u) ? u : u + '.')).filter((u) => u.length >= 8);
}

// Guides often speak to the assistant ("Point users to the Safety page..."). Turn those into what a person can do.
const ADDRESSEE = '(?:users?|the\\s+(?:user|buyer|seller|person)|them|buyers|sellers|people|visitors|customers)';
function toSecondPerson(sentence) {
    return String(sentence)
        .replace(new RegExp(`^(?:Point|Direct|Refer|Send|Guide)\\s+${ADDRESSEE}\\s+to\\s+`, 'i'), 'You can use ')
        .replace(new RegExp(`^(?:Suggest|Recommend|Advise)\\s+(?:that\\s+)?${ADDRESSEE}\\s+`, 'i'), 'It helps to ')
        .replace(new RegExp(`^(?:Tell|Remind)\\s+${ADDRESSEE}\\s+(?:that\\s+|to\\s+)?`, 'i'), '')
        .replace(new RegExp(`^Encourage\\s+${ADDRESSEE}\\s+to\\s+`, 'i'), 'Try to ')
        .replace(/^Explain\s+(?:that\s+)?/i, '')
        .replace(/,\s+and\s+to\s+/g, ', and ')
        .replace(/^(\w)/, (c) => c.toUpperCase());
}

/** Sentences fit to show a person: no file pointers, no instructions aimed at the assistant. */
function userSentences(text) { return splitSentences(text).map(toSecondPerson).filter((s) => !POINTER_RE.test(s) && !META_RE.test(s)); }

// ---------- scoring ----------
function scoreSentence(sentence, groups) {
    if (!groups.length) return 0;
    const have = new Set(terms(sentence));
    let got = 0; let total = 0;
    for (const g of groups) {
        const w = typeof g.weak === 'number' ? g.weak : 1;
        total += w;
        if ((g.own || g.terms).some((t) => have.has(t))) got += w;          // the person's own word
        else if (g.terms.some((t) => have.has(t))) got += 0.6 * w;          // only a synonym of it
    }
    return total ? got / total : 0;
}

/**
 * The best `n` sentences of a chunk for these question groups, kept in their original order. Always at least one sentence.
 * @param {{forUser?: boolean}} [opts] forUser drops sentences that are pointers or instructions to the assistant
 */
function selectSentences(text, groups, n = 3, { forUser = false } = {}) {
    const all = forUser ? userSentences(text) : splitSentences(text).filter((s) => !POINTER_RE.test(s));
    if (!all.length) return [];
    const scored = all.map((s, i) => ({ s, i, score: scoreSentence(s, groups) + (i === 0 ? 0.05 : 0) - Math.max(0, s.split(/\s+/).length - 45) * 0.004 }));
    const best = scored.slice().sort((a, b) => b.score - a.score || a.i - b.i).slice(0, Math.max(1, n)).filter((x, idx) => idx === 0 || x.score > 0.15);
    return best.sort((a, b) => a.i - b.i).map((x) => x.s);
}

// ---------- intent shape ----------
const SITUATIONAL_RE = /\bif\s+(?:i|we|my|the|a|an|someone|he|she|they|it|you)\b|\bwhat\s+if\b|\bin\s+case\b|\bsuppose\b|\b(?:i|we)\s+(?:paid|sent|placed|ordered|bought|received|clicked|tried|submitted|uploaded|transferred|cancelled|canceled|deleted|lost)\b|\bmy\s+(?:\w+\s+){1,2}(?:is|was|are|were|has|have|did|does|doesnt|isnt|wont|cant|not)\b/i;
// WIP 98: the question word after "and" stays in the next clause ("... and IS it refundable"): without it the second clause was too short to count and a two-part question looked single.
const CLAUSE_SPLIT_RE = /\?|;|\b(?:and\s+(?:also\s+)?(?=(?:how|what|can|do|does|is|are|where|when|why|which|will|should)\b)|and|also|plus|but|then|after\s+that)\b/i;

/** Question clauses that carry their own content words (at least two stems each). */
function clauses(message, minTerms = 2) {
    const ASKS = /\b(?:how|what|can|do|does|is|are|where|when|why|which|will|should|am)\b/i;
    return String(message || '').split(new RegExp(CLAUSE_SPLIT_RE.source, 'gi')).map((c) => (c || '').trim())
        .filter((c) => c && (terms(c).length >= minTerms || (terms(c).length >= 1 && ASKS.test(c) && c.split(/\s+/).length >= 3)));
}

/** One intent = FAQ-direct is allowed. Two intents, a situation ("if I...") or a personal report goes to composition. */
function isCompoundOrSituational(message) {
    const m = String(message || '');
    if (SITUATIONAL_RE.test(m)) return true;
    const cs = clauses(m);
    return cs.length >= 2;
}

// ---------- context for the model ----------
/**
 * The facts block: at most `maxChunks` chunks, each trimmed to its best sentences for THIS question, plus live facts.
 * Returns { block, used } and never exceeds `budget` characters.
 */
function buildFactsBlock({ retrieved, groups, liveContext = '', faqAnswer = '', maxChunks = 2, sentencesPerChunk = 3, budget = 1500 }) {
    const parts = []; const owners = [];
    if (faqAnswer) { parts.push(`Confirmed answer: ${cleanInline(faqAnswer)}`); owners.push(null); }
    const used = [];
    const real = retrieved.filter((r) => !r.isFactsCompanion);
    let companion = retrieved.find((r) => r.isFactsCompanion);
    // WIP 98: a facts chunk that retrieval ranked just below the cut-off still supplies the figures of the section that points at it ("the exact window and limit are in the
    // generated facts"): it joins as the companion instead of being dropped.
    if (!companion) {
        const { factsPointerChunk } = require('./fallback');
        const FACTS_SRC = /(?:^|\/)90-project-facts\.generated\.md$/i;
        const keep = real.slice(0, maxChunks);
        if (!keep.some((r) => FACTS_SRC.test(String(r.source || ''))) && factsPointerChunk(keep)) companion = real.slice(maxChunks).find((r) => FACTS_SRC.test(String(r.source || ''))) || null;
    }
    for (const r of real.slice(0, maxChunks)) {
        const sents = selectSentences(r.text, groups, sentencesPerChunk);
        if (!sents.length) continue;
        parts.push(`${cleanInline(r.heading).replace(/\s*\([^)]*\)\s*$/, '')}: ${sents.join(' ')}`); owners.push(r);
        used.push(r);
    }
    if (companion) { const s = selectSentences(companion.text, groups, sentencesPerChunk); if (s.length) { parts.push(`${cleanInline(companion.heading)}: ${s.join(' ')}`); owners.push(companion); used.push(companion); } }
    if (liveContext) { parts.push(String(liveContext).trim()); owners.push(null); }
    // WIP 98: a sentence the selection left out may carry the one figure the answer needs ("Gold Partner (12+ months)", "blocks of 1, 3, 6, 12 or 24 months").
    // Keep a short stub of each such sentence, from the first chunk to the last, as long as the block stays inside the budget.
    const stubsOf = (r, kept) => {
        const have = new Set(kept);
        return splitSentences(r.text).filter((x) => !POINTER_RE.test(x) && !META_RE.test(x) && /\d/.test(x) && !have.has(x))
            .map((x) => { const head = x.split(/:\s/)[0]; return (head.length < x.length && head.length <= 90 ? head : x).replace(/[.;]\s*$/, ''); })
            .filter((x) => x.length <= 110 && /\d/.test(x));
    };
    let room = budget - parts.join('\n').length;
    const withStubs = parts.map((part, i) => {
        const src = owners[i]; if (!src || room < 40) return part;
        const picked = []; let add = 0;
        for (const st of stubsOf(src, selectSentences(src.text, groups, sentencesPerChunk))) { if (add + st.length + 2 > Math.min(room, 220)) break; picked.push(st); add += st.length + 2; }
        if (!picked.length) return part;
        room -= add + 8;
        return `${part} ${picked.map((x) => x.replace(/[.;]\s*$/, '') + '.').join(' ')}`;
    });
    let block = withStubs.join('\n');
    if (block.length > budget) {
        block = parts.join('\n');
        // Trim the lowest-priority material first: later chunks lose sentences before earlier ones do.
        const live = liveContext ? String(liveContext).trim() : '';
        const head = parts.filter((p) => p !== live);
        while (head.join('\n').length + (live ? live.length + 1 : 0) > budget && head.length > 1) head.pop();
        block = [...head, live].filter(Boolean).join('\n');
        if (block.length > budget) block = block.slice(0, budget).replace(/\s+\S*$/, '');
    }
    return { block, used };
}

module.exports = { splitSentences, userSentences, selectSentences, scoreSentence, clauses, isCompoundOrSituational, buildFactsBlock, cleanInline, POINTER_RE, META_RE };
