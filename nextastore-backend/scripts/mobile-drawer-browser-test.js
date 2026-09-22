#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the dashboard's mobile hamburger drawer (spec item 4):
 * Logout and the other footer actions must always be reachable, on any phone
 * shape, and the drawer must behave like a proper modal navigation.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:mobile-drawer-browser
 *
 * Opens the REAL dashboard.html signed in as a seller, against a tiny fake API
 * on localhost:4000, at four phone geometries (normal, short, landscape,
 * small) plus desktop and a mid-open resize.
 *
 * Cannot cover in headless Chromium: a real iOS home-indicator inset
 * (env(safe-area-inset-bottom) is 0 here) and the browser address bar
 * resizing the viewport. The CSS is checked statically instead (qa-static).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PRESENCE_TEST_PORT || 4000);

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u_s', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const USER = { id: 'u_s', name: 'Sam Seller', email: 's@example.com', role: 'seller' };

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://l').pathname;
  if (p.startsWith('/api/')) {
    req.resume();
    req.on('end', () => {
      const ORDERS = [1, 2, 3].map((n) => ({ id: `ord${n}`, customerName: `Customer With A Fairly Long Name ${n}`, total: 125000 * n, fulfillmentMethod: n === 2 ? 'pickup' : 'delivery', status: 'pending', createdAt: new Date(Date.now() - n * 86400000).toISOString(), store: { district: 'Kampala', address: 'Plot 12 Some Long Street Name' } }));
      const TOP = [1, 2].map((n) => ({ id: `p${n}`, name: `Best selling product number ${n}`, category: 'Fashion', price: 45000 * n, sold: 10 * n, icon: 'fa-box' }));
      const data = p === '/api/user/me' ? USER : p === '/api/store' ? { id: 's1', slug: 'acme', name: 'Acme', status: 'active' } : p === '/api/orders' ? ORDERS : p === '/api/products/top' ? TOP : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data, pagination: { page: 1, limit: 20, total: 0, pages: 1 } }));
    });
    return;
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let passed = 0; let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(50); } return false; }

const PHONES = [
  { name: 'phone 390x844', w: 390, h: 844 },
  { name: 'short phone 360x560', w: 360, h: 560 },
  { name: 'landscape 667x375', w: 667, h: 375 },
  { name: 'small 320x480', w: 320, h: 480 }
];

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}). Stop whatever is using it or set PRESENCE_TEST_PORT.`);
    process.exit(2);
  });
  const browser = await chromium.launch({ channel: 'chromium' });
  const errors = [];
  const open = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', JSON.stringify(u)); } catch (e) { /* ignore */ } }, [TOKEN, USER]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(`http://localhost:${PORT}/dashboard.html`);
    await page.waitForSelector('#menuToggle', { state: 'attached', timeout: 8000 });
    await sleep(700);
    return { ctx, page };
  };
  const geo = (page) => page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.y + b.height }; };
    const sb = document.getElementById('dashboardSidebar');
    const lo = sb.querySelector('.logout-btn');
    const lr = lo.getBoundingClientRect();
    const hit = document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2);
    const nav = sb.querySelector('.sidebar-nav');
    return {
      vh: innerHeight, vw: innerWidth, sb: r(sb), logout: r(lo), toggle: r(document.getElementById('menuToggle')),
      hitIsLogout: !!hit && (hit === lo || lo.contains(hit)),
      visibility: getComputedStyle(sb).visibility,
      navScroll: [nav.scrollHeight, nav.clientHeight, getComputedStyle(nav).overflowY],
      expanded: document.getElementById('menuToggle').getAttribute('aria-expanded'),
      label: document.getElementById('menuToggle').getAttribute('aria-label'),
      overlay: document.getElementById('sidebarOverlay').classList.contains('active'),
      bodyLocked: getComputedStyle(document.body).overflow.includes('hidden') && document.body.classList.contains('drawer-open'),
      focusInSidebar: sb.contains(document.activeElement),
      navItems: [...sb.querySelectorAll('.nav-item')].map((el) => el.getBoundingClientRect().height)
    };
  });

  try {
    for (const ph of PHONES) {
      const { ctx, page } = await open(ph.w, ph.h);
      const tag = `[${ph.name}] `;
      let g = await geo(page);
      check(tag + 'closed drawer is out of the accessibility tree / tab order (visibility:hidden)', g.visibility === 'hidden', g.visibility);
      check(tag + 'hamburger is at least 44x44 and starts collapsed', g.toggle.w >= 44 && g.toggle.h >= 44 && g.expanded === 'false', JSON.stringify(g.toggle));

      const mainBefore = await page.evaluate(() => { const m = document.querySelector('.main-content').getBoundingClientRect(); return [m.x, m.width]; });
      await page.click('#menuToggle');
      await waitFor(async () => (await geo(page)).sb.x >= -1 && (await geo(page)).visibility === 'visible');
      await sleep(350);
      g = await geo(page);
      check(tag + 'opening: toggle reports expanded + "Close menu", overlay shown', g.expanded === 'true' && g.label === 'Close menu' && g.overlay, JSON.stringify([g.expanded, g.label, g.overlay]));
      check(tag + 'the drawer is pinned to the top edge and its bottom does not run past the screen', Math.abs(g.sb.y) < 0.5 && g.sb.b <= g.vh + 0.5, JSON.stringify(g.sb));
      check(tag + 'Logout is fully inside the visible screen', g.logout.y >= 0 && g.logout.b <= g.vh + 0.5 && g.logout.x >= 0 && g.logout.x + g.logout.w <= g.vw, JSON.stringify(g.logout));
      check(tag + 'Logout is what a tap there actually hits (nothing overlaps it)', g.hitIsLogout);
      check(tag + 'Logout is at least 44x44', g.logout.h >= 44 && g.logout.w >= 44, JSON.stringify(g.logout));
      check(tag + 'every nav item is at least 44px tall', g.navItems.every((h) => h >= 44), JSON.stringify(g.navItems));
      if (g.navScroll[0] > g.navScroll[1]) {
        check(tag + 'a nav list taller than the space scrolls on its own (overflow-y:auto) instead of pushing Logout off', /auto|scroll/.test(g.navScroll[2]), JSON.stringify(g.navScroll));
        await page.evaluate(() => { const n = document.querySelector('.sidebar-nav'); n.scrollTop = n.scrollHeight; });
        g = await geo(page);
        check(tag + 'Logout is still on screen with the nav scrolled to its end', g.logout.b <= g.vh + 0.5 && g.hitIsLogout);
      }
      const mainAfter = await page.evaluate(() => { const m = document.querySelector('.main-content').getBoundingClientRect(); return [m.x, m.width]; });
      check(tag + 'opening the drawer does not shift or resize the page beneath (no layout shift)', mainBefore[0] === mainAfter[0] && mainBefore[1] === mainAfter[1], JSON.stringify([mainBefore, mainAfter]));
      check(tag + 'the page underneath is scroll-locked while the drawer is open', g.bodyLocked);

      // Tab stays inside the modal drawer
      await page.evaluate(() => document.querySelector('#dashboardSidebar .nav-item').focus());
      let stayed = true;
      for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); if (!(await geo(page)).focusInSidebar) { stayed = false; break; } }
      check(tag + 'Tab cycles within the open drawer (focus never escapes to the dimmed page)', stayed);

      // Escape
      await page.keyboard.press('Escape');
      await sleep(400);
      g = await geo(page);
      check(tag + 'Escape closes it, returns focus to the hamburger, and releases the scroll lock',
        g.expanded === 'false' && !g.overlay && !g.bodyLocked && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'menuToggle', JSON.stringify([g.expanded, g.overlay, g.bodyLocked]));
      check(tag + 'once closed it is out of the tab order again', g.visibility === 'hidden', g.visibility);

      // Overlay tap
      await page.click('#menuToggle'); await sleep(350);
      await page.mouse.click(Math.min(ph.w - 8, 300), 60);
      await sleep(400);
      g = await geo(page);
      check(tag + 'tapping the dimmed area closes the drawer', g.expanded === 'false' && !g.overlay && !g.bodyLocked, JSON.stringify([g.expanded, g.overlay]));

      // Choose a section
      await page.click('#menuToggle'); await sleep(350);
      await page.click('#dashboardSidebar .nav-item[data-section="orders"]');
      await sleep(400);
      g = await geo(page);
      check(tag + 'choosing a section closes the drawer AND keeps the toggle state in sync', g.expanded === 'false' && !g.overlay && !g.bodyLocked, JSON.stringify([g.expanded, g.overlay, g.bodyLocked]));
      await ctx.close();
    }

    // Mid-open resize to a wide screen
    {
      const { ctx, page } = await open(600, 800);
      await page.click('#menuToggle'); await sleep(350);
      await page.setViewportSize({ width: 1100, height: 800 });
      await sleep(500);
      const g = await geo(page);
      check('[resize] widening past the breakpoint with the drawer open clears the overlay and the scroll lock', !g.overlay && !g.bodyLocked, JSON.stringify([g.overlay, g.bodyLocked]));
      check('[resize] ...and the sidebar is simply visible as the desktop layout', g.visibility === 'visible' && Math.abs(g.sb.x) < 1 && Math.abs(g.sb.y) < 0.5, JSON.stringify(g.sb));
      check('[desktop] Logout is on screen and clickable', g.logout.b <= g.vh + 0.5 && g.hitIsLogout);
      await ctx.close();
    }

    // Data tables become card stacks (or at least fully reachable) under 768px.
    {
      const { ctx, page } = await open(390, 844);
      await page.click('#menuToggle'); await sleep(350);
      await page.click('#dashboardSidebar .nav-item[data-section="orders"]');
      await waitFor(async () => (await page.locator('.order-status-select').count()) === 3, 6000);
      await sleep(300);
      const t = await page.evaluate(() => {
        const vw = innerWidth;
        const within = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.x >= -0.5 && r.x + r.width <= vw + 0.5; };
        const selects = [...document.querySelectorAll('.order-status-select')];
        const views = [...document.querySelectorAll('[data-view-seller-order]')];
        const tr = document.querySelector('#ordersList tbody tr');
        const cell = tr && tr.querySelector('td');
        return {
          pageOverflow: document.documentElement.scrollWidth > vw + 1,
          allSelectsReachable: selects.length === 3 && selects.every(within),
          allViewsReachable: views.length === 3 && views.every(within),
          selectH: Math.min(...selects.map((x) => x.getBoundingClientRect().height)),
          viewH: Math.min(...views.map((x) => x.getBoundingClientRect().height)),
          cardStack: !!tr && getComputedStyle(tr).display === 'block' && getComputedStyle(cell).display !== 'table-cell',
          labelled: [...document.querySelectorAll('#ordersList tbody tr:first-child td')].filter((td) => td.hasAttribute('data-label')).length
        };
      });
      check('[orders 390px] the page itself does not scroll sideways', !t.pageOverflow, JSON.stringify(t));
      check('[orders 390px] every order\'s Status control and View button are fully on screen (not clipped by the table)', t.allSelectsReachable && t.allViewsReachable, JSON.stringify(t));
      check('[orders 390px] rows are stacked as cards, each value carrying its column label', t.cardStack && t.labelled >= 6, JSON.stringify(t));
      check('[orders 390px] Status select and View button are at least 44px tall', t.selectH >= 44 && t.viewH >= 44, JSON.stringify([t.selectH, t.viewH]));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(1280, 800);
      await page.click('.nav-item[data-section="orders"]');
      await waitFor(async () => (await page.locator('.order-status-select').count()) === 3, 6000);
      const d = await page.evaluate(() => { const tr = document.querySelector('#ordersList tbody tr'); return { row: getComputedStyle(tr).display, thead: getComputedStyle(document.querySelector('#ordersList thead')).display }; });
      check('[orders 1280px] desktop keeps the real table (header row visible, rows are table rows)', d.row === 'table-row' && d.thead !== 'none', JSON.stringify(d));
      await ctx.close();
    }

    // Account menu on the other pages: Log out must stay in view even when the panel scrolls.
    for (const [w, h] of [[360, 400], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', JSON.stringify(u)); } catch (e) { /* ignore */ } }, [TOKEN, USER]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e.message || e)));
      await page.goto(`http://localhost:${PORT}/marketplace.html`);
      await page.waitForSelector('[data-account-trigger]', { timeout: 8000 });
      await sleep(600);
      await page.click('[data-account-trigger]');
      await sleep(400);
      const a = await page.evaluate(() => {
        const lo = document.querySelector('[data-account-action="logout"]');
        const r = lo.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { vh: innerHeight, top: r.y, bottom: r.y + r.height, h: r.height, w: r.width, hit: !!hit && (hit === lo || lo.contains(hit)) };
      });
      const tag = `[account menu ${w}x${h}] `;
      check(tag + 'Log out is fully on screen without scrolling the panel, and tappable', a.top >= 0 && a.bottom <= a.vh + 0.5 && a.hit, JSON.stringify(a));
      check(tag + 'Log out is at least 44x44', a.h >= 44 && a.w >= 44, JSON.stringify(a));
      await ctx.close();
    }

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${passed}/${passed + failed} mobile drawer browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
