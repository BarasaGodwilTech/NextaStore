#!/usr/bin/env node
/*
 * Nexi widget DESIGN audit (real browser). Put this in ai-assistant/scripts/design-audit.js
 * Setup once: npm i -D playwright && npx playwright install chromium
 * Run:        node scripts/design-audit.js ..        (argument = project root that contains marketplace.html)
 *
 * These are measurable design rules, not taste. They apply to the hero chat AND the floating panel:
 *   - chrome (header + toolbar) leaves room for the conversation on a phone
 *   - readable type: nothing under 12 px, buttons/links 14 px or more, the text box 16 px (stops iOS zoom-on-focus)
 *   - tap targets 44 x 44 px
 *   - WCAG AA contrast for every text (4.5:1) and for the placeholder
 *   - product cards sit directly in the thread, full width (no card inside a message bubble) with a visible image fallback
 *   - the human-handoff button is a real button: icon, 48 px tall, no underline
 *   - motion respects prefers-reduced-motion
 *   - no horizontal overflow at 320 / 375 / 390 / 1280
 * Screenshots (for you to LOOK at) go to the OS temp folder, never into the project. Exit code 0 only if every rule passes.
 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const ROOT = path.resolve(process.argv[2] || process.cwd());
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); } catch (e2) { console.error('playwright not found. Run: npm i -D playwright && npx playwright install chromium'); process.exit(2); } }
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-design-'));

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const serve = () => new Promise(res => { const s = http.createServer((q, r) => { const p = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, p === '/' ? 'index.html' : p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, '127.0.0.1', () => res(s)); });
const startersFile = ['ai-assistant/src/lang/starters.json', 'src/lang/starters.json'].map(p => path.join(ROOT, p)).find(fs.existsSync);
const STARTERS = startersFile ? fs.readFileSync(startersFile, 'utf8') : '{"en":[],"lg":[]}';
const nd = (...e) => e.map(x => JSON.stringify(x)).join('\n') + '\n';
const PRODUCTS = { kind: 'products', items: [
  { type: 'product', id: 'p1', name: 'Handmade leather messenger bag with an extra long product title that must wrap or truncate cleanly', price: 185000, originalPrice: 230000, storeName: 'Kampala Leather Works and Accessories Limited' },
  { type: 'product', id: 'p2', name: 'Phone case', price: 15000, storeName: 'Cases' },
  { type: 'product', id: 'p3', name: 'Sneakers', price: 90000, thumbnail: 'https://example.invalid/missing.jpg', storeName: 'Shoes Hub' }] };
const EN_HO = 'I need to connect you with a human team member so they can help with this.';
const LG_HO = 'Nsaba nkuyungaganye n’omukozi wa NextaStore akuyambe.';
let mode = 'plain';
async function open(browser, vp, touch, extra = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: !!touch, isMobile: !!touch, reducedMotion: extra.reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage(); page._errs = [];
  page.on('pageerror', e => page._errs.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost:4000)/, r => r.abort());
  await page.route('http://localhost:4000/**', async route => {
    const u = route.request().url(); const json = b => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (u.endsWith('/starters')) return route.fulfill({ contentType: 'application/json', body: STARTERS });
    if (u.endsWith('/facts')) return json({ support: { email: 'support@nextastore.test', url: '/contact' } });
    if (u.endsWith('/handoff-contact')) return json({ enabled: true, whatsappDigits: '256761789006', displayNumber: '+256761789006', label: 'NextaStore support team', hoursNote: '' });
    if (u.endsWith('/chat/stream')) {
      const lg = JSON.parse(route.request().postData() || '{}').lang === 'lg'; let out;
      if (mode === 'products') out = nd({ type: 'token', text: 'Here are a few options.' }, { type: 'done', reply: 'x', bubbles: ['Here are a few options.'], cards: PRODUCTS });
      else if (mode === 'handoff') { const t = lg ? LG_HO : EN_HO; out = nd({ type: 'token', text: t }, { type: 'done', reply: t, bubbles: [t], handoff: { reason: 'not_in_context' } }); }
      else { const t = 'You can open a store from the Sell page. It only takes a few minutes, and you can add your first products straight away.'; out = nd({ type: 'token', text: t }, { type: 'done', reply: t, bubbles: [t] }); }
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: out });
    }
    return json({ data: [], items: [], products: [], stores: [] });
  });
  await page.goto(extra.base + '/marketplace.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#heroChat .hero-chat-head', { timeout: 10000 }); await page.waitForTimeout(800);
  return { ctx, page };
}
async function ask(page, text) { const t = page.locator('#heroChat textarea'); await t.fill(text); await t.press('Enter'); await page.waitForTimeout(1300); }

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok || !detail ? '' : '\n         -> ' + detail)); };

// ---- measured inside the page; root = '#heroChat' or '#nexiPanel' ----
function measure(rootSel) {
  const root = document.querySelector(rootSel); if (!root) return { missing: true };
  const vis = el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const bgOf = el => { let e = el; const layers = []; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } e = e.parentElement; } let base = { r: 255, g: 255, b: 255 }; for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; } return base; };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05); };
  const out = { small: [], smallInteractive: [], lowContrast: [], tiny: [], underline: [], textarea: null };
  const seen = new Set();
  root.querySelectorAll('*').forEach(el => {
    if (!vis(el)) return; const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize);
    const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
    const interactive = el.matches('button, a, [role=button], .nexi-chip');
    if (txt) {
      const key = String(el.className).split(' ')[0] + '|' + txt.slice(0, 20);
      if (!seen.has(key)) { seen.add(key);
        if (fs < 12) out.small.push(`${fs.toFixed(1)}px ${txt.slice(0, 24)}`);
        else if (interactive && fs < 14 && !el.closest('.nexi-lang, .nexi-bubble p')) out.smallInteractive.push(`${fs.toFixed(1)}px ${txt.slice(0, 24)}`);
        const fg = parse(cs.color); if (fg) { const r = ratio(fg, bgOf(el)); if (r < 4.5) out.lowContrast.push(`${r.toFixed(2)} ${txt.slice(0, 24)}`); } }
    }
    if (el.matches('button, .nexi-chip, .nexi-card-open, .nexi-card-share, a.nexi-handoff, a.nexi-handoff-link') && !el.closest('.nexi-bubble p')) { const r = el.getBoundingClientRect(); if (r.width > 0 && (r.width < 44 - .5 || r.height < 44 - .5)) out.tiny.push(`${Math.round(r.width)}x${Math.round(r.height)} ${(el.getAttribute('aria-label') || el.textContent || el.className).toString().trim().slice(0, 22)}`); }
    if (el.matches('a.nexi-handoff, a.nexi-handoff-link, .nexi-card-open, .nexi-card-share') && cs.textDecorationLine.includes('underline')) out.underline.push(el.className.toString().split(' ')[0]);
  });
  const ta = root.querySelector('textarea'); if (ta) { const cs = getComputedStyle(ta); const pc = getComputedStyle(ta, '::placeholder'); const fg = parse(pc.color); out.textarea = { fs: parseFloat(cs.fontSize), h: Math.round(ta.getBoundingClientRect().height), ph: fg ? +ratio(fg, bgOf(ta)).toFixed(2) : null }; }
  const head = root.querySelector('.hero-chat-head, .nexi-panel-head'); const content = [...root.querySelectorAll('.nexi-starters, .nexi-thread')].filter(e => vis(e) && e.getBoundingClientRect().height > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  out.chromeH = head && content ? Math.round(content.getBoundingClientRect().top - head.getBoundingClientRect().top) : null;
  const thread = root.querySelector('.nexi-thread'); const tw = thread ? thread.getBoundingClientRect() : null;
  const cards = [...root.querySelectorAll('.nexi-card')];
  out.cards = { n: cards.length, insideBubble: cards.filter(c => c.closest('.nexi-bubble')).length, narrow: tw ? cards.filter(c => c.getBoundingClientRect().width < (tw.width - 24) * 0.92).length : 0, noFallback: cards.filter(c => { const m = c.querySelector('.nexi-card-media'); if (!m) return true; const img = m.querySelector('img'); if (img && img.complete && img.naturalWidth > 0) return false; return !(m.querySelector('svg') || (m.textContent || '').trim() || /url\(/.test(getComputedStyle(m).backgroundImage) || m.querySelector('.nexi-card-placeholder') && (getComputedStyle(m.querySelector('.nexi-card-placeholder'), '::before').content !== 'none' || getComputedStyle(m.querySelector('.nexi-card-placeholder'), '::after').content !== 'none' || m.querySelector('.nexi-card-placeholder').children.length)); }).length };
  const ho = [...root.querySelectorAll('a.nexi-handoff, .nexi-handoff')].filter(e => e.tagName === 'A' && vis(e)).pop();
  out.handoff = ho ? { hasIcon: !!ho.querySelector('svg, img'), h: Math.round(ho.getBoundingClientRect().height), underline: getComputedStyle(ho).textDecorationLine.includes('underline'), fs: parseFloat(getComputedStyle(ho).fontSize), full: thread ? ho.getBoundingClientRect().width >= (thread.getBoundingClientRect().width - 24) * 0.6 : true } : null;
  out.docOverflow = document.documentElement.scrollWidth - innerWidth;
  return out;
}
// WIP 102: every starter chip, measured whether or not it is scrolled into view. A chip's words are never cut in the middle of a line: either the text fits its box,
// or it is clamped to a whole number of lines (at most 3) so the last visible line ends in an ellipsis and no line is half shown.
function chipsMeasure(rootSel) {
  const root = document.querySelector(rootSel); if (!root) return { missing: true, n: 0, bad: [] };
  const chips = [...root.querySelectorAll('.nexi-starters-row .nexi-chip')]; const bad = []; let clamped = 0, maxLines = 0;
  chips.forEach((c) => {
    const label = c.textContent.trim().slice(0, 28);
    const box = c.querySelector('.nexi-chip-text') || c; const cs = getComputedStyle(box); const lh = parseFloat(cs.lineHeight) || parseFloat(getComputedStyle(c).fontSize) * 1.35;
    const lines = Math.round(box.clientHeight / lh); maxLines = Math.max(maxLines, lines);
    const overflows = box.scrollHeight > box.clientHeight + 1; const wide = c.scrollWidth > c.clientWidth + 1 || box.scrollWidth > box.clientWidth + 1;
    const chipCut = c.scrollHeight > c.clientHeight + 1;
    const wholeLines = Math.abs(box.clientHeight - lines * lh) <= 1.5;
    const clampOn = (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ? parseInt(cs.webkitLineClamp, 10) : 0;
    if (overflows) clamped++;
    if (wide) bad.push(`"${label}" is wider than its chip`);
    else if (chipCut) bad.push(`"${label}" is taller than its chip`);
    else if (overflows && !(clampOn >= 1 && wholeLines && lines <= clampOn)) bad.push(`"${label}" is cut in the middle of a line`);
    else if (lines > 3) bad.push(`"${label}" shows ${lines} lines (3 at most)`);
  });
  return { n: chips.length, bad, clamped, maxLines };
}
const animCheck = () => { const bad = []; document.querySelectorAll('#heroChat *, #nexiPanel *').forEach(el => { const cs = getComputedStyle(el); const names = cs.animationName.split(','); const durs = cs.animationDuration.split(','); names.forEach((n, i) => { if (n.trim() !== 'none' && parseFloat(durs[i] || durs[0]) > 0.011) bad.push(String(el.className).split(' ')[0] + ':' + n.trim()); }); }); return [...new Set(bad)].slice(0, 6); };

(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port; const browser = await chromium.launch();
  try {
    for (const [label, vp, touch] of [['390px phone', { width: 390, height: 844 }, true], ['320px small phone', { width: 320, height: 568 }, true], ['1280px desktop', { width: 1280, height: 900 }, false]]) {
      console.log('\n[' + label + ' - hero chat]');
      const { ctx, page } = await open(browser, vp, touch, { base }); mode = 'plain';
      const idle = await page.evaluate(measure, '#heroChat');
      if (touch) check(label + ' idle chrome (header + toolbar) leaves room: <= 128px (two-row header, nothing hidden)', idle.chromeH !== null && idle.chromeH <= 128, 'chrome is ' + idle.chromeH + 'px tall');
      check(label + ' no horizontal overflow (idle)', idle.docOverflow <= 0, idle.docOverflow + 'px');
      await ask(page, 'How do I start my first store?'); mode = 'products'; await ask(page, 'show me bags'); mode = 'handoff'; await ask(page, 'what is the delivery fee');
      await page.evaluate(() => document.querySelector('#heroChat').scrollIntoView({ block: 'center' })); await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, label.split(' ')[0] + '-hero-after-chat.png') });
      const m = await page.evaluate(measure, '#heroChat');
      check(label + ' no text under 12px', !m.small.length, m.small.slice(0, 5).join(' | '));
      check(label + ' buttons and links are 14px or larger', !m.smallInteractive.length, m.smallInteractive.slice(0, 6).join(' | '));
      check(label + ' every text meets WCAG AA contrast (4.5:1)', !m.lowContrast.length, m.lowContrast.slice(0, 5).join(' | '));
      check(label + ' text box font is 16px or larger (no iOS zoom on focus)', m.textarea && m.textarea.fs >= 16, m.textarea && m.textarea.fs + 'px');
      check(label + ' placeholder meets 4.5:1', m.textarea && m.textarea.ph >= 4.5, m.textarea && 'ratio ' + m.textarea.ph);
      check(label + ' tap targets are 44x44 or larger', !m.tiny.length, m.tiny.slice(0, 6).join(' | '));
      check(label + ' cards sit directly in the thread, not inside a message bubble', m.cards.n >= 3 && m.cards.insideBubble === 0, m.cards.insideBubble + ' of ' + m.cards.n + ' cards are inside a bubble');
      check(label + ' cards use the full thread width (>= 92%)', m.cards.n >= 3 && m.cards.narrow === 0, m.cards.narrow + ' of ' + m.cards.n + ' cards are narrower');
      check(label + ' every card has a visible image fallback (icon or initial, not a blank box)', m.cards.n >= 3 && m.cards.noFallback === 0, m.cards.noFallback + ' of ' + m.cards.n + ' blank');
      check(label + ' handoff button: icon, 48px tall, no underline, 14px+ text', m.handoff && m.handoff.hasIcon && m.handoff.h >= 48 && !m.handoff.underline && m.handoff.fs >= 14, JSON.stringify(m.handoff));
      check(label + ' underlined styling removed from action buttons', !m.underline.length, m.underline.join(', '));
      check(label + ' no horizontal overflow after cards + handoff', m.docOverflow <= 0, m.docOverflow + 'px');
      check(label + ' no page errors', !page._errs.length, page._errs.join(' | '));
      await ctx.close();
    }
    console.log('\n[floating panel @390px]');
    { const { ctx, page } = await open(browser, { width: 390, height: 844 }, true, { base }); mode = 'plain';
      await page.evaluate(() => window.scrollTo(0, 99999)); await page.waitForTimeout(1200); const fab = await page.$('button.nexi-fab'); if (fab) { await fab.click({ force: true }); await page.waitForTimeout(900); }
      const pm = await page.evaluate(measure, '#nexiPanel'); await page.screenshot({ path: path.join(SHOTS, 'panel-390.png') });
      check('panel idle chrome (header + toolbar) <= 140px (two-row header, nothing hidden)', pm.chromeH !== null && pm.chromeH <= 140, 'chrome is ' + pm.chromeH + 'px');
      check('panel: no text under 12px, buttons 14px+', !pm.small.length && !pm.smallInteractive.length, [...pm.small, ...pm.smallInteractive].slice(0, 6).join(' | '));
      check('panel: tap targets 44x44', !pm.tiny.length, pm.tiny.slice(0, 5).join(' | '));
      check('panel: text box 16px+', pm.textarea && pm.textarea.fs >= 16, pm.textarea && pm.textarea.fs + 'px');
      await ctx.close(); }
    console.log('\n[starter chips: no clipped text, English and Luganda, hero and panel]');
    for (const [w, h] of [[320, 640], [360, 740], [390, 844]]) {
      for (const lang of ['en', 'lg']) {
        for (const where of ['hero', 'panel']) {
          const { ctx, page } = await open(browser, { width: w, height: h }, true, { base }); mode = 'plain';
          if (where === 'panel') { await page.evaluate(() => window.scrollTo(0, 99999)); await page.waitForTimeout(1200); const fab = await page.$('button.nexi-fab'); if (fab) { await fab.click({ force: true }); await page.waitForTimeout(900); } }
          const root = where === 'hero' ? '#heroChat' : '#nexiPanel';
          if (lang === 'lg') { await page.locator(root + ' .nexi-lang button[data-lang="lg"]').click(); await page.waitForTimeout(600); }
          const cm = await page.evaluate(chipsMeasure, root);
          check(`${w}px ${lang === 'en' ? 'English' : 'Luganda'} ${where}: no clipped text in any starter chip (${cm.n} chips; at most 3 lines, a longer question ends in a clean ellipsis)`, cm.n >= 6 && !cm.bad.length, cm.n < 6 ? `only ${cm.n} chips found` : cm.bad.slice(0, 4).join(' | '));
          await ctx.close();
        }
      }
    }
    // WIP 104: the language words and the subtitle are spelled out in full on every device, and the starter slider has both buttons.
    console.log('\n[header: full words, full subtitle, nothing clipped; starter slider buttons]');
    const headMeasure = (rootSel) => {
      const root = document.querySelector(rootSel); if (!root) return { missing: true };
      const R = root.getBoundingClientRect(), head = root.querySelector('.hero-chat-head, .nexi-panel-head'), bad = [];
      const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      [...head.children].forEach((c) => { if (!vis(c)) return; const r = c.getBoundingClientRect(); if (r.left < R.left - 0.5 || r.right > R.right + 0.5) bad.push('outside the card: ' + (c.className || c.tagName)); });
      const strong = head.querySelector('strong'); if (vis(strong) && strong.scrollWidth > strong.clientWidth + 1) bad.push('the name is clipped');
      const words = [...head.querySelectorAll('.nexi-lang button')].map((b) => { const f = b.querySelector('.l-full'); return { shown: vis(f) && f.textContent.trim().length > 2, cut: !!f && (f.scrollWidth > f.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1), text: f && f.textContent.trim() }; });
      words.forEach((w) => { if (!w.shown) bad.push('language shows an abbreviation'); if (w.cut) bad.push('language word is clipped'); });
      const sub = [...head.querySelectorAll('span')].find((e) => /guide to buying|Omuyambi mu kugula/i.test(e.textContent) && !e.closest('.nexi-lang'));
      let subState = 'hidden';
      if (sub && vis(sub)) { subState = 'shown'; const cs = getComputedStyle(sub); if (sub.scrollWidth > sub.clientWidth + 1 || (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap')) bad.push('the subtitle is cut off'); const rg = document.createRange(); rg.selectNodeContents(sub); const rr = rg.getBoundingClientRect(); if (rr.right > R.right + 0.5) bad.push('the subtitle runs outside the card'); }
      return { bad, words: words.map((w) => w.text).join(' / '), subState };
    };
    for (const [w, h, touch] of [[320, 640, true], [360, 740, true], [390, 844, true], [768, 1000, true], [1280, 900, false]]) {
      for (const lang of ['en', 'lg']) {
        const { ctx, page } = await open(browser, { width: w, height: h }, touch, { base }); mode = 'plain';
        if (lang === 'lg') { await page.locator('#heroChat .nexi-lang button[data-lang="lg"]').click(); await page.waitForTimeout(500); }
        const hm = await page.evaluate(headMeasure, '#heroChat');
        check(`${w}px ${lang === 'en' ? 'English' : 'Luganda'} hero: full words "${hm.words}", subtitle ${hm.subState} in full, nothing clipped`, !hm.missing && !hm.bad.length && /English/.test(hm.words) && /Luganda/.test(hm.words) && hm.subState === 'shown', hm.bad && hm.bad.join('; '));
        const ar = await page.evaluate(() => { const q = (s) => document.querySelector('#heroChat ' + s); const p = q('.nexi-starters-arrow--prev'), n = q('.nexi-starters-arrow--next'), lab = q('.nexi-starters-label'); if (!p || !n) return { missing: true }; const pr = p.getBoundingClientRect(), nr = n.getBoundingClientRect(), card = document.getElementById('heroChat').getBoundingClientRect(), lr = lab.getBoundingClientRect(); const mid = (r) => (r.top + r.bottom) / 2; return { both: !p.hidden && !n.hidden, w: Math.round(Math.min(pr.width, pr.height, nr.width, nr.height)), inside: pr.left >= card.left && nr.right <= card.right + 0.5, line: Math.abs(mid(pr) - mid(lr)) < 12 && Math.abs(mid(nr) - mid(lr)) < 12, startDim: p.getAttribute('aria-disabled') === 'true' && n.getAttribute('aria-disabled') === 'false' }; });
        check(`${w}px ${lang === 'en' ? 'English' : 'Luganda'} hero: starter slider has a previous AND a next button (44px, inside the card, on the "Try asking" line, previous dimmed at the start)`, !ar.missing && ar.both && ar.w >= 44 && ar.inside && ar.line && ar.startDim, JSON.stringify(ar));
        await ctx.close();
      }
    }
    // WIP 105: NOTHING in the header is ever hidden or cut, idle or chatting, hero or panel, English or Luganda, at every width.
    console.log('\n[header: avatar, name, subtitle, both language words and every button always visible; no overlaps]');
    const headEverything = (args) => {
      const rootSel = args[0], chatting = args[1];
      const root = document.querySelector(rootSel); if (!root) return { missing: true };
      const R = root.getBoundingClientRect(), head = root.querySelector('.hero-chat-head, .nexi-panel-head'), bad = [];
      const vis = (e) => { if (!e || !e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inside = (r, what) => { if (r.left < R.left - 0.5 || r.right > R.right + 0.5) bad.push(what + ' runs outside the card'); };
      const boxes = [];
      const av = head.querySelector('.nexi-avatar');
      if (!vis(av)) bad.push('the avatar (assistant logo) is hidden'); else { const r = av.getBoundingClientRect(); if (r.width < 28) bad.push('the avatar is only ' + Math.round(r.width) + 'px'); inside(r, 'the avatar'); boxes.push(['avatar', r]); }
      const strong = head.querySelector('strong');
      if (!vis(strong)) bad.push('the name is hidden'); else { if (strong.scrollWidth > strong.clientWidth + 1) bad.push('the name is clipped'); const rg = document.createRange(); rg.selectNodeContents(strong); const rr = rg.getBoundingClientRect(); inside(rr, 'the name'); boxes.push(['name', rr]); }
      const sub = [...head.querySelectorAll('span')].find((e) => /guide to buying|Omuyambi mu kugula/i.test(e.textContent) && !e.closest('.nexi-lang'));
      if (!vis(sub)) bad.push('the subtitle is hidden'); else { const cs = getComputedStyle(sub); if (sub.scrollWidth > sub.clientWidth + 1 || (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap')) bad.push('the subtitle is cut off'); const rg = document.createRange(); rg.selectNodeContents(sub); const rr = rg.getBoundingClientRect(); inside(rr, 'the subtitle'); boxes.push(['subtitle', rr]); }
      const btns = [...head.querySelectorAll('.nexi-lang button')];
      if (btns.length !== 2) bad.push('language switch has ' + btns.length + ' buttons');
      btns.forEach((b) => { const f = b.querySelector('.l-full'); if (!vis(b) || !vis(f)) { bad.push('a language button is hidden'); return; } if (f.scrollWidth > f.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1) bad.push('language word "' + f.textContent.trim() + '" is clipped'); const r = b.getBoundingClientRect(); if (r.width < 44 - 0.5 || r.height < 44 - 0.5) bad.push('language button is ' + Math.round(r.width) + 'x' + Math.round(r.height)); inside(r, 'language button'); boxes.push(['lang-' + f.textContent.trim(), r]); });
      const icons = [...head.querySelectorAll('.nexi-iconbtn')].filter((b) => !b.hidden);
      const want = rootSel === '#heroChat' ? (chatting ? 1 : 0) : (chatting ? 2 : 1);
      if (icons.length !== want) bad.push('expected ' + want + ' header button(s), found ' + icons.length);
      icons.forEach((b) => { if (!vis(b)) { bad.push('a header button is hidden'); return; } const r = b.getBoundingClientRect(); if (r.width < 44 - 0.5 || r.height < 44 - 0.5) bad.push('header button is ' + Math.round(r.width) + 'x' + Math.round(r.height)); inside(r, 'a header button'); boxes.push(['button-' + (b.getAttribute('aria-label') || icons.indexOf(b)), r]); });
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i][1], b = boxes[j][1]; const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) bad.push(boxes[i][0] + ' overlaps ' + boxes[j][0]);
      }
      if (head.scrollWidth > head.clientWidth + 1) bad.push('the header scrolls sideways');
      if (document.documentElement.scrollWidth > innerWidth) bad.push('the page scrolls sideways');
      return { bad, h: Math.round(head.getBoundingClientRect().height) };
    };
    const SWEEP_HERO = [320, 340, 360, 375, 390, 430, 520, 639, 640, 700, 768, 900, 1024, 1280];
    const SWEEP_PANEL = [320, 360, 390, 430, 600, 601, 768, 1280];
    for (const lang of ['en', 'lg']) {
      for (const chatting of [false, true]) {
        const { ctx, page } = await open(browser, { width: 1280, height: 900 }, false, { base }); mode = 'plain';
        if (lang === 'lg') { await page.locator('#heroChat .nexi-lang button[data-lang="lg"]').click(); await page.waitForTimeout(400); }
        if (chatting) await ask(page, lang === 'lg' ? 'Nsobola ntya okutandika edduuka?' : 'hello there');
        const bad = []; let tallest = 0;
        for (const w of SWEEP_HERO) {
          await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(250);
          const m = await page.evaluate(headEverything, ['#heroChat', chatting]);
          if (m.missing) { bad.push(w + 'px: hero missing'); continue; }
          tallest = Math.max(tallest, m.h); m.bad.forEach((x) => bad.push(w + 'px: ' + x));
        }
        check(`hero ${lang === 'en' ? 'English' : 'Luganda'}, ${chatting ? 'chatting' : 'idle'}: avatar + name + subtitle + both language words + buttons all visible, uncut, no overlap, at ${SWEEP_HERO.length} widths 320-1280 (tallest header ${tallest}px)`, !bad.length, bad.slice(0, 5).join(' | '));
        await ctx.close();
      }
    }
    for (const lang of ['en', 'lg']) {
      for (const chatting of [false, true]) {
        const { ctx, page } = await open(browser, { width: 1280, height: 900 }, false, { base }); mode = 'plain';
        if (lang === 'lg') { await page.locator('#heroChat .nexi-lang button[data-lang="lg"]').click(); await page.waitForTimeout(400); }
        if (chatting) await ask(page, lang === 'lg' ? 'Nsobola ntya okutandika edduuka?' : 'hello there');
        await page.evaluate(() => window.scrollTo(0, 99999)); await page.waitForTimeout(1200);
        const fab = await page.$('button.nexi-fab'); if (fab) { await fab.click({ force: true }); await page.waitForTimeout(900); }
        const bad = []; let tallest = 0;
        for (const w of SWEEP_PANEL) {
          await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(300);
          const m = await page.evaluate(headEverything, ['#nexiPanel', chatting]);
          if (m.missing) { bad.push(w + 'px: panel missing'); continue; }
          tallest = Math.max(tallest, m.h); m.bad.forEach((x) => bad.push(w + 'px: ' + x));
        }
        await page.setViewportSize({ width: 667, height: 375 }); await page.waitForTimeout(300);
        { const m = await page.evaluate(headEverything, ['#nexiPanel', chatting]); if (m.missing) bad.push('667x375 landscape: panel missing'); else { tallest = Math.max(tallest, m.h); m.bad.forEach((x) => bad.push('667x375 landscape: ' + x)); } }
        check(`panel ${lang === 'en' ? 'English' : 'Luganda'}, ${chatting ? 'chatting' : 'idle'}: avatar + name + subtitle + both language words + buttons all visible, uncut, no overlap, at ${SWEEP_PANEL.length} widths plus a phone on its side (tallest header ${tallest}px)`, !bad.length, bad.slice(0, 5).join(' | '));
        if (!chatting && lang === 'en') await page.screenshot({ path: path.join(SHOTS, 'panel-landscape-header.png') });
        await ctx.close();
      }
    }
    console.log('\n[reduced motion]');
    { const { ctx, page } = await open(browser, { width: 390, height: 844 }, true, { base, reduced: true }); mode = 'plain'; await ask(page, 'hello there');
      const bad = await page.evaluate(animCheck); check('prefers-reduced-motion: no running animations in the widget', !bad.length, bad.join(', ')); await ctx.close(); }
  } finally { await browser.close(); srv.close(); }
  const failed = results.filter(r => !r.ok);
  console.log('\ndesign-audit: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  console.log('Screenshots to review (outside the project): ' + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
