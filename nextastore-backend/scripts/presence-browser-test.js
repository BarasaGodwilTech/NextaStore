#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of js/presence.js + the shared presence CSS.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:presence-browser
 *
 * Serves the repo root plus a FAKE /api/presence/stream (SSE over a POST
 * body, like the real route) on a random localhost port, loads a tiny
 * harness page that includes the real css/main.css and js/presence.js, and
 * drives the stream from the test. Covers what the string-matching checks
 * in qa-static.js cannot: the dot actually changes colour live, the label
 * text tracks the bucket, REST seeding works before/without a stream, a
 * late seed can't undo a live event, and end:replaced stops reconnecting.
 *
 * Does NOT cover the real backend (see presence-test.js) or messages.js /
 * store-detail.js wiring against a running server.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"></head><body>
<div style="position:relative;width:48px;height:48px" id="av"><span id="dot" class="presence-dot" data-presence-key="conversation:c1" data-presence-dot></span></div>
<span id="label" class="presence-status" data-presence-key="conversation:c1" data-presence-label></span>
<script>window.app = { token: 'test-token', apiBaseUrl: '/api' };</script>
<script src="/js/presence.js"></script></body></html>`;

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const streams = [];        // open SSE responses
const streamRequests = []; // { headers, body }
let nextStreamStatus = 200;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/harness') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
  if (url === '/api/presence/stream' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      streamRequests.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      if (nextStreamStatus !== 200) { res.writeHead(nextStreamStatus); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' });
      res.write(': ping\n\n');
      streams.push(res);
      res.on('close', () => { const i = streams.indexOf(res); if (i >= 0) streams.splice(i, 1); });
    });
    return;
  }
  if (url === '/__send') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { streams.forEach((s) => s.write(body)); res.writeHead(204); res.end(); });
    return;
  }
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let passed = 0; let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
function frame(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
async function send(base, text) { await fetch(base + '/__send', { method: 'POST', body: text }); }

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    const state = () => page.evaluate(() => ({
      dot: document.getElementById('dot').className,
      label: document.getElementById('label').textContent,
      dotColor: getComputedStyle(document.getElementById('dot')).backgroundColor,
      dotOpacity: getComputedStyle(document.getElementById('dot')).opacity,
      stats: window.NextaPresence.stats()
    }));

    await page.goto(base + '/harness');
    check('window.NextaPresence loads with the expected API', await page.evaluate(() => ['setWatch', 'seed', 'render', 'formatLabel', 'stats'].every((k) => typeof window.NextaPresence[k] === 'function')));

    // Unknown state: invisible dot, empty label.
    let s = await state();
    check('before anything is known the dot is invisible and the label empty', !s.dot.includes('is-online') && !s.dot.includes('is-offline') && s.dotOpacity === '0' && s.label === '', JSON.stringify(s));
    check('a signed-in page opens the stream on load, before any watch is set (that is what marks the caller online)', await waitFor(() => streamRequests.length === 1 && streamRequests[0].body.watch.length === 0), JSON.stringify(streamRequests.map((r) => r.body)));

    // REST seed with no stream (offline, 5 minutes ago).
    await page.evaluate(() => window.NextaPresence.seed('conversation:c1', { online: false, lastActiveAt: new Date(Date.now() - 5 * 60000).toISOString() }));
    await waitFor(async () => (await state()).dotOpacity === '1');
    s = await state();
    check('REST seed: gray dot + "Active 5m ago"', s.dot.includes('is-offline') && s.label === 'Active 5m ago' && s.dotOpacity === '1', JSON.stringify(s));

    // Open the stream.
    await page.evaluate(() => window.NextaPresence.setWatch(['conversation:c1']));
    check('setWatch re-opens the stream with the watch list', await waitFor(() => streamRequests.length === 2));
    const rq = streamRequests[1];
    check('stream request is authenticated, marked background, and carries the watch list',
      rq.headers.authorization === 'Bearer test-token' && rq.headers['x-background-poll'] === '1' && JSON.stringify(rq.body.watch) === JSON.stringify(['conversation:c1']), JSON.stringify(rq));

    await waitFor(() => streams.length === 1);
    await sleep(100);
    await send(base, frame('snapshot', { presence: { 'conversation:c1': { online: false, lastActiveAt: new Date(Date.now() - 3 * 3600000).toISOString() } } }));
    check('snapshot: gray dot + "Active 3h ago"', await waitFor(async () => (await state()).label === 'Active 3h ago'), JSON.stringify(await state()));

    // Live flip online.
    await send(base, frame('presence', { key: 'conversation:c1', online: true, lastActiveAt: null, at: Date.now() + 1000 }));
    check('live event flips the dot green and the label to "Online" with no reload', await waitFor(async () => { const x = await state(); return x.dot.includes('is-online') && x.label === 'Online'; }), JSON.stringify(await state()));
    s = await state();
    check('online dot is actually the success colour (not gray)', s.dotColor !== 'rgba(0, 0, 0, 0)' && s.dotColor !== 'rgb(156, 163, 175)', s.dotColor);

    // Late REST seed must not undo live state.
    await page.evaluate(() => window.NextaPresence.seed('conversation:c1', { online: false, lastActiveAt: new Date().toISOString() }));
    check('a late REST seed does not undo a live "online" while the stream is healthy', (await state()).dot.includes('is-online'));

    // Stale (out-of-order) event ignored.
    await send(base, frame('presence', { key: 'conversation:c1', online: false, lastActiveAt: new Date().toISOString(), at: 1 }));
    await sleep(300);
    check('an out-of-order older event is ignored', (await state()).dot.includes('is-online'));

    // Newer offline event.
    await send(base, frame('presence', { key: 'conversation:c1', online: false, lastActiveAt: new Date().toISOString(), at: Date.now() + 5000 }));
    check('a newer offline event flips back to gray + "Active just now"', await waitFor(async () => { const x = await state(); return x.dot.includes('is-offline') && x.label === 'Active just now'; }), JSON.stringify(await state()));

    // Markup rebuilt with innerHTML (as messages.js does) is picked up on next render.
    await page.evaluate(() => { document.getElementById('av').innerHTML = '<span id="dot" class="presence-dot" data-presence-key="conversation:c1" data-presence-dot></span>'; });
    check('re-rendered markup (innerHTML rebuild, NO manual render() call) picks the current state up on its own', await waitFor(async () => (await state()).dot.includes('is-offline') && (await state()).label === 'Active just now'), JSON.stringify(await state()));

    // Watch change reconnects with the new list.
    await page.evaluate(() => window.NextaPresence.setWatch(['conversation:c1', 'store:acme']));
    check('changing the watch list reconnects with the new keys', await waitFor(() => streamRequests.length === 3 && streamRequests[2].body.watch.includes('store:acme')), JSON.stringify(streamRequests.map((r) => r.body)));

    await page.close();
    streams.slice().forEach((x) => x.end());

    // end:replaced stops for good — INCLUDING past the 5s auth poll, which
    // used to restart it (same token) and, past the tab cap, made tabs
    // replace each other in turn.
    streamRequests.length = 0;
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(base + '/harness');
    await waitFor(() => streams.length === 1);
    await sleep(100);
    await send(base, frame('end', { reason: 'replaced' }));
    streams.slice().forEach((x) => x.end());
    await sleep(6500);
    check('end:replaced stops reconnecting, even past the 5s auth poll', streamRequests.length === 1 && (await p2.evaluate(() => window.NextaPresence.stats().stopped)) === true, String(streamRequests.length));
    await p2.evaluate(() => { window.app.token = 'fresh-token'; });
    check('a fresh sign-in (new token) restarts a stopped stream', await waitFor(() => streamRequests.length === 2, 7000), String(streamRequests.length));
    await p2.close();
    streams.slice().forEach((x) => x.end());

    // 401 stops for good too.
    streamRequests.length = 0; nextStreamStatus = 401;
    const p3 = await (await browser.newContext()).newPage();
    await p3.goto(base + '/harness');
    await waitFor(() => streamRequests.length >= 1);
    await sleep(6500);
    check('a 401 stops reconnecting, even past the 5s auth poll', streamRequests.length === 1 && (await p3.evaluate(() => window.NextaPresence.stats().stopped)) === true, String(streamRequests.length));
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${passed}/${passed + failed} presence browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
