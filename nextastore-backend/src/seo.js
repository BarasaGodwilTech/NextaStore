/**
 * Search-engine / link-preview tags for public storefronts.
 *
 * A store's public address is nextastores.com/<slug>, and it opens the real,
 * fully styled store-detail.html page - there is no second, stripped-down page
 * for crawlers. The catch is that store-detail.html is a JavaScript shell whose
 * <head> is identical for every store until the browser runs the script:
 * WhatsApp/Facebook/Twitter link previews and most crawlers never run it, so
 * every store would share one generic title and a blank preview. These
 * functions solve that by rewriting only the <head> of that same file per
 * store (unique title, description, canonical URL, Open Graph tags, schema.org
 * JSON-LD); routes/seo.js serves the result at /<slug>. The <body> is left
 * untouched, so what a person sees is exactly the normal storefront.
 *
 * Deliberately dependency-free (no express/prisma/config imports) so it can
 * be unit-tested without a database - see scripts/seo-test.js.
 */

const DEFAULT_OG_IMAGE_PATH = '/assets/brand/png/social/og-link-preview-1200x630.png';
const SITEMAP_MAX_URLS = 50000; // sitemaps.org hard limit per file

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** JSON for an inline <script type="application/ld+json">: escape anything
 *  that could close the tag or be read as HTML. */
function safeJson(obj) {
    return JSON.stringify(obj)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function collapse(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Trim to `max` characters at a word boundary, with an ellipsis. */
function clip(text, max) {
    const t = collapse(text);
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:-]+$/, '')}\u2026`;
}

function titleCase(text) {
    const t = collapse(text);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** Accepts only well-formed http(s) URLs with no characters that could break
 *  out of a CSS url('...') or an HTML attribute. Image URLs come from
 *  seller-editable columns, so they are not trusted to be R2 keys. */
function isAbsoluteUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
    if (/[\s'"()<>\\`]/.test(value)) return false;
    try { new URL(value); return true; } catch (e) { return false; }
}

function parseCoordinates(value) {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(value || ''));
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

/** A store is listed in search engines unless its owner switched that off. */
function isIndexable(store) {
    return !(store && store.seo && store.seo.indexable === false);
}

/** The public, shareable address of a store: https://nextastores.com/<slug>. */
function storeUrl(siteUrl, slug) {
    return `${String(siteUrl).replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
}

function appStoreUrl(appUrl, slug) {
    return `${String(appUrl).replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
}

function appProductUrl(appUrl, productId, slug) {
    return `${String(appUrl).replace(/\/$/, '')}/product-detail.html?id=${encodeURIComponent(productId)}&store=${encodeURIComponent(slug)}`;
}

function firstImage(product) {
    const imgs = Array.isArray(product.images) ? product.images.filter(isAbsoluteUrl) : [];
    if (imgs.length) return imgs[0];
    return isAbsoluteUrl(product.image) ? product.image : null;
}

/** Everything a page needs that is derived from the store's own settings. */
function buildStoreSeo({ store, products = [], productCount = 0, siteUrl, appUrl, paymentLabels = [] }) {
    const district = titleCase(store.district);
    const seo = store.seo || {};
    const canonical = storeUrl(siteUrl, store.slug);
    const shopUrl = appStoreUrl(appUrl, store.slug);

    const title = clip(
        seo.title || `${store.name} \u2013 Shop online${district ? ` in ${district}` : ''} | NextaStore`,
        70
    );
    const description = clip(
        seo.description
            || store.description
            || `Shop ${store.name} on NextaStore${district ? `, ${district}` : ''}. Browse products and message the seller directly.`,
        160
    );

    const defaultImage = `${String(appUrl).replace(/\/$/, '')}${DEFAULT_OG_IMAGE_PATH}`;
    const image = [store.banner, store.logo].find(isAbsoluteUrl) || defaultImage;
    const robots = isIndexable(store) ? 'index,follow,max-image-preview:large' : 'noindex,nofollow';

    const storeNode = {
        '@type': 'Store',
        '@id': `${canonical}#store`,
        name: store.name,
        url: canonical,
        description,
        image: [store.banner, store.logo].filter(isAbsoluteUrl),
        ...(isAbsoluteUrl(store.logo) ? { logo: store.logo } : {}),
        address: {
            '@type': 'PostalAddress',
            ...(district ? { addressLocality: district } : {}),
            addressCountry: 'UG'
        }
    };
    const coords = parseCoordinates(store.mapCoordinates);
    if (coords) storeNode.geo = { '@type': 'GeoCoordinates', latitude: coords.lat, longitude: coords.lng };
    if (paymentLabels.length) storeNode.paymentAccepted = paymentLabels.join(', ');
    if (!storeNode.image.length) delete storeNode.image;

    const graph = [storeNode];
    if (products.length) {
        graph.push({
            '@type': 'ItemList',
            name: `${store.name} products`,
            numberOfItems: productCount || products.length,
            itemListElement: products.map((p, i) => {
                const productUrl = appProductUrl(appUrl, p.id, store.slug);
                const img = firstImage(p);
                return {
                    '@type': 'ListItem',
                    position: i + 1,
                    item: {
                        '@type': 'Product',
                        name: p.name,
                        url: productUrl,
                        ...(img ? { image: img } : {}),
                        ...(collapse(p.description) ? { description: clip(p.description, 200) } : {}),
                        ...(p.category ? { category: p.category } : {}),
                        offers: {
                            '@type': 'Offer',
                            price: Number(p.price),
                            priceCurrency: 'UGX',
                            availability: Number(p.stock) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                            url: productUrl,
                            seller: { '@id': `${canonical}#store` }
                        }
                    }
                };
            })
        });
    }

    return {
        title, description, canonical, shopUrl, image, robots,
        jsonLd: { '@context': 'https://schema.org', '@graph': graph }
    };
}

/** Removes the tags this module replaces, so the shell never ends up with two
 *  descriptions, two canonical links, or a relative og:image a crawler can't use. */
function stripHeadTags(head) {
    return head
        .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
        .replace(/<meta\s+name="(?:description|robots|twitter:[^"]*)"[^>]*>\s*/gi, '')
        .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
        .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '');
}

/**
 * The real store-detail.html, with its <head> rewritten for one store.
 *  - `store` given, `live` true:  that store's title, description, preview image, JSON-LD.
 *  - `store` given, `live` false: a draft / lapsed store. Same generic tags as the
 *    untouched page plus noindex, so nothing about it leaks or gets indexed. The owner
 *    can still preview it (the page itself asks the API, which allows the owner).
 *  - no `store`: an address nobody owns. Same page, noindex; the caller sends 404.
 * `baseHref`, when given, makes the page's relative css/js/image paths resolve against
 * that origin - only needed if the API is opened on a different host than the site.
 */
function renderStoreShell(shellHtml, { store = null, live = false, products = [], productCount = 0, paymentLabels = [], siteUrl, appUrl, baseHref = null } = {}) {
    const headEnd = shellHtml.search(/<\/head>/i);
    if (headEnd === -1) return shellHtml;
    const headStart = shellHtml.search(/<head[^>]*>/i);
    const openTagEnd = shellHtml.indexOf('>', headStart) + 1;
    const head = stripHeadTags(shellHtml.slice(openTagEnd, headEnd));

    let inject;
    if (store && live) {
        const s = buildStoreSeo({ store, products, productCount, siteUrl, appUrl, paymentLabels });
        inject = `<title>${esc(s.title)}</title>
<meta name="description" content="${esc(s.description)}">
<meta name="robots" content="${esc(s.robots)}">
<link rel="canonical" href="${esc(s.canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NextaStore">
<meta property="og:title" content="${esc(s.title)}">
<meta property="og:description" content="${esc(s.description)}">
<meta property="og:url" content="${esc(s.canonical)}">
<meta property="og:image" content="${esc(s.image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(s.title)}">
<meta name="twitter:description" content="${esc(s.description)}">
<meta name="twitter:image" content="${esc(s.image)}">
<script type="application/ld+json">${safeJson(s.jsonLd)}</script>
`;
    } else {
        inject = `<title>${store ? 'Store' : 'Store not found'} | NextaStore</title>
<meta name="robots" content="noindex,nofollow">
`;
    }
    const base = baseHref ? `<base href="${esc(String(baseHref).replace(/\/?$/, '/'))}">\n` : '';
    return `${shellHtml.slice(0, openTagEnd)}\n${base}${head.trim()}\n${inject}${shellHtml.slice(headEnd)}`;
}

function renderRobots({ siteUrl }) {
    // Deliberately NOT disallowing /api/: Googlebot renders the JavaScript
    // pages (store-detail.html, product-detail.html) and needs the API to do it.
    return [
        'User-agent: *',
        'Allow: /',
        'Disallow: /dashboard.html',
        'Disallow: /admin.html',
        'Disallow: /messages.html',
        'Disallow: /cart.html',
        'Disallow: /orders.html',
        'Disallow: /favorites.html',
        'Disallow: /following.html',
        'Disallow: /subscription.html',
        'Disallow: /onboarding.html',
        'Disallow: /product-form.html',
        'Disallow: /login.html',
        'Disallow: /signup.html',
        'Disallow: /forgot-password.html',
        'Disallow: /verify-email.html',
        '',
        `Sitemap: ${String(siteUrl).replace(/\/$/, '')}/sitemap.xml`,
        ''
    ].join('\n');
}

function isoDate(value) {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function renderSitemap({ siteUrl, appUrl, stores = [] }) {
    const site = String(siteUrl).replace(/\/$/, '');
    const urls = [];
    // The static pages only belong in this sitemap when they live on the same
    // host as /sitemap.xml (a sitemap may not list other hosts' URLs).
    try {
        if (new URL(appUrl).host === new URL(site).host) {
            ['/', '/marketplace.html', '/stores.html', '/safety.html', '/terms.html', '/privacy.html'].forEach(p => urls.push({ loc: `${site}${p}` }));
        }
    } catch (e) { /* ignore malformed URLs; store pages are still listed */ }
    stores.slice(0, SITEMAP_MAX_URLS - urls.length).forEach(s => {
        urls.push({ loc: storeUrl(site, s.slug), lastmod: isoDate(s.updatedAt) });
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

module.exports = {
    esc, safeJson, clip, isIndexable, storeUrl, appStoreUrl, appProductUrl,
    buildStoreSeo, renderStoreShell, renderRobots, renderSitemap,
    SITEMAP_MAX_URLS
};
