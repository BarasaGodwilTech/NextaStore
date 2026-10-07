/**
 * Relevance + safety flagging for Nexi (WIP 55).
 *
 * Nexi is a guide for buying, selling and starting a small business on NextaStore.
 * This module decides, BEFORE the model is called, whether a message is clearly outside
 * that job, and flags it. It is deliberately cheap (no model, no network, microseconds)
 * and deliberately CONSERVATIVE: a message is only flagged when it clearly belongs to
 * another topic and has no NextaStore / shopping / selling vocabulary in it. Anything
 * unclear is let through to the model, which has its own [OFF_TOPIC] marker rule
 * (see systemPrompt.js and pipeline.js) as a second net.
 *
 * Flag types
 *   off_topic      - homework, coding, politics, sport, celebrities, medical/legal advice, jokes ...
 *   inappropriate  - abusive, sexual or hateful language aimed at Nexi or others
 *   sensitive      - the person is SHARING a password, OTP/PIN or a card number
 *   manipulation   - trying to override Nexi's instructions / reveal its prompt
 *   unclear        - keyboard mashing / no readable words
 * "Hard" flags (everything except off_topic) are never overridden by NextaStore words.
 *
 * Conversation flag: when 3 or more of the last 5 questions (including this one) are flagged,
 * the whole conversation is marked as drifting. The server is stateless, so it re-classifies
 * the user turns the browser sends back as history.
 */

const FLAG_TYPES = ['off_topic', 'inappropriate', 'sensitive', 'manipulation', 'unclear'];
const DRIFT_WINDOW = 5;
const DRIFT_THRESHOLD = 3;

function tokens(text) {
    return (String(text || '').toLowerCase().match(/[a-zŋ0-9']+/g) || []);
}
function normalise(text) {
    return ` ${String(text || '').toLowerCase().replace(/[^a-zŋ0-9'\s]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

// ---- NextaStore / shopping / selling vocabulary (English + Luganda) ----
const ON_TOPIC_TOKEN = new RegExp('^(?:' + [
    'nextastore', 'nextastores', 'nexta', 'nexi',
    'stores?', 'shops?', 'shopping', 'shopper', 'shoppers', 'seller', 'sellers', 'selling', 'sell', 'sold', 'sale', 'sales',
    'buy', 'buyer', 'buyers', 'buying', 'bought', 'purchase', 'purchases',
    'orders?', 'ordered', 'ordering', 'cart', 'checkout', 'products?', 'listings?', 'listed', 'items?',
    'price', 'prices', 'pricing', 'priced', 'cheap', 'afford(?:able)?', 'cost', 'costs',
    'pay', 'paid', 'payment', 'payments', 'paying', 'momo', 'mtn', 'airtel', 'ugx', 'shs', 'money',
    'deliver(?:y|ies|ed|ing)?', 'boda', 'courier', 'customers?', 'clients?', 'business(?:es)?', 'enterprise',
    'market', 'marketing', 'marketplace', 'brand', 'branding', 'profit', 'profits', 'income', 'earn', 'earning', 'earnings',
    'stock', 'inventory', 'photos?', 'photograph(?:s|y)?', 'pictures?', 'description', 'descriptions',
    'whatsapp', 'instagram', 'facebook', 'tiktok', 'subscription', 'subscribe', 'trial',
    'account', 'login', 'signup', 'register', 'verify', 'verified', 'verification', 'badge', 'badges',
    'refund', 'refunds', 'scam', 'scams', 'scammer', 'fraud', 'fraudster', 'trust', 'trusted', 'trustworthy', 'legit', 'safe', 'safely', 'safety',
    'follow', 'followers', 'following', 'favou?rites?', 'wishlist', 'message', 'messages', 'messaging', 'chat',
    'discount', 'discounts', 'promo', 'promotion', 'promotions', 'budget', 'startup', 'hustle', 'entrepreneur', 'entrepreneurs',
    'gift', 'gifts', 'wholesale', 'retail', 'supplier', 'suppliers', 'packag(?:e|es|ing)', 'shipping', 'shipment',
    'clothes', 'clothing', 'shoes', 'fashion', 'food', 'electronics', 'phones?', 'furniture', 'jewel(?:l)?ery', 'crafts?', 'handmade',
    // Luganda
    'edduuka', 'amaduuka', 'duuka', 'okutunda', 'tunda', 'ntunde', 'omutunzi', 'abatunzi', 'okugula', 'gula', 'omuguzi', 'abaguzi',
    'bbeeyi', 'ebbeeyi', 'ssente', 'sente', 'ensimbi', 'okusasula', 'sasula', 'bakasitoma', 'kasitoma', 'obusuubuzi', 'musuubuzi', 'abasuubuzi',
    'ebintu', 'ekintu', 'ebifaananyi', 'ekifaananyi', 'okutandika', 'nkyatandika', 'akatale', 'ebirowoozo', 'okuweereza', 'okutuusa', 'ekiragiro', 'ebiragiro',
].join('|') + ')$');
const ON_TOPIC_PHRASE = /\b(?:seller pass|mobile money|small business|side hustle|first store|open a store|start selling|make money selling)\b/;

// ---- Clearly another topic (soft: any NextaStore word overrides) ----
const OFF_TOPIC_PATTERNS = [
    // coding / tech homework
    /\b(?:python|javascript|typescript|java|c\+\+|c#|php|html|css|sql|react|node\.?js|regex|algorithm|compile[rd]?|debug(?:ging)?|stack ?overflow|leetcode)\b/,
    /\bwrite (?:me )?(?:a |an |some )?(?:code|script|program|function|essay|poem|story|song|speech|letter|joke|cover letter)\b/,
    // school / general knowledge
    /\b(?:homework|assignment|exam questions?|essay|equation|derivative|integral|calculus|algebra|geometry|trigonometry|chemistry|physics|biology|photosynthesis|periodic table|solve (?:this|the)|what is \d+ ?[+\-*/x×÷] ?\d+)\b/,
    /\b(?:capital (?:city )?of|who (?:is|was) the (?:president|prime minister|king|queen)|when was .* (?:born|founded|invented)|history of|meaning of life|how many (?:planets|continents|countries))\b/,
    /\btranslate (?:this|the|my|these) (?:text|document|paragraph|sentence|article|letter|essay)\b/,
    /\bsummari[sz]e (?:this|the) (?:article|text|book|chapter|paragraph|document)\b/,
    // politics / religion
    /\b(?:election|elections|vote for|voting for|parliament|politic(?:s|al|ian|ians)|museveni|bobi ?wine|trump|biden|putin|nrm|ndc|nup|campaign rally|government corruption|is god real|existence of god|which religion)\b/,
    // sport / entertainment / celebrities
    /\b(?:football|soccer|premier league|champions league|la liga|arsenal|chelsea|liverpool|man(?:chester)? (?:united|city)|world cup|match (?:result|results|score|scores)|live score|fixtures|basketball|nba|cricket|boxing|ufc|celebrity|celebrities|kardashian|beyonc[eé]|netflix|movie|movies|tv show|series finale|song lyrics|lyrics|music video|bongo flava|gossip)\b/,
    // medical / legal / relationships / astrology
    /\b(?:symptoms?|diagnos(?:e|is)|medicine for|cure for|how to cure|am i pregnant|pregnancy test|hiv|malaria|cancer|diabetes|blood pressure|prescription|dosage|sue (?:someone|him|her|them)|lawyer|divorce|custody|court case|girlfriend|boyfriend|dating advice|crush|horoscope|zodiac|astrology|my ex)\b/,
    // everyday trivia
    /\b(?:weather|forecast|news today|latest news|breaking news|bitcoin|crypto(?:currency)?|forex|stock market|lottery|betting|sportybet|bet9ja|tell me a joke|riddle|recipe for|how to cook|bible verse|quran verse)\b/,
];

const OFF_TOPIC_GLOBAL = OFF_TOPIC_PATTERNS.map((re) => new RegExp(re.source, 'g'));

// ---- Hard flags: never overridden ----
const INAPPROPRIATE = /\b(?:fuck(?:ing|er)?|shit|bitch(?:es)?|bastard|asshole|dickhead|motherfucker|cunt|pussy|slut|whore|retard(?:ed)?|you(?:'re| are) (?:so )?(?:stupid|useless|an idiot|a moron|dumb|trash|garbage)|shut up|idiot|moron|nigga|nigger|porn|sex ?(?:chat|video|videos|tape|story)|send nudes|malaaya|kuma)\b/;
const MANIPULATION = [
    /\bignore (?:all |any |your |the |previous |prior |above |earlier )*(?:instructions?|prompts?|rules|guidelines)\b/,
    /\b(?:disregard|forget) (?:all |your |the |previous |prior )*(?:instructions?|rules|guidelines|training)\b/,
    /\b(?:reveal|show|print|repeat|tell me|give me|leak) (?:me )?(?:your |the )?(?:system |hidden |initial |secret )?(?:prompt|instructions|rules)\b/,
    /\bsystem prompt\b/,
    /\b(?:jailbreak|developer mode|dan mode|do anything now|unrestricted mode|no restrictions)\b/,
    /\b(?:you are now|from now on you are|pretend (?:to be|you are)|act as if you (?:are|have)) (?:an? )?(?!seller|shopper|buyer|customer)/,
];
// Sharing (not asking about) credentials: "my password is hunter2", "OTP: 482913", a 13-19 digit card number.
const SENSITIVE_SHARING = [
    /\b(?:my |the |our )?(?:password|passcode|pin|otp|cvv|cvc|secret code|verification code)\s*(?:is|was|=|:)\s*\S{3,}/,
    /\b(?:otp|pin|cvv|cvc|verification code|secret code)\s*[:=]?\s*\d{4,8}\b/,
    /\b(?:\d[ -]?){13,19}\b/,
];

function hasOnTopic(text) {
    // "by'obusuubuzi" / "n'ensimbi": Luganda glues words with apostrophes, so test each piece too.
    const toks = tokens(text).flatMap((t) => (t.includes("'") ? [t, ...t.split(/'+/).filter(Boolean)] : [t]));
    let hits = 0;
    for (const t of toks) if (ON_TOPIC_TOKEN.test(t)) hits += 1;
    if (ON_TOPIC_PHRASE.test(normalise(text))) hits += 1;
    return hits;
}

function looksUnclear(text) {
    const s = String(text || '').trim();
    const letters = (s.match(/[a-zŋ]/gi) || []).length;
    if (letters < 5) return false; // emoji / "ok" / "hi": leave to the model
    const compact = s.toLowerCase().replace(/[^a-zŋ]/g, '');
    if (!/[aeiouy]/.test(compact)) return true;
    if (/(.)\1{5,}/.test(compact)) return true;
    if (/(?:asdf|qwer|zxcv|hjkl|jkl;|sdfg|dfgh|fghj)/.test(compact) && tokens(s).length <= 3) return true;
    const toks = tokens(s);
    if (toks.length === 1 && compact.length >= 9 && !/[aeiouy]{1}.*[aeiouy]{1}/.test(compact)) return true;
    return false;
}

/**
 * Classify ONE message on its own. `contextOnTopic` (bool) means the conversation so far was about
 * NextaStore topics, which lets short follow-ups through.
 * @returns {{type: string|null, reason: string, onTopicHits: number}}
 */
function classifyMessage(message, opts = {}) {
    const text = String(message || '');
    const norm = normalise(text);
    const onTopicHits = hasOnTopic(text);
    const none = (reason = 'ok') => ({ type: null, reason, onTopicHits });

    if (MANIPULATION.some((re) => re.test(norm))) return { type: 'manipulation', reason: 'tries to change Nexi\'s instructions', onTopicHits };
    if (SENSITIVE_SHARING.some((re) => re.test(norm)) && !/\b(?:how|where|can i|should i|forgot|reset|change|recover|lost)\b/.test(norm.slice(0, 40))) {
        return { type: 'sensitive', reason: 'shares a password, PIN/OTP or card number', onTopicHits };
    }
    if (INAPPROPRIATE.test(norm)) return { type: 'inappropriate', reason: 'abusive or sexual language', onTopicHits };
    if (looksUnclear(text)) return { type: 'unclear', reason: 'no readable words', onTopicHits };

    // Words inside the off-topic phrase itself ("stock market", "history of") must not count as NextaStore vocabulary.
    const offHit = OFF_TOPIC_PATTERNS.find((re) => re.test(norm));
    const withoutOff = OFF_TOPIC_GLOBAL.reduce((acc, re) => acc.replace(re, ' '), norm);
    if (offHit && hasOnTopic(withoutOff) === 0) {
        const shortFollowUp = tokens(text).length <= 3;
        if (!(opts.contextOnTopic && shortFollowUp)) return { type: 'off_topic', reason: 'unrelated to NextaStore, buying or selling', onTopicHits };
    }
    return none();
}

function userTurns(history) {
    return (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
}

/**
 * Classify the current message in the light of the conversation.
 * @returns {{type: string|null, reason: string, conversation: boolean, flaggedRecent: number, onTopicHits: number}}
 */
function analyseTurn({ message, history = [] }) {
    const earlier = userTurns(history).slice(-(DRIFT_WINDOW - 1));
    const contextOnTopic = earlier.slice(-2).some((t) => hasOnTopic(t) > 0);
    const current = classifyMessage(message, { contextOnTopic });
    const priorFlags = earlier.filter((t) => classifyMessage(t, {}).type !== null).length;
    const flaggedRecent = priorFlags + (current.type ? 1 : 0);
    return {
        type: current.type,
        reason: current.reason,
        onTopicHits: current.onTopicHits,
        flaggedRecent,
        conversation: Boolean(current.type) && flaggedRecent >= DRIFT_THRESHOLD,
    };
}

const MODEL_MARKER = '[OFF_TOPIC]';
const MARKER_RE = /^\s*\[OFF_TOPIC\]\s*/;
function stripMarker(text) {
    const s = String(text || '');
    return MARKER_RE.test(s) ? { text: s.replace(MARKER_RE, ''), marked: true } : { text: s, marked: false };
}

/**
 * Wraps a token callback so a leading [OFF_TOPIC] marker from the model is removed from the
 * stream (it is never shown). Holds back at most the first few characters.
 */
function markerGate(onToken) {
    let buf = '';
    let decided = false;
    let marked = false;
    const emit = (t) => { if (t && onToken) onToken(t); };
    function decide() {
        decided = true;
        const { text, marked: m } = stripMarker(buf);
        marked = m;
        emit(text);
        buf = '';
    }
    return {
        push(t) {
            if (decided) { emit(t); return; }
            buf += t;
            const lead = buf.replace(/^\s+/, '');
            if (lead.length < MODEL_MARKER.length && MODEL_MARKER.startsWith(lead)) return; // could still become the marker
            decide();
        },
        end() { if (!decided && buf) decide(); },
        get marked() { return marked; },
    };
}

module.exports = { FLAG_TYPES, DRIFT_WINDOW, DRIFT_THRESHOLD, MODEL_MARKER, classifyMessage, analyseTurn, hasOnTopic, stripMarker, markerGate };
