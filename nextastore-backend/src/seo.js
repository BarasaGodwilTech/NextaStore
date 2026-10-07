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

const { productPath } = require('./slugs');

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

function appProductUrl(appUrl, product, slug) {
    const base = String(appUrl).replace(/\/$/, '');
    // /<store>/<name>-<key>; /p/<id> only when a clean address cannot be made,
    // and the server sends that on to the real one.
    return `${base}${productPath(product, slug) || `/p/${encodeURIComponent(product && product.id)}`}`;
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
                const productUrl = appProductUrl(appUrl, p, store.slug);
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
 * Asset URLs remain relative to the public storefront origin. The API serves
 * this shell as the fallback for the public host, so a `<base>` tag pointing
 * at a configured deployment URL would make local/tunnel/domain-switch requests
 * load assets from the wrong host.
 */
function renderStoreShell(shellHtml, { store = null, live = false, products = [], productCount = 0, paymentLabels = [], siteUrl, appUrl } = {}) {
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
    return `${shellHtml.slice(0, openTagEnd)}\n${head.trim()}\n${inject}${shellHtml.slice(headEnd)}`;
}

// ---- Product pages: nextastores.com/<store-slug>/<name>-<key> -----------------
//
// A product's address is its page: the API answers /<store>/<name>-<key> with
// the real product-detail.html (the normal, fully styled page) and rewrites only
// its <head> for that product - title with the price, description, preview
// photo, canonical URL, Open Graph / Twitter tags and schema.org JSON-LD - the
// same way stores work at /<slug>. So the link in the address bar IS the link
// that previews well: copy it, share it, paste it anywhere.
//
// Image choice (what looks professional AND always shows up in WhatsApp): the
// product's ~480px cover THUMBNAIL. WhatsApp draws a product link as a small
// square photo, so 480px is sharp at that size, and being a small JPEG it is
// never over the size limit past which WhatsApp silently drops an og:image (the
// full-size photos go up to 1800px and can be). The full photo, the store logo
// and the brand card are fallbacks, in that order.

function siteBase(url) { return String(url).replace(/\/$/, ''); }

/** The public, shareable address of a product:
 *  https://nextastores.com/<store-slug>/<name>-<key>. */
function productShareUrl(siteUrl, product, storeSlug) {
    return `${siteBase(siteUrl)}${productPath(product, storeSlug) || `/p/${encodeURIComponent(product && product.id)}`}`;
}

/** "UGX 450,000" - whole shillings with thousands separators, or '' when the
 *  product has no usable price (so a title never says "UGX 0"). */
function formatUgx(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `UGX ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** The preview photo. Index 0 is the cover in every image array, so only the
 *  cover is considered - never a later photo that happens to be valid. */
function productShareImage(product, store, defaultImage) {
    const first = arr => (Array.isArray(arr) ? arr[0] : null);
    return [first(product.thumbnails), first(product.images), product.image, store && store.logo]
        .find(isAbsoluteUrl) || defaultImage;
}

/** Everything a product page's <head> needs for one LIVE product of a LIVE store. */
function buildProductShare({ product, store, siteUrl, appUrl }) {
    const name = collapse(product.name) || 'Product';
    const price = formatUgx(product.price);
    const priceSuffix = price ? ` \u2013 ${price}` : '';
    // The price is the last thing dropped: shorten the name, never the price.
    const title = `${clip(name, 70 - priceSuffix.length)}${priceSuffix}`;

    const district = titleCase(store.district);
    const inStock = Number(product.stock) > 0;
    const lead = `Sold by ${store.name}${district ? ` in ${district}` : ''} on NextaStore.${inStock ? '' : ' Currently out of stock.'}`;
    const description = clip(`${lead} ${collapse(product.description)}`, 160);

    const defaultImage = `${siteBase(appUrl)}${DEFAULT_OG_IMAGE_PATH}`;
    const url = productShareUrl(siteUrl, product, store.slug);
    const image = productShareImage(product, store, defaultImage);
    const numericPrice = price ? Math.round(Number(product.price)) : null;

    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        '@id': `${url}#product`,
        name,
        url,
        image: [image],
        ...(collapse(product.description) ? { description: clip(product.description, 300) } : {}),
        ...(numericPrice ? {
            offers: {
                '@type': 'Offer',
                price: numericPrice,
                priceCurrency: 'UGX',
                availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                url,
                seller: { '@type': 'Organization', name: store.name }
            }
        } : {})
    };

    return {
        title,
        description,
        url,
        image,
        imageAlt: clip(name, 100),
        price: numericPrice,
        inStock,
        // Listed by search engines unless the owner switched that off for the store.
        robots: isIndexable(store) ? 'index,follow,max-image-preview:large' : 'noindex,nofollow',
        jsonLd
    };
}

/** product-detail.html loads its CSS, scripts and images with relative paths
 *  (`css/main.css`). That works at /product-detail and at /<slug>, but this page
 *  lives one folder deeper (/<store>/<product>), where `css/main.css` would mean
 *  /<store>/css/main.css. Make every relative file reference root-relative. Left
 *  alone: absolute paths, full URLs, data:/mailto:/javascript: and #anchors. */
function rootRelative(html) {
    return html.replace(/(\s(?:src|href)=)(["'])(?!\/|#|\?|[a-z][a-z0-9+.-]*:)([^"']+)\2/gi,
        (m, attr, quote, value) => `${attr}${quote}/${value}${quote}`);
}

/**
 * The real product-detail.html, with its <head> rewritten for one product.
 *  - `share` given:            a live product: its own title, description, photo,
 *                              canonical URL and JSON-LD.
 *  - `product` but no `share`: a draft / lapsed store's product. Generic brand
 *                              tags + noindex, so nothing about it leaks or gets
 *                              indexed; the owner still sees it (the page asks the
 *                              API, which knows who is looking).
 *  - neither:                  an address nobody owns. Same page, noindex; the
 *                              caller sends 404 and the page shows "not found".
 * Whenever a product exists, its id and store go into the page as two <meta>
 * tags: the address only carries a short key, and the page needs the full id to
 * ask the API for the product.
 */
function renderProductShell(shellHtml, { share = null, product = null, store = null, siteUrl, appUrl } = {}) {
    const headEnd = shellHtml.search(/<\/head>/i);
    if (headEnd === -1) return shellHtml;
    const headStart = shellHtml.search(/<head[^>]*>/i);
    const openTagEnd = shellHtml.indexOf('>', headStart) + 1;
    const head = stripHeadTags(shellHtml.slice(openTagEnd, headEnd));

    const defaultImage = `${siteBase(appUrl || siteUrl)}${DEFAULT_OG_IMAGE_PATH}`;
    let inject;
    if (share) {
        inject = `<title>${esc(share.title)}</title>
<meta name="description" content="${esc(share.description)}">
<meta name="robots" content="${esc(share.robots)}">
<link rel="canonical" href="${esc(share.url)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="NextaStore">
<meta property="og:title" content="${esc(share.title)}">
<meta property="og:description" content="${esc(share.description)}">
<meta property="og:url" content="${esc(share.url)}">
<meta property="og:image" content="${esc(share.image)}">
<meta property="og:image:alt" content="${esc(share.imageAlt)}">
${share.price ? `<meta property="product:price:amount" content="${share.price}">
<meta property="product:price:currency" content="UGX">
` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(share.title)}">
<meta name="twitter:description" content="${esc(share.description)}">
<meta name="twitter:image" content="${esc(share.image)}">
<script type="application/ld+json">${safeJson(share.jsonLd)}</script>
`;
    } else {
        // Generic brand card. Only the title differs between "not public" and
        // "no such product".
        inject = `<title>${product ? 'Product' : 'Product not found'} | NextaStore</title>
<meta name="description" content="Open this product on NextaStore.">
<meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NextaStore">
<meta property="og:title" content="Product | NextaStore">
<meta property="og:description" content="Open this product on NextaStore.">
<meta property="og:image" content="${esc(defaultImage)}">
<meta property="og:image:alt" content="NextaStore">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Product | NextaStore">
<meta name="twitter:description" content="Open this product on NextaStore.">
<meta name="twitter:image" content="${esc(defaultImage)}">
`;
    }
    const ids = product
        ? `<meta name="nx-product-id" content="${esc(product.id)}">\n<meta name="nx-store-slug" content="${esc((store && store.slug) || '')}">\n`
        : '';
    return rootRelative(`${shellHtml.slice(0, openTagEnd)}\n${head.trim()}\n${inject}${ids}${shellHtml.slice(headEnd)}`);
}

// Pages nobody should find through a search engine (they need a login, or exist
// only to be arrived at from an email). Their clean addresses are listed here;
// robotsRulesFor() turns each into the rules for /page, /page?query and the
// old /page.html.
const PRIVATE_PAGES = [
    'dashboard', 'admin', 'messages', 'cart', 'orders', 'favorites', 'following',
    'subscription', 'onboarding', 'product-form', 'login', 'signup',
    'forgot-password', 'verify-email'
];

// A bare "Disallow: /cart" would also hide every store whose address merely
// starts with "cart" (a store called "Cart Kings" lives at /cart-kings), so the
// clean address is end-anchored with `$` (understood by Google and Bing) and the
// query-string form is listed on its own.
function robotsRulesFor(page) {
    return [`Disallow: /${page}$`, `Disallow: /${page}?`, `Disallow: /${page}.html`];
}

function renderRobots({ siteUrl }) {
    // Deliberately NOT disallowing /api/: Googlebot renders the JavaScript
    // pages (store-detail.html, product-detail) and needs the API to do it.
    return [
        'User-agent: *',
        'Allow: /',
        ...PRIVATE_PAGES.flatMap(robotsRulesFor),
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
            ['/', '/marketplace', '/stores', '/safety', '/terms', '/privacy'].forEach(p => urls.push({ loc: `${site}${p}` }));
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
    productShareUrl, formatUgx, productShareImage, rootRelative,
    buildProductShare, renderProductShell,
    SITEMAP_MAX_URLS
};
