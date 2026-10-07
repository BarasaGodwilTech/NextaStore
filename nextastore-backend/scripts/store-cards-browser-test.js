#!/usr/bin/env node
'use strict';
/*
 * Real-browser check that store cards survive hostile data on every surface
 * that shows seller badges (marketplace, directory/stores.html, product-page
 * mini card, home featured stores): a 100-character name, a 70-character
 * unbroken name, 5 badges (one with a very long label) and an 800-character
 * description, at 320 / 375 / 768 / 1440 px.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:store-cards-browser        (CHROMIUM_PATH=... to pick a binary)
 *
 * Uses the REAL css/*.css and the REAL app.renderSellerBadges (extracted from
 * js/main.js), but the card markup below is a COPY of each page's template
 * string - if you change a template in marketplace.js / stores.js / following.js /
 * product-detail.js / index.html, change it here too. Fails on: anything
 * spilling past its card edge, page-level sideways scroll, a header taller
 * than 200px, or a card taller than 650px. Does not load Font Awesome
 * (icon widths are approximate). Pass "shots" as 2nd arg to keep 375px
 * screenshots in the temp folder it prints.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cards-'));
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const CSS = f => 'file://' + encodeURI(path.join(ROOT, 'css', f));

// Pull the REAL renderSellerBadges out of js/main.js so this tests shipped code.
const src = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
const start = src.indexOf('renderSellerBadges(store');
let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = i;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
const fnSrc = src.slice(start, end + 1);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = { escapeHtml: esc };
app.renderSellerBadges = new Function('return function ' + fnSrc.replace(/^renderSellerBadges/, 'renderSellerBadges'))().bind(app);

const store = {
  id: 's1', slug: 'x', followers: 1250000, productCount: 60,
  name: 'The Very Long Named Handmade Kampala Craft and Leather Goods Collective of Central Uganda Limited',
  description: 'We make and sell things. '.repeat(30), district: 'Kampala Central Division, Nakasero, Plot 14 Kyagwe Road',
  badges: [
    { label: 'Verified seller', tone: 'verified', icon: 'fa-check', shortLabel: 'Verified' },
    { label: 'Gold commitment 12 months', tone: 'gold', icon: 'fa-award', shortLabel: 'Gold' },
    { label: 'Platinum commitment 24 months verified by NextaStore', tone: 'platinum', icon: 'fa-gem', shortLabel: 'Platinum' },
    { label: 'Fast responder', tone: 'ready', icon: 'fa-bolt', shortLabel: 'Fast' },
    { label: 'Top rated seller in Uganda, Kampala Region', tone: 'gold', icon: 'fa-star', shortLabel: 'Top' },
  ],
};
const unbroken = { ...store, name: 'A'.repeat(70) };

const INDEX_STYLE = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const surfaces = {
  marketplace: { css: ['main.css', 'marketplace.css', 'mobile.css'], cardSel: '.store-card', head: '.store-name',
    wrap: h => `<div class="stores-grid">${h}</div>`,
    card: s => `<div class="store-card"><div class="store-banner" style="background:#00B074;height:80px"></div><div class="store-info"><div class="store-logo">A</div>
      <h3 class="store-name" title="${esc(s.name)}"><span class="store-name-text">${esc(s.name)}</span> <span class="store-badge-row">${app.renderSellerBadges(s, { limit: 2, more: true })}</span></h3>
      <p class="store-description">${esc(s.description)}</p><div class="store-meta">${s.badges?.length ? `<span class="store-meta-item"><i class="fas fa-award"></i> <span class="store-meta-text">${esc(s.badges[0].label)}</span></span>` : ''}<span class="store-meta-item">${s.followers.toLocaleString()}</span><span class="store-meta-item">${s.productCount} products</span></div>
      <div class="store-actions"><button class="btn btn-primary">Visit Store</button></div></div></div>` },
  directory: { css: ['main.css', 'stores.css', 'mobile.css'], cardSel: '.directory-store-card', head: '.directory-title',
    wrap: h => `<main class="stores-page"><div class="stores-directory-grid">${h}</div></main>`,
    card: s => `<a class="directory-store-card" href="#"><div class="directory-banner"><div class="directory-logo">A</div></div><div class="directory-info">
      <div class="directory-title"><h2>${esc(s.name)}</h2><span class="directory-badges">${app.renderSellerBadges(s, { more: true })}</span></div>
      <p>${esc(s.description)}</p><div class="directory-meta"><span>${s.productCount} products</span><span>${esc(s.district)}</span></div></div></a>` },
  productMini: { css: ['main.css', 'product-detail.css', 'mobile.css'], cardSel: '.store-info-card', head: '.store-mini-info',
    wrap: h => `<div style="max-width:420px;margin:0;padding:0" id="mini">${h}</div>`,
    card: s => `<div class="store-info-card"><div class="store-info-header"><div class="store-mini-logo">S</div><div class="store-mini-info"><h4>${esc(s.name)}</h4>
      <div class="store-mini-rating">${app.renderSellerBadges(s, { limit: 2, more: true })}</div></div><a href="#" class="btn btn-sm btn-outline">Visit Store</a></div></div>` },
home: { css: ['main.css', 'mobile.css'], inlineStyle: true, cardSel: '.store-card', head: '.store-details h3',
    wrap: h => `<div class="stores-grid">${h}</div>`,
    card: s => `<div class="store-card"><div class="store-banner"></div><div class="store-details"><div class="store-logo"><span class="store-logo-initial">A</span></div>
      <h3 title="${esc(s.name)}"><span class="store-name-text">${esc(s.name)}</span> <span class="store-badge-row">${app.renderSellerBadges(s, { limit: 2, more: true })}</span></h3>
      <p>${esc(s.description)}</p><div class="store-meta"><span>${s.badges?.length || 0} badges</span><span>${s.productCount} products</span></div><button class="btn btn-primary btn-sm">Visit Store</button></div></div>` }

};

(async () => {
  const label = process.argv[2] || 'run';
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  let bad = 0;
  for (const [name, sf] of Object.entries(surfaces)) {
    for (const [dataName, data] of [['long', store], ['unbroken', unbroken], ['none', { ...store, badges: [] }]]) {
      for (const w of [320, 375, 768, 1440]) {
        const page = await browser.newPage({ viewport: { width: w, height: 900 } });
        const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${sf.css.map(f => `<link rel="stylesheet" href="${CSS(f)}">`).join('')}${sf.inlineStyle ? INDEX_STYLE : ''}</head><body>${sf.wrap(sf.card(data) + sf.card(data))}</body></html>`;
        fs.writeFileSync(path.join(OUT, 'page.html'), html);
        await page.goto('file://' + path.join(OUT, 'page.html')); await page.waitForTimeout(150);
        const r = await page.evaluate(({ cardSel, head }) => {
          const c = document.querySelector(cardSel), cr = c.getBoundingClientRect(), out = [];
          c.querySelectorAll('*').forEach(el => { const b = el.getBoundingClientRect(); if (b.width && (b.right > cr.right + 0.5 || b.left < cr.left - 0.5)) out.push((el.className || el.tagName).toString().slice(0, 40)); });
          return { clipped: [...new Set(out)], headH: Math.round(c.querySelector(head).getBoundingClientRect().height), cardH: Math.round(cr.height), pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
        }, { cardSel: sf.cardSel, head: sf.head });
        const flag = r.clipped.length || r.pageScroll || r.headH > 200 || r.cardH > 650;
        if (flag) bad++;
        console.log(`${flag ? 'BAD ' : 'ok  '} ${name.padEnd(12)} ${dataName.padEnd(8)} ${String(w).padStart(4)}px  header ${String(r.headH).padStart(3)}px  card ${String(r.cardH).padStart(3)}px${r.pageScroll ? '  PAGE-SCROLL' : ''}${r.clipped.length ? '  spills: ' + r.clipped.join(', ') : ''}`);
        if (process.argv[3]==='shots' && dataName==='long' && w===375) await page.locator(sf.cardSel).first().screenshot({ path: path.join(OUT, `shot_${name}.png`) });
        await page.close();
      }
    }
  }
  await browser.close();
  console.log(`\n[${label}] ${bad} problem case(s)`);
  process.exitCode = bad ? 1 : 0;
})();
