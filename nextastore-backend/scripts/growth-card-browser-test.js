// Real Chromium + the REAL growth backend (in-memory database) served over HTTP, with the project's real pages.
const http = require('http'), fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = require('path').resolve(__dirname, '..', '..'), BE = ROOT + '/nextastore-backend';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { createGrowth } = require(BE + '/src/growth/index.js'); const { createMemoryPrisma } = require(BE + '/scripts/lib/memory-prisma');
let nowMs = new Date('2026-11-02T07:00:00Z').getTime(); const clock = () => new Date(nowMs), HOUR = 3600000;
const prisma = createMemoryPrisma(clock), db = prisma._db, files = {}, notes = [];
const growth = createGrowth({ prisma, now: clock, createNotification: async (x) => { notes.push(x); }, recordAdminAudit: async () => {}, savePrivateImage: async (d, folder) => { const k = `${folder}/${Object.keys(files).length + 1}.jpg`; files[k] = d; return k; } });
let pass = 0, fail = 0; const ok = (n, c, d) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (d ? '  ' + d : '')); } };
const mk = (id, name) => { const u = { id, name, email: `${id}@gmail.test`, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock() }; db.user.push(u); return u; };
const routes = (() => { const o = Module._load; Module._load = function (r, ...a) { return r === 'express' ? { Router: () => { const x = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { x[m] = (p, ...h) => { x.routes[`${m} ${p}`] = h; return x; }; }); return x; } } : o.call(this, r, ...a); };
  try { return growth.routes({ requireAuth: (q, s, n) => n(), requireAdminPermission: () => (q, s, n) => n(), sendKyc: (req, res, key) => { const d = files[key] || ''; const [, b64] = d.split(','); res.setHeader('Content-Type', 'image/jpeg'); res.end(Buffer.from(b64 || '', 'base64')); } }); } finally { Module._load = o; } })();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const tok = (req.headers.authorization || '').replace('Bearer ', ''), uid = tok.split('.')[2], user = db.user.find((u) => u.id === uid);
    let body = ''; for await (const c of req) body += c;
    const send = (st, obj) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const p = url.pathname.replace(/^\/api/, '');
    if (!p.startsWith('/growth')) { if (p === '/user/me') return send(200, { user: user || null }); return send(404, { message: 'not mocked' }); }
    if (!user && !p.startsWith('/growth/rules')) return send(401, { message: 'Sign in', code: 'AUTH_REQUIRED' });
    const sub = p.replace(/^\/growth/, '');
    for (const [key, chain] of Object.entries(routes.partner.routes)) {
      const [m, pattern] = key.split(' '); if (m !== req.method.toLowerCase()) continue;
      const names = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'); const hit = re.exec(sub); if (!hit) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
      const r = { _h: {}, setHeader(k, v) { this._h[k] = v; }, status(s) { this._s = s; return this; }, json: (b) => send(r._s || 200, b), end: (b) => { res.writeHead(r._s || 200, r._h); res.end(b); } };
      try { return await chain[chain.length - 1]({ user, params, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : {}, headers: req.headers, ip: '10.0.0.9' }, r, (e) => send(e.status || 500, { message: e.message, code: e.code })); } catch (e) { return send(e.status || 500, { message: e.message, code: e.code }); }
    }
    return send(404, { message: 'no route ' + req.method + ' ' + sub });
  }
  let f = path.join(ROOT, decodeURIComponent(url.pathname)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (fs.existsSync(f + '.html')) f += '.html'; else { res.writeHead(404); return res.end('nf'); } }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const jpeg = (page, kind) => page.evaluate(async (kind) => { const c = document.createElement('canvas'); c.width = 900; c.height = 1200; const x = c.getContext('2d'); const draw = (x) => { x.fillStyle = '#9a9a96'; x.fillRect(0, 0, 900, 1200); x.fillStyle = '#d8b08c'; x.beginPath(); x.ellipse(450, 470, 190, 250, 0, 0, 7); x.fill(); x.fillStyle = '#222'; for (const d of [-70, 70]) { x.beginPath(); x.ellipse(450 + d, 440, 20, 12, 0, 0, 7); x.fill(); } x.fillRect(420, 560, 60, 8); for (let i = 0; i < 24; i++) { x.fillStyle = i % 2 ? '#fff' : '#123a7a'; x.fillRect(190, 800 + i * 16, 520, 8); } };
  if (kind === 'blur') { const t = document.createElement('canvas'); t.width = 900; t.height = 1200; draw(t.getContext('2d')); x.filter = 'blur(30px)'; x.drawImage(t, 0, 0); } else draw(x); return c.toDataURL('image/jpeg', .9).split(',')[1]; }, kind);
(async () => {
  await new Promise((r) => server.listen(4000, r)); const BASE = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch(); const errs = [];
  const open = async (userId, urlPath, viewport = { width: 390, height: 844 }) => {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true }); const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(userId + ': ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|favicon|fonts|cdnjs|unpkg/.test(m.text())) errs.push(userId + ' console: ' + m.text()); });
    await page.addInitScript((t) => { try { localStorage.setItem('nextastore_token', t); } catch (e) {} window.L = {}; window.NextaStoreMapPicker = { districtCoordinates: {}, open: (o) => o.onSave({ district: 'kampala', lat: 0.3136, lng: 32.5811, placeName: 'Owino Market' }) }; window.NextaStoreMapPreview = { render: (el) => { el.innerHTML = '<div style="height:60px">map</div>'; } }; }, `a.b.${userId}`);
    await page.route(/cdnjs|unpkg|fonts\.g/, (r) => r.abort());
    await page.goto(BASE + urlPath); return page;
  };
  // ================= A. applying
  const ann = mk('u_ann', 'Ann Applicant');
  let page = await open('u_ann', '/crew-apply.html');
  await page.waitForSelector('#caForm', { timeout: 10000 }).catch(async (e) => { console.log('URL', page.url()); console.log((await page.innerText('body')).slice(0, 600)); console.log(errs.join('\n')); throw e; });
  ok('the Crew application has a \"Passport photo\" step after \"Your ID\"', (await page.locator('#caSegs li').count()) === 6, String(await page.locator('#caSegs li').count()));
  await page.fill('#caName', 'Ann Applicant'); await page.fill('#caPhone', '0753123456'); await page.click('#caNext');
  await page.fill('#caIdNo', 'CM1234567890AB');
  const good = Buffer.from(await jpeg(page, 'good'), 'base64'), blur = Buffer.from(await jpeg(page, 'blur'), 'base64');
  await page.setInputFiles('#caIdFront', { name: 'front.jpg', mimeType: 'image/jpeg', buffer: good }); await page.setInputFiles('#caIdBack', { name: 'back.jpg', mimeType: 'image/jpeg', buffer: good });
  await page.click('#caNext');
  ok('the photo step is showing, with the guide', (await page.locator('.gp-photoguide li').count()) === 4);
  await page.click('#caNext');
  ok('Next without a photo is refused with a plain message', /photo/i.test(await page.textContent('#caPhotoStepErr')), await page.textContent('#caPhotoStepErr'));
  await page.setInputFiles('#gpCardPhotoIn', { name: 'blur.jpg', mimeType: 'image/jpeg', buffer: blur });
  await page.waitForSelector('.gp-photo-score'); await page.click('#caNext');
  ok('a blurred photo shows \"Please take it again\" and cannot be used', (await page.textContent('.gp-photo-score')).includes('Please take it again') && (await page.textContent('#caPhotoStepErr')).includes('will not work on a card'));
  await page.setInputFiles('#gpCardPhotoIn', { name: 'ok.jpg', mimeType: 'image/jpeg', buffer: good });
  await page.waitForFunction(() => /Great photo|Good enough/.test(document.querySelector('.gp-photo-score')?.textContent || ''));
  const rateText = await page.textContent('#gpPhotoRate');
  ok('a clear photo is rated and can continue', !(/Please take it again/.test(rateText)));
  await page.screenshot({ path: '/tmp/e2e-photo-step.png', fullPage: true });
  await page.click('#caNext');
  await page.waitForSelector('#caAreaList li', { timeout: 5000 });
  ok('arriving at Work area opens the map by itself and the chosen area shows its place name', (await page.textContent('#caAreaList li')).includes('Owino Market') && !(await page.textContent('#caAreaList li')).includes('Pin placed'), await page.textContent('#caAreaList'));
  await page.click('#caNext'); await page.click('#caNext');
  ok('the review shows the passport photo', (await page.textContent('#caSum')).includes('Passport photo') && /Added \(/.test(await page.textContent('#caSum')));
  await page.check('#caTerms'); await page.click('#caNext');
  await page.waitForSelector('.ca-done', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const annP = db.growthPartner.find((p) => p.userId === 'u_ann');
  ok('the application is saved as pending with the card photo stored privately', !!annP && annP.status === 'applied' && /^growth-card\/u_ann\//.test(annP.cardPhotoUrl || ''), JSON.stringify(annP && { s: annP.status, c: annP.cardPhotoUrl }));
  const sent = files[annP.cardPhotoUrl] || '';
  const dim = await page.evaluate(async (d) => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = d; }); return [im.naturalWidth, im.naturalHeight]; }, sent);
  ok('what was sent is a 720x960 JPEG head-and-shoulders crop, not the raw upload', sent.startsWith('data:image/jpeg') && dim[0] === 720 && dim[1] === 960, JSON.stringify(dim));
  ok('the ID sheet is still stored separately', /^growth-kyc\//.test(annP.kycFileUrl || ''));
  const bare = await page.evaluate(async (b) => { const r = await fetch(b + '/api/growth/crew/apply', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('nextastore_token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0753999888', territories: ['kampala'], agreedTerms: true, kycImage: 'data:image/jpeg;base64,AAAA' }) }); return [r.status, (await r.json()).code]; }, BASE);
  ok('the server refuses an application with no card photo, even when the form is bypassed', bare[0] === 400 && bare[1] === 'CARD_PHOTO_REQUIRED', JSON.stringify(bare));
  await page.context().close();
  // ================= B. approved, locked
  const bea = mk('u_bea', 'Bea Member'); const bp = await growth.partners.applyCrew(bea, { phone: '0753200200', territories: ['kampala', 'wakiso'], kycFileUrl: 'k', cardPhotoUrl: 'private/old.jpg', agreedTerms: true }); await growth.admin.approveCrew('admin1', bp.id); await prisma.growthPartner.update({ where: { id: bp.id }, data: { cardPhotoUrl: null } });   // an older record with no photo
  for (let i = 1; i <= 2; i++) { nowMs += 3 * HOUR; await growth.leads.logLead(bea, { business: `Shop ${i}`, contactName: 'O', phone: `0772${100000 + i * 913}`, district: 'kampala' }); }
  page = await open('u_bea', '/crew.html');
  await page.waitForSelector('#gpIdCanvas', { timeout: 10000 });
  ok('an approved member below the target sees a locked card with progress', (await page.textContent('#gpIdCardH')).includes('locked') && (await page.textContent('#gpIdLockNote')).includes('Add your photo'));
  ok('a locked card offers Change photo but no Save or Show back', (await page.locator('#gpIdChange').count()) === 1 && (await page.locator('#gpIdSave').count()) === 0 && (await page.locator('#gpIdFlip').count()) === 0);
  await page.click('#gpIdChange'); await page.setInputFiles('#gpCardPhotoIn', { name: 'bea.jpg', mimeType: 'image/jpeg', buffer: good });
  await page.waitForFunction(() => !document.querySelector('#gpIdUse')?.disabled);
  await page.click('#gpIdUse'); await page.waitForSelector('#gpIdChangeBox[hidden]', { state: 'attached' });
  await new Promise((r) => setTimeout(r, 500));
  const beaP = db.growthPartner.find((p) => p.userId === 'u_bea');
  ok('a member with no photo can add one while the card is locked (PUT /growth/card/photo)', /^growth-card\/u_bea\//.test(beaP.cardPhotoUrl || ''));
  ok('the note now reads "2 of 5 businesses"', (await page.textContent('#gpIdLockNote')).includes('2 of 5'));
  const canvasPx = await page.evaluate(() => { const c = document.getElementById('gpIdCanvas'); return [c.width, c.height]; });
  ok('the card canvas is 600:940', Math.abs(canvasPx[0] / canvasPx[1] - 600 / 940) < 0.01, JSON.stringify(canvasPx));
  await page.locator('#gpIdCardSection').scrollIntoViewIfNeeded(); await page.screenshot({ path: '/tmp/e2e-locked.png' });
  ok('no sideways scroll on the dashboard at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // photo is private: fetching without login is refused, with login works
  const noAuth = await page.evaluate(async (b) => (await fetch(b + '/api/growth/card/photo')).status, BASE);
  const withAuth = await page.evaluate(async (b) => { const r = await fetch(b + '/api/growth/card/photo', { headers: { Authorization: 'Bearer ' + localStorage.getItem('nextastore_token') } }); return [r.status, r.headers.get('content-type')]; }, BASE);
  ok('the photo needs a login and then comes back as an image', noAuth === 401 && withAuth[0] === 200 && withAuth[1] === 'image/jpeg', JSON.stringify([noAuth, withAuth]));
  await page.context().close();
  // ================= C. unlocked
  for (let i = 3; i <= 5; i++) { nowMs += 3 * HOUR; await growth.leads.logLead(bea, { business: `Shop ${i}`, contactName: 'O', phone: `0772${100000 + i * 913}`, district: 'kampala' }); }
  page = await open('u_bea', '/crew.html');
  await page.waitForSelector('#gpIdSave', { timeout: 10000 });
  ok('at 5 businesses the card is unlocked: Save and Show back appear, Change photo is gone', (await page.textContent('#gpIdCardH')) === 'Your Crew ID card' && (await page.locator('#gpIdFlip').count()) === 1 && (await page.locator('#gpIdChange').count()) === 0);
  await page.waitForTimeout(800);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gpIdSave')]);
  const saved = '/tmp/saved-card.png'; await dl.saveAs(saved);
  const sz = await page.evaluate(async (b64) => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); return [im.naturalWidth, im.naturalHeight]; }, fs.readFileSync(saved).toString('base64'));
  ok('Save gives a PNG named for the code, with front and back side by side at 2x', /^nextastore-crew-card-crew-.*\.png$/.test(dl.suggestedFilename()) && sz[0] === 2480 && sz[1] === 1880, dl.suggestedFilename() + ' ' + sz);
  await page.click('#gpIdFlip'); ok('Show back flips the button to "Show front"', (await page.textContent('#gpIdFlip')).includes('Show front') && (await page.getAttribute('#gpIdFlip', 'aria-pressed')) === 'true');
  await page.locator('#gpIdCardSection').scrollIntoViewIfNeeded(); await page.screenshot({ path: '/tmp/e2e-unlocked-back.png' });
  await page.click('#gpIdFlip');
  const putAfter = await page.evaluate(async (b) => (await fetch(b + '/api/growth/card/photo', { method: 'PUT', headers: { Authorization: 'Bearer ' + localStorage.getItem('nextastore_token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ photo: 'data:image/jpeg;base64,AAAA' }) })).status, BASE);
  ok('the server refuses a photo change once the card is released', putAfter === 403, String(putAfter));
  await page.context().close();
  // desktop layout
  page = await open('u_bea', '/crew.html', { width: 1280, height: 900 }); await page.waitForSelector('#gpIdSave'); await page.waitForTimeout(600);
  const lay = await page.evaluate(() => { const s = document.querySelector('.gp-idcard-stage').getBoundingClientRect(), t = document.querySelector('.gp-idcard-side').getBoundingClientRect(); return { w: s.width, sideBySide: t.left >= s.right - 1 }; });
  ok('on a desktop the card sits beside its buttons, 300px wide', lay.sideBySide && Math.round(lay.w) === 300, JSON.stringify(lay));
  await page.context().close();
  ok('no page errors in any of the runs', errs.length === 0, errs.join(' | '));
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
