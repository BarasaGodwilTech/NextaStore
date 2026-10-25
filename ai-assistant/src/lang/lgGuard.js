'use strict';
/**
 * Luganda output gate (WIP 92c redesign, dependency-free).
 *
 * Order of trust on a Luganda turn:
 *   1. PROVENANCE first. Text that came from a curated Luganda source is served as-is and is never
 *      blocked by a text heuristic: phrasebook, translation-memory, Luganda canned / small talk, handoff.
 *   2. model + local translator ("model+local"): trusted only when EVERY piece was translated, and
 *      then only an English-LEAK detector (englishLeak) may veto it. There is no "must contain a
 *      Luganda signal word" rule any more, so short or unusual Luganda is not rejected for lacking one.
 *   3. Anything else (faq, link, cards, fallback, clarify, cache, unknown ...) is English by construction
 *      and becomes the Luganda handoff.
 * The handoff text is a DRAFT for Luganda speaker review; keep it text only, never append review metadata.
 */
const { detectLanguage, looksEnglish } = require('./detect');

const LG_HANDOFF = 'Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe. Osobola okwogera n’ekibinja kyaffe ku WhatsApp.';

/** Sources whose text is curated Luganda (or the fixed handoff) and is trusted as-is on a Luganda turn. */
const TRUSTED_SOURCES = new Set(['phrasebook', 'translation-memory', 'smalltalk', 'canned', 'handoff']);

// ---------------------------------------------------------------------------------------------
// English-leak detector
// ---------------------------------------------------------------------------------------------
// Strong evidence: English function words and very common verbs. None of these is an ordinary Luganda
// word ("be", "so", "no", "a", "i", "me", "we" are left out on purpose: they occur in or next to Luganda).
const FUNCTION_WORDS = new Set([
    'the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'yours', 'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might', 'must',
    'for', 'from', 'with', 'without', 'this', 'that', 'these', 'those', 'what', 'how', 'when', 'where', 'which', 'who', 'whom', 'why', 'whose',
    'please', 'sorry', 'thanks', 'thank', 'hello', 'hi', 'welcome', 'okay', 'yes', 'need', 'needs', 'help', 'have', 'has', 'had', 'having',
    'not', 'our', 'ours', 'their', 'they', 'them', 'he', 'she', 'his', 'her', 'its', 'it', 'to', 'of', 'in', 'on', 'at', 'an', 'do', 'does', 'did', 'done',
    'my', 'by', 'or', 'but', 'if', 'as', 'there', 'here', 'about', 'any', 'all', 'some', 'more', 'most', 'than', 'then', 'also', 'just', 'only', 'into',
    'out', 'up', 'down', 'over', 'under', 'after', 'before', 'during', 'between', 'because', 'while', 'until', 'again', 'once', 'every', 'each', 'both',
    'other', 'such', 'own', 'same', 'too', 'very', 'been', 'being', 'am', 'us', 'get', 'got', 'make', 'made', 'use', 'used', 'using', 'going',
    'let', 'want', 'wants', 'see', 'ask', 'try', 'check', 'find', 'give', 'take', 'come', 'know', 'think', 'like', 'look', 'open', 'click', 'tap', 'choose',
    'select', 'enter', 'add', 'set', 'start', 'create', 'sign', 'log', 'pay', 'buy', 'sell', 'send', 'share', 'follow', 'keep', 'stay',
    'first', 'next', 'last', 'new', 'good', 'best', 'safe', 'free', 'easy', 'now', 'today', 'soon', 'within', 'per', 'via',
]);
// Weaker evidence: English domain nouns that Luganda text borrows now and then ("orders", "products").
const CONTENT_WORDS = new Set([
    'refund', 'refunds', 'delivery', 'policy', 'order', 'orders', 'store', 'stores', 'shop', 'shops', 'seller', 'sellers', 'buyer', 'buyers', 'payment', 'payments',
    'account', 'password', 'support', 'contact', 'team', 'human', 'price', 'prices', 'fee', 'fees', 'warranty', 'available', 'product', 'products',
    'login', 'signup', 'customer', 'customers', 'message', 'messages', 'page', 'link', 'button', 'details', 'information', 'question', 'questions',
    'business', 'marketplace', 'badge', 'trial', 'subscription', 'photo', 'photos', 'cart', 'checkout', 'shipping', 'item', 'items', 'money', 'number',
    'name', 'address', 'phone', 'profile', 'settings', 'dashboard', 'listing', 'listings', 'category', 'categories', 'description', 'quality', 'reply',
    'day', 'days', 'week', 'month', 'year', 'time', 'date', 'end', 'ends', 'great', 'goodbye', 'simply', 'online', 'built', 'image', 'images', 'logo', 'banner',
    'school', 'office', 'book', 'books', 'people', 'user', 'users', 'home', 'work', 'works', 'working', 'world', 'world', 'wishing', 'thing', 'things',
]);
// Never evidence either way: brand / UI / protocol terms that stay English inside Luganda text.
const EXEMPT_RE = /\b(?:nexi|nextastore|seller\s+pass|ugx|mtn|airtel|whatsapp|mobile\s+money|e-?mail|otp|pin|sms|ussd|momo|kyc|wi-?fi|app)\b/gi;
const CONTRACTION_RE = /^(?:i|you|we|they|he|she|it|that|there|what|let|don|doesn|didn|can|won|isn|aren|wasn|weren|couldn|wouldn|shouldn|haven|hasn)['’](?:m|re|s|ve|ll|d|t)$/i;

/** Remove everything that must not count: URLs, code, link syntax, quoted UI labels, numbers, brand terms. */
function stripExempt(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
    s = s.replace(/!?\[[^\]\n]{0,120}\]\([^)\n]{0,240}\)/g, ' ');        // markdown links: label and target
    s = s.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ');
    s = s.replace(/(?:^|[\s(])\/[a-z][a-z0-9\-_/]*/gi, ' ');             // bare site paths such as /signup
    s = s.replace(/"[^"\n]{1,60}"|“[^”\n]{1,60}”|«[^»\n]{1,60}»|‘[^’\n]{1,60}’/g, ' '); // quoted UI labels
    s = s.replace(/(^|[\s(])'[^'\n]{1,40}'(?=[\s).,;:!?]|$)/g, '$1 ');   // 'Forgot password' (a quote after a letter is an apostrophe, not a label)
    s = s.replace(/\d+(?:[.,]\d+)*/g, ' ');                              // numbers and amounts
    s = s.replace(EXEMPT_RE, ' ');
    return s;
}

function tokensOf(sentence) {
    return (sentence.toLowerCase().match(/[a-zŋ]+(?:['’][a-zŋ]+)*/g) || []);
}

/**
 * Luganda words are open-syllable: essentially every native word ends in a vowel, while English words
 * mostly end in a consonant. This catches English noun lists ("cases, chargers, earphones, power banks")
 * that contain no function word at all. A few borrowed words ("orders") are tolerated by the ratio.
 */
const CONSONANT_FINAL = /[bcdfghjklmnpqrstvwxz]$/;

/** Score one sentence. Returns { n, f, c, cf, n4, leak }. */
function scoreSentence(sentence) {
    const toks = tokensOf(sentence);
    const n = toks.length;
    let f = 0;
    let c = 0;
    let n4 = 0;
    let cons = 0;
    for (const t of toks) {
        if (t.includes("'") || t.includes('’')) { if (CONTRACTION_RE.test(t)) f += 1; continue; }
        if (FUNCTION_WORDS.has(t)) f += 1; else if (CONTENT_WORDS.has(t)) c += 1;
        if (t.length >= 4) { n4 += 1; if (CONSONANT_FINAL.test(t)) cons += 1; }
    }
    const cf = n4 ? cons / n4 : 0;
    let leak = false;
    if (n >= 4) leak = (f >= 2 && (f + 0.5 * c) / n >= 0.3) || (f >= 1 && (f + c) / n >= 0.5) || (n4 >= 3 && cf >= 0.6);
    else if (n >= 1) leak = (f >= 1 && (f + c) / n >= 0.5) || (c >= 2 && c / n >= 0.66) || (n4 >= 2 && cf >= 0.99 && f + c >= 1);
    return { n, f, c, cf, n4, leak };
}

/**
 * True when the text reads as English: any one sentence (or line) in which English function words dominate.
 * A ratio plus a minimum length, never a single hit; works for replies of one to three words too.
 */
function englishLeak(text) {
    const cleaned = stripExempt(text);
    for (const part of cleaned.split(/[.!?;:\n\r]+|\s[-–—]\s/)) {
        if (!part.trim()) continue;
        if (scoreSentence(part).leak) return true;
    }
    return false;
}
/** Back-compat name: true = no English leak found and the text is not empty. */
function strictTextCheck(text) { return Boolean(String(text || '').trim()) && !englishLeak(text); }

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------
function handoffResult() { return { text: LG_HANDOFF, handoff: { reason: 'language_guard' }, needs_review: true, allowed: false }; }

function gateReply({ lang, source, text, translatedPieces, translatorMode = 'on' }) {
    if (lang !== 'lg') return { text: String(text || ''), handoff: null, allowed: true };
    const t = String(text || '');
    if (!t.trim()) return handoffResult();
    const src = String(source || '').split(':')[0];
    const trusted = TRUSTED_SOURCES.has(src);
    const viaTranslator = src === 'model+local' && translatorMode !== 'off'
        && Array.isArray(translatedPieces) && translatedPieces.length > 0 && translatedPieces.every((x) => x && x.translated === true);
    // Reviewed translation-memory wording is served exactly: when EVERY piece is approved, no heuristic may veto it.
    const allApproved = viaTranslator && translatedPieces.every((x) => x.approved === true);
    if (trusted || allApproved || (viaTranslator && !englishLeak(t))) return { text: t, handoff: null, allowed: true };
    return handoffResult();
}
function ensureLuganda(text, lang, source = 'unknown', opts = {}) { return gateReply({ lang, source, text, ...opts }).text; }

// ---------------------------------------------------------------------------------------------
// Which language is this turn in?
// ---------------------------------------------------------------------------------------------
const EXPLICIT = new Set(['lg', 'en', 'sw']);
function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
/** A clear English sentence: three or more words with at least two English function words (or the usual question openers). */
function clearlyEnglish(message) {
    if (wordCount(message) < 3) return false;
    if (looksEnglish(message)) return true;
    return wordCount(message) >= 4 && /\b(?:the|is|are|what|how|can|could|please|i need|do you|does it)\b/i.test(String(message || ''));
}
function contentOf(m) {
    if (!m || typeof m !== 'object') return '';
    const v = typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : '');
    return v.trim();
}
function roleOf(m) { return m && (m.role || m.type); }

/**
 * Language of a turn. An explicit lang (the visitor's toggle) always wins. Otherwise:
 * a Luganda word -> Luganda; a clear English sentence -> English (so people can switch back);
 * a 1-3 word message follows the previous turn ("yee", "ssente?", "why?"): the previous USER message
 * (history[].content) first, with the chain followed back up to three turns, then the previous assistant reply.
 */
function effectiveLang(lang, message, history = [], depth = 0) {
    if (EXPLICIT.has(lang)) return lang;
    const d = detectLanguage(message);
    if (d.code === 'lg') return 'lg';
    if (clearlyEnglish(message)) return 'en';
    if (wordCount(message) <= 3 && depth < 3 && Array.isArray(history) && history.length) {
        const msg = String(message || '').trim();
        const turns = history.filter((x) => x && (roleOf(x) === 'user' || roleOf(x) === 'assistant'));
        // the client may already include the current message as the last user turn: skip it
        while (turns.length && roleOf(turns[turns.length - 1]) === 'user' && contentOf(turns[turns.length - 1]) === msg) turns.pop();
        let lastUserIdx = -1;
        for (let i = turns.length - 1; i >= 0; i--) if (roleOf(turns[i]) === 'user') { lastUserIdx = i; break; }
        if (lastUserIdx >= 0) {
            const prev = turns[lastUserIdx];
            const prevLang = EXPLICIT.has(prev.lang) ? prev.lang : effectiveLang(undefined, contentOf(prev), turns.slice(0, lastUserIdx), depth + 1);
            if (prevLang === 'lg') return 'lg';
        }
        const lastAssistant = [...turns].reverse().find((x) => roleOf(x) === 'assistant');
        if (lastAssistant) { const a = contentOf(lastAssistant); if (detectLanguage(a).code === 'lg' && !clearlyEnglish(a)) return 'lg'; }
    }
    return d.code;
}

module.exports = { LG_HANDOFF, TRUSTED_SOURCES, effectiveLang, englishLeak, strictTextCheck, scoreSentence, stripExempt, gateReply, ensureLuganda };
