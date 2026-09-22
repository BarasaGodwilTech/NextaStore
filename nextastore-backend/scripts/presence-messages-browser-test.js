#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the presence WIRING in messages.html / messages.js
 * (not just presence.js itself — see presence-browser-test.js for that).
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:presence-messages-browser
 *
 * Serves the repo root AND a small fake API on localhost:4000 (the port the
 * frontend picks on localhost), signs a buyer in through localStorage, and
 * opens the REAL messages page. The fake API returns the same shapes as
 * routes/messages.js and routes/presence.js, so this catches things the
 * string checks in qa-static.js cannot: a key mismatch between the markup
 * and the stream's snapshot keys, a dot that never appears, a label that
 * never fills in, a deep link that shows nothing, a list re-render that
 * loses the state.
 *
 * It does NOT prove the real backend returns those shapes (see
 * presence-test.js and PRESENCE_BACKEND_CHANGELOG.md) — only that this page
 * behaves correctly when it does.
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

const CONV_ID = 'conv_1';
const STORE = { id: 's1', slug: 'acme-store', name: 'Acme Store', logo: null };
const conversation = () => ({
  id: CONV_ID, buyer: { id: 'u_buyer', name: 'Bea Buyer', avatar: null }, store: STORE, product: null,
  lastMessage: { body: 'Hello there', type: 'text', metadata: null, senderId: 'u_seller', createdAt: new Date(Date.now() - 120000).toISOString() },
  unreadCount: 0, updatedAt: new Date().toISOString(),
  presence: mock.listPresence
});
const mock = {
  listPresence: { online: false, lastActiveAt: new Date(Date.now() - 12 * 60000).toISOString() },
  threadPresence: { online: false, lastActiveAt: new Date(Date.now() - 12 * 60000).toISOString() },
  storePresence: { online: true, lastActiveAt: null },
  streams: [], streamBodies: [], unknown: new Set()
};

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (p.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (p === '/api/presence/stream' && req.method === 'POST') {
        mock.streamBodies.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' });
        res.write(': ping\n\n');
        // The real route answers with a snapshot for the requested keys, first.
        const watch = (JSON.parse(body || '{}').watch) || [];
        const presence = {};
        watch.forEach((k) => { presence[k] = k.startsWith('store:') ? mock.storePresence : mock.threadPresence; });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ presence })}\n\n`);
        mock.streams.push(res);
        res.on('close', () => { const i = mock.streams.indexOf(res); if (i >= 0) mock.streams.splice(i, 1); });
        return;
      }
      if (p === '/api/messages/conversations' && req.method === 'GET') return json(res, { success: true, data: [conversation()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } });
      if (p === `/api/messages/conversations/${CONV_ID}` && req.method === 'GET') {
        return json(res, { success: true, data: { id: CONV_ID, store: STORE, messages: [], presence: mock.threadPresence, pagination: { serverTime: new Date().toISOString(), hasMore: false } } });
      }
      const sm = p.match(/^\/api\/presence\/store\/(.+)$/);
      if (sm) return json(res, { success: true, data: { key: `store:${decodeURIComponent(sm[1])}`, ...mock.storePresence } });
      mock.unknown.add(`${req.method} ${p}`);
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
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(80); } return false; }
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const pushToStreams = (text) => mock.streams.forEach((s) => s.write(text));

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}). The frontend expects the API on 4000 when served from localhost; stop whatever is using it or set PRESENCE_TEST_PORT.`);
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

    const rowDot = () => page.evaluate(() => { const d = document.querySelector('.conversation-item .presence-dot'); return d ? { cls: d.className, key: d.getAttribute('data-presence-key') } : null; });
    const headerState = () => page.evaluate(() => {
      const h = document.getElementById('threadHeader');
      const d = h && h.querySelector('.presence-dot'); const l = h && h.querySelector('.thread-header-status');
      return { dot: d ? d.className : null, label: l ? l.textContent : null, labelVisible: l ? getComputedStyle(l).display !== 'none' : false };
    });

    // ---- 1. conversation list
    await page.goto(`http://localhost:${PORT}/messages.html`);
    check('the conversation row renders a presence dot keyed conversation:<id>', await waitFor(async () => { const d = await rowDot(); return d && d.key === `conversation:${CONV_ID}`; }));
    check('the stream is opened watching that conversation (dot key === stream key)', await waitFor(() => mock.streamBodies.some((b) => (b.watch || []).includes(`conversation:${CONV_ID}`))), JSON.stringify(mock.streamBodies));
    check('the row dot turns gray/offline from list data', await waitFor(async () => (await rowDot())?.cls.includes('is-offline')), JSON.stringify(await rowDot()));

    // ---- 2. open the thread
    await page.click('.conversation-item');
    check('opening the conversation shows the thread header dot immediately, offline', await waitFor(async () => (await headerState()).dot?.includes('is-offline')), JSON.stringify(await headerState()));
    check('the header label reads "Active 12m ago" and is visible', await waitFor(async () => { const h = await headerState(); return h.label === 'Active 12m ago' && h.labelVisible; }), JSON.stringify(await headerState()));

    // ---- 3. live flip, no reload
    mock.threadPresence = { online: true, lastActiveAt: null };
    pushToStreams(frame('presence', { key: `conversation:${CONV_ID}`, online: true, lastActiveAt: null, at: Date.now() + 1000 }));
    check('a live event turns the header dot green and the label "Online" without a reload', await waitFor(async () => { const h = await headerState(); return h.dot?.includes('is-online') && h.label === 'Online'; }), JSON.stringify(await headerState()));
    check('the conversation-list dot flipped too (same key, two places)', (await rowDot())?.cls.includes('is-online'), JSON.stringify(await rowDot()));

    pushToStreams(frame('presence', { key: `conversation:${CONV_ID}`, online: false, lastActiveAt: new Date().toISOString(), at: Date.now() + 5000 }));
    check('going offline flips both back to gray + "Active just now"', await waitFor(async () => { const h = await headerState(); return h.dot?.includes('is-offline') && h.label === 'Active just now' && (await rowDot())?.cls.includes('is-offline'); }), JSON.stringify(await headerState()));

    // ---- 4. re-render keeps state
    await page.evaluate(() => { window.__m = window.__m || null; });
    const before = await headerState();
    await page.evaluate(() => { const list = document.querySelector('.conversation-item'); if (list) list.click(); });
    await sleep(600);
    const after = await headerState();
    check('re-opening / re-rendering the thread keeps the current status (no blank flash left behind)', after.dot?.includes('is-offline') && after.label === before.label, JSON.stringify({ before, after }));

    // ---- 5. deep link straight into a thread
    mock.threadPresence = { online: true, lastActiveAt: null };
    mock.listPresence = { online: true, lastActiveAt: null };
    const page2 = await context.newPage();
    page2.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page2.goto(`http://localhost:${PORT}/messages.html?conversation=${CONV_ID}`);
    check('a deep link (?conversation=) shows the participant as Online straight away', await waitFor(async () => {
      const s = await page2.evaluate(() => { const h = document.getElementById('threadHeader'); const l = h && h.querySelector('.thread-header-status'); const d = h && h.querySelector('.presence-dot'); return { label: l && l.textContent, dot: d && d.className }; });
      return s.label === 'Online' && s.dot && s.dot.includes('is-online');
    }, 6000));
    await page2.close();

    // ---- 6. no script errors
    check('no uncaught page errors while doing all of the above', errors.length === 0, errors.join(' | '));
    if (mock.unknown.size) console.log('note: fake API answered these paths generically: ' + [...mock.unknown].join(', '));
  } finally {
    await browser.close(); server.close(); mock.streams.forEach((s) => s.end());
  }
  console.log(`\n${passed}/${passed + failed} presence-on-messages-page browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
