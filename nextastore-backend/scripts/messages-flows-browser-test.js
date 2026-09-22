#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the messaging flows that messages-perf-browser-test
 * does not cover:
 *   A. prefetch by touch / keyboard focus, cancelled by a scroll, off on Data
 *      Saver, and a tap that lands while a prefetch is still on the wire;
 *   B. "Message seller": the first message creates the conversation and the
 *      compose screen turns into the real thread;
 *   C. a failed FIRST message: persisted across a reload, Resend uses the same
 *      clientId, and a Resend that succeeds does not come back as failed;
 *   D. location and product attachments sent optimistically (pending -> sent,
 *      shown once) and failing with their content intact;
 *   E. "Load older messages" combined with the thread cache.
 *
 *   npm run test:messages-flows-browser
 *
 * Runs the REAL messages.html / js/messages.js against a stateful fake of
 * routes/messages.js (same response shapes, same clientId idempotency, a
 * peek route that marks nothing read) on localhost:4000.
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
const BUYER = { id: 'u_buyer', name: 'Bea Buyer', avatar: null };
const NOW = Date.now();

const mkStore = (id, slug, name) => ({ id, slug, name, logo: null });
const db = {
  threadDelayMs: 0, peekDelayMs: 0, postDelayMs: 0, createDelayMs: 0, postFails: false, createFails: false,
  calls: [], seq: 0, convSeq: 0, markedRead: new Set(),
  stores: { s_new: mkStore('s_new', 'new-store', 'New Store'), s_new2: mkStore('s_new2', 'second-store', 'Second Store') },
  convs: [], messages: {}
};
function addConv(id, store, msgs) {
  const list = msgs.map((body, i) => ({ id: `m_${id}_${i + 1}`, clientId: null, body, type: 'text', metadata: {}, senderId: 'u_seller', senderName: 'Seller', createdAt: new Date(NOW - (msgs.length - i + 1) * 60000).toISOString(), readAt: null }));
  db.messages[id] = list;
  db.convs.push({ id, buyer: BUYER, store, product: null, unreadCount: 0, updatedAt: list[list.length - 1]?.createdAt || new Date(NOW).toISOString(), presence: { online: false, lastActiveAt: null } });
}
function resetDb() {
  db.convs = []; db.messages = {}; db.calls = []; db.markedRead = new Set(); db.convSeq = 0; db.seq = 0;
  db.threadDelayMs = db.peekDelayMs = db.postDelayMs = db.createDelayMs = 0; db.postFails = db.createFails = false;
  addConv('conv_a', mkStore('s_a', 'alpha', 'Alpha Store'), ['Hello from A']);
  addConv('conv_b', mkStore('s_b', 'beta', 'Beta Store'), ['Hello from B']);
  addConv('conv_long', mkStore('s_g', 'gamma', 'Gamma Store'), Array.from({ length: 150 }, (_, i) => `Msg ${String(i + 1).padStart(3, '0')}`));
}
const lastOf = (c) => { const m = db.messages[c.id]; return m[m.length - 1]; };
const listView = () => db.convs.map((c) => { const l = lastOf(c); return { ...c, lastMessage: l ? { body: l.body, type: l.type, metadata: l.metadata, senderId: l.senderId, createdAt: l.createdAt } : null }; })
  .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
function storeMessage(conv, payload) {
  const msg = { id: `srv_${++db.seq}`, clientId: payload.clientId || null, body: payload.body || '', type: payload.attachment?.type || 'text', metadata: {}, senderId: 'u_buyer', senderName: 'Bea Buyer', createdAt: new Date().toISOString(), readAt: null };
  if (payload.attachment?.type === 'location') msg.metadata = { lat: payload.attachment.lat, lng: payload.attachment.lng, label: payload.attachment.label || null };
  if (payload.attachment?.type === 'product') msg.metadata = { productId: payload.attachment.productId, name: 'Blue Kettle', price: 25000, image: null, stock: 3 };
  db.messages[conv.id].push(msg);
  conv.updatedAt = msg.createdAt;
  return msg;
}
function findByClientId(clientId) {
  if (!clientId) return null;
  for (const c of db.convs) { const m = db.messages[c.id].find((x) => x.clientId === clientId); if (m) return { conv: c, msg: m }; }
  return null;
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
    if (p === '/api/user/me') return json(res, { data: USER });
    if (p === '/api/messages/unread-count' || p === '/api/notifications/unread-count') return json(res, { data: { count: 0 } });
    if (p.startsWith('/api/presence')) return json(res, { data: { online: false, lastActiveAt: null } });
    let m;
    if ((m = p.match(/^\/api\/store\/public\/([^/]+)$/))) { const s = db.stores[decodeURIComponent(m[1])]; return s ? json(res, { data: s }) : json(res, { message: 'Store not found' }, 404); }
    if (p === '/api/messages/conversations' && req.method === 'GET') { const l = listView(); return json(res, { data: l, pagination: { page: 1, limit: 20, total: l.length, pages: 1 } }); }
    if (p === '/api/messages' && req.method === 'POST') {
      const payload = JSON.parse(body || '{}');
      db.calls.push({ kind: 'create', storeId: payload.storeId, clientId: payload.clientId, attachment: payload.attachment });
      await sleep(db.createDelayMs);
      const dup = findByClientId(payload.clientId);
      if (dup) return json(res, { data: { conversationId: dup.conv.id, messageId: dup.msg.id, message: dup.msg } }, 200);
      if (db.createFails) return json(res, { message: 'Could not send' }, 500);
      const store = db.stores[payload.storeId];
      if (!store) return json(res, { message: 'Store not found' }, 404);
      let conv = db.convs.find((c) => c.store.id === store.id);
      if (!conv) { conv = { id: `conv_new${++db.convSeq}`, buyer: BUYER, store, product: null, unreadCount: 0, updatedAt: new Date().toISOString(), presence: { online: false, lastActiveAt: null } }; db.convs.push(conv); db.messages[conv.id] = []; }
      const msg = storeMessage(conv, payload);
      return json(res, { data: { conversationId: conv.id, messageId: msg.id, message: msg } }, 201);
    }
    if ((m = p.match(/^\/api\/messages\/conversations\/([^/]+)(\/peek)?$/))) {
      const id = decodeURIComponent(m[1]); const peek = !!m[2];
      const conv = db.convs.find((c) => c.id === id);
      if (!conv) return json(res, { message: 'Conversation not found.' }, 404);
      if (req.method === 'POST') {
        const payload = JSON.parse(body || '{}');
        db.calls.push({ kind: 'post', id, clientId: payload.clientId, attachment: payload.attachment, body: payload.body });
        await sleep(db.postDelayMs);
        const dup = findByClientId(payload.clientId);
        if (dup) return json(res, { data: dup.msg }, 200);
        if (db.postFails) return json(res, { message: 'Boom' }, 500);
        return json(res, { data: storeMessage(conv, payload) }, 201);
      }
      const since = u.searchParams.get('since');
      db.calls.push({ kind: since ? 'since' : (peek ? 'peek' : 'open'), id });
      if (since) return json(res, { data: { id, store: conv.store, messages: [], readUpdates: [], presence: conv.presence, pagination: { mode: 'since', serverTime: new Date().toISOString(), truncated: false } } });
      if (peek) await sleep(db.peekDelayMs); else { await sleep(db.threadDelayMs); db.markedRead.add(id); }
      const all = db.messages[id];
      const limit = Math.min(100, Number(u.searchParams.get('limit')) || 100);
      const before = u.searchParams.get('before');
      const pool = before ? all.filter((x) => new Date(x.createdAt) < new Date(before)) : all;
      const page = pool.slice(Math.max(0, pool.length - limit));
      return json(res, { data: { id, store: conv.store, buyer: conv.buyer, product: null, presence: conv.presence, messages: page, pagination: { mode: 'page', limit, hasMore: pool.length > page.length, nextBefore: page[0]?.createdAt || null, serverTime: new Date().toISOString() } } });
    }
    return json(res, { data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  });
});

let passed = 0; let failed = 0;
const allErrors = [];
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) { /* retry */ } await sleep(40); } return false; }
const count = (kind, id) => db.calls.filter((c) => c.kind === kind && (id === undefined || c.id === id)).length;

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}).`); process.exit(2);
  });
  const browser = await chromium.launch({ channel: 'chromium' });
  const newPage = async (init) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(([token, user]) => { try { localStorage.setItem('nextastore_token', token); localStorage.setItem('nextastore_user', JSON.stringify(user)); } catch (e) { /* ignore */ } }, [TOKEN, USER]);
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on('pageerror', (e) => allErrors.push(String(e.message || e)));
    return page;
  };
  try {
    const threadText = (page) => page.evaluate(() => document.getElementById('threadMessages')?.innerText || '');
    const bubbles = (page) => page.evaluate(() => document.querySelectorAll('#threadMessages .thread-message').length);
    const row = (id) => `[data-conversation-id="${id}"]`;
    const gotoMsgs = async (page, q = '') => { await page.goto(`http://localhost:${PORT}/messages.html${q}`); await page.waitForSelector('#threadReplyInput', { state: 'attached' }); };

    // ============================ A. prefetch by touch / focus
    resetDb();
    let page = await newPage();
    await gotoMsgs(page);
    await page.waitForSelector(row('conv_a'));
    await page.evaluate(() => document.querySelector('[data-conversation-id="conv_a"]').dispatchEvent(new Event('touchstart', { bubbles: true })));
    check('touching down on a row prefetches that thread (peek, nothing marked read)', await waitFor(() => count('peek', 'conv_a') === 1, 1500) && !db.markedRead.has('conv_a'), JSON.stringify(db.calls));
    await page.evaluate(() => { const r = document.querySelector('[data-conversation-id="conv_b"]'); r.dispatchEvent(new Event('touchstart', { bubbles: true })); r.dispatchEvent(new Event('touchmove', { bubbles: true })); });
    await sleep(300);
    check('a touch that turns into a scroll (touchmove) prefetches nothing', count('peek', 'conv_b') === 0, JSON.stringify(db.calls));
    // keyboard focus
    let focused = false;
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => !!document.activeElement?.dataset?.conversationId && document.activeElement.dataset.conversationId === 'conv_b');
    }
    check('tabbing to a row with the keyboard prefetches it', focused && await waitFor(() => count('peek', 'conv_b') === 1, 1500), `focused=${focused} ${JSON.stringify(db.calls)}`);
    check('clicking with a pointer does not double up on a prefetch (focus-by-mouse is not keyboard intent)', await (async () => { const before = count('peek', 'conv_long'); await page.click(row('conv_long')); await sleep(200); return count('peek', 'conv_long') === before; })());
    await page.context().close();

    // a tap that lands while the prefetch is still in flight paints when THAT lands
    resetDb(); db.peekDelayMs = 400; db.threadDelayMs = 1800;
    page = await newPage();
    await gotoMsgs(page);
    await page.waitForSelector(row('conv_b'));
    await page.evaluate(() => document.querySelector('[data-conversation-id="conv_b"]').dispatchEvent(new Event('touchstart', { bubbles: true })));
    await sleep(90);
    const t0 = Date.now();
    await page.click(row('conv_b'));
    const adopted = await waitFor(async () => (await threadText(page)).includes('Hello from B'), 1300);
    check('a tap while the prefetch is in flight paints as soon as it lands (~400ms), not after the 1.8s real request', adopted && (Date.now() - t0) < 1300, `${Date.now() - t0}ms`);
    check('...and the real (marking-read) request still goes out', await waitFor(() => count('open', 'conv_b') === 1, 3000));
    await page.context().close();

    // Data Saver
    resetDb();
    page = await newPage(() => { Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true }); });
    await gotoMsgs(page);
    await page.waitForSelector(row('conv_a'));
    await page.hover(row('conv_a'));
    await sleep(350);
    check('on Data Saver hovering prefetches nothing', count('peek') === 0, JSON.stringify(db.calls));
    await page.click(row('conv_a'));
    check('...but a click still opens the thread normally', await waitFor(async () => (await threadText(page)).includes('Hello from A'), 3000));
    await page.context().close();

    // ============================ B. "Message seller": the first message creates the conversation
    resetDb(); db.createDelayMs = 800;
    page = await newPage();
    await gotoMsgs(page, '?store=s_new&product=p1');
    check('the compose screen for a new conversation shows the store', await waitFor(async () => /Message New Store/.test(await threadText(page))), await threadText(page));
    await page.fill('#threadReplyInput', 'Is it available?');
    await page.click('#threadSendBtn');
    check('the first message shows as pending within 300ms although creating the conversation takes 800ms', await waitFor(() => page.evaluate(() => !!document.querySelector('.thread-message.is-mine.is-pending')), 300));
    check('...the textarea is not disabled (keeps the phone keyboard up), Send is held', await page.evaluate(() => !document.getElementById('threadReplyInput').disabled && document.getElementById('threadSendBtn').disabled));
    await page.fill('#threadReplyInput', 'second one');
    await page.press('#threadReplyInput', 'Enter');
    await sleep(150);
    check('a second Enter while the conversation is being created does not send and keeps the typed text', count('create') === 1 && (await page.inputValue('#threadReplyInput')) === 'second one', `${count('create')} / ${await page.inputValue('#threadReplyInput')}`);
    check('once created, the URL becomes ?conversation=… and the header names the store', await waitFor(async () => /conversation=conv_new1/.test(page.url()) && /New Store/.test(await page.evaluate(() => document.getElementById('threadHeader').innerText)), 4000), page.url());
    check('the message is shown exactly once, as sent (a tick), not pending', await waitFor(() => page.evaluate(() => document.querySelectorAll('.thread-message.is-mine').length === 1 && !document.querySelector('.thread-message.is-pending') && !!document.querySelector('.message-receipt[data-status="sent"]')), 3000));
    check('the new conversation appears in the list', await waitFor(() => page.evaluate(() => !!document.querySelector('[data-conversation-id="conv_new1"]')), 4000));
    check('Send is enabled again and the typed text was kept', await waitFor(async () => !(await page.evaluate(() => document.getElementById('threadSendBtn').disabled)) && (await page.inputValue('#threadReplyInput')) === 'second one', 2000));
    db.createDelayMs = 0;
    await page.click('#threadSendBtn');
    check('the next message goes to the existing conversation (not a second create)', await waitFor(() => count('post', 'conv_new1') === 1 && count('create') === 1, 3000), JSON.stringify(db.calls.map((c) => c.kind)));
    check('...and both messages end up shown once each', await waitFor(async () => (await bubbles(page)) === 2, 3000), String(await bubbles(page)));
    await page.context().close();

    // ============================ C. failed first message: persisted, same clientId, no ghost afterwards
    resetDb(); db.createFails = true;
    page = await newPage();
    await gotoMsgs(page, '?store=s_new2');
    await waitFor(async () => /Message Second Store/.test(await threadText(page)));
    await page.fill('#threadReplyInput', 'hello there');
    await page.click('#threadSendBtn');
    check('a failed first message becomes a failed bubble with Resend', await waitFor(() => page.evaluate(() => !!document.querySelector('.thread-message.is-failed [data-retry-message]')), 4000));
    check('...and Send is usable again', await waitFor(async () => !(await page.evaluate(() => document.getElementById('threadSendBtn').disabled)) || (await page.inputValue('#threadReplyInput')) === '', 1500));
    await page.reload();
    await page.waitForSelector('#threadReplyInput', { state: 'attached' });
    check('after a reload the failed bubble is still there (persisted)', await waitFor(() => page.evaluate(() => !!document.querySelector('.thread-message.is-failed [data-retry-message]')), 4000));
    db.createFails = false;
    await page.click('[data-retry-message]');
    check('Resend creates the conversation and shows the message once', await waitFor(async () => /conversation=conv_new1/.test(page.url()) && (await bubbles(page)) === 1 && !(await page.evaluate(() => !!document.querySelector('.thread-message.is-failed, .thread-message.is-pending'))), 5000), `${page.url()} ${await bubbles(page)}`);
    const creates = db.calls.filter((c) => c.kind === 'create');
    check('both attempts carried the same clientId (so a lost reply can never duplicate the message)', creates.length === 2 && creates[0].clientId && creates[0].clientId === creates[1].clientId, JSON.stringify(creates));
    check('the server holds exactly one copy', db.messages.conv_new1.length === 1);
    await gotoMsgs(page, '?store=s_new2');
    await sleep(500);
    check('coming back to the "message this store" screen later shows no ghost failed bubble', !(await page.evaluate(() => !!document.querySelector('.thread-message.is-failed'))), await threadText(page));
    await page.context().close();

    // ============================ D. attachments, optimistic
    resetDb(); db.postDelayMs = 700;
    page = await newPage();
    await gotoMsgs(page);
    await page.waitForSelector(row('conv_a'));
    await page.click(row('conv_a'));
    await waitFor(async () => (await threadText(page)).includes('Hello from A'));
    await page.evaluate(() => window.messagesManager.openAttachmentConfirm({ attachment: { type: 'location', lat: 0.3476, lng: 32.5825 }, defaultCaption: '' }));
    await page.fill('#attachConfirmCaption', 'Meet here');
    await page.click('#attachConfirmSend');
    check('a shared location shows as a pending card with its caption within 300ms', await waitFor(() => page.evaluate(() => { const b = document.querySelector('.thread-message.is-mine.is-pending'); return !!b && !!b.querySelector('.message-location-card') && /Meet here/.test(b.innerText); }), 300));
    check('...settles to one sent location card', await waitFor(() => page.evaluate(() => document.querySelectorAll('.thread-message .message-location-card').length === 1 && !document.querySelector('.thread-message.is-pending')), 4000));
    const locPost = db.calls.find((c) => c.kind === 'post' && c.attachment?.type === 'location');
    check('...and the server received the coordinates and the caption', !!locPost && locPost.attachment.lat === 0.3476 && locPost.attachment.lng === 32.5825 && locPost.body === 'Meet here', JSON.stringify(locPost));

    await page.evaluate(() => window.messagesManager.openAttachmentConfirm({ attachment: { type: 'product', productId: 'p9' }, optimisticProduct: { id: 'p9', name: 'Blue Kettle', price: 25000, stock: 3, images: [] }, defaultCaption: '' }));
    await page.click('#attachConfirmSend');
    check('a shared product shows its card (name) as pending straight away', await waitFor(() => page.evaluate(() => { const b = document.querySelector('.thread-message.is-pending'); return !!b && /Blue Kettle/.test(b.innerText) && !!b.querySelector('.message-product-card'); }), 300));
    check('...and settles to one sent product card', await waitFor(() => page.evaluate(() => document.querySelectorAll('.thread-message .message-product-card').length === 1 && !document.querySelector('.thread-message.is-pending')), 4000));

    db.postDelayMs = 0; db.postFails = true;
    await page.evaluate(() => window.messagesManager.openAttachmentConfirm({ attachment: { type: 'location', lat: 1.5, lng: 2.5 }, defaultCaption: 'again' }));
    await page.click('#attachConfirmSend');
    check('a failing attachment stays as a failed bubble with its card intact', await waitFor(() => page.evaluate(() => { const b = document.querySelector('.thread-message.is-failed'); return !!b && !!b.querySelector('.message-location-card') && !!b.querySelector('[data-retry-message]'); }), 4000));
    db.postFails = false;
    await page.click('[data-retry-message]');
    const resent = await waitFor(() => page.evaluate(() => !document.querySelector('.thread-message.is-failed') && !document.querySelector('.thread-message.is-pending') && document.querySelectorAll('.thread-message .message-location-card').length === 2), 4000);   // settled: not failed, not still pending
    check('Resend delivers the same attachment once', resent && db.messages.conv_a.filter((x) => x.type === 'location' && x.metadata.lat === 1.5).length === 1,
      JSON.stringify({ resent, cards: await page.evaluate(() => document.querySelectorAll('.thread-message .message-location-card').length), failedBubbles: await page.evaluate(() => document.querySelectorAll('.thread-message.is-failed').length), pending: await page.evaluate(() => document.querySelectorAll('.thread-message.is-pending').length), serverCopies: db.messages.conv_a.filter((x) => x.type === 'location' && x.metadata.lat === 1.5).length, calls: db.calls.filter((c) => c.kind === 'post').map((c) => [c.clientId && c.clientId.slice(-4), c.attachment && c.attachment.type]) }));
    await page.context().close();

    // ============================ E. "Load older" + the cache
    resetDb();
    page = await newPage();
    await gotoMsgs(page);
    await page.waitForSelector(row('conv_long'));
    await page.click(row('conv_long'));
    check('a long thread opens with the newest 100 and a Load-older button', await waitFor(async () => (await bubbles(page)) === 100 && await page.evaluate(() => !!document.getElementById('messagesLoadOlder')), 4000), String(await bubbles(page)));
    await page.click('#messagesLoadOlder');
    check('Load older brings the other 50 (150 in all) and the button goes', await waitFor(async () => (await bubbles(page)) === 150 && !(await page.evaluate(() => !!document.getElementById('messagesLoadOlder'))), 4000), String(await bubbles(page)));
    await page.click(row('conv_a'));
    await waitFor(async () => (await threadText(page)).includes('Hello from A'));
    db.threadDelayMs = 1500;
    await page.click(row('conv_long'));
    check('going back paints all 150 from the cache within 400ms (older history included)', await waitFor(async () => (await bubbles(page)) === 150, 400), String(await bubbles(page)));
    check('...opened at the newest message', await page.evaluate(() => { const c = document.getElementById('threadMessages'); return c.scrollTop + c.clientHeight >= c.scrollHeight - 40; }));
    await sleep(1800);
    check('after the background revalidation it is still 150, each once, no Load-older button', (await bubbles(page)) === 150 && !(await page.evaluate(() => !!document.getElementById('messagesLoadOlder'))));
    check('...in order', await page.evaluate(() => { const t = [...document.querySelectorAll('#threadMessages .thread-message')].map((n) => (n.innerText.match(/Msg (\d+)/) || [])[1]); return t.every((v, i) => v === String(i + 1).padStart(3, '0')); }));
    await page.context().close();

    check('no uncaught page errors in any scenario', allErrors.length === 0, allErrors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} messaging-flow browser checks passed.`);
  process.exit(failed ? 1 : 0);
})();
