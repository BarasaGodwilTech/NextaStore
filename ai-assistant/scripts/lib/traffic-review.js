'use strict';
/**
 * WIP 99: the pure part of `npm run review:traffic` (so a test can feed it a synthetic log).
 *
 * Input : the rows of data/flagged.jsonl (handoffs, clarifies, "not sure" answers and flagged messages) and, if present, data/lg-misses.jsonl.
 * Output: one row per distinct question + route, scrubbed with the SAME sensitive-data rules as the WhatsApp summary (chat/scrub.js):
 *         question, count, route, top_section (the guide section the question came closest to), suggested_alias_line.
 * Nothing here ever writes to a knowledge file: the alias line is a suggestion the owner pastes by hand.
 */
const { scrubSensitive } = require('../../src/chat/scrub');
const { classifyMessage } = require('../../src/chat/relevance');

const COLUMNS = ['question', 'count', 'route', 'top_section', 'suggested_alias_line'];
// WIP 100: the SAME abusive / manipulation / sensitive classifier the live assistant uses (chat/relevance.js classifyMessage) runs on the text of EVERY row, whatever its logged
// flag type: an insult or a "ignore your instructions" string inside an ordinary handoff or clarify row is counted, never listed, and never gets an alias suggestion.
// Review-side supplements (additive; the live classifier is untouched). They only ever hide MORE rows from the weekly list, never fewer.
const EXTRA_ABUSE = /\b(?:you(?:'re|\s+are)\s+(?:\w+\s+){0,3}(?:stupid|useless|idiot(?:ic)?|moron(?:ic)?|dumb|trash|garbage|worthless|pathetic|rubbish|crap)|(?:stupid|useless|dumb|worthless|pathetic|rubbish)\s+(?:\w+\s+){0,2}(?:bot|robot|assistant|ai|thing|app|site|platform)|piece\s+of\s+(?:shit|crap|garbage|trash)|go\s+to\s+hell|kill\s+yourself|die\b|damn\s+you|screw\s+you|f+u+c+k+|sh[i1]+t)\b/i;
const EXTRA_INJECTION = [
    /(?:^|[\s>\]])(?:system|assistant|developer|admin)\s*(?:prompt|message|override)?\s*:\s*\S/i,
    /<\s*\/?\s*(?:system|assistant|instructions?|prompt|tool|im_start|im_end)\b[^>]*>|<\|[a-z_]+\|>|\[\s*\/?\s*(?:inst|sys)\s*\]|```\s*(?:system|prompt)/i,
    /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(?:instructions?|rules?|guidelines?|polic(?:y|ies)|safety|filters?|restrictions?|above|before)\b/i,
    /\b(?:new|updated|real|actual|hidden)\s+instructions?\b|\bfollow\s+(?:these|my)\s+instructions\b|\byour\s+(?:real|true|actual)\s+(?:task|purpose|job|instructions?)\b/i,
    /\b(?:reveal|print|repeat|leak|show|output|dump)\b[^.\n]{0,30}\b(?:system\s+prompt|hidden\s+prompt|instructions|api\s*key|secret|token|password\s+file|\.env)\b/i,
    /\b(?:you\s+must\s+now|from\s+now\s+on|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|you\s+are\s+now)\b/i,
    /\b(?:jailbreak|dan\s+mode|developer\s+mode|do\s+anything\s+now)\b/i,
];
function unsafeKind(text) {
    const raw = String(text || '');
    const scrubbed = scrubSensitive(raw);
    for (const t of [raw, scrubbed]) { const k = classifyMessage(t).type; if (SKIP_FLAGS.has(k)) return k; }
    // a password / PIN / OTP / card number that was shared inside an otherwise ordinary question ("my password is x why can i not log in")
    // (the scrubber is greedy and also redacts "OTP saying" in a scam REPORT, which is a fine row to learn from, so a secret means: the keyword is followed by "is / was / : / =" or by something with a digit)
    if (/\[card redacted\]/.test(scrubbed)) return 'sensitive';
    for (const m of raw.matchAll(/\b(?:password|passcode|otp|pin|verification code|security code)\b(\s+(?:is|was|are)\b)?\s*([:=])?\s*([^\s,;]+)/gi)) if (m[1] || m[2] || /\d/.test(m[3])) return 'sensitive';
    if (EXTRA_INJECTION.some((re) => re.test(raw))) return 'manipulation';
    if (EXTRA_ABUSE.test(raw)) return 'inappropriate';
    return '';
}
// flag types whose text is not worth learning from (the text is abusive, a manipulation attempt, nothing readable, or was never stored)
const SKIP_FLAGS = new Set(['sensitive', 'inappropriate', 'manipulation', 'unclear']);
// routes where a guide section MAY already have the answer, so an alias is a sensible suggestion (a real gap needs guide text instead: see README)
const ALIAS_ROUTES = /^(?:handoff:(?:not_in_context|still_stuck)|clarify:|unsure:)/;
const FILLER_LEAD = /^(?:hi|hello|hey|pls|plz|please|kindly|dear nexi|nexi)\b[\s,.!:-]*/i;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const keyOf = (q) => squash(q).toLowerCase().replace(/[?!.,\s]+$/g, '');

/** One short alias phrase in the guides' own style ("how do i ..."), or '' when the question is not a good alias. */
function aliasPhrase(question) {
    let p = keyOf(question).replace(/[|;]/g, ' ');
    for (let i = 0; i < 3 && FILLER_LEAD.test(p); i++) p = p.replace(FILLER_LEAD, '');
    p = squash(p.replace(/[?!"]/g, ''));
    const words = p ? p.split(' ') : [];
    if (words.length < 3 || words.length > 14) return '';          // too short to mean anything, or too long to be a phrase people would match
    if (/[\[\]]|\d{5,}/.test(p)) return '';                       // a redaction marker or a long number (order reference, phone) is never an alias
    return p;
}

/** Excel / Sheets run a cell that starts with = + - @ as a formula: a visitor's text must never do that. */
function safeCell(v) { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; }
const csvCell = (v) => { const s = safeCell(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows) { return '\uFEFF' + [COLUMNS.join(',')].concat(rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))).join('\r\n') + '\r\n'; }

const mode = (arr) => { const m = new Map(); for (const x of arr) if (x) m.set(x, (m.get(x) || 0) + 1); let best = '', n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v; } return best; };

/**
 * @param {object[]} flagRows rows of flagged.jsonl
 * @param {{text: string}[]} [lgRows] rows of lg-misses.jsonl
 * @param {{since?: number, minCount?: number}} [opts] since = epoch ms; rows older than that are ignored
 * @returns {{rows: object[], skipped: Record<string, number>, considered: number}}
 */
function buildReview(flagRows, lgRows = [], { since = 0, minCount = 1 } = {}) {
    const groups = new Map(); const skipped = {}; let considered = 0;
    const add = (question, route, top, lang, at) => {
        if (since && at && Date.parse(at) < since) return;
        const bad = unsafeKind(question);
        if (bad) { skipped[bad] = (skipped[bad] || 0) + 1; return; }
        const clean = squash(scrubSensitive(question));
        if (!clean || clean === '[not stored]') return;
        considered++;
        const k = `${keyOf(clean)}\u0001${route}`;
        const g = groups.get(k) || { question: clean, route, tops: [], langs: [], n: 0 };
        g.n++; g.tops.push(top); g.langs.push(lang || 'en'); groups.set(k, g);
    };
    for (const r of flagRows || []) {
        if (!r || typeof r !== 'object') continue;
        if (SKIP_FLAGS.has(r.type)) { skipped[r.type] = (skipped[r.type] || 0) + 1; continue; }
        if (r.type === 'handoff') add(r.text, r.route || `handoff:${r.reason || 'unknown'}`, r.top, r.lang, r.at);
        else if (r.type === 'clarify' || r.type === 'unsure') add(r.text, r.route || `${r.type}:${r.reason || ''}`, r.top, r.lang, r.at);
        else if (r.type === 'off_topic') add(r.text, 'flag:off_topic', '', r.lang, r.at);
    }
    for (const r of lgRows || []) if (r && typeof r.text === 'string') add(r.text, 'lg-miss', '', 'lg', r.at);

    const rows = [...groups.values()].filter((g) => g.n >= minCount).map((g) => {
        const lang = mode(g.langs);
        const phrase = ALIAS_ROUTES.test(g.route) && lang !== 'lg' ? aliasPhrase(g.question) : '';
        return { question: g.question, count: g.n, route: g.route, top_section: mode(g.tops), suggested_alias_line: phrase ? `| ${phrase}` : '' };
    }).sort((a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.question.localeCompare(b.question));
    return { rows, skipped, considered };
}

module.exports = { COLUMNS, unsafeKind, buildReview, aliasPhrase, toCsv, csvCell, keyOf };
