#!/usr/bin/env node
'use strict';
/*
 * Clean URLs (no .html) - guards and behaviour. No database, browser or
 * dependencies needed:   npm run test:clean-urls
 *
 * The point of these checks is that the rule keeps holding when the site
 * grows: a page added later must be clean too, so nothing here lists pages -
 * they are discovered from the files in the site root.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''));
// store-detail is the shell the API serves at /<slug>; offline is served by the worker.
const NO_SAFETY_NET = new Set(['store-detail', 'offline']);

// ---- 1. every page (including ones added later) carries the address tidier ---
{
  const missing = pages.filter(p => !NO_SAFETY_NET.has(p) && !/<script src="\/js\/clean-url\.js"><\/script>/.test(read(p + '.html')));
  check('every page in the site root loads /js/clean-url.js (offenders: ' + (missing.join(', ') || 'none') + ')', missing.length === 0);
  const lateInHead = pages.filter(p => !NO_SAFETY_NET.has(p)).filter(p => {
    const html = read(p + '.html');
    const head = html.slice(0, html.search(/<\/head>/i));
    const scripts = [...head.matchAll(/<script\b[^>]*>/g)];
    const mine = scripts.findIndex(m => /js\/clean-url\.js/.test(m[0]));
    return mine !== 0;   // it must be the very first <script> (external or inline) in the head
  });
  check('it is the first script in each <head>, so nothing runs against the .html address first (offenders: ' + (lateInHead.join(', ') || 'none') + ')', lateInHead.length === 0);
}

// ---- 2. nothing links to a .html address -------------------------------------
{
  const names = pages.filter(p => p !== 'store-detail');
  const re = new RegExp('(?<![A-Za-z0-9_\\-./\\\\])(\\.\\./|/)?(' + names.map(n => n.replace(/[-]/g, '\\-')).join('|') + ')\\.html(?![A-Za-z0-9_\\-])');
  const isComment = (l) => /^\s*(\/\/|\*|\/\*|<!--)/.test(l);
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))
    .concat(fs.readdirSync(path.join(ROOT, 'errors')).filter(f => f.endsWith('.html')).map(f => 'errors/' + f))
    .concat(fs.readdirSync(path.join(ROOT, 'js')).map(f => 'js/' + f));
  const offenders = [];
  for (const f of files) {
    let inBlock = false;
    read(f).split('\n').forEach((line, i) => {
      if (inBlock) { if (line.includes('*/') || line.includes('-->')) inBlock = false; return; }
      if (isComment(line)) { if ((/^\s*(\/\*|<!--)/.test(line)) && !/(\*\/|-->)/.test(line)) inBlock = true; return; }
      const code = line.replace(/\s\/\/\s.*$/, '');
      if (re.test(code)) offenders.push(`${f}:${i + 1}`);
    });
  }
  check('no page or script links to a page ending in .html (offenders: ' + (offenders.slice(0, 8).join(', ') || 'none') + ')', offenders.length === 0);
  const manifest = JSON.parse(read('manifest.json'));
  check('manifest start_url and shortcuts are clean (the app id stays put on purpose)',
    manifest.start_url === '/' && manifest.shortcuts.every(s => !/\.html/.test(s.url)) && manifest.id === '/index.html');

  const backend = ['src/helpers.js', 'src/seo.js', 'src/routes/admin.js', 'src/routes/auth.js', 'src/routes/orders.js', 'src/routes/products.js', 'src/routes/store.js', 'src/routes/messages.js']
    .map(f => ['nextastore-backend/' + f, read('nextastore-backend/' + f)]);
  const linkRe = /(link\s*[:=]|\/\/[^\n]*\n)?[^\n]*['"`]\/?(?:dashboard|messages|orders|subscription|product-detail|forgot-password|verify-email|marketplace|stores)\.html/;
  const bad = backend.filter(([f, src]) => src.split('\n').some(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && linkRe.test(l) && !/legacyLink|messages\.html\?conversation=\$\{conversation\.id\}/.test(l)));
  check('server-built links (notifications, emails, sitemap) are clean (offenders: ' + (bad.map(b => b[0]).join(', ') || 'none') + ')', bad.length === 0);
}

// ---- 3. js/clean-url.js behaviour ------------------------------------------------
function tidy(url) {
  const u = new URL(url);
  let replaced = null;
  const win = { location: { pathname: u.pathname, search: u.search, hash: u.hash }, history: { state: null, replaceState: (s, t, to) => { replaced = to; } } };
  vm.runInNewContext(read('js/clean-url.js'), { window: win });
  return replaced;
}
check('clean-url: /dashboard.html -> /dashboard', tidy('http://x.test/dashboard.html') === '/dashboard');
check('clean-url: query string and #hash are kept', tidy('http://x.test/product-detail.html?id=3&store=a#reviews') === '/product-detail?id=3&store=a#reviews');
check('clean-url: /index.html -> /', tidy('http://x.test/index.html') === '/' && tidy('http://x.test/index.html?x=1') === '/?x=1');
check('clean-url: an already clean address is left alone', tidy('http://x.test/dashboard') === null && tidy('http://x.test/') === null && tidy('http://x.test/amina-crafts') === null);
check('clean-url: nested paths are never touched', tidy('http://x.test/errors/404.html') === null && tidy('http://x.test/a/b.html') === null);
check('clean-url: never throws when history is missing', (() => { try { vm.runInNewContext(read('js/clean-url.js'), { window: { location: { pathname: '/a.html', search: '', hash: '' } } }); return true; } catch (e) { return false; } })());

// ---- 4. login redirect (js/auth.js safeRedirect) ---------------------------------
{
  const src = read('js/auth.js');
  const chunk = src.slice(src.indexOf('const AUTH_PAGES'), src.indexOf('class AuthManager'));
  const ctx = { SessionData: { readEnded: () => null } };
  vm.runInNewContext(chunk + '\nthis.safeRedirect = safeRedirect;', ctx);
  const seller = { id: 's1', role: 'seller' }, buyer = { id: 'b1', role: 'buyer' }, admin = { id: 'a1', role: 'admin' };
  const go = (raw, user) => ctx.safeRedirect(raw, user, null);
  check('redirect: clean page name -> /page (query kept)', go('cart?x=1', buyer) === '/cart?x=1' && go('orders', buyer) === '/orders');
  check('redirect: an old .html link lands on the clean address', go('cart.html?x=1', buyer) === '/cart?x=1' && go('index.html', buyer) === '/');
  check('redirect: a store address is opened from the site root', go('amina-crafts', buyer) === '/amina-crafts');
  check('redirect: seller-only pages stay seller-only, in every spelling', ['dashboard', 'dashboard.html', 'product-form?id=1', 'subscription', 'onboarding'].every(r => go(r, buyer) === null) && go('dashboard', seller) === '/dashboard');
  check('redirect: admin-only page stays admin-only, in every spelling', go('admin', seller) === null && go('admin.html', seller) === null && go('admin', admin) === '/admin');
  check('redirect: login/signup pages can never be a destination (no loops)', ['login', 'login.html', 'signup', 'forgot-password', 'verify-email.html'].every(r => go(r, buyer) === null));
  check('redirect: a product address (<store>/<name>-<key>) is opened from the site root, query kept, for buyers and sellers',
    go('amina-crafts/blue-sofa-x7k2m9ab', buyer) === '/amina-crafts/blue-sofa-x7k2m9ab' && go('amina-crafts/blue-sofa-x7k2m9ab?x=1', seller) === '/amina-crafts/blue-sofa-x7k2m9ab?x=1');
  check('redirect: a second part never gets past a page rule - only the first part names the page',
    go('admin/x', seller) === null && go('dashboard/x', buyer) === null && go('login/x', buyer) === null && go('admin/x', admin) === '/admin/x');
  check('redirect: hostile values are refused (no scheme, host, dot, backslash, empty or extra part)',
    ['https://evil.example', '//evil.example', 'javascript:alert(1)', '../x', '/dashboard', '', 'a/b/c', 'a//b', 'a/../b', 'a/b.html', 'a/evil.example', 'a\\b', 'a/https://evil.example', '/a/b'].every(r => go(r, seller) === null));
  check('redirect: role home pages are clean', vm.runInNewContext(chunk + '[homeFor({role:"admin"}), homeFor({role:"seller"}), homeFor({role:"buyer"})].join()', { SessionData: {} }) === '/admin,/dashboard,/marketplace');
}

// ---- 5. notification links (js/main.js) -------------------------------------------
{
  const main = read('js/main.js');
  const fn = main.slice(main.indexOf('safeInternalLink(link) {'));
  const body = fn.slice(0, fn.indexOf('\n    }\n') + 6);
  const ctx = {};
  vm.runInNewContext('const o = {' + body.replace(/^safeInternalLink/, 'safeInternalLink') + '}; this.f = o.safeInternalLink;', ctx);
  const f = ctx.f;
  check('bell link: a clean link is kept', f('/messages?conversation=abc') === '/messages?conversation=abc' && f('/dashboard#orders') === '/dashboard#orders' && f('/subscription') === '/subscription');
  check('bell link: a link saved with .html opens the clean address', f('messages.html?conversation=abc') === '/messages?conversation=abc' && f('dashboard.html#orders') === '/dashboard#orders' && f('/subscription.html') === '/subscription' && f('index.html') === '/');
  check('bell link: unsafe values still give no link', ['https://evil.example', '//evil.example', 'javascript:alert(1)', '', null, '/a b'].every(v => f(v) === ''));
  check('bell: a saved .html message link still matches the thread-open and hover patterns', /messages\(\?:\\\.html\)\?\\\?conversation=/.test(main) && (main.match(/messages\(\?:\\\.html\)\?\\\?conversation=/g) || []).length === 2);
  check('bell: settling a thread matches old and new link spellings', /replace\(\/\\\.html\(\?=\[\?#\]\|\$\)\/, ''\)/.test(main.slice(main.indexOf('settleByLink(link)'), main.indexOf('settleByLink(link)') + 300)));
}

// ---- 6. service worker ----------------------------------------------------------------
{
  const sw = read('service-worker.js');
  check('worker: offline page and precache use clean addresses (a redirected response cannot answer a navigation)',
    /const OFFLINE_URL = '\/offline';/.test(sw) && !/'\/(?:index|offline)\.html'/.test(sw));
  check('worker: cache version was bumped for this change (v27 or later)', Number((/CACHE_VERSION = 'v(\d+)'/.exec(sw) || [])[1]) >= 27);
}

// ---- 7. server rules ----------------------------------------------------------------------
{
  const readme = read('nextastore-backend/README.md');
  const m = /if \(\$request_uri ~ "([^"]+)"\) \{ return 301 (\S+); \}/.exec(readme);
  check('README: the nginx clean-URL rule is documented', !!m);
  if (m) {
    const re = new RegExp(m[1].replace(/\\\\/g, '\\'));
    const out = (u) => { const x = re.exec(u); return x ? '/' + x[1] + (x[2] || '') : null; };
    check('nginx rule: /login.html -> /login, query kept; clean and nested paths untouched',
      out('/login.html') === '/login' && out('/product-detail.html?id=1&store=a') === '/product-detail?id=1&store=a' && out('/login') === null && out('/errors/404.html') === null && out('/css/main.css') === null);
    check('nginx rule works for a page that does not exist yet (no page list)', out('/brand-new-page.html?x=1') === '/brand-new-page?x=1');
  }
  check('README: try_files serves /name from name.html', /try_files \$uri \$uri\.html \$uri\/ @api;/.test(readme));
  check('local launcher serves clean addresses (http-server -e html)', /http-server \. -p 3000 -e html /.test(read('start-local.bat')));
  const reserved = read('nextastore-backend/src/slugs.js');
  const unreserved = pages.filter(p => !new RegExp("'" + p + "'").test(reserved));
  check('every page address is a reserved store slug, so no store can take /' + (unreserved[0] || 'page') + ' (offenders: ' + (unreserved.join(', ') || 'none') + ')', unreserved.length === 0);
}

console.log(`\n${passed}/${passed + failed} clean-URL checks passed.`);
process.exit(failed ? 1 : 0);
