'use strict';
/**
 * WIP 97 Part 2.4 / 2.5: tidy whatever a model returns (English only) and catch a model that just parrots the guide text.
 * Deterministic; has no idea which model produced the text.
 */
const { rawTokens, terms } = require('../rag/bm25');

const META_PHRASE_RES = [
    /\b(?:based on|according to|from|using|per)\s+(?:the\s+|this\s+|my\s+|your\s+)?(?:provided\s+|given\s+)?(?:context|knowledge(?:\s+base)?|information|facts|documents?|sources?|guides?|material)\b[^.,:;\n]*[,:]?\s*/gi,
    /\b(?:as\s+an?\s+(?:ai|artificial intelligence)(?:\s+(?:language\s+)?(?:model|assistant))?)\b[,.]?\s*/gi,
    /\bI(?:'m| am)\s+(?:just\s+)?an?\s+(?:ai|language model)\b[,.]?\s*/gi,
    /\b(?:the\s+)?(?:provided|given)\s+(?:context|knowledge|facts|information)\s+(?:says|states|mentions|shows|indicates)\s+(?:that\s+)?/gi,
];

const normSentence = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ŋ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function splitForReply(text) {
    return String(text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[*])|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {string} text model output
 * @param {{headings?: string[], truncated?: boolean, maxWords?: number}} [opts]
 */
function cleanEnglishReply(text, { headings = [], truncated = false, maxWords = 90 } = {}) {
    let t = String(text || '').replace(/\r/g, '').trim();
    if (!t) return '';
    for (const re of META_PHRASE_RES) t = t.replace(re, '');
    t = t.replace(/[ \t]+-{2,3}[ \t]+/g, ' \u2013 ');      // WIP 98: " -- " is a typing slip; a spaced en dash instead
    t = t.replace(/^\s*#{1,6}\s+.*\n?/gm, (line) => (/\?\s*$/.test(line) ? line : ''));     // markdown headings are never part of an answer
    // drop a leading line that merely echoes a section heading (plain, bold or "###")
    const lines = t.split('\n');
    const headSet = new Set(headings.map(normSentence).filter(Boolean));
    while (lines.length > 1 && headSet.has(normSentence(lines[0].replace(/^[#*\s]+|[*:\s]+$/g, '')))) lines.shift();
    t = lines.join('\n').trim();
    // remove duplicated sentences, keeping the first
    const seen = new Set(); const kept = [];
    for (const piece of t.split(/(\n+)/)) {
        if (/^\n+$/.test(piece)) { kept.push(piece); continue; }
        const sentences = piece.split(/(?<=[.!?])\s+/);
        const out = [];
        for (const s of sentences) { const k = normSentence(s); if (k.length > 12 && seen.has(k)) continue; if (k.length > 12) seen.add(k); out.push(s); }
        kept.push(out.join(' '));
    }
    t = kept.join('').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    const steps = (t.match(/^\s*(?:\d+[.)]|[-*])\s+/gm) || []).length >= 2;
    // a model that ran out of tokens: cut at the last complete sentence
    if ((truncated || !/[.!?)"”\]]\s*$/.test(t)) && /[.!?]/.test(t)) {
        const cut = t.search(/[.!?](?=[^.!?]*$)/);
        if (cut > 20) t = t.slice(0, cut + 1);
    }
    // about 90 words unless the answer is steps
    if (!steps) {
        const words = t.split(/\s+/);
        if (words.length > maxWords + 15) {
            const head = words.slice(0, maxWords).join(' ');
            const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
            t = cut > 40 ? head.slice(0, cut + 1) : head.replace(/[,;:\s]+\S*$/, '') + '.';
        }
    }
    return t.replace(/\s+([.,!?])/g, '$1').trim();
}

function ngrams(tokens, n) { const out = new Set(); for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' ')); return out; }

/** Share of the reply's 4-grams found in the single best-matching chunk (0..1). */
function overlapRatio(reply, chunkTexts, n = 4) {
    const rt = rawTokens(reply); if (rt.length < n + 1) return 0;
    const rg = ngrams(rt, n); let best = 0;
    for (const c of chunkTexts) { const cg = ngrams(rawTokens(c), n); let hit = 0; for (const g of rg) if (cg.has(g)) hit++; best = Math.max(best, hit / rg.size); }
    return best;
}

// WIP 98: "explain / describe / walk me through" frame the ask; a good answer does not repeat them, so they are never demanded of a reply.
const ASK_VERBS = new Set(['explain', 'describe', 'walk', 'through', 'tell', 'show', 'list', 'outline', 'summarise', 'summarize', 'detail', 'details', 'please', 'after', 'before', 'then', 'also', 'next', 'still']);   // + words that only link the two halves of a question
const isAskVerb = (g) => ASK_VERBS.has(String(g.word || '').toLowerCase());

/**
 * WIP 98: the terms a reply speaks to, compared by FACT and not by token. Besides its own words it counts for:
 *   "money back" / "get your money back"   -> the refund idea        (a reply may say money back where the question said refund)
 *   an amount (UGX 20,000, 20k, 5 thousand shillings) -> cost / price / fee   (the answer to "how much")
 *   a span of time (7 days, 30 minutes, a year)         -> long / duration     (the answer to "how long")
 *   a count ("up to 3 times", "at most three")          -> many / times        (the answer to "how many")
 */
function replyTerms(reply) {
    const text = String(reply || ''); const lower = text.toLowerCase();
    const set = new Set(terms(text));
    if (/\bmoney[- ]back\b|\bback\s+(?:your|my|the)\s+money\b|\breimburs/.test(lower)) for (const t of terms('refund refunds refundable')) set.add(t);
    const { spellOutNumbers } = require('./numbers'); const spelled = spellOutNumbers(lower);
    if (/\b(?:ugx|shs?|usd|shillings?)\b|\d\s*k\b|\bthousand\b|\bmillion\b|\$/.test(spelled) || /\d{1,3}(?:,\d{3})+/.test(spelled)) for (const t of terms('cost price fee charge amount')) set.add(t);
    if (/(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)[- ](?:minutes?|hours?|days?|weeks?|months?|years?)\b|\b(?:a|one)\s+(?:year|month|week)\b/.test(spelled)) for (const t of terms('long duration')) set.add(t);
    if (/\b(?:\d+|once|twice|(?:one|two|three|four|five|six|seven|eight|nine|ten))\s+(?:times?|orders?|items?|products?|stores?)\b|\bat\s+most\b|\bup\s+to\b/.test(spelled)) for (const t of terms('many times number limit')) set.add(t);
    return set;
}

/** Share of the question's content groups that the reply speaks to. */
function questionCoverage(reply, groups) {
    groups = (groups || []).filter((g) => !isAskVerb(g));
    if (!groups.length) return 1;
    const have = replyTerms(reply); let got = 0; let total = 0;
    for (const g of groups) { const w = typeof g.weak === 'number' ? g.weak : 1; total += w; if (g.terms.some((t) => have.has(t))) got += w; }
    return total ? got / total : 1;
}

/**
 * WIP 98: a SHORT reply (at most 3 sentences) whose wording is the guide's best sentences for THIS question is the answer itself, even when the
 * question's own words ("requirements", "tiers") are not repeated in it. A paste of a whole section is never focused: it has more sentences.
 */
function isFocusedQuote(reply, chunkTexts, groups) {
    const { selectSentences, scoreSentence } = require('./compose');
    if (!groups || !groups.length) return false;
    const sentences = splitForReply(reply);
    if (!sentences.length || sentences.length > 3) return false;
    const best = chunkTexts.flatMap((c) => selectSentences(c, groups, 3, { forUser: true })).filter((x) => scoreSentence(x, groups) > 0);
    if (!best.length) return false;
    return overlapRatio(reply, [best.join(' ')]) >= 0.9;
}

/** A paste of (most of) a multi-sentence section: 4+ sentences in the guide and at least 80% of them are in the reply. */
function pastesSection(reply, chunkTexts, minShare = 0.8) {
    const { splitSentences } = require('./compose');
    const flat = String(reply || '').replace(/\s+/g, ' ');
    return chunkTexts.some((c) => { const ss = splitSentences(c); if (ss.length < 4) return false; const hit = ss.filter((x) => flat.includes(x.replace(/\s+/g, ' ').slice(0, 60))).length; return hit / ss.length >= minShare; });
}

/** Parroting: lifted from one chunk AND not speaking to the question (and not just the guide's own best answer to it), or most of a whole section pasted back. */
function isParroting(reply, chunkTexts, groups, { overlap = 0.6, coverage = 0.5 } = {}) {
    if (pastesSection(reply, chunkTexts)) return true;
    return overlapRatio(reply, chunkTexts) >= overlap && questionCoverage(reply, groups) < coverage && !isFocusedQuote(reply, chunkTexts, groups);
}

/** A reply worth showing: a few words that do not start with punctuation or a stray one-letter fragment ("g. trial ending soon)"). */
function isUsableReply(text) {
    const t = String(text || '').trim();
    if (t.split(/\s+/).filter(Boolean).length < 3) return false;
    if (/[,:]\s*\d{1,2}\.\s*$/.test(t)) return false;                       // WIP 98: cut off inside a numbered list ("... 1. Store Basics, 2.")
    // WIP 98: letters and digits of ANY script count (a reply may start with "Ŋ" or an accented capital); only punctuation first is a fragment.
    if (!/^[\p{L}\p{N}"“'(\[*]/u.test(t) || /^\p{L}\.\s/u.test(t)) return false;   // punctuation first, or a stray "g. " fragment
    // a short reply that starts in lower case is a tail cut off a longer sentence ("com for help."), not an answer
    if (/^\p{Ll}/u.test(t) && t.split(/\s+/).length < 6 && (t.match(/[.!?]/g) || []).length < 2) return false;
    return true;
}

/**
 * A two-part question needs BOTH parts answered. Each part's own words (the ones not shared with the other part) must be spoken to
 * by the reply, otherwise the reply answered one half only.
 */
function partsCovered(reply, parts, topicText = '', minCoverage = 0.6) {
    if (!Array.isArray(parts) || parts.length < 2) return true;
    const { normalise } = require('../rag/normalise');
    const topic = new Set(terms(topicText));
    const groupsOf = parts.map((p) => normalise(p).groups);
    for (let i = 0; i < parts.length; i++) {
        const others = new Set(groupsOf.filter((_, j) => j !== i).flatMap((gs) => gs.map((g) => g.word)));
        const mine = groupsOf[i].filter((g) => !isAskVerb(g));
        // a word that another word of the same part already stands for ("cancel" inside "refund") is not a separate demand
        const covered = new Set(mine.flatMap((g) => g.terms.filter((t) => !(g.own || []).includes(t))));
        const ownOf = (g) => (g.own && g.own.length ? g.own : [g.word]);
        const own = mine.filter((g) => !others.has(g.word) && !(typeof g.weak === 'number' && g.weak < 0.3) && !ownOf(g).some((t) => topic.has(t)) && !ownOf(g).every((t) => covered.has(t)));
        if (own.length && questionCoverage(reply, own) < minCoverage) return false;
    }
    return true;
}

const STARTS_WITH_HEADING_RE = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/;

module.exports = { replyTerms, pastesSection, isFocusedQuote, partsCovered, isUsableReply, cleanEnglishReply, overlapRatio, questionCoverage, isParroting, STARTS_WITH_HEADING_RE, normSentence, splitForReply };
