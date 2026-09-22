/**
 * Search-engine / link-preview rendering for public storefronts.
 *
 * Why this exists: the storefront (store-detail.html) is a JavaScript shell —
 * its HTML is identical for every store until the browser runs the script and
 * fetches the store from the API. Google can sometimes render that, but
 * WhatsApp/Facebook/Twitter link previews and most other crawlers cannot, and
 * every store shares one generic <title>. These functions produce a real,
 * server-rendered HTML page per store (unique title, description, canonical
 * URL, Open Graph tags, schema.org JSON-LD, and crawlable product links) that
 * is served at /s/<slug> by routes/seo.js.
 *
 * Deliberately dependency-free (no express/prisma/config imports) so it can
 * be unit-tested without a database — see scripts/seo-test.js.
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

function formatUgx(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return `UGX ${Math.round(n).toLocaleString('en-US')}`;
}

function parseCoordinates(value) {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(value || ''));
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

/** A store is listed in search engines unless its owner switched that off. */
function isIndexable(store) {
    return !(store && store.seo && store.seo.indexable === false);
}

function storeUrl(siteUrl, slug) {
    return `${String(siteUrl).replace(/\/$/, '')}/s/${encodeURIComponent(slug)}`;
}

function appStoreUrl(appUrl, slug) {
    return `${String(appUrl).replace(/\/$/, '')}/store-detail.html?store=${encodeURIComponent(slug)}`;
}

function appProductUrl(appUrl, productId, slug) {
    return `${String(appUrl).replace(/\/$/, '')}/product-detail.html?id=${encodeURIComponent(productId)}&store=${encodeURIComponent(slug)}`;
}

function firstImage(product) {
    const imgs = Array.isArray(product.images) ? product.images.filter(isAbsoluteUrl) : [];
    if (imgs.length) return imgs[0];
    return isAbsoluteUrl(product.image) ? product.image : null;
}

function thumbImage(product) {
    const thumbs = Array.isArray(product.thumbnails) ? product.thumbnails.filter(isAbsoluteUrl) : [];
    return thumbs[0] || firstImage(product);
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

const PAGE_CSS = `
:root{--ink:#0B3B2B;--green:#00B074;--gray:#5b6660;--line:#e4e9e6;--bg:#f6f8f7}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2521;background:var(--bg)}
a{color:inherit}.wrap{max-width:960px;margin:0 auto;padding:0 16px}
.top{background:var(--ink);color:#fff}.top .wrap{display:flex;align-items:center;justify-content:space-between;min-height:56px}
.top a{color:#fff;text-decoration:none;font-weight:600}
.banner{height:160px;background-size:cover;background-position:center}
.head{background:#fff;border-bottom:1px solid var(--line)}
.head .wrap{display:flex;gap:16px;align-items:flex-end;padding-top:0;padding-bottom:20px;flex-wrap:wrap}
.logo{width:96px;height:96px;border-radius:50%;border:4px solid #fff;background:#fff center/cover;margin-top:-48px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--gray)}
h1{margin:0;font-size:1.6rem;line-height:1.2}.meta{color:var(--gray);font-size:.9rem;margin:4px 0 0}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 22px;border-radius:10px;background:var(--green);color:#fff;font-weight:700;text-decoration:none;margin-left:auto}
.cta.alt{background:#fff;color:var(--ink);border:1.5px solid var(--line);margin-left:0}
section{padding:24px 0}h2{font-size:1.15rem;margin:0 0 12px}
.about{white-space:pre-line;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;list-style:none;margin:0;padding:0}
.card{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none}
.thumb{aspect-ratio:1/1;background:#eef2f0 center/cover}
.card b{display:block;padding:10px 12px 0;font-size:.95rem;line-height:1.3}
.card span{display:block;padding:2px 12px 12px;color:var(--gray);font-size:.9rem}
.card .price{color:var(--ink);font-weight:700}
.foot{border-top:1px solid var(--line);background:#fff;color:var(--gray);font-size:.85rem;padding:20px 0}
.foot a{margin-right:14px}
@media(max-width:520px){.cta{width:100%;margin-left:0}.banner{height:110px}}
`;

function renderStorePage({ store, products = [], productCount = 0, siteUrl, appUrl, paymentLabels = [] }) {
    const s = buildStoreSeo({ store, products, productCount, siteUrl, appUrl, paymentLabels });
    const district = titleCase(store.district);
    const base = String(appUrl).replace(/\/$/, '');
    const coords = parseCoordinates(store.mapCoordinates);
    const bannerStyle = isAbsoluteUrl(store.banner)
        ? `background-color:${esc(/^#[0-9a-fA-F]{6}$/.test(store.bannerColor || '') ? store.bannerColor : '#00B074')};background-image:url('${esc(store.banner)}')`
        : `background-color:${esc(/^#[0-9a-fA-F]{6}$/.test(store.bannerColor || '') ? store.bannerColor : '#00B074')}`;
    const logoInner = isAbsoluteUrl(store.logo) ? '' : esc((store.name || '?').trim().charAt(0).toUpperCase());
    const logoStyle = isAbsoluteUrl(store.logo) ? ` style="background-image:url('${esc(store.logo)}')"` : '';

    const productCards = products.map(p => {
        const thumb = thumbImage(p);
        return `<li><a class="card" href="${esc(appProductUrl(appUrl, p.id, store.slug))}">
<div class="thumb"${thumb ? ` style="background-image:url('${esc(thumb)}')"` : ''} role="img" aria-label="${esc(p.name)}"></div>
<b>${esc(p.name)}</b><span class="price">${esc(formatUgx(p.price))}</span>${Number(p.stock) > 0 ? '' : '<span>Out of stock</span>'}</a></li>`;
    }).join('\n');

    const locationLines = [];
    if (district) locationLines.push(`<p class="about"><strong>Area:</strong> ${esc(district)}</p>`);
    if (collapse(store.detailedDirections)) locationLines.push(`<p class="about"><strong>Directions:</strong> ${esc(store.detailedDirections)}</p>`);
    if (coords) locationLines.push(`<p><a href="https://www.google.com/maps/search/?api=1&amp;query=${coords.lat},${coords.lng}" rel="noopener">Open in Google Maps</a></p>`);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title>
<meta name="description" content="${esc(s.description)}">
<meta name="robots" content="${esc(s.robots)}">
<link rel="canonical" href="${esc(s.canonical)}">
<meta name="theme-color" content="#0B3B2B">
<link rel="icon" href="${esc(base)}/assets/brand/png/favicon/favicon-32.png">
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
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="top"><div class="wrap"><a href="${esc(base)}/">NextaStore</a><a href="${esc(base)}/marketplace.html">Marketplace</a></div></div>
<div class="banner" style="${bannerStyle}"></div>
<header class="head"><div class="wrap">
<div class="logo"${logoStyle}>${logoInner}</div>
<div><h1>${esc(store.name)}</h1><p class="meta">${district ? `${esc(district)}, Uganda` : 'Uganda'}${paymentLabels.length ? ` \u00b7 Accepts ${esc(paymentLabels.join(', '))}` : ''}</p></div>
<a class="cta" href="${esc(s.shopUrl)}">Shop this store</a>
</div></header>
<main class="wrap">
${collapse(store.description) ? `<section><h2>About ${esc(store.name)}</h2><p class="about">${esc(store.description)}</p></section>` : ''}
${products.length ? `<section><h2>Products${productCount > products.length ? ` (${productCount})` : ''}</h2><ul class="grid">
${productCards}
</ul>${productCount > products.length ? `<p><a class="cta alt" href="${esc(s.shopUrl)}">See all ${esc(productCount)} products</a></p>` : ''}</section>` : ''}
${locationLines.length ? `<section><h2>Find us</h2>${locationLines.join('\n')}</section>` : ''}
</main>
<footer class="foot"><div class="wrap"><a href="${esc(base)}/marketplace.html">Marketplace</a><a href="${esc(base)}/safety.html">Trust &amp; Safety</a><span>Powered by NextaStore</span></div></footer>
</body>
</html>`;
}

function renderNotFoundPage({ appUrl }) {
    const base = String(appUrl).replace(/\/$/, '');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store not found | NextaStore</title><meta name="robots" content="noindex,nofollow"><style>${PAGE_CSS}</style></head>
<body><main class="wrap" style="padding:64px 16px;text-align:center"><h1>This store isn't available</h1>
<p class="meta">It may have moved, been paused, or never existed.</p>
<p><a class="cta" style="margin:0" href="${esc(base)}/marketplace.html">Browse the marketplace</a></p></main></body></html>`;
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
            ['/', '/marketplace.html', '/stores.html', '/safety.html'].forEach(p => urls.push({ loc: `${site}${p}` }));
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
    buildStoreSeo, renderStorePage, renderNotFoundPage, renderRobots, renderSitemap,
    SITEMAP_MAX_URLS
};
