#!/usr/bin/env node
'use strict';
/*
 * WIP 107: real-browser test of the Nexi floating panel and hero card LAYOUT, English and Luganda.
 * The REAL marketplace.html + css/assistant.css + js/assistant.js with a fake assistant API in front.
 *   npm run test:assistant-layout        (CHROMIUM_PATH=... to pick a binary; SHOTS=dir to save screenshots)
 *
 * Guards the four things that went wrong together:
 *   1. the starter questions stay on screen for the whole conversation (a CSS rule order bug made `hidden` lose)
 *   2. the language switch is a small pill, not a full-width 48px bar, yet each button is still a 44px tap target
 *   3. Luganda answers are longer: the conversation must still get most of the window, with its latest answer whole
 *   4. the taller panel must not ride up over the sticky site header
 * The Luganda strings below are layout filler of realistic length, not reviewed wording.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium'); process.exit(2);
}
const { chromium } = loadPlaywright();
const ORIGIN = 'http://localhost:3000', API = 'http://localhost:4000';
const EN = ['Opening a store on NextaStore is free to start. Create your account, add your store name and location, then upload your first products. You can start selling the same day.', 'Payments reach you through mobile money once the buyer confirms the order. Fees are shown before you publish any product so there are no surprises later.'];
const LG = ['Okuggulawo edduuka ku NextaStore tekusasulwa kutandika. Kola akaundi yo, ssaamu erinnya ly’edduuka lyo n’ekifo kyalyo, oluvannyuma oteekeko ebintu byo ebisooka. Oyinza okutandika okutunda ku lunaku olwo.', 'Ssente zituuka gy’oli ng’oyita mu mobile money omuguzi bw’akakasa oda. Ssente z’obuweereza ziragibwa nga tonnaba kufulumya kintu kyonna, tewali kikyamu kinaabaawo oluvannyuma.'];
const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const out = []; const check = (n, ok, d = '') => out.push({ n, ok: !!ok, d });
let reply = EN;

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage(); page.__ctx = ctx; page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === API) {
      const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname.endsWith('/assistant/chat')) return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ type: 'done', bubbles: reply }) });
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ data: {} }) });
    }
    if (u.origin === ORIGIN) {
      let f = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!fs.existsSync(f) && /^\/[A-Za-z0-9-]+$/.test(u.pathname)) f = path.join(ROOT, fs.existsSync(f + '.html') ? u.pathname + '.html' : 'marketplace.html');
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: 'nope' });
    }
    return route.abort();
  });
  await page.goto(ORIGIN + '/marketplace.html');
  return page;
}
const shot = async (page, name) => { if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') }); } };
const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }, sel);

async function converse(page, root, textarea) {
  for (const q of ['How do I open a store?', 'When do I get paid?']) { await page.fill(textarea, q); await page.keyboard.press('Enter'); await page.waitForTimeout(900); }
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [tag, vp] of [['phone 390x844', { width: 390, height: 844 }], ['small phone 320x640', { width: 320, height: 640 }], ['laptop 1280x800', { width: 1280, height: 800 }]]) {
    for (const lang of ['en', 'lg']) {
      reply = lang === 'lg' ? LG : EN;
      const L = `${tag} ${lang === 'lg' ? 'Luganda' : 'English'}`;
      const page = await newPage(browser, vp);
      await page.waitForSelector('#nexiDock', { timeout: 8000 });
      await page.evaluate(() => NexiAssistant.open()); await page.waitForTimeout(500);
      const P = '.nexi-panel';
      if (lang === 'lg') await page.click(`${P} .nexi-lang button[data-lang="lg"]`);
      // ---- idle ----
      check(`${L}, panel idle: the starter questions are shown`, await visible(page, `${P} .nexi-starters`));
      const idle = await page.evaluate(P => { const q = s => document.querySelector(P + ' ' + s).getBoundingClientRect(); const lang = q('.nexi-lang'), head = q('.nexi-panel-head'); const btns = [...document.querySelectorAll(P + ' .nexi-lang button')].map(b => b.getBoundingClientRect()); const vis = [...document.querySelectorAll(P + ' .nexi-lang .l-full')].map(e => e.getBoundingClientRect()); return { langH: Math.round(lang.height), langW: Math.round(lang.width), headW: Math.round(head.width), headH: Math.round(head.height), btnH: Math.min(...btns.map(b => b.height)), btnW: Math.min(...btns.map(b => b.width)), visH: Math.max(...vis.map(b => b.height)), words: [...document.querySelectorAll(P + ' .nexi-lang .l-full')].map(e => e.textContent.trim()) }; }, P);
      check(`${L}: the language switch is a small pill (<= 36px tall, under 65% of the header width), not a full-width bar`, idle.langH <= 36 && idle.langW < idle.headW * 0.65, JSON.stringify(idle));
      check(`${L}: yet each language button is still a 44px tap target, and both words are spelled out`, idle.btnH >= 44 && idle.btnW >= 44 && idle.words.join('|') === 'English|Luganda', JSON.stringify(idle));
      check(`${L}: the panel header is compact (<= 120px)`, idle.headH <= 120, String(idle.headH));
      await shot(page, `${tag.split(' ')[0]}-${lang}-idle`.replace(/\s/g, ''));
      // ---- chatting ----
      await converse(page, P, `${P} textarea`);
      check(`${L}, panel after the first question: the starter questions are gone`, !(await visible(page, `${P} .nexi-starters`)));
      const m = await page.evaluate(P => { const panel = document.querySelector(P).getBoundingClientRect(), body = document.querySelector(P + ' .nexi-panel-body'), br = body.getBoundingClientRect(); const bubbles = [...document.querySelectorAll(P + ' .nexi-msg.is-bot .nexi-bubble')].filter(b => b.offsetParent !== null); const last = bubbles[bubbles.length - 1].getBoundingClientRect(); const prev = bubbles[bubbles.length - 2] && bubbles[bubbles.length - 2].getBoundingClientRect(); const foot = document.querySelector(P + ' .nexi-handoff-link'); return { panelH: Math.round(panel.height), panelTop: Math.round(panel.top), viewH: Math.round(br.height), lastFullyVisible: last.top >= br.top - 1 && last.bottom <= br.bottom + 1, prevInView: !!prev && prev.bottom > br.top, footH: foot ? Math.round(foot.getBoundingClientRect().height) : null }; }, P);
      check(`${L}: the conversation gets at least 45% of the panel (not squeezed by header, starters and footer)`, m.viewH >= m.panelH * 0.45, `${m.viewH}px of ${m.panelH}px`);
      check(`${L}: the latest answer is fully on screen, with the one before it still partly in view`, m.lastFullyVisible && m.prevInView, JSON.stringify(m));
      if (vp.width >= 1024) {
        check(`${L}: the panel stays below the 76px site header`, m.panelTop >= 76, `top is ${m.panelTop}px`);
        check(`${L}: "Need a person? Chat on WhatsApp" is one line on the wide panel`, m.footH !== null && m.footH <= 48, String(m.footH));
      }
      await shot(page, `${tag.split(' ')[0]}-${lang}-chat`.replace(/\s/g, ''));
      // ---- new chat brings the starters back ----
      await page.click(`${P} .nexi-panel-head .nexi-iconbtn:not([hidden])`); await page.waitForTimeout(400);
      check(`${L}: "new chat" brings the starter questions back`, await visible(page, `${P} .nexi-starters`));
      check(`${L}: no page errors`, !page.__errors.length, page.__errors.join(' | '));
      await page.__ctx.close();
    }
  }
  // ---- hero card, laptop: same rules ----
  for (const lang of ['en', 'lg']) {
    reply = lang === 'lg' ? LG : EN;
    const page = await newPage(browser, { width: 1280, height: 800 });
    await page.waitForSelector('#heroChat .nexi-composer', { timeout: 8000 });
    if (lang === 'lg') await page.click('#heroChat .nexi-lang button[data-lang="lg"]');
    const L = `hero 1280x800 ${lang === 'lg' ? 'Luganda' : 'English'}`;
    check(`${L}, idle: the starter questions are shown`, await visible(page, '#heroChat .nexi-starters'));
    const h = await page.evaluate(() => { const l = document.querySelector('#heroChat .nexi-lang'), b = [...document.querySelectorAll('#heroChat .nexi-lang button')]; return { langH: Math.round(l.getBoundingClientRect().height), btnH: Math.min(...b.map(x => x.getBoundingClientRect().height)) }; });
    check(`${L}: compact pill with 44px tap targets`, h.langH <= 36 && h.btnH >= 44, JSON.stringify(h));
    await converse(page, '#heroChat', '#heroChat textarea');
    check(`${L}, after the first question: the starter questions are gone`, !(await visible(page, '#heroChat .nexi-starters')));
    check(`${L}: no page errors`, !page.__errors.length, page.__errors.join(' | '));
    await page.__ctx.close();
  }
  await browser.close();
  out.forEach(x => console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.ok ? '' : '  -> ' + x.d}`));
  const bad = out.filter(x => !x.ok); console.log(`\n${out.length - bad.length}/${out.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
