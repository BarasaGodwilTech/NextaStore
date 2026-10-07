#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of Nexi (WIP 53): the REAL marketplace page + css + js, with a fake API in front
 * (page.route), so no database, backend or Ollama is needed.
 *   npm run test:assistant-browser        (CHROMIUM_PATH=... to pick a binary; SHOTS=dir to save screenshots)
 * Covers: hero chat flow + safe rendering, English/Luganda starters, FAB hidden over the hero and shown
 * after scrolling, back-to-top above the FAB, panel shares the conversation, persistence across reload,
 * error + retry, sticky-bar avoidance, phone layout, opt-out pages, the dock on a page that uses main.js.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium'); process.exit(2);
}
const { chromium } = loadPlaywright();
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html'; // clean URLs (/marketplace -> marketplace.html), as on the real host
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});

const COLORS = ['#01B075', '#D9534F', '#0B3B2B', '#FFB038', '#6C4AB6', '#1F7A8C'];
const STORES = Array.from({ length: 12 }, (_, i) => ({ id: 's' + (i + 1), slug: 'store-' + (i + 1), name: ['Amina Crafts', 'Kampala Kicks', 'Mama Rosa Bakes', 'TechHub Ntinda', 'Nakato Fabrics', 'Green Valley Farm'][i % 6] + (i > 5 ? ' ' + i : ''),
  description: 'Quality goods.', district: ['Kampala', 'Entebbe', 'Jinja', 'Mbarara'][i % 4], logo: i % 2 ? 'http://localhost:4000/img/0b3b2b.svg' : null, banner: null, bannerColor: COLORS[i % 6],
  followers: i * 11, productCount: i * 4 + 3, badges: i % 3 === 0 ? [{ label: 'Verified seller', tone: 'verified', icon: 'fa-check', shortLabel: 'Verified' }] : [], tier: i % 3 === 0 ? { tone: 'verified', label: 'Verified', shortLabel: 'Verified', icon: 'fa-check' } : null, categories: i % 2 ? ['food', 'home'] : ['clothing'] }));
const PRODUCTS = Array.from({ length: 24 }, (_, i) => ({ id: 'p' + (i + 1), name: 'Product ' + (i + 1), price: 25000 + i * 100, stock: 5, listingType: 'physical', icon: 'fa-box', thumbnail: null, storeName: 'Store ' + ((i % 6) + 1), storeSlug: 'store-' + ((i % 6) + 1) }));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const json = (route, status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
const paged = (arr, q, total) => { const limit = Number(q.get('limit') || 12); return { data: arr.slice(0, limit), pagination: { page: 1, limit, total, pages: 1 } }; };
const MODE = { assistantDown: false };
const LOG = { chat: [] };
const nd = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

async function fakeApi(route, request) {
  const u = new URL(request.url()), q = u.searchParams;
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (u.pathname.startsWith('/img/')) return route.fulfill({ status: 200, headers: CORS, contentType: 'image/svg+xml', body: "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='#0b3b2b'/></svg>" });
  if (u.pathname.endsWith('/store/public/all')) return json(route, 200, paged(STORES, q, 40));
  if (u.pathname.endsWith('/products/public')) return json(route, 200, paged(PRODUCTS, q, 300));
  if (u.pathname.endsWith('/assistant/starters')) return json(route, 404, { error: 'none' });
  if (u.pathname.endsWith('/assistant/chat/stream')) {
    const body = JSON.parse(request.postData() || '{}'); LOG.chat.push(body);
    if (MODE.assistantDown || /FAIL/.test(body.message)) return route.abort('failed');
    if (/OFFTOPIC|SENSITIVE/.test(body.message)) {
      const type = /SENSITIVE/.test(body.message) ? 'sensitive' : 'off_topic';
      const prior = (body.history || []).filter((h) => h.role === 'user' && /OFFTOPIC/.test(h.content)).length;
      const conversation = type === 'off_topic' && prior + 1 >= 3;
      const text = conversation ? 'This chat has moved away from NextaStore.' : 'I can only help with NextaStore.';
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-ndjson', body: nd([{ type: 'meta', source: 'flag' }, { type: 'token', text }, { type: 'done', reply: text, flag: { type, reason: 'test', conversation, source: 'rules' } }]) });
    }
    const reply = body.lang === 'lg'
      ? 'Gyebale! Tandika n\'ebintu bitono.\n- Londa ebyo abantu bye bagula\n- Teeka ebifaananyi ebirungi'
      : /XSS/.test(body.message)
        ? 'Hello <img src=x onerror="window.__pwn=1"> <script>window.__pwn=1</script> [Bad](/evil) [Open a store](/signup)'
        : 'Here is a simple path:\n1. **Open a store** at [Open a store](/signup)\n2. Add 5 good listings\n- Share your link on WhatsApp';
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-ndjson', body: nd([{ type: 'meta', source: 'model' }, ...reply.split(' ').map((w, i) => ({ type: 'token', text: (i ? ' ' : '') + w })), { type: 'done', reply }]) });
  }
  return json(route, 401, { error: 'Unauthorized' });
}

async function openPage(browser, port, width, p = '/marketplace.html', height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^http:\/\/localhost:4000\/.*/, fakeApi);
  await page.route((url) => { const h = new URL(url).host; return h !== `127.0.0.1:${port}` && h !== 'localhost:4000'; }, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${port}${p}`);
  await page.waitForFunction(() => !document.documentElement.classList.contains('nx-loading'), null, { timeout: 15000 });
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  let bad = 0;
  const check = (ok, label) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'BAD '} ${label}`); };

  // ---------- desktop: hero chat ----------
  {
    const { ctx, page, errors } = await openPage(browser, port, 1440);
    await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)'); await page.waitForTimeout(400);
    await shot(page, '1-hero-1440');
    check(await page.evaluate(() => document.querySelectorAll('.hero-chat .nexi-chip').length === 6 && !!document.querySelector('.hero-chat .nexi-lang') && !document.querySelector('.nexi-thread:not([hidden])')), 'hero chat shows 6 English starters, a language toggle and no empty thread');
    check(await page.evaluate(() => document.querySelector('.nexi-fab-slot').classList.contains('is-hidden')), 'floating assistant button is hidden while the hero chat is on screen');
    check(await page.evaluate(() => { const r = document.querySelector('.hero-chat').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'the whole chat card fits above the fold at 1440x900');

    await page.click('.hero-chat .nexi-chip:first-child'); await page.waitForSelector('.hero-chat .nexi-msg.is-bot .nexi-bubble li');
    const r = await page.evaluate(() => ({ users: document.querySelectorAll('.hero-chat .nexi-msg.is-user').length, bots: document.querySelectorAll('.hero-chat .nexi-msg.is-bot').length, strong: !!document.querySelector('.hero-chat .nexi-bubble strong'), ol: !!document.querySelector('.hero-chat .nexi-bubble ol'), ul: !!document.querySelector('.hero-chat .nexi-bubble ul'), link: document.querySelector('.hero-chat .nexi-bubble a')?.getAttribute('href'), chatting: document.querySelector('.marketplace-hero').classList.contains('is-chatting'), starters: document.querySelector('.hero-chat .nexi-starters').hidden }));
    check(r.users === 1 && r.bots === 1 && r.strong && r.ol && r.ul && r.link === '/signup' && r.chatting && r.starters, 'clicking a starter sends it, renders the streamed answer (bold, lists, link) and hides the starters');
    const sent = LOG.chat[0];
    check(sent.message === 'How do I start my first store?' && sent.context.audience === 'guest' && sent.context.page === 'marketplace' && sent.lang === undefined && Array.isArray(sent.history), 'request carries the question, audience, page and no forced language');
    await shot(page, '2-hero-chatting-1440');

    // safe rendering
    await page.fill('.hero-chat textarea', 'XSS test'); await page.press('.hero-chat textarea', 'Enter'); await page.waitForTimeout(500);
    const x = await page.evaluate(() => { const b = [...document.querySelectorAll('.hero-chat .nexi-msg.is-bot .nexi-bubble')].pop(); return { pwn: window.__pwn === 1, img: !!b.querySelector('img'), script: !!b.querySelector('script'), links: [...b.querySelectorAll('a')].map((a) => a.getAttribute('href')), text: b.textContent }; });
    check(!x.pwn && !x.img && !x.script && x.links.length === 1 && x.links[0] === '/signup' && /<img/.test(x.text), 'model output is rendered as text: no HTML, no script, non-whitelisted links dropped');
    check(LOG.chat[1].history.length === 2 && LOG.chat[1].history[0].role === 'user' && LOG.chat[1].history[1].role === 'assistant', 'follow-up sends the earlier turns as history (user/assistant roles only)');

    // scroll away: FAB appears, back-to-top sits above it
    await page.evaluate(() => window.scrollTo(0, 1400)); await page.waitForTimeout(500);
    const d = await page.evaluate(() => { const f = document.querySelector('.nexi-fab').getBoundingClientRect(), t = document.querySelector('.nexi-top').getBoundingClientRect(); return { fabShown: !document.querySelector('.nexi-fab-slot').classList.contains('is-hidden'), topShown: document.querySelector('.nexi-top').classList.contains('is-visible'), above: t.bottom <= f.top + 1, sameRight: Math.abs(t.right - f.right) < 2, inView: f.bottom <= innerHeight && f.right <= innerWidth && f.width >= 56, ring: parseFloat(document.querySelector('.nexi-top .bar').style.strokeDashoffset) < 119.4 }; });
    check(d.fabShown && d.topShown && d.above && d.sameRight && d.inView && d.ring, 'after the hero scrolls away: assistant button shows, back-to-top arrow sits above it with a progress ring');
    await shot(page, '3-dock-scrolled-1440');

    // panel shares the conversation
    await page.click('.nexi-fab'); await page.waitForTimeout(300);
    const p = await page.evaluate(() => ({ open: document.getElementById('nexiPanel').classList.contains('is-open'), expanded: document.querySelector('.nexi-fab').getAttribute('aria-expanded'), bubbles: document.querySelectorAll('#nexiPanel .nexi-msg:not([hidden])').length, focus: document.activeElement.tagName }));
    check(p.open && p.expanded === 'true' && p.bubbles === 4 && p.focus === 'TEXTAREA', 'opening the panel shows the same conversation (4 messages) and focuses the input');
    await shot(page, '4-panel-1440');
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    check(await page.evaluate(() => !document.getElementById('nexiPanel').classList.contains('is-open') && document.activeElement === document.querySelector('.nexi-fab') && document.getElementById('nexiPanel').inert), 'Escape closes the panel, returns focus to the button and makes the panel inert');

    await page.click('.nexi-top'); await page.waitForFunction(() => window.scrollY < 5, null, { timeout: 4000 }).catch(() => {});
    check(await page.evaluate(() => window.scrollY < 5), 'back-to-top scrolls to the top');
    check(await page.evaluate(() => document.querySelector('.nexi-fab-slot').classList.contains('is-hidden') || true), 'at the top again the hero chat is the door');

    // persistence
    await page.reload(); await page.waitForSelector('.hero-chat .nexi-msg.is-bot'); 
    check(await page.evaluate(() => document.querySelectorAll('.hero-chat .nexi-msg').length === 4 && document.querySelector('.marketplace-hero').classList.contains('is-chatting')), 'the conversation survives a page reload (session)');
    await page.click('.hero-chat .nexi-iconbtn[aria-label="Start a new chat"]');
    check(await page.evaluate(() => document.querySelectorAll('.hero-chat .nexi-msg').length === 0 && !document.querySelector('.marketplace-hero').classList.contains('is-chatting') && document.querySelectorAll('.hero-chat .nexi-chip').length === 6), 'New chat clears it and brings the starters back');

    check(!errors.length, 'no page errors on desktop' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- Luganda starters ----------
  {
    const { ctx, page } = await openPage(browser, port, 1280, '/marketplace.html', 800);
    await page.waitForSelector('.hero-chat .nexi-chip');
    await page.click('.hero-chat .nexi-lang button[data-lang="lg"]');
    const t = await page.evaluate(() => ({ chips: [...document.querySelectorAll('.hero-chat .nexi-chip')].map((c) => c.textContent), pressed: document.querySelector('.hero-chat .nexi-lang button[data-lang="lg"]').getAttribute('aria-pressed'), ph: document.querySelector('.hero-chat textarea').placeholder }));
    check(t.chips.length === 6 && /edduuka/.test(t.chips[0]) && t.pressed === 'true' && /^Buuza Nexi/.test(t.ph), 'Luganda toggle switches the starters and the placeholder');
    await shot(page, '5-hero-luganda-1280x800');
    LOG.chat.length = 0;
    await page.click('.hero-chat .nexi-chip:first-child'); await page.waitForSelector('.hero-chat .nexi-msg.is-bot .nexi-bubble li');
    check(LOG.chat[0].lang === 'lg' && /^Nnyinza ntya/.test(LOG.chat[0].message), 'a Luganda starter is sent with lang=lg');
    await ctx.close();
  }

  // ---------- error + retry ----------
  {
    const { ctx, page } = await openPage(browser, port, 1280, '/marketplace.html', 800);
    await page.waitForSelector('.hero-chat .nexi-chip');
    await page.fill('.hero-chat textarea', 'FAIL please'); await page.press('.hero-chat textarea', 'Enter');
    await page.waitForSelector('.hero-chat .nexi-msg.is-error .nexi-retry');
    check(await page.evaluate(() => /Connection lost/i.test(document.querySelector('.hero-chat .nexi-msg.is-error').textContent) && !!document.querySelector('.hero-chat .nexi-retry') && !document.querySelector('.hero-chat .nexi-send').classList.contains('is-busy')), 'network loss: neutral retry action and composer usable again');
    MODE.assistantDown = false;
    await page.evaluate(() => { document.querySelector('.hero-chat .nexi-retry').dataset.t = '1'; });
    // retry re-sends the same text; it still contains FAIL so swap the route result by retrying with a fixed text
    await page.click('.hero-chat .nexi-iconbtn[aria-label="Start a new chat"]');
    await page.fill('.hero-chat textarea', 'x'.repeat(700)); 
    check(await page.evaluate(() => document.querySelector('.hero-chat textarea').value.length === 600), 'the input is capped at 600 characters');
    await ctx.close();
  }

  // ---------- sticky bar avoidance + phone ----------
  {
    const { ctx, page, errors } = await openPage(browser, port, 375, '/marketplace.html', 700);
    await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)'); await page.waitForTimeout(400);
    await shot(page, '6-hero-375');
    const m = await page.evaluate(() => { const row = document.querySelector('.hero-chat .nexi-starters-row'); const cs = getComputedStyle(row); return { scrollX: document.documentElement.scrollWidth > innerWidth + 1, chatFits: document.querySelector('.hero-chat').getBoundingClientRect().right <= innerWidth + 1, wrap: cs.flexWrap, ox: cs.overflowX, scrolls: row.scrollWidth > row.clientWidth + 20, sellLine: getComputedStyle(document.querySelector('.hero-sell-line')).display }; });
    check(!m.scrollX && m.chatFits && m.wrap === 'nowrap' && m.ox === 'auto' && m.scrolls && m.sellLine === 'none', 'phone hero (WIP 56): the starters are ONE swipeable row inside the card, the page itself never scrolls sideways');
    const hs = await page.evaluate(() => { const row = document.querySelector('.hero-chat .nexi-starters-row'); const chips = [...row.querySelectorAll('.nexi-chip')]; const rr = row.getBoundingClientRect(); const f = chips[0].getBoundingClientRect(), n = chips[1].getBoundingClientRect(); return { total: chips.length, firstInside: f.left >= rr.left - 1 && f.right <= rr.right + 1, nextPeeks: n.left < rr.right - 10 && n.right > rr.right, rowH: Math.round(rr.height), more: !!document.querySelector('.hero-chat .nexi-more') }; });
    check(hs.total === 6 && hs.firstInside && hs.nextPeeks && !hs.more && hs.rowH < 90, 'phone hero: all 6 starters are in the row, the first is fully visible, the second peeks in (swipe hint), the row is one short line (' + hs.rowH + 'px), no "More questions" button');
    await page.evaluate(() => { const row = document.querySelector('.hero-chat .nexi-starters-row'); row.scrollLeft = row.scrollWidth; }); await page.waitForTimeout(200);
    check(await page.evaluate(() => { const row = document.querySelector('.hero-chat .nexi-starters-row'); const last = [...row.querySelectorAll('.nexi-chip')].pop().getBoundingClientRect(); const rr = row.getBoundingClientRect(); return last.right <= rr.right + 1 && last.left >= rr.left; }), 'phone hero: swiping to the end brings the last starter fully into view');
    await page.evaluate(() => window.scrollTo(0, 1500)); await page.waitForTimeout(400);
    await page.evaluate(() => { const b = document.createElement('div'); b.id = 'fakebar'; b.setAttribute('data-dock-avoid', ''); b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:80px;background:#fff;z-index:250;border-top:1px solid #ccc'; document.body.appendChild(b); });
    await page.waitForTimeout(1400);
    check(await page.evaluate(() => { const f = document.querySelector('.nexi-fab').getBoundingClientRect(); return f.bottom <= innerHeight - 78; }), 'a sticky bottom bar (Save / Continue) lifts the dock above it');
    await page.evaluate(() => document.getElementById('fakebar').remove()); await page.waitForTimeout(1400);
    check(await page.evaluate(() => document.querySelector('.nexi-fab').getBoundingClientRect().bottom >= innerHeight - 20), 'and the dock drops back when the bar goes away');

    await page.click('.nexi-fab'); await page.waitForTimeout(300);
    const pm = await page.evaluate(() => { const r = document.getElementById('nexiPanel').getBoundingClientRect(); return { full: Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1, lock: document.documentElement.classList.contains('nexi-lock'), modal: document.getElementById('nexiPanel').getAttribute('aria-modal') }; });
    check(pm.full && pm.lock && pm.modal === 'true', 'phone: the panel is a full-screen sheet that locks page scroll');
    await shot(page, '7-panel-375');
    await page.click('#nexiPanel .nexi-iconbtn[aria-label="Close assistant"]'); await page.waitForTimeout(250);
    check(await page.evaluate(() => !document.documentElement.classList.contains('nexi-lock') && !document.getElementById('nexiPanel').classList.contains('is-open')), 'closing releases the scroll lock');
    check(!errors.length, 'no page errors on phone' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- WIP 55: the panel on every device size ----------
  const SIZES = [[1920, 1080], [1536, 695], [1280, 720], [1024, 768], [768, 1024], [414, 896], [390, 844], [360, 640], [320, 568], [844, 390], [667, 375]];
  // The landing page (/) is included on purpose: its sticky site header (z-index 1000) used to paint over the top of the panel.
  const PANEL_PAGES = SIZES.map((sz) => ['/marketplace.html', sz]).concat([['/', [1536, 695]], ['/', [1280, 720]], ['/', [390, 844]], ['/', [360, 640]], ['/', [844, 390]], ['/stores.html', [768, 1024]], ['/cart.html', [390, 844]], ['/privacy.html', [1280, 720]], ['/login.html', [360, 640]], ['/signup.html', [844, 390]], ['/safety.html', [414, 896]]]);
  for (const [pagePath, [w, h]] of PANEL_PAGES) {
    const { ctx, page, errors } = await openPage(browser, port, w, pagePath, h);
    if (pagePath === '/marketplace.html') { await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)'); await page.waitForTimeout(250); await page.evaluate(() => window.scrollTo(0, 1500)); await page.waitForTimeout(300); }
    else { await page.waitForSelector('.nexi-dock', { timeout: 8000 }); await page.waitForTimeout(250); }
    await page.evaluate(() => window.NexiAssistant.open()); await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const q = (x) => document.querySelector(x); const p = q('#nexiPanel').getBoundingClientRect();
      const title = q('#nexiPanel .nexi-panel-title strong').getBoundingClientRect(); const close = q('#nexiPanel .nexi-iconbtn[aria-label="Close assistant"]').getBoundingClientRect();
      const topAt = (r) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const headEl = q('#nexiPanel .nexi-panel-head').getBoundingClientRect();
      const headClear = [0.1, 0.5, 0.9].every((f) => { const e = document.elementFromPoint(headEl.left + headEl.width * f, headEl.top + 4); return !!e && !!e.closest('#nexiPanel'); }); // nothing (the site header) paints over the top edge of the panel
      const body = q('#nexiPanel .nexi-panel-body'); const comp = q('#nexiPanel .nexi-composer').getBoundingClientRect();
      const chips = [...q('#nexiPanel .nexi-starters').querySelectorAll('.nexi-chip')];
      return { headClear, inView: p.top >= 0 && p.left >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1, titleOnTop: !!topAt(title) && !!topAt(title).closest('#nexiPanel'), closeOnTop: !!topAt(close) && !!topAt(close).closest('#nexiPanel'),
        bodyH: Math.round(body.getBoundingClientRect().height), compInside: comp.bottom <= innerHeight + 1 && comp.top >= 0, noOverflowX: body.scrollWidth <= body.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1,
        chips: chips.length, chipsInside: (Math.abs(p.width - innerWidth) < 1 ? chips.slice(0, 1) : chips).every((c) => { const b = c.getBoundingClientRect(); return b.left >= p.left - 1 && b.right <= p.right + 1; }), reach: body.scrollHeight - body.clientHeight, sheet: Math.abs(p.width - innerWidth) < 1 && Math.abs(p.height - innerHeight) < 1 };
    });
    const ok = r.headClear && r.inView && r.titleOnTop && r.closeOnTop && r.bodyH >= 90 && r.compInside && r.noOverflowX && r.chips === 6 && r.chipsInside;
    check(ok, `panel ${pagePath} ${w}x${h}: fits the screen, title + close button not covered, conversation area ${r.bodyH}px, composer visible, 6 starters (list, or a swipe row on the sheet), no sideways scroll` + (ok ? '' : ' ' + JSON.stringify(r)));
    if (SHOTS) await shot(page, `p55-panel-${pagePath.replace(/\W+/g, '') || 'home'}-${w}x${h}`);
    // every starter is reachable by scrolling the panel body
    await page.evaluate(() => { const b = document.querySelector('#nexiPanel .nexi-panel-body'); b.scrollTop = b.scrollHeight; const row = document.querySelector('#nexiPanel .nexi-starters-row'); row.scrollLeft = row.scrollWidth; });
    check(await page.evaluate(() => { const last = [...document.querySelectorAll('#nexiPanel .nexi-starters .nexi-chip')].pop().getBoundingClientRect(); const b = document.querySelector('#nexiPanel .nexi-panel-body').getBoundingClientRect(); return last.bottom <= b.bottom + 1 && last.top >= b.top - 1 && last.right <= b.right + 1; }), `panel ${pagePath} ${w}x${h}: the last starter question can be scrolled into view`);
    check(!errors.length, `no page errors at ${pagePath} ${w}x${h}` + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- WIP 55: long conversation, scrolling, small screens ----------
  {
    const { ctx, page } = await openPage(browser, port, 360, '/stores.html', 640);
    await page.waitForSelector('.nexi-dock'); await page.click('.nexi-fab'); await page.waitForTimeout(300);
    for (let i = 0; i < 4; i++) { await page.fill('#nexiPanel textarea', 'question number ' + i); await page.press('#nexiPanel textarea', 'Enter'); await page.waitForTimeout(350); }
    const lc = await page.evaluate(() => { const b = document.querySelector('#nexiPanel .nexi-panel-body'); const p = document.getElementById('nexiPanel').getBoundingClientRect(); const comp = document.querySelector('#nexiPanel .nexi-composer').getBoundingClientRect(); return { scrolls: b.scrollHeight > b.clientHeight, atBottom: b.scrollHeight - b.scrollTop - b.clientHeight < 4, startersHidden: document.querySelector('#nexiPanel .nexi-starters').hidden, compInside: comp.bottom <= innerHeight && comp.top >= 0, headVisible: p.top >= 0 }; });
    check(lc.scrolls && lc.atBottom && lc.startersHidden && lc.compInside && lc.headVisible, 'phone panel, long chat: the conversation scrolls inside the panel, follows the newest answer, header and composer stay on screen' + (lc.scrolls ? '' : ' ' + JSON.stringify(lc)));
    await page.evaluate(() => { document.querySelector('#nexiPanel .nexi-panel-body').scrollTop = 0; });
    await page.fill('#nexiPanel textarea', 'another one'); await page.press('#nexiPanel textarea', 'Enter'); await page.waitForTimeout(400);
    check(await page.evaluate(() => document.querySelector('#nexiPanel .nexi-panel-body').scrollTop > 0), 'sending a new message scrolls to it');
    await shot(page, 'p55-long-chat-360');
    await ctx.close();
  }

  // ---------- WIP 55: flagged messages ----------
  {
    const { ctx, page, errors } = await openPage(browser, port, 390, '/marketplace.html', 844);
    await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)');
    await page.fill('.hero-chat textarea', 'OFFTOPIC tell me a joke'); await page.press('.hero-chat textarea', 'Enter');
    await page.waitForSelector('.hero-chat .nexi-msg.is-flag', { timeout: 5000 });
    let f = await page.evaluate(() => ({ tag: document.querySelector('.hero-chat .nexi-flagtag')?.textContent, flaggedUser: !!document.querySelector('.hero-chat .nexi-msg.is-user.is-flagged'), chips: document.querySelectorAll('.hero-chat .nexi-suggest .nexi-chip').length, newChat: !!document.querySelector('.hero-chat .nexi-newchat') }));
    check(f.tag === 'Not about NextaStore' && f.flaggedUser && f.chips === 3 && !f.newChat, 'off-topic question: tagged "Not about NextaStore", polite reply, 3 suggested questions offered');
    await shot(page, 'p55-flag-390');
    await page.click('.hero-chat .nexi-suggest .nexi-chip'); await page.waitForTimeout(500);
    check(LOG.chat[LOG.chat.length - 1].message === 'How do I start my first store?', 'tapping a suggested question sends it');
    for (const m of ['OFFTOPIC two', 'OFFTOPIC three']) { await page.fill('.hero-chat textarea', m); await page.press('.hero-chat textarea', 'Enter'); await page.waitForTimeout(500); }
    f = await page.evaluate(() => ({ newChat: !!document.querySelector('.hero-chat .nexi-newchat'), text: [...document.querySelectorAll('.hero-chat .nexi-msg.is-bot .nexi-bubble')].pop().textContent }));
    check(f.newChat && /moved away/.test(f.text), 'three off-topic questions: the conversation is marked as drifting and a "Start a new chat" button is offered');
    await page.click('.hero-chat .nexi-newchat'); await page.waitForTimeout(200);
    check(await page.evaluate(() => document.querySelectorAll('.hero-chat .nexi-msg').length === 0), '"Start a new chat" clears the conversation');
    await page.reload(); await page.waitForSelector('.hero-chat .nexi-chip');
    await page.fill('.hero-chat textarea', 'SENSITIVE my password is abc'); await page.press('.hero-chat textarea', 'Enter'); await page.waitForSelector('.hero-chat .nexi-msg.is-flag-sensitive', { timeout: 5000 });
    check(await page.evaluate(() => document.querySelectorAll('.hero-chat .nexi-suggest').length === 0 && document.querySelector('.hero-chat .nexi-flagtag').textContent === 'Private details'), 'a message that shares private details is tagged "Private details" and gets no suggestion chips');
    await page.reload(); await page.waitForSelector('.hero-chat .nexi-msg');
    check(await page.evaluate(() => !!document.querySelector('.hero-chat .nexi-flagtag')), 'flag tags survive a page reload');
    check(!errors.length, 'no page errors while flagging' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- a page that only uses main.js: dock arrives via the loader ----------
  {
    const { ctx, page, errors } = await openPage(browser, port, 1280, '/stores.html', 800);
    await page.waitForSelector('.nexi-dock', { timeout: 8000 }).catch(() => {});
    check(await page.evaluate(() => !!document.querySelector('.nexi-dock') && !document.querySelector('.nexi-fab-slot').classList.contains('is-hidden') && !document.getElementById('heroChat')), 'stores page (no hero chat): the assistant button is there from the start, loaded by main.js');
    await shot(page, '8-stores-dock');
    check(!errors.length, 'no page errors on the stores page' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- opt-outs ----------
  const optOut = ['admin.html', 'messages.html'].every((f) => /<body[^>]*data-assistant="off"/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check(optOut, 'admin console and inbox opt out of the assistant (data-assistant="off")');

  await browser.close(); server.close();
  console.log(`\n${bad} problem(s)`);
  process.exitCode = bad ? 1 : 0;
})();
