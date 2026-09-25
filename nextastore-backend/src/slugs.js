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
    // folders and files served from the site root
    'api', 'assets', 'css', 'js', 'errors', 'uploads', 'sitemap', 'robots', 'manifest',
    'service-worker', 'favicon', 'static', 'public', 'health', 's',
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

module.exports = { slugify, RESERVED_SLUGS, isReservedSlug, storeSlugFrom };
