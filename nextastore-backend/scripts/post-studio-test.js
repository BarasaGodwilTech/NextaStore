#!/usr/bin/env node
'use strict';
/*
 * WIP 121: tests for the Product posts studio's engines (no browser needed).
 *   Part A (always runs): the quality gate's rules, and a contrast sweep of the post palettes over hundreds of store colours.
 *   Part B (runs if the optional "canvas" package is installed: npm i -D canvas): the background remover and the photo
 *          checks on synthetic photos (clean, tinted wall, cluttered, white-on-white, tiny, blurry, dark).
 *   node scripts/post-studio-test.js
 */
const path = require('path');
const JS = path.resolve(__dirname, '..', '..', 'js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };

const pending = [];      // async checks that must finish before the summary
let canvasPkg = null; try { canvasPkg = require('canvas'); } catch (e) { /* optional */ }
// node-canvas rejects the CSS keyword -apple-system in font lists (browsers accept it): strip it in tests only
function mk(w, h) {
    const c = canvasPkg.createCanvas(w || 10, h || 10), gc = c.getContext.bind(c);
    c.getContext = (t) => { const ctx = gc(t); if (!ctx.__p) { let pr = Object.getPrototypeOf(ctx), d; while (pr && !(d = Object.getOwnPropertyDescriptor(pr, 'font'))) pr = Object.getPrototypeOf(pr); if (d) Object.defineProperty(ctx, 'font', { get() { return d.get.call(ctx); }, set(v) { d.set.call(ctx, String(v).replace(/-apple-system,\s*/, '')); } }); ctx.__p = 1; } return ctx; };
    return c;
}
if (canvasPkg) { global.document = { createElement: () => mk(10, 10) }; global.Image = canvasPkg.Image; }
require(path.join(JS, 'growth-qr.js')); require(path.join(JS, 'brand-kit.js'));
const Cut = require(path.join(JS, 'nexta-cutout.js')), Q = require(path.join(JS, 'nexta-quality.js')), Posts = require(path.join(JS, 'brand-kit-posts.js'));
if (canvasPkg) { Cut.env.createCanvas = mk; Q.env.createCanvas = mk; }

// ---- Part A -------------------------------------------------------------------------------------------------------------
const good = { sharp: 60, mean: 150, spread: 120, w: 1200, h: 1200 };
const ev = (style, p, rep, store) => Q.evaluate({ style, products: [Object.assign({ name: 'Soap', price: 5000, photo: good, mode: 'photo' }, p)], store: store || { hasLogo: true, logoPx: 400, published: true }, report: rep });
const ids = (r) => r.items.map((i) => i.id);
ok('a good post is ready', ev('spotlight', {}).status === 'ready');
ok('blurry photo blocks the download', (() => { const r = ev('spotlight', { photo: Object.assign({}, good, { sharp: 15 }) }); return r.status === 'blocked' && !r.canDownload && ids(r).includes('photo_blurry'); })());
ok('a slightly soft photo only warns', (() => { const r = ev('spotlight', { photo: Object.assign({}, good, { sharp: 30 }) }); return r.status === 'fix' && r.canDownload; })());
ok('a very dark photo blocks', ids(ev('spotlight', { photo: Object.assign({}, good, { mean: 40 }) })).includes('photo_dark'));
ok('a photo stretched 2x blocks', ev('spotlight', {}, { upscale: [2] }).status === 'blocked');
ok('a photo stretched 1.4x warns', ev('spotlight', {}, { upscale: [1.4] }).status === 'fix');
ok('missing photo blocks', ev('spotlight', { photo: null }).status === 'blocked');
ok('missing name blocks', ev('spotlight', { name: '' }).status === 'blocked');
ok('Deal without a discount blocks', ids(ev('deal', {})).includes('deal_no_discount'));
ok('Deal with a real discount is ready', ev('deal', { originalPrice: 8000 }).status === 'ready');
ok('a 99% discount is questioned', ids(ev('deal', { price: 100, originalPrice: 10000 })).includes('deal_suspicious'));
ok('no price warns on Spotlight, blocks on Deal', ev('spotlight', { price: 0 }).status === 'fix' && ev('deal', { price: 0 }).status === 'blocked');
ok('a collection of one product blocks', Q.evaluate({ style: 'collection', products: [{ name: 'A', price: 1, photo: good }], store: {} }).status === 'blocked');
ok('cut-off text and tiny text warn', (() => { const r = ev('spotlight', {}, { truncated: ['name'], shrunk: [{ label: 'The price', to: 20, min: 30 }] }); return ids(r).includes('text_cut') && ids(r).includes('text_small'); })());
ok('unreadable text blocks', ev('spotlight', {}, { contrast: 2.5 }).status === 'blocked');
ok('missing logo and an unpublished store warn but do not block', (() => { const r = ev('spotlight', {}, null, { hasLogo: false, published: false }); return r.status === 'fix' && r.canDownload; })());
ok('a cutout that fell back is explained, not punished', (() => { const r = ev('spotlight', { mode: 'cutout', cutoutFellBack: true, cutout: { reasons: ['cluttered_background'], verdict: 'poor' } }); return r.status === 'ready' && ids(r).includes('cutout_fallback'); })());

// the "Updating..." chip that never went away: .pm-busy sets display, which beats the hidden attribute unless overridden
{
    const css = require('fs').readFileSync(path.join(JS, '..', 'css', 'post-studio.css'), 'utf8');
    ok('the stylesheet makes the hidden attribute win over display rules in the studio', /\.pm-busy\[hidden\]\s*\{\s*display:\s*none/.test(css) && /#pmPostsPanel \[hidden\][^{]*\{\s*display:\s*none\s*!important/.test(css));
    const promote = require('fs').readFileSync(path.join(JS, '..', 'css', 'promote.css'), 'utf8');
    ok('(why: promote.css gives .pm-busy a display value of its own)', /\.pm-busy\s*\{[^}]*display:\s*inline-flex/.test(promote));
}

// Settings: the store form was capped at 700px on a PC; make sure the wide layout stays in place
{
    const manage = require('fs').readFileSync(path.join(JS, '..', 'css', 'dashboard-manage.css'), 'utf8');
    ok('the store settings form is no longer capped at 700px, and uses two columns on a desktop', /#settingsSection \.settings-form\s*\{\s*max-width:\s*none/.test(manage) && /@media \(min-width: 1100px\)[\s\S]*#storeSettingsForm\s*\{[^}]*grid-template-columns:\s*repeat\(2/.test(manage));
}

// long names: per-design limits split a long name into a headline and a details line
{
    const sp = Posts._splitName;
    const a = sp('Samsung Galaxy A06 - 6.7" 4GB RAM 64GB ROM 50MP 5000mAh - Black', 46, 64);
    ok('a long phone name becomes a headline and a details line', a.title === 'Samsung Galaxy A06' && a.sub === '6.7" 4GB RAM 64GB ROM 50MP 5000mAh \u00B7 Black' && !a.titleCut && !a.subCut, a);
    const b = sp('Fresh Aloe Vera Drink', 46, 64); ok('a short name is left alone', b.title === 'Fresh Aloe Vera Drink' && b.sub === '' && !b.titleCut);
    const c = sp('Extraordinarily Long Handmade Traditional Ugandan Barkcloth Wall Hanging Decoration', 34, 0);
    ok('an over-long headline is cut at a word with an ellipsis', c.titleCut && c.title.length <= 34 && /\u2026$/.test(c.title) && !/\s\u2026$/.test(c.title), c);
    const d = sp('Samsung Galaxy A06 - 6.7" 4GB RAM - Black', 40, 0); ok('a design with no room for details drops them without calling it an error', d.sub === '' && !d.subCut && !d.titleCut, d);
    const e = sp('Mug - ' + 'details '.repeat(20), 40, 30); ok('very long details are trimmed and flagged', e.subCut && e.sub.length <= 30, e);
    const f = sp('  Soap,   rose  and  honey ', 40, 40); ok('spaces are tidied and a comma starts the details', f.title === 'Soap' && f.sub === 'rose  and  honey'.replace(/\s+/g, ' '), f);
}
// photos that will not load are explained, not reported as "no photo"
ok('a photo that failed to load blocks with a clear reason', (() => { const r = ev('spotlight', { photo: null, photoFailed: true }); return r.status === 'blocked' && ids(r).includes('photo_failed') && !ids(r).includes('photo_missing'); })());
ok('a logo or banner that failed to load warns but does not block', (() => { const r = ev('spotlight', {}, null, { hasLogo: true, logoPx: 300, published: true, logoFailed: true, bannerFailed: true }); return r.status === 'fix' && r.canDownload && ids(r).includes('logo_failed') && ids(r).includes('banner_failed'); })());
ok('a shortened name is only a note, never a warning', (() => { const r = ev('spotlight', {}, { shortened: ['name'] }); return r.status === 'ready' && ids(r).includes('name_shortened'); })());

// the shared image loader: direct first, then our image route, never forever
{
    const realImage = global.Image, realApp = global.app, calls = [];
    class Fake { set src(u) { calls.push([this.crossOrigin || '', u]); setTimeout(() => { if (this.crossOrigin && !/media\/proxy/.test(u) && /^https:\/\/r2\./.test(u)) this.onerror && this.onerror(); else this.onload && this.onload(); }, 0); } }
    global.Image = Fake; global.app = { apiBaseUrl: 'http://api.test/api/' };
    const load = global.NextaBrandKit.helpers.loadImageSafe;
    pending.push((async () => {
        const viaProxy = await load('https://r2.test/photos/a.png');
        ok('an image the browser will not read directly is fetched through /api/media/proxy', !!viaProxy && /^http:\/\/api\.test\/api\/media\/proxy\?u=https%3A%2F%2Fr2\.test%2Fphotos%2Fa\.png$/.test(calls[calls.length - 1][1]), calls);
        const direct = await load('https://cdn.test/ok.png'); ok('an image that allows CORS is loaded directly', !!direct && !/proxy/.test(calls[calls.length - 1][1]));
        const data = await load('data:image/png;base64,AAAA'); ok('a data: image never goes near the proxy', !!data && !/proxy/.test(calls[calls.length - 1][1]));
        global.app = undefined; const noApi = await load('https://r2.test/photos/b.png'); ok('without an API address there is no proxy, and the result is simply null', noApi === null);
        global.Image = realImage; global.app = realApp;
    })());
}

let worst = 99, below = 0, n = 0, seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const colors = ['#00B074', '#FFFFFF', '#000000', '#FFD700', '#FF8C00', '#D9534F', '#236B82', '#F5F5DC', '#7FFFD4', '#800080', '#808080'];
for (let i = 0; i < 300; i++) colors.push('#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0'));
for (const c of colors) for (const mood of ['deep', 'light', 'brand']) {
    const P = Posts.palette(c, mood); n++;
    for (const [a, b] of [[P.text, P.bg1], [P.text, P.bg2], [P.accent, P.bg1], [P.accentText, P.accent], [P.brandOnCard, '#FFFFFF']]) { const r = Q.contrastRatio(a, b); worst = Math.min(worst, r); if (r < 4.4) below++; }
}
ok(`post palettes keep text readable (4.4:1 or better) for ${n} colour and mood combinations`, below === 0, { worst, below });

// ---- Part B -------------------------------------------------------------------------------------------------------------
if (!canvasPkg) console.log('SKIP  background remover and photo checks (install the optional "canvas" package to run them)');
else (async () => {
    const W = 600, H = 600;
    const scene = (bg, draw, noise) => { const c = mk(W, H), x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]); x.fillStyle = g; x.fillRect(0, 0, W, H); draw(x); if (noise) { const d = x.getImageData(0, 0, W, H); for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - .5) * noise; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } x.putImageData(d, 0, 0); } return c; };
    const bottle = (col) => (x) => { const g = x.createLinearGradient(200, 0, 400, 0); g.addColorStop(0, col[0]); g.addColorStop(.4, col[1]); g.addColorStop(1, col[0]); x.fillStyle = g; x.beginPath(); x.roundRect ? x.roundRect(210, 220, 180, 330, 30) : x.rect(210, 220, 180, 330); x.fill(); x.fillRect(270, 100, 60, 130); };
    const clean = scene(['#EEEEEC', '#D6D6D4'], bottle(['#14683f', '#3aa86e']), 5);
    const wall = scene(['#4678BE', '#3768AA'], bottle(['#B38418', '#F7D24E']), 5);
    const clutter = scene(['#966B3C', '#785028'], (x) => { for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 53) % 360},70%,55%)`; x.beginPath(); x.arc((i * 97) % W, (i * 61) % H, 15 + (i % 6) * 8, 0, 7); x.fill(); } bottle(['#14683f', '#3aa86e'])(x); }, 5);
    const whiteOnWhite = scene(['#FAFAFA', '#F4F4F4'], bottle(['#EDEDED', '#FFFFFF']), 4);
    const tiny = scene(['#EEEEEC', '#D6D6D4'], (x) => { x.fillStyle = '#2a8'; x.fillRect(285, 285, 30, 40); }, 5);
    const r1 = await Cut.remove(clean, {}), r2 = await Cut.remove(wall, {}), r3 = await Cut.remove(clutter, {}), r4 = await Cut.remove(whiteOnWhite, {}), r5 = await Cut.remove(tiny, {});
    ok('clean photo: a good cutout', r1.ok && r1.verdict === 'good', [r1.confidence, r1.reasons]);
    ok('coloured wall: a good cutout', r2.ok && r2.verdict === 'good', [r2.confidence, r2.reasons]);
    ok('cluttered background is graded poor, never passed off as good', r3.verdict === 'poor', [r3.confidence, r3.reasons]);
    ok('white product on white is graded poor', r4.verdict === 'poor', [r4.confidence, r4.reasons]);
    ok('a tiny subject is graded poor', r5.verdict === 'poor', [r5.confidence, r5.reasons]);
    ok('the cutout is transparent where the background was', (() => { const d = r1.canvas.getContext('2d').getImageData(10, 10, 1, 1).data; return d[3] === 0; })());
    ok('the cutout keeps the product opaque', (() => { const d = r1.canvas.getContext('2d').getImageData(300, 400, 1, 1).data; return d[3] === 255; })());
    const blur = (src, k) => { const s = mk(Math.round(W / k), Math.round(H / k)), b = mk(W, H); s.getContext('2d').drawImage(src, 0, 0, s.width, s.height); const bx = b.getContext('2d'); bx.imageSmoothingEnabled = true; bx.drawImage(s, 0, 0, W, H); return b; };
    const sharpA = Q.analysePhoto(clean), softA = Q.analysePhoto(blur(clean, 14));
    ok('a blurred photo scores lower on sharpness than a sharp one', softA.sharp < sharpA.sharp && softA.sharp < Q.THRESHOLDS.sharp.block, [sharpA.sharp, softA.sharp]);
    const dark = mk(W, H); dark.getContext('2d').drawImage(clean, 0, 0); dark.getContext('2d').fillStyle = 'rgba(0,0,0,.8)'; dark.getContext('2d').fillRect(0, 0, W, H);
    ok('a dark photo is measured as dark', Q.analysePhoto(dark).mean < Q.THRESHOLDS.mean.block, Q.analysePhoto(dark).mean);
    // end to end: render a post and run the gate on its report
    const rep = await Posts.render(mk(10, 10), { style: 'spotlight', format: 'portrait', mood: 'deep', badge: 'NEW IN', store: { name: 'Test Store', color: '#00B074', phone: '+256 700 000 000', url: 'https://nextastore.com/test' }, products: [{ name: 'Fresh Aloe Vera Drink 500ml', price: 12000, originalPrice: 16000, image: Cut.trim(r1), mode: 'cutout' }] });
    ok('a post renders and reports readable text', rep.contrast >= 4.5 && Array.isArray(rep.upscale), rep.contrast);
    const long = await Posts.render(mk(10, 10), { style: 'spotlight', format: 'portrait', mood: 'deep', store: { name: 'S', color: '#00B074', url: 'https://nextastore.com/s' }, products: [{ name: 'A'.repeat(20) + ' extremely long product name that goes on '.repeat(5), price: 1000, image: clean, mode: 'photo' }] });
    ok('an over-long product name is shortened by design and reported', long.shortened.length > 0, long);
    await Promise.all(pending);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
if (!canvasPkg) Promise.all(pending).then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
