// Unit tests for src/seo.js — no database or network needed.
//   node scripts/seo-test.js
const assert = require('assert');
const seo = require('../src/seo');

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

test('page has unique title, description, canonical, OG and robots', () => {
    const html = seo.renderStorePage({ store, products, productCount: 2, siteUrl: site, appUrl: site, paymentLabels: ['MTN MoMo'] });
    assert(/<link rel="canonical" href="https:\/\/nextastore\.ug\/s\/amina-crafts">/.test(html));
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
    const html = seo.renderStorePage({ store, products, productCount: 2, siteUrl: site, appUrl: site });
    assert(!html.includes('<Crafts>'));
    assert(!/<script>alert\(1\)<\/script>/.test(html));
    assert(html.includes('&lt;Crafts&gt; &amp; &quot;Co&quot;'));
});

test('JSON-LD is valid JSON, cannot close its script tag, and describes store + products', () => {
    const html = seo.renderStorePage({ store, products, productCount: 2, siteUrl: site, appUrl: site });
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
    const html = seo.renderStorePage({ store: off, siteUrl: site, appUrl: site });
    assert(/<meta name="robots" content="noindex,nofollow">/.test(html));
});

test('unsafe image URLs are ignored rather than emitted into CSS/HTML', () => {
    const evil = { ...store, banner: "https://x.example/a.jpg');background:url('//evil", logo: 'javascript:alert(1)' };
    const html = seo.renderStorePage({ store: evil, siteUrl: site, appUrl: site });
    assert(!html.includes('evil'));
    assert(!html.includes('javascript:'));
    assert(html.includes('og-link-preview-1200x630.png'));
});

test('a store with no products or description still renders a valid page', () => {
    const bare = { slug: 'bare', name: 'Bare Store', description: '', district: '', seo: {} };
    const html = seo.renderStorePage({ store: bare, siteUrl: site, appUrl: site });
    assert(html.includes('<h1>Bare Store</h1>'));
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
    assert(same.includes('<loc>https://nextastore.ug/s/a%26b</loc>'));
    assert(same.includes('<lastmod>2026-09-01T00:00:00.000Z</lastmod>'));
    assert(same.includes('<loc>https://nextastore.ug/marketplace.html</loc>'));
    const diff = seo.renderSitemap({ siteUrl: 'https://api.example.com', appUrl: site, stores: [{ slug: 'x' }] });
    assert(!diff.includes('marketplace.html'));
    assert(diff.includes('<loc>https://api.example.com/s/x</loc>'));
});

test('title and description are length-capped for search snippets', () => {
    const s = seo.buildStoreSeo({ store: { ...store, seo: { title: 'T'.repeat(200), description: 'word '.repeat(100) } }, siteUrl: site, appUrl: site });
    assert(s.title.length <= 70);
    assert(s.description.length <= 160);
});

console.log(`\n${passed}/${passed} SEO checks passed.`);
