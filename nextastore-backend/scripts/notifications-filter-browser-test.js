#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the bell panel's All | Unread filter (js/main.js) and
 * GET /notifications?unread=1 (as the page drives it):
 *
 *   - the switch exists, starts on All every time the bell opens, and shows
 *     the server's unread total;
 *   - Unread reaches unread items OLDER than the newest 30 (the case the
 *     filter exists for) and lists nothing that is read;
 *   - tapping an item there clears its dot but leaves the row until the filter
 *     is re-entered, and the count drops;
 *   - Mark all as read empties the view at once and restores it if refused;
 *   - it says so when more than 30 unread exist;
 *   - it draws instantly from what is known even when the server is slow;
 *   - it still works against a server that ignores ?unread=1;
 *   - new notifications show up in an open Unread view.
 *
 *   npm run test:notifications-filter-browser
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
const db = { notifications: [], listDelayMs: 0, readAllDelayMs: 0, readAllFails: false, ignoreUnreadParam: false };
function addNotification(over = {}) {
  seq += 1;
  db.notifications.unshift({ id: `n${seq}`, type: 'order_update', title: `Title ${seq}`, body: `Body ${seq}`, link: `orders.html?order=o${seq}`, createdAt: new Date(Date.now() - (100000 - seq) * 1000).toISOString(), readAt: null, acknowledgedAt: null, ...over });
  return `n${seq}`;
}
const READ = () => ({ readAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() });
const byId = (id) => db.notifications.find((n) => n.id === id);
const resetDb = () => { db.notifications = []; db.listDelayMs = 0; db.readAllDelayMs = 0; db.readAllFails = false; db.ignoreUnreadParam = false; };

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (p.startsWith('/api/')) {
    req.resume();
    req.on('end', async () => {
      const now = new Date().toISOString();
      if (p === '/api/user/me') return json(res, { data: USER });
      if (p === '/api/notifications/unread-count') return json(res, { data: { count: db.notifications.filter((n) => !n.acknowledgedAt).length } });
      if (p === '/api/notifications' && req.method === 'GET') {
        const unreadOnly = u.searchParams.get('unread') === '1' && !db.ignoreUnreadParam;   // like routes/notifications.js (or a server that predates it)
        const rows = db.notifications.filter((n) => !unreadOnly || !n.readAt).slice(0, 30);
        const snapshot = JSON.parse(JSON.stringify(rows));
        const unreadCount = db.notifications.filter((n) => !n.readAt).length;
        if (db.listDelayMs) await sleep(db.listDelayMs);
        return json(res, { data: snapshot, unreadCount, bellCount: db.notifications.filter((n) => !n.acknowledgedAt).length });
      }
      if (p === '/api/notifications/acknowledge' && req.method === 'PUT') { db.notifications.forEach((n) => { if (!n.acknowledgedAt) n.acknowledgedAt = now; }); return json(res, { data: { ok: true } }); }
      if (p === '/api/notifications/read-all' && req.method === 'PUT') {
        if (db.readAllDelayMs) await sleep(db.readAllDelayMs);
        if (db.readAllFails) return json(res, { error: 'nope' }, 500);
        db.notifications.forEach((n) => { if (!n.readAt) { n.readAt = now; n.acknowledgedAt = now; } });
        return json(res, { data: { ok: true } });
      }
      const m = p.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (m && req.method === 'PUT') {
        const n = byId(decodeURIComponent(m[1])); if (!n) return json(res, { error: 'Notification not found.' }, 404);
        n.readAt = now; n.acknowledgedAt = n.acknowledgedAt || now; return json(res, { data: n });
      }
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
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(50); } return false; }

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

    const rows = () => page.evaluate(() => [...document.querySelectorAll('.notification-preview-item')].map((el) => ({ title: el.querySelector('strong')?.textContent, unread: el.classList.contains('is-unread'), dot: !!el.querySelector('.notification-unread-dot') })));
    const titles = async () => (await rows()).map((r) => r.title);
    const dotCount = async () => (await rows()).filter((r) => r.dot).length;
    const tab = () => page.evaluate(() => { const b = document.querySelector('[data-notification-filter="unread"]'); const c = b.querySelector('[data-notification-filter-count]'); return { pressed: b.getAttribute('aria-pressed'), count: c.classList.contains('hidden') ? '' : c.textContent, allPressed: document.querySelector('[data-notification-filter="all"]').getAttribute('aria-pressed') }; });
    const panelText = () => page.evaluate(() => document.querySelector('[data-notification-preview-list]').innerText);
    const openBell = () => page.click('[data-notification-nav]');
    const closeBell = () => page.evaluate(() => document.body.click());
    const chooseUnread = () => page.click('[data-notification-filter="unread"]');
    const chooseAll = () => page.click('[data-notification-filter="all"]');
    const clickItem = (title) => page.locator('.notification-preview-item', { hasText: title }).first().click({ modifiers: ['Control'] });
    const load = async () => { await page.goto(`http://localhost:${PORT}/messages.html`); await waitFor(() => page.evaluate(() => !!window.app && !!app.token)); };

    // ================= A. more than 30 notifications: 3 old UNREAD ones sit behind 32 newer READ ones
    for (let i = 1; i <= 3; i++) addNotification({ title: `Old unread ${i}` });
    for (let i = 1; i <= 32; i++) addNotification({ title: `Newer read ${i}`, ...READ() });
    await load();
    await openBell();
    check('the panel has an All | Unread switch, starting on All', await waitFor(async () => (await rows()).length === 30) && (await tab()).allPressed === 'true' && (await tab()).pressed === 'false', JSON.stringify(await tab()));
    check('the Unread tab carries the server\'s unread total (3), which is more than any dot on screen', await waitFor(async () => (await tab()).count === '3'), JSON.stringify(await tab()));
    check('All shows only the newest 30 — every one read, so no dots (the 3 unread are out of reach here)', (await dotCount()) === 0 && !(await titles()).some((t) => /Old unread/.test(t)));

    await chooseUnread();
    check('Unread reaches the 3 unread items older than the newest 30', await waitFor(async () => { const t = await titles(); return t.length === 3 && t.every((x) => /^Old unread/.test(x)); }), JSON.stringify(await titles()));
    check('...each with its dot, and nothing read is listed', (await dotCount()) === 3 && (await rows()).every((r) => r.unread));
    check('the switch shows Unread pressed (aria-pressed) and All not', await (async () => { const t = await tab(); return t.pressed === 'true' && t.allPressed === 'false'; })());

    // tapping an item on the Unread view
    await clickItem('Old unread 2');
    check('tapping an item on Unread clears its dot...', await waitFor(async () => (await rows()).find((r) => r.title === 'Old unread 2')?.dot === false), JSON.stringify(await rows()));
    check('...but the row stays listed (the list does not jump under the tap)', (await titles()).length === 3);
    check('...and the Unread count drops to 2', await waitFor(async () => (await tab()).count === '2'), JSON.stringify(await tab()));
    check('...and the server recorded the read', await waitFor(() => byId('n2').readAt !== null, 2000));
    await chooseAll();
    await waitFor(async () => (await rows()).length === 30);
    check('the count stays 2 after going back to All (no double subtraction)', (await tab()).count === '2', JSON.stringify(await tab()));
    await chooseUnread();
    check('re-entering Unread drops the row that was read', await waitFor(async () => { const t = await titles(); return t.length === 2 && !t.includes('Old unread 2'); }), JSON.stringify(await titles()));
    check('...and does not flash "all caught up" on the way (the list is never empty while unread exist)', !/caught up/.test(await panelText()));

    // close / re-open resets the filter
    await closeBell();
    await openBell();
    check('re-opening the bell starts on All again', await waitFor(async () => (await tab()).allPressed === 'true' && (await tab()).pressed === 'false'), JSON.stringify(await tab()));

    // Mark all as read on the Unread view
    await chooseUnread();
    await waitFor(async () => (await titles()).length === 2);
    db.readAllDelayMs = 800;
    await page.click('[data-notification-read-all]');
    check('Mark all empties the Unread view immediately ("all caught up"), before the server answers', await waitFor(async () => /all caught up/i.test(await panelText()), 300), await panelText());
    check('...and the count disappears', (await tab()).count === '');
    check('...and the server ends up with nothing unread', await waitFor(() => db.notifications.every((n) => n.readAt), 3000));
    db.readAllDelayMs = 0;

    // refused Mark all restores the list
    addNotification({ title: 'Fresh A' });
    addNotification({ title: 'Fresh B' });
    await page.evaluate(() => app.refreshOpenNotificationLists());
    await waitFor(async () => (await titles()).length === 2);
    db.readAllFails = true; db.readAllDelayMs = 500;
    await page.click('[data-notification-read-all]');
    check('a refused Mark all first empties the view...', await waitFor(async () => /all caught up/i.test(await panelText()), 300));
    check('...then puts both unread items (with dots) back', await waitFor(async () => (await titles()).length === 2 && (await dotCount()) === 2, 3000), JSON.stringify(await rows()));
    db.readAllFails = false; db.readAllDelayMs = 0;

    // a new notification while the Unread view is open
    addNotification({ title: 'Arrived while filtered' });
    await page.evaluate(() => app.refreshUnreadBadges());
    check('a new notification appears in an open Unread view on the next tick', await waitFor(async () => (await titles()).includes('Arrived while filtered'), 3000), JSON.stringify(await titles()));

    if (process.env.NEXTA_TEST_SHOT) await page.screenshot({ path: process.env.NEXTA_TEST_SHOT, clip: { x: 760, y: 0, width: 520, height: 560 } });

    // ================= B. instant from memory even when the server is slow
    resetDb();
    for (let i = 1; i <= 4; i++) addNotification({ title: `Mixed read ${i}`, ...READ() });
    addNotification({ title: 'Mixed unread X' });
    addNotification({ title: 'Mixed unread Y' });
    await load();
    await openBell();
    await waitFor(async () => (await rows()).length === 6);
    db.listDelayMs = 1500;
    await chooseUnread();
    check('Unread draws its rows within 300ms although the server takes 1.5s (from what is already known)', await waitFor(async () => { const t = await titles(); return t.length === 2 && t.includes('Mixed unread X') && t.includes('Mixed unread Y'); }, 300), JSON.stringify(await titles()));
    await sleep(1700);
    db.listDelayMs = 0;
    check('...and it is still right after the server\'s answer lands', (await titles()).length === 2 && (await dotCount()) === 2);

    // ================= C. an older server that ignores ?unread=1 (returns everything)
    resetDb();
    db.ignoreUnreadParam = true;
    for (let i = 1; i <= 5; i++) addNotification({ title: `Legacy read ${i}`, ...READ() });
    addNotification({ title: 'Legacy unread' });
    await load();
    await openBell();
    await waitFor(async () => (await rows()).length === 6);
    await chooseUnread();
    await sleep(500);
    check('against a server that ignores ?unread=1 the filter still lists only the unread item', (await titles()).join('|') === 'Legacy unread', JSON.stringify(await titles()));

    // ================= D. more than 30 unread: say so
    resetDb();
    for (let i = 1; i <= 35; i++) addNotification({ title: `Bulk ${i}` });
    await load();
    await openBell();
    await waitFor(async () => (await rows()).length === 30);
    await chooseUnread();
    check('with 35 unread, Unread lists 30 and says "Showing your newest 30 of 35 unread."', await waitFor(async () => (await rows()).length === 30 && /newest 30 of 35 unread/.test(await panelText()), 3000), await panelText());
    check('...and the tab count is 35', (await tab()).count === '35', JSON.stringify(await tab()));

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} notification-filter browser checks passed.`);
  process.exit(failed ? 1 : 0);
})();
