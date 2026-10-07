/**
 * One address per store, and a closed shop that owns the whole screen.
 * No dependencies (no jsdom, browser, database): reads the real files and
 * runs the real inline scripts / helper methods in a vm with tiny stubs.
 *
 *   node scripts/store-url-test.js     (npm run test:store-url)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const out = [];
const check = (n, ok) => out.push({ n, ok: !!ok });

// ---- helpers ------------------------------------------------------------
function methodSource(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error('method not found: ' + signature);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced: ' + signature);
}
function inlineScripts(html, { headOnly = false } = {}) {
    const scope = headOnly ? html.slice(0, html.search(/<\/head>/i)) : html;
    return [...scope.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}
function runRedirectScript(code, url, { stamp = null } = {}) {
    const u = new URL(url);
    let redirected = null;
    const store = new Map(stamp ? [['nx-store-detail-bounce', String(stamp)]] : []);
    const window = {
        location: { pathname: u.pathname, search: u.search, hash: u.hash, replace: (t) => { redirected = t; } }
    };
    const sandbox = {
        window, URLSearchParams, Date, Number, String, encodeURIComponent, RegExp,
        sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
    };
    vm.runInNewContext(code, sandbox);
    return { redirected, store };
}

// ---- 1. link helpers never build a store-detail.html link -----------------
const mainJs = read('js/main.js');
const helperClass = `class H {
    ${methodSource(mainJs, 'storeLink(store)')}
    ${methodSource(mainJs, 'storeLinkFor(slugOrId)')}
}`;
const H = vm.runInNewContext(`(${helperClass})`);
const h = new H();
check('storeLink: slug -> /<slug>', h.storeLink({ slug: 'amina-crafts', id: 'x1' }) === '/amina-crafts');
check('storeLink: no slug, has id -> /<id> (server sends it to the slug)', h.storeLink({ id: 'cm9abc123' }) === '/cm9abc123');
check('storeLink: nothing usable -> marketplace', h.storeLink(null) === '/marketplace' && h.storeLink({}) === '/marketplace');
check('storeLinkFor: slug and id -> /<key>', h.storeLinkFor('uganda-fashion-hub') === '/uganda-fashion-hub' && h.storeLinkFor('cm9ABC123') === '/cm9ABC123');
check('storeLinkFor: junk can never become a store address', ['', '   ', '../evil', 'a b', 'x?y=1', 'store_demo', 'a/b'].every(k => h.storeLinkFor(k) === '/marketplace'));

// ---- 2. no page or script links to store-detail.html ------------------------
const linkFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).concat(fs.readdirSync(path.join(ROOT, 'js')).map(f => 'js/' + f));
const linking = /href\s*=\s*["'`]\/?store-detail(\.html)?|["'`]\/?store-detail\.html(\?[^"'`]*)?["'`]\s*[;,)]?|location[^;\n]*store-detail\.html|`store-detail\.html\?/;
const offenders = linkFiles.filter(f => {
    // Comments are ignored, and so is reading an OLD referrer
    // (product-detail.js: pathname.includes('store-detail.html')) - that parses, it does not link.
    const src = read(f).split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
        .replace(/includes\(\s*['"]store-detail\.html['"]\s*\)/g, '');
    return linking.test(src);
});
check('no page or script links to store-detail.html (offenders: ' + (offenders.join(', ') || 'none') + ')', offenders.length === 0);
check('no frontend file links to store.html', !linkFiles.some(f => /href\s*=\s*["']\/?store\.html/.test(read(f))));

// ---- 3. store.html (old links) --------------------------------------------
const storeHtmlScript = inlineScripts(read('store.html'), { headOnly: true })[0];
const oldLink = (q) => runRedirectScript(storeHtmlScript, 'http://localhost:3000/store.html' + q).redirected;
check('store.html?store=<slug> -> /<slug>', oldLink('?store=amina-crafts') === '/amina-crafts');
check('store.html?store=<id> -> /<id>', oldLink('?store=cm9abc123') === '/cm9abc123');
check('store.html with no store, or a junk one -> marketplace', oldLink('') === '/marketplace' && oldLink('?store=../evil') === '/marketplace' && oldLink('?store=a%20b') === '/marketplace');
check('store.html never redirects to store-detail.html', !/store-detail\.html/.test(read('store.html').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')));

// ---- 4. store-detail.html opened directly ------------------------------------
const detailHtml = read('store-detail.html');
const guard = inlineScripts(detailHtml, { headOnly: true })[0];
check('store-detail.html has the direct-visit guard in <head>', /store-detail/.test(guard || '') && /location\.replace|\.replace\(target\)/.test(guard || ''));
const hit = (u, o) => runRedirectScript(guard, u, o).redirected;
check('guard: store-detail.html?store=<slug> -> /<slug>', hit('http://localhost:3000/store-detail.html?store=amina-crafts') === '/amina-crafts');
check('guard: other params and the #hash survive', hit('http://localhost:3000/store-detail.html?store=amina-crafts&q=bag#reviews') === '/amina-crafts?q=bag#reviews');
check('guard: no store named -> marketplace (never someone\'s own store)', hit('http://localhost:3000/store-detail.html') === '/marketplace');
check('guard: junk store value -> marketplace', hit('http://localhost:3000/store-detail.html?store=..%2Fevil') === '/marketplace');
check('guard: the real address /<slug> is left alone', hit('http://localhost:3000/amina-crafts') === null && hit('http://localhost:3000/amina-crafts?x=1') === null);
check('guard: a fresh redirect stamp stops a redirect loop', hit('http://localhost:3000/store-detail.html?store=amina-crafts', { stamp: Date.now() }) === null);
check('guard: an old stamp does not block a later visit', hit('http://localhost:3000/store-detail.html?store=amina-crafts', { stamp: Date.now() - 60000 }) === '/amina-crafts');
check('guard runs before the page styles and scripts load', detailHtml.indexOf(guard) < detailHtml.indexOf('css/main.css'));

// ---- 5. subscription page header ---------------------------------------------
const subHtml = read('subscription.html');
const subJs = read('js/subscription.js');
const subApi = read('nextastore-backend/src/routes/subscription.js');
check('subscription header: "My store" is not a store.html / store-detail.html link', /id="subMyStoreLink"/.test(subHtml) && !/href="store(-detail)?\.html/.test(subHtml));
check('subscription header: link is hidden until the real address is known', /id="subMyStoreLink"[^>]*\bhidden\b/.test(subHtml) && /subscription-topnav a\[hidden\]\s*\{\s*display:\s*none/.test(read('css/subscription.css')));
check('subscription.js points the link at app.storeLink({ slug })', /subMyStoreLink/.test(subJs) && /app\.storeLink\(\{\s*slug\s*\}\)/.test(subJs));
check('GET /subscription returns storeSlug', /storeSlug:\s*store\.slug/.test(subApi));

// ---- 6. closed shop = the whole screen, for shoppers only ----------------------
const sdJs = read('js/store-detail.js');
const sdCss = read('css/store-detail.css');
const closedFn = methodSource(sdJs, 'renderClosedShop(closed)');
const ownerFn = methodSource(sdJs, 'renderOwnerPreview() {');
check('closed shop is appended to <body> and flags it', /document\.body\.appendChild\(screen\)/.test(closedFn) && /classList\.add\('store-closed-public'\)/.test(closedFn));
check('closed shop no longer renders inside the products grid', !/productsGrid/.test(closedFn));
check('closed screen is fixed and fills the viewport', /\.closed-screen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/.test(sdCss));
check('closed screen hides the normal page chrome', ['.store-detail-header', '.page-breadcrumb', '.store-hero', '.store-content', '.footer'].every(sel => new RegExp('body\\.store-closed-public ' + sel.replace('.', '\\.') + '[,\\s{]').test(sdCss)));
check('closed shutter window stretches to fill the screen height', /\.closed-shop-window\s*\{[^}]*flex:\s*1 1 auto/.test(sdCss));
check('owner view is untouched: shutter over the banner, never the closed screen', /banner-shutter/.test(ownerFn) && /store-lapsed/.test(ownerFn) && !/closedShopScreen|store-closed-public/.test(ownerFn));
check('closed screen shows identity only: no payment / trial wording in its markup', !/trial|payment|subscription|renew|overdue/i.test(closedFn));
check('service worker cache is v25 or later', Number((read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/) || [])[1]) >= 25);

const failed = out.filter(o => !o.ok);
out.forEach(o => console.log((o.ok ? 'PASS  ' : 'FAIL  ') + o.n));
console.log(`\n${out.length - failed.length}/${out.length} passed`);
process.exit(failed.length ? 1 : 0);
