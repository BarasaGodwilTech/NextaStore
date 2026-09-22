#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the two-tier notification behaviour (spec item 2):
 *
 *   - tapping the bell clears the EXTERIOR badge, and only that;
 *   - items inside the dropdown stay visibly unread until that item is
 *     tapped (or "Mark all as read" is used);
 *   - the state survives a reload, because it lives on the server.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:notifications-browser
 *
 * Runs the REAL bell from js/main.js on the REAL messages.html against a
 * small STATEFUL fake of routes/notifications.js on localhost:4000 (readAt /
 * acknowledgedAt tracked per row, same semantics as the real routes). It does
 * not prove the real routes behave that way — read them against
 * src/routes/notifications.js — only that the page drives them correctly.
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
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u_buyer', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const USER = { id: 'u_buyer', name: 'Bea Buyer', email: 'bea@example.com', role: 'buyer' };

let seq = 0;
const db = { notifications: [], listDelayMs: 0, calls: [] };
function addNotification(over = {}) {
  seq += 1;
  db.notifications.unshift({ id: `n${seq}`, type: 'order_update', title: `Title ${seq}`, body: `Body ${seq}`, link: `orders.html?order=o${seq}`, createdAt: new Date(Date.now() - (100 - seq) * 1000).toISOString(), readAt: null, acknowledgedAt: null, ...over });
  return `n${seq}`;
}
const byId = (id) => db.notifications.find((n) => n.id === id);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (p.startsWith('/api/')) {
    req.resume();
    req.on('end', async () => {
      db.calls.push(`${req.method} ${p}`);
      const now = new Date().toISOString();
      if (p === '/api/notifications/unread-count') return json(res, { data: { count: db.notifications.filter((n) => !n.acknowledgedAt).length } });
      if (p === '/api/notifications' && req.method === 'GET') {
        if (db.listDelayMs) await new Promise((r) => setTimeout(r, db.listDelayMs));
        return json(res, { data: db.notifications.slice(0, 30), unreadCount: db.notifications.filter((n) => !n.readAt).length, bellCount: db.notifications.filter((n) => !n.acknowledgedAt).length });
      }
      if (p === '/api/notifications/acknowledge' && req.method === 'PUT') { db.notifications.forEach((n) => { if (!n.acknowledgedAt) n.acknowledgedAt = now; }); return json(res, { data: { ok: true } }); }
      if (p === '/api/notifications/read-all' && req.method === 'PUT') { db.notifications.forEach((n) => { if (!n.readAt) { n.readAt = now; n.acknowledgedAt = now; } }); return json(res, { data: { ok: true } }); }
      const m = p.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (m && req.method === 'PUT') { const n = byId(decodeURIComponent(m[1])); if (!n) return json(res, { error: 'Notification not found.' }, 404); n.readAt = now; n.acknowledgedAt = n.acknowledgedAt || now; return json(res, { data: n }); }
      return json(res, { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
    });
    return;
  }
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let passed = 0; let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(60); } return false; }

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}). Stop whatever is using it or set PRESENCE_TEST_PORT.`);
    process.exit(2);
  });
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(([token, user]) => {
      try { localStorage.setItem('nextastore_token', token); localStorage.setItem('nextastore_user', JSON.stringify(user)); } catch (e) { /* ignore */ }
    }, [TOKEN, USER]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));

    // Seed: two unread with links, one already read, one unread with NO link.
    addNotification({ title: 'Old read one', readAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() });
    const idA = addNotification({ title: 'Order shipped' });
    const idB = addNotification({ title: 'New message' , link: 'messages.html?conversation=c1' });
    const idNoLink = addNotification({ title: 'Plan reminder', link: null });

    const badge = () => page.evaluate(() => { const b = document.querySelector('[data-notification-nav-badge]'); return b ? { hidden: b.classList.contains('hidden'), text: b.textContent } : null; });
    const items = () => page.evaluate(() => [...document.querySelectorAll('.notification-preview-item')].map((el) => ({ title: el.querySelector('strong')?.textContent, unread: el.classList.contains('is-unread') })));
    const unreadTitles = async () => (await items()).filter((i) => i.unread).map((i) => i.title).sort();
    const bellOpen = () => page.evaluate(() => !!document.querySelector('[data-notification-nav-wrap].open'));

    await page.goto(`http://localhost:${PORT}/messages.html`);
    check('the bell badge shows the number of unacknowledged notifications (3)', await waitFor(async () => { const b = await badge(); return b && !b.hidden && b.text === '3'; }), JSON.stringify(await badge()));

    // ---- tier 1: bell
    await page.click('[data-notification-nav]');
    check('opening the bell clears the exterior badge to 0', await waitFor(async () => (await badge()).hidden), JSON.stringify(await badge()));
    check('...but the unopened items are still marked unread inside the dropdown', await waitFor(async () => (await unreadTitles()).length === 3), JSON.stringify(await items()));
    check('...and the item that was already read is NOT highlighted', (await items()).find((i) => i.title === 'Old read one')?.unread === false);
    check('the server stamped acknowledgedAt only — readAt untouched', db.notifications.every((n) => n.acknowledgedAt) && byId(idA).readAt === null && byId(idB).readAt === null);

    // ---- survives reload
    await page.reload();
    await sleep(800);
    check('after a reload the badge is still 0 (state is server-side, not a local flag)', (await badge()).hidden, JSON.stringify(await badge()));
    await page.click('[data-notification-nav]');
    check('...and the items are still unread after the reload', await waitFor(async () => (await unreadTitles()).length === 3), JSON.stringify(await items()));

    // ---- tier 2: tapping an item
    const clickItem = async (title) => { await page.locator('.notification-preview-item', { hasText: title }).first().click({ modifiers: ['Control'] }); }; // Ctrl: read-mark without navigating away
    await clickItem('Order shipped');
    check('tapping one item marks just that one read on the server', await waitFor(() => byId(idA).readAt !== null && byId(idB).readAt === null && byId(idNoLink).readAt === null), JSON.stringify(db.notifications.map((n) => [n.title, !!n.readAt])));
    check('...and its unread highlight disappears while the others keep theirs', await waitFor(async () => { const u = await unreadTitles(); return u.length === 2 && !u.includes('Order shipped'); }), JSON.stringify(await unreadTitles()));

    // ---- link-less item
    await clickItem('Plan reminder');
    check('an item with no link can still be marked read by tapping it', await waitFor(() => byId(idNoLink).readAt !== null), JSON.stringify(db.notifications.map((n) => [n.title, !!n.readAt])));
    check('...and loses its highlight', await waitFor(async () => !(await unreadTitles()).includes('Plan reminder')), JSON.stringify(await items()));

    // ---- new arrival while items are unread
    const idC = addNotification({ title: 'Fresh arrival' });
    await page.evaluate(() => app.refreshNotificationBadge());
    check('a new notification brings the badge back as 1 (old unread items do not count again)', await waitFor(async () => { const b = await badge(); return !b.hidden && b.text === '1'; }), JSON.stringify(await badge()));
    await page.keyboard.press('Escape');
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.click('[data-notification-nav]');
    if (!(await bellOpen())) await page.click('[data-notification-nav]');
    check('opening the bell again clears it back to 0', await waitFor(async () => (await badge()).hidden), JSON.stringify(await badge()));
    check('the new item sits unread alongside the earlier still-unread one', await waitFor(async () => { const u = await unreadTitles(); return u.includes('Fresh arrival') && u.includes('New message'); }), JSON.stringify(await unreadTitles()));

    // ---- slow list must not delay clearing the badge
    addNotification({ title: 'Another one' });
    await page.evaluate(() => app.refreshNotificationBadge());
    await waitFor(async () => !(await badge()).hidden);
    await page.click('body', { position: { x: 5, y: 5 } });
    await sleep(200);
    db.listDelayMs = 1800;
    await page.click('[data-notification-nav]');
    const cleared = await waitFor(async () => (await badge()).hidden, 700);
    check('the badge clears immediately on tap, without waiting for a slow list request', cleared, JSON.stringify(await badge()));
    db.listDelayMs = 0;
    await waitFor(async () => (await items()).length > 0, 4000);

    // ---- mark all as read
    const label = await page.evaluate(() => document.querySelector('[data-notification-read-all]')?.textContent.trim());
    check('the batch action is labelled "Mark all as read"', label === 'Mark all as read', JSON.stringify(label));
    await page.click('[data-notification-read-all]');
    check('"Mark all as read" clears every item’s unread state', await waitFor(async () => (await unreadTitles()).length === 0 && db.notifications.every((n) => n.readAt)), JSON.stringify(await items()));
    check('...and the badge stays at 0', (await badge()).hidden);

    // ---- touch target (spec: 44x44 minimum) on a phone-sized viewport
    await page.setViewportSize({ width: 390, height: 780 });
    await page.reload();
    await sleep(600);
    await page.click('[data-notification-nav]');
    const box = await page.locator('[data-notification-read-all]').boundingBox();
    check('"Mark all as read" is at least 44x44 on a phone', !!box && box.height >= 44 && box.width >= 44, JSON.stringify(box));
    const bellBox = await page.locator('[data-notification-nav]').boundingBox();
    check('the bell itself is at least 44x44 on a phone', !!bellBox && bellBox.height >= 44 && bellBox.width >= 44, JSON.stringify(bellBox));

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${passed}/${passed + failed} notification browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
