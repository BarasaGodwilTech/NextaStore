'use strict';
/**
 * WIP 97 Part 4: the SERVER decides whether to answer, ask which topic was meant (clarify) or hand over to the team.
 * The model's own [HANDOFF] marker only counts when this module also sees low coverage.
 */
const config = require('../config');

const GENERAL_ADVICE_RE = /\b(?:what\s+(?:to|should\s+i)\s+sell|ideas?|tips?|advice|pricing|price\s+my|photos?|pictures?|describe|description|first\s+customers?|customers?|buyers?\s+(?:fast|quickly)|reply|respond|package|packaging|grow|trust(?:worthy)?|gifts?|compare|small\s+(?:capital|budget)|capital|budget|which\s+(?:category|product|item)s?|best\s+things|business)\b/i;
const PLATFORM_SPECIFIC_RE = /\b(?:fees?|cost|how\s+much|charges?|refunds?|delivery|shipping|warranty|policy|policies|limits?|how\s+long|how\s+many|deadline|commission|tax|delete|password|badge|seller\s+pass|subscription|trial|order|payment|support|contact|verify|approved?|account|coupon|discount|courier|address|username)\b/i;
const CLARIFY_MARK = /did you mean/i;
const PLAUSIBLE_COVERAGE = 0.3;   // WIP 99: a section explaining less than this share of the question's content words is not a real candidate, so it never becomes a chip
const CLEAR_LEAD = 0.15;          // WIP 99: the best-ranked section leading the runner-up by this much coverage wins outright: answer it, never ask
const SAME_TOPIC_OVERLAP = 0.18;
const ONE_FAMILY_OVERLAP = 0.28;  // WIP 99: sections this alike (the cancel-an-order family: 0.29-0.40) are one task, so chips would only repeat it; below this they are different tasks   // term overlap (heading+aliases+text) above which two sections are one topic family: compose them, do not ask

// WIP 101 (A1): sections about the same TASK family are one choice, and two chips whose labels share their word stems ("avoid scammers" / "avoid scams") are one chip.
const FAMILIES = [
    /\b(?:scams?|scammers?|safe|safety|fraud|report|suspicious|cheat\w*|disappear\w*|vanish\w*|goes\s+wrong)\b/i,
    /\bcancel\w*/i,
    /\b(?:passwords?|log\s?in|sign[\s-]?in|verify\s+email|verification|remember\s+me)\b/i,
    /\b(?:seller\s+pass|subscriptions?|coverage|renew\w*)\b/i,
];
const familyOf = (r) => { const t = `${r.heading} ${(r.aliases || []).slice(0, 3).join(' ')}`; return FAMILIES.findIndex((re) => re.test(t)); };
const stem4 = (label) => new Set(require('../rag/bm25').terms(label).map((t) => t.slice(0, 4)));
function nearDuplicateLabel(a, b) {
    const x = stem4(a); const y = stem4(b); if (!x.size || !y.size) return a.toLowerCase() === b.toLowerCase();
    let i = 0; for (const t of x) if (y.has(t)) i++;
    return i / (x.size + y.size - i) >= 0.5;
}

// Distress or safety situations are ANSWERED from the safety / report sections, never turned into a "did you mean" menu.
const DISTRESS_RE = /\b(?:(?:took|stole|stolen|ran\s+away\s+with)\s+my\s+(?:money|payment|cash)|(?:he|she|they|seller|buyer|shop|store|someone|somebody|man|guy|person)\s+(?:keeps?|kept|is\s+keeping)\s+my\s+(?:money|payment|cash)|(?:i\s+)?(?:was|got|been|am)\s+(?:scammed|cheated|robbed|defrauded|conned)|scammed\s+me|cheated\s+me|(?:seller|buyer|shop|store)\s+(?:has\s+)?(?:disappeared|vanished|ran\s+away|is\s+gone|went\s+quiet|stopped\s+replying)|(?:disappeared|vanished)\s+with\s+my|(?:paid|sent)\s+(?:the\s+)?(?:money|payment)[^.?]{0,40}(?:never\s+(?:came|arrived|delivered|received)|not\s+(?:delivered|received)|disappeared|vanished|gone)|(?:sent|paid|transferred)\s+(?:my\s+)?(?:money|payment|cash)?[^.?]{0,25}(?:to\s+)?(?:the\s+)?wrong\s+(?:number|person|account|seller)|wrong\s+(?:number|person)\b[^.?]{0,30}(?:money|paid|sent|payment)|someone\s+(?:is\s+|has\s+been\s+)?(?:using|logged\s+in(?:to)?|accessing|hacked|stole)\s+(?:to\s+)?my\s+account|(?:my\s+)?account\s+(?:was\s+|has\s+been\s+|got\s+|is\s+)?(?:hacked|stolen|compromised|taken\s+over|breached)|(?:hacked|compromised)\s+(?:my\s+)?account|unauthori[sz]ed\s+(?:login|access|activity|order)|(?:threaten\w*|blackmail\w*|harass\w*)\s+(?:me|us)\b|fake\s+(?:seller|buyer|account|nextastore|support)|(?:pretend\w*|claim\w*)\s+(?:to\s+be|they\s+are|he\s+is|she\s+is)\s+(?:from\s+)?(?:nextastore|support))/i;
const ACCOUNT_TAKEOVER_RE = /\b(?:using\s+my\s+account|logged\s+in\s+(?:to\s+)?my|hacked|compromised|taken\s+over|breached|unauthori[sz]ed\s+(?:login|access))\b/i;
const isDistress = (message) => DISTRESS_RE.test(String(message || ''));
/** Headings of the sections a distress question is answered from, in order. */
const SAFETY_SECTIONS = [/goes\s+wrong\s+with\s+an\s+order/i, /reporting\s+a\s+problem/i, /general\s+safety/i];
const TAKEOVER_SECTIONS = [/remember\s+me/i, /resetting\s+a\s+forgotten\s+password/i];

function topicOverlap(a, b) {
    const { terms } = require('../rag/bm25');
    const set = (r) => new Set(terms(`${r.heading} ${(r.aliases || []).join(' ')} ${r.text}`));
    const x = set(a); const y = set(b); let i = 0; for (const t of x) if (y.has(t)) i++;
    return i / Math.max(1, x.size + y.size - i);
}

/**
 * WIP 99: should this question get clarify chips? Only when the top TWO sections are both plausible (they explain enough of the question) AND
 * are about different tasks. Never when one section's coverage clearly wins, and never for near-duplicate sections.
 * @returns {{kind: 'chips'|'winner'|'same_topic'|'none', options: object[]}}
 */
function planClarify(retrieved, message = '') {
    const [a, b] = retrieved || [];
    if (!a) return { kind: 'none', options: [] };
    const covA = Number(a.coverage) || 0;
    if (!b) return covA >= PLAUSIBLE_COVERAGE ? { kind: 'winner', options: [] } : { kind: 'none', options: [] };
    const covB = Number(b.coverage) || 0;
    const sameTask = a.heading === b.heading || topicOverlap(a, b) >= ONE_FAMILY_OVERLAP || (familyOf(a) >= 0 && familyOf(a) === familyOf(b));   // WIP 101: one task family is one topic
    if (sameTask) return { kind: 'same_topic', options: [] };
    if (covA >= PLAUSIBLE_COVERAGE && covA - covB >= CLEAR_LEAD) return { kind: 'winner', options: [] };
    if (covA >= PLAUSIBLE_COVERAGE && covB >= PLAUSIBLE_COVERAGE) {
        const options = optionsFrom(retrieved, 3, message, { strict: true });
        if (options.length >= 2) return { kind: 'chips', options };
    }
    return { kind: 'none', options: [] };
}

function lastAssistantAskedToClarify(history = []) {
    for (let i = history.length - 1; i >= 0; i--) { if (history[i] && history[i].role === 'assistant') return CLARIFY_MARK.test(String(history[i].content || '')); }
    return false;
}

function optionsFrom(retrieved, limit = 3, message = '', { strict = false } = {}) {
    const { terms } = require('../rag/bm25');
    const q = new Set(terms(message));
    const top = retrieved[0] ? retrieved[0].confidence : 0;
    const seen = new Set(); const out = []; const chosen = [];
    for (const r of retrieved) {
        if (out.length && r.confidence < top - 0.12) continue;           // only topics that are close to the best one
        // WIP 99 (strict): a chip is a different TASK that the question really touches: never a near-duplicate of a chip already shown, never a weak match
        if (strict && (Number(r.coverage) < PLAUSIBLE_COVERAGE || chosen.some((c) => c.heading === r.heading || topicOverlap(c, r) >= ONE_FAMILY_OVERLAP))) continue;
        // WIP 101 (A1): one chip per task family
        const fam = familyOf(r); if (fam >= 0 && chosen.some((c) => familyOf(c) === fam)) continue;
        const key = `${r.source}#${r.heading}`; if (seen.has(key)) continue; seen.add(key);
        // the chunk's own way of asking that is closest to what the person wrote
        const cands = (r.aliases && r.aliases.length ? r.aliases : [r.heading]).map((a) => ({ a, hit: terms(a).filter((t) => q.has(t)).length }));
        cands.sort((x, y) => y.hit - x.hit || x.a.length - y.a.length);
        const label = String(cands[0].a).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\?+$/, '').trim();
        if (!label || out.some((o) => o.label.toLowerCase() === label.toLowerCase() || nearDuplicateLabel(o.label, label))) continue;
        out.push({ label: label.charAt(0).toUpperCase() + label.slice(1), query: label.charAt(0).toUpperCase() + label.slice(1) + '?' });
        chosen.push(r);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * @param {{message: string, retrieved: object[], humanRequest?: boolean, history?: object[]}} args
 * @returns {{tier: 'answer'|'clarify'|'handoff', reason: string, options?: object[]}}
 */
function decideTier({ message, retrieved, humanRequest = false, history = [], gap = null }) {
    if (humanRequest) return { tier: 'handoff', reason: 'user_request' };
    if (isDistress(message)) return { tier: 'answer', reason: 'distress' };   // WIP 101 (A1): answered from the safety / report sections, never a menu, never a handoff-by-gap
    if (gap && !(retrieved && retrieved[0] && retrieved[0].gap)) return { tier: 'handoff', reason: 'not_in_context', gap };
    const top = retrieved && retrieved[0];
    const hadClarify = lastAssistantAskedToClarify(history);
    const general = GENERAL_ADVICE_RE.test(String(message || '')) && !/\b(?:seller\s+pass|fee|refund|delivery|warranty|policy)\b/i.test(String(message || ''));
    if (!top) return general ? { tier: 'answer', reason: 'general_advice' } : (hadClarify ? { tier: 'handoff', reason: 'still_stuck' } : { tier: 'clarify', reason: 'no_match', options: [] });
    if (top.gap) return { tier: 'handoff', reason: 'not_in_context', gap: top.gap };
    // One or two bare words ("account", "my thing") fit many topics: ask which one is meant.
    const { terms } = require('../rag/bm25');
    if ((!history.length || hadClarify) && terms(message).length <= 1 && String(message || '').trim().split(/\s+/).length <= 3) return hadClarify ? { tier: 'handoff', reason: 'still_stuck' } : { tier: 'clarify', reason: 'too_short', options: optionsFrom(retrieved, 3, message) };
    if (top.band === 'none') {
        if (general) return { tier: 'answer', reason: 'general_advice' };
        if (PLATFORM_SPECIFIC_RE.test(String(message || ''))) return { tier: 'handoff', reason: 'not_in_context' };
        if (hadClarify) return { tier: 'handoff', reason: 'still_stuck' };
        // WIP 99: chips only for two plausible, different tasks; one clear winner or one task family is answered; otherwise ask in plain words (no chips)
        const plan = planClarify(retrieved, message);
        if (plan.kind === 'winner' || plan.kind === 'same_topic') return { tier: 'answer', reason: plan.kind };
        return { tier: 'clarify', reason: plan.kind === 'chips' ? 'low_confidence' : 'low_confidence_no_chips', options: plan.options };
    }
    if (top.band === 'clarify') {
        const second = retrieved[1];
        // two different TOPICS tie; near-duplicate sections (measured term overlap) are one topic family and are composed together instead
        const close = second && (top.confidence - second.confidence) < 0.03 && second.heading !== top.heading && topicOverlap(top, second) < SAME_TOPIC_OVERLAP && second.coverage >= 0.5 && second.coverage >= top.coverage - 0.1;
        if (close) {
            const opts = optionsFrom(retrieved, 3, message, { strict: true });
            if (opts.length < 2) return { tier: 'answer', reason: 'same_family' };   // WIP 101 (A1): the two "topics" are one task, so answer instead of asking
            return hadClarify ? { tier: 'handoff', reason: 'still_stuck' } : { tier: 'clarify', reason: 'two_topics', options: opts };
        }
    }
    return { tier: 'answer', reason: top.band };
}

/** The model's [HANDOFF] marker is honoured only when the server also sees weak coverage of a platform-specific question. */
function honourModelHandoff({ retrieved, message }) {
    const top = retrieved && retrieved[0];
    if (!top) return PLATFORM_SPECIFIC_RE.test(String(message || ''));
    return Boolean(top.gap) || (top.band === 'none' && PLATFORM_SPECIFIC_RE.test(String(message || '')));
}

function clarifyText(options) {
    const labels = options.map((o) => o.label.charAt(0).toLowerCase() + o.label.slice(1));
    if (labels.length >= 2) return `I want to point you to the right thing. Did you mean: ${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}?`;
    return 'I want to point you to the right thing. Could you tell me a little more about what you want to do on NextaStore?';
}

module.exports = { isDistress, DISTRESS_RE, ACCOUNT_TAKEOVER_RE, SAFETY_SECTIONS, TAKEOVER_SECTIONS, nearDuplicateLabel, familyOf, planClarify, PLAUSIBLE_COVERAGE, CLEAR_LEAD, decideTier, honourModelHandoff, clarifyText, optionsFrom, lastAssistantAskedToClarify, GENERAL_ADVICE_RE, PLATFORM_SPECIFIC_RE };
