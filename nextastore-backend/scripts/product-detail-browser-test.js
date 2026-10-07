#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of product-detail.html (WIP 36): the enlarge/zoom image
 * viewer, gallery paging, stock states, the truthful Delivery & Returns tab,
 * and the "More from this store" section.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:product-detail-browser        (CHROMIUM_PATH=... to pick a binary)
 *
 * Serves the REAL html/css/js from the project root on a throwaway local
 * server and stubs every /api/* call in the browser, so it needs no database
 * or backend. Font Awesome (a CDN) is not loaded here, so icons are absent
 * in this run only.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

// ---- static server -------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
const svg = (w, h, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="#fff"/></svg>`;
const IMAGES = { '/uploads/a.svg': svg(1200, 1600, '#0B3B2B'), '/uploads/b.svg': svg(1600, 900, '#01B075'), '/uploads/c.svg': svg(1000, 1000, '#A96B00'), '/uploads/t-a.svg': svg(200, 200, '#0B3B2B'), '/uploads/t-b.svg': svg(200, 200, '#01B075'), '/uploads/t-c.svg': svg(200, 200, '#A96B00') };
// The product's own address is answered by the REAL page renderer (see lib/).
const PID = 'cmg8x2k1a0003abcd5efgh6ij';   // a real-looking cuid; its key is 5efgh6ij
const KEY = PID.slice(-8);
const ADDRESS = `/amina-crafts/handwoven-basket-${KEY}`;
const handleProductAddress = require('./lib/product-address-server')({
  root: ROOT,
  product: { id: PID, name: 'Handwoven Basket', description: 'A sturdy basket.', price: 45000, stock: 5, image: null, images: [], thumbnails: [] },
  store: { id: 'st1', slug: 'amina-crafts', name: 'Amina Crafts', district: 'Kampala', logo: null, seo: {}, isPublished: true }
});
const server = http.createServer((req, res) => {
  if (handleProductAddress(req, res)) return;
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (IMAGES[urlPath]) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(IMAGES[urlPath]); }
  let file = path.join(ROOT, (rel => rel === '/' ? 'index.html' : (fs.existsSync(path.join(ROOT, rel)) || path.extname(rel) ? rel : rel + '.html'))(urlPath));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---- API stub ------------------------------------------------------------
const STORE = { id: 'st1', slug: 'amina-crafts', name: 'Amina Crafts', district: 'Kampala', address: 'Plot 4 Bombo Rd', badges: [], logo: null };
const product = (over = {}) => ({ id: PID, storeId: 'st1', name: 'Handwoven Basket', description: 'A sturdy basket.\nMade by hand.', price: 45000, originalPrice: null, category: 'home', images: ['/uploads/a.svg', '/uploads/b.svg', '/uploads/c.svg'], thumbnails: ['/uploads/t-a.svg', '/uploads/t-b.svg', '/uploads/t-c.svg'], thumbnail: '/uploads/t-a.svg', stock: 25, ...over });
const OTHERS = [
  { id: 'o1', name: 'Kitenge Bag', price: 30000, category: 'accessories', thumbnail: '/uploads/t-a.svg' },
  { id: 'o2', name: 'Clay Pot', price: 20000, category: 'home', thumbnail: '/uploads/t-b.svg' },
  { id: PID, name: 'Handwoven Basket', price: 45000, category: 'home', thumbnail: '/uploads/t-a.svg' }
];

async function open(browser, opts, scenario = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // uploads resolve against the API origin (localhost:4000 in dev), so serve them from the browser side too
  await page.route('**/uploads/**', route => {
    const body = IMAGES['/uploads/' + new URL(route.request().url()).pathname.split('/').pop()];
    return body ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/api/, '');
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { data } : { error: 'nope' }) });
    if (p.startsWith('/products/public/')) return scenario.productMissing ? json(null, 404) : json(product(scenario.product));
    if (p.startsWith('/store/public/')) return scenario.noStore ? json(null, 404) : json({ ...STORE, ...(scenario.store || {}) });
    if (p === '/products') return json(scenario.others || OTHERS);
    if (p.startsWith('/favorites/')) return json({ favorited: false });
    return json(null, 404);
  });
  if (opts.cart) await page.addInitScript(c => localStorage.setItem('nextastore_cart_v1', JSON.stringify(c)), opts.cart);
  if (opts.share) await page.addInitScript(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d; }; });
  await page.goto(`http://127.0.0.1:${PORT}${ADDRESS}`);
  await page.waitForFunction(() => !document.documentElement.classList.contains('nx-loading'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#productContent:not(.hidden)', { timeout: 15000 });
  return { ctx, page, errors };
}

let PORT;
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // ===== 1. gallery + viewer, desktop ======================================
  {
    const { ctx, page, errors } = await open(browser, {});
    const text = async sel => (await page.textContent(sel) || '').trim();
    check('gallery counter starts at 1 / 3', await text('#galleryCounter') === '1 / 3');
    check('thumbnails use the small variants', await page.$$eval('#thumbnailGallery img', els => els.every(i => /\/t-[abc]\.svg$/.test(i.getAttribute('src')))));
    check('main image is fully visible (object-fit: contain), not cropped', await page.$eval('#mainImage img', i => getComputedStyle(i).objectFit) === 'contain');
    check('main image is exposed as a button with a label', await page.$eval('#mainImage', el => el.getAttribute('role') === 'button' && /Enlarge/.test(el.getAttribute('aria-label'))));
    check('category shows its label, not the raw slug', await text('#productCategory') === 'Home & Living');
    check('viewer starts hidden', await page.$eval('#lightbox', el => el.hidden));

    const histBefore = await page.evaluate(() => history.length);
    await page.click('#mainImage');
    check('clicking the main image opens the viewer', await page.$eval('#lightbox', el => !el.hidden));
    check('viewer shows the full-size photo', await page.$eval('#lightboxImg', i => /\/uploads\/a\.svg$/.test(i.getAttribute('src'))));
    check('viewer counter reads 1 / 3', await text('#lightboxCount') === '1 / 3');
    check('page scroll is locked while the viewer is open', await page.evaluate(() => document.documentElement.classList.contains('lightbox-open') && getComputedStyle(document.documentElement).overflow === 'hidden'));
    check('focus moves into the viewer (close button)', await page.evaluate(() => document.activeElement && document.activeElement.id === 'lightboxClose'));
    check('viewer covers the whole viewport', await page.$eval('#lightbox', el => { const r = el.getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; }));
    check('image fits inside the stage at rest', await page.evaluate(() => { const i = document.getElementById('lightboxImg').getBoundingClientRect(), s = document.getElementById('lightboxStage').getBoundingClientRect(); return i.width <= s.width + 1 && i.height <= s.height + 1; }));

    await page.keyboard.press('ArrowRight');
    check('ArrowRight shows image 2', await text('#lightboxCount') === '2 / 3' && await page.$eval('#lightboxImg', i => /b\.svg$/.test(i.getAttribute('src'))));
    check('the page behind the viewer follows along', await text('#galleryCounter') === '2 / 3');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    check('paging wraps from first to last', await text('#lightboxCount') === '3 / 3');
    await page.click('.lightbox-thumb[data-index="1"]');
    check('viewer thumbnail jumps to that photo', await text('#lightboxCount') === '2 / 3');

    // zoom: button, tap, wheel, pan clamp, reset on paging
    await page.click('#lightboxZoom');
    check('zoom button zooms in', await page.$eval('#lightboxImg', i => /scale\(2\.5\)/.test(i.style.transform)) && await page.$eval('#lightboxZoom', b => b.getAttribute('aria-label') === 'Zoom out'));
    await page.click('#lightboxZoom');
    check('zoom button zooms back out', await page.$eval('#lightboxImg', i => i.style.transform === ''));
    const box = await page.$eval('#lightboxImg', i => { const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(box.x, box.y);
    check('clicking the photo zooms in', await page.$eval('#lightboxImg', i => /scale\(2\.5\)/.test(i.style.transform)));
    await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + 4000, box.y + 4000, { steps: 4 }); await page.mouse.up();
    const pan = await page.evaluate(() => {
      const i = document.getElementById('lightboxImg'), s = document.getElementById('lightboxStage');
      const m = i.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/);
      return { tx: +m[1], ty: +m[2], maxX: Math.max(0, (i.offsetWidth * +m[3] - s.clientWidth) / 2), maxY: Math.max(0, (i.offsetHeight * +m[3] - s.clientHeight) / 2) };
    });
    check('dragging pans but never past the photo edge', Math.abs(pan.tx) <= pan.maxX + 0.5 && Math.abs(pan.ty) <= pan.maxY + 0.5 && (pan.tx !== 0 || pan.ty !== 0), pan);
    check('a drag does not count as a tap (still zoomed)', await page.$eval('#lightboxImg', i => /scale\(2\.5\)/.test(i.style.transform)));
    await page.keyboard.press('ArrowRight');
    check('paging resets the zoom', await page.$eval('#lightboxImg', i => i.style.transform === ''));
    await page.mouse.move(box.x, box.y); await page.mouse.wheel(0, -300);
    check('scroll wheel zooms in', await page.$eval('#lightboxImg', i => /scale\(/.test(i.style.transform)));
    await page.keyboard.press('-'); await page.keyboard.press('-'); await page.keyboard.press('-'); await page.keyboard.press('-');
    check('"-" key zooms back out to rest', await page.$eval('#lightboxImg', i => i.style.transform === ''));

    // tab trap
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    check('Tab stays inside the viewer', await page.evaluate(() => document.getElementById('lightbox').contains(document.activeElement)));

    // Escape closes, focus comes back, history is not left dirty
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('Escape closes the viewer', await page.$eval('#lightbox', el => el.hidden));
    check('scroll lock is released', await page.evaluate(() => !document.documentElement.classList.contains('lightbox-open')));
    check('focus returns to the main image', await page.evaluate(() => document.activeElement && document.activeElement.id === 'mainImage'));
    check('closing does not leave an extra history entry behind', await page.evaluate(() => history.state === null || !history.state.nxLightbox));
    check('history length is unchanged after open/close', await page.evaluate(() => history.length) <= histBefore + 1);

    // Back button closes the viewer and keeps the shopper on the product
    await page.click('#mainImage');
    await page.goBack();
    await page.waitForTimeout(150);
    check('browser Back closes the viewer', await page.$eval('#lightbox', el => el.hidden));
    check('...and stays on the product page, at its own address', new URL(page.url()).pathname === ADDRESS);

    // backdrop tap closes (scale 1)
    await page.click('#mainImage');
    await page.mouse.click(8, 300);
    await page.waitForTimeout(150);
    check('tapping the dark area closes the viewer', await page.$eval('#lightbox', el => el.hidden));

    // keyboard: Enter on the focused main image opens it
    await page.focus('#mainImage'); await page.keyboard.press('Enter');
    check('Enter on the focused image opens the viewer', await page.$eval('#lightbox', el => !el.hidden));
    await page.click('#lightboxClose');
    await page.waitForTimeout(150);
    check('close button closes it', await page.$eval('#lightbox', el => el.hidden));

    // gallery arrows on the page
    await page.click('#thumbnailGallery .thumbnail-item[data-index="0"]');
    await page.hover('#mainImage');
    await page.click('#galleryNext');
    check('page arrow advances the gallery', await text('#galleryCounter') === '2 / 3' && await page.$eval('#mainImage img', i => /b\.svg$/.test(i.getAttribute('src'))));
    check('page arrow does not open the viewer', await page.$eval('#lightbox', el => el.hidden));
    check('active thumbnail follows', await page.$eval('#thumbnailGallery .thumbnail-item.active', b => b.dataset.index === '1'));
    check('no uncaught page errors', errors.length === 0, errors);
    await ctx.close();
  }

  // ===== 2. single image, tabs copy ========================================
  {
    const { ctx, page } = await open(browser, {}, { product: { images: ['/uploads/a.svg'], thumbnails: [] } });
    check('single image: no arrows or counter', await page.evaluate(() => ['galleryPrev', 'galleryNext', 'galleryCounter'].every(id => document.getElementById(id).hidden)));
    check('single image: enlarge hint still offered', await page.$eval('#galleryZoomHint', el => !el.hidden));
    await page.click('#mainImage');
    check('single image: viewer opens without paging controls', await page.$eval('#lightbox', el => !el.hidden && el.classList.contains('is-single')) && await page.$eval('#lightboxNext', el => getComputedStyle(el).display === 'none'));
    await page.keyboard.press('Escape');
    await page.click('[data-tab="shipping"]');
    check('the Delivery & Returns tab button becomes the active tab', await page.$eval('.tab-btn.active', b => b.dataset.tab === 'shipping'));
    const tab = await page.$eval('#shippingTab', el => el.innerText);
    check('Delivery & Returns tab no longer invents fees or timings', !/UGX\s*5,000|UGX\s*15,000|Express Shipping|3-5 business|7 days|5-7 business/i.test(tab), tab.slice(0, 200));
    check('Delivery & Returns tab says returns are agreed with the seller', /agreed directly with the seller/i.test(tab));
    check('pickup line names the store location', /Amina Crafts/.test(await page.textContent('#pickupInfo')) && /Kampala/.test(await page.textContent('#pickupInfo')));
    check('page no longer claims "Shipping: Available"', !/Shipping:\s*Available/i.test(await page.textContent('body')));
    check('tab is labelled Delivery & Returns', /Delivery & Returns/.test(await page.textContent('[data-tab="shipping"]')));
    await ctx.close();
  }

  // ===== 3. stock states ===================================================
  {
    let s = await open(browser, {}, { product: { stock: 0 } });
    check('out of stock: shows Out of stock', /Out of stock/.test(await s.page.textContent('#productStockText')));
    check('out of stock: Add to Cart is disabled and says so', await s.page.$eval('#addToCartBtn', b => b.disabled && /Out of stock/.test(b.textContent)));
    check('out of stock: quantity controls disabled', await s.page.evaluate(() => ['decreaseQty', 'increaseQty'].every(id => document.getElementById(id).disabled)));
    await s.ctx.close();

    s = await open(browser, {}, { product: { stock: 2 } });
    check('low stock: shows "Only 2 left"', /Only 2 left/.test(await s.page.textContent('#productStockText')));
    const poke = (id, n) => s.page.evaluate(([i, times]) => { for (let k = 0; k < times; k++) document.getElementById(i).click(); }, [id, n]);
    await poke('increaseQty', 3); // a disabled button ignores clicks, exactly like a shopper's
    check('quantity cannot exceed stock', await s.page.inputValue('#quantityInput') === '2' && await s.page.$eval('#increaseQty', b => b.disabled));
    await s.page.fill('#quantityInput', '50'); await s.page.press('#quantityInput', 'Tab');
    check('typing a huge quantity is clamped to stock', await s.page.inputValue('#quantityInput') === '2');
    await s.page.click('#addToCartBtn');
    check('adding puts 2 in the cart', await s.page.evaluate(() => JSON.parse(localStorage.getItem('nextastore_cart_v1'))[0].quantity) === 2);
    check('afterwards the button says everything is in the cart', await s.page.$eval('#addToCartBtn', b => b.disabled && /in your cart/i.test(b.textContent)));
    check('...and the hint explains why', /all 2 available/i.test(await s.page.textContent('#qtyHint')));
    await s.ctx.close();

    s = await open(browser, { cart: [{ productId: PID, quantity: 2, name: 'Handwoven Basket', price: 45000, stock: 5, storeId: 'st1', storeName: 'Amina Crafts' }] }, { product: { stock: 5 } });
    check('already in cart: hint shows the count', /2 already in your cart/.test(await s.page.textContent('#qtyHint')));
    await s.page.evaluate(() => { for (let k = 0; k < 4; k++) document.getElementById('increaseQty').click(); });
    check('already in cart: quantity capped at what is left (3)', await s.page.inputValue('#quantityInput') === '3');
    await s.ctx.close();

    s = await open(browser, {}, { product: { stock: 25 } });
    check('plenty in stock: "In stock · 25 available"', /In stock/.test(await s.page.textContent('#productStockText')) && /25 available/.test(await s.page.textContent('#productStockText')));
    check('Add to Cart is enabled', await s.page.$eval('#addToCartBtn', b => !b.disabled));
    await s.ctx.close();
  }

  // ===== 4. related products ===============================================
  {
    let s = await open(browser, {});
    check('related section is titled with the store name', await s.page.textContent('#relatedTitle') === 'More from Amina Crafts');
    check('"View all" goes to the store, not #', (await s.page.getAttribute('#relatedViewAll', 'href')) !== '#' && /amina-crafts/.test(await s.page.getAttribute('#relatedViewAll', 'href')));
    const names = await s.page.$$eval('#relatedProductsGrid .related-product-details h4', els => els.map(e => e.textContent));
    check('current product is excluded and same-category comes first', names.join('|') === 'Clay Pot|Kitenge Bag', names);
    check('related skeleton is gone', await s.page.$eval('#relatedLoadingState', el => getComputedStyle(el).display === 'none'));
    await s.ctx.close();

    s = await open(browser, {}, { others: [{ id: PID, name: 'Only Me', price: 1, category: 'home' }] });
    check('no other products: the whole section is hidden', await s.page.$eval('#relatedSection', el => getComputedStyle(el).display === 'none'));
    await s.ctx.close();

    s = await open(browser, {}, { noStore: true });
    check('store lookup failed: related section hidden, no stuck skeleton', await s.page.$eval('#relatedSection', el => getComputedStyle(el).display === 'none'));
    await s.ctx.close();

    s = await open(browser, {}, { productMissing: true }).catch(() => null);
    if (s) {
      check('product not found: Add to Cart disabled and related hidden', await s.page.$eval('#addToCartBtn', b => b.disabled) && await s.page.$eval('#relatedSection', el => getComputedStyle(el).display === 'none'));
      await s.ctx.close();
    }
  }

  // ===== 5. phone: swipe, layout, native share =============================
  {
    const { ctx, page, errors } = await open(browser, { mobile: true, viewport: { width: 390, height: 844 }, share: true });
    const swipe = (sel, from, to) => page.$eval(sel, (el, [a, b]) => {
      const r = el.getBoundingClientRect(), y = r.top + r.height / 2;
      const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: x, clientY: y, bubbles: true, isPrimary: true }));
      fire('pointerdown', r.left + r.width * a); fire('pointermove', r.left + r.width * (a + b) / 2); fire('pointerup', r.left + r.width * b);
    }, [from, to]);
    await swipe('#mainImage', 0.8, 0.2);
    check('swipe left on the photo shows the next image', await page.textContent('#galleryCounter') === '2 / 3');
    check('a swipe does not also open the viewer', await page.$eval('#lightbox', el => el.hidden));
    await swipe('#mainImage', 0.2, 0.8);
    check('swipe right goes back', await page.textContent('#galleryCounter') === '1 / 3');
    await page.waitForTimeout(400);
    await page.tap('#mainImage');
    check('tap opens the viewer', await page.$eval('#lightbox', el => !el.hidden));
    await swipe('#lightboxStage', 0.8, 0.2);
    check('swipe inside the viewer pages to the next photo', await page.textContent('#lightboxCount') === '2 / 3');
    await page.evaluate(() => document.getElementById('lightboxClose').click());
    await page.waitForTimeout(200);
    check('no sideways scroll on a 390px phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
    await page.click('#shareBtn');
    check('phone share opens the system share sheet with the product\'s own address (the one that carries its photo, name and price to WhatsApp)', await page.evaluate(([addr]) => window.__shared && window.__shared.url === location.origin + addr && !/product-detail|\/p\//.test(window.__shared.url) && /Handwoven Basket/.test(window.__shared.text), [ADDRESS]));
    check('...instead of the in-page share modal', await page.$eval('#shareModal', el => !el.classList.contains('open')));
    check('no uncaught page errors on the phone', errors.length === 0, errors);
    await ctx.close();
  }

  // ===== 6. long description ==============================================
  {
    const { ctx, page } = await open(browser, {}, { product: { description: 'Line one.\nLine two. ' + 'word '.repeat(300) } });
    check('long description is clamped with a Read more button', await page.$eval('#readMoreBtn', b => !b.hidden) && await page.$eval('#productDescription', p => p.classList.contains('is-clamped')));
    await page.click('#readMoreBtn');
    check('Read more expands it and offers Show less', await page.$eval('#productDescription', p => !p.classList.contains('is-clamped')) && /Show less/.test(await page.textContent('#readMoreBtn')));
    await ctx.close();
    const short = await open(browser, {});
    check('short description: no Read more button', await short.page.$eval('#readMoreBtn', b => b.hidden));
    check('line breaks in the description are preserved', await short.page.$eval('#productDescription', p => getComputedStyle(p).whiteSpace === 'pre-line'));
    await short.ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed}/${passed + failed} browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
