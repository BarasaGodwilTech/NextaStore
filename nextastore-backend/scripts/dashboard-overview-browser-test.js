#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the dashboard Overview store-info header (logo, name,
 * description, location, contact, payment methods, badges, followers, mini
 * stats) with the WORST realistic data and with almost no data, at phone,
 * tablet and desktop widths.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:dashboard-overview-browser
 *   OVERVIEW_SHOTS=/some/dir npm run test:dashboard-overview-browser   (also saves screenshots)
 *
 * Opens the REAL dashboard.html signed in as a seller, against a tiny fake API
 * on localhost:4000. No database. Cannot cover: real product photos / logo
 * images, Font Awesome icons (a CDN the sandbox cannot reach, so icons render
 * as empty boxes here), Safari/iOS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PRESENCE_TEST_PORT || 4000);
const SHOTS = process.env.OVERVIEW_SHOTS || '';

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u_s', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const USER = { id: 'u_s', name: 'Sam Seller', email: 's@example.com', role: 'seller' };

const METHODS = [
  ['mtn_momo', 'MTN Mobile Money', 'fa-mobile-screen'], ['airtel_money', 'Airtel Money', 'fa-mobile-screen'],
  ['cash_on_delivery', 'Cash on delivery', 'fa-money-bill'], ['bank_transfer', 'Bank transfer', 'fa-building-columns'],
  ['visa', 'Visa / Mastercard', 'fa-credit-card'], ['paypal', 'PayPal', 'fa-wallet'],
  ['pay_on_pickup', 'Pay on pickup', 'fa-hand-holding-dollar'], ['crypto', 'Cryptocurrency', 'fa-coins'],
  ['installments', 'Pay in installments', 'fa-calendar-days']
].map(([code, label, icon]) => ({ code, label, icon }));

const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(2);
const BADGE = (tone, label, icon) => ({ tone, label, shortLabel: label.split(' ')[0], icon, reason: label });

const STORES = {
  worst: {
    id: 's1', slug: 'acme', name: `The Very Long Named Kampala Artisans and Fine Crafts Collective ${LONG_WORD}`,
    description: 'We make and sell handmade goods from across Uganda. '.repeat(30).trim(),
    district: 'kampala', address: 'Plot 12, Some Extremely Long Street Name Close To The Old Taxi Park Behind The Big Yellow Building, Nakasero Hill Road, Opposite The Blue Gate',
    contactEmail: `customer.support.and.orders.${LONG_WORD}@a-really-long-company-domain-name-example.co.ug`, phoneNumber: '+256 700 000 000',
    payments: Object.fromEntries(METHODS.map((m) => [m.code, true])), followers: 1234567, status: 'active', isPublished: true,
    badges: [BADGE('verified', 'Verified seller', 'fa-circle-check'), BADGE('gold', 'Gold seller', 'fa-medal'), BADGE('platinum', 'Platinum seller', 'fa-gem'),
      BADGE('verified', 'Fast responder', 'fa-bolt'), BADGE('verified', 'Top rated this year', 'fa-star')],
    stats: { totalProducts: 12345, totalOrders: 98765, totalRevenue: 1234567890123 }
  },
  sparse: {
    id: 's1', slug: 'acme', name: 'Acme', description: '', district: '', address: '', contactEmail: '', phoneNumber: '',
    payments: {}, followers: 0, status: 'active', isPublished: true, badges: [], stats: { totalProducts: 0, totalOrders: 0, totalRevenue: 0 }
  },
  // The store from the seller's screenshot: a long but ordinary address next to the stats.
  amina: {
    id: 's1', slug: 'acme', name: "Amina's Crafts & Coffee", description: 'Handmade fashion, beadwork and single-origin coffee from Kampala, made by local artisans.',
    district: 'mbale', address: 'oxford class room block, A7, Mbale City, Bugisa sub-region, Mbale, Eastern Region, Uganda', contactEmail: 'amina@example.com', phoneNumber: '',
    payments: { mtn_momo: true, airtel_money: true, visa: true }, followers: 1242, status: 'active', isPublished: true, badges: [],
    stats: { totalProducts: 4, totalOrders: 4, totalRevenue: 175000 }
  },
  normal: {
    id: 's1', slug: 'acme', name: 'Amina Crafts', description: 'Handwoven baskets and jewelry from Jinja.',
    district: 'jinja', address: 'Main Street', contactEmail: 'amina@example.com', phoneNumber: '+256 700 111 222',
    payments: { mtn_momo: true, airtel_money: true }, followers: 42, status: 'active', isPublished: true,
    badges: [BADGE('verified', 'Verified seller', 'fa-circle-check')], stats: { totalProducts: 8, totalOrders: 21, totalRevenue: 640000 }
  }
};
let scenario = 'worst';

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://l').pathname;
  if (p.startsWith('/api/')) {
    req.resume();
    req.on('end', () => {
      const s = STORES[scenario];
      let data = [];
      if (p === '/api/user/me') data = USER;
      else if (p === '/api/store') data = s;
      else if (p === '/api/payments/methods') data = METHODS;
      else if (p.startsWith('/api/store/stats') || p.includes('/stats')) data = s.stats;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data, pagination: { page: 1, limit: 20, total: 0, pages: 1 } }));
    });
    return;
  }
  const f = path.join(ROOT, (rel => rel === '/' ? 'index.html' : (fs.existsSync(path.join(ROOT, rel)) || path.extname(rel) ? rel : rel + '.html'))(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let passed = 0; let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WIDTHS = [
  { name: '320', w: 320, h: 640 }, { name: '360', w: 360, h: 740 }, { name: '390', w: 390, h: 844 },
  { name: '768', w: 768, h: 900 }, { name: '1280', w: 1280, h: 900 }
];

/* Measured inside the page: everything the seller sees in the store header. */
const measure = () => {
  const $ = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.x + b.width, b: b.y + b.height }; };
  const sec = $('.store-branding-section');
  const secBox = box(sec);
  const header = $('.store-header');
  // Anything inside the header that pokes out past the card's right edge.
  const outside = [...header.querySelectorAll('*')].filter((el) => {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && (b.x + b.width > secBox.r + 1 || b.x < secBox.x - 1);
  }).map((el) => el.id || el.className).slice(0, 5);
  const lh = (el) => { const cs = getComputedStyle(el); const v = parseFloat(cs.lineHeight); return Number.isNaN(v) ? parseFloat(cs.fontSize) * 1.3 : v; };
  const desc = $('#storeDescriptionDisplay');
  const name = $('#storeDisplayName');
  const loc = $('#locationText');
  const email = $('#storeContactEmailDisplay');
  const pay = $('#storePaymentsDisplay');
  const chips = [...pay.querySelectorAll('.payment-badge')].filter((c) => c.offsetParent !== null);
  const badgeRoot = $('#storeBadges');
  const stat = (id) => { const e = document.getElementById(id); return { el: box(e), cell: box(e.closest('.mini-stat')), over: e.scrollWidth > e.clientWidth + 1 }; };
  const descToggle = $('#storeDescToggle');
  return {
    vw: innerWidth, docScroll: document.documentElement.scrollWidth, secBox, outside,
    nameOver: name.scrollWidth > name.clientWidth + 1, nameLines: Math.round(name.getBoundingClientRect().height / lh(name)),
    descLines: Math.round(desc.getBoundingClientRect().height / lh(desc)),
    descClamped: desc.scrollHeight > desc.clientHeight + 1,
    descToggle: descToggle ? { visible: descToggle.offsetParent !== null, expanded: descToggle.getAttribute('aria-expanded'), text: descToggle.textContent.trim(), h: box(descToggle).h, w: box(descToggle).w } : null,
    locLines: Math.round(box(loc).h / lh(loc)), locOver: loc.scrollWidth > loc.clientWidth + 1,
    emailOver: email.scrollWidth > email.clientWidth + 1 && getComputedStyle(email).overflow === 'visible',
    emailBox: box(email),
    chipCount: chips.length, chipTexts: chips.map((c) => c.textContent.trim()),
    payToggle: (() => { const t = $('#storePaymentsToggle'); return t ? { visible: t.offsetParent !== null, expanded: t.getAttribute('aria-expanded'), text: t.textContent.trim(), h: box(t).h } : null; })(),
    payBox: box(pay),
    badgeCount: badgeRoot.querySelectorAll('.seller-badge').length, badgeMore: (badgeRoot.querySelector('.seller-badge--more') || {}).textContent || '',
    badgeBox: box(badgeRoot),
    products: stat('miniProducts'), orders: stat('miniOrders'), revenue: stat('miniRevenue'),
    headerBox: box(header), logoBox: box($('#storeLogoPreview')),
    nameEdit: box($('.store-name-row .btn')), locEdit: box($('#storeLocationDisplay .btn-link')),
    followers: $('#storeFollowers').textContent,
    locToggle: (() => { const t = $('#storeLocToggle'); return t ? { visible: t.offsetParent !== null, expanded: t.getAttribute('aria-expanded'), text: t.textContent.trim(), h: box(t).h } : null; })(),
    locClamped: loc.scrollHeight > loc.clientHeight + 1,
    statsBox: box($('.store-stats-mini')), infoBox: box($('.store-info'))
  };
};

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, 'localhost', r); }).catch((e) => {
    console.error(`Could not listen on localhost:${PORT} (${e.code}). Stop whatever is using it or set PRESENCE_TEST_PORT.`);
    process.exit(2);
  });
  const browser = await chromium.launch({ channel: 'chromium' });
  const errors = [];
  const open = async (w, h, which) => {
    scenario = which;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', JSON.stringify(u)); } catch (e) { /* ignore */ } }, [TOKEN, USER]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${which} ${w}] ` + String(e.message || e)));
    await page.goto(`http://localhost:${PORT}/dashboard`);
    await page.waitForFunction(() => document.querySelectorAll('#storePaymentsDisplay .payment-badge').length > 0 || document.getElementById('storeDisplayName').textContent.trim() !== 'My Store', null, { timeout: 8000 }).catch(() => {});
    // The app's full-screen loader fades out on its own; screenshots (and
    // sticky-header overlap) look wrong until it is gone.
    await page.waitForFunction(() => !document.getElementById('nxLoader'), null, { timeout: 8000 }).catch(() => {});
    await sleep(400);
    return { ctx, page };
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.addStyleTag({ content: '.top-bar{position:static !important}' });
    await page.locator('.store-branding-section').screenshot({ path: path.join(SHOTS, name + '.png') });
  };

  try {
    for (const vp of WIDTHS) {
      const tag = `[worst ${vp.name}px] `;
      const { ctx, page } = await open(vp.w, vp.h, 'worst');
      let m = await page.evaluate(measure);
      await shot(page, `worst-${vp.name}`);
      const phone = vp.w <= 480;

      check(tag + 'page does not scroll sideways', m.docScroll <= m.vw + 1, `${m.docScroll} > ${m.vw}`);
      check(tag + 'nothing in the header sticks out past the card', m.outside.length === 0, m.outside.join(', '));
      check(tag + 'a very long unbroken store name wraps inside the card', !m.nameOver, `nameLines=${m.nameLines}`);
      check(tag + 'store name takes at most 3 lines', m.nameLines <= 3, String(m.nameLines));
      check(tag + 'a 1,500-character description is held to 3 lines', m.descLines <= 3, `lines=${m.descLines}`);
      check(tag + 'a clamped description offers "Read more"', !!m.descToggle && m.descToggle.visible && m.descToggle.expanded === 'false' && /more/i.test(m.descToggle.text), JSON.stringify(m.descToggle));
      check(tag + 'a very long address stays within 2 lines', m.locLines <= 2 && !m.locOver, `lines=${m.locLines} over=${m.locOver}`);
      check(tag + 'a very long email address does not overflow', !m.emailOver && m.emailBox.r <= m.secBox.r + 1, JSON.stringify(m.emailBox));
      check(tag + '9 payment methods collapse to 4 plus a "+5 more" control', m.chipCount === 4 && !!m.payToggle && m.payToggle.visible && /5/.test(m.payToggle.text) && m.payToggle.expanded === 'false', JSON.stringify([m.chipCount, m.payToggle]));
      check(tag + '5 badges show 3 plus "+2"', m.badgeCount === 4 && m.badgeMore.trim() === '+2', `${m.badgeCount} / "${m.badgeMore}"`);
      check(tag + 'badge row is inside the card', m.badgeBox.r <= m.secBox.r + 1);
      check(tag + 'all three mini stats are inside the card and their numbers do not overflow',
        [m.products, m.orders, m.revenue].every((s) => s.cell.r <= m.secBox.r + 1 && s.cell.x >= m.secBox.x - 1 && !s.over), JSON.stringify([m.products, m.orders, m.revenue].map((s) => [Math.round(s.cell.x), Math.round(s.cell.r), s.over])));
      check(tag + 'mini stat cells do not overlap each other', m.products.cell.r <= m.orders.cell.x + 1 && m.orders.cell.r <= m.revenue.cell.x + 1);
      if (phone) {
        check(tag + 'whole header stays under 1.6 screens tall (long content does not push products off)', m.headerBox.h <= vp.h * 1.6, `${Math.round(m.headerBox.h)} vs ${vp.h}`);
        check(tag + 'name Edit and location Edit are at least 44px to tap', m.nameEdit.h >= 44 && m.nameEdit.w >= 44 && m.locEdit.h >= 44, JSON.stringify([m.nameEdit, m.locEdit]));
        check(tag + 'Read more toggle is at least 44px tall', m.descToggle.h >= 44, String(m.descToggle.h));
        check(tag + 'payment "more" control is at least 44px tall', m.payToggle.h >= 44, String(m.payToggle.h));
      }

      // Expand description
      await page.click('#storeDescToggle');
      await sleep(100);
      let m2 = await page.evaluate(measure);
      check(tag + 'Read more shows the whole description and flips to "Show less"', m2.descLines > 3 && !m2.descClamped && m2.descToggle.expanded === 'true' && /less/i.test(m2.descToggle.text), JSON.stringify([m2.descLines, m2.descToggle]));
      check(tag + 'expanded description still does not overflow sideways', m2.docScroll <= m2.vw + 1);
      await page.click('#storeDescToggle');
      await sleep(100);
      m2 = await page.evaluate(measure);
      check(tag + 'Show less puts it back to 3 lines', m2.descLines <= 3 && m2.descToggle.expanded === 'false');

      // The control must appear exactly when the address is cut off: always on phones for this
      // worst case, and only if it still overflows 2 lines on wider screens.
      check(tag + 'address \"Show full address\" appears exactly when the address is cut off', !!m.locToggle && m.locToggle.visible === m.locClamped && (!phone || m.locClamped), JSON.stringify([m.locClamped, m.locToggle]));
      if (m.locClamped) {
        if (phone) check(tag + 'address toggle is at least 44px tall', m.locToggle.h >= 44, String(m.locToggle.h));
        await page.click('#storeLocToggle');
        await sleep(100);
        m2 = await page.evaluate(measure);
        check(tag + 'Show full address reveals the whole address and flips to \"Show less\"', m2.locLines > 2 && !m2.locClamped && m2.locToggle.expanded === 'true' && /less/i.test(m2.locToggle.text), JSON.stringify([m2.locLines, m2.locToggle]));
        check(tag + 'expanded address stays inside the card', m2.docScroll <= m2.vw + 1 && m2.outside.length === 0, m2.outside.join(', '));
        await page.click('#storeLocToggle');
        await sleep(100);
        m2 = await page.evaluate(measure);
        check(tag + 'Show less puts the address back to 2 lines', m2.locLines <= 2 && m2.locToggle.expanded === 'false');
      }

      // Expand payments
      await page.click('#storePaymentsToggle');
      await sleep(100);
      m2 = await page.evaluate(measure);
      check(tag + 'payment control shows all 9 methods and offers "Show fewer"', m2.chipCount === 9 && m2.payToggle.expanded === 'true' && /fewer|less/i.test(m2.payToggle.text), JSON.stringify([m2.chipCount, m2.payToggle]));
      check(tag + 'all 9 payment methods stay inside the card', m2.payBox.r <= m2.secBox.r + 1 && m2.docScroll <= m2.vw + 1);
      await page.click('#storePaymentsToggle');
      await sleep(100);
      m2 = await page.evaluate(measure);
      check(tag + 'Show fewer collapses back to 4', m2.chipCount === 4 && m2.payToggle.expanded === 'false');
      await ctx.close();
    }

    // Sparse store: nothing set yet
    for (const vp of [WIDTHS[0], WIDTHS[2], WIDTHS[4]]) {
      const tag = `[sparse ${vp.name}px] `;
      const { ctx, page } = await open(vp.w, vp.h, 'sparse');
      const m = await page.evaluate(measure);
      await shot(page, `sparse-${vp.name}`);
      check(tag + 'no sideways scroll and nothing sticks out', m.docScroll <= m.vw + 1 && m.outside.length === 0, m.outside.join(', '));
      check(tag + 'no "Read more" / "more" controls when there is nothing to hide', (!m.descToggle || !m.descToggle.visible) && (!m.payToggle || !m.payToggle.visible), JSON.stringify([m.descToggle, m.payToggle]));
      check(tag + 'unset contact shows "Not set" instead of blank', /Not set/i.test(await page.textContent('#contactPhone')) && /Not set|@/i.test(await page.textContent('#storeContactEmailDisplay')));
      check(tag + 'empty payment list says so', m.chipCount === 1 && /No payment/i.test(m.chipTexts[0]), JSON.stringify(m.chipTexts));
      check(tag + 'stats show zeros in three cells', m.products.cell.r <= m.orders.cell.x + 1 && m.orders.cell.r <= m.revenue.cell.x + 1);
      await ctx.close();
    }

    // The seller's own store: the address "Edit" must not crowd the stats beside it
    for (const vp of [WIDTHS[2], WIDTHS[3], WIDTHS[4]]) {
      const tag = `[amina ${vp.name}px] `;
      const { ctx, page } = await open(vp.w, vp.h, 'amina');
      const m = await page.evaluate(measure);
      await shot(page, `amina-${vp.name}`);
      check(tag + 'no sideways scroll and nothing sticks out', m.docScroll <= m.vw + 1 && m.outside.length === 0, m.outside.join(', '));
      check(tag + 'address never exceeds 2 lines, and \"Show full address\" appears exactly when it is cut off', m.locLines <= 2 && !!m.locToggle && m.locToggle.visible === m.locClamped, JSON.stringify([m.locLines, m.locClamped, m.locToggle]));
      if (vp.w >= 1025) {
        const gap = m.statsBox.x - m.locEdit.r;
        check(tag + 'address Edit is at least 24px clear of the stats column', gap >= 24, `gap=${Math.round(gap)}`);
        check(tag + 'a divider line separates the identity block from the stats', await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.store-stats-mini')).borderLeftWidth) >= 1));
        check(tag + 'the address is not cut off on desktop, so no toggle is shown', !m.locClamped && !m.locToggle.visible);
        check(tag + 'stats column stays on the right edge of the card', m.secBox.r - m.statsBox.r <= 40, `${Math.round(m.secBox.r - m.statsBox.r)}`);
      }
      await ctx.close();
    }

    // Normal store: short content must not show any controls
    for (const vp of [WIDTHS[2], WIDTHS[4]]) {
      const tag = `[normal ${vp.name}px] `;
      const { ctx, page } = await open(vp.w, vp.h, 'normal');
      const m = await page.evaluate(measure);
      await shot(page, `normal-${vp.name}`);
      check(tag + 'short description is not clamped and has no toggle', !m.descClamped && (!m.descToggle || !m.descToggle.visible), JSON.stringify(m.descToggle));
      check(tag + '2 payment methods all show, no "more" control', m.chipCount === 2 && (!m.payToggle || !m.payToggle.visible), JSON.stringify([m.chipCount, m.payToggle]));
      check(tag + 'one badge shows, no "+N"', m.badgeCount === 1 && m.badgeMore.trim() === '');
      check(tag + 'no sideways scroll', m.docScroll <= m.vw + 1 && m.outside.length === 0);
      await ctx.close();
    }
    check('no uncaught page errors in any scenario', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (x) { /* ignore */ } process.exit(1); });
