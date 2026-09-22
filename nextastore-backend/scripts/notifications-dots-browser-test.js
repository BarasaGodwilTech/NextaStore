#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the item-level unread dot and the client notification
 * store behind it (js/main.js: NotificationStore + the bell panel):
 *
 *   - every unread item has a colour dot; read items don't; the dot's colour
 *     is not the bell badge's;
 *   - opening the bell clears the exterior count but NOT the dots, and they
 *     are still there when the panel is closed and re-opened — drawn from
 *     memory instantly even when the server is slow;
 *   - a dot clears only for the item that was tapped, and stays cleared even
 *     if a list response that was already in flight says otherwise;
 *   - Mark all as read clears every dot at once and puts them back if the
 *     server refuses; a failed single mark-read is retried;
 *   - opening a message thread settles that thread's item; open panels pick
 *     up new notifications; all returned items (not just 10) are shown;
 *   - session end wipes the in-memory copies.
 *
 *   npm run test:notifications-dots-browser
 *
 * Runs the REAL bell on the REAL messages.html against a stateful fake of
 * routes/notifications.js. The fake snapshots the list when a request ARRIVES
 * (before any artificial delay), like a database read would, so a slow
 * response is genuinely stale.
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
const db = { notifications: [], listDelayMs: 0, putDelayMs: 0, readAllDelayMs: 0, readAllFails: false, failReadOnce: false };
function addNotification(over = {}) {
  seq += 1;
  db.notifications.unshift({ id: `n${seq}`, type: 'order_update', title: `Title ${seq}`, body: `Body ${seq}`, link: `orders.html?order=o${seq}`, createdAt: new Date(Date.now() - (1000 - seq) * 1000).toISOString(), readAt: null, acknowledgedAt: null, ...over });
  return `n${seq}`;
}
const byId = (id) => db.notifications.find((n) => n.id === id);

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
        const snapshot = JSON.parse(JSON.stringify(db.notifications.slice(0, 30)));   // read NOW, answer later
        if (db.listDelayMs) await sleep(db.listDelayMs);
        return json(res, { data: snapshot });
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
        if (db.putDelayMs) await sleep(db.putDelayMs);
        if (db.failReadOnce) { db.failReadOnce = false; return json(res, { error: 'boom' }, 500); }
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

    // Seed: 1 read + 12 unread = 13 rows (more than the old 10-row cut-off) — one links to a thread, one has no link.
    addNotification({ title: 'Old read one', readAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() });
    for (let i = 1; i <= 9; i++) addNotification({ title: `Filler ${i}` });
    const idA = addNotification({ title: 'Order shipped' });
    const idB = addNotification({ title: 'New message', link: 'messages.html?conversation=c1' });
    const idNoLink = addNotification({ title: 'Plan reminder', link: null });

    const rows = () => page.evaluate(() => [...document.querySelectorAll('.notification-preview-item')].map((el) => ({
      title: el.querySelector('strong')?.textContent, unread: el.classList.contains('is-unread'), dot: !!el.querySelector('.notification-unread-dot'), attr: el.dataset.notificationUnread
    })));
    const dotTitles = async () => (await rows()).filter((r) => r.dot).map((r) => r.title).sort();
    const dotCount = async () => (await rows()).filter((r) => r.dot).length;
    const badge = () => page.evaluate(() => { const b = document.querySelector('[data-notification-nav-badge]'); return b ? { hidden: b.classList.contains('hidden'), text: b.textContent } : null; });
    const clickItem = (title) => page.locator('.notification-preview-item', { hasText: title }).first().click({ modifiers: ['Control'] });   // Ctrl: mark read without navigating away
    const openBell = () => page.click('[data-notification-nav]');
    const closeBell = () => page.evaluate(() => document.body.click());

    await page.goto(`http://localhost:${PORT}/messages.html`);
    await waitFor(async () => { const b = await badge(); return b && !b.hidden; });

    // ---- 1. the dot itself
    await openBell();
    check('every returned item is listed — 13 rows, not capped at 10', await waitFor(async () => (await rows()).length === 13), String((await rows()).length));
    check('each of the 12 unread items has a dot; the read one does not', (await dotCount()) === 12 && (await rows()).find((r) => r.title === 'Old read one').dot === false, JSON.stringify(await rows()));
    check('dot presence always agrees with the item\'s unread state', (await rows()).every((r) => r.dot === r.unread && (r.attr === '1') === r.unread));
    const colours = await page.evaluate(() => ({ dot: getComputedStyle(document.querySelector('.notification-unread-dot')).backgroundColor, badge: getComputedStyle(document.querySelector('[data-notification-nav-badge]')).backgroundColor }));
    check('the dot colour is not the bell badge colour (two different meanings)', colours.dot !== colours.badge, JSON.stringify(colours));
    check('the dot is decorative (aria-hidden) and unread items say "Unread" to screen readers', await page.evaluate(() => document.querySelector('.notification-unread-dot').getAttribute('aria-hidden') === 'true' && /Unread/.test(document.querySelector('.notification-unread-label')?.textContent || '')));
    check('the item title text is unchanged by the screen-reader label', (await rows()).some((r) => r.title === 'Order shipped'));

    if (process.env.NEXTA_TEST_SHOT) await page.screenshot({ path: process.env.NEXTA_TEST_SHOT, clip: { x: 760, y: 0, width: 520, height: 560 } });   // optional: eyeball the panel
    // ---- 2. bell count vs item dots
    check('opening the bell cleared the exterior count', await waitFor(async () => (await badge()).hidden), JSON.stringify(await badge()));
    check('...but every dot is still there', (await dotCount()) === 12);

    // ---- 3. persistence across close / re-open, instantly, with a slow server
    await closeBell();
    db.listDelayMs = 1500;
    await openBell();
    check('re-opening draws the list with its dots within 300ms although the server takes 1.5s', await waitFor(async () => (await rows()).length === 13 && (await dotCount()) === 12, 300), JSON.stringify((await rows()).length));
    await sleep(1700);
    db.listDelayMs = 0;
    check('the dots survive the background revalidation too', (await dotCount()) === 12);

    // ---- 4. tapping clears only that item — and stays cleared through a stale in-flight list
    // The stale snapshot ALSO contains a brand-new item, so the list really does
    // change when it lands and the panel repaints from the store — that repaint
    // is what would resurrect the dot if the local read weren't remembered.
    await closeBell();
    addNotification({ title: 'Arrives mid-flight' });
    db.listDelayMs = 1000; db.putDelayMs = 150;
    await openBell();                                   // cached render now; revalidation snapshot has A unread + the new item
    await sleep(150);
    const dotsBefore = await dotCount();
    await clickItem('Order shipped');
    check('the tapped item\'s dot clears at once', await waitFor(async () => !(await dotTitles()).includes('Order shipped'), 400), JSON.stringify(await dotTitles()));
    check('...and only that one', (await dotCount()) === dotsBefore - 1, `${await dotCount()} vs ${dotsBefore}`);
    check('...and the server recorded the read', await waitFor(() => byId(idA).readAt !== null, 2000));
    await sleep(1300);                                  // the stale list (A unread, plus the new item) lands now
    db.listDelayMs = 0; db.putDelayMs = 0;
    check('the stale list DID repaint the panel (the new item is there, with its dot)...', (await dotTitles()).includes('Arrives mid-flight'), JSON.stringify(await dotTitles()));
    check('...yet it does not bring the tapped item\'s dot back', !(await dotTitles()).includes('Order shipped'), JSON.stringify(await dotTitles()));

    // ---- 5. a failed mark-read is kept cleared on screen and retried
    const idFlaky = addNotification({ title: 'Flaky one' });
    await page.evaluate(() => app.refreshOpenNotificationLists());
    await waitFor(async () => (await dotTitles()).includes('Flaky one'));
    db.failReadOnce = true;
    await clickItem('Flaky one');
    await sleep(400);
    check('the failed write leaves the server unread...', byId(idFlaky).readAt === null);
    check('...but the tapped item stays visually read', !(await dotTitles()).includes('Flaky one'));
    db.putDelayMs = 600;                                // the retry will land AFTER the list snapshot is taken
    await closeBell();
    await openBell();                                   // redraws from the store while the server still says unread
    await sleep(120);
    check('...also after closing and re-opening the panel (redrawn from memory)', !(await dotTitles()).includes('Flaky one'), JSON.stringify(await dotTitles()));
    check('the next load retries the write and the server ends up read', await waitFor(() => byId(idFlaky).readAt !== null, 3000));
    db.putDelayMs = 0;

    // ---- 6. open panels pick up new notifications on the poll tick
    addNotification({ title: 'Brand new' });
    await page.evaluate(() => app.refreshUnreadBadges());
    check('a notification created while the panel is open appears, with a dot, without re-opening', await waitFor(async () => (await dotTitles()).includes('Brand new'), 3000), JSON.stringify(await dotTitles()));

    // ---- 7. opening a thread settles its item
    const before = await dotCount();
    await page.evaluate(() => app.notifications.settleByLink('messages.html?conversation=c1'));
    check('settling a thread clears exactly that thread\'s dot', await waitFor(async () => !(await dotTitles()).includes('New message') && (await dotCount()) === before - 1), JSON.stringify(await dotTitles()));

    // ---- 8. bell items that point at a thread warm its cache on hover
    await page.evaluate(() => { window.__prefetched = []; window.messagesManager.prefetchThread = (id) => window.__prefetched.push(id); });
    await page.evaluate(() => { const l = document.querySelector('[data-notification-preview-list]'); l.scrollTop = l.scrollHeight; });
    await page.locator('.notification-preview-item', { hasText: 'Order shipped' }).first().hover();
    await sleep(250);
    check('hovering a non-thread notification prefetches nothing', (await page.evaluate(() => window.__prefetched.length)) === 0);
    await page.locator('.notification-preview-item', { hasText: 'New message' }).first().hover();
    check('hovering a thread notification prefetches that thread', await waitFor(() => page.evaluate(() => window.__prefetched.includes('c1')), 1500));

    // ---- 9. Mark all as read — optimistic, and rolled back if refused
    addNotification({ title: 'Late one' });
    addNotification({ title: 'Later one' });
    await page.evaluate(() => app.refreshOpenNotificationLists());
    await waitFor(async () => (await dotCount()) >= 3);
    db.readAllDelayMs = 800; db.readAllFails = true;
    await page.click('[data-notification-read-all]');
    check('Mark all clears every dot immediately, before the server answers', await waitFor(async () => (await dotCount()) === 0, 300));
    check('...and puts them back when the server refuses', await waitFor(async () => (await dotCount()) >= 3, 3000), String(await dotCount()));
    db.readAllFails = false; db.readAllDelayMs = 0;
    await page.click('[data-notification-read-all]');
    check('a Mark all the server accepts leaves no dots and no unread on the server', await waitFor(async () => (await dotCount()) === 0 && db.notifications.every((n) => n.readAt), 3000));

    // ---- 10. everything in memory goes when the session ends
    await page.evaluate(() => { window.messagesManager.threadCache.set('x', { messages: [] }); SessionData.dropMemoryCaches(); });
    check('session end empties the notification store and the thread cache', await page.evaluate(() => app.notifications.items === null && window.messagesManager.threadCache.size === 0));

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} notification-dot browser checks passed.`);
  process.exit(failed ? 1 : 0);
})();
