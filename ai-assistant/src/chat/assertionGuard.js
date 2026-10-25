'use strict';
/**
 * WIP 100: ASSERTION-SUPPORT GUARD (reply level).
 *
 * The claim check (claims.js) only objects to a figure or a policy promise. A confident model can still answer a question about
 * availability, fees, limits, prices, locations or policy that the guides do not cover with a plain "Yes, you can do that on NextaStore."
 * or "No, there is no fee.": no figure, no policy word, so nothing objected.
 *
 * Rule (deterministic, no model, no network):
 *   1. The QUESTION must have a shape that asks for a platform fact: "can I ...", "do you ...", "is there ...", "what is the fee / limit /
 *      maximum ...", "how much / how many / how long ...", "where is your office", "is my money safe". General selling and shopping advice
 *      ("how do I ...", tips, ideas, "what should I sell", "can you help me ...") is never gated.
 *   2. The REPLY must ASSERT something: begin with yes / no, state "you can ..." / "there is no ...", or state a figure. Instructions, disclaimers
 *      ("I do not have that"), questions and the "not in the guides" handoff are not assertions.
 *   3. An assertion is allowed ONLY IF one SENTENCE of the retrieved text contains the question's key object AND a predicate that matches the
 *      kind of question (a fee word or an amount for "what is the fee", a limit word or a figure for "what is the maximum", the action verb for
 *      "can I pay ...", the safety word for "is my money safe"). Otherwise the reply is replaced by the "not in the guides" handoff.
 *
 * "Key object" = the question's content words. A word that is rare in the guides (or absent from them) MUST be in the supporting sentence; the
 * common words only have to add up to half of the weight. Words that are only ask-framing (offer, have, maximum ...), time spans attached to a
 * number ("an hour", "30 days") and generic filler (thing, amount, number ...) are not objects.
 */
const { rawTokens, stem, STOPWORDS } = require('../rag/bm25');

// ---------------------------------------------------------------- 1. the question
const LEAD_RE = /^(?:(?:hi|hello|hey|ok|okay|so|and|also|please|pls|plz|kindly|dear\s+nexi|nexi|sir|madam)[\s,]+)+/;
// advice / how-to / opinion: never gated
const ADVICE_RES = [
    /\b(?:how\s+(?:do|does|can|could|should|would|to|did)\b)/,
    /\bshould\s+(?:i|we|my)\b/, /\bwhat\s+(?:should|to|can\s+i\s+do|do\s+i\s+do)\b/, /\bwhich\s+(?:one|is\s+better|should)\b/,
    /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help|tell|explain|show|give|suggest|recommend|teach|guide|share|list|describe|walk|assist|advise|write|draft|compare|summar|remind|clarify|point|direct|take|connect)/,
    /\b(?:tips?|ideas?|advice|suggestions?|recommend\w*|best\s+way|good\s+way|better\s+way|ways\s+to|help\s+me|guide\s+me|teach\s+me|explain|what\s+is\s+nextastore|what\s+does\s+nextastore\s+do|difference\s+between)\b/,
];
// the question asks for a yes/no
const POLARITY_RE = /^(?:can|could|may|might|am|is|are|was|were|do|does|did|will|would|has|have|had|shall)\b/;
const MID_POLARITY_RES = [
    /\b(?:can|could|may)\s+(?:i|we|you|one|a\s+seller|sellers?|buyers?|shoppers?|customers?|someone|anyone|people|users?|stores?|shops?)\b/,
    /\b(?:do|does|did)\s+(?:you|u|nextastore|nexta|it|they|the\s+(?:site|platform|website|app|store|shop|seller)|a\s+(?:store|shop|seller)|sellers?|buyers?|stores?|shops?|shoppers?|customers?)\b/,
    /\bis\s+there\b/, /\bare\s+there\b/, /\b(?:is|are)\s+(?:it|this|that)\s+(?:possible|allowed|free|available|safe|legal|true)\b/,
    /\b(?:is|are)\s+(?:my|our|your|the)\s+\w+\s+(?:safe|secure|protected|covered|insured|refundable|free|guaranteed)\b/,
];
const FEE_Q_RE = /\b(?:fees?|costs?|prices?|priced|pricing|charges?|charged|commission|rates?|how\s+much|taxes|tax)\b/;
const LIMIT_Q_RE = /\b(?:limits?|maximum|minimum|max|min|cap|capped|at\s+most|at\s+least|longest|shortest|highest|lowest|biggest|largest|smallest|most|least|how\s+many|how\s+long|how\s+old|how\s+big|how\s+large|how\s+fast|how\s+soon|how\s+often|age\s+(?:limit|requirement)|deadline)\b/;
const WH_RE = /\b(?:what|which|how\s+(?:much|many|long|old|big|large|fast|soon|often))\b/;
const LOCATION_Q_RE = /\bwhere\s+(?:is|are|do|does|can)\b[^?]*\b(?:office|offices|located|based|headquarters|hq|branch(?:es)?|warehouse|shops?|stores?\s+located|operate|you)\b|\b(?:which|what)\s+(?:districts?|towns?|cities|city|countries|country|areas?|regions?)\b/;
const SAFETY_Q_RE = /\b(?:is|are)\s+(?:my|our|your|the)\s+\w+(?:\s+\w+)?\s+(?:safe|secure|protected|covered|insured)\b/;

/**
 * Shape of the question (on the already normalised text).
 * @returns {{kind: 'fee'|'limit'|'location'|'safety'|'availability'|'policy', verb: string}|null}
 */
function questionShape(text, raw = '') {
    const rawLower = String(raw || '').toLowerCase().replace(/[’‘]/g, "'");
    const t = ' ' + String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ?]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const body = t.trim().replace(LEAD_RE, '').trim();
    // the normaliser drops filler such as "help" ("can you help me ..."), so advice is tested on the person's own words as well
    if (ADVICE_RES.some((re) => re.test(t) || (rawLower && re.test(' ' + rawLower + ' ')))) return null;
    const polarity = POLARITY_RE.test(body) || MID_POLARITY_RES.some((re) => re.test(t));
    const wh = WH_RE.test(t);
    let kind = null;
    if (LOCATION_Q_RE.test(t) && !/\bhow\s+do\b/.test(t)) kind = 'location';
    else if (SAFETY_Q_RE.test(t)) kind = 'safety';
    else if (LIMIT_Q_RE.test(t) && (wh || polarity)) kind = 'limit';
    else if (FEE_Q_RE.test(t) && (wh || polarity)) kind = 'fee';
    else if (polarity && !/^(?:what|which|who|whom|whose|why|when|where|how)\b/.test(body)) kind = 'availability';   // "what does the store setup include" is an open question, not a yes/no
    if (!kind) return null;
    const verb = /\b(?:can|could|may|do|does|did|will|would)\s+(?:you|u|i|we|nextastore|it|sellers?|buyers?|a\s+seller|a\s+buyer|one|someone|anyone|people|users?)\s+(?:also\s+|just\s+|really\s+)?([a-z]+)/.exec(t);
    // WIP 101 (A2): which way a limit points. "at least 8 characters" answers "the shortest password", never "the longest password".
    const minQ = /\b(?:minimum|min|shortest|smallest|lowest|fewest|least)\b/.test(t); const maxQ = /\b(?:maximum|max|longest|largest|biggest|highest|most|cap|capped)\b/.test(t);
    const dir = minQ && !maxQ ? 'min' : (maxQ && !minQ ? 'max' : '');
    return { kind, verb: verb ? verb[1] : '', dir, explicit: /\b(?:limits?|maximum|minimum|max|min|cap|capped|at\s+most|at\s+least|longest|shortest|highest|lowest|biggest|largest|smallest|most|least|deadline)\b/.test(t) };
}

// ---------------------------------------------------------------- 2. the reply
const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"“(\[])|\n+/;
const DISCLAIM_RE = /\b(?:i\s+(?:do\s*n[o']t|don't|cannot|can't|am\s+not|'m\s+not)\s+(?:have|know|see|find|sure|certain|able|provide|confirm|want)|i'?m\s+not\s+(?:sure|certain)|not\s+sure|(?:isn't|is\s+not|not)\s+in\s+the\s+nextastore\s+guides|connect\s+you\s+with\s+a\s+human|no\s+information)\b/i;
const YESNO_START_RE = /^\s*(?:yes|yeah|yep|yup|sure|absolutely|certainly|definitely|of\s+course|correct|indeed|right|no|nope|nah|unfortunately|sadly|not|never)\b/i;
const MODAL_RE = /\b(?:you|sellers?|buyers?|shoppers?|customers?|stores?|users?|people|anyone|everyone)\s+(?:can|cannot|can't|could|may|are\s+able\s+to|are\s+allowed\s+to|aren't\s+allowed\s+to|are\s+not\s+allowed\s+to|will\s+be\s+able\s+to|won't\s+be\s+able\s+to|don't\s+need\s+to|do\s+not\s+need\s+to|do\s+not\s+have\s+to|don't\s+have\s+to)\b/i;
const EXIST_RE = /\b(?:there\s+(?:is|are|isn't|aren't|is\s+no|are\s+no|'s\s+no)|(?:nextastore|we|it|the\s+(?:platform|site|app|store))\s+(?:does|do|doesn't|don't|did\s+not|does\s+not|has|have|offers?|provides?|supports?|allows?|accepts?|charges?|takes?|delivers?|ships?|sells?|gives?|requires?|verifies|checks?|holds?|keeps?)|(?:is|are)\s+(?:free|available|allowed|possible|supported|offered|included|required|safe|secure|protected|not\s+(?:available|allowed|possible|supported|offered|included|required|free|safe)))\b/i;
const LOCATION_A_RE = /\b(?:located|based|headquartered|situated|office\s+is|offices\s+are|you\s+can\s+visit|visit\s+(?:us|our))\b/i;

const CRITICAL = new Set(['not', 'no', 'never', 'cannot', 'cant', 'dont', 'doesnt', 'isnt', 'arent', 'wont', 'only', 'free', 'without', 'any', 'every', 'all', 'unlimited', 'must', 'always', 'none', 'nothing', 'refundable', 'automatically']);
const wordsOf = (t) => String(t || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
/** Is this sentence of the reply the guides' own sentence (copied, or all but a word or two)? Words the guides wrote are not an invented "yes". */
function isFromContext(sentence, units) {
    const w = wordsOf(sentence);
    if (w.length < 4) return false;
    const key = w.join(' ');
    for (const u of units) {
        const uw = wordsOf(String(u)); const uk = uw.join(' ');
        if (uk.includes(key)) return true;
        if (uw.length >= 4) {
            const set = new Set(uw); const hit = w.filter((x) => set.has(x)).length;
            // a near-copy may differ by a word or two, but never in a figure, a negation or an absolute ("only", "never", "free", "any"): that is where a changed meaning hides
            const crit = (arr) => new Set(arr.filter((x) => /^\d+$/.test(x) || CRITICAL.has(x)));
            const cw = crit(w); const cu = crit(uw);
            const same = [...cw].every((x) => cu.has(x)) && [...cu].every((x) => cw.has(x));
            if (same && hit / w.length >= 0.85 && hit / uw.length >= 0.6) return true;
        }
    }
    return false;
}

/** Sentences of `reply` that assert something (yes / no / "you can ..." / "there is no ..." / a figure). */
function assertionsOf(reply, { figures = true } = {}) {
    const out = [];
    for (let s of String(reply || '').replace(/\r/g, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').split(SENT_SPLIT)) {
        s = s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
        if (!s || /\?\s*$/.test(s) || DISCLAIM_RE.test(s)) continue;
        // a markdown link or a bare path is not an assertion
        const plain = s.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/(?:^|\s)\/[a-z0-9\-_/]+/gi, ' ');
        const hasFigure = figures && (/\d/.test(plain) || require('./claims').figuresOf(plain).size > 0);
        if (YESNO_START_RE.test(plain) || MODAL_RE.test(plain) || EXIST_RE.test(plain) || LOCATION_A_RE.test(plain) || hasFigure) out.push(s);
    }
    return out;
}

// ---------------------------------------------------------------- 3. the support
// Generic words that are never "the object" even when the guides do not use them.
const GENERIC = new Set(('thing things kind kinds type types way ways amount amounts number numbers mine own else extra different other another same new old big small ' +
    'long short high low good bad best better great second hand time times day days week weeks month months year years hour hours minute minutes today now ' +
    'one two three four five six seven eight nine ten hundred thousand first last next more less few lot lots part full whole ' +
    'nextastore nexta platform site website app application online here there anything something everything someone anyone ' +
    'offer give provide have get become accept take stock allow able possible available use used want find live exist any ' +
    'maximum minimum max min limit limits cap most least highest lowest longest shortest biggest largest smallest much many ' +
    'also just really actually already still even ever never always often usually normally mostly maybe please ' +
    'through via over under between within without into onto upon toward towards across along around against among per than keep keeps kept save saves look looks looking put puts ' +
    'check checks show shows let lets try tries add adds read reads write writes call calls hold holds run runs ' +
    'multi several hear hears heard know knows learn notice noticed passed passes passing twice once thrice told tell used uses using happen happens happened took takes taking making made makes going gone come comes came ' +
    'out off up down away back again ahead already ever even only own such very quite ' +
    'itself myself yourself themselves himself herself ourselves anyway whatever whenever however instead rather quite pretty sometimes anymore yet soon later after before while during').split(/\s+/));
const TIME_UNIT_RE = /^(?:hours?|minutes?|mins?|days?|weeks?|months?|years?|seconds?)$/;
const NUMBERISH = new Set('a an one two three four five six seven eight nine ten twelve twenty thirty forty fifty sixty ninety hundred half several few'.split(' '));
// tight synonyms (retrieval has a much looser list; support must be strict)
const TIGHT = {
    shop: 'store', shops: 'store', stores: 'store', stall: 'store', vendor: 'seller', vendors: 'seller', merchant: 'seller', merchants: 'seller', trader: 'seller',
    customer: 'buyer', customers: 'buyer', client: 'buyer', clients: 'buyer', shopper: 'buyer', shoppers: 'buyer',
    item: 'product', items: 'product', goods: 'product', listing: 'product', listings: 'product', things: 'product',
    money: 'payment', phone: 'mobile', mtn: 'momo', cellphone: 'mobile', email: 'email', mail: 'email', pics: 'image', pic: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', images: 'image',
    visa: 'card', mastercard: 'card', debit: 'card', credit: 'card', atm: 'card', airtel: 'airtel', momo: 'momo',
    otp: 'code codes onetime', pin: 'code codes', mobile: 'phone', purchase: 'order buy', purchases: 'order buy', bought: 'order buy', buy: 'order purchase', return: 'refund cancel',
    confirm: 'processing confirmed', confirmed: 'processing confirm', confirming: 'processing confirm', confirms: 'processing confirm',
    verification: 'verified verify', verify: 'verified verification', verified: 'verify verification', cancellation: 'cancel', cancelled: 'cancel', delivery: 'deliver', delivered: 'delivery', delivering: 'delivery', registration: 'register signup', checkout: 'order buyer cart', location: 'address district', locations: 'address district', directions: 'directions address', pass: 'coverage', subscription: 'coverage', plan: 'coverage', installable: 'install', installed: 'install', screen: 'homescreen', home: 'homescreen',
    secure: 'safe', protected: 'safe', safety: 'safe', pickup: 'pickup', collect: 'pickup', collection: 'pickup',
    cheat: 'scam', cheated: 'scam', scammed: 'scam', fraud: 'scam', disappears: 'disappear', vanish: 'disappear', vanished: 'disappear',
};
// verbs whose meaning the supporting sentence must carry (stems of acceptable forms)
const VERB_GROUPS = {
    pay: ['pay', 'paid', 'payment', 'method', 'accept', 'mobile', 'momo', 'checkout', 'send'],
    sell: ['sell', 'sold', 'list', 'product', 'listing', 'add'],
    cancel: ['cancel', 'cancellation', 'cancelled'],
    deliver: ['deliver', 'delivery', 'delivered', 'ship', 'shipped', 'pickup'],
    ship: ['deliver', 'delivery', 'ship', 'shipped', 'pickup'],
    refund: ['refund', 'refundable', 'refunded', 'money back'],
    withdraw: ['withdraw', 'withdrawal', 'payout', 'cash out'],
    upload: ['upload', 'add', 'image', 'photo', 'picture', 'logo', 'banner'],
    change: ['change', 'edit', 'update', 'rename'],
    edit: ['change', 'edit', 'update'],
    delete: ['delete', 'remove', 'deleted'],
    contact: ['contact', 'email', 'message', 'support', 'whatsapp', 'reach'],
    log: ['log', 'sign', 'login', 'logout', 'session'],
    follow: ['follow', 'follower', 'following'],
    message: ['message', 'messages', 'messaging', 'chat'],
    verify: ['verify', 'verified', 'verification'],
    renew: ['renew', 'renewal', 'renews', 'extend', 'automatically'],
    track: ['track', 'status', 'orders'],
};
// every inflection of a verb we know -> its group key
const VERB_KEY = (() => { const m = {}; const add = (k, forms) => forms.forEach((f) => { m[f] = k; }); 
    add('pay', ['pay', 'paying', 'paid', 'pays']); add('sell', ['sell', 'selling', 'sold', 'sells']); add('cancel', ['cancel', 'canceling', 'cancelling', 'cancelled', 'canceled']);
    add('deliver', ['deliver', 'delivers', 'delivering']); add('ship', ['ship', 'ships', 'shipping']); add('refund', ['refund', 'refunds', 'refunded']); add('withdraw', ['withdraw', 'withdrawing', 'withdrawn']);
    add('upload', ['upload', 'uploading']); add('change', ['change', 'changing']); add('edit', ['edit', 'editing']); add('delete', ['delete', 'deleting']); add('contact', ['contact', 'contacting']);
    add('follow', ['follow', 'following']); add('message', ['message', 'messaging']); add('verify', ['verify', 'verifies', 'verified']); add('renew', ['renew', 'renews', 'renewing']); add('track', ['track', 'tracking']); return m; })();
const GENERIC_VERBS = new Set(['have', 'has', 'get', 'got', 'be', 'do', 'make', 'use', 'offer', 'give', 'provide', 'take', 'need', 'see', 'find', 'put', 'open', 'start', 'become', 'join', 'allow', 'support', 'work', 'go', 'live', 'accept', 'stock', 'tell', 'know', 'also', 'just']);
const FEE_LEX = new Set(['fee', 'cost', 'price', 'charg', 'commission', 'free', 'ugx', 'rate', 'tax', 'refund', 'nothing', 'costs', 'priced', 'pric']);
const LIMIT_LEX = new Set(['limit', 'maximum', 'minimum', 'max', 'min', 'cap', 'most', 'least', 'only', 'within', 'block', 'blocks', 'least', 'up', 'longest', 'shortest', 'mos', 'lea', 'least', 'hour', 'minut', 'day', 'week', 'month', 'year', 'old', 'age', 'long', 'before', 'after', 'until', 'number']);
const SAFETY_LEX = new Set(['safe', 'secure', 'protect', 'cover', 'insur', 'hold', 'process', 'scam', 'caution', 'careful', 'risk']);
const LOCATION_LEX = new Set(['located', 'office', 'address', 'based', 'visit', 'district', 'town', 'area', 'country', 'city', 'kampala', 'uganda', 'location', 'headquarter', 'warehouse']);
const DAY_FIGURE_RE = /\d/;

const EXPLICIT_LIMIT = new Set(['limit', 'maximum', 'minimum', 'max', 'min', 'cap', 'capped', 'most', 'least', 'only', 'within', 'block', 'blocks', 'upto', 'longest', 'shortest', 'deadline', 'exceed', 'allowed', 'per']);
const MIN_LIMIT = new Set(['minimum', 'min', 'least', 'shortest', 'smallest', 'lowest', 'fewest', 'atleast']);
const MAX_LIMIT = new Set(['maximum', 'max', 'most', 'longest', 'largest', 'biggest', 'highest', 'cap', 'capped', 'upto', 'limit', 'block', 'blocks', 'exceed', 'atmost']);
const NUMBER_WORDS = new Set('one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty ninety hundred thousand once twice'.split(' '));
const NEAR = 6;

/** Is a predicate word (fee word, limit word or figure) within NEAR words of a word of the question's object? */
function nearObject(unit, groups, isPredicate) {
    const words = String(unit).toLowerCase().replace(/[’']/g, "'").split(/[^a-z0-9']+/).filter(Boolean);
    const keys = words.map(keysOf);
    const objPos = []; const predPos = [];
    words.forEach((w, i) => {
        if (groups.some((g) => [...g.alts].some((a) => keys[i].has(a)))) objPos.push(i);
        if (isPredicate(w, keys[i])) predPos.push(i);
        if (w === 'up' && words[i + 1] === 'to') predPos.push(i);
    });
    // a question with no usable object word (all words generic) only needs the predicate in the sentence
    if (!groups.length) return predPos.length > 0;
    return objPos.some((o) => predPos.some((q) => Math.abs(o - q) <= NEAR));
}

const cache = { stamp: null, units: null, ctx: null };

function loadIndex() {
    try { const st = require('../rag/retrieve').ensureFresh(); return st; } catch (e) { return null; }
}

/** Sentence units of `contextText`: hard-wrapped lines are re-joined into paragraphs, bullets stay separate. */
function sentenceUnits(contextText) {
    const raw = String(contextText || '').replace(/\r/g, '').split('\n');
    const blocks = []; let cur = '';
    const flush = () => { if (cur.trim()) blocks.push(cur.trim()); cur = ''; };
    for (const line of raw) {
        if (/^\s*$/.test(line) || /^#{1,6}\s/.test(line)) { flush(); continue; }
        if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) { flush(); cur = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''); flush(); continue; }
        cur += (cur ? ' ' : '') + line.trim();
    }
    flush();
    const units = [];
    for (const b of blocks) {
        let prev = '';
        for (const s of b.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(*])/)) {
            const t = s.trim(); if (t.length <= 3) continue;
            // a sentence that opens with a pronoun (or "a / the link") talks about what the sentence before named
            const u = new String(t); u.prev = /^(?:it|they|this|that|these|those|its|their|(?:a|the)\s+(?:link|email|page|window|button|reply|message))\b/i.test(t) ? prev : '';
            units.push(u); prev = t;
        }
    }
    return units;
}

/** Plain inflection removal (buying -> buy, cars -> car, but care stays care). */
function lemma(w) {
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(?:ed|es)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
    return w;
}
/** Match keys of one word. A stem of 3 letters or fewer collides across different words (cars / care -> "car"), so it is replaced by the word with a plain plural removed. */
function keysOf(w) {
    const keys = new Set([w]);
    const st = stem(w);
    keys.add(st.length >= 4 ? st : lemma(w));
    if (TIGHT[w]) for (const alt of TIGHT[w].split(' ')) keys.add(alt);
    if (/ly$/.test(w) && w.length > 5) keys.add(stem(w.slice(0, -2)));
    return keys;
}
const KEY_CACHE = new Map();   // the same guide sentences come back on every turn: their match keys are computed once
function stemsOf(text) {
    const hit = KEY_CACHE.get(text);
    if (hit) return hit;
    const set = stemsOfUncached(text);
    if (KEY_CACHE.size > 3000) KEY_CACHE.clear();
    KEY_CACHE.set(text, set);
    return set;
}
function stemsOfUncached(text) {
    const { joinPhrases } = require('../rag/normalise');
    const set = new Set();
    for (const w of rawTokens(joinPhrases(text))) for (const k of keysOf(w)) set.add(k);
    for (const w of rawTokens(text)) for (const k of keysOf(w)) set.add(k);
    return set;
}

/** The question's object groups: [{word, alts:Set(stem), idf, required, optional}] and the predicate to look for. */
function analyseQuestion(question, shape, st, foreign = false) {
    const { normalise } = require('../rag/normalise');
    const { rewriteQuery } = require('../rag/retrieve');
    const bm = st && st.bm25;
    const norm = normalise(rewriteQuery(String(question || '')), { vocab: st ? st.vocab : new Map() });
    const lex = st && st.lexicon;
    const unknownIdf = bm ? Math.log(1 + (bm.n + 0.5) / 0.5) : 4.5;
    // the index stores real stems; a match key may be the plain word (short stems), so look up both
    const dfOf = (t) => (bm ? Math.max(bm.df.get(t) || 0, bm.df.get(stem(t)) || 0) : 0);
    const idfOf = (t) => (dfOf(t) > 0 ? bm.idf(bm.df.get(t) ? t : stem(t)) : unknownIdf);
    const known = (t) => dfOf(t) > 0;
    // Luganda glues clitics with apostrophes (n'ensimbi, by'obusuubuzi): split them so the lexicon can see each word
    const toks = foreign ? String(question || '').toLowerCase().split(/[^a-zŋ0-9]+/).filter(Boolean) : norm.tokens;
    const groups = [];
    for (let i = 0; i < toks.length; i++) {
        const w = toks[i];
        if (STOPWORDS.has(w) || GENERIC.has(w) || /^\d+$/.test(w) || (foreign && (LG_FUNCTION.has(w) || w.length <= 3))) continue;
        // a span of time attached to a number or an article ("an hour", "30 days", "one month") is a value being asked about, not the object
        if (TIME_UNIT_RE.test(w) && i > 0 && (NUMBERISH.has(toks[i - 1]) || /^\d+$/.test(toks[i - 1]))) continue;
        if (VERB_KEY[w] || GENERIC_VERBS.has(w) || (shape.verb && w === shape.verb && VERB_GROUPS[w] === undefined && GENERIC_VERBS.has(w))) continue;
        // the framing words of fee / limit questions are the predicate, not the object
        if (shape.kind === 'fee' && FEE_LEX.has(stem(w))) continue;
        if (shape.kind === 'limit' && (LIMIT_LEX.has(stem(w)) || LIMIT_LEX.has(w)) && !known(stem(w) === w ? w : stem(w)) ) continue;
        const own = keysOf(w);
        // Luganda / Swahili words contribute their English expansions; an unknown foreign word is ignored (it cannot be judged)
        const expansion = lex && lex.get && lex.get(w);
        if (expansion) { for (const e of rawTokens(expansion)) { if (!STOPWORDS.has(e)) own.add(stem(e)); } }
        const idf = Math.max(...[...own].map(idfOf));
        const anyKnown = [...own].some(known);
        groups.push({ word: w, alts: own, idf: anyKnown ? Math.max(...[...own].filter(known).map(idfOf)) : idf, unknown: !anyKnown });
    }
    return { groups, tokens: toks };
}

const RARE_IDF = 2.5;   // idf of a word found in about 7 of the 86 guide sections or fewer: such a word must be in the supporting sentence
const COVER_MIN = 0.7;  // and the question's words found in the sentence must carry at least this share of the total idf weight

/**
 * Is there ONE sentence of the context that has the question's object and a predicate that fits?
 * @returns {{supported: boolean, why: string, unit?: string}}
 */
function findSupport(question, shape, contextText, { st = loadIndex(), foreign = false } = {}) {
    const units = sentenceUnits(contextText);
    const { groups, tokens } = analyseQuestion(question, shape, st, foreign);
    // a foreign (Luganda) question whose words are not in the lexicon cannot be judged: unknown words are not "absent" evidence
    // A Luganda question we can only partly read: when it holds words the lexicon cannot map and the guides never use, the guard cannot tell what is being asked, so an
    // asserting reply is not allowed through (the same fail-closed rule as the rest of the Luganda path: handoff, never a guess).
    const unreadable = foreign ? groups.filter((g) => g.unknown && g.word.length >= 5).map((g) => g.word) : [];
    if (unreadable.length) return { supported: false, why: `Luganda words the guard cannot check: ${unreadable.join(', ')}` };
    const usable = groups.filter((g) => !(foreign && g.unknown));
    const required = usable.filter((g) => g.unknown || g.idf >= RARE_IDF);
    const total = usable.reduce((a, g) => a + g.idf, 0);
    const verbKey = (() => { for (const w of tokens) { const k = VERB_KEY[w]; if (k) return k; } return ''; })();
    let best = null;
    for (const unit of units) {
        const have = stemsOf(String(unit) + (unit.prev ? ' ' + unit.prev : ''));
        const lower = String(unit).toLowerCase();
        if (!required.every((g) => [...g.alts].some((a) => have.has(a)))) continue;
        const got = usable.reduce((a, g) => a + ([...g.alts].some((x) => have.has(x)) ? g.idf : 0), 0);
        if (total > 0 && got / total < COVER_MIN) continue;
        // predicate
        let ok = true;
        if (shape.kind === 'fee') ok = nearObject(String(unit), usable, (w, k) => [...k].some((x) => FEE_LEX.has(x)) || w === 'ugx' || /\d/.test(w) && false);
        else if (shape.kind === 'limit') ok = nearObject(String(unit), usable, shape.dir
            ? (w, k) => [...k].some((x) => (shape.dir === 'min' ? MIN_LIMIT : MAX_LIMIT).has(x))
            : shape.explicit
            ? (w, k) => [...k].some((x) => EXPLICIT_LIMIT.has(x))
            : (w, k) => /\d/.test(w) || NUMBER_WORDS.has(w) || [...k].some((x) => EXPLICIT_LIMIT.has(x)));
        else if (shape.kind === 'safety') ok = [...have].some((x) => SAFETY_LEX.has(x));
        else if (shape.kind === 'location') ok = [...have].some((x) => LOCATION_LEX.has(x));
        else if (verbKey) ok = VERB_GROUPS[verbKey].some((v) => have.has(stem(v)) || have.has(v));
        if (!ok) continue;
        best = { supported: true, why: 'sentence', unit: String(unit) };
        break;
    }
    if (best) return best;
    const missing = required.filter((g) => !units.some((u) => { const h = stemsOf(String(u) + (u.prev ? ' ' + u.prev : '')); return [...g.alts].some((a) => h.has(a)); })).map((g) => g.word);
    return { supported: false, why: missing.length ? `object not in the guides: ${missing.join(', ')}` : 'no sentence with the object and a matching predicate' };
}

const NOT_IN_GUIDES = "I don't have that in the NextaStore guides, and I don't want to guess.";

/**
 * @param {{question: string, reply: string, contextText: string, foreign?: boolean}} args
 * @returns {{applies: boolean, ok: boolean, kind?: string, why?: string, assertion?: string}}
 */
function clausesOf(question) {
    const parts = String(question || '').split(/\s+(?:and|also|plus|but)\s+|\s*[,;?&]\s*/i).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 3);
    return parts.length > 1 ? parts : [String(question || '')];
}

function checkAssertion({ question, reply, contextText, foreign = false }) {
    const whole = questionShape(foreign ? foreignQuestionText(question) : normalisedText(question), question);
    // "how long is the free trial and is seller pass refundable": every clause that asks for a fact needs its own support
    const clauses = clausesOf(question).map((c) => ({ c, shape: questionShape(foreign ? foreignQuestionText(c) : normalisedText(c), c) })).filter((x) => x.shape);
    const parts = clauses.length > 1 ? clauses : (whole ? [{ c: question, shape: whole }] : []);
    if (!parts.length) return { applies: false, ok: true };
    // only the model's OWN assertions are judged: a sentence taken from the guides (the extractive answer, a quoted rule) cannot be an invented yes
    const units = sentenceUnits(contextText);
    const asserted = assertionsOf(reply).filter((a) => !isFromContext(a, units));
    if (!asserted.length) return { applies: false, ok: true, kind: parts[0].shape.kind };
    let support = null; let shape = parts[0].shape;
    for (const part of parts) { support = findSupport(part.c, part.shape, contextText, { foreign }); shape = part.shape; if (!support.supported) break; }
    return { applies: true, ok: support.supported, kind: shape.kind, why: support.why, assertion: asserted[0], unit: support.unit };
}

function normalisedText(question) {
    try { const st = loadIndex(); const { normalise } = require('../rag/normalise'); const { rewriteQuery } = require('../rag/retrieve'); return normalise(rewriteQuery(String(question || '')), { vocab: st ? st.vocab : new Map() }).tokens.join(' '); } catch (e) { return String(question || ''); }
}

// Luganda function words and question cues that carry no object (DRAFT, not yet reviewed by a Luganda speaker)
const LG_FUNCTION = new Set('nsobola osobola asobola basobola nnyinza oyinza waliwo ewali mulina olina alina balina kisoboka kiri nti ku mu ne na eri nga bwe ate oba era ki ani lwaki ddi wa mmeka kyenkana eza ya wa za bya by obwa ogwa ekya eky omu ekimu ssente yange yo ye bo ffe mmwe'.split(' '));
// DRAFT Luganda question cues (not yet reviewed by a Luganda speaker). They only ever make the guard stricter (a handoff), never looser.
const LG_POLARITY = /\b(?:nsobola|osobola|asobola|basobola|nnyinza|oyinza|waliwo|ewali|mulina|olina|alina|balina|kisoboka|kiri)\b/;
const LG_HOWTO = /\b(?:ntya|otya|batya|kitya)\b/;
function foreignQuestionText(question) {
    const t = String(question || '').toLowerCase();
    if (LG_HOWTO.test(t)) return '';                      // "how can I ...": a how-to, never gated
    if (LG_POLARITY.test(t) || /\?\s*$/.test(t.trim())) return 'can i ' + t;
    return '';
}

module.exports = { checkAssertion, questionShape, assertionsOf, findSupport, sentenceUnits, NOT_IN_GUIDES, analyseQuestion };
