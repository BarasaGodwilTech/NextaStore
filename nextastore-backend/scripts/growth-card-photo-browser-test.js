const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs'), path = require('path');
const ROOT = require('path').resolve(__dirname, '..', '..');
let pass = 0, fail = 0; const ok = (n, c, d) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (d ? '  ' + d : '')); } };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const html = `<!doctype html><meta charset=utf-8><link rel=stylesheet href="file://${ROOT}/css/growth.css"><body class="gp-body" data-program="crew"><main class="gp-shell"><section class="gp-card"><div id="pick"></div></section><section class="gp-card"><div id="card"></div></section></main>
  <script src="file://${ROOT}/js/growth-qr.js"></script><script src="file://${ROOT}/js/crew-card-photo.js"></script><script src="file://${ROOT}/js/crew-card.js"></script>`;
  fs.writeFileSync('/tmp/h.html', html);
  await page.goto('file:///tmp/h.html');
  // ---- rating on synthetic pictures
  const r = await page.evaluate(async () => {
    const mk = (w, h, draw, type = 'image/jpeg') => new Promise((res) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); c.toBlob((b) => res(new File([b], 'p.jpg', { type })), type, 0.92); });
    // a "portrait": plain wall, a head and shoulders with detail (eyes, hair edge, stripes on the shirt)
    const portrait = (x, w, h, light = 150) => { x.fillStyle = `rgb(${light},${light},${light - 5})`; x.fillRect(0, 0, w, h); x.fillStyle = '#2b2b2b'; x.beginPath(); x.ellipse(w / 2, h * .4, w * .2, h * .2, 0, 0, 7); x.fill(); x.fillStyle = `rgb(${light + 40},${light + 5},${light - 30})`; x.beginPath(); x.ellipse(w / 2, h * .42, w * .17, h * .17, 0, 0, 7); x.fill(); x.fillStyle = '#111'; for (const dx of [-.07, .07]) { x.beginPath(); x.ellipse(w / 2 + dx * w, h * .39, w * .02, h * .012, 0, 0, 7); x.fill(); } x.fillRect(w * .47, h * .5, w * .06, h * .01); for (let i = 0; i < 12; i++) { x.fillStyle = i % 2 ? '#1c3d7a' : '#e8e8e8'; x.fillRect(w * .2, h * (.7 + i * .02), w * .6, h * .01); } };
    const out = {};
    const stat = async (name, file) => { const s = await NextaCardPhoto.analyse(file); out[name] = { s, r: NextaCardPhoto.rate(s) }; };
    await stat('good', await mk(900, 1200, (x, w, h) => portrait(x, w, h)));
    await stat('tiny', await mk(200, 260, (x, w, h) => portrait(x, w, h)));
    await stat('dark', await mk(900, 1200, (x, w, h) => { portrait(x, w, h, 12); x.fillStyle = 'rgba(0,0,0,.8)'; x.fillRect(0, 0, w, h); }));
    await stat('bright', await mk(900, 1200, (x, w, h) => { portrait(x, w, h, 250); x.fillStyle = 'rgba(255,255,255,.8)'; x.fillRect(0, 0, w, h); }));
    await stat('blur', await mk(900, 1200, (x, w, h) => { const t = document.createElement('canvas'); t.width = w; t.height = h; portrait(t.getContext('2d'), w, h); x.filter = 'blur(30px)'; x.drawImage(t, 0, 0); }));
    await stat('busy', await mk(900, 1200, (x, w, h) => { portrait(x, w, h); for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${i * 37 % 360},70%,${30 + i % 50}%)`; x.fillRect((i * 97) % w, (i * 53) % 220 + (i % 3 ? 0 : h - 240), 60, 60); } }));
    return out;
  });
  const row = (k) => `${k}: sharp=${r[k].s.sharp.toFixed(1)} mean=${r[k].s.mean.toFixed(0)} border=${r[k].s.border.toFixed(1)} -> ${r[k].r.level} ${r[k].r.score}`;
  Object.keys(r).forEach((k) => console.log('   ' + row(k)));
  ok('a clear portrait is not blocked', !r.good.r.blocked, row('good'));
  ok('a tiny photo is blocked', r.tiny.r.blocked && r.tiny.r.checks.find((c) => c.key === 'size').state === 'bad');
  ok('a very dark photo is blocked', r.dark.r.blocked && r.dark.r.checks.find((c) => c.key === 'light').state === 'bad', row('dark'));
  ok('a washed-out photo is blocked', r.bright.r.blocked && r.bright.r.checks.find((c) => c.key === 'light').state === 'bad', row('bright'));
  ok('a heavily blurred photo is blocked', r.blur.r.blocked && r.blur.r.checks.find((c) => c.key === 'sharp').state === 'bad', row('blur'));
  ok('a busy background only warns, never blocks', !r.busy.r.blocked && r.busy.r.checks.find((c) => c.key === 'background').state === 'warn', row('busy'));
  ok('no face rows when the browser has no face detector', r.good.s.face === null ? !r.good.r.checks.some((c) => c.key === 'face') : true);
  // face-detector branch (pure rating)
  const f = await page.evaluate(() => { const base = { w: 900, h: 1200, sharp: 200, mean: 140, border: 8 }; const R = (face) => NextaCardPhoto.rate({ ...base, face }); return { none: R({ found: false }), far: R({ found: true, width: .08, cx: .5 }), near: R({ found: true, width: .8, cx: .5 }), off: R({ found: true, width: .3, cx: .85 }), good: R({ found: true, width: .3, cx: .5 }) }; });
  ok('no face found = advice, not a block', !f.none.blocked && f.none.checks.some((c) => c.key === 'face' && c.state === 'warn'));
  ok('face too far / too close / off-centre each warn', ['far', 'near', 'off'].every((k) => f[k].checks.find((c) => c.key === 'framing').state === 'warn'));
  ok('a well-framed face scores 100', f.good.score === 100 && f.good.level === 'good');
  // prepare(): 3:4 output
  const prep = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 1600; c.height = 900; c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, 1600, 900); const f = await new Promise((r) => c.toBlob((b) => r(new File([b], 'w.jpg', { type: 'image/jpeg' })), 'image/jpeg')); const u = await NextaCardPhoto.prepare(f, { face: null }); const im = new Image(); await new Promise((r) => { im.onload = r; im.src = u; }); return { w: im.naturalWidth, h: im.naturalHeight, jpeg: u.startsWith('data:image/jpeg') }; });
  ok('prepare() turns a landscape photo into a 720x960 JPEG', prep.w === 720 && prep.h === 960 && prep.jpeg, JSON.stringify(prep));
  // ---- the picker UI
  await page.evaluate(() => { window.__pick = NextaCardPhoto.mount(document.getElementById('pick'), {}); });
  const goodFile = '/tmp/good.jpg';
  const buf = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 1200; const x = c.getContext('2d'); x.fillStyle = '#999'; x.fillRect(0, 0, 900, 1200); x.fillStyle = '#222'; x.beginPath(); x.ellipse(450, 480, 180, 240, 0, 0, 7); x.fill(); for (let i = 0; i < 20; i++) { x.fillStyle = i % 2 ? '#fff' : '#123'; x.fillRect(200, 800 + i * 18, 500, 9); } return c.toDataURL('image/jpeg', .9).split(',')[1]; });
  fs.writeFileSync(goodFile, Buffer.from(buf, 'base64'));
  await page.setInputFiles('#gpCardPhotoIn', goodFile);
  await page.waitForSelector('#gpPhotoRate .gp-photo-score', { timeout: 5000 });
  ok('picking a photo shows the picture, a score bar and the checks', (await page.locator('#gpPhotoFrame img').count()) === 1 && (await page.locator('#gpPhotoRate li').count()) >= 4);
  ok('the picker has no sideways scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/picker.png', fullPage: true });
  // ---- the card
  const photoUrl = await page.evaluate(async () => { const f = new File([await (await fetch('data:image/jpeg;base64,' + ''+ '')).blob().catch(() => new Blob())], 'x'); return 1; });
  const draws = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 720; c.height = 960; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, 960); g.addColorStop(0, '#d9c3a5'); g.addColorStop(1, '#8a6f55'); x.fillStyle = g; x.fillRect(0, 0, 720, 960); x.fillStyle = '#3a2a20'; x.beginPath(); x.ellipse(360, 400, 150, 190, 0, 0, 7); x.fill(); x.fillStyle = '#2d5b8a'; x.beginPath(); x.ellipse(360, 900, 260, 200, 0, 0, 7); x.fill();
    const im = new Image(); await new Promise((r) => { im.onload = r; im.src = c.toDataURL(); });
    const base = { name: 'Nakato Grace Namukasa', rankIndex: 2, rankLabel: 'Trailblazer', areas: ['Kampala', 'Wakiso', 'Mukono'], code: 'CREW-7K3QX', link: 'https://nextastores.com/invite?ref=CREW-7K3QX', host: 'nextastores.com', since: 'Oct 2026', photo: im, needed: 5 };
    const out = {};
    for (const [k, d, side] of [['front', { ...base, unlocked: true, leads: 5 }, 'front'], ['back', { ...base, unlocked: true, leads: 5 }, 'back'], ['locked', { ...base, unlocked: false, leads: 2 }, 'front'], ['lockedNoPhoto', { ...base, photo: null, unlocked: false, leads: 0 }, 'front']]) {
      const cv = NextaCrewCard.render(document.createElement('canvas'), d, { side, scale: 1 }); out[k] = cv.toDataURL('image/png');
      // transparent corner check: the rounded corner pixel must be transparent, the centre opaque
      const px = cv.getContext('2d').getImageData(2, 2, 1, 1).data[3], mid = cv.getContext('2d').getImageData(300, 470, 1, 1).data[3]; out[k + 'Alpha'] = [px, mid];
    }
    const sh = NextaCrewCard.sheet({ ...base, unlocked: true, leads: 5 }, 1); out.sheet = [sh.width, sh.height];
    const shl = NextaCrewCard.sheet({ ...base, unlocked: false, leads: 2 }, 1); out.sheetLocked = [shl.width, shl.height];
    out.long = (() => { const cv = NextaCrewCard.render(document.createElement('canvas'), { ...base, name: 'Namukasa Nakato Grace Bernadette Kyomuhendo-Atwine', unlocked: true, leads: 5, areas: ['Kampala', 'Wakiso', 'Mukono'] }, { side: 'front', scale: 1 }); return cv.toDataURL('image/png'); })();
    return out;
  });
  for (const k of ['front', 'back', 'locked', 'lockedNoPhoto', 'long']) fs.writeFileSync(`/tmp/card-${k}.png`, Buffer.from(draws[k].split(',')[1], 'base64'));
  ok('the card corners are transparent and the body is opaque (no hole punched in it)', draws.frontAlpha[0] === 0 && draws.frontAlpha[1] === 255 && draws.lockedAlpha[1] === 255, JSON.stringify([draws.frontAlpha, draws.lockedAlpha]));
  ok('the saved sheet is front + back side by side; a locked card saves only its front', draws.sheet[0] === 600 * 2 + 40 && draws.sheet[1] === 940 && draws.sheetLocked[0] === 600, JSON.stringify([draws.sheet, draws.sheetLocked]));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
