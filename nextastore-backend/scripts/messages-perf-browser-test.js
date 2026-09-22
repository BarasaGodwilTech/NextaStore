#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the messaging performance work (thread cache,
 * prefetch, skeleton, optimistic send) against the REAL messages.html /
 * js/messages.js and a small fake of routes/messages.js on localhost:4000.
 *
 *   npm run test:messages-perf-browser
 *
 * What it proves: the page's behaviour when the API behaves like
 * routes/messages.js does (…/peek = no mark-read, POST returns the stored
 * message with the clientId echoed). It does not prove the real route does —
 * read src/routes/messages.js for that.
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

const NOW = Date.now();
const mkConv = (id, name) => ({
  id, buyer: { id: 'u_buyer', name: 'Bea Buyer', avatar: null }, store: { id: `s_${id}`, slug: `${id}-store`, name, logo: null }, product: null,
  lastMessage: { body: `Hello from ${id}`, type: 'text', metadata: null, senderId: 'u_seller', createdAt: new Date(NOW - 60000).toISOString() },
  unreadCount: 1, updatedAt: new Date(NOW - 60000).toISOString(), presence: { online: false, lastActiveAt: null }
});
const CONVS = [mkConv('conv_1', 'Alpha Store'), mkConv('conv_2', 'Beta Store')];
const db = {
  threadDelayMs: 0, postDelayMs: 0, postFails: false, calls: [], markedRead: new Set(), seq: 0,
  messages: { conv_1: [], conv_2: [] }
};
for (const id of Object.keys(db.messages)) {
  db.messages[id].push({ id: `m_${id}_1`, clientId: null, body: `Hello from ${id}`, type: 'text', metadata: {}, senderId: 'u_seller', senderName: 'Seller', createdAt: new Date(NOW - 60000).toISOString(), readAt: null });
}

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (!p.startsWith('/api/')) {
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const pk = p.match(/^\/api\/messages\/conversations\/([^/]+)\/peek$/);
    const m = pk || p.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (p === '/api/messages/conversations' && req.method === 'GET') return json(res, { data: CONVS, pagination: { page: 1, limit: 20, total: 2, pages: 1 } });
    if (m && req.method === 'GET') {
      const id = m[1]; const peek = !!pk; const since = u.searchParams.get('since');
      const conv = CONVS.find((c) => c.id === id);
      if (!conv) return json(res, { message: 'Conversation not found.' }, 404);
      db.calls.push({ kind: since ? 'since' : (peek ? 'peek' : 'open'), id });
      if (!peek && !since) { await sleep(db.threadDelayMs); db.markedRead.add(id); }
      if (since) return json(res, { data: { id, store: conv.store, messages: [], readUpdates: [], presence: conv.presence, pagination: { mode: 'since', serverTime: new Date().toISOString(), truncated: false } } });
      return json(res, { data: { id, store: conv.store, buyer: conv.buyer, product: null, presence: conv.presence, messages: db.messages[id], pagination: { mode: 'page', limit: 100, hasMore: false, nextBefore: null, serverTime: new Date().toISOString() } } });
    }
    if (m && req.method === 'POST') {
      const id = m[1]; const payload = JSON.parse(body || '{}');
      db.calls.push({ kind: 'post', id });
      await sleep(db.postDelayMs);
      if (db.postFails) return json(res, { message: 'Boom' }, 500);
      const msg = { id: `srv_${++db.seq}`, clientId: payload.clientId || null, body: payload.body, type: 'text', metadata: {}, senderId: 'u_buyer', senderName: 'Bea Buyer', createdAt: new Date().toISOString(), readAt: null };
      db.messages[id].push(msg);
      return json(res, { data: msg }, 201);
    }
    if (p === '/api/user/me') return json(res, { data: USER });
    if (p === '/api/messages/unread-count' || p === '/api/notifications/unread-count') return json(res, { data: { count: 0 } });
    if (p.startsWith('/api/presence')) return json(res, { data: {} });
    return json(res, { data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  });
});

let passed = 0; let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(50); } return false; }
const count = (kind, id) => db.calls.filter((c) => c.kind === kind && c.id === id).length;

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}).`); process.exit(2);
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
    const threadText = () => page.evaluate(() => document.getElementById('threadMessages')?.innerText || '');
    const row = (id) => `[data-conversation-id="${id}"]`;

    await page.goto(`http://localhost:${PORT}/messages.html`);
    await page.waitForSelector(row('conv_2'));

    // ---- 1. hover prefetch is a PEEK: warms the cache, marks nothing read
    await page.hover(row('conv_2'));
    check('a mouse resting on a row prefetches that thread with GET …/peek', await waitFor(() => count('peek', 'conv_2') === 1), JSON.stringify(db.calls));
    check('...and it is NOT a normal open (nothing marked read on the server)', count('open', 'conv_2') === 0 && !db.markedRead.has('conv_2'));
    await page.mouse.move(5, 5);
    await page.hover(row('conv_2'));
    await sleep(250);
    check('hovering again while the entry is fresh does not fetch again', count('peek', 'conv_2') === 1);

    // ---- 2. a cached thread paints instantly, before the (slow) real request
    db.threadDelayMs = 1500;
    await page.click(row('conv_2'));
    const paintedFast = await waitFor(async () => (await threadText()).includes('Hello from conv_2'), 400);
    check('clicking a prefetched row paints the messages within 400ms although the real request takes 1.5s', paintedFast, await threadText());
    check('...and the real (marking-read) request is still sent in the background', await waitFor(() => count('open', 'conv_2') === 1, 2000));
    check('the pane opened without waiting on the network', await page.evaluate(() => !document.getElementById('threadView').classList.contains('hidden')));
    check('the row\'s unread badge cleared immediately', await page.evaluate(() => !document.querySelector('[data-conversation-id="conv_2"] .conversation-unread-count')));
    await waitFor(() => db.markedRead.has('conv_2'), 3000);

    // ---- 3. a cold thread shows a skeleton + the right header at once
    await page.click(row('conv_1'));
    const skeleton = await waitFor(() => page.evaluate(() => !!document.querySelector('#threadMessages .thread-skeleton') && document.getElementById('threadMessages').getAttribute('aria-busy') === 'true'), 500);
    if (process.env.NEXTA_TEST_SHOT) await page.screenshot({ path: process.env.NEXTA_TEST_SHOT });   // optional: eyeball the skeleton
    check('an uncached thread shows skeleton bubbles immediately (aria-busy) instead of a blank pane', skeleton);
    check('...with its header drawn from the list row already', await page.evaluate(() => (document.getElementById('threadHeader')?.innerText || '').includes('Alpha Store')));
    check('...and then the real messages replace the skeleton', await waitFor(async () => (await threadText()).includes('Hello from conv_1'), 4000));
    check('...with aria-busy removed', await page.evaluate(() => !document.getElementById('threadMessages').hasAttribute('aria-busy')));

    // ---- 4. optimistic send: pending at once, settled in place, no refetch
    db.threadDelayMs = 0; db.postDelayMs = 900;
    const opensBefore = count('open', 'conv_1');
    await page.fill('#threadReplyInput', 'hi there');
    await page.click('#threadSendBtn');
    const pending = await waitFor(() => page.evaluate(() => !!document.querySelector('.thread-message.is-mine.is-pending .message-receipt[data-status="pending"]')), 300);
    check('the bubble appears as pending within 300ms while the POST takes 900ms', pending);
    check('the composer is not blocked or disabled while it is in flight', await page.evaluate(() => !document.getElementById('threadReplyInput').disabled));
    check('the list row already shows the sent text as its preview', await page.evaluate(() => document.querySelector('[data-conversation-id="conv_1"] .conversation-item-preview')?.textContent === 'hi there'));
    // a second message typed straight away is accepted and queued behind the first
    await page.fill('#threadReplyInput', 'second');
    await page.click('#threadSendBtn');
    check('a second message can be sent while the first is still pending', await waitFor(() => page.evaluate(() => document.querySelectorAll('.thread-message.is-mine').length >= 2)));
    // (A tick is only drawn on the last bubble of a same-sender run — see buildMessagesHtml — so "both settled" = no pending left, and the run ends in a sent tick.)
    const sent = await waitFor(() => page.evaluate(() => document.querySelectorAll('.thread-message.is-mine').length === 2 && !document.querySelector('.thread-message.is-pending') && !!document.querySelector('.thread-message.is-mine .message-receipt[data-status="sent"]')), 4000);
    check('both settle in place: no pending bubble left, the run ends in a "sent" tick', sent);
    const order = db.messages.conv_1.filter((m) => m.senderId === 'u_buyer').map((m) => m.body);
    check('they reached the server in the order they were written', order.join('|') === 'hi there|second', order.join('|'));
    check('settling did NOT refetch the thread (no extra open GET after sending)', count('open', 'conv_1') === opensBefore, `${count('open', 'conv_1')} vs ${opensBefore}`);
    const texts = await page.evaluate(() => [...document.querySelectorAll('.thread-message.is-mine')].map((n) => n.innerText.trim()));
    check('each message is shown exactly once (no pending + server duplicate)', texts.filter((t) => t.startsWith('hi there')).length === 1 && texts.filter((t) => t.startsWith('second')).length === 1, JSON.stringify(texts));

    // ---- 5. failure: kept, flagged, with Resend
    db.postDelayMs = 0; db.postFails = true;
    await page.fill('#threadReplyInput', 'will fail');
    await page.click('#threadSendBtn');
    check('a failed send stays as a failed bubble with Resend/Delete', await waitFor(() => page.evaluate(() => !!document.querySelector('.thread-message.is-failed [data-retry-message]') && !!document.querySelector('.message-receipt[data-status="failed"], .thread-message.is-failed')), 3000));
    db.postFails = false;
    await page.click('[data-retry-message]');
    check('Resend succeeds and the failed bubble becomes a sent one (server got one copy)', await waitFor(() => page.evaluate(() => !document.querySelector('.thread-message.is-failed') && !document.querySelector('.thread-message.is-pending')), 3000)
      && db.messages.conv_1.filter((m) => m.body === 'will fail').length === 1);

    // ---- 6. back to a thread already seen: instant even with a slow server
    db.threadDelayMs = 1500;
    await page.click(row('conv_2'));
    check('returning to a thread already seen paints at once', await waitFor(async () => (await threadText()).includes('Hello from conv_2'), 400));

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} messaging-performance browser checks passed.`);
  process.exit(failed ? 1 : 0);
})();
