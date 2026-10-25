'use strict';
/**
 * WIP 92d: CLAIM-LEVEL check of a model reply against the retrieved context (dependency-free).
 *
 * The earlier detector was topic-level: it only objected when a topic word (delivery, refund, fee ...) was missing
 * from the context, so "The delivery fee is UGX 5,000." passed whenever the context mentioned delivery or fees
 * anywhere else. This module checks the CLAIM itself:
 *
 *   figure claim   a policy sentence (refund / fee / delivery / warranty / return) that states a specific figure:
 *                  an amount, a percentage or a time span ("UGX 5,000", "7 days", "1 year"). It is supported only
 *                  when ONE unit of the context (a sentence or a bullet/paragraph line, together with its heading)
 *                  contains every policy topic of the claim AND every figure.
 *   promise claim  a policy sentence that makes a commitment without a figure ("Free delivery on all items.",
 *                  "Refunds are accepted.", "Delivery is guaranteed.", "Seller Pass payments are not refundable.").
 *                  It is supported only when one context unit makes the same commitment with the same polarity.
 *
 * Sentences that do not state a figure or a commitment ("Delivery is arranged between you and the seller.") are
 * not claims and are left alone, as are disclaimers ("I do not have the fee"), questions and instructions.
 * Everything here is deliberately conservative about what counts as a claim and strict about support.
 */

const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};
const UNIT_NORM = { day: 'day', days: 'day', hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year', minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', '%': 'pct', percent: 'pct' };
const UNIT_RE = '(days?|hours?|hrs?|weeks?|months?|years?|minutes?|mins?|%|percent)';
const WORD_RE = Object.keys(NUMBER_WORDS).join('|');

/** Figures of a sentence as a Set of normalised tokens: "UGX 5,000" -> "5000", "7 days" -> "7day", "3 percent" -> "3pct". */
function figuresOf(text) {
    const out = new Set();
    let s = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
    // WIP 98: "2 to 3 business days" is the same span as "2-3 days"; "20k", "20 thousand" and "UGX 20,000 shillings" are the same amount as "20,000".
    s = require('./numbers').spellOutNumbers(s);
    s = s.replace(/\b(?:business|working|calendar|full|whole)\s+(?=(?:days?|weeks?|hours?|months?)\b)/g, '');
    s = s.replace(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|million|mil)\b/g, (m, n, mult) => String(Math.round(Number(n.replace(/,/g, '')) * (mult === 'k' || mult === 'thousand' ? 1e3 : 1e6))) + ' ');
    // number words next to a unit ("two days", "twenty-four hours")
    s = s.replace(new RegExp(`\\b(${WORD_RE})(?:[- ](one|two|three|four|five|six|seven|eight|nine))?\\s+${UNIT_RE}`, 'g'), (m, a, b, u) => {
        const n = NUMBER_WORDS[a] + (b ? NUMBER_WORDS[b] : 0);
        out.add(`${n}${UNIT_NORM[u]}`);
        return ' ';
    });
    // ranges: "2-3 days", "2 to 3 days"
    s = s.replace(new RegExp(`(\\d+)\\s*(?:-|–|to)\\s*(\\d+)\\s*${UNIT_RE}`, 'g'), (m, a, b, u) => {
        out.add(`${a}${UNIT_NORM[u]}`); out.add(`${b}${UNIT_NORM[u]}`);
        return ' ';
    });
    s = s.replace(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(?:-\s*)?([a-z%]+)?/g, (m, whole, frac, unit, offset, str) => {
        const n = whole.replace(/,/g, '') + (frac ? `.${frac}` : '');
        const u = unit ? UNIT_NORM[unit] : null;
        if (u) { out.add(`${n}${u}`); return ' '; }
        if (/^(?:ugx|shs?|usd|shillings?|dollars?)$/.test(unit || '') || /(?:ugx|shs?|usd|\$)\s*$/.test(str.slice(Math.max(0, offset - 6), offset))) { out.add(n); return ' '; }
        if (Number(n) >= 100) out.add(n);         // a bare number is a figure only when it is amount-sized
        return ' ';
    });
    return out;
}

// Policy classes. A claim sentence is mapped to the classes whose terms it uses.
const CLASS_TERMS = {
    refund: /\b(?:refund(?:s|ed|able|ing)?|money[- ]back|return(?:s|ed)?\s+(?:policy|window|period)|returns?\s+(?:are|is|will be)\b|chargebacks?)\b/,
    fee: /\b(?:fee|fees|cost|costs|costing|price|prices|priced|charge|charges|charged|commission|rates?)\b/,
    delivery: /\b(?:deliver(?:y|ies|ed|s|ing)?|shipping|shipped|ships?|arrive[sd]?|arrival|dispatch(?:ed)?)\b/,
    warranty: /\b(?:warrant(?:y|ies)|guarantee[ds]?|guaranteeing)\b/,
    // WIP 93: offers and payout limits. The knowledge base states none of these, so a figure attached to one is unsupported.
    discount: /\b(?:discounts?|coupons?|promo(?:tions?|tional)?|vouchers?|cash[- ]?back)\b|(?:%|\bpercent)\s+off\b|\b(?:use|enter|apply)\s+(?:the\s+)?(?:promo\s+)?code\b/,
    withdrawal: /\b(?:withdraw(?:al|als|s|ing)?|payouts?|cash[- ]?out)\b/,
};
const MONEY_RE = /\bugx\b|\bshs?\b|\busd\b|\$/;
const CLASSES = Object.keys(CLASS_TERMS);

function classesOf(lower) { return CLASSES.filter((c) => CLASS_TERMS[c].test(lower)); }

const NEG_RE = /\b(?:no|not|never|cannot|can't|cant|isn't|aren't|won't|don't|doesn't|without|non|none)\b|n't\b|-refundable|nonrefundable/;
const PROMISE_POS = [
    ['refund', /\b(?:refunds?\s+(?:are|is|will be|can be|may be)\s+(?:available|accepted|allowed|possible|given|offered|issued|processed|granted|provided)|(?:can|will|may|could)\s+(?:be\s+)?refund(?:ed)?|you\s+(?:can|will|may)\s+(?:get|receive|request|claim)\s+(?:a\s+|your\s+)?(?:full\s+|partial\s+)?(?:refund|money back)|money[- ]back\s+guarantee|full\s+refund|returns?\s+(?:are|is|will be)\s+(?:accepted|allowed|possible|available|free)|get\s+your\s+money\s+back|money\s+back)\b/],
    ['delivery', /\b(?:free\s+(?:delivery|shipping)|(?:delivery|shipping)\s+(?:is|are)\s+(?:free|guaranteed|included|provided|offered)|guaranteed\s+(?:delivery|shipping|arrival)|(?:same|next)[- ]day\s+(?:delivery|shipping)|nextastore\s+(?:delivers|ships|will deliver|will ship)|(?:orders?|items?|goods|products|parcels?)\s+(?:will\s+)?(?:arrive|be delivered|get delivered)\s+(?:same day|the same day|next day|the next day|tomorrow|today|quickly|fast|immediately|on time|within\b)|we\s+(?:deliver|ship|will deliver|will ship)|we\s+guarantee\s+delivery|(?:fast|quick|express)\s+(?:delivery|shipping))\b/],
    ['warranty', /\b(?:(?:come|comes|have|has|with|include|includes|included|covered by|offer|offers|offered|get|gets)\s+(?:a\s+|an\s+|the\s+|full\s+|free\s+)*(?:[a-z0-9-]+\s+){0,2}(?:warranty|guarantee)|(?:warranty|guarantee)\s+(?:is|are|applies|apply|included|provided|offered|valid|covers?|period)|(?:warranties|guarantees)\s+(?:are|is|apply|included|provided|offered)|(?:all|every)\s+(?:products?|items?|goods)\s+(?:are|is|come|comes|have|has)\s+(?:covered|guaranteed|with a warranty))\b/],
    // WIP 93: a verification requirement or a payout/discount promise that the context does not state.
    ['kyc', /\b(?:kyc|know\s+your\s+customer|(?:id|identity)\s+(?:verification|check)|national\s+id|passport\s+(?:number|copy|scan))\b/],
    ['fee', /\b(?:no\s+(?:fees?|charges?|commission|hidden\s+(?:fees?|charges?))|free\s+of\s+charge|zero\s+(?:fees?|commission)|(?:fees?|charges?|commission)\s+(?:is|are)\s+(?:waived|free|zero|included))\b/],
];
const DISCLAIMER_RE = /\b(?:i\s+(?:do\s*n[o']t|don't|cannot|can't|am\s+not|'m\s+not)\s+(?:have|know|see|find|sure|certain|able|provide|confirm|want)|i'?m\s+not\s+(?:sure|certain)|not\s+sure|no\s+information|no\s+details|not\s+(?:specified|stated|listed|provided|mentioned)|isn't\s+(?:specified|stated|listed|provided)|please\s+(?:check|contact|ask|see|visit|message)|(?:check|see|visit)\s+the\b|contact\s+(?:our\s+)?(?:support|team|seller|the seller)|ask\s+the\s+seller|depends\s+on\s+the\s+seller)\b/;

/** Split text into sentences. */
function sentencesOf(text) {
    return String(text || '').replace(/\r/g, '').split(/\n+/).flatMap((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || []).flatMap((x) => x.split(/;|\s[—–]\s/)).map((x) => x.trim()).filter(Boolean);
}

/** The clauses of one sentence: split at ", and / but / then / while / which" and at a bare " and / but ". */
function clausesOfSentence(sentence) {
    return String(sentence).split(/,\s+(?:and|but|then|while|which)\s+|\s+(?:and|but)\s+/i).map((x) => x.trim()).filter((x) => x.length > 3);
}

/** Context units: every sentence and every line, each joined with its "### heading" (so "### Cost\n- UGX 20,000" counts as a cost unit). */
function contextUnits(context) {
    const units = [];
    let heading = '';
    for (const rawLine of String(context || '').replace(/\r/g, '').split('\n')) {
        const h = /^#{1,6}\s+(.*)$/.exec(rawLine);
        if (h) { heading = h[1]; continue; }
        const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
        if (!line) continue;
        units.push(`${heading} ${line}`);
        const sents = sentencesOf(line);
        if (sents.length > 1) for (const s of sents) units.push(`${heading} ${s}`);
    }
    return units;
}

function promiseKeys(sentence) {
    const lower = sentence.toLowerCase().replace(/[’‘]/g, "'");
    const keys = [];
    for (const [cls, re] of PROMISE_POS) {
        const m = re.exec(lower);
        if (!m) continue;
        const neg = cls === 'fee' ? false : NEG_RE.test(lower.slice(Math.max(0, m.index - 24), m.index + m[0].length + 12));
        keys.push({ cls, neg });
    }
    // negative refund statements: "not refundable", "no refunds", "cannot be refunded"
    if (/\b(?:no\s+refunds?|(?:is|are|be|was|were)\s+not\s+(?:refundable|refunded|eligible\s+for\s+(?:a\s+)?refund|accepted)|not\s+refundable|non[- ]?refundable|cannot\s+be\s+refunded|can't\s+be\s+refunded|refunds?\s+(?:are|is)\s+not\s+(?:available|accepted|allowed|possible|offered)|not\s+eligible\s+for\s+(?:a\s+)?refund)\b/.test(lower)) {
        if (!keys.some((k) => k.cls === 'refund' && k.neg)) keys.push({ cls: 'refund', neg: true });
    }
    return keys;
}

function claimOf(sentence) {
    const lower = sentence.toLowerCase().replace(/[’‘]/g, "'");
    if (/\?\s*$/.test(sentence) || DISCLAIMER_RE.test(lower)) return null;
    const figs = figuresOf(lower);
    const classes = classesOf(lower);
    const hasMoney = MONEY_RE.test(lower);
    const promises = promiseKeys(sentence);
    return { sentence, lower, figs, classes, hasMoney, promises, isFigureClaim: figs.size > 0 && (classes.length > 0), isPromise: promises.length > 0 };
}

/** Is `claim` supported by one unit of the context? */
function supported(claim, units) {
    for (const unit of units) {
        const u = unit.toLowerCase().replace(/[’‘]/g, "'");
        let ok = true;
        if (claim.isFigureClaim) {
            const uf = figuresOf(u);
            for (const f of claim.figs) if (!uf.has(f)) { ok = false; break; }
            if (ok) for (const c of claim.classes) {
                if (c === 'fee') { if (!(CLASS_TERMS.fee.test(u) || MONEY_RE.test(u) || /per\s+(?:month|year|week|day)|%|percent/.test(u))) { ok = false; break; } }
                else if (!CLASS_TERMS[c].test(u)) { ok = false; break; }
            }
            if (!ok) continue;
        }
        if (claim.isPromise) {
            const up = promiseKeys(unit);
            const all = claim.promises.every((k) => up.some((x) => x.cls === k.cls && x.neg === k.neg));
            if (!all) continue;
        }
        return true;
    }
    return false;
}

/**
 * @returns {{sentence: string, type: 'figure'|'promise', detail: string}[]} the claims of `reply` that the context does not support.
 */
function claimProblems(reply, context) {
    const units = contextUnits(context);
    const problems = [];
    for (const sentence of sentencesOf(reply)) {
        // WIP 98: a natural answer often joins two facts in one sentence ("costs UGX 20,000, and those payments are not refundable"). Each CLAUSE is a claim of its own and is
        // checked against the context on its own; the whole sentence is only checked when it is a single clause. An invented figure in either clause is still caught.
        const parts = clausesOfSentence(sentence);
        for (const part of parts.length > 1 ? parts : [sentence]) {
            const claim = claimOf(part);
            if (!claim || !(claim.isFigureClaim || claim.isPromise)) continue;
            if (!supported(claim, units)) {
                problems.push({ sentence: part, type: claim.isFigureClaim ? 'figure' : 'promise', detail: claim.isFigureClaim ? `${claim.classes.join('+')} ${[...claim.figs].join(',')}` : claim.promises.map((k) => `${k.neg ? 'not ' : ''}${k.cls}`).join(',') });
            }
        }
    }
    return problems;
}

module.exports = { claimProblems, figuresOf, contextUnits, sentencesOf, promiseKeys, claimOf };
