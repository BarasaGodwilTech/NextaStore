'use strict';
/**
 * WIP 97 Part 2.6: the answer when no model can be used (Ollama down, timeout, empty, or a parroting reply), and the
 * honest "not sure" answer. Composes 1-3 sentences chosen for THIS question under a one-line lead. Never returns a whole
 * chunk or a section checklist, and never returns text from a section that does not address the question.
 */
const { terms } = require('../rag/bm25');
const { normalise } = require('../rag/normalise');
const { gapSentence } = require('./gapLine');
const { selectSentences, scoreSentence, clauses, cleanInline, POINTER_RE, META_RE } = require('./compose');

const PROPER = /^(?:seller|nextastore|verified|gold|platinum|mtn|airtel|momo|whatsapp|uganda|kampala|messages|marketplace|orders|favorites|following|notifications|sign|log|remember|account|pwa)\b/i;

/** " -- " (and a spaced hyphen used as a dash) reads as a typing slip: a spaced en dash instead. */
function tidyDashes(text) { return String(text || '').replace(/\s+-{2,3}\s+/g, ' \u2013 ').replace(/\s+-\s+(?=[A-Z])/g, ' \u2013 '); }

// WIP 98: an answer starts with the answer. No "About {heading}:" and no "Here is what applies:" lead, and a section heading is never shown as text.
// The only lead left is "Here's how to ..." and it is used for steps.
const HOW_RE = /^\s*(?:please\s+)?(?:how\s+(?:do|can|should|would|could)\s+(?:i|we|one|you)\s+|how\s+to\s+|what(?:'s| is)\s+the\s+(?:way|steps?|process)\s+to\s+)(.{4,60}?)\s*[?.!]*\s*$/i;
function actionOf(message) {
    const m = HOW_RE.exec(String(message || '').trim()); if (!m) return null;
    const act = m[1].replace(/\b(?:my|our)\b/gi, 'your').replace(/\b(?:me|myself)\b/gi, 'you').replace(/\bmine\b/gi, 'yours').replace(/\bi\b/gi, 'you').trim();
    if (/\b(?:and|or|but|if|when|because)\b/i.test(act) || act.split(/\s+/).length > 7) return null;     // a compound ask is not one "how to"
    return act.charAt(0).toLowerCase() + act.slice(1);
}
/** The numbered steps of a guide section, in order, as plain sentences. */
function stepsOf(text) {
    const steps = []; let open = false;
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
        const m = /^\s*\d+[.)]\s+(.+)$/.exec(raw);
        if (m) { steps.push(m[1]); open = true; continue; }
        if (open && /^\s+\S/.test(raw)) { steps[steps.length - 1] += ' ' + raw.trim(); continue; }      // a wrapped step line
        open = false;
    }
    // a pointer sentence INSIDE a step ("The current password-length requirement is supplied by the live platform rules.") is dropped, the step itself stays
    return steps.map((x) => cleanInline(x).replace(/\s*\([^)]*(?:facts|guide|\.md)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter((sen) => !POINTER_RE.test(sen) && !META_RE.test(sen)).join(' '))
        .filter((x) => x.length >= 8).map((x) => (/[.!?:)"”]$/.test(x) ? x : x + '.'));
}

const NEXT_STEP = 'The quickest way to be sure is to check your [dashboard](/dashboard) or message the team through the Support link at the bottom of any page.';

function shorten(t, max = 200) { const s = String(t); if (s.length <= max) return s; const cut = s.slice(0, max); const i = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf('. '), cut.lastIndexOf(', ')); return (i > 60 ? cut.slice(0, i) : cut.replace(/\s+\S*$/, '')).replace(/[;,]\s*$/, '') + '.'; }

function notSure(message, { gap = null, closest = null } = {}) {
    // WIP 99: a curated topic phrase is named; any other gap word is never printed (see gapLine.js)
    const what = gap ? `${gap}` : null;
    const first = gapSentence(what);
    return [first, closest ? `The closest thing I have: ${shorten(closest)}` : '', what ? 'I can connect you to the NextaStore team on WhatsApp.' : NEXT_STEP].filter(Boolean).join(' ');
}

/**
 * @param {{message: string, retrieved: object[], groups: object[], gap?: string|null, band?: string}} args
 * @returns {{text: string, kind: 'answer'|'unsure', used: object[]}}
 */
function extractiveAnswer({ message, retrieved, groups, gap = null, band = 'answer', maxSentences = 3 }) {
    const chunks = (retrieved || []).filter((r) => !r.isFactsCompanion).slice(0, 2);
    const companion = (retrieved || []).find((r) => r.isFactsCompanion);
    if (!chunks.length || gap) return { text: notSure(message, { gap }), kind: 'unsure', used: [] };

    // One intent: the best sentences of the TOP section only, in the order the guide gives them (a second section is used only
    // when the question has two parts, one per part).
    const multi = clauses(message).length >= 2;
    const parts = multi ? clauses(message) : [message];
    const picked = []; const seen = new Set();
    // a trusted match is answered from its own section; a mid-confidence one may draw on the runner-up too
    // WIP 98: the facts companion supplies the figures/names the TOP section points to; when the top section does not point at the facts, its own sentences answer (a companion
    // pulled in by a runner-up must not replace them: "what happens if my order never arrives" is not answered with the list of order statuses).
    const needsFacts = Boolean(companion) && (multi || band === 'clarify' || Boolean(require('./fallback').factsPointerChunk([chunks[0]])));
    const pool = multi || band === 'clarify' ? [...chunks, ...(needsFacts ? [companion] : [])] : [chunks[0], ...(needsFacts ? [companion] : [])];
    for (const part of parts) {
        const g = multi ? normalise(part).groups : groups;
        let best = null;
        for (const c of pool) {
            for (const s of selectSentences(c.text, g, 3, { forUser: true })) {
                const sc = scoreSentence(s, g) + (c === chunks[0] ? 0.03 : 0);
                if ((!best || sc > best.score) && !seen.has(s)) best = { s, c, score: sc };
            }
        }
        if (best) { picked.push(best); seen.add(best.s); }
    }
    if (!picked.length) return { text: notSure(message, { gap }), kind: 'unsure', used: [] };
    if (!multi) {
        // keep neighbours that also speak to the question, then restore the guide's own order
        const ranked = selectSentences(picked[0].c.text, groups, maxSentences, { forUser: true });
        for (const s of ranked) { if (picked.length >= maxSentences) break; if (!seen.has(s) && scoreSentence(s, groups) > 0.3) { picked.push({ s, c: picked[0].c, score: scoreSentence(s, groups) }); seen.add(s); } }
            }
    // A word the person used that no chosen sentence contains (e.g. "refund"): add the best sentence that does, if there is room.
    const allGroups = multi ? parts.flatMap((p) => normalise(p).groups) : groups;
    for (let guard = 0; guard < 2 && picked.length < maxSentences; guard++) {
        const have = new Set(picked.flatMap((p) => terms(p.s)));
        const missing = allGroups.filter((g) => (g.weak === undefined || g.weak >= 1) && (g.own || g.terms).every((t) => !have.has(t)));
        if (!missing.length) break;
        let best = null;
        for (const c of pool) for (const sen of userSentencesOf(c)) {
            if (seen.has(sen)) continue;
            const hasIt = terms(sen); if (!missing.some((g) => (g.own || g.terms).some((t) => hasIt.includes(t)))) continue;
            const sc = scoreSentence(sen, allGroups); if (!best || sc > best.score) best = { s: sen, c, score: sc };
        }
        if (!best) break;
        picked.push(best); seen.add(best.s);
    }
    if (picked.length > 1) { const orderOf = (p) => userSentencesOf(p.c).indexOf(p.s); picked.sort((a, b) => (chunks.indexOf(a.c) - chunks.indexOf(b.c)) || (orderOf(a) - orderOf(b))); }
    const top = picked.slice(0, maxSentences);
    const used = [...new Set(top.map((p) => p.c))];
    const strongest = Math.max(...top.map((p) => p.score));
    // No sentence speaks to ANY of the question's words (the retrieval gate already handles real gaps): say so rather than dress up a loosely related section.
    // A section the retrieval gate trusts (answer/clarify band) is answered even when the wording differs a lot from the question; only a weak match with no overlap at all is "not sure".
    if (band === 'none' && strongest < 0.2) return { text: notSure(message, { closest: top[0].s }), kind: 'unsure', used: [top[0].c] };
    // steps: a how-to question answered from a section that gives numbered steps is answered with those steps, in order (at most 4)
    const act = actionOf(message); const steps = act ? stepsOf(top[0].c.text) : [];
    if (act && steps.length >= 2 && top.some((p) => steps.includes(p.s) || steps.some((x) => p.s.startsWith(x.slice(0, 40))))) {
        const shown = steps.slice(0, 4);
        return { text: tidyDashes(`Here's how to ${act}:\n${shown.map((x, i) => `${i + 1}. ${x}`).join('\n')}`), kind: 'answer', used };
    }
    return { text: tidyDashes(top.map((p) => p.s).join(' ')), kind: 'answer', used };
}

function userSentencesOf(chunk) { return require('./compose').userSentences(chunk.text); }

module.exports = { extractiveAnswer, notSure, tidyDashes, actionOf, stepsOf, NEXT_STEP };
