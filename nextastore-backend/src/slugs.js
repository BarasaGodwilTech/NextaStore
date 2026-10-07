/**
 * Store slugs: how a store name becomes the last part of its public address
 * (nextastores.com/<slug>), and which words are off limits.
 *
 * Dependency-free on purpose (no config/prisma), so it can be unit-tested
 * without a database - see scripts/seo-test.js.
 */

function slugify(text) {
    return (text || 'my-store')
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'my-store';
}

// A store's public address is a bare top-level path (nextastores.com/<slug>),
// so a slug must never equal the name of something else that lives at the top
// level of the site: a page (login, marketplace, cart, ...), an asset folder
// (css, js, assets, uploads), an API/SEO path (api, sitemap, robots) or a word
// that would look official (admin, support, nextastore). scripts/qa-static.js
// fails if a new top-level .html page is added without being listed here.
const RESERVED_SLUGS = new Set([
    // pages in the site root (basename of each .html file)
    'index', 'admin', 'cart', 'dashboard', 'favorites', 'following', 'forgot-password',
    'login', 'marketplace', 'messages', 'offline', 'onboarding', 'orders', 'privacy',
    'product-detail', 'product-form', 'safety', 'signup', 'store', 'store-detail',
    'stores', 'subscription', 'terms', 'verify-email',
    'nextastore-loading-everyone', 'nextastore-loading-seller',
    // folders and files served from the site root
    'api', 'assets', 'css', 'js', 'errors', 'uploads', 'sitemap', 'robots', 'manifest',
    'service-worker', 'favicon', 'static', 'public', 'health', 's', 'p',
    // routes the site may grow into, and words that would look official
    'home', 'about', 'contact', 'help', 'support', 'pricing', 'blog', 'docs', 'status',
    'search', 'shop', 'sell', 'seller', 'sellers', 'buyer', 'account', 'settings',
    'profile', 'notifications', 'checkout', 'deals', 'categories', 'category', 'product',
    'products', 'order', 'reset-password', 'logout', 'register', 'www', 'app', 'null',
    'undefined', 'nextastore', 'nextastores', 'nextawills'
]);

function isReservedSlug(slug) {
    return RESERVED_SLUGS.has(String(slug || '').toLowerCase());
}

/** slugify() that can never return a reserved word: "Login" becomes
 *  "login-store" instead of taking over nextastores.com/login. Used wherever
 *  a slug is *generated* for someone (signup, become-seller); a slug the seller
 *  types themselves is rejected with a message instead (see PUT /store). */
function storeSlugFrom(text) {
    const slug = slugify(text);
    return isReservedSlug(slug) ? `${slug}-store` : slug;
}


// ---- Product addresses: /<store-slug>/<product-name>-<key> ---------------------
//
// A product's public address is the store's address plus a readable name and a
// short key: nextastores.com/asia-ivan/blue-sofa-x7k2m9ab. The key is the tail
// of the product's id (its random part), so the address survives a product
// rename - the name in it is decoration, the server finds the product by the key
// inside that store and 301s to the current spelling.
//
// js/main.js carries a copy of these three functions for the browser (they
// build the links on cards, search results, favorites...). scripts/
// product-url-test.js runs both against the same inputs, so they cannot drift.
const PRODUCT_KEY_LENGTH = 8;   // characters of the id used as the key
const PRODUCT_KEY_MIN = 4;      // a shorter id cannot make a safe address
const PRODUCT_SLUG_MAX = 60;    // readable part only, never the key

function productKey(id) {
    return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-PRODUCT_KEY_LENGTH);
}

function productSlugFrom(name) {
    let slug = String(name == null ? '' : name)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    if (slug.length > PRODUCT_SLUG_MAX) {
        slug = slug.slice(0, PRODUCT_SLUG_MAX);
        const cut = slug.lastIndexOf('-');
        if (cut > 20) slug = slug.slice(0, cut);   // end on a whole word when we can
        slug = slug.replace(/-$/, '');
    }
    return slug || 'product';
}

/** `/<store-slug>/<name>-<key>`, or null when there is no store slug or the id is
 *  too short to key on (callers then use /p/<id>, which the server resolves). */
function productPath(product, storeSlug) {
    const slug = String(storeSlug || '').trim();
    const key = productKey(product && product.id);
    if (!slug || !/^[A-Za-z0-9-]+$/.test(slug) || key.length < PRODUCT_KEY_MIN) return null;
    return `/${slug}/${productSlugFrom(product.name)}-${key}`;
}

/** The key out of the last part of a product address (`blue-sofa-x7k2m9ab` ->
 *  `x7k2m9ab`), or null when it cannot be one. */
function productKeyFromSlug(productSlug) {
    const raw = String(productSlug || '');
    const key = raw.slice(raw.lastIndexOf('-') + 1).toLowerCase();
    return /^[a-z0-9]+$/.test(key) && key.length >= PRODUCT_KEY_MIN && key.length <= 32 ? key : null;
}

module.exports = { slugify, RESERVED_SLUGS, isReservedSlug, storeSlugFrom, productKey, productSlugFrom, productPath, productKeyFromSlug, PRODUCT_KEY_LENGTH, PRODUCT_KEY_MIN };
