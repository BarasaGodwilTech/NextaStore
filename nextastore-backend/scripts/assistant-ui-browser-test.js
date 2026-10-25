#!/usr/bin/env node
'use strict';
/*
 * WIP 94: real-browser UI check of Nexi's header, handoff link, Luganda chrome, cards and keyboard focus.
 * The REAL marketplace page + css + js with a fake API in front (no backend, database or Ollama).
 *   npm run test:assistant-ui        (SHOTS=dir to save screenshots)
 * Needs Playwright + Chromium (npm i -D playwright && npx playwright install chromium).
 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'); process.exit(2);
}
const { chromium } = loadPlaywright();
const nexi = require('./lib/nexi-ready'); // WIP 95: state-based waits (no fixed sleeps)
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
// expected interface text, read from the widget source itself
const widgetSrc = fs.readFileSync(path.join(ROOT, 'js/assistant.js'), 'utf8');
const T = new Function('return (function(){' + widgetSrc.slice(widgetSrc.indexOf('var T = {'), widgetSrc.indexOf('// T-END')) + ' return T; })()')();

T.en.title_name = 'Ask Nexi'; T.lg.title_name = 'Buuza Nexi'; // COPY.title in js/assistant.js
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const json = (route, status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
const nd = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const LONG = 'Extra Large Premium Handwoven Bark Cloth Wall Hanging With Traditional Baganda Patterns And Framed Edge';
const PRODUCT_CARDS = { kind: 'products', query: 'phones', items: [
  { type: 'product', id: 'p1', name: 'Samsung Galaxy A15 128GB', price: 650000, originalPrice: 720000, thumbnail: 'http://localhost:4000/img/ok.svg', storeName: 'TechHub Ntinda' },
  { type: 'product', id: 'p2', name: LONG, price: 1250000000, thumbnail: 'http://localhost:4000/img/missing.png', storeName: 'A Store With An Extremely Long Name That Keeps On Going' },
  { type: 'product', id: 'p3', name: 'Supercalifragilisticexpialidocious_unbreakable_token_without_spaces_123456789' },
  { type: 'product', id: 'p4', name: 'Tiny', price: 0 },
] };
const STORE_CARDS = { kind: 'stores', query: 'shops', items: [
  { type: 'store', id: 's1', slug: 'amina-crafts', name: 'Amina Crafts', district: 'Kampala', logo: 'http://localhost:4000/img/ok.svg', description: 'Handmade baskets, bark cloth and gifts from Kampala.' },
  { type: 'store', id: 's2', slug: 'x', name: LONG, district: 'A Very Long District Name That Overflows The Card Width Easily' },
] };
const MODE = { contact: 'on', kind: 'products' };
async function fakeApi(route, request) {
  const u = new URL(request.url());
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (u.pathname === '/img/ok.svg') return route.fulfill({ status: 200, headers: CORS, contentType: 'image/svg+xml', body: "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='#0b3b2b'/></svg>" });
  if (u.pathname.startsWith('/img/')) return route.fulfill({ status: 404, headers: CORS });
  if (u.pathname.endsWith('/store/public/all') || u.pathname.endsWith('/products/public')) return json(route, 200, { data: [], pagination: { page: 1, limit: 12, total: 0, pages: 1 } });
  if (u.pathname.endsWith('/assistant/handoff-contact')) return MODE.contact === 'on' ? json(route, 200, { enabled: true, whatsappDigits: '256712345678' }) : json(route, 200, { enabled: false });
  if (u.pathname.endsWith('/assistant/facts')) return json(route, 200, { support: { url: 'https://example.test/support', label: 'support' } });
  if (u.pathname.endsWith('/assistant/starters')) return json(route, 404, { error: 'none' });
  if (u.pathname.endsWith('/assistant/chat/stream')) {
    const cards = MODE.kind === 'products' ? PRODUCT_CARDS : STORE_CARDS; const reply = 'Here are some options I found.';
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-ndjson', body: nd([{ type: 'meta', source: 'catalog' }, { type: 'token', text: reply }, { type: 'cards', ...cards }, { type: 'done', reply, cards }]) });
  }
  return json(route, 401, { error: 'Unauthorized' });
}
async function openPage(browser, port, w, h, touch) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', hasTouch: !!touch, isMobile: !!touch, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await nexi.track(page);
  await page.route(/^http:\/\/localhost:4000\/.*/, fakeApi);
  await page.route((url) => { const x = new URL(url).host; return x !== `127.0.0.1:${port}` && x !== 'localhost:4000'; }, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${port}/marketplace.html`);
  await page.waitForFunction(() => !document.documentElement.classList.contains('nx-loading'), null, { timeout: 15000 });
  // ready = hero rendered + starters answered + handoff contact resolved (links out of their loading state)
  await nexi.waitReady(page, { starters: true, contact: MODE.contact });
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
// state waits (WIP 95): each waits for the thing that was previously slept for, and fails after a timeout; none retries an assertion
const switchLang = async (page, scope, lang) => { await page.click(`${scope} .nexi-lang button[data-lang="${lang}"]`); await page.waitForFunction(([s, l]) => document.querySelector(`${s} .nexi-lang button[data-lang="${l}"]`).getAttribute('aria-pressed') === 'true', [scope, lang]); };
const sendAndWait = async (page, scope, text, cardSel) => { // send, then wait until the answer finished streaming (composer idle) and, if given, the cards rendered
  await page.fill(`${scope} textarea`, text); await page.press(`${scope} textarea`, 'Enter');
  await page.waitForFunction(([s, c]) => { const b = document.querySelector(`${s} .nexi-send`); return !!document.querySelector(`${s} .nexi-msg.is-bot`) && !!b && !b.classList.contains('is-busy') && (!c || !!document.querySelector(`${s} ${c}`)); }, [scope, cardSel || ''], { timeout: 15000, polling: 'raf' });
};
const showFab = async (page) => { await page.evaluate(() => window.scrollTo(0, 1800)); await page.waitForFunction(() => !document.querySelector('.nexi-fab-slot').classList.contains('is-hidden'), null, { polling: 'raf' }); await nexi.settle(page); };
// bounded waits that never throw: on timeout they return false and the checks that follow report the problem as BAD (not a crashed run)
const panelOpen = async (page) => { const ok = await page.waitForFunction(() => { const p = document.getElementById('nexiPanel'); return !!p && p.classList.contains('is-open') && !p.inert && p.contains(document.activeElement); }, null, { timeout: 10000, polling: 'raf' }).then(() => true, () => false); await nexi.settle(page); return ok; };
const panelClosed = (page) => page.waitForFunction(() => { const p = document.getElementById('nexiPanel'); return !!p && !p.classList.contains('is-open') && p.inert && document.activeElement === document.querySelector('.nexi-fab'); }, null, { timeout: 10000, polling: 'raf' }).then(() => true, () => false);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  let bad = 0; const check = (ok, label) => { if (!ok) bad++; console.log(`${ok ? 'ok   ' : 'BAD  '} ${label}`); };
  const SIZES = [[320, 640, true], [340, 640, true], [360, 700, true], [375, 700, true], [1280, 800, false]];

  // ---------- hero header, handoff link, idle state ----------
  for (const contact of ['on', 'off']) for (const [w, h, touch] of SIZES) for (const lang of ['en', 'lg']) {
    MODE.contact = contact; MODE.kind = 'products';
    const { ctx, page, errors } = await openPage(browser, port, w, h, touch);
    const tag = `hero ${w} ${lang} contact-${contact}`;
    if (lang === 'lg') await switchLang(page, '.hero-chat', 'lg');
    const L = T[lang];
    const r = await page.evaluate(() => {
      const card = document.querySelector('.hero-chat').getBoundingClientRect(); const head = document.querySelector('.hero-chat-head'); const hr = head.getBoundingClientRect();
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.left >= card.left - 0.5 && b.right <= card.right + 0.5; };
      const kids = [...head.children].filter((k) => k.getClientRects().length);   // WIP 101: the idle New-chat button is hidden, not measured
      const link = document.querySelector('.hero-chat .nexi-handoff-link'); const lr = link.getBoundingClientRect();
      const note = document.querySelector('.hero-chat .nexi-handoff-notice');
      const lang = head.querySelector('.nexi-lang');
      const st = head.querySelector('.hero-chat-title strong'); const rg = document.createRange(); rg.selectNodeContents(st); const tcut = rg.getBoundingClientRect().right > st.getBoundingClientRect().right + 0.5 || st.scrollWidth > st.clientWidth + 0.5;
      return { titleName: st.textContent, titleCut: tcut, headH: Math.round(hr.height), titleW: Math.round(head.querySelector('.hero-chat-title strong').getBoundingClientRect().width), allInside: kids.every(inside) && inside(link) && [...document.querySelectorAll('.hero-chat .nexi-handoff-row > *')].filter((n) => !n.hidden).every(inside),
        noticeInHead: !!head.querySelector('.nexi-handoff-notice'), headText: head.textContent.replace(/\s+/g, ' ').trim(), linkH: Math.round(lr.height), linkText: link.textContent, linkFits: link.scrollWidth <= link.clientWidth + 1, linkBelowHead: lr.top >= document.querySelector('.hero-chat .nexi-composer').getBoundingClientRect().bottom - 1, linkGlyph: !!link.querySelector('svg'), headHasLink: !!head.querySelector('.nexi-handoff-link'),
        linkTab: link.getAttribute('tabindex'), linkAria: link.getAttribute('aria-label'), noteHidden: note.hidden || note.getBoundingClientRect().height === 0, langH: Math.round(lang.querySelector('button').getBoundingClientRect().height), pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    });
    check(r.headH <= 120 && r.titleW >= 90 && r.allInside && !r.pageOverflow, `${tag}: header ${r.headH}px high (<=120, two rows, nothing hidden), title ${r.titleW}px (>=90), every control inside the card, no page overflow`);
    check(!r.titleCut && r.titleName === L.title_name, `${tag}: the name "${r.titleName}" is shown in full (never "Buuza N…")`);
    check(!r.noticeInHead && !/WhatsApp|summary|Kino kijja/.test(r.headText), `${tag}: nothing explanatory in the header ("${r.headText.slice(0, 60)}")`);
    check(r.linkText === L.need_person && r.linkFits && r.linkBelowHead && r.linkGlyph && !r.headHasLink && r.linkH >= 44 && r.linkTab === '0' && r.linkAria === L.need_person, `${tag}: "${L.need_person}" link: full text, WhatsApp glyph, under the composer (not in the header), ${r.linkH}px tall, focusable, accessible name`);
    check(r.noteHidden, `${tag}: no explanation visible before a tap`);
    if (touch) check(r.langH >= 44, `${tag}: language buttons ${r.langH}px tall (>=44 on touch)`);
    // keyboard reachable + tap shows the right line
    // the contact is already resolved (openPage waited for it), so the link is final: it carries its href (contact on) or has none (off)
    await page.focus('.hero-chat .nexi-handoff-link');
    check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('nexi-handoff-link')), `${tag}: the link takes keyboard focus`);
    const popup = contact === 'on' ? page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null) : null; // Enter on an <a href target=_blank> opens WhatsApp in a new tab
    await page.press('.hero-chat .nexi-handoff-link', 'Enter');
    await page.waitForFunction(() => { const n = document.querySelector('.hero-chat .nexi-handoff-notice'); return !n.hidden && n.getBoundingClientRect().height > 8 && n.textContent.length > 0; }, null, { polling: 'raf' }); // the explanation is rendered
    // contact off: the unavailable line also carries the support link, which is fetched after the note first renders
    if (contact === 'off') await page.waitForFunction(() => !!document.querySelector('.hero-chat .nexi-handoff-notice a'), null, { polling: 'raf' });
    if (popup) { const pop = await popup; await pop.close().catch(() => {}); }
    const after = await page.evaluate(() => { const n = document.querySelector('.hero-chat .nexi-handoff-notice'); return { visible: !n.hidden && n.getBoundingClientRect().height > 8, text: n.textContent, warn: n.classList.contains('is-warn') }; });
    if (contact === 'on') check(after.visible && after.text === L.talk_explain, `${tag}: after Enter the explanation shows (${lang})`);
    else check(after.visible && after.text.startsWith(L.talk_unavailable) && /support/.test(after.text), `${tag}: after Enter the "unavailable, contact support" line shows (${lang})`);
    if (w === 375 || w === 1280) await shot(page, `hero-${w}-${lang}-${contact}`);
    check(!errors.length, `${tag}: no page errors${errors.length ? ': ' + errors[0] : ''}`);
    await ctx.close();
  }

  // ---------- href carries the CURRENT conversation ----------
  for (const lang of ['en', 'lg']) {
    MODE.contact = 'on'; MODE.kind = 'products';
    const { ctx, page } = await openPage(browser, port, 375, 700, true);
    if (lang === 'lg') await switchLang(page, '.hero-chat', 'lg');
    const hrefText = async () => { const href = await page.evaluate(() => document.querySelector('.hero-chat .nexi-handoff-link').getAttribute('href')); return href ? decodeURIComponent(href.split('text=')[1] || '') : null; };
    const before = await hrefText();
    check(before !== null && !/My recent questions|Ebibuuzo byange|Question Nexi could not answer|Ekibuuzo Nexi/.test(before) && /^https:\/\/wa\.me\/256712345678\?text=/.test(await page.evaluate(() => document.querySelector('.hero-chat .nexi-handoff-link').getAttribute('href'))), `href ${lang}: with no chat yet there is no empty "recent questions" / "could not answer" line`);
    check(lang === 'lg' ? /Olulimi: Luganda/.test(before) : /Language: English/.test(before), `href ${lang}: summary header follows the language`);
    await sendAndWait(page, '.hero-chat', 'Where is my order 123456?', '.nexi-card');
    const afterChat = await hrefText();
    check(/Where is my order 123456\?/.test(afterChat) && /(My recent questions|Ebibuuzo byange): Where is my order/.test(afterChat) && /(Question Nexi could not answer|Ekibuuzo Nexi ky’etannyanukula): Where is my order/.test(afterChat), `href ${lang}: rebuilt from the conversation after messages arrive (no reload)`);
    // switching language rewrites the summary header too
    await switchLang(page, '.hero-chat', lang === 'en' ? 'lg' : 'en');
    const switched = await hrefText();
    check(lang === 'en' ? /Olulimi: Luganda/.test(switched) : /Language: English/.test(switched), `href ${lang}: switching language rebuilds the summary language line`);
    await ctx.close();
  }

  // ---------- Luganda chrome repaints on switch (hero + panel + cards + dock) ----------
  {
    MODE.contact = 'on'; MODE.kind = 'products';
    const { ctx, page } = await openPage(browser, port, 1280, 800, false);
    await sendAndWait(page, '.hero-chat', 'show me phones', '.nexi-card');
    await showFab(page);
    await page.click('.nexi-fab'); await panelOpen(page);
    const snap = () => page.evaluate(() => {
      const a = (sel, attr) => { const e = document.querySelector(sel); return e ? (attr ? e.getAttribute(attr) : e.textContent.trim()) : null; };
      return {
        talkHero: a('.hero-chat .nexi-handoff-link'), talkPanel: a('#nexiPanel .nexi-handoff-link'), tryAsking: a('.hero-chat .nexi-starters-label'), foot: a('.hero-chat .nexi-foot'), footPanel: a('#nexiPanel .nexi-foot'),
        newChatAria: a('.hero-chat .nexi-iconbtn', 'aria-label'), newChatTitle: a('.hero-chat .nexi-iconbtn', 'title'), closeAria: a('#nexiPanel .nexi-iconbtn:last-of-type', 'aria-label'),
        langGroup: a('.hero-chat .nexi-lang', 'aria-label'), convo: a('.hero-chat .nexi-thread', 'aria-label'), startersGroup: a('.hero-chat .nexi-starters', 'aria-label'), prev: a('.hero-chat .nexi-starters-arrow--prev', 'aria-label'), next: a('.hero-chat .nexi-starters-arrow--next', 'aria-label'),
        ta: a('.hero-chat textarea', 'aria-label'), send: a('.hero-chat .nexi-send', 'aria-label'), top: a('.nexi-top', 'aria-label'), fab: a('.nexi-fab', 'aria-label'), fabLabel: a('.nexi-fab-label'), panel: a('#nexiPanel', 'aria-label'),
        cards: a('.hero-chat .nexi-cards', 'aria-label'), open: a('.hero-chat .nexi-card-open'), share: a('.hero-chat .nexi-card-share', 'title'), openAria: a('.hero-chat .nexi-card-open', 'aria-label'), shareAria: a('.hero-chat .nexi-card-share', 'aria-label'),
        togglesEn: a('.hero-chat .nexi-lang button[data-lang="en"]', 'aria-label'), togglesLg: a('.hero-chat .nexi-lang button[data-lang="lg"]', 'aria-label'), tagged: document.querySelectorAll('[data-nx-t]').length,
      };
    });
    const expectFor = (lg) => { const L = T[lg]; return {
      talkHero: L.need_person, talkPanel: L.need_person, tryAsking: L.try_asking, foot: L.foot, footPanel: L.foot, newChatAria: L.new_chat, newChatTitle: L.new_chat_title, closeAria: L.close,
      langGroup: L.chat_language, convo: L.conversation, startersGroup: L.starters, prev: L.prev_q, next: L.more_q, ta: L.message_nexi, send: L.send, top: L.back_top, fab: L.fab, fabLabel: L.fab_label, panel: L.panel,
      cards: L.products, open: L.card_open, share: L.card_share, openAria: L.card_open_aria.replace('{n}', 'Samsung Galaxy A15 128GB'), shareAria: L.card_share_aria.replace('{n}', 'Samsung Galaxy A15 128GB'), togglesEn: 'English', togglesLg: 'Luganda' }; };
    const en = await snap(); const expEn = expectFor('en');
    const mismatchEn = Object.keys(expEn).filter((k) => en[k] !== expEn[k]);
    check(mismatchEn.length === 0, 'English chrome is complete' + (mismatchEn.length ? ': ' + mismatchEn.map((k) => `${k}="${en[k]}"`).join(', ') : ''));
    await switchLang(page, '.hero-chat', 'lg');
    const lg = await snap(); const expLg = expectFor('lg');
    const mismatchLg = Object.keys(expLg).filter((k) => lg[k] !== expLg[k]);
    check(mismatchLg.length === 0, 'switching to Luganda repaints ALL chrome (hero, panel, cards, floating button, back to top)' + (mismatchLg.length ? ': ' + mismatchLg.map((k) => `${k}="${lg[k]}"`).join(', ') : ''));
    const stillEnglish = Object.keys(expLg).filter((k) => !['togglesEn', 'togglesLg', 'fabLabel'].includes(k) && lg[k] === en[k]);
    check(stillEnglish.length === 0, 'no Luganda chrome string is identical to its English one' + (stillEnglish.length ? ': ' + stillEnglish.join(', ') : ''));
    await switchLang(page, '#nexiPanel', 'en');
    const back = await snap(); const mismatchBack = Object.keys(expEn).filter((k) => back[k] !== expEn[k]);
    check(mismatchBack.length === 0, 'switching back to English repaints everything again' + (mismatchBack.length ? ': ' + mismatchBack.join(', ') : ''));
    check(!/DRAFT|needs_review/i.test(JSON.stringify(lg)), 'no review wording in the visible interface');
    await ctx.close();
  }

  // ---------- tap targets on touch (cards + header controls while chatting) ----------
  for (const kind of ['products', 'stores']) for (const [w, h] of [[320, 640], [375, 700]]) {
    MODE.contact = 'on'; MODE.kind = kind;
    const { ctx, page, errors } = await openPage(browser, port, w, h, true);
    await sendAndWait(page, '.hero-chat', 'show me ' + kind, '.nexi-card');
    const r = await page.evaluate(() => {
      const issues = []; const vw = document.documentElement.clientWidth; const card = document.querySelector('.hero-chat').getBoundingClientRect();
      const ctrls = [...document.querySelectorAll('.hero-chat .nexi-lang button, .hero-chat .nexi-handoff-link, .hero-chat .nexi-iconbtn:not([hidden]), .hero-chat .nexi-card-open, .hero-chat .nexi-card-share')];
      ctrls.forEach((c) => { const b = c.getBoundingClientRect(); if (b.height < 43.5 || b.width < 43.5) issues.push(c.className.slice(0, 22) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height)); if (b.right > card.right + 0.5 || b.left < card.left - 0.5) issues.push(c.className.slice(0, 22) + ' outside card'); });
      const head = document.querySelector('.hero-chat-head'); if (head.getBoundingClientRect().height > 120) issues.push('header ' + Math.round(head.getBoundingClientRect().height) + 'px');
      const cards = [...document.querySelectorAll('.hero-chat .nexi-card')]; const holder = document.querySelector('.hero-chat .nexi-cards'); if (holder.closest('.nexi-bubble') || holder.parentElement !== document.querySelector('.hero-chat .nexi-thread')) issues.push('cards are not direct children of the thread'); const br = document.querySelector('.hero-chat .nexi-thread').getBoundingClientRect();
      cards.forEach((c, i) => { const cr = c.getBoundingClientRect(); if (cr.right > br.right + 1) issues.push('card ' + i + ' outside the thread'); c.querySelectorAll('*').forEach((e) => { const er = e.getBoundingClientRect(); if (er.width && er.right > cr.right + 1) issues.push('card ' + i + ' child overflows'); }); });
      return { n: cards.length, issues, overflow: document.documentElement.scrollWidth > vw + 1 };
    });
    check(r.n === (kind === 'products' ? 4 : 2) && !r.overflow && r.issues.length === 0, `touch ${kind} ${w}px: header + link + card controls >= 44px and inside, cards do not overflow` + (r.issues.length ? ': ' + r.issues.slice(0, 5).join(' | ') : ''));
    check(!errors.length, `touch ${kind} ${w}px: no page errors`);
    await ctx.close();
  }

  // ---------- floating panel: header, focus, modal behaviour ----------
  for (const [w, h, touch] of SIZES) for (const how of ['keyboard', 'pointer']) {
    MODE.contact = 'on'; MODE.kind = 'products';
    const { ctx, page, errors } = await openPage(browser, port, w, h, touch);
    await showFab(page);
    const tag = `panel ${w} (${how} open)`;
    if (how === 'keyboard') { await page.focus('.nexi-fab'); await page.keyboard.press('Enter'); } else { await page.click('.nexi-fab'); }
    await panelOpen(page);
    const r = await page.evaluate(() => {
      const p = document.getElementById('nexiPanel'); const pr = p.getBoundingClientRect(); const head = p.querySelector('.nexi-panel-head'); const hr = head.getBoundingClientRect();
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.left >= pr.left - 0.5 && b.right <= pr.right + 0.5; };
      const ctrls = [...p.querySelectorAll('.nexi-panel-head > *, .nexi-lang button, .nexi-handoff-link')].filter((n) => !n.hidden && n.getBoundingClientRect().width);
      const link = p.querySelector('.nexi-handoff-link').getBoundingClientRect(); const ae = document.activeElement;
      return { headH: Math.round(hr.height), titleW: Math.round(head.querySelector('.nexi-panel-title strong').getBoundingClientRect().width), inside: ctrls.every(inside), noNotice: !head.querySelector('.nexi-handoff-notice'), headText: head.textContent.replace(/\s+/g, ' ').trim(),
        linkH: Math.round(link.height), focusIn: !!ae && p.contains(ae), focusTag: ae ? ae.tagName + (ae.id ? '#' + ae.id : '') : '', role: p.getAttribute('role'), modal: p.getAttribute('aria-modal'), minH: Math.min(...[...p.querySelectorAll('.nexi-lang button, .nexi-iconbtn:not([hidden])')].map((n) => n.getBoundingClientRect().height)) };
    });
    check(r.headH <= 150 && r.titleW >= 90 && r.inside && r.noNotice && !/WhatsApp|summary/.test(r.headText), `${tag}: header ${r.headH}px, title ${r.titleW}px, controls inside, nothing explanatory in it`);
    check(r.linkH >= 44 && r.role === 'dialog', `${tag}: "Talk to a person" ${r.linkH}px tall, panel is role=dialog`);
    check(r.focusIn, `${tag}: focus moved into the panel (${r.focusTag})`);
    if (touch) { check(r.modal === 'true', `${tag}: aria-modal=true on the phone sheet`); check(r.minH >= 43.5, `${tag}: panel language + icon buttons >= 44px (${Math.round(r.minH)})`); }
    if (touch && how === 'pointer') check(r.focusTag !== 'TEXTAREA', `${tag}: touch opening does not pop the keyboard (focus on ${r.focusTag})`);
    if (touch && how === 'keyboard') check(r.focusTag === 'TEXTAREA', `${tag}: keyboard opening lands in the message box`);
    if (touch) { // focus trap on the sheet
      let escaped = false; for (let i = 0; i < 14; i++) { await nexi.press(page, 'Tab'); if (!(await page.evaluate(() => document.getElementById('nexiPanel').contains(document.activeElement)))) { escaped = true; break; } }
      check(!escaped, `${tag}: Tab never leaves the modal sheet`);
      escaped = false; for (let i = 0; i < 14; i++) { await nexi.press(page, 'Shift+Tab'); if (!(await page.evaluate(() => document.getElementById('nexiPanel').contains(document.activeElement)))) { escaped = true; break; } }
      check(!escaped, `${tag}: Shift+Tab never leaves the modal sheet`);
      check(await page.evaluate(() => [...document.getElementById('nexiPanel').querySelectorAll('a[tabindex="0"]')].every((a) => a.getAttribute('role') === 'button' || a.getAttribute('href'))), `${tag}: the handoff link is reachable inside the trap`);
    }
    if (w === 375 || w === 1280) await shot(page, `panel-${w}-${how}`);
    await page.keyboard.press('Escape'); await panelClosed(page);
    check(await page.evaluate(() => document.activeElement === document.querySelector('.nexi-fab') && document.getElementById('nexiPanel').inert), `${tag}: Escape closes it and returns focus to the floating button`);
    check(!errors.length, `${tag}: no page errors${errors.length ? ': ' + errors[0] : ''}`);
    await ctx.close();
  }

  // ---------- starter arrows in the hero: both stay on the "Try asking" line; the one that cannot move is dimmed (aria-disabled), not hidden ----------
  {
    MODE.contact = 'on';
    const { ctx, page, errors } = await openPage(browser, port, 320, 640, true);
    const ROW = '.hero-chat .nexi-starters-row', PREV = '.hero-chat .nexi-starters-arrow--prev', NEXT = '.hero-chat .nexi-starters-arrow--next';
    const st = () => page.evaluate(([row, prev, next]) => { const r = document.querySelector(row), p = document.querySelector(prev), n = document.querySelector(next), a = document.activeElement, lab = document.querySelector('.hero-chat .nexi-starters-label').getBoundingClientRect(), pr = p.getBoundingClientRect(), nr = n.getBoundingClientRect(), card = document.querySelector('.hero-chat').getBoundingClientRect(); return { scrollable: r.scrollWidth > r.clientWidth + 1, left: r.scrollLeft, prevHidden: p.hidden, nextHidden: n.hidden, prevOff: p.getAttribute('aria-disabled') === 'true', nextOff: n.getAttribute('aria-disabled') === 'true', onLabelLine: Math.abs((pr.top + pr.bottom) / 2 - (lab.top + lab.bottom) / 2) < 12 && Math.abs((nr.top + nr.bottom) / 2 - (lab.top + lab.bottom) / 2) < 12, inside: pr.left >= card.left && nr.right <= card.right + 0.5, size: Math.round(Math.min(pr.width, pr.height, nr.width, nr.height)), active: a === p ? 'prev' : a === n ? 'next' : a === r.querySelector('.nexi-chip') ? 'firstChip' : a === document.body ? 'BODY' : a.tagName + '.' + String(a.className).split(' ')[0] }; }, [ROW, PREV, NEXT]);
    const s0 = await st();
    check(s0.scrollable && !s0.prevHidden && !s0.nextHidden && s0.prevOff && !s0.nextOff, `hero arrows 320: both arrows show at the start; only "previous" is dimmed${s0.scrollable ? '' : ' (row does not overflow)'}`);
    check(s0.onLabelLine && s0.inside && s0.size >= 44, `hero arrows 320: both sit on the "Try asking" line, inside the card, >= 44px tap area (${s0.size}px)`);
    await page.focus(PREV); await nexi.press(page, 'Enter');
    check((await st()).left <= 1, 'hero arrows 320: pressing the dimmed "previous" arrow does nothing');
    await page.focus(NEXT);
    let guard = 0; while (!(await st()).nextOff && guard++ < 20) await nexi.press(page, 'Enter');
    const a1 = await st();
    check(a1.nextOff && !a1.prevOff && guard < 20, 'hero arrows 320: the "more" arrow scrolls the row to its end, then dims; "previous" comes alive');
    check(a1.active === 'next', `hero arrows 320: the dimmed arrow keeps keyboard focus (was: ${a1.active})`);
    await page.focus(PREV);
    guard = 0; while (!(await st()).prevOff && guard++ < 20) await nexi.press(page, 'Enter');
    const a2 = await st();
    check(a2.prevOff && !a2.nextOff && a2.active === 'prev' && guard < 20, `hero arrows 320: "previous" scrolls back to the start and dims, focus stays on it (was: ${a2.active})`);
    // the whole row fits: both arrows go away at once and focus moves to the first question
    await page.focus(NEXT);
    await page.evaluate((row) => { document.querySelectorAll(row + ' .nexi-chip').forEach((c, i) => { if (i > 0) c.style.display = 'none'; else { c.style.maxWidth = '60px'; c.style.overflow = 'hidden'; } }); window.dispatchEvent(new Event('resize')); }, ROW);
    await nexi.settle(page);
    const a3 = await st();
    check(!a3.scrollable && a3.prevHidden && a3.nextHidden, 'hero arrows 320: with the row fitting both arrows are hidden');
    check(a3.active === 'firstChip', `hero arrows 320: both arrows hid and focus moved to the first starter chip (was: ${a3.active})`);
    await page.evaluate((row) => { document.querySelectorAll(row + ' .nexi-chip').forEach((c) => { c.style.display = ''; c.style.maxWidth = ''; c.style.overflow = ''; }); window.dispatchEvent(new Event('resize')); }, ROW);
    await nexi.settle(page);
    await page.focus('.hero-chat textarea');
    await page.evaluate((row) => { const r = document.querySelector(row); r.scrollLeft = r.scrollWidth; }, ROW); await nexi.settle(page);
    await page.evaluate((row) => { document.querySelector(row).scrollLeft = 0; }, ROW); await nexi.settle(page);
    check(await page.evaluate(() => document.activeElement === document.querySelector('.hero-chat textarea')), 'hero arrows 320: arrows dimming and showing never take focus away from the composer');
    check(!errors.length, `hero arrows 320: no page errors${errors.length ? ': ' + errors[0] : ''}`);
    await ctx.close();
  }

  // ---------- starter arrows in the floating panel: the same, on the phone sheet ----------
  {
    MODE.contact = 'on';
    const { ctx, page, errors } = await openPage(browser, port, 320, 640, true);
    await showFab(page); await page.click('.nexi-fab'); await panelOpen(page);
    const ROW = '#nexiPanel .nexi-starters-row', PREV = '#nexiPanel .nexi-starters-arrow--prev', NEXT = '#nexiPanel .nexi-starters-arrow--next';
    const st = () => page.evaluate(([row, prev, next]) => { const r = document.querySelector(row), p = document.querySelector(prev), n = document.querySelector(next), a = document.activeElement, lab = document.querySelector('#nexiPanel .nexi-starters-label').getBoundingClientRect(), pr = p.getBoundingClientRect(), nr = n.getBoundingClientRect(), card = document.querySelector('#nexiPanel').getBoundingClientRect(); return { scrollable: r.scrollWidth > r.clientWidth + 1, left: r.scrollLeft, prevHidden: p.hidden, nextHidden: n.hidden, prevOff: p.getAttribute('aria-disabled') === 'true', nextOff: n.getAttribute('aria-disabled') === 'true', onLabelLine: Math.abs((pr.top + pr.bottom) / 2 - (lab.top + lab.bottom) / 2) < 12 && Math.abs((nr.top + nr.bottom) / 2 - (lab.top + lab.bottom) / 2) < 12, inside: pr.left >= card.left && nr.right <= card.right + 0.5, size: Math.round(Math.min(pr.width, pr.height, nr.width, nr.height)), active: a === p ? 'prev' : a === n ? 'next' : a === r.querySelector('.nexi-chip') ? 'firstChip' : a === document.body ? 'BODY' : a.tagName + '.' + String(a.className).split(' ')[0] }; }, [ROW, PREV, NEXT]);
    const s0 = await st();
    check(s0.scrollable && !s0.prevHidden && !s0.nextHidden && s0.prevOff && !s0.nextOff, `panel arrows 320: both arrows show at the start; only "previous" is dimmed${s0.scrollable ? '' : ' (row does not overflow)'}`);
    check(s0.onLabelLine && s0.inside && s0.size >= 44, `panel arrows 320: both sit on the "Try asking" line, inside the card, >= 44px tap area (${s0.size}px)`);
    await page.focus(PREV); await nexi.press(page, 'Enter');
    check((await st()).left <= 1, 'panel arrows 320: pressing the dimmed "previous" arrow does nothing');
    await page.focus(NEXT);
    let guard = 0; while (!(await st()).nextOff && guard++ < 20) await nexi.press(page, 'Enter');
    const a1 = await st();
    check(a1.nextOff && !a1.prevOff && guard < 20, 'panel arrows 320: the "more" arrow scrolls the row to its end, then dims; "previous" comes alive');
    check(a1.active === 'next', `panel arrows 320: the dimmed arrow keeps keyboard focus (was: ${a1.active})`);
    await page.focus(PREV);
    guard = 0; while (!(await st()).prevOff && guard++ < 20) await nexi.press(page, 'Enter');
    const a2 = await st();
    check(a2.prevOff && !a2.nextOff && a2.active === 'prev' && guard < 20, `panel arrows 320: "previous" scrolls back to the start and dims, focus stays on it (was: ${a2.active})`);
    // the whole row fits: both arrows go away at once and focus moves to the first question
    await page.focus(NEXT);
    await page.evaluate((row) => { document.querySelectorAll(row + ' .nexi-chip').forEach((c, i) => { if (i > 0) c.style.display = 'none'; else { c.style.maxWidth = '60px'; c.style.overflow = 'hidden'; } }); window.dispatchEvent(new Event('resize')); }, ROW);
    await nexi.settle(page);
    const a3 = await st();
    check(!a3.scrollable && a3.prevHidden && a3.nextHidden, 'panel arrows 320: with the row fitting both arrows are hidden');
    check(a3.active === 'firstChip', `panel arrows 320: both arrows hid and focus moved to the first starter chip (was: ${a3.active})`);
    await page.evaluate((row) => { document.querySelectorAll(row + ' .nexi-chip').forEach((c) => { c.style.display = ''; c.style.maxWidth = ''; c.style.overflow = ''; }); window.dispatchEvent(new Event('resize')); }, ROW);
    await nexi.settle(page);
    await page.focus('#nexiPanel textarea');
    await page.evaluate((row) => { const r = document.querySelector(row); r.scrollLeft = r.scrollWidth; }, ROW); await nexi.settle(page);
    await page.evaluate((row) => { document.querySelector(row).scrollLeft = 0; }, ROW); await nexi.settle(page);
    check(await page.evaluate(() => document.activeElement === document.querySelector('#nexiPanel textarea')), 'panel arrows 320: arrows dimming and showing never take focus away from the composer');
    check(!errors.length, `panel arrows 320: no page errors${errors.length ? ': ' + errors[0] : ''}`);
    await ctx.close();
  }


  await browser.close(); server.close();
  console.log(bad ? `${bad} BAD` : 'all ok');
  process.exit(bad ? 1 : 0);
})();
