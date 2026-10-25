#!/usr/bin/env node
'use strict';
/*
 * Real-browser test of the in-app directions modal (js/map-directions.js) and of
 * the map-preview width fix (js/map-preview.js), using the REAL css/main.css,
 * css/map-picker.css and the REAL scripts in Chromium.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:directions-browser        (CHROMIUM_PATH=... to pick a binary)
 *
 * Proves: live-location -> OSRM road route -> distance / drive time / walking time;
 * the route is drawn (white casing + green line) and the view is fitted to it; the
 * Google Maps link gains the person's origin; an OSRM failure becomes a clearly
 * labelled dashed straight-line estimate; denied location shows a retry that works
 * once allowed; "you're here" within 40 m; showRoute:false never asks for location;
 * a missing Leaflet falls back to the static tile map; Escape / backdrop / close
 * button close it and give focus back; Tab stays inside it; seller-written text can
 * not inject markup; the layout holds at 360 / 768 / 1280 px and on a phone on its
 * side; a map preview fills its slot on a wide screen (no blank strip) and redraws
 * when the slot changes width.
 *
 * Does NOT prove: real Leaflet (it cannot be downloaded in the sandbox, so a small
 * recording stand-in is used - the CALLS the modal makes are checked, not Leaflet's
 * drawing), the real OSRM server, real GPS, Font Awesome icons (not loaded), or
 * real phones.
 */
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

const out = []; const check = (n, ok, d = '') => out.push({ n, ok: !!ok, d });
const API_ORIGIN = 'http://localhost:4000';
const ORIGIN = 'http://localhost:3000';   // geolocation needs a secure origin; localhost counts
const DEST = { lat: 0.3136, lng: 32.5811 };
const USER = { lat: 0.3500, lng: 32.6000 };
const ROUTE_LNGLAT = [[32.6000, 0.3500], [32.5950, 0.3400], [32.5900, 0.3300], [32.5811, 0.3136]]; // OSRM order: lng, lat
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A recording stand-in for Leaflet: it draws nothing real, it records what the modal asks for.
const LEAFLET_STUB = `
window.__L = { maps: [], polylines: [], fitBounds: [], markers: [], tileLayers: 0, removed: 0, polylineRemoved: 0 };
window.L = {
  map(el) { el.classList.add('leaflet-container'); const m = { el, getZoom() { return this.view ? this.view[1] : 14; }, setView(c, z, o) { this.view = [c, z]; this.viewOpts = o; (__L.setViews = __L.setViews || []).push([c, z]); return this; },
    fitBounds(b, o) { __L.fitBounds.push({ pts: b.pts, opts: o }); }, invalidateSize() {}, remove() { __L.removed++; el.innerHTML = ''; } }; __L.maps.push(m); return m; },
  tileLayer() { __L.tileLayers++; return { addTo() { return this; } }; },
  control: { zoom() { return { addTo() { return this; } }; } },
  Control: { extend(proto) { return function () { return { addTo(m) { const c = proto.onAdd.call({}); c.classList.add('stub-control'); m.el.appendChild(c); return this; } }; }; } },
  DomUtil: { create(tag, cls, parent) { const e = document.createElement(tag); e.className = cls || ''; if (parent) parent.appendChild(e); return e; } },
  DomEvent: { disableClickPropagation() {}, on(el, ev, fn) { el.addEventListener(ev, fn); }, stop(e) { e.preventDefault(); e.stopPropagation(); } },
  divIcon(o) { return o; },
  marker(ll, o) { const mk = { ll, addTo(m) { __L.markers.push({ ll: this.ll, title: o.title, html: o.icon.html }); const d = document.createElement('div'); d.innerHTML = o.icon.html; m.el.appendChild(d); return this; }, setLatLng(l) { this.ll = l; }, setZIndexOffset() {} }; return mk; },
  polyline(coords, o) { return { addTo() { __L.polylines.push({ coords, opts: o }); return this; }, remove() { __L.polylineRemoved++; } }; },
  latLngBounds(pts) { return { pts }; }
};`;

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/map-picker.css"></head>
<body><button id="opener" type="button" data-nsd-open data-lat="${DEST.lat}" data-lng="${DEST.lng}" data-label="Nexta Crafts" data-address="Plot 4, Kampala Road" data-notes="Opposite the blue gate">Directions</button>
<div id="card" style="max-width:1000px;margin:20px auto;padding:20px;border:1px solid #ccc;box-sizing:border-box"><div id="slot" style="width:100%"></div></div>
<script src="/js/map-preview.js"></script><script src="/js/map-directions.js"></script></body></html>`;

const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** opts: geo ('granted' | 'denied'), pos, accuracy, osrm ('ok' | 'fail'), leaflet (true | false), viewport */
async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 800 },
    ...(opts.geo === 'denied' ? {} : { permissions: ['geolocation'], geolocation: { latitude: (opts.pos || USER).lat, longitude: (opts.pos || USER).lng, accuracy: opts.accuracy || 20 } })
  });
  const page = await ctx.newPage();
  const seen = { osrm: [], tiles: 0, geoCalls: 0 };
  page.__seen = seen; page.__ctx = ctx;
  page.on('pageerror', e => { (page.__errors = page.__errors || []).push(e.message); });
  if (opts.init) await page.addInitScript(opts.init, opts.initArg);
  if (opts.geo === 'denied') {
    // A blocked site: calls fail with PERMISSION_DENIED straight away (headless Chromium would leave
    // them pending), the Permissions API says 'denied', and __allowGeo() plays "person flipped it to
    // Allow in the lock menu": the real (Playwright-granted) geolocation takes over and onchange fires.
    await page.addInitScript(() => {
      window.__geoBlocked = true;
      const g = navigator.geolocation;
      ['getCurrentPosition', 'watchPosition'].forEach(k => {
        const real = g[k].bind(g);
        g[k] = (ok, err, o) => {
          if (window.__geoBlocked) { if (err) setTimeout(() => err({ code: 1, message: 'denied' }), 10); return k === 'watchPosition' ? 1 : undefined; }
          return real(ok, err, o);
        };
      });
      const status = { state: 'denied', onchange: null };
      navigator.permissions.query = async () => status;
      window.__allowGeo = () => { window.__geoBlocked = false; status.state = 'granted'; if (status.onchange) status.onchange(); };
    });
  }
  await page.addInitScript(() => {
    const g = navigator.geolocation;
    window.__geoCalls = 0;
    ['getCurrentPosition', 'watchPosition'].forEach(k => { const f = g[k].bind(g); g[k] = (...a) => { window.__geoCalls++; return f(...a); }; });
  });
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === API_ORIGIN) {   // the real pages talk to the API on :4000 when served from localhost
      const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = opts.api ? opts.api(u.pathname.replace(/^\/api/, '') + u.search) : { data: {} };
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    }
    if (u.origin === ORIGIN) {
      if (u.pathname === '/harness.html') return route.fulfill({ contentType: 'text/html', body: HARNESS });
      let f = path.join(ROOT, decodeURIComponent(u.pathname));
      // What the real server does: /messages -> messages.html, and any other single-segment address is a store.
      if (!fs.existsSync(f) && /^\/[A-Za-z0-9-]+$/.test(u.pathname)) f = path.join(ROOT, fs.existsSync(f + '.html') ? u.pathname + '.html' : 'store-detail.html');
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: 'nope' });
    }
    if (u.hostname === 'unpkg.com') {
      if (u.pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: '/* stub */' });
      if (opts.leaflet === false) return route.abort();
      return route.fulfill({ contentType: 'application/javascript', body: LEAFLET_STUB });
    }
    if (u.hostname === 'router.project-osrm.org') {
      seen.osrm.push(u.pathname);
      if (opts.osrm === 'fail') return route.fulfill({ status: 500, body: 'down' });
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'Ok', routes: [{ distance: 5230, duration: 780, geometry: { type: 'LineString', coordinates: ROUTE_LNGLAT } }] }) });
    }
    if (u.hostname.endsWith('tile.openstreetmap.org')) { seen.tiles++; return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG }); }
    return route.abort();   // fonts, Font Awesome, anything else: not needed
  });
  await page.goto(ORIGIN + (opts.url || '/harness.html'));
  return page;
}

const text = (page, sel) => page.evaluate(s => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const close = page => page.__ctx.close();

module.exports = { newPage };
if (require.main !== module) return;   // lets a debug script reuse newPage()

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let page;

  // ---- 1. Happy path: live location -> road route -------------------------------
  page = await newPage(browser);
  await page.click('#opener');
  check('open: overlay is in the page, body is flagged, and it is a modal dialog', await page.evaluate(() => !!document.getElementById('nsdOverlay') && document.body.classList.contains('nsd-open') && document.querySelector('.nsd-panel').getAttribute('aria-modal') === 'true'));
  check('open: focus moves to the close button', await page.evaluate(() => document.activeElement === document.querySelector('.nsd-close')));
  check('open: header says Directions, "to <store name>"', (await text(page, '#nsdTitle')) === 'Directions' && /to Nexta Crafts/.test(await text(page, '.nsd-head-text p')));
  check('open: destination block shows the name, address and the seller\'s directions', /Nexta Crafts/.test(await text(page, '.nsd-points li:last-child')) && /Plot 4, Kampala Road/.test(await text(page, '.nsd-points')) && /Opposite the blue gate/.test(await text(page, '.nsd-seller-note')));
  await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  const stats = await page.evaluate(() => [...document.querySelectorAll('.nsd-stat')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('route: distance (5.2 km) and drive time (13 min) shown from the road route', /Distance\s*5\.2 km/.test(stats[0]) && /13 min/.test(stats[1]), stats.join(' | '));
  check('route: walking time derived from the road distance (about 1 h 5 min)', /Walking: about 1 h 5 min/.test(await text(page, '.nsd-alt')), await text(page, '.nsd-alt'));
  check('route: says it is an estimate without live traffic', /without live traffic/.test(await text(page, '.nsd-note')));
  check('route: OSRM asked once, from the person to the shop (lng,lat;lng,lat)', page.__seen.osrm.length === 1 && page.__seen.osrm[0].endsWith('/32.6,0.35;32.5811,0.3136'), page.__seen.osrm.join(' '));
  check('route: "From" line says how accurate the fix is', /Accurate to about 20 m/.test(await text(page, '#nsdFromSub')), await text(page, '#nsdFromSub'));
  const L = await page.evaluate(() => window.__L);
  check('map: Leaflet built once, with a tile layer', L.maps.length === 1 && L.tileLayers === 1);
  check('map: shop pin and "Your location" dot both placed', L.markers.some(m => m.title === 'Nexta Crafts' && /nsd-pin/.test(m.html)) && L.markers.some(m => m.title === 'Your location' && /nsd-me/.test(m.html)), JSON.stringify(L.markers.map(m => m.title)));
  const expectedCoords = ROUTE_LNGLAT.map(([x, y]) => [y, x]);
  check('map: route drawn as a white casing under a solid green line, with the road\'s own points (lat,lng order)', L.polylines.length === 2 && L.polylines[0].opts.weight === 10 && L.polylines[1].opts.weight === 5 && !L.polylines[1].opts.dashArray && JSON.stringify(L.polylines[1].coords) === JSON.stringify(expectedCoords), JSON.stringify(L.polylines.map(p => p.opts)));
  check('map: view fitted to shop + person + the whole route', L.fitBounds.length === 1 && L.fitBounds[0].pts.length === 2 + ROUTE_LNGLAT.length, L.fitBounds[0] && String(L.fitBounds[0].pts.length));
  check('actions: "Show whole route" appears once there is a route, and re-fits the view', await page.evaluate(() => !document.querySelector('[data-nsd-fit]').hidden));
  await page.click('[data-nsd-fit]');
  check('actions: tapping it fits the view again', (await page.evaluate(() => window.__L.fitBounds.length)) === 2);
  const g = await page.getAttribute('#nsdGoogle', 'href');
  check('actions: Google Maps link carries the destination AND the person\'s origin', /destination=0\.3136,32\.5811/.test(g) && /origin=0\.35,32\.6/.test(g) && (await page.getAttribute('#nsdGoogle', 'rel')).includes('noopener'), g);
  check('no page errors', !(page.__errors || []).length, (page.__errors || []).join(' | '));
  await page.keyboard.press('Escape');
  check('Escape closes: overlay gone, body unflagged, Leaflet map removed', await page.evaluate(() => !document.getElementById('nsdOverlay') && !document.body.classList.contains('nsd-open') && window.__L.removed === 1));
  check('Escape closes: focus goes back to the button that opened it', await page.evaluate(() => document.activeElement === document.getElementById('opener')));
  await close(page);

  // ---- 2. OSRM down -> labelled straight-line estimate ---------------------------
  page = await newPage(browser, { osrm: 'fail' });
  await page.click('#opener'); await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  const s2 = await page.evaluate(() => [...document.querySelectorAll('.nsd-stat')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('routing down: numbers still appear, labelled "Straight line" / "Drive (rough)"', /Straight line/.test(s2[0]) && /Drive \(rough\)/.test(s2[1]) && /\d/.test(s2[0]) && /\d/.test(s2[1]), s2.join(' | '));
  check('routing down: says plainly it is a rough straight-line estimate', /rough straight-line estimate/.test(await text(page, '.nsd-note')));
  const L2 = await page.evaluate(() => window.__L);
  check('routing down: the line on the map is dashed and joins just the two points', L2.polylines.length === 2 && L2.polylines[1].opts.dashArray === '2 10' && L2.polylines[1].coords.length === 2);
  await close(page);

  // ---- 3. Location denied -> message, retry works once allowed -------------------
  page = await newPage(browser, { geo: 'denied' });
  await page.click('#opener'); await page.waitForSelector('[data-nsd-retry]', { timeout: 5000 });
  check('denied: says location access is off and offers Try again', /Location access is off/.test(await text(page, '.nsd-summary')) && !!(await page.$('[data-nsd-retry]')));
  check('denied: "From" line says not available, and the shop is still on the map', /Not available/.test(await text(page, '#nsdFromSub')) && (await page.evaluate(() => window.__L.markers.some(m => m.title === 'Nexta Crafts'))));
  check('denied: no route was requested', page.__seen.osrm.length === 0);
  await page.__ctx.grantPermissions(['geolocation'], { origin: ORIGIN });
  await page.__ctx.setGeolocation({ latitude: USER.lat, longitude: USER.lng, accuracy: 20 });
  await page.evaluate(() => window.__allowGeo());
  // The modal now watches the permission itself, so allowing location may already retry on its own;
  // pressing Try again must work too if it hasn't.
  await page.waitForTimeout(300);
  if (await page.$('[data-nsd-retry]')) await page.click('[data-nsd-retry]');
  await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  check('denied then allowed: the person is found and the route shows', /5\.2 km/.test(await text(page, '.nsd-stats')));
  await close(page);

  // ---- 3b. The "find me" button on the map itself --------------------------------
  page = await newPage(browser, {});
  await page.click('#opener'); await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  check('locate button: sits on the map itself (not only in the side panel)', await page.evaluate(() => !!document.querySelector('#nsdMap .nsd-locate-btn')));
  check('locate button: labelled for screen readers', (await page.getAttribute('#nsdMap .nsd-locate-btn', 'aria-label')) === 'Show my location');
  check('locate button: turns active (blue) once a position is known', await page.evaluate(() => document.querySelector('#nsdMap .nsd-locate-btn').classList.contains('is-active')));
  await page.evaluate(() => { window.__L.setViews = []; });
  await page.click('#nsdMap .nsd-locate-btn');
  const sv = await page.evaluate(() => window.__L.setViews.slice(-1)[0]);
  check('locate button: tapping it centres the map on the person at street zoom', sv && Math.abs(sv[0][0] - USER.lat) < 1e-6 && Math.abs(sv[0][1] - USER.lng) < 1e-6 && sv[1] >= 16, JSON.stringify(sv));
  await close(page);

  // pin-only mode never asks for location, so it has no locate button
  page = await newPage(browser, {});
  await page.evaluate(() => NextaStoreDirections.open({ lat: 0.3136, lng: 32.5811, label: 'Pin', showRoute: false }));
  await page.waitForSelector('#nsdMap .leaflet-container, #nsdMap.leaflet-container', { timeout: 5000 });
  check('pin-only mode: no locate button and no location request', !(await page.$('#nsdMap .nsd-locate-btn')) && (await page.evaluate(() => window.__geoCalls)) === 0);
  await close(page);

  // Location blocked: the map button asks again, and the message tells them what to do
  page = await newPage(browser, { geo: 'denied' });
  await page.click('#opener'); await page.waitForSelector('[data-nsd-retry]', { timeout: 5000 });
  const calls0 = await page.evaluate(() => window.__geoCalls);
  await page.click('#nsdMap .nsd-locate-btn');
  await page.waitForTimeout(400);
  check('blocked: the map button asks the browser for location again', (await page.evaluate(() => window.__geoCalls)) > calls0);
  check('blocked: message says how to fix it (lock icon -> Location -> Allow)', /lock icon/i.test(await text(page, '.nsd-summary')));
  await page.__ctx.grantPermissions(['geolocation'], { origin: ORIGIN });
  await page.__ctx.setGeolocation({ latitude: USER.lat, longitude: USER.lng, accuracy: 20 });
  await page.evaluate(() => window.__allowGeo());
  await page.waitForSelector('.nsd-stats', { timeout: 8000 });
  check('blocked then allowed in the lock menu: found without pressing anything', /5\.2 km/.test(await text(page, '.nsd-stats')));
  await close(page);

  // Device cannot work out its position (e.g. Windows location services off)
  page = await newPage(browser, { init: () => {
    const g = navigator.geolocation;
    g.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: 2, message: 'unavailable' }), 20);
    g.watchPosition = () => 1; g.clearWatch = () => {};
  } });
  await page.click('#opener'); await page.waitForSelector('[data-nsd-retry]', { timeout: 6000 });
  check('position unavailable: explains how to turn location on (not just "off")', /system settings/i.test(await text(page, '.nsd-summary')) && !/Location access is off/.test(await text(page, '.nsd-summary')));
  await close(page);

  // ---- 4. Already at the shop ----------------------------------------------------
  page = await newPage(browser, { pos: { lat: DEST.lat + 0.00005, lng: DEST.lng } });
  await page.click('#opener'); await page.waitForSelector('.nsd-status', { timeout: 5000 });
  await page.waitForFunction(() => /You.re here/.test(document.querySelector('.nsd-summary')?.textContent || ''), null, { timeout: 5000 });
  check('at the shop (about 5 m away): says "You\'re here" instead of a 0-minute route', /You.re here/.test(await text(page, '.nsd-summary')) && !(await page.$('.nsd-stats')));
  await close(page);

  // ---- 5. Pin-check mode never asks for location ----------------------------------
  page = await newPage(browser);
  await page.evaluate(() => NextaStoreDirections.open({ lat: 0.3136, lng: 32.5811, label: 'My pin', address: 'Somewhere', showRoute: false }));
  await page.waitForTimeout(300);
  check('showRoute:false: no location request, no summary box, title is the place', (await page.evaluate(() => window.__geoCalls)) === 0 && !(await page.$('.nsd-summary')) && (await text(page, '#nsdTitle')) === 'My pin');
  check('showRoute:false: Google link is a plain search for the pin, no "From" row', /maps\/search\/\?api=1&query=0\.3136,32\.5811/.test(await page.getAttribute('#nsdGoogle', 'href')) && !/From/.test(await text(page, '.nsd-points')));
  check('showRoute:false: still shows the pin on a Leaflet map and does not call OSRM', (await page.evaluate(() => window.__L.markers.length)) === 1 && page.__seen.osrm.length === 0);
  await close(page);

  // ---- 6. No Leaflet -> static tile map, numbers still work -----------------------
  page = await newPage(browser, { leaflet: false });
  await page.click('#opener');
  await page.waitForSelector('#nsdMap .map-preview-frame', { timeout: 8000 });
  await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  check('Leaflet blocked: the map slot falls back to the static tile map of the pin', !!(await page.$('#nsdMap .map-preview-frame')));
  check('Leaflet blocked: distance and time still work', /5\.2 km/.test(await text(page, '.nsd-stats')));
  await close(page);

  // ---- 7. Closing + keyboard + hostile text ---------------------------------------
  page = await newPage(browser);
  await page.evaluate(() => { document.getElementById('opener').dataset.label = '<img src=x onerror="window.__x=1">Shop'; document.getElementById('opener').dataset.address = '"><script>window.__y=1<\/script>'; document.getElementById('opener').dataset.notes = '<b id=evil>bold</b>'; });
  await page.click('#opener'); await page.waitForSelector('.nsd-stats', { timeout: 5000 });
  check('hostile label/address/notes: shown as text, no elements, no script ran', await page.evaluate(() => !document.querySelector('#nsdOverlay img, #nsdOverlay script, #evil') && !window.__x && !window.__y && document.querySelector('#nsdTitle').nextElementSibling.textContent.includes('<img')));
  const order = await page.evaluate(() => { const f = [...document.querySelectorAll('#nsdOverlay button:not([hidden]):not([disabled]), #nsdOverlay a[href]')].filter(e => e.offsetParent !== null); return { first: f[0].className, last: f[f.length - 1].id, n: f.length }; });
  await page.evaluate(() => { const f = [...document.querySelectorAll('#nsdOverlay button:not([hidden]):not([disabled]), #nsdOverlay a[href]')].filter(e => e.offsetParent !== null); f[f.length - 1].focus(); }); await page.keyboard.press('Tab');   // the last control is now the on-map locate button
  check('Tab on the last control wraps to the first (focus stays inside the modal)', await page.evaluate(() => document.activeElement === document.querySelector('.nsd-close')), JSON.stringify(order));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab on the first control wraps to the last', await page.evaluate(() => { const f = [...document.querySelectorAll('#nsdOverlay button:not([hidden]):not([disabled]), #nsdOverlay a[href]')].filter(e => e.offsetParent !== null); return document.activeElement === f[f.length - 1]; }));
  await page.click('.nsd-panel .nsd-head-text');
  check('clicking inside the panel does not close it', !!(await page.$('#nsdOverlay')));
  await page.mouse.click(4, 4);
  check('clicking the dark backdrop closes it', !(await page.$('#nsdOverlay')));
  await page.click('#opener'); await page.click('.nsd-close');
  check('the X button closes it', !(await page.$('#nsdOverlay')));
  await page.click('#opener'); await page.click('#opener', { force: true }).catch(() => {});
  check('opening twice never stacks two overlays', (await page.$$('#nsdOverlay')).length <= 1);
  await close(page);

  // ---- 8. Layout at real screen sizes ---------------------------------------------
  for (const vp of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 700 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }, { width: 667, height: 375 }]) {
    page = await newPage(browser, { viewport: vp });
    await page.click('#opener'); await page.waitForSelector('.nsd-stats', { timeout: 5000 });
    await page.waitForTimeout(450);   // let the open animation finish
    const m = await page.evaluate(() => {
      const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      return { vw: innerWidth, vh: innerHeight, panel: r('.nsd-panel'), map: r('#nsdMap'), close: r('.nsd-close'), summary: r('.nsd-summary'), google: r('#nsdGoogle'),
        spill: [...document.querySelectorAll('.nsd-panel button, .nsd-panel a[href]')].filter(e => e.offsetParent !== null).map(e => { const b = e.getBoundingClientRect(), p = document.querySelector('.nsd-panel').getBoundingClientRect(); return (b.right > p.right + 1 || b.left < p.left - 1) ? (e.textContent.trim() || e.className) + ' ' + Math.round(b.left) + '-' + Math.round(b.right) + ' vs panel ' + Math.round(p.left) + '-' + Math.round(p.right) : null; }).filter(Boolean),
        sideBlank: Math.round(document.querySelector('.nsd-body').getBoundingClientRect().bottom - document.querySelector('.nsd-side').getBoundingClientRect().bottom),
        googleInside: document.querySelector('#nsdGoogle').getBoundingClientRect().bottom <= document.querySelector('.nsd-panel').getBoundingClientRect().bottom + 1,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, panelOverflowX: (() => { const p = document.querySelector('.nsd-panel'); return p.scrollWidth > p.clientWidth + 1; })() };
    });
    const tag = `${vp.width}x${vp.height}`;
    check(`${tag}: panel sits inside the screen`, m.panel.l >= -1 && m.panel.r <= m.vw + 1 && m.panel.t >= -1 && m.panel.b <= m.vh + 1, JSON.stringify(m.panel));
    check(`${tag}: no sideways scrolling (page or panel)`, !m.docOverflow && !m.panelOverflowX);
    check(`${tag}: the map has real size (at least 200 x 150)`, m.map.w >= 200 && m.map.h >= 150, JSON.stringify(m.map));
    check(`${tag}: close button is a proper tap target (>= 44px) and on screen`, m.close.w >= 44 && m.close.h >= 44 && m.close.r <= m.vw + 1 && m.close.t >= -1, JSON.stringify(m.close));
    check(`${tag}: no button or link runs past the panel's left or right edge`, m.spill.length === 0, m.spill.join(' ; '));
    check(`${tag}: no dead white space under the summary column`, m.sideBlank <= 1, String(m.sideBlank));
    if (vp.height >= 560) check(`${tag}: the whole summary and the Google Maps button are on screen without scrolling`, m.googleInside, 'google button bottom is below the panel');
    check(`${tag}: summary and Google button are laid out (not collapsed)`, m.summary.h > 40 && m.google.h > 20 && m.google.w > 80, JSON.stringify({ s: m.summary, g: m.google }));
    await close(page);
  }

  // ---- 9. Map preview: fills its slot on a wide screen, redraws on resize ---------
  page = await newPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.evaluate(() => NextaStoreMapPreview.render(document.getElementById('slot'), { lat: 0.3136, lng: 32.5811, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=0.3136,32.5811' }));
  await page.waitForSelector('#slot .map-preview-tile', { timeout: 5000 });
  const geo = () => page.evaluate(() => {
    const slot = document.getElementById('slot'), f = slot.querySelector('.map-preview-frame'); const sb = slot.getBoundingClientRect(), fb = f.getBoundingClientRect();
    const tiles = [...slot.querySelectorAll('.map-preview-tile')].map(t => ({ l: parseFloat(t.style.left), t: parseFloat(t.style.top) }));
    return { slotW: Math.round(sb.width), frameW: Math.round(fb.width), gap: Math.round(sb.right - fb.right), minL: Math.min(...tiles.map(t => t.l)), maxR: Math.max(...tiles.map(t => t.l + 256)), minT: Math.min(...tiles.map(t => t.t)), maxB: Math.max(...tiles.map(t => t.t + 256)), fh: Math.round(fb.height) };
  });
  let gm = await geo();
  check('preview @1440: frame is as wide as its slot (no white strip), well past the old 640px cap', gm.frameW === gm.slotW && gm.gap === 0 && gm.frameW > 800, JSON.stringify(gm));
  check('preview @1440: tiles cover the frame edge to edge', gm.minL <= 0 && gm.maxR >= gm.frameW && gm.minT <= 0 && gm.maxB >= gm.fh, JSON.stringify(gm));
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForFunction(() => document.querySelector('#slot .map-preview-frame').getBoundingClientRect().width < 600, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#slot .map-preview-frame .map-preview-tile').length > 0, null, { timeout: 5000 });
  gm = await geo();
  check('preview: shrinking the window redraws it to the new slot width', gm.frameW === gm.slotW && gm.gap === 0 && gm.frameW < 600, JSON.stringify(gm));
  check('preview: tiles still cover the frame after the redraw', gm.minL <= 0 && gm.maxR >= gm.frameW, JSON.stringify(gm));
  await page.setViewportSize({ width: 360, height: 700 });
  await page.waitForFunction(() => document.querySelector('#slot .map-preview-frame').getBoundingClientRect().width < 340, null, { timeout: 5000 });
  gm = await geo();
  check('preview @360: fits a phone with no overflow', gm.frameW === gm.slotW && gm.gap === 0 && !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), JSON.stringify(gm));
  // Regression: the desktop sidebar slot (~214px) is narrower than one 256px tile. The site-wide
  // `img { max-width: 100% }` used to squash the tiles to the slot width, leaving a blank vertical
  // bar through the middle of the map (right where the pin is). Tiles must stay 256px and touch.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.getElementById('card').style.width = '254px'; });   // 254 - 2*20 padding - 2 border = ~212px slot
  await page.waitForFunction(() => { const f = document.querySelector('#slot .map-preview-frame'); return f && f.getBoundingClientRect().width < 230 && f.querySelectorAll('.map-preview-tile').length > 1; }, null, { timeout: 5000 });
  const narrow = await page.evaluate(() => {
    const f = document.querySelector('#slot .map-preview-frame'); const fr = f.getBoundingClientRect();
    const t = [...f.querySelectorAll('.map-preview-tile')].map(i => { const r = i.getBoundingClientRect(); return { l: Math.round(r.left - fr.left), w: Math.round(r.width) }; });
    const cols = [...new Set(t.map(x => x.l))].sort((a, b) => a - b);
    return { frameW: Math.round(fr.width), widths: [...new Set(t.map(x => x.w))], steps: cols.slice(1).map((l, k) => l - cols[k]), first: cols[0], lastRight: cols[cols.length - 1] + 256 };
  });
  check('narrow slot (desktop sidebar): tiles stay 256px wide, not squashed to the slot', narrow.widths.length === 1 && narrow.widths[0] === 256 && narrow.frameW < 256, JSON.stringify(narrow));
  check('narrow slot: tiles touch edge to edge - no blank bar through the map', narrow.steps.every(d => d === 256) && narrow.first <= 0 && narrow.lastRight >= narrow.frameW, JSON.stringify(narrow));
  await close(page);

  // ---- 10. Map preview tap opens the modal with that place -------------------------
  page = await newPage(browser);
  await page.evaluate(() => NextaStoreMapPreview.render(document.getElementById('slot'), { lat: 0.3136, lng: 32.5811, directions: { label: 'Tap Shop', address: 'Ntinda', notes: 'Behind the market' } }));
  await page.waitForSelector('#slot .map-preview-tap', { timeout: 5000 });
  check('preview with directions: shows a "Get directions" button over the map, not a link out to Google', !!(await page.$('#slot button[data-nsd-open]')) && !(await page.$('#slot a.map-preview-overlay-link')) && /Get directions/.test(await text(page, '#slot .map-preview-hint')));
  await page.click('#slot .map-preview-tap');
  await page.waitForSelector('#nsdOverlay');
  check('tapping it opens the modal for that place, with its name, address and notes', (await text(page, '.nsd-head-text p')) === 'to Tap Shop' && /Ntinda/.test(await text(page, '.nsd-points')) && /Behind the market/.test(await text(page, '.nsd-seller-note')));
  await page.keyboard.press('Escape');
  check('and focus returns to the map button on close', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('map-preview-tap')));
  await close(page);

  // ---- 11. The REAL store-detail.html: every tap point opens the modal --------------
  const store = { id: 's1', name: 'Asia Ivan Store', slug: 'asia-ivan-store', description: 'Handmade things', district: 'Mbale', address: 'Plot 9 Republic St', mapCoordinates: '0.3136,32.5811', detailedDirections: 'Opposite the blue gate', productCount: 0, followers: 0, badges: [], bannerColor: '#00B074', logo: null };
  const storeApi = st => ep => {
    if (ep.startsWith('/store/public')) return { data: st };
    if (ep.startsWith('/products')) return { data: [], pagination: { page: 1, pages: 1, total: 0 } };
    return { data: {} };
  };
  page = await newPage(browser, { url: '/store-detail.html?store=asia-ivan-store', api: storeApi(store), viewport: { width: 1440, height: 900 } });
  let popups = 0; page.on('popup', () => popups++);
  await page.waitForSelector('#storeMapPreview .map-preview-tile, #storeMapPreview .map-preview-fallback', { timeout: 8000 });
  const sf = await page.evaluate(() => { const loc = document.getElementById('storeLocation').parentElement; return {
    locAction: loc.hasAttribute('data-nsd-open') && loc.getAttribute('role') === 'button' && loc.tabIndex === 0 && loc.dataset.lat === '0.3136' && loc.dataset.lng === '32.5811' && loc.dataset.label === 'Asia Ivan Store',
    aboutRow: !!document.querySelector('.info-row--action[data-nsd-open]'),
    mapTap: !!document.querySelector('#storeMapPreview button.map-preview-tap[data-nsd-open]'),
    googleLinkOnMap: !!document.querySelector('#storeMapPreview a.map-preview-overlay-link'),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth } });
  check('storefront: header location is a button carrying the store\'s pin, name and label', sf.locAction);
  check('storefront: the About card has a directions row, and the map has a "Get directions" button (not a link out)', sf.aboutRow && sf.mapTap && !sf.googleLinkOnMap);
  const sfGeo = await page.evaluate(() => { const slot = document.getElementById('storeMapPreview'), f = slot.querySelector('.map-preview-frame'); const sb = slot.getBoundingClientRect(), fb = f.getBoundingClientRect(); const cs = getComputedStyle(slot); return { slot: Math.round(sb.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), frame: Math.round(fb.width), inside: fb.right <= sb.right + 1 && fb.left >= sb.left - 1 }; });
  check('storefront @1440: the map fills its card exactly (no white strip, not wider than the card)', sfGeo.frame === sfGeo.slot && sfGeo.inside, JSON.stringify(sfGeo));
  check('storefront @1440: no sideways scrolling', !sf.overflowX);
  for (const [name, sel] of [['header location', '#storeLocation'], ['About row', '.info-row--action[data-nsd-open]'], ['map', '#storeMapPreview .map-preview-tap']]) {
    await page.click(sel);
    await page.waitForSelector('#nsdOverlay', { timeout: 3000 }).catch(() => {});
    const ok = await page.evaluate(() => !!document.getElementById('nsdOverlay') && /to Asia Ivan Store/.test(document.querySelector('.nsd-head-text p')?.textContent || '') && /Mbale, Plot 9 Republic St/.test(document.querySelector('.nsd-points')?.textContent || '') && /Opposite the blue gate/.test(document.querySelector('.nsd-seller-note')?.textContent || ''));
    check(`storefront: tapping the ${name} opens the directions modal for this store, with its address and the seller's notes`, ok);
    await page.keyboard.press('Escape');
    check(`storefront: closing it from the ${name} puts focus back on what was tapped`, await page.evaluate(() => !document.getElementById('nsdOverlay') && !!document.activeElement && document.activeElement.hasAttribute('data-nsd-open')));
  }
  await page.focus('#storeLocation'.replace('#storeLocation', '[data-nsd-open][role="button"]'));
  await page.keyboard.press('Enter');
  check('storefront: the header location also opens with the keyboard (Enter)', !!(await page.$('#nsdOverlay')));
  await page.keyboard.press('Escape');
  check('storefront: nothing opened a new tab or left the page', popups === 0 && new URL(page.url()).pathname === '/asia-ivan-store');
  check('storefront: no page errors', !(page.__errors || []).length, (page.__errors || []).join(' | '));
  await close(page);

  page = await newPage(browser, { url: '/store-detail.html?store=asia-ivan-store', api: storeApi({ ...store, mapCoordinates: null }), viewport: { width: 1280, height: 800 } });
  await page.waitForFunction(() => /Asia Ivan Store/.test(document.getElementById('storeName')?.textContent || ''), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  check('storefront with NO saved pin: no directions anywhere and the map is hidden', await page.evaluate(() => !document.querySelector('[data-nsd-open]') && getComputedStyle(document.getElementById('storeMapPreview')).display === 'none'));
  await close(page);

  // ---- 12. The REAL orders.html: pickup order -> directions on top of the order dialog ----
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: 'u1', userId: 'u1', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const orderStub = { id: 'o1', orderNumber: 'NS-1001', status: 'processing', fulfillmentMethod: 'pickup', createdAt: new Date().toISOString(), total: 25000, subtotal: 25000, deliveryFee: 0, items: [{ id: 'i1', name: 'Chair', quantity: 1, price: 25000, productName: 'Chair' }], paymentMethod: 'cash', store: { id: 's1', name: 'Asia Ivan Store', slug: 'asia-ivan-store', district: 'Mbale', address: 'Plot 9', mapCoordinates: '0.3136,32.5811', detailedDirections: 'Opposite the blue gate' } };
  const ordersApi = ep => {
    if (/^\/orders\/o1/.test(ep)) return { data: orderStub };
    if (ep.startsWith('/orders')) return { data: [], pagination: { page: 1, pages: 1, total: 0 } };
    if (ep.startsWith('/auth/me') || ep.startsWith('/users/me')) return { data: { id: 'u1', name: 'Test Buyer', email: 'b@x.co', role: 'buyer' } };
    return { data: {} };
  };
  page = await newPage(browser, { url: '/orders.html', api: ordersApi, viewport: { width: 1280, height: 800 }, init: (jwt) => { localStorage.setItem('nextastore_token', jwt); localStorage.setItem('nextastore_user', JSON.stringify({ id: 'u1', name: 'Test Buyer', email: 'b@x.co', role: 'buyer' })); }, initArg: jwt });
  await page.waitForFunction(() => typeof OrdersPageManager === 'function', null, { timeout: 8000 });
  await page.evaluate(() => new OrdersPageManager().showDetail('o1'));
  await page.waitForSelector('.order-detail-modal', { timeout: 5000 }).catch(() => {});
  const od = await page.evaluate(() => ({ modal: !!document.querySelector('.order-detail-modal'), link: !!document.querySelector('.order-detail-modal .nsd-link-btn[data-nsd-open]'), tap: !!document.querySelector('.order-detail-modal .map-preview-tap[data-nsd-open]'), url: location.pathname }));
  check('orders: a pickup order shows "Get directions" and a tappable map (not a link out to Google)', od.modal && od.link, JSON.stringify(od));
  if (od.modal) {
    await page.waitForSelector('.order-detail-modal .map-preview-tap', { timeout: 6000 }).catch(() => {});
    for (const [name, sel] of [['"Get directions" button', '.order-detail-modal .nsd-link-btn'], ['map', '.order-detail-modal .map-preview-tap']]) {
      if (!(await page.$(sel))) { check(`orders: the ${name} exists`, false, 'missing'); continue; }
      await page.click(sel);
      await page.waitForSelector('#nsdOverlay', { timeout: 3000 }).catch(() => {});
      const r = await page.evaluate(() => { const p = document.querySelector('.nsd-panel'); if (!p) return { open: false }; const b = p.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + 90); return { open: true, onTop: !!top && !!top.closest('#nsdOverlay'), sub: document.querySelector('.nsd-head-text p')?.textContent, notes: document.querySelector('.nsd-seller-note')?.textContent || '' }; });
      check(`orders: tapping the ${name} opens directions to the store, ABOVE the order dialog`, r.open && r.onTop && /to Asia Ivan Store/.test(r.sub) && /Opposite the blue gate/.test(r.notes), JSON.stringify(r));
      await page.keyboard.press('Escape');
      check(`orders: Escape closes only the directions - the order dialog stays open (${name})`, await page.evaluate(() => !document.getElementById('nsdOverlay') && !!document.querySelector('.order-detail-modal')));
    }
  }
  check('orders: no page errors', !(page.__errors || []).length, (page.__errors || []).join(' | '));
  await close(page);

  // ---- 13. The REAL messages.html: a shared-location card in a chat thread -------------
  const nowIso = new Date().toISOString();
  const locMsg = { id: 'm1', conversationId: 'c1', senderId: 'u2', senderRole: 'seller', type: 'location', body: 'Come here', metadata: { lat: 0.3136, lng: 32.5811, label: 'Asia Ivan Store' }, createdAt: nowIso, readAt: null };
  const conv = { id: 'c1', store: { id: 's1', name: 'Asia Ivan Store', slug: 'asia-ivan-store', logo: null }, buyer: { id: 'u1', name: 'Test Buyer' }, lastMessage: locMsg, unreadCount: 0, updatedAt: nowIso, createdAt: nowIso, messages: [locMsg], pagination: { hasMore: false } };
  const chatApi = ep => {
    if (/^\/messages\/conversations\/c1/.test(ep)) return { data: conv };
    if (ep.startsWith('/messages/conversations')) return { data: [conv], pagination: { page: 1, pages: 1, total: 1, limit: 20 } };
    if (ep.startsWith('/auth/me') || ep.startsWith('/users/me')) return { data: { id: 'u1', name: 'Test Buyer', role: 'buyer' } };
    return { data: {} };
  };
  page = await newPage(browser, { url: '/messages.html', api: chatApi, viewport: { width: 1280, height: 800 }, init: (j) => { localStorage.setItem('nextastore_token', j); localStorage.setItem('nextastore_user', JSON.stringify({ id: 'u1', name: 'Test Buyer', role: 'buyer' })); }, initArg: jwt });
  await page.waitForFunction(() => !!window.messagesManager, null, { timeout: 8000 });
  await page.evaluate(() => window.messagesManager.openConversation('c1'));
  await page.waitForSelector('.message-location-card', { timeout: 5000 }).catch(() => {});
  check('chat: the shared location shows as a card in the thread', !!(await page.$('.message-location-card')));
  await page.waitForSelector('.message-location-card .map-preview-tile', { timeout: 6000 }).catch(() => {});
  const cardGeo = await page.evaluate(() => { const pv = document.querySelector('.message-location-preview'); const f = pv && pv.querySelector('.map-preview-frame'); if (!f) return null; const a = pv.getBoundingClientRect(), b = f.getBoundingClientRect(); return { slot: Math.round(a.width), frame: Math.round(b.width), inside: b.right <= a.right + 1 }; });
  check('chat: the card\'s map thumbnail is drawn and stays inside the card', !!cardGeo && cardGeo.inside, JSON.stringify(cardGeo));
  const before = await page.evaluate(() => window.__geoCalls);
  await page.click('.message-location-card');
  await page.waitForSelector('#nsdOverlay', { timeout: 3000 }).catch(() => {});
  check('chat: tapping the card opens the directions modal for that pin and asks for the route', await page.evaluate(() => !!document.getElementById('nsdOverlay') && /to Asia Ivan Store/.test(document.querySelector('.nsd-head-text p')?.textContent || '')) && (await page.evaluate(() => window.__geoCalls)) > before);
  check('chat: the older plain location preview did not open as well', !(await page.$('#locationPreviewModal, .location-preview-modal')));
  await page.keyboard.press('Escape');
  check('chat: Escape closes it and focus returns to the card', await page.evaluate(() => !document.getElementById('nsdOverlay') && !!document.activeElement && document.activeElement.classList.contains('message-location-card')));
  const g0 = await page.evaluate(() => window.__geoCalls);
  await page.evaluate(() => window.messagesManager.openLocationPreview(0.3136, 32.5811, 'Shared location', { directions: false }));
  await page.waitForSelector('#nsdOverlay', { timeout: 3000 }).catch(() => {});
  check('chat: checking a pin before sending (directions:false) opens the pin only - no location request, no route box', await page.evaluate(() => !!document.getElementById('nsdOverlay') && !document.querySelector('.nsd-summary')) && (await page.evaluate(() => window.__geoCalls)) === g0);
  await page.keyboard.press('Escape');
  check('chat: no page errors', !(page.__errors || []).length, (page.__errors || []).join(' | '));
  await close(page);

  // ---- 14. The REAL dashboard.html: seller order view --------------------------------
  const sellerUser = { id: 'u1', name: 'Test Seller', email: 's@x.co', role: 'seller' };
  const sellerApi = ep => {
    if (/^\/orders\/o1/.test(ep)) return { data: { ...orderStub, buyer: { id: 'b1', name: 'Some Buyer', email: 'b@x.co' } } };
    if (ep.startsWith('/user/me') || ep.startsWith('/auth/me')) return { data: sellerUser };
    if (ep === '/store') return { data: { ...store, ownerId: 'u1' } };
    if (ep.startsWith('/orders')) return { data: [], pagination: { page: 1, pages: 1, total: 0 } };
    return { data: {} };
  };
  page = await newPage(browser, { url: '/dashboard.html', api: sellerApi, viewport: { width: 1280, height: 800 }, init: (j) => { localStorage.setItem('nextastore_token', j); localStorage.setItem('nextastore_user', JSON.stringify({ id: 'u1', name: 'Test Seller', email: 's@x.co', role: 'seller' })); }, initArg: jwt });
  await page.waitForFunction(() => typeof dashboardManager !== 'undefined' && !!dashboardManager, null, { timeout: 8000 }).catch(() => {});
  const haveDash = await page.evaluate(() => typeof dashboardManager !== 'undefined' && !!dashboardManager);
  check('dashboard: the seller dashboard page boots', haveDash);
  if (haveDash) {
    await page.evaluate(() => dashboardManager.showSellerOrder('o1'));
    await page.waitForSelector('.order-detail-modal', { timeout: 5000 }).catch(() => {});
    check('dashboard: a pickup order in the seller view has "Get directions"', !!(await page.$('.order-detail-modal .nsd-link-btn[data-nsd-open]')));
    await page.click('.order-detail-modal .nsd-link-btn').catch(() => {});
    await page.waitForSelector('#nsdOverlay', { timeout: 3000 }).catch(() => {});
    const dr = await page.evaluate(() => { const p = document.querySelector('.nsd-panel'); if (!p) return { open: false }; const b = p.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + 90); return { open: true, onTop: !!top && !!top.closest('#nsdOverlay'), sub: document.querySelector('.nsd-head-text p')?.textContent }; });
    check('dashboard: it opens directions to the store, above the order dialog', dr.open && dr.onTop && /to Asia Ivan Store/.test(dr.sub), JSON.stringify(dr));
    await page.keyboard.press('Escape');
    check('dashboard: Escape closes only the directions - the order dialog stays', await page.evaluate(() => !document.getElementById('nsdOverlay') && !!document.querySelector('.order-detail-modal')));
  }
  await close(page);

  await browser.close();
  out.forEach(x => console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.ok ? '' : '  -> ' + x.d}`));
  const bad = out.filter(x => !x.ok); console.log(`\n${out.length - bad.length}/${out.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
