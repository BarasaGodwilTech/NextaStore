#!/usr/bin/env node
/*
 * Nexi widget UI audit (real browser). Put this in ai-assistant/scripts/ui-audit.js
 *
 * Setup once:   npm i -D playwright && npx playwright install chromium
 * Run:          node scripts/ui-audit.js            (from the project root, or pass the root as argv[2])
 *
 * It serves the static site (marketplace.html + js/ + css/), mocks every API call
 * (no backend, no Ollama needed) and checks the things unit tests cannot see:
 *   1. header layout at 320 / 375 / 1280 px (hero chat AND floating panel)
 *   2. Luganda mode: no English in visible UI chrome, aria-labels, titles, placeholders
 *   3. "Talk to a person" header link carries the CURRENT chat summary, no empty lines
 *   4. handoff button, product cards, store cards: fit, no overflow, tap targets
 *   5. no page errors
 * Exit code 0 only when every check passes.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.argv[2] || process.cwd());

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
  catch (e2) { console.error('playwright not found. Run: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
}

// ---------- tiny static server ----------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- fixtures ----------
const startersFile = ['ai-assistant/src/lang/starters.json', 'src/lang/starters.json'].map(p => path.join(ROOT, p)).find(fs.existsSync);
const STARTERS = startersFile ? fs.readFileSync(startersFile, 'utf8') : '{"en":[],"lg":[]}';
const nd = (...e) => e.map(x => JSON.stringify(x)).join('\n') + '\n';
const PRODUCTS = { kind: 'products', items: [
  { type: 'product', id: 'p1', name: 'Handmade leather messenger bag with an extra long product title that must wrap or truncate without breaking the card layout', price: 185000, originalPrice: 230000, storeName: 'Kampala Leather Works and Accessories Limited' },
  { type: 'product', id: 'p2', name: 'Phone case', price: 15000, storeName: 'Cases' },
  { type: 'product', id: 'p3', name: 'Gold watch', price: 12345678901, storeName: 'Time' },
  { type: 'product', id: 'p4', name: 'Sneakers', price: 90000, thumbnail: 'https://example.invalid/missing.jpg', storeName: 'Shoes Hub' }] };
const STORES = { kind: 'stores', items: [
  { type: 'store', id: 's1', name: 'Mukwano Fresh Produce and Groceries Wholesale Market Stall Number 14', slug: 'mukwano', district: 'Kampala', description: 'Fresh fruit and vegetables delivered daily across Kampala and Wakiso districts, with weekly bundles and bulk pricing for restaurants.' },
  { type: 'store', id: 's2', name: 'Zed', slug: 'zed', district: 'Gulu' }] };
const LG_HANDOFF = 'Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe.';
const EN_HANDOFF = 'I need to connect you with a human team member so they can help with this.';
let mode = 'plain';

async function open(browser, vp, touch) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage(); page._errs = [];
  page.on('pageerror', e => page._errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) page._errs.push('console: ' + m.text().slice(0, 140)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost:4000)/, r => r.abort());
  await page.route('http://localhost:4000/**', async route => {
    const u = route.request().url(); const json = b => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (u.endsWith('/starters')) return route.fulfill({ contentType: 'application/json', body: STARTERS });
    if (u.endsWith('/facts')) return json({ support: { email: 'support@nextastore.test', url: '/contact' } });
    if (u.endsWith('/handoff-contact')) return json({ enabled: true, whatsappDigits: '256761789006', displayNumber: '+256761789006', label: 'NextaStore support team', hoursNote: '' });
    if (u.endsWith('/chat/stream')) {
      const lg = JSON.parse(route.request().postData() || '{}').lang === 'lg'; let out;
      if (mode === 'products') out = nd({ type: 'token', text: 'Here are a few options.' }, { type: 'done', reply: 'x', bubbles: ['Here are a few options.'], cards: PRODUCTS });
      else if (mode === 'stores') out = nd({ type: 'token', text: 'These stores match.' }, { type: 'done', reply: 'x', bubbles: ['These stores match.'], cards: STORES });
      else if (mode === 'handoff') { const t = lg ? LG_HANDOFF : EN_HANDOFF; out = nd({ type: 'token', text: t }, { type: 'done', reply: t, bubbles: [t], handoff: { reason: 'not_in_context' } }); }
      else { const t = lg ? 'Weebale nnyo okubuuza.' : 'You can open a store from the Sell page.'; out = nd({ type: 'token', text: t }, { type: 'done', reply: t, bubbles: [t] }); }
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: out });
    }
    return json({ data: [], items: [], products: [], stores: [] });
  });
  return { ctx, page };
}
async function load(page, base) {
  await page.goto(base + '/marketplace.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#heroChat .hero-chat-head', { timeout: 10000 });
  await page.waitForTimeout(700);
}
async function ask(page, text) { const t = page.locator('#heroChat textarea'); await t.fill(text); await t.press('Enter'); await page.waitForTimeout(1300); }

// ---------- result collection ----------
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok || !detail ? '' : '\n         -> ' + detail)); };

// ---------- in-page helpers ----------
function headerMetrics(sel) {
  const head = document.querySelector(sel); if (!head) return null;
  const card = head.parentElement.getBoundingClientRect(); const hr = head.getBoundingClientRect();
  const kids = [...head.children].filter(c => c.offsetParent !== null).map(c => { const r = c.getBoundingClientRect(); return { cls: String(c.className).split(' ')[0], w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; });
  // the name itself is what is measured
  const title = head.querySelector('.hero-chat-title strong, .nexi-panel-title strong'); const tw = title ? Math.round(title.getBoundingClientRect().width) : -1;
  const notice = [...head.querySelectorAll('small, .nexi-handoff-notice')].filter(n => n.offsetParent !== null).map(n => ({ cls: String(n.className), h: Math.round(n.getBoundingClientRect().height) }));
  const cardR = Math.round(card.right);
  return { headH: Math.round(hr.height), titleW: tw, clipped: kids.filter(k => k.right > cardR + 1).map(k => k.cls + ' r=' + k.right + '>' + cardR), notice };
}
const ENGLISH = new Set('talk person this opens with short summary chat you can edit before sending try asking send message start new conversation starters previous more questions language guide mistakes orders payments check page itself seller back top open share please contact support the and for your our team human help whatsapp unavailable ask'.split(' '));
const ALLOW = new Set(['nexi', 'nextastore', 'whatsapp', 'english', 'luganda', 'ai']);
function chromeStrings() {
  const out = []; const roots = [document.querySelector('#heroChat'), document.querySelector('#nexiPanel')].filter(Boolean);
  const skip = el => el.closest('.nexi-chip, .nexi-msg-user, .nexi-user, [class*=bubble]:not(a):not(button)');
  roots.forEach(r => {
    const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const t = n.textContent.trim(); const p = n.parentElement; if (t && p && p.offsetParent !== null && !skip(p)) out.push(t); }
    r.querySelectorAll('[aria-label],[placeholder],[title]').forEach(e => { if (e.closest('.nexi-chip') || e.offsetParent === null && !e.closest('#nexiPanel')) return; ['aria-label', 'placeholder', 'title'].forEach(a => { const v = e.getAttribute(a); if (v) out.push(v); }); });
  });
  return [...new Set(out)];
}
function isEnglish(s) { const w = (s.toLowerCase().match(/[a-z']+/g) || []).filter(x => !ALLOW.has(x)); if (!w.length) return false; const hits = w.filter(x => ENGLISH.has(x)).length; return hits >= 2 || (w.length === 1 && hits === 1) || hits / w.length >= 0.5; }

(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    // 1. header layout ---------------------------------------------------
    for (const [label, vp, touch] of [['320px', { width: 320, height: 568 }, true], ['375px', { width: 375, height: 667 }, true], ['1280px', { width: 1280, height: 800 }, false]]) {
      console.log('\n[header layout @' + label + ']');
      const { ctx, page } = await open(browser, vp, touch); mode = 'plain'; await load(page, base);
      const m = await page.evaluate(headerMetrics, '#heroChat .hero-chat-head');
      check(label + ' hero header is compact (<= 120px tall: two rows, nothing hidden)', m && m.headH <= 120, m && 'height ' + m.headH + 'px');
      check(label + ' hero title keeps readable width (>= 60px)', m && m.titleW >= 60, m && 'title width ' + m.titleW + 'px');
      check(label + ' hero header has no clipped controls', m && !m.clipped.length, m && m.clipped.join('; '));
      check(label + ' no explainer paragraph inside the header', m && !m.notice.some(n => n.h > 40), m && JSON.stringify(m.notice));
      await page.evaluate(() => window.scrollTo(0, 99999)); await page.waitForTimeout(1100);
      // open through the widget's public API: on a wide desktop the dock button can stay hidden while the hero is still on screen, and a forced click on a hidden button never opened the panel (the 1280px rows then measured nothing)
      await page.evaluate(() => window.NexiAssistant && window.NexiAssistant.open()); await page.waitForTimeout(900);
      const pm = await page.evaluate(headerMetrics, '#nexiPanel .nexi-panel-head');
      check(label + ' floating-panel header is compact (<= 150px tall: two rows plus padding, nothing hidden)', pm && pm.headH <= 150, pm && 'height ' + pm.headH + 'px');
      check(label + ' floating-panel title keeps readable width (>= 60px)', pm && pm.titleW >= 60, pm && 'title width ' + pm.titleW + 'px');
      check(label + ' floating-panel header has no clipped controls', pm && !pm.clipped.length, pm && pm.clipped.join('; '));
      check(label + ' no page errors', !page._errs.length, page._errs.join(' | '));
      await ctx.close();
    }

    // 2/3/4. English chat, cards, handoff on a phone ---------------------
    console.log('\n[English chat, cards, handoff @375px]');
    { const { ctx, page } = await open(browser, { width: 375, height: 667 }, true); mode = 'plain'; await load(page, base);
      mode = 'products'; await ask(page, 'show me bags');
      const c = await page.evaluate(() => { const bad = []; document.querySelectorAll('#heroChat .nexi-card').forEach(card => { const r = card.getBoundingClientRect(), p = card.parentElement.getBoundingClientRect(); if (r.right > p.right + 1 || r.left < p.left - 1) bad.push('card exceeds its container'); card.querySelectorAll('*').forEach(n => { if (n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible') bad.push('text overflows: ' + String(n.className).slice(0, 30)); }); }); const small = [...document.querySelectorAll('#heroChat .nexi-card-open, #heroChat .nexi-card-share')].filter(b => { const r = b.getBoundingClientRect(); return r.width < 40 || r.height < 40; }).length; return { n: document.querySelectorAll('#heroChat .nexi-card').length, bad, small, docOverflow: document.documentElement.scrollWidth - innerWidth }; });
      check('product cards render and fit', c.n >= 4 && !c.bad.length, JSON.stringify(c.bad.slice(0, 3)));
      check('card buttons are tappable (>= 40px)', c.small === 0, c.small + ' too small');
      check('no horizontal page scroll with cards', c.docOverflow <= 0, c.docOverflow + 'px');
      mode = 'stores'; await ask(page, 'find stores');
      const s = await page.evaluate(() => ({ docOverflow: document.documentElement.scrollWidth - innerWidth }));
      check('no horizontal page scroll with store cards', s.docOverflow <= 0, s.docOverflow + 'px');
      mode = 'handoff'; await ask(page, 'what is the delivery fee');
      await page.locator('#heroChat .nexi-handoff-link, #heroChat .nexi-handoff-header').first().hover().catch(() => {}); await page.waitForTimeout(300);
      const h = await page.evaluate(() => { const hdr = document.querySelector('#heroChat .nexi-handoff-link, #heroChat .nexi-handoff-header'); const btn = [...document.querySelectorAll('#heroChat a.nexi-handoff')].pop(); const rd = a => a ? decodeURIComponent((a.href.split('text=')[1] || '')) : ''; const hb = hdr && hdr.getBoundingClientRect(); return { hdrHref: hdr ? hdr.href : '', hdrText: rd(hdr), btnText: rd(btn), btnTarget: btn && btn.target, btnRel: btn && btn.rel, hdrH: hb && Math.round(hb.height) }; });
      check('handoff button opens wa.me in a new tab with noopener', /^https:\/\/wa\.me\/2567\d{8}\?text=/.test(h.hdrHref) && h.btnTarget === '_blank' && /noopener/.test(h.btnRel || ''), JSON.stringify({ t: h.btnTarget, r: h.btnRel }));
      check('handoff button summary has the user question', /delivery fee/.test(h.btnText), h.btnText.slice(0, 120));
      check('"Talk to a person" header link carries the CURRENT chat summary', /delivery fee/.test(h.hdrText), 'header link text: ' + JSON.stringify(h.hdrText.slice(0, 140)));
      check('summary has no empty "label: " lines', !/:\s*(\n|$)/.test(h.hdrText) && !/:\s*(\n|$)/.test(h.btnText), JSON.stringify(h.hdrText.slice(-90)));
      check('header "Talk to a person" is a comfortable tap target (>= 40px)', h.hdrH >= 40, h.hdrH + 'px tall');
      check('no page errors', !page._errs.length, page._errs.join(' | '));
      await ctx.close(); }

    // 5. Luganda chrome --------------------------------------------------
    console.log('\n[Luganda mode: no English in UI chrome]');
    { const { ctx, page } = await open(browser, { width: 375, height: 667 }, true); mode = 'plain'; await load(page, base);
      await page.locator('#heroChat button:has-text("Luganda")').click(); await page.waitForTimeout(700);
      let eng = (await page.evaluate(chromeStrings)).filter(isEnglish);
      check('Luganda, idle: no English UI text / aria-labels / titles / placeholder', !eng.length, eng.slice(0, 8).join(' | '));
      mode = 'plain'; await ask(page, 'Nsobola ntya okutunda?'); mode = 'handoff'; await ask(page, 'Ssente ze delivery ziri ntya?');
      await page.locator('#heroChat .nexi-handoff-link, #heroChat .nexi-handoff-header').first().hover().catch(() => {}); await page.waitForTimeout(300);
      eng = (await page.evaluate(chromeStrings)).filter(isEnglish);
      check('Luganda, after a handoff: no English UI text', !eng.length, eng.slice(0, 8).join(' | '));
      const lg = await page.evaluate(() => { const rd = a => a ? decodeURIComponent((a.href.split('text=')[1] || '')) : ''; return { hdr: rd(document.querySelector('#heroChat .nexi-handoff-link, #heroChat .nexi-handoff-header')), btn: rd([...document.querySelectorAll('#heroChat a.nexi-handoff')].pop()) }; });
      check('Luganda header link summary is current and in Luganda', /delivery/.test(lg.hdr) && !/Language: English/.test(lg.hdr), JSON.stringify(lg.hdr.slice(0, 140)));
      check('Luganda handoff button summary is in Luganda', /Luganda/.test(lg.btn) && !/Language: English/.test(lg.btn), JSON.stringify(lg.btn.slice(0, 100)));
      check('no page errors', !page._errs.length, page._errs.join(' | '));
      await ctx.close(); }
  } finally { await browser.close(); srv.close(); }
  const failed = results.filter(r => !r.ok);
  console.log('\nui-audit: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
