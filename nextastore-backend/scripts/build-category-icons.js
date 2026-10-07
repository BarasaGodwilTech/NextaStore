#!/usr/bin/env node
/* ==========================================================================
   Builds NextaStore's category icon set.

   Every glyph below is drawn in one house style so the set reads as ours:
   a deep ink-green outline (the brand's --ink), flat fills from a small
   palette, a gold accent, no gradients. Glyphs sit on a 64x64 grid and are
   shown on a tinted rounded tile (the tile is CSS, see css/categories.css).

   Output (both generated - edit THIS file, then re-run it):
     assets/categories/sprite.svg       one <symbol id="c-<id>"> per icon
     js/category-sprite.js              the same sprite as a JS string, so a
                                         page never waits on an extra request
                                         and icons work under any URL depth
   Run:  node scripts/build-category-icons.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ---- palette -----------------------------------------------------------
const K = {
    ink: '#0B3B2B', g: '#01B075', gl: '#8FE6C4', gd: '#008558',
    y: '#FFB038', yl: '#FFD88A', cream: '#FFF4DC',
    r: '#FF7A66', rl: '#FFB8AA',
    b: '#4DA8DA', bl: '#B5DDF3',
    p: '#8E7CF0', pl: '#D3CBFF',
    br: '#B4744F', brl: '#E0AE86', brd: '#8F5A3C',
    gray: '#B9C6C0', grayl: '#E6EDEA', dark: '#33413B', w: '#FFFFFF',
    o: '#FF8A3D'
};
const SW = 2.4; // outline weight

// ---- tiny drawing helpers ---------------------------------------------
const f = n => Math.round(n * 100) / 100;
const P = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`;
const NS = 'stroke="none"'; // fill-only shape (no outline)
const C = (cx, cy, r, fill, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;
const R = (x, y, w, h, rx, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;
const E = (cx, cy, rx, ry, fill, extra = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
// A stroke that is itself outlined: ink underlay + colour top, so handles,
// bars and bands read as solid tubes in the same sticker style.
const tube = (d, col, w = 4, fillNone = 'fill="none"') =>
    `<path d="${d}" ${fillNone} stroke="${K.ink}" stroke-width="${w + 3.4}"/>` +
    `<path d="${d}" ${fillNone} stroke="${col}" stroke-width="${w}"/>`;
const shine = d => `<path d="${d}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.2" ${''}/>`;
const line = (d, col, w) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}"/>`;

function polar(cx, cy, r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function gear(cx, cy, rOut, rIn, teeth) {
    const pts = [];
    const step = 360 / teeth;
    for (let i = 0; i < teeth; i++) {
        const a = i * step;
        [[a - step * 0.30, rIn], [a - step * 0.17, rOut], [a + step * 0.17, rOut], [a + step * 0.30, rIn]]
            .forEach(([deg, rad]) => pts.push(polar(cx, cy, rad, deg)));
    }
    return 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + ' Z';
}
function poly(pts) { return 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + ' Z'; }
function pentagon(cx, cy, r, rot = 0) {
    return poly([0, 1, 2, 3, 4].map(i => polar(cx, cy, r, rot + i * 72)));
}

// ---- the glyphs ---------------------------------------------------------
const icons = {};

icons.clothing = () =>
    P('M22 9 L8 17 L13 29 L20 26 L20 54 L44 54 L44 26 L51 29 L56 17 L42 9 C40 14 36 16 32 16 C28 16 24 14 22 9 Z', K.r) +
    P('M20.5 38 H43.5 V43.5 H20.5 Z', K.yl, NS) +
    P('M22 9 C24 14 28 16 32 16 C36 16 40 14 42 9', 'none') +
    shine('M25 21 V30');

icons.shoes =
    () => P('M6 44 V20 Q6 17 9 17 H18 Q22 17 24 22 L26 26 Q30 32 38 33 L50 35 Q58 37 58 44 Z', K.b) +
        P('M47 35.5 Q56 37 57.5 44 H44 Q47.5 40 47 35.5 Z', K.bl, NS) +
        line('M27.5 24 L32 27 M30.5 20.5 L35.5 24.5', K.w, 2.2) +
        P('M5 44 H59 V49 Q59 52.5 55.5 52.5 H8.5 Q5 52.5 5 49 Z', K.w) +
        line('M11 47.6 H53', K.gray, 1.6);

icons.accessories = () =>
    tube('M22 30 C22 8 42 8 42 30', K.yl, 3.2) +
    P('M12 28 H52 L56 54 Q56.4 57 53.4 57 H10.6 Q7.6 57 8 54 Z', K.y) +
    P('M10 37 Q32 47 54 37', 'none') +
    C(32, 43, 3.6, K.w) +
    shine('M15 33 L16.5 48');

icons.phones = () =>
    R(19, 5, 26, 54, 6, K.dark) +
    R(22.5, 11, 19, 40, 2.5, K.bl, NS) +
    R(25, 15, 6, 6, 1.5, K.y, NS) + R(33, 15, 6, 6, 1.5, K.r, NS) +
    R(25, 23, 6, 6, 1.5, K.g, NS) + R(33, 23, 6, 6, 1.5, K.p, NS) +
    R(26, 33, 12, 5, 2.5, K.w, NS) +
    R(28, 7.4, 8, 1.8, 0.9, K.grayl, NS) +
    P('M22.5 46 L30 38 L41.5 38 L41.5 40 L30 51 H22.5 Z', '#fff', 'fill-opacity=".35" stroke="none"');

icons.electronics = () =>
    R(10, 10, 44, 31, 3.5, K.dark) +
    R(13.5, 13.5, 37, 24, 1.5, K.bl, NS) +
    line('M18 32 L26 24.5 L32 29.5 L40 20.5 L46 26', K.g, 2.8) +
    P('M4 42 H60 V45 Q60 50.5 54.5 50.5 H9.5 Q4 50.5 4 45 Z', K.gray) +
    R(26, 42, 12, 3.4, 1.7, K.grayl, NS);

icons.appliances = () =>
    R(11, 5, 42, 54, 5, K.w) +
    line('M11 19 H53', K.ink, SW) +
    C(19, 12, 2.9, K.r) + R(28, 9.4, 15, 5.2, 2.6, K.bl) + C(47.5, 12, 1.6, K.g, NS) +
    C(32, 39, 15, K.grayl) + C(32, 39, 10.5, K.b) +
    line('M24.5 39 q3.7 -4 7.5 0 t7.5 0', K.w, 2);

icons.home = () =>
    line('M13 49 L11 58 M51 49 L53 58', K.ink, 3.4) +
    P('M17 12 H47 Q52 12 52 17 V37 H12 V17 Q12 12 17 12 Z', K.b) +
    R(16, 32, 32, 16, 4, K.bl) +
    R(5, 27, 13, 23, 6.5, K.b) + R(46, 27, 13, 23, 6.5, K.b) +
    shine('M18 18 H30');

icons.beauty = () =>
    R(7, 26, 20, 30, 5, K.rl) + R(11, 15, 12, 11, 2, K.dark) + C(17, 41, 5.2, K.w) +
    R(36, 38, 18, 18, 3.5, K.y) + R(38, 30, 14, 8.5, 1.5, K.dark) +
    P('M39.5 30 V21 L46 12.5 L50.5 21 V30 Z', K.r) +
    line('M33 8 V14 M30 11 H36', K.y, 2.4) + line('M55 24 V28 M53 26 H57', K.p, 2.2);

icons.health = () =>
    tube('M24 21 V16 Q24 12 28 12 H36 Q40 12 40 16 V21', K.gray, 2.6) +
    R(7, 20, 50, 37, 6.5, K.g) +
    P('M28 28 H36 V35.5 H43.5 V43.5 H36 V51 H28 V43.5 H20.5 V35.5 H28 Z', K.w) +
    shine('M12 27 V36');

icons.food = () =>
    P('M40 29 L44.5 14 L49 29 Z', K.o) +
    line('M44.5 14 L41 5.5 M44.5 14 V4.5 M44.5 14 L48 5.5', K.gd, 2.6) +
    C(23, 21, 9, K.r) +
    P('M17 15.5 L23 19 L29 15.5 L25.5 13 L23 15 L20.5 13 Z', K.g) +
    P('M12 27 H52 L49.4 56.4 Q49.2 58.5 47 58.5 H17 Q14.8 58.5 14.6 56.4 Z', K.brl) +
    P('M12 27 H52', 'none', `stroke-width="3.6"`) +
    C(32, 43.5, 6.5, K.y) + line('M29 43.6 L31.3 46 L35.5 41', K.ink, 2.2) +
    shine('M17.5 33 L18.4 52');

icons.farm = () =>
    P('M6 57 Q10 42 32 42 Q54 42 58 57 Z', K.brd) +
    tube('M32 45 V27', K.g, 3) +
    P('M32 31 C20 33 12 27 10 14 C22 12 32 18 32 31 Z', K.g) +
    P('M32 25 C42 27 50 21 54 8 C42 6 32 12 32 25 Z', K.gl) +
    line('M12 16 Q22 20 29 28', K.ink, 1.4) +
    line('M17 50 H25 M36 52 H46', K.brl, 2.4);

icons.vehicles = () =>
    P('M5 42 V36.5 Q5 33.4 8.2 32.6 L13.5 31 L19.4 21.4 Q21.2 18 25.2 18 H40.6 Q44.6 18 46.6 21.2 L52.6 31 Q60 32 60 37.5 V42 Q60 44.5 57.5 44.5 H7.5 Q5 44.5 5 42 Z', K.b) +
    P('M22 30 L26 22.4 H31.6 V30 Z', K.bl, 'stroke-width="1.9"') +
    P('M35 22.4 H40.4 L46.4 30 H35 Z', K.bl, 'stroke-width="1.9"') +
    R(55.4, 34, 4, 3.4, 1, K.yl, NS) +
    C(17.5, 44.5, 7.2, K.dark) + C(17.5, 44.5, 3, K.grayl, NS) +
    C(47.5, 44.5, 7.2, K.dark) + C(47.5, 44.5, 3, K.grayl, NS);

icons.construction = () =>
    P('M26 25 V14.5 Q26 11 29.5 11 H34.5 Q38 11 38 14.5 V25', K.yl) +
    P('M9 43 C9 26 19 16 32 16 C45 16 55 26 55 43 Z', K.y) +
    R(5, 42, 54, 9, 4.5, K.y) +
    shine('M15.5 37 C15.5 30 19 25 24.5 22') +
    line('M32 16 V42', K.ink, 1.6);

icons.commercial = () =>
    P(gear(27, 36, 22, 17, 9), K.gray) + C(27, 36, 7.5, K.grayl) +
    P(gear(50, 16, 11.5, 8.6, 8), K.y) + C(50, 16, 3.6, K.cream) +
    line('M12 28 Q16 22 22 20', K.w, 2.2);

icons.baby = () =>
    E(16, 47, 6.5, 5, K.brl) + E(48, 47, 6.5, 5, K.brl) +
    E(32, 47.5, 15, 11.5, K.brl) +
    C(19, 14, 6.5, K.brl) + C(45, 14, 6.5, K.brl) + C(19, 14, 3, K.rl, NS) + C(45, 14, 3, K.rl, NS) +
    C(32, 26, 15, K.brl) +
    E(32, 31.5, 7.2, 5.6, K.cream) + E(32, 29, 2.8, 2, K.dark, NS) +
    C(26, 22.4, 1.9, K.dark, NS) + C(38, 22.4, 1.9, K.dark, NS) +
    line('M32 31 V33.5 M28.8 34 Q32 36.4 35.2 34', K.dark, 1.5) +
    P('M32 43 L23.5 38.6 V47.4 Z M32 43 L40.5 38.6 V47.4 Z', K.r) + C(32, 43, 2.6, K.y);

(() => {
    const cx = 32, cy = 32, r = 22;
    const vtx = [0, 1, 2, 3, 4].map(i => -90 + i * 72);
    let lines = '', patches = '';
    vtx.forEach(a => {
        const [x1, y1] = polar(cx, cy, 8, a + 90), [x2, y2] = polar(cx, cy, 18.5, a + 90);
        lines += `M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} `;
        const [px, py] = polar(cx, cy, 25.5, a + 90);
        patches += P(pentagon(px, py, 8.4, a + 90 + 180 + 36), K.dark, 'stroke-width="1.8"');
    });
    icons.sports = () =>
        C(cx, cy, r, K.w) +
        `<clipPath id="c-sports-clip"><circle cx="${cx}" cy="${cy}" r="${r - 1}"/></clipPath>` +
        `<g clip-path="url(#c-sports-clip)">${patches}</g>` +
        line(lines.trim(), K.ink, 2) +
        P(pentagon(cx, cy, 8.2, 0), K.dark) +
        C(cx, cy, r, 'none') + shine('M18 22 Q21 17 27 14');
})();

icons.books = () =>
    R(6, 43, 52, 13, 2.5, K.r) + R(11, 43, 3, 13, 0, K.rl, NS) + line('M18 49.5 H52', K.rl, 2) +
    R(10, 30, 46, 13, 2.5, K.b) + R(15, 30, 3, 13, 0, K.bl, NS) + line('M22 36.5 H48', K.bl, 2) +
    `<g transform="rotate(-7 32 22)">` + R(13, 17, 40, 12.5, 2.5, K.y) + R(18, 17, 3, 12.5, 0, K.yl, NS) + line('M26 23.2 H46', K.yl, 2) + `</g>`;

icons.music = () =>
    tube('M13 38 V32 C13 18 21 10 32 10 C43 10 51 18 51 32 V38', K.p, 4) +
    R(7, 34, 14, 22, 6, K.p) + R(43, 34, 14, 22, 6, K.p) +
    R(15, 38, 6, 14, 3, K.pl, NS) + R(43, 38, 6, 14, 3, K.pl, NS) +
    C(32, 30, 4.4, K.y);

icons.pets = () =>
    `<g fill="${K.br}">` +
    E(13.5, 31, 5.2, 7.2, K.br, 'transform="rotate(-22 13.5 31)"') +
    E(25, 18.5, 5.6, 8, K.br, 'transform="rotate(-8 25 18.5)"') +
    E(39, 18.5, 5.6, 8, K.br, 'transform="rotate(8 39 18.5)"') +
    E(50.5, 31, 5.2, 7.2, K.br, 'transform="rotate(22 50.5 31)"') +
    `</g>` +
    P('M32 29.5 C23.5 29.5 15 39.5 15 47 C15 53.5 20 56.5 25.5 55.5 C28.5 55 30.2 54.2 32 54.2 C33.8 54.2 35.5 55 38.5 55.5 C44 56.5 49 53.5 49 47 C49 39.5 40.5 29.5 32 29.5 Z', K.br) +
    P('M24 38 Q27 33 31 32', 'none', 'stroke="#fff" stroke-opacity=".5" stroke-width="2.2"');

icons.crafts = () =>
    P('M32 7 C16 7 6 19 7 32 C8 46 20 57 33 56 C39.4 55.6 38.4 50 36.6 47 C34.6 43.4 37.4 40 42 40 H49 C56 40 58.5 35 58.5 30 C58.5 17 47 7 32 7 Z', K.brl) +
    C(22, 47, 4.2, K.cream) +
    C(20, 24, 4.6, K.r) + C(31.5, 16.5, 4.6, K.y) + C(44, 21, 4.6, K.g) + C(15.5, 36, 4.6, K.b);

icons.gifts = () =>
    R(9, 28, 46, 29, 3, K.r) + R(6, 20.5, 52, 11, 3, K.rl) + R(28, 20.5, 8, 36.5, 0, K.y) +
    P('M32 20.5 C23 7 11 12 18 18.4 C21.4 21.4 28 20.5 32 20.5 Z', K.y) +
    P('M32 20.5 C41 7 53 12 46 18.4 C42.6 21.4 36 20.5 32 20.5 Z', K.y) +
    R(28, 20.5, 8, 36.5, 0, 'none');

icons.property = () =>
    R(43.5, 10, 7, 14, 1.5, K.rl) +
    R(11, 28, 42, 28, 1.5, K.cream) +
    P('M4 31 L32 8 L60 31 Z', K.r) +
    R(26.5, 37.5, 11, 18.5, 2.5, K.y) + C(34.5, 47.5, 1.1, K.ink, NS) +
    R(15, 36, 8.5, 8.5, 1.5, K.bl) + R(40.5, 36, 8.5, 8.5, 1.5, K.bl) +
    line('M2.5 57 H61.5', K.ink, SW);

icons.home_services = () =>
    R(7, 8, 42, 16, 4.5, K.b) + shine('M12 13 H34') + C(44, 16, 1.6, K.bl, NS) +
    tube('M49 16 H55 Q58 16 58 19 V30 Q58 33 55 33 H36 Q33 33 33 36 V41', K.gray, 3) +
    R(28.5, 40, 9, 18, 3.5, K.y);

icons.repairs = () => {
    const wr = `<g transform="rotate(42 32 32)">` +
        tube('M32 25 V55', K.gray, 5) +
        `<path d="M38.4 9.3 A10 10 0 1 1 25.6 9.3" fill="none" stroke="${K.ink}" stroke-width="9.6" stroke-linecap="round"/>` +
        `<path d="M38.4 9.3 A10 10 0 1 1 25.6 9.3" fill="none" stroke="${K.gray}" stroke-width="4.8" stroke-linecap="round"/>` +
        `</g>`;
    const sd = `<g transform="rotate(-42 32 32)">` +
        tube('M32 12 V38', K.gray, 3) +
        R(27, 36, 10, 21, 4.5, K.r) + line('M30 41 V52', K.rl, 2) +
        `</g>`;
    return sd + wr;
};

icons.salon = () =>
    tube('M24 43 L44 8', K.gray, 4.4) + tube('M40 43 L20 8', K.gray, 4.4) +
    `<circle cx="22" cy="51" r="7.4" fill="none" stroke="${K.ink}" stroke-width="8.2"/><circle cx="22" cy="51" r="7.4" fill="none" stroke="${K.r}" stroke-width="3.8"/>` +
    `<circle cx="42" cy="51" r="7.4" fill="none" stroke="${K.ink}" stroke-width="8.2"/><circle cx="42" cy="51" r="7.4" fill="none" stroke="${K.r}" stroke-width="3.8"/>` +
    C(32, 29, 2.6, K.y);

icons.events = () =>
    P('M7 57 L22 21 Q23 19 25 20.4 L43 41 Q44.4 43 42 43.6 Z', K.y) +
    line('M14.6 39 L24.6 50.4', K.r, 3.2) + line('M19.4 28 L33 44.6', K.r, 3.2) +
    P('M22 21 Q34 22.5 42.6 43.4', 'none') +
    line('M33 22 Q36.5 12 45 17', K.b, 2.6) + line('M44 33 Q52 28 55 36', K.g, 2.6) +
    C(41, 9, 2.6, K.r, NS) + C(53, 22, 2.4, K.b, NS) + C(29, 9.5, 2.2, K.g, NS) +
    C(56, 45, 2.4, K.p, NS) + C(18, 11, 2, K.y, NS) +
    P('M50 9 L52.4 14 L57.4 14.6 L53.6 18 L54.8 23 L50 20.4 L45.2 23 L46.4 18 L42.6 14.6 L47.6 14 Z', K.y, 'transform="translate(1 -2) scale(.9)"');

icons.creative = () =>
    P('M21 18 L24.5 11.5 H39.5 L43 18 Z', K.dark) +
    R(5, 18, 54, 36, 7, K.dark) +
    R(5, 24, 54, 4.4, 0, K.p, NS) +
    C(32, 38, 13, K.grayl) + C(32, 38, 8.6, K.b) + C(28.6, 34.6, 2.6, K.w, NS) +
    R(46, 21.4, 7, 4.2, 1.2, K.y, NS);

icons.transport = () =>
    R(3, 14, 34, 31, 3.5, K.y) + line('M3 31 H37', K.yl, 2.4) +
    P('M37 23 H48.5 Q51.4 23 53 25.6 L59 34 Q60.4 36 60.4 38.4 V45 H37 Z', K.b) +
    P('M41.6 27.4 H48 L54 34.6 H41.6 Z', K.bl, 'stroke-width="1.9"') +
    C(15, 46.5, 7, K.dark) + C(15, 46.5, 2.8, K.grayl, NS) +
    C(48, 46.5, 7, K.dark) + C(48, 46.5, 2.8, K.grayl, NS);

icons.education = () =>
    P('M15 29 V42.5 Q32 53.5 49 42.5 V29 L32 37 Z', K.p) +
    P('M32 10 L60 23.2 L32 36.4 L4 23.2 Z', K.dark) +
    line('M32 18 L47 23.2 L32 29 L17 23.2 Z', K.gray, 1.4) +
    line('M54 25 V40', K.y, 2.8) + C(54, 43.6, 3.4, K.y);

icons.wellness = () =>
    `<g transform="rotate(-32 32 32)">` +
    R(20, 28.6, 24, 6.8, 2, K.gray) +
    R(6, 24, 7, 16, 2.6, K.dark) + R(13, 18, 9, 28, 3.2, K.r) +
    R(42, 18, 9, 28, 3.2, K.r) + R(51, 24, 7, 16, 2.6, K.dark) +
    `</g>`;

icons.business = () =>
    tube('M23 22 V15.4 Q23 11 27.4 11 H36.6 Q41 11 41 15.4 V22', K.brl, 3) +
    R(6, 21, 52, 35, 6.5, K.br) + P('M6 36 H58', 'none') +
    R(27, 32, 10, 9.4, 2, K.y) + shine('M11 27 H21');

icons.tech = () =>
    R(5, 9, 54, 47, 6.5, K.w) +
    P('M5 21 V15.5 Q5 9 11.5 9 H52.5 Q59 9 59 15.5 V21 Z', K.b) +
    C(12, 15, 1.9, K.w, NS) + C(18, 15, 1.9, K.w, NS) + C(24, 15, 1.9, K.w, NS) +
    line('M24 31.5 L16 38.5 L24 45.5', K.gd, 3.8) +
    line('M40 31.5 L48 38.5 L40 45.5', K.gd, 3.8) +
    line('M35.4 29 L28.6 48', K.y, 3.6);

icons.travel = () =>
    line('M6 55 Q14 52 20 45', K.b, 2.6, ) +
    `<g transform="rotate(38 32 32) translate(0 -1)">` +
    P('M32 3 C34.6 3 35.6 6.4 35.6 9.6 V23 L58 37.6 V45 L35.6 37 V50 L42 55 V61 L32 58 L22 61 V55 L28.4 50 V37 L6 45 V37.6 L28.4 23 V9.6 C28.4 6.4 29.4 3 32 3 Z', K.w) +
    P('M28.4 37 L6 45 V41 L28.4 33 Z M35.6 37 L58 45 V41 L35.6 33 Z', K.bl, NS) +
    R(30.6, 9, 2.8, 5, 1.2, K.b, NS) +
    `</g>`;

icons.digital = () =>
    P('M14 6 H38 L52 20 V56 Q52 58 50 58 H16 Q14 58 14 56 Z', K.w) +
    P('M38 6 V20 H52 Z', K.bl) +
    line('M21 29 H40 M21 36 H34', K.gray, 2.6) +
    C(44, 47, 12.4, K.g) + line('M44 40.5 V53 M38.6 48 L44 53.4 L49.4 48', K.w, 3.2);

icons.other = () =>
    P('M8 20 V44 L32 56 V32 Z', K.br) +
    P('M56 20 V44 L32 56 V32 Z', K.brd) +
    P('M32 8 L56 20 L32 32 L8 20 Z', K.brl) +
    P('M17 17.5 L41 29.5', 'none', `stroke="${K.yl}" stroke-width="5.4"`) +
    P('M38 38.4 L50 32.6 V40 L38 46 Z', K.cream, 'stroke-width="1.8"');

// ---- non-category helpers used by the marketplace grid -----------------
icons.trending = () =>
    P('M32 5 C34.4 15.4 47 20 47 36.4 C47 48.6 40.4 57 32 57 C23.6 57 17 49 17 38.6 C17 32.4 20.6 28.4 23.6 24 C25.4 28.6 28 29.6 29.6 28 C30.4 20 29.8 11.6 32 5 Z', K.o) +
    P('M32.4 35 C34 40 40 41.4 40 47.6 C40 52 36.6 55 32.4 55 C28 55 24.8 52 24.8 47.6 C24.8 43.8 28.6 41.2 29.8 38 C30.4 36.4 31.4 36 32.4 35 Z', K.yl);

icons.sell = () => {
    // Awning: six segments alternating gold / white, scalloped hem.
    const seg = [];
    for (let i = 0; i < 6; i++) {
        const tx = (a) => 12 + a * (40 / 6), bx = (a) => 6 + a * (52 / 6);
        seg.push(P(poly([[tx(i), 8], [tx(i + 1), 8], [bx(i + 1), 22], [bx(i), 22]]), i % 2 ? K.w : K.y, 'stroke-width="1.8"'));
    }
    let hem = '';
    for (let i = 0; i < 4; i++) hem += P(`M${6 + i * 13} 22 a6.5 6.5 0 0 0 13 0 Z`, i % 2 ? K.w : K.y, 'stroke-width="1.8"');
    return R(10, 28, 44, 28, 1.5, K.cream) + seg.join('') + hem +
        R(26, 37, 12, 19, 2.5, K.g) + C(35, 47, 1.1, K.w, NS) +
        R(13.5, 35.5, 9, 9, 1.5, K.bl) + R(41.5, 35.5, 9, 9, 1.5, K.bl) +
        line('M5 57 H59', K.ink, SW);
};

icons.all = () =>
    R(8, 8, 21, 21, 6, K.r) + R(35, 8, 21, 21, 6, K.b) + R(8, 35, 21, 21, 6, K.y) + R(35, 35, 21, 21, 6, K.g);

// ---- assemble ----------------------------------------------------------
const ids = Object.keys(icons);
const symbols = ids.map(id => {
    const body = icons[id]();
    return `<symbol id="c-${id}" viewBox="0 0 64 64"><g fill="none" stroke="${K.ink}" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round">${body}</g></symbol>`;
}).join('\n');

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">\n${symbols}\n</svg>\n`;

fs.mkdirSync(path.join(ROOT, 'assets', 'categories'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'categories', 'sprite.svg'), sprite);

const js = `/* GENERATED by nextastore-backend/scripts/build-category-icons.js - do not edit by hand.
   The category icon sprite, inlined so icons never wait on a request and work
   at any URL depth. js/categories.js injects it into the page. */
window.NX_CATEGORY_SPRITE = ${JSON.stringify(sprite.trim())};
window.NX_CATEGORY_SPRITE_IDS = ${JSON.stringify(ids)};
`;
fs.writeFileSync(path.join(ROOT, 'js', 'category-sprite.js'), js);

console.log(`Built ${ids.length} icons -> assets/categories/sprite.svg (${sprite.length} bytes), js/category-sprite.js`);
