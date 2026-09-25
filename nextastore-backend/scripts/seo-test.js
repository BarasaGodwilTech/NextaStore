// Unit tests for src/seo.js (store-page <head> rewriting, sitemap, robots) and the
// reserved store-link words in src/utils.js — no database or network needed.
//   node scripts/seo-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const seo = require('../src/seo');
const { isReservedSlug, storeSlugFrom, RESERVED_SLUGS } = require('../src/slugs');

// The real storefront page: the thing the API rewrites per store.
const root = path.resolve(__dirname, '..', '..');
const shell = fs.readFileSync(path.join(root, 'store-detail.html'), 'utf8');
const render = (opts) => seo.renderStoreShell(shell, { siteUrl: site, appUrl: site, ...opts });

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS  ${name}`); }

const site = 'https://nextastore.ug';
const store = {
    slug: 'amina-crafts', name: 'Amina\'s <Crafts> & "Co"', description: 'Handmade baskets.\nDelivered across Kampala.',
    district: 'kampala', detailedDirections: 'Opposite the bank, 2nd floor', mapCoordinates: '0.3476,32.5825',
    banner: 'https://cdn.example.com/stores/1/banner.jpg', logo: 'https://cdn.example.com/stores/1/logo.jpg', bannerColor: '#00B074',
    seo: {}
};
const products = [
    { id: 'p1', name: 'Woven basket', description: 'A basket', price: 25000, stock: 3, category: 'home', images: ['https://cdn.example.com/p1.jpg'], thumbnails: [] },
    { id: 'p2', name: 'Sold out mat</script><script>alert(1)</script>', description: '', price: '12000.00', stock: 0, category: 'home', images: [], image: null, thumbnails: [] }
];

function ld(html) {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert(m, 'JSON-LD block missing');
    return JSON.parse(m[1]);
}

test('the store\'s page has unique title, description, canonical, OG and robots', () => {
    const html = render({ store, live: true, products, productCount: 2, paymentLabels: ['MTN MoMo'] });
    assert(/<link rel="canonical" href="https:\/\/nextastore\.ug\/amina-crafts">/.test(html));
    assert(/<meta name="robots" content="index,follow/.test(html));
    assert(/property="og:image" content="https:\/\/cdn\.example\.com\/stores\/1\/banner\.jpg"/.test(html));
    assert(/<title>[^<]*Kampala[^<]*<\/title>/.test(html));
    assert(/name="description" content="Handmade baskets\. Delivered across Kampala\."/.test(html));
});

test('seller-written SEO title/description override the defaults', () => {
    const s = seo.buildStoreSeo({ store: { ...store, seo: { title: 'Best baskets in Kampala', description: 'Custom text' } }, siteUrl: site, appUrl: site });
    assert.strictEqual(s.title, 'Best baskets in Kampala');
    assert.strictEqual(s.description, 'Custom text');
});

test('store name and product names are HTML-escaped (no injection)', () => {
    const html = render({ store, live: true, products, productCount: 2 });
    assert(!html.includes('<Crafts>'));
    assert(!/<script>alert\(1\)<\/script>/.test(html));
    assert(html.includes('&lt;Crafts&gt; &amp; &quot;Co&quot;'));
});

test('JSON-LD is valid JSON, cannot close its script tag, and describes store + products', () => {
    const html = render({ store, live: true, products, productCount: 2 });
    const data = ld(html);
    const store_ = data['@graph'].find(n => n['@type'] === 'Store');
    const list = data['@graph'].find(n => n['@type'] === 'ItemList');
    assert.strictEqual(store_.address.addressLocality, 'Kampala');
    assert.strictEqual(store_.geo.latitude, 0.3476);
    assert.strictEqual(list.itemListElement.length, 2);
    assert.strictEqual(list.itemListElement[0].item.offers.priceCurrency, 'UGX');
    assert.strictEqual(list.itemListElement[0].item.offers.availability, 'https://schema.org/InStock');
    assert.strictEqual(list.itemListElement[1].item.offers.availability, 'https://schema.org/OutOfStock');
    assert.strictEqual(list.itemListElement[1].item.offers.price, 12000);
});

test('seller opt-out renders noindex and is excluded from the sitemap logic', () => {
    const off = { ...store, seo: { indexable: false } };
    assert.strictEqual(seo.isIndexable(off), false);
    assert.strictEqual(seo.isIndexable(store), true);
    const html = render({ store: off, live: true });
    assert(/<meta name="robots" content="noindex,nofollow">/.test(html));
});

test('unsafe image URLs are ignored rather than emitted into CSS/HTML', () => {
    const evil = { ...store, banner: "https://x.example/a.jpg');background:url('//evil", logo: 'javascript:alert(1)' };
    const html = render({ store: evil, live: true });
    assert(!html.includes('evil'));
    assert(!html.includes('javascript:'));
    assert(html.includes('og-link-preview-1200x630.png'));
});

test('a store with no products or description still renders a valid page', () => {
    const bare = { slug: 'bare', name: 'Bare Store', description: '', district: '', seo: {} };
    const html = render({ store: bare, live: true });
    assert(/<title>Bare Store[^<]*<\/title>/.test(html));
    ld(html);
});

test('robots.txt points at the sitemap and does not block the API', () => {
    const txt = seo.renderRobots({ siteUrl: site + '/' });
    assert(txt.includes('Sitemap: https://nextastore.ug/sitemap.xml'));
    assert(!/Disallow:\s*\/api/.test(txt));
    assert(/Disallow: \/dashboard\.html/.test(txt));
});

test('sitemap lists store pages, escapes URLs, and only adds static pages on the same host', () => {
    const same = seo.renderSitemap({ siteUrl: site, appUrl: site, stores: [{ slug: 'a&b', updatedAt: '2026-09-01T00:00:00Z' }] });
    assert(same.includes('<loc>https://nextastore.ug/a%26b</loc>'));
    assert(same.includes('<lastmod>2026-09-01T00:00:00.000Z</lastmod>'));
    assert(same.includes('<loc>https://nextastore.ug/marketplace.html</loc>'));
    const diff = seo.renderSitemap({ siteUrl: 'https://api.example.com', appUrl: site, stores: [{ slug: 'x' }] });
    assert(!diff.includes('marketplace.html'));
    assert(diff.includes('<loc>https://api.example.com/x</loc>'));
});

test('title and description are length-capped for search snippets', () => {
    const s = seo.buildStoreSeo({ store: { ...store, seo: { title: 'T'.repeat(200), description: 'word '.repeat(100) } }, siteUrl: site, appUrl: site });
    assert(s.title.length <= 70);
    assert(s.description.length <= 160);
});

test('the page stays the real storefront: body untouched, one title/description/canonical, no old relative og:image', () => {
    const html = render({ store, live: true, products, productCount: 2 });
    const bodyOf = (h) => h.slice(h.search(/<body/i));
    assert.strictEqual(bodyOf(html), bodyOf(shell), 'body must be byte-for-byte the normal storefront');
    assert(html.includes('css/store-detail.css') && html.includes('js/store-detail.js'), 'stylesheet/script links kept');
    assert.strictEqual((html.match(/<title>/g) || []).length, 1);
    assert.strictEqual((html.match(/name="description"/g) || []).length, 1);
    assert.strictEqual((html.match(/rel="canonical"/g) || []).length, 1);
    assert.strictEqual((html.match(/property="og:image"/g) || []).length, 1);
    assert(!html.includes('content="assets/brand'), 'no relative preview image left from the generic page');
    assert(html.includes('<meta charset="UTF-8">'), 'charset kept');
    assert(html.indexOf('<meta charset') < html.indexOf('<title>'), 'charset stays ahead of the injected tags');
});

test('a draft or lapsed store gets noindex and none of its own details', () => {
    const html = render({ store, live: false });
    assert(/<meta name="robots" content="noindex,nofollow">/.test(html));
    assert(!html.includes('Handmade baskets') && !html.includes('cdn.example.com') && !html.includes('ld+json'));
    assert(/<title>Store \| NextaStore<\/title>/.test(html));
});

test('an unknown address renders the same page as noindex', () => {
    const html = render({});
    assert(/<title>Store not found \| NextaStore<\/title>/.test(html));
    assert(/noindex/.test(html));
});

test('baseHref (API opened on another host) points relative paths at the site', () => {
    const html = render({ store, live: true, baseHref: 'http://localhost:3000' });
    assert(html.includes('<base href="http://localhost:3000/">'));
    assert(html.indexOf('<base') < html.indexOf('css/main.css'), 'base must precede every relative URL');
    assert(!render({ store, live: true }).includes('<base'));
});

test('the store address is /<slug> with no path in between', () => {
    assert.strictEqual(seo.storeUrl('https://nextastores.com/', 'amina-crafts'), 'https://nextastores.com/amina-crafts');
    assert(!/\/s\//.test(seo.storeUrl('https://nextastores.com', 'amina-crafts')));
});

test('reserved words can never become a store address', () => {
    ['login', 'admin', 'api', 'cart', 'marketplace', 'css', 'js', 'assets', 'uploads', 's', 'Login'].forEach(w => assert(isReservedSlug(w), w));
    assert(!isReservedSlug('amina-crafts'));
    assert.strictEqual(storeSlugFrom('Login'), 'login-store');
    assert.strictEqual(storeSlugFrom("Amina's Store"), 'amina-s-store');
    // Every top-level page and folder of the site is reserved, so adding one
    // without listing it here fails this test instead of hijacking a store link.
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== 'nextastore-backend' && e.name !== 'changelog-archive');
    const missing = entries
        .map(e => e.isDirectory() ? e.name : (e.name.endsWith('.html') ? e.name.replace(/\.html$/, '') : null))
        .filter(Boolean)
        .filter(n => !RESERVED_SLUGS.has(n));
    assert.deepStrictEqual(missing, [], `top-level names missing from RESERVED_SLUGS: ${missing.join(', ')}`);
});

console.log(`\n${passed}/${passed} SEO checks passed.`);
