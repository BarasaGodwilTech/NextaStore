'use strict';

const config = require('../config');

// Conservative English-only rules. Keep these small and readable; catalog intent
// must never steal an FAQ, starter, small-talk message, or a vague trigger with no
// clear item/place after it.
const PRODUCT_TRIGGERS = [
    /^show me\s+(.+)$/i,
    /^find\s+(.+)$/i,
    /^(?:i am|i'm)\s+looking for\s+(.+)$/i,
    /^(?:do you have|do you sell)\s+(.+)$/i,
    /^(?:looking for|search(?:ing)? for)\s+(.+)$/i,
];
const STORE_TRIGGERS = [
    /^(?:any|which|what)\s+(?:stores|shops|sellers)\s+(?:that\s+)?sell\s+(.+)$/i,
    /^(?:stores|shops|sellers)\s+in\s+(.+)$/i,
    /^(?:find|show me|list)\s+(?:some\s+)?((?:stores|shops|sellers))(?:\s+in\s+(.+))?$/i,
    /^(?:where can i find)\s+(?:stores|shops|sellers)\s+(?:in\s+)?(.+)$/i,
];
const STORE_WORDS = /\b(?:store|stores|shop|shops|seller|sellers)\b/i;
const SELL_WORD = /\bsell(?:s|ing)?\b/i;
const LEADING_DETERMINERS = /^(?:(?:a|an|the|some|any)\s+){1,2}/i;
const INVALID_QUERY_START = /^(?:to|on|in|with|for|about|how|what|why|when|where|who|which|out|my|our|your|me|i|you|it|is|are|can|do|does|way|help)\b/i;
const BLOCKED_PRODUCT_WORDS = [
    'order', 'orders', 'refund', 'refunds', 'password', 'account', 'cart', 'checkout',
    'payment', 'payments', 'pay', 'delivery', 'shipping', 'support', 'help', 'person',
    'agent', 'app', 'subscription', 'pass', 'message', 'messages', 'chat', 'login',
    'signup', 'verify', 'email', 'whatsapp', 'seller', 'sellers', 'store', 'stores',
    'shop', 'shops', 'job', 'jobs',
];
const FAQ_EXCLUSIONS = [
    /how\s+do\s+i\s+start\s+my\s+first\s+store/i,
    /how\s+do\s+i\s+find\s+a\s+trustworthy\s+seller/i,
    /how\s+can\s+i\s+buy\s+safely\s+on\s+nextastore/i,
    /what\s+should\s+i\s+sell\s+as\s+a\s+beginner/i,
    /business\s+ideas.*small\s+budget/i,
    /how\s+does\s+the\s+seller\s+pass\s+work/i,
];

function cleanQuery(value) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/["'\\<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(LEADING_DETERMINERS, '')
        .trim()
        .slice(0, 60)
        .trim();
}

function validQuery(query, kind) {
    if (query.length < 2) return false;
    const words = query.split(/\s+/);
    if (words.length > 5 || INVALID_QUERY_START.test(query)) return false;
    if (kind === 'products' && BLOCKED_PRODUCT_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(query))) return false;
    return true;
}

function detectCatalogIntent(message) {
    const text = String(message || '').trim();
    if (!text || /[^\x00-\x7F]/.test(text)) return null;
    if (FAQ_EXCLUSIONS.some((re) => re.test(text))) return null;

    for (const re of STORE_TRIGGERS) {
        const m = text.match(re);
        if (m) {
            const raw = m[2] || m[1] || '';
            let q = cleanQuery(raw);
            if (/^(?:store|stores|shop|shops|seller|sellers)$/i.test(q)) q = '';
            if (!q && /^(?:find|show me|list)\s+(?:some\s+)?(?:stores|shops|sellers)$/i.test(text)) return { kind: 'stores', query: '' };
            if (q && validQuery(q, 'stores')) return { kind: 'stores', query: q.replace(/^in\s+/i, '') };
        }
    }

    // Natural "stores that sell X" wording is intentionally separate from the
    // generic product triggers so the assistant returns store cards.
    if (STORE_WORDS.test(text) && SELL_WORD.test(text)) {
        const m = text.match(/\b(?:sell(?:s|ing)?)\b\s+(.+)$/i);
        const q = cleanQuery(m && m[1]);
        if (validQuery(q, 'stores')) return { kind: 'stores', query: q };
    }

    for (const re of PRODUCT_TRIGGERS) {
        const m = text.match(re);
        if (m) {
            let q = cleanQuery(m[1]);
            q = q.replace(/\s+in\s+.+$/i, '').trim();
            if (validQuery(q, 'products') && !STORE_WORDS.test(q)) return { kind: 'products', query: q };
        }
    }
    return null;
}

function textField(value, max) {
    return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max).trim();
}
function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function productCard(p) {
    if (!p || p.id == null || p.price == null || String(p.price).trim() === '') return null;
    const price = finiteNumber(p.price);
    if (price === null) return null;
    const originalPrice = p.originalPrice == null ? null : finiteNumber(p.originalPrice);
    return {
        type: 'product',
        id: textField(p.id, 120),
        name: textField(p.name, 120),
        price,
        originalPrice,
        thumbnail: textField(p.thumbnail, 500),
        storeName: textField(p.storeName, 120),
        storeSlug: textField(p.storeSlug, 120),
    };
}
function storeCard(s) {
    if (!s || s.id == null) return null;
    return {
        type: 'store',
        id: textField(s.id, 120),
        slug: textField(s.slug, 120),
        name: textField(s.name, 120),
        logo: textField(s.logo, 500),
        district: textField(s.district, 80),
        description: textField(s.description, 120),
    };
}

async function fetchJson(url, signal) {
    const timeout = AbortSignal.timeout(config.catalogTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        const res = await fetch(url, { signal: combined });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

function singularQuery(query) {
    const words = query.trim().split(/\s+/);
    const last = words[words.length - 1];
    if (last.length < 4 || !/s$/i.test(last) || /ss$/i.test(last)) return null;
    words[words.length - 1] = /ies$/i.test(last) ? last.slice(0, -3) + 'y' : last.slice(0, -1);
    return words.join(' ');
}

async function lookupCatalogOnce(kind, query, signal) {
    const encoded = encodeURIComponent(query);
    let url;
    if (kind === 'products') {
        url = `${config.nextastoreApiBase}/products/public?q=${encoded}&limit=4&sort=popular`;
    } else if (kind === 'stores') {
        // /store/public/all searches store name, description, district and address;
        // /store/search only matches store names, so it misses place and description queries.
        url = `${config.nextastoreApiBase}/store/public/all?limit=4${query ? `&q=${encoded}` : ''}`;
    } else {
        return null;
    }
    const body = await fetchJson(url, signal);
    if (!body) return null;
    const raw = body?.data;
    if (!Array.isArray(raw)) return null;
    const cards = raw.slice(0, 4).map(kind === 'products' ? productCard : storeCard).filter(Boolean);
    return { kind, items: cards };
}

async function searchCatalog({ kind, query, signal }) {
    const q = cleanQuery(query);
    if (kind === 'products' && q.length < 2) return null;
    if (kind === 'stores' && q && q.length < 2) return null;
    if (kind !== 'products' && kind !== 'stores') return null;

    const first = await lookupCatalogOnce(kind, q, signal);
    if (!first || signal?.aborted) return null;
    if (first.items.length) return { kind, query: q, items: first.items };

    const singular = q ? singularQuery(q) : null;
    if (!singular || singular === q) return { kind, query: q, items: [] };
    const second = await lookupCatalogOnce(kind, singular, signal);
    if (!second || signal?.aborted) return null;
    return { kind, query: q, items: second.items };
}

module.exports = { detectCatalogIntent, searchCatalog };
