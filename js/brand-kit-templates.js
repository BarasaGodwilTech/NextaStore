/**
 * (Round 2 adds: delivery, openhours, thanks, flash, newin - see the bottom of the template list.)
 * More poster templates for the Promote studio, added NEXT TO the originals in js/brand-kit.js (nothing there is changed):
 *   opening   Grand opening poster (A4)       sale      Big sale poster (A4)       scansign  Scan-to-order counter sign (A5)
 * They take the same data and the same colour swatch as the originals, so every control in the studio keeps working:
 *   tagline -> the line under the headline (opening) or the offer band (sale) or the sub-line (scansign)
 *   cta     -> the date / invitation pill (opening), the small line under the offer (sale) or the sign headline (scansign)
 * Loaded after brand-kit.js. It wraps NextaBrandKit.render: any other template id goes straight to the original.
 */
(function (root) {
    'use strict';
    const K = root.NextaBrandKit;
    if (!K || K.__moreTemplates) return;
    K.__moreTemplates = true;
    const H = K.helpers, INK = '#0B3B2B', DEEP = '#008558', PAPER = '#F7FAF8';
    const font = (w, s) => H.font(w, Math.round(s));

    K.TEMPLATES.push(
        { id: 'opening',  group: 'poster', label: 'Grand opening (A4)',    w: 2480, h: 3508, mm: [210, 297], pdf: true, file: 'grand-opening-a4' },
        { id: 'sale',     group: 'poster', label: 'Big sale (A4)',         w: 2480, h: 3508, mm: [210, 297], pdf: true, file: 'big-sale-a4' },
        { id: 'scansign', group: 'poster', label: 'Scan to order (A5)',    w: 1748, h: 2480, mm: [148, 210], pdf: true, file: 'scan-to-order-a5' },
        { id: 'delivery', group: 'poster', label: 'We deliver (A4)',       w: 2480, h: 3508, mm: [210, 297], pdf: true, file: 'we-deliver-a4' },
        { id: 'openhours',group: 'poster', label: 'We are open (A5)',      w: 1748, h: 2480, mm: [148, 210], pdf: true, file: 'we-are-open-a5' },
        { id: 'thanks',   group: 'poster', label: 'Thank-you card (A6)',   w: 1240, h: 1748, mm: [105, 148], pdf: true, file: 'thank-you-a6' },
        { id: 'flash',    group: 'social', label: 'Flash sale story',      w: 1080, h: 1920, file: 'flash-sale-story' },
        { id: 'newin',    group: 'social', label: 'New in stock (square)', w: 1080, h: 1080, file: 'new-in-square' }
    );

    function spaced(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
    function lines(ctx, ls, x, y, lh, align) { ctx.textAlign = align || 'center'; ls.forEach((l, i) => ctx.fillText(l, x, y + i * lh)); return y + ls.length * lh; }
    function ring(ctx, cx, cy, r, color, alpha, lw) { ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    function archPath(ctx, x, y, w, h) { const r = w / 2; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath(); }
    function logoOn(ctx, logo, d, cx, cy, r, th) { H.drawLogo(ctx, d.showLogo === false ? null : logo, d.name, cx, cy, r, th); }
    const lightTheme = (t) => ({ dark: false, soft: '#EAF0ED', bg: INK, accent: DEEP, fg: INK, muted: '#52615B', qrFg: INK });

    /** The rounded store plate at the foot: logo, name, phone or how to order, link, QR. */
    function plate(ctx, x, y, w, h, d, t, logo, u) {
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 30 * u; ctx.shadowOffsetY = 10 * u;
        H.rr(ctx, x, y, w, h, 38 * u); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.restore();
        const qs = h - 28 * u, qx = x + w - qs - 14 * u;
        H.drawQR(ctx, d.url, qx, y + 14 * u, qs, t, { fg: INK, radius: 16 * u });
        const r = Math.min(46 * u, h * 0.27), lx = x + 26 * u + r;
        logoOn(ctx, logo, d, lx, y + h / 2, r, lightTheme(t));
        const tx = lx + r + 24 * u, tw = qx - 20 * u - tx;
        const nf = H.fit(ctx, String(d.name || 'My Store'), 700, 40 * u, 24 * u, tw, 1);
        const second = d.showPhone && d.phone ? d.phone : 'Scan to order';
        const sf = H.fit(ctx, second, 400, 28 * u, 20 * u, tw, 1), uf = H.fit(ctx, H.urlLabel(d.url), 700, 26 * u, 16 * u, tw, 1);
        const top = y + (h - (nf.size + sf.size + uf.size + 28 * u)) / 2;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = font(700, nf.size); ctx.fillStyle = INK; ctx.fillText(nf.lines[0], tx, top + nf.size * 0.9);
        ctx.font = font(400, sf.size); ctx.fillStyle = '#52615B'; ctx.fillText(sf.lines[0], tx, top + nf.size + 8 * u + sf.size * 0.9);
        ctx.font = font(700, uf.size); ctx.fillStyle = DEEP; ctx.fillText(uf.lines[0], tx, top + nf.size + sf.size + 20 * u + uf.size * 0.9);
    }

    function opening(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 240 * u, 1320 * u, 500 * u, t.accent, 0.3, 3 * u); ring(ctx, 860 * u, 60 * u, 350 * u, t.dark ? '#2EDDA2' : t.accent, 0.25, 3 * u);
        // store name across the top
        const nf = H.fit(ctx, String(d.name || 'My Store').toUpperCase(), 700, 28 * u, 18 * u, 800 * u, 1);
        ctx.font = font(700, nf.size); ctx.fillStyle = t.accent; ctx.textBaseline = 'alphabetic'; spaced(ctx, 6 * u); lines(ctx, nf.lines, W / 2, 80 * u, 0); spaced(ctx, 0);
        // the arch
        const ax = 140 * u, ay = 130 * u, aw = 720 * u, ah = 760 * u;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 40 * u; ctx.shadowOffsetY = 14 * u; archPath(ctx, ax, ay, aw, ah); ctx.fillStyle = t.dark ? PAPER : '#FFFFFF'; ctx.fill(); ctx.restore();
        // confetti
        [[100, 300, 13, t.accent], [900, 262, 10, '#2EDDA2'], [70, 570, 8, '#2EDDA2'], [930, 530, 11, t.accent], [120, 830, 7, t.accent], [880, 812, 12, '#2EDDA2'], [200, 156, 7, '#2EDDA2'], [800, 140, 9, t.accent]]
            .forEach(([x, y, r, c]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x * u, y * u, r * u, 0, Math.PI * 2); ctx.fill(); });
        logoOn(ctx, logo, d, 500 * u, 262 * u, 66 * u, lightTheme(t));
        ctx.fillStyle = INK; const g = H.fit(ctx, 'GRAND', 700, 168 * u, 80 * u, 640 * u, 1); ctx.font = font(700, g.size); lines(ctx, g.lines, W / 2, 470 * u, 0);
        ctx.fillStyle = DEEP; const o = H.fit(ctx, 'OPENING', 700, 142 * u, 70 * u, 640 * u, 1); ctx.font = font(700, o.size); lines(ctx, o.lines, W / 2, 600 * u, 0);
        ctx.fillStyle = '#FFB038'; H.rr(ctx, 420 * u, 660 * u, 160 * u, 6 * u, 3 * u); ctx.fill();
        const line = String(d.tagline || 'Come and celebrate with us'), tf = H.fit(ctx, line, 400, 32 * u, 22 * u, 620 * u, 3);
        ctx.font = font(400, tf.size); ctx.fillStyle = '#52615B'; lines(ctx, tf.lines, W / 2, 725 * u, tf.size * 1.4);
        // the date / invitation pill
        ctx.fillStyle = '#FFB038'; H.rr(ctx, 140 * u, 930 * u, 720 * u, 120 * u, 60 * u); ctx.fill();
        const pf = H.fit(ctx, String(d.cta || 'Join us this Saturday'), 700, 40 * u, 24 * u, 640 * u, 1);
        ctx.font = font(700, pf.size); ctx.fillStyle = INK; ctx.textBaseline = 'middle'; lines(ctx, pf.lines, W / 2, 991 * u, 0); ctx.textBaseline = 'alphabetic';
        ctx.font = font(400, 30 * u); ctx.fillStyle = t.fg; ctx.globalAlpha = 0.85; lines(ctx, ['Point your camera at the code to see our store'], W / 2, 1100 * u, 0); ctx.globalAlpha = 1;
        plate(ctx, 50 * u, 1196 * u, 900 * u, 164 * u, d, t, logo, u);
    }

    function sale(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 200 * u, 150 * u, 400 * u, t.fg, 0.14, 3 * u); ring(ctx, 870 * u, 1050 * u, 350 * u, t.fg, 0.14, 3 * u);
        // chip + logo
        ctx.font = font(700, 24 * u); spaced(ctx, 3 * u); const cw = ctx.measureText('LIMITED TIME').width + 52 * u; spaced(ctx, 0);
        ctx.fillStyle = t.dark ? t.accent : INK; H.rr(ctx, 50 * u, 60 * u, cw, 58 * u, 29 * u); ctx.fill();
        ctx.fillStyle = t.dark ? INK : '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; spaced(ctx, 3 * u); ctx.fillText('LIMITED TIME', 76 * u, 90 * u); spaced(ctx, 0); ctx.textBaseline = 'alphabetic';
        logoOn(ctx, logo, d, 900 * u, 90 * u, 44 * u, t);
        // BIG / SALE
        const b = H.fit(ctx, 'BIG', 700, 230 * u, 100 * u, 900 * u, 1); ctx.font = font(700, b.size); ctx.fillStyle = t.fg; ctx.textAlign = 'left'; ctx.fillText(b.lines[0], 46 * u, 330 * u);
        const s = H.fit(ctx, 'SALE', 700, 380 * u, 160 * u, 910 * u, 1); ctx.font = font(700, s.size); ctx.fillStyle = t.accent; ctx.fillText(s.lines[0], 38 * u, 630 * u);
        // offer band
        const bandBg = t.dark ? H.mix(t.bg, '#000000', 0.38) : INK, bandFg = t.dark ? t.accent : '#FFFFFF';
        ctx.fillStyle = bandBg; ctx.fillRect(0, 860 * u, W, 170 * u);
        const of = H.fit(ctx, String(d.tagline || 'UP TO 50% OFF').toUpperCase(), 700, 96 * u, 40 * u, 900 * u, 1);
        ctx.font = font(700, of.size); ctx.fillStyle = bandFg; ctx.textBaseline = 'middle'; lines(ctx, of.lines, W / 2, 946 * u, 0); ctx.textBaseline = 'alphabetic';
        const cf = H.fit(ctx, String(d.cta || 'While stock lasts'), 700, 38 * u, 24 * u, 880 * u, 2);
        ctx.font = font(700, cf.size); ctx.fillStyle = t.fg; lines(ctx, cf.lines, W / 2, 1090 * u, cf.size * 1.3);
        plate(ctx, 50 * u, 1196 * u, 900 * u, 164 * u, d, t, logo, u);
    }

    function scansign(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        // header band with rounded bottom
        const band = t.dark ? H.mix(t.bg, '#000000', 0.3) : INK;
        ctx.fillStyle = band; H.rr(ctx, 0, -80 * u, W, 480 * u, 70 * u); ctx.fill();
        ring(ctx, 800 * u, 40 * u, 230 * u, '#FFB038', 0.4, 3 * u);
        logoOn(ctx, logo, d, W / 2, 110 * u, 46 * u, { dark: true, soft: '#EAF0ED', bg: band, accent: '#FFB038', fg: '#FFFFFF', muted: '#BFD3CA', qrFg: INK });
        const hf = H.fit(ctx, String(d.cta || 'Scan to order'), 700, 104 * u, 48 * u, 840 * u, 2);
        ctx.font = font(700, hf.size); ctx.fillStyle = '#FFFFFF'; const hy = lines(ctx, hf.lines, W / 2, 232 * u + hf.size * 0.2, hf.size * 1.08);
        const sf = H.fit(ctx, String(d.tagline || 'Point your phone camera at the code'), 400, 32 * u, 22 * u, 820 * u, 2);
        ctx.font = font(400, sf.size); ctx.fillStyle = '#2EDDA2'; lines(ctx, sf.lines, W / 2, Math.max(hy + 4 * u, 330 * u), sf.size * 1.3);
        // QR card
        const qs = 600 * u, qx = (W - qs) / 2, qy = 430 * u;
        H.drawQR(ctx, d.url, qx, qy, qs, t, { fg: INK, shadow: true, radius: 56 * u });
        // three steps
        [['1', 'Scan', 'with your camera'], ['2', 'Choose', 'what you want'], ['3', 'Order', 'and we get it to you']].forEach((st, i) => {
            const cx = 190 * u + i * 310 * u;
            ctx.fillStyle = '#FFB038'; ctx.beginPath(); ctx.arc(cx, 1138 * u, 38 * u, 0, Math.PI * 2); ctx.fill();
            ctx.font = font(700, 40 * u); ctx.fillStyle = INK; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(st[0], cx, 1141 * u); ctx.textBaseline = 'alphabetic';
            ctx.font = font(700, 34 * u); ctx.fillStyle = t.fg; ctx.fillText(st[1], cx, 1226 * u);
            ctx.font = font(400, 23 * u); ctx.fillStyle = t.muted; ctx.fillText(st[2], cx, 1262 * u);
        });
        const nf = H.fit(ctx, [d.name, d.showPhone && d.phone ? d.phone : ''].filter(Boolean).join('  ·  '), 700, 30 * u, 18 * u, 880 * u, 1);
        ctx.font = font(700, nf.size); ctx.fillStyle = t.accent; lines(ctx, nf.lines, W / 2, 1340 * u, 0);
        const uf = H.fit(ctx, H.urlLabel(d.url), 400, 26 * u, 16 * u, 880 * u, 1);
        ctx.font = font(400, uf.size); ctx.fillStyle = t.muted; lines(ctx, uf.lines, W / 2, 1384 * u, 0);
    }


    // ---------------------------------------------------------------------------------------------------------------
    // Round 2
    function qrCard(ctx, d, t, x, y, size, u) { H.drawQR(ctx, d.url, x, y, size, t, { fg: INK, shadow: true, radius: size * 0.1 }); }
    function pill(ctx, x, y, w, h, bg, fg, text, weight, size, maxW) {
        ctx.fillStyle = bg; H.rr(ctx, x, y, w, h, h / 2); ctx.fill();
        const f = H.fit(ctx, text, weight, size, size * 0.55, maxW, 1); ctx.font = font(weight, f.size); ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(f.lines[0], x + w / 2, y + h / 2 + f.size * 0.04); ctx.textBaseline = 'alphabetic';
    }
    function brandRow(ctx, d, t, logo, cx, cy, r, u, color) {
        logoOn(ctx, logo, d, cx, cy, r, t);
        const f = H.fit(ctx, String(d.name || 'My Store'), 700, 34 * u, 20 * u, 700 * u, 1); ctx.font = font(700, f.size); ctx.fillStyle = color || t.fg; ctx.textAlign = 'center'; ctx.fillText(f.lines[0], cx, cy + r + 20 * u + f.size * 0.8);
    }
    function truck(ctx, x, y, s, body, cab, glass) {
        ctx.fillStyle = body; H.rr(ctx, x, y, 300 * s, 190 * s, 22 * s); ctx.fill();
        ctx.fillStyle = cab; H.rr(ctx, x + 310 * s, y + 60 * s, 170 * s, 130 * s, 26 * s); ctx.fill();
        ctx.fillStyle = glass; H.rr(ctx, x + 350 * s, y + 80 * s, 100 * s, 56 * s, 12 * s); ctx.fill();
        ctx.fillStyle = cab; ctx.fillRect(x + 20 * s, y + 175 * s, 460 * s, 16 * s);
        [[90, 210], [390, 210]].forEach(([wx, wy]) => { ctx.fillStyle = '#15171A'; ctx.beginPath(); ctx.arc(x + wx * s, y + wy * s, 38 * s, 0, 7); ctx.fill(); ctx.fillStyle = '#C9D1CD'; ctx.beginPath(); ctx.arc(x + wx * s, y + wy * s, 16 * s, 0, 7); ctx.fill(); });
        ctx.strokeStyle = glass; ctx.globalAlpha = 0.5; ctx.lineWidth = 6 * s; ctx.lineCap = 'round';
        [[-90, 60], [-130, 100], [-70, 130]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.moveTo(x + dx * s, y + dy * s); ctx.lineTo(x - 10 * s + dx * s * 0.2, y + dy * s); ctx.stroke(); }); ctx.globalAlpha = 1;
    }
    function heart(ctx, cx, cy, s, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.9); ctx.bezierCurveTo(cx - s * 1.5, cy - s * 0.1, cx - s * 0.7, cy - s * 1.1, cx, cy - s * 0.35); ctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.1, cx + s * 1.5, cy - s * 0.1, cx, cy + s * 0.9); ctx.fill(); }

    function delivery(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 900 * u, 120 * u, 380 * u, t.accent, 0.3, 3 * u); ring(ctx, 80 * u, 1100 * u, 420 * u, t.fg, 0.1, 3 * u);
        pill(ctx, 50 * u, 60 * u, 330 * u, 58 * u, t.dark ? t.accent : INK, t.dark ? INK : '#FFFFFF', 'FAST AND SAFE', 700, 24 * u, 280 * u);
        logoOn(ctx, logo, d, 900 * u, 90 * u, 44 * u, t);
        ctx.textAlign = 'left'; ctx.fillStyle = t.fg; const a = H.fit(ctx, 'WE', 700, 200 * u, 100 * u, 900 * u, 1); ctx.font = font(700, a.size); ctx.fillText(a.lines[0], 46 * u, 310 * u);
        ctx.fillStyle = t.accent; const b = H.fit(ctx, 'DELIVER', 700, 250 * u, 100 * u, 910 * u, 1); ctx.font = font(700, b.size); ctx.fillText(b.lines[0], 40 * u, 520 * u);
        truck(ctx, 250 * u, 640 * u, 1.0 * u, t.dark ? '#FFFFFF' : INK, t.accent, t.dark ? t.bg : '#FFFFFF');
        const tf = H.fit(ctx, String(d.tagline || 'Order online and we bring it to your door'), 700, 40 * u, 24 * u, 860 * u, 2);
        ctx.font = font(700, tf.size); ctx.fillStyle = t.fg; lines(ctx, tf.lines, W / 2, 940 * u, tf.size * 1.25);
        const cf = H.fit(ctx, String(d.cta || 'Kampala and nearby areas'), 400, 32 * u, 20 * u, 860 * u, 1);
        ctx.font = font(400, cf.size); ctx.fillStyle = t.muted; lines(ctx, cf.lines, W / 2, 1050 * u, 0);
        plate(ctx, 50 * u, 1196 * u, 900 * u, 164 * u, d, t, logo, u);
    }

    function openhours(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 500 * u, 560 * u, 470 * u, t.accent, 0.28, 3 * u); ring(ctx, 500 * u, 560 * u, 400 * u, t.fg, 0.1, 3 * u);
        brandRow(ctx, d, t, logo, 500 * u, 110 * u, 48 * u, u);
        ctx.fillStyle = t.fg; ctx.font = font(700, 54 * u); ctx.textAlign = 'center'; ctx.fillText("WE'RE", 500 * u, 460 * u);
        ctx.fillStyle = t.accent; const o = H.fit(ctx, 'OPEN', 700, 300 * u, 120 * u, 760 * u, 1); ctx.font = font(700, o.size); ctx.fillText(o.lines[0], 500 * u, 700 * u);
        ctx.fillStyle = '#2EDDA2'; ctx.beginPath(); ctx.arc(500 * u, 760 * u, 14 * u, 0, 7); ctx.fill();
        const hf = H.fit(ctx, String(d.tagline || 'Mon to Sat  ·  8:00 AM to 7:00 PM'), 700, 38 * u, 22 * u, 840 * u, 2);
        ctx.font = font(700, hf.size); ctx.fillStyle = t.fg; lines(ctx, hf.lines, W / 2, 850 * u, hf.size * 1.3);
        const cf = H.fit(ctx, String(d.cta || 'Walk in or order online'), 400, 30 * u, 20 * u, 840 * u, 1);
        ctx.font = font(400, cf.size); ctx.fillStyle = t.muted; lines(ctx, cf.lines, W / 2, 960 * u, 0);
        qrCard(ctx, d, t, 380 * u, 1020 * u, 240 * u, u);
        const uf = H.fit(ctx, H.urlLabel(d.url), 700, 28 * u, 16 * u, 880 * u, 1); ctx.font = font(700, uf.size); ctx.fillStyle = t.accent; lines(ctx, uf.lines, W / 2, 1330 * u, 0);
    }

    function thanks(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 900 * u, 80 * u, 330 * u, t.accent, 0.3, 3 * u); ring(ctx, 60 * u, 1300 * u, 380 * u, t.fg, 0.1, 3 * u);
        brandRow(ctx, d, t, logo, 500 * u, 130 * u, 56 * u, u);
        heart(ctx, 500 * u, 470 * u, 90 * u, t.dark ? t.accent : '#FFB038');
        ctx.fillStyle = t.fg; const f = H.fit(ctx, 'Thank you!', 700, 150 * u, 70 * u, 880 * u, 1); ctx.font = font(700, f.size); ctx.textAlign = 'center'; ctx.fillText(f.lines[0], 500 * u, 700 * u);
        const mf = H.fit(ctx, String(d.tagline || 'We really appreciate your order'), 400, 38 * u, 22 * u, 760 * u, 3);
        ctx.font = font(400, mf.size); ctx.fillStyle = t.fg; ctx.globalAlpha = 0.9; lines(ctx, mf.lines, W / 2, 780 * u, mf.size * 1.35); ctx.globalAlpha = 1;
        qrCard(ctx, d, t, 360 * u, 930 * u, 280 * u, u);
        const cf = H.fit(ctx, String(d.cta || 'Scan to order again'), 700, 34 * u, 20 * u, 840 * u, 1);
        ctx.font = font(700, cf.size); ctx.fillStyle = t.accent; lines(ctx, cf.lines, W / 2, 1270 * u, 0);
        const pf = H.fit(ctx, d.showPhone && d.phone ? d.phone : H.urlLabel(d.url), 400, 28 * u, 16 * u, 840 * u, 1);
        ctx.font = font(400, pf.size); ctx.fillStyle = t.muted; lines(ctx, pf.lines, W / 2, 1330 * u, 0);
    }

    function flash(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 880 * u, 380 * u, 430 * u, t.accent, 0.3, 3 * u); ring(ctx, 80 * u, 1300 * u, 430 * u, t.fg, 0.1, 3 * u);
        brandRow(ctx, d, t, logo, 500 * u, 270 * u, 56 * u, u);
        ctx.textAlign = 'left'; ctx.fillStyle = t.fg; const a = H.fit(ctx, 'FLASH', 700, 300 * u, 120 * u, 900 * u, 1); ctx.font = font(700, a.size); ctx.fillText(a.lines[0], 46 * u, 700 * u);
        ctx.fillStyle = t.accent; const b = H.fit(ctx, 'SALE', 700, 400 * u, 160 * u, 910 * u, 1); ctx.font = font(700, b.size); ctx.fillText(b.lines[0], 38 * u, 1010 * u);
        const bandBg = t.dark ? H.mix(t.bg, '#000000', 0.38) : INK, bandFg = t.dark ? t.accent : '#FFFFFF';
        ctx.fillStyle = bandBg; ctx.fillRect(0, 1080 * u, W, 150 * u);
        const of = H.fit(ctx, String(d.tagline || 'TODAY ONLY').toUpperCase(), 700, 84 * u, 36 * u, 900 * u, 1); ctx.font = font(700, of.size); ctx.fillStyle = bandFg; ctx.textBaseline = 'middle'; lines(ctx, of.lines, W / 2, 1157 * u, 0); ctx.textBaseline = 'alphabetic';
        const cf = H.fit(ctx, String(d.cta || 'Scan to shop now'), 700, 36 * u, 22 * u, 860 * u, 1); ctx.font = font(700, cf.size); ctx.fillStyle = t.fg; lines(ctx, cf.lines, W / 2, 1300 * u, 0);
        qrCard(ctx, d, t, 350 * u, 1340 * u, 300 * u, u);
        const uf = H.fit(ctx, H.urlLabel(d.url), 700, 28 * u, 16 * u, 880 * u, 1); ctx.font = font(700, uf.size); ctx.fillStyle = t.accent; lines(ctx, uf.lines, W / 2, 1690 * u, 0);
    }

    function newin(ctx, W, H_, d, t, logo) {
        const u = W / 1000;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H_);
        ring(ctx, 880 * u, 180 * u, 380 * u, t.accent, 0.3, 3 * u); ring(ctx, 60 * u, 980 * u, 340 * u, t.fg, 0.1, 3 * u);
        logoOn(ctx, logo, d, 100 * u, 100 * u, 44 * u, t);
        const nf = H.fit(ctx, String(d.name || 'My Store'), 700, 34 * u, 20 * u, 640 * u, 1); ctx.font = font(700, nf.size); ctx.fillStyle = t.fg; ctx.textAlign = 'left'; ctx.fillText(nf.lines[0], 166 * u, 112 * u);
        ctx.fillStyle = t.accent; const a = H.fit(ctx, 'NEW', 700, 330 * u, 140 * u, 900 * u, 1); ctx.font = font(700, a.size); ctx.fillText(a.lines[0], 50 * u, 440 * u);
        ctx.fillStyle = t.fg; const b = H.fit(ctx, 'IN STOCK', 700, 150 * u, 70 * u, 900 * u, 1); ctx.font = font(700, b.size); ctx.fillText(b.lines[0], 54 * u, 590 * u);
        const tf = H.fit(ctx, String(d.tagline || 'Fresh arrivals, ready for you'), 400, 36 * u, 22 * u, 860 * u, 2); ctx.font = font(400, tf.size); ctx.fillStyle = t.muted; lines(ctx, tf.lines, 54 * u, 660 * u, tf.size * 1.3, 'left');
        pill(ctx, 54 * u, 790 * u, 560 * u, 96 * u, '#FFB038', INK, String(d.cta || 'Scan to shop now'), 700, 36 * u, 480 * u);
        const uf = H.fit(ctx, H.urlLabel(d.url), 700, 28 * u, 16 * u, 560 * u, 1); ctx.font = font(700, uf.size); ctx.fillStyle = t.accent; ctx.textAlign = 'left'; ctx.fillText(uf.lines[0], 54 * u, 950 * u);
        qrCard(ctx, d, t, 690 * u, 700 * u, 260 * u, u);
    }

    const LAYOUTS = { opening, sale, scansign, delivery, openhours, thanks, flash, newin };
    const base = K.render;
    K.render = async function (canvas, id, data, opts) {
        if (!LAYOUTS[id]) return base.apply(this, arguments);
        if (typeof root.NextaQR === 'undefined') throw new Error('QR generator missing');
        if (!data || !data.url) throw new Error('No store link to put in the QR code');
        opts = opts || {};
        const T = K.TEMPLATES.find((x) => x.id === id);
        try { if (root.document && root.document.fonts && root.document.fonts.load) await Promise.all([root.document.fonts.load(font(400, 40)), root.document.fonts.load(font(700, 40))]); } catch (e) { /* system font */ }
        const logo = data.showLogo === false ? null : await H.loadLogo(data.logo);
        const scale = opts.scale || 1;
        canvas.width = Math.round(T.w * scale); canvas.height = Math.round(T.h * scale);
        const ctx = canvas.getContext('2d'), t = K.themeFrom(data);
        ctx.save(); ctx.scale(scale, scale); LAYOUTS[id](ctx, T.w, T.h, data, t, logo); ctx.restore();
        return canvas;
    };
})(typeof window !== 'undefined' ? window : globalThis);
