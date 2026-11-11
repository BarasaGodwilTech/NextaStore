/**
 * NextaPosts: product posts a seller can share in two taps. Extends the brand kit (js/brand-kit.js) and takes the
 * store's own branding automatically: logo, banner image, brand colour, name, phone and QR.
 *
 *   NextaPosts.STYLES / FORMATS / MOODS / BADGES      what the studio offers
 *   await NextaPosts.render(canvas, data, { scale })  -> report
 *
 * data = {
 *   style:  'spotlight' | 'deal' | 'collection',
 *   format: 'square' | 'portrait' | 'story',
 *   mood:   'deep' | 'light' | 'brand',
 *   badge:  'NEW IN' | 'ON SALE' | ... | '',          cta: 'Scan to order',
 *   store:  { name, logo, banner, color, phone, url },  // logo / banner: url, data: url, Image or canvas
 *   showPhone, showBanner, showLogo,
 *   products: [{ name, price, originalPrice, image: Image|canvas, mode: 'cutout'|'photo' }]
 * }
 *
 * The visual identity is NextaStore's own: the logo's open ring and gold dot as the hero motif, arch-window photo
 * frames, a paper price tag with punched holes, a scalloped gold discount seal, and a rounded "store plate" at the
 * foot with the QR. Nothing is positioned by the seller, so layouts cannot break; every text block is fitted to its
 * box and reports back if it had to shrink or be cut, so js/nexta-quality.js can hold back a poor result.
 *
 * report = { upscale: [n per product], shrunk: [{ id, label, from, to, min }], truncated: [ids], contrast: minRatio }
 */
(function (root) {
    'use strict';
    const K = () => root.NextaBrandKit;
    const env = { createCanvas(w, h) { const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c; } };

    const FORMATS = [
        { id: 'square',   label: 'Square',   sub: 'Feed & chats',     w: 1080, h: 1080, top: 56,  bottom: 56 },
        { id: 'portrait', label: 'Portrait', sub: 'Feed, best reach', w: 1080, h: 1350, top: 64,  bottom: 64 },
        { id: 'story',    label: 'Status',   sub: 'WhatsApp status',  w: 1080, h: 1920, top: 210, bottom: 230 }
    ];
    const STYLES = [
        { id: 'spotlight',  label: 'Spotlight',  sub: 'One product, big and clear',  products: [1, 1] },
        { id: 'deal',       label: 'Deal',       sub: 'Lead with the price drop',    products: [1, 1], needsDiscount: true },
        { id: 'collection', label: 'Collection', sub: '2 to 4 products together',   products: [2, 4] },
        { id: 'arch',       label: 'Arch',       sub: 'Product in an arch window',   products: [1, 1] },
        { id: 'drop',       label: 'Price drop', sub: 'Big seal, old price crossed out', products: [1, 1], needsDiscount: true },
        { id: 'catalogue',  label: 'Catalogue',  sub: 'Header band, 2 to 4 products', products: [2, 4] },
        { id: 'bold',       label: 'Bold price', sub: 'The price is the headline',    products: [1, 1] },
        { id: 'round',      label: 'Round',      sub: 'Product in a round frame',     products: [1, 1] },
        { id: 'soft',       label: 'Soft card',  sub: 'Rounded card, no arch',        products: [1, 1] }
    ];
    const MOODS = [
        { id: 'deep',  label: 'Deep' },
        { id: 'light', label: 'Light' },
        { id: 'brand', label: 'My colour' }
    ];
    const BADGES = ['', 'NEW IN', 'ON SALE', 'LIMITED STOCK', 'BACK IN STOCK', 'BEST SELLER', 'FRESH TODAY', 'NEW ARRIVALS'];

    const INK = '#0B3B2B', GOLD = '#FFB038', MINT = '#2EDDA2', PAPER = '#F7FAF8';

    // ---- colour ---------------------------------------------------------------------------------------------------
    const lum = (c) => K().helpers.luminance(c);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const mix = (a, b, t) => K().helpers.mix(a, b, t);
    const hexOr = (c, d) => K().helpers.hex(c) || d;
    function warm(c) { const [r, g, b] = K().helpers.rgb(c); return r > 190 && g > 130 && b < 130; }   // yellow / orange brands: gold would vanish
    function bestText(bg) { return ratio('#FFFFFF', bg) >= ratio(INK, bg) ? '#FFFFFF' : INK; }

    /** Pulls `color` towards `toward` until it reads at `target`:1 against every colour in `bgs`. */
    function reach(color, bgs, target, toward) {
        let c = color, n = 0;
        while (bgs.some((b) => ratio(c, b) < target) && n++ < 12) c = mix(c, toward, 0.14);
        return c;
    }

    /** First preferred colour that reads at 4.5:1 on every background; otherwise whichever reads best. */
    function pickAccent(bgs, prefs) {
        const worst = (c) => Math.min(...bgs.map((b) => ratio(c, b)));
        const hit = prefs.find((c) => worst(c) >= 4.5);
        if (hit) return hit;
        return prefs.concat(['#FFFFFF', INK]).reduce((best, c) => (worst(c) > worst(best) ? c : best));
    }

    function palette(brandColor, mood) {
        const brand = hexOr(brandColor, '#00B074');
        let P;
        if (mood === 'light') {
            const bg2 = mix(PAPER, brand, 0.14);
            const accent = reach(mix(brand, '#000000', 0.12), [PAPER, bg2], 4.5, '#000000');
            P = { bg1: PAPER, bg2, text: INK, muted: '#52615B', accent, accentText: bestText(accent), ring: accent, ringAlpha: 0.9, dark: false, heroGlow: mix(PAPER, brand, 0.22) };
        } else if (mood === 'brand') {
            // Your colour as the whole background. If neither white nor dark text can read on it, the colour is deepened a step at a time.
            let bg1 = brand, text;
            if (ratio('#FFFFFF', bg1) >= 4.5) text = '#FFFFFF';
            else if (ratio(INK, bg1) >= 4.5) text = INK;
            else { let n = 0; while (ratio('#FFFFFF', bg1) < 4.5 && n++ < 14) bg1 = mix(bg1, '#000000', 0.1); text = '#FFFFFF'; }
            const dark = text === '#FFFFFF', bg2 = dark ? mix(bg1, '#000000', 0.24) : mix(bg1, '#FFFFFF', 0.16);
            const accent = pickAccent([bg1, bg2], dark ? [GOLD, '#FFFFFF'] : [INK]);
            const muted = reach(dark ? mix(bg1, '#FFFFFF', 0.82) : mix(bg1, INK, 0.8), [bg1, bg2], 4.5, text);
            P = { bg1, bg2, text, muted, accent, accentText: bestText(accent), ring: dark ? '#FFFFFF' : INK, ringAlpha: 0.6, dark, heroGlow: mix(bg1, '#FFFFFF', 0.2) };
        } else {
            let bg1 = mix(brand, '#04140E', 0.62), bg2 = mix(brand, '#031510', 0.8), n = 0;
            while (ratio('#FFFFFF', bg1) < 7 && n++ < 10) { bg1 = mix(bg1, '#000000', 0.15); bg2 = mix(bg2, '#000000', 0.15); }
            const accent = pickAccent([bg1, bg2], [warm(brand) ? MINT : GOLD, GOLD, MINT]);
            P = { bg1, bg2, text: '#FFFFFF', muted: reach(mix(bg1, '#FFFFFF', 0.78), [bg1, bg2], 4.5, '#FFFFFF'), accent, accentText: bestText(accent), ring: accent, ringAlpha: 0.95, dark: true, heroGlow: mix(bg1, '#FFFFFF', 0.1) };
        }
        P.brand = brand;
        P.card = '#FFFFFF'; P.cardInk = INK; P.cardMuted = '#52615B';
        P.cardAccent = reach(P.accent, ['#FFFFFF'], 4.5, INK);
        P.brandOnCard = reach(brand, ['#FFFFFF'], 4.5, '#000000');
        return P;
    }

    // ---- small drawing helpers ------------------------------------------------------------------------------------
    const money = (n) => Math.round(Number(n || 0)).toLocaleString('en-UG');
    const iw = (i) => i.naturalWidth || i.width, ih = (i) => i.naturalHeight || i.height;
    function loadImage(src) {
        if (!src) return Promise.resolve(null);
        if (typeof src !== 'string') return Promise.resolve(src);
        return K().helpers.loadImageSafe(src);          // direct, then through /api/media/proxy; never hangs
    }
    function gradient(ctx, x0, y0, x1, y1, stops) { const g = ctx.createLinearGradient(x0, y0, x1, y1); stops.forEach(([t, c]) => g.addColorStop(t, c)); return g; }
    function withAlpha(hex, a) { const [r, g, b] = K().helpers.rgb(hex); return `rgba(${r},${g},${b},${a})`; }

    /** Fit text into maxW x maxLines, and tell the report if it had to shrink a lot or be cut off. */
    function fitText(rep, id, label, ctx, text, weight, size, min, maxW, maxLines, legible) {
        const f = K().helpers.fit(ctx, text, weight, size, min, maxW, maxLines);
        const cut = f.lines.length && /…$/.test(f.lines[f.lines.length - 1]) && !/…$/.test(String(text));
        if (cut) rep.truncated.push(id);
        if (f.size < size) rep.shrunk.push({ id, label, from: size, to: f.size, min: legible || min });
        return f;
    }
    function text(ctx, s, x, y, o) {
        ctx.font = K().helpers.font(o.weight || 400, o.size); ctx.fillStyle = o.color; ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'alphabetic';
        ctx.fillText(s, x, y);
    }
    function lines(ctx, ls, x, y, lh, o) { ls.forEach((l, i) => text(ctx, l, x, y + i * lh, o)); return y + ls.length * lh; }
    function track(rep, bg, fg) { const r = ratio(bg, fg); if (rep.contrast == null || r < rep.contrast) rep.contrast = Math.round(r * 100) / 100; }

    /** The open ring and dot from the NextaStore mark, used large and soft behind the product. */
    function ring(ctx, cx, cy, r, P, bold) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = withAlpha(P.ring, 0.14 * (P.ringAlpha)); ctx.lineWidth = r * 0.02;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.16, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = withAlpha(P.ring, P.ringAlpha * (bold ? 0.6 : 0.5)); ctx.lineWidth = r * 0.04;
        const a0 = -Math.PI * 0.18, a1 = Math.PI * 1.32;                    // open at the upper right, like the logo
        ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1, false); ctx.stroke();
        const dx = cx + r * Math.cos(a0 - 0.12), dy = cy + r * Math.sin(a0 - 0.12);
        ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(dx, dy, r * 0.055, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
    /** Little ring mark for the plate. */
    function miniMark(ctx, cx, cy, r, color, dot) {
        ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.lineWidth = r * 0.34;
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI * 0.2, Math.PI * 1.3); ctx.stroke();
        ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(cx + r * 0.78, cy - r * 0.5, r * 0.26, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    function seal(ctx, cx, cy, r, label, sub, P, rep) {
        const bumps = 14, inner = r * 0.9;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = r * 0.25; ctx.shadowOffsetY = r * 0.08;
        ctx.beginPath();
        for (let i = 0; i <= 360; i += 2) { const a = (i * Math.PI) / 180, rr = inner + (r - inner) * (0.5 + 0.5 * Math.cos(a * bumps)); const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.fillStyle = GOLD; ctx.fill(); ctx.restore();
        const col = INK; track(rep, GOLD, col);
        const f = K().helpers.fit(ctx, label, 700, r * 0.62, r * 0.3, r * 1.45, 1);
        text(ctx, f.lines[0], cx, cy + f.size * 0.12, { size: f.size, weight: 700, color: col, align: 'center' });
        if (sub) text(ctx, sub, cx, cy + r * 0.52, { size: r * 0.26, weight: 700, color: col, align: 'center' });
    }
    function badgePill(ctx, label, rightX, y, P, rep) {
        if (!label) return 0;
        const size = 26; ctx.font = K().helpers.font(700, size);
        const w = ctx.measureText(label).width + size * 1.7, h = size * 2.1;
        K().helpers.rr(ctx, rightX - w, y, w, h, h / 2); ctx.fillStyle = P.accent; ctx.fill();
        track(rep, P.accent, P.accentText);
        text(ctx, label, rightX - w / 2, y + h / 2 + size * 0.04, { size, weight: 700, color: P.accentText, align: 'center', base: 'middle' });
        return w;
    }

    // ---- heroes ---------------------------------------------------------------------------------------------------
    /** A cut-out product: sits on a soft pool of light with a ground shadow, inside the ring. */
    function heroCutout(ctx, img, box, P) {
        const pad = Math.min(box.w, box.h) * 0.05, aw = box.w - pad * 2, ah = box.h - pad * 2;
        const s = Math.min(aw / iw(img), ah / ih(img)), w = iw(img) * s, h = ih(img) * s;
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2, x = cx - w / 2, y = cy - h / 2 - box.h * 0.01;
        ring(ctx, cx, cy, Math.min(box.w, box.h) * 0.41, P, true);
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(box.w, box.h) * 0.42);
        glow.addColorStop(0, withAlpha(P.heroGlow, 0.85)); glow.addColorStop(1, withAlpha(P.heroGlow, 0));
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, Math.min(box.w, box.h) * 0.42, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(cx, y + h + h * 0.012); ctx.scale(1, 0.14);
        const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(40, w * 0.42)); sh.addColorStop(0, 'rgba(0,0,0,.42)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, Math.max(40, w * 0.42), 0, Math.PI * 2); ctx.fill(); ctx.restore();
        ctx.save(); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, x, y, w, h); ctx.restore();
        return s;
    }
    /** A photo: an arch window with a white edge and a gold line inside it. */
    function heroPhoto(ctx, img, box, P) {
        const w = Math.min(box.w, box.h * 0.86), h = Math.min(box.h, w / 0.86), x = box.x + (box.w - w) / 2, y = box.y + (box.h - h) / 2;
        const archPath = (px, py, pw, ph, r) => { ctx.beginPath(); ctx.moveTo(px, py + ph - 36); ctx.lineTo(px, py + pw / 2); ctx.arc(px + pw / 2, py + pw / 2, pw / 2, Math.PI, 0); ctx.lineTo(px + pw, py + ph - 36); ctx.arcTo(px + pw, py + ph, px + pw - 36, py + ph, 36); ctx.lineTo(px + 36, py + ph); ctx.arcTo(px, py + ph, px, py + ph - 36, 36); ctx.closePath(); };
        ring(ctx, x + w / 2, y + h / 2, Math.min(w, h) * 0.55, P, false);
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.32)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14; archPath(x, y, w, h); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.restore();
        const b = Math.max(10, w * 0.022);
        ctx.save(); archPath(x + b, y + b, w - b * 2, h - b * 2); ctx.clip();
        const s = Math.max((w - b * 2) / iw(img), (h - b * 2) / ih(img)), dw = iw(img) * s, dh = ih(img) * s;
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
        ctx.save(); archPath(x + b * 2.1, y + b * 2.1, w - b * 4.2, h - b * 4.2); ctx.strokeStyle = withAlpha(GOLD, 0.9); ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
        return s;
    }

    // ---- store pieces ---------------------------------------------------------------------------------------------
    function logoDisc(ctx, logo, name, cx, cy, r, P, show) {
        const th = { dark: P.dark, soft: P.dark ? mix(P.bg1, '#FFFFFF', 0.12) : mix(PAPER, '#000000', 0.06), bg: P.bg1, accent: P.accent };
        K().helpers.drawLogo(ctx, show === false ? null : logo, name, cx, cy, r, th);
    }
    function header(ctx, x, y, w, d, assets, P, rep, badgeLabel, hs) {
        const r = hs || 40, cx = x + r, cy = y + r;
        logoDisc(ctx, assets.logo, d.store.name, cx, cy, r, P, d.showLogo);
        const badgeW = badgeLabel ? 40 + (ctx.font = K().helpers.font(700, 26), ctx.measureText(badgeLabel).width) + 20 : 0;
        const maxW = w - r * 2 - 20 - badgeW;
        const f = fitText(rep, 'storeName', 'The store name', ctx, String(d.store.name || 'My Store'), 700, 34, 24, maxW, 1, 24);
        text(ctx, f.lines[0], x + r * 2 + 20, cy + f.size * 0.36, { size: f.size, weight: 700, color: P.text });
        track(rep, P.bg1, P.text);
        if (badgeLabel) badgePill(ctx, badgeLabel, x + w, cy - 27, P, rep);
    }
    /** The rounded "store plate" at the foot: logo, name, how to order, QR. */
    function plate(ctx, x, y, w, h, d, assets, P, rep) {
        const H = K().helpers;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
        H.rr(ctx, x, y, w, h, 34); ctx.fillStyle = P.card; ctx.fill(); ctx.restore();
        const qs = h - 28, qx = x + w - qs - 16, qy = y + 14;
        let qrOk = true;
        try { H.drawQR(ctx, d.store.url, qx, qy, qs, { qrFg: INK }, { fg: INK, radius: 14 }); } catch (e) { qrOk = false; }
        const lr = Math.min(40, h * 0.27), lx = x + 24 + lr;
        logoDisc(ctx, assets.logo, d.store.name, lx, y + h / 2, lr, Object.assign({}, P, { dark: false, bg1: P.brandOnCard, accent: P.cardAccent }), d.showLogo);
        const tx = lx + lr + 22, tw = (qrOk ? qx - 20 : x + w - 20) - tx;
        const nf = fitText(rep, 'plateName', 'The store name', ctx, String(d.store.name || 'My Store'), 700, 34, 22, tw, 1, 22);
        const contact = d.showPhone && d.store.phone ? d.store.phone : (d.cta || 'Scan to order');
        const cf = fitText(rep, 'plateLine', 'The contact line', ctx, contact, 400, 26, 20, tw, 1, 20);
        const uf = fitText(rep, 'plateUrl', 'The store link', ctx, H.urlLabel(d.store.url), 700, 24, 16, tw, 1, 16);
        const total = 34 + 14 + 26 + 10 + 24, top = y + (h - total) / 2;
        text(ctx, nf.lines[0], tx, top + 30, { size: nf.size, weight: 700, color: P.cardInk });
        text(ctx, cf.lines[0], tx, top + 30 + 14 + 24, { size: cf.size, weight: 400, color: P.cardMuted });
        text(ctx, uf.lines[0], tx, top + 30 + 14 + 24 + 10 + 22, { size: uf.size, weight: 700, color: P.brandOnCard });
        track(rep, '#FFFFFF', P.cardMuted); track(rep, '#FFFFFF', P.brandOnCard);
    }

    // ---- price tag ------------------------------------------------------------------------------------------------
    /** A paper tag with two punched holes. Returns its height. */
    function priceTag(ctx, rect, p, P, rep, o) {
        o = o || {}; const H = K().helpers, price = Number(p.price), orig = Number(p.originalPrice);
        const disc = orig > price && price > 0 ? Math.round(((orig - price) / orig) * 100) : 0;
        const h = rect.h;
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
        H.rr(ctx, rect.x, rect.y, rect.w, h, 28); ctx.fillStyle = P.card; ctx.fill(); ctx.restore();
        ctx.save(); ctx.fillStyle = P.dark ? P.bg1 : P.bg2; for (const hy of [0.3, 0.7]) { ctx.beginPath(); ctx.arc(rect.x + 20, rect.y + h * hy, 6, 0, Math.PI * 2); ctx.fill(); } ctx.restore();
        const lx = rect.x + 52, rightPad = (disc >= 5 && o.sealInside ? 150 : 28);
        if (!(price > 0)) {
            const f = fitText(rep, 'price', 'The price', ctx, 'Message us for the price', 700, 38, 26, rect.w - 80, 2, 26);
            lines(ctx, f.lines, lx, rect.y + h / 2 - (f.lines.length - 1) * f.size * 0.55 + f.size * 0.35, f.size * 1.15, { size: f.size, weight: 700, color: P.cardInk });
            return;
        }
        const showWas = disc >= 5, hasRight = showWas && o.was !== false;
        const leftW = hasRight ? rect.w * 0.56 : rect.w - 52 - rightPad;
        const amount = money(price);
        text(ctx, 'UGX', lx, rect.y + h * 0.32, { size: 24, weight: 700, color: P.cardMuted });
        const f = fitText(rep, 'price', 'The price', ctx, amount, 700, o.big || 76, 40, leftW - 8, 1, 46);
        text(ctx, f.lines[0], lx, rect.y + h * 0.32 + f.size * 0.98, { size: f.size, weight: 700, color: P.cardInk });
        track(rep, '#FFFFFF', P.cardInk);
        if (hasRight) {
            const dx = rect.x + rect.w * 0.6;
            ctx.save(); ctx.strokeStyle = '#C1D0CA'; ctx.lineWidth = 3; ctx.setLineDash([2, 10]); ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(dx - 22, rect.y + 24); ctx.lineTo(dx - 22, rect.y + h - 24); ctx.stroke(); ctx.restore();
            text(ctx, 'WAS', dx, rect.y + h * 0.36, { size: 22, weight: 700, color: P.cardMuted });
            const wf = fitText(rep, 'was', 'The old price', ctx, money(orig), 400, 40, 28, rect.x + rect.w - dx - rightPad + 8, 1, 28);
            text(ctx, wf.lines[0], dx, rect.y + h * 0.36 + wf.size * 1.25, { size: wf.size, weight: 400, color: P.cardMuted });
            const wm = ctx.measureText(wf.lines[0]).width; ctx.strokeStyle = P.cardMuted; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(dx, rect.y + h * 0.36 + wf.size * 0.98); ctx.lineTo(dx + wm, rect.y + h * 0.36 + wf.size * 0.98); ctx.stroke();
        }
        if (!showWas && p.tagNote && o.note !== false) {
            const nf = fitText(rep, 'tagNote', 'The stock note', ctx, p.tagNote, 700, 30, 22, rect.w * 0.34, 1, 22), nx = rect.x + rect.w - 36;
            ctx.font = K().helpers.font(700, nf.size); const nw = ctx.measureText(nf.lines[0]).width;
            ctx.fillStyle = P.brandOnCard; ctx.beginPath(); ctx.arc(nx - nw - 18, rect.y + h / 2, 7, 0, Math.PI * 2); ctx.fill();
            text(ctx, nf.lines[0], nx, rect.y + h / 2 + nf.size * 0.36, { size: nf.size, weight: 700, color: P.brandOnCard, align: 'right' });
        }
        if (showWas && o.sealInside) seal(ctx, rect.x + rect.w - 74, rect.y + h * 0.5, 62, `-${disc}%`, 'OFF', P, rep);
    }

    // ---- layouts ----------------------------------------------------------------------------------------------------
    // ---- long names: limits per design ------------------------------------------------------------------------------
    // Product names on a marketplace run long ("Samsung Galaxy A06 - 6.7" 4GB RAM 64GB ROM 50MP 5000mAh - Black"). A post
    // is read in a second on a phone, so each design sets how much name it has room for: the part before the first
    // " - " is the headline, the rest becomes one quieter line of details, and anything beyond the limits is trimmed
    // at a word. The full name stays on the store; the studio tells the seller when a name was shortened.
    const NAME_RULES = {
        spotlight:  { title: 46, lines: 2, sub: 64 },
        deal:       { title: 40, lines: 2, sub: 56 },
        column:     { title: 34, lines: 3, sub: 40 },
        card:       { title: 40, lines: 2, sub: 0 },
        cardNarrow: { title: 30, lines: 3, sub: 0 }
    };
    function cutWords(s, max) {
        if (s.length <= max) return s;
        let out = '';
        for (const w of s.split(' ')) { const t = out ? out + ' ' + w : w; if (t.length > max - 1) break; out = t; }
        return (out || s.slice(0, max - 1)).replace(/[\s,.;:\-\u2013\u2014|]+$/, '') + '\u2026';
    }
    /** { title, sub, titleCut, subCut }. subMax 0 = this design has no room for details (they are dropped, not an error). */
    function splitName(name, titleMax, subMax) {
        const clean = String(name || '').replace(/\s+/g, ' ').trim(), out = { title: clean, sub: '', titleCut: false, subCut: false };
        if (!clean) return out;
        const parts = clean.split(/\s+[-\u2013\u2014|:]\s+|,\s+/).map((x) => x.trim()).filter(Boolean);
        let title = parts[0] || clean; const rest = parts.slice(1);
        if (title.length > titleMax) { title = cutWords(title, titleMax); out.titleCut = true; rest.length = 0; }
        out.title = title;
        if (subMax > 0 && rest.length) { let sub = rest.join(' \u00B7 '); if (sub.length > subMax) { sub = cutWords(sub, subMax); out.subCut = true; } out.sub = sub; }
        return out;
    }
    function planName(ctx, p, rule, size, subSize, maxW, rep, id) {
        const sn = splitName(p.name, rule.title, rule.sub);
        const f = fitText(rep, id, 'The product name', ctx, sn.title, 700, size, Math.round(size * 0.72), maxW, rule.lines, 40);
        const sf = sn.sub ? fitText(rep, id + ':sub', 'The product details', ctx, sn.sub, 400, subSize, 22, maxW, 1, 22) : null;
        if (sn.titleCut || sn.subCut) rep.shortened.push(id);
        const lh = f.size * 1.16;
        return { f, sf, lh, h: f.lines.length * lh + (sf ? 10 + sf.size * 1.3 : 0) };
    }
    function drawName(ctx, plan, x, y, P, rep) {
        lines(ctx, plan.f.lines, x, y + plan.f.size * 0.92, plan.lh, { size: plan.f.size, weight: 700, color: P.text });
        track(rep, P.bg1, P.text);
        if (plan.sf) { text(ctx, plan.sf.lines[0], x, y + plan.f.lines.length * plan.lh + 10 + plan.sf.size * 0.95, { size: plan.sf.size, weight: 400, color: P.muted }); track(rep, P.bg1, P.muted); }
        return y + plan.h;
    }

    function dealPlan(ctx, w, p, rep, compact) {
        const price = Number(p.price), orig = Number(p.originalPrice);
        const pf = fitText(rep, 'price', 'The price', ctx, money(price), 700, compact ? 96 : 132, 56, w, 1, 56);
        const wasText = orig > price ? `was UGX ${money(orig)}` : '';
        const wf = wasText ? fitText(rep, 'was', 'The old price', ctx, wasText, 400, 32, 22, w - (compact ? 0 : 200), 1, 22) : null;
        return { pf, wf, wasText, h: 26 + pf.size * 1.12 + (wf ? wf.size * 1.5 : 0) + 14 };
    }
    function drawDeal(ctx, x, y, dp, P, rep, label) {
        text(ctx, label || 'NOW  UGX', x, y + 26, { size: 26, weight: 700, color: P.accent }); track(rep, P.bg1, P.accent);
        text(ctx, dp.pf.lines[0], x, y + 26 + dp.pf.size * 0.98, { size: dp.pf.size, weight: 700, color: P.text }); track(rep, P.bg1, P.text);
        let yy = y + 26 + dp.pf.size * 1.12;
        if (dp.wf) {
            text(ctx, dp.wasText, x, yy + dp.wf.size, { size: dp.wf.size, weight: 400, color: P.muted });
            ctx.font = K().helpers.font(400, dp.wf.size); const m = ctx.measureText(dp.wasText).width;
            ctx.strokeStyle = P.muted; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, yy + dp.wf.size * 0.66); ctx.lineTo(x + m, yy + dp.wf.size * 0.66); ctx.stroke();
            track(rep, P.bg1, P.muted);
        }
    }

    function spotlightLayout(ctx, W, H, F, d, assets, P, rep, split) {
        const pad = 56, p = d.products[0], img = assets.products[0], badge = d.badge;
        header(ctx, pad, F.top, W - pad * 2, d, assets, P, rep, badge);
        const footH = split ? 136 : 168, fy = H - F.bottom - footH;
        const deal = d.style === 'deal', disc = Number(p.originalPrice) > Number(p.price) ? Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100) : 0;
        let hero;
        if (split) {
            const colX = pad + 570, colW = W - pad - colX, top = F.top + 112;
            hero = { x: pad, y: top, w: 540, h: fy - top - 16 };
            drawHero(ctx, p, img, hero, P, rep, 0);
            const y = top + 40;
            if (deal) {
                const dp = dealPlan(ctx, colW, p, rep, true); drawDeal(ctx, colX, y, dp, P, rep);
                if (disc >= 5) seal(ctx, hero.x + hero.w - 96, hero.y + 70, 76, `-${disc}%`, 'OFF', P, rep);
                drawName(ctx, planName(ctx, p, NAME_RULES.column, 44, 26, colW, rep, 'name'), colX, y + dp.h, P, rep);
            } else {
                const plan = planName(ctx, p, NAME_RULES.column, 50, 28, colW, rep, 'name');
                drawName(ctx, plan, colX, y, P, rep);
                const ty = y + plan.h + 26;
                priceTag(ctx, { x: colX, y: ty, w: colW, h: 150 }, p, P, rep, { big: 68, was: false, note: false });
                const sub = disc >= 5 ? `Save ${disc}%` : (p.tagNote || '');
                if (sub) { const sf = fitText(rep, 'tagNote', 'The stock note', ctx, sub, 700, 30, 22, colW, 1, 22); text(ctx, sf.lines[0], colX + 4, ty + 150 + 44, { size: sf.size, weight: 700, color: P.accent }); track(rep, P.bg1, P.accent); }
            }
        } else {
            const top = F.top + 124, fullW = W - pad * 2;
            const plan = planName(ctx, p, deal ? NAME_RULES.deal : NAME_RULES.spotlight, deal ? 52 : 58, 30, fullW, rep, 'name');
            const dp = deal ? dealPlan(ctx, fullW, p, rep, false) : null, tagH = 140;
            const infoH = deal ? dp.h + plan.h : plan.h + 18 + tagH, infoTop = fy - 26 - infoH;
            hero = { x: pad, y: top, w: fullW, h: infoTop - top - 8 };
            drawHero(ctx, p, img, hero, P, rep, 0);
            if (deal) {
                if (disc >= 5) seal(ctx, W - pad - 100, hero.y + 100, 100, `-${disc}%`, 'OFF', P, rep);
                drawDeal(ctx, pad, infoTop, dp, P, rep);
                drawName(ctx, plan, pad, infoTop + dp.h, P, rep);
            } else {
                drawName(ctx, plan, pad, infoTop, P, rep);
                priceTag(ctx, { x: pad, y: infoTop + plan.h + 18, w: fullW, h: tagH }, p, P, rep, { big: 84, sealInside: true });
            }
        }
        plate(ctx, pad, fy, W - pad * 2, footH, d, assets, P, rep);
    }

    // ---- arch & price drop (added next to the original designs) -----------------------------------------------------
    function archPath(ctx, x, y, w, h) { const r = w / 2; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath(); }
    /** The product stands in a tall arch window, with a dotted outline and a paper price tag tilted over its corner. */
    // The same layout in three shapes: the arch window, a round frame (echoes the logo's ring) and a soft rounded card.
    const FRAME_ASPECT = { arch: 0.86, round: 1, soft: 0.9 };
    function framePath(ctx, shape, x, y, w, h, grow) {
        const g = grow || 0;
        if (shape === 'round') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2 + g, h / 2 + g, 0, 0, Math.PI * 2); ctx.closePath(); }
        else if (shape === 'soft') K().helpers.rr(ctx, x - g, y - g, w + g * 2, h + g * 2, 64 + g);
        else archPath(ctx, x - g, y - g, w + g * 2, h + g);
    }
    function archLayout(ctx, W, H, F, d, assets, P, rep, shape) {
        shape = shape || 'arch'; const asp = FRAME_ASPECT[shape];
        const pad = 56, p = d.products[0], img = assets.products[0], fullW = W - pad * 2, sq = F.id === 'square';
        header(ctx, pad, F.top, fullW, d, assets, P, rep, d.badge);
        const footH = sq ? 128 : 168, fy = H - F.bottom - footH;
        const plan = planName(ctx, p, NAME_RULES.spotlight, sq ? 44 : 58, 28, fullW, rep, 'name');
        const top = F.top + 112, infoTop = fy - 26 - plan.h, availH = infoTop - top - 14;
        const aw = Math.min(fullW * (sq ? 0.5 : 0.66), availH * asp), ah = Math.min(availH, aw / asp), ax = (W - aw) / 2, ay = top + (availH - ah) / 2;
        ctx.save(); ctx.setLineDash([2, 14]); ctx.lineCap = 'round'; ctx.strokeStyle = withAlpha(P.ring, P.ringAlpha * 0.55); ctx.lineWidth = 4;
        framePath(ctx, shape, ax, ay, aw, ah, 26); ctx.stroke(); ctx.restore();
        ctx.save(); framePath(ctx, shape, ax, ay, aw, ah, 0); ctx.fillStyle = P.dark ? mix(P.bg1, '#FFFFFF', 0.12) : mix(P.bg2, P.brand, 0.14); ctx.fill(); ctx.clip();
        if (img) {
            if (p.mode === 'cutout') {
                const s = Math.min((aw * 0.8) / iw(img), (ah * 0.78) / ih(img)), w = iw(img) * s, h = ih(img) * s, x = ax + (aw - w) / 2, y = ay + ah * 0.52 - h / 2;
                ctx.fillStyle = withAlpha('#000000', 0.12); ctx.beginPath(); ctx.ellipse(ax + aw / 2, y + h + 6, w * 0.4, 14, 0, 0, Math.PI * 2); ctx.fill();
                ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, x, y, w, h); rep.upscale[0] = Math.round(s * 100) / 100;
            } else {
                const s = Math.max(aw / iw(img), ah / ih(img)); ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, ax + (aw - iw(img) * s) / 2, ay + (ah - ih(img) * s) / 2, iw(img) * s, ih(img) * s); rep.upscale[0] = Math.round(s * 100) / 100;
            }
        } else rep.upscale[0] = 99;
        ctx.restore();
        const tw = Math.min(360, fullW * 0.42), th = 128;
        ctx.save(); ctx.translate(ax + aw - tw * 0.62, ay + ah - th * 0.8); ctx.rotate(-0.07);
        priceTag(ctx, { x: 0, y: 0, w: tw, h: th }, p, P, rep, { big: 58, was: false, note: false }); ctx.restore();
        drawName(ctx, plan, pad, infoTop, P, rep);
        plate(ctx, pad, fy, fullW, footH, d, assets, P, rep);
    }
    /** Headline top-left, a big gold seal top-right, the product between, the new price huge with the old one crossed out. */
    function dropLayout(ctx, W, H, F, d, assets, P, rep) {
        const pad = 56, p = d.products[0], img = assets.products[0], fullW = W - pad * 2, sq = F.id === 'square';
        header(ctx, pad, F.top, fullW, d, assets, P, rep, d.badge);
        const footH = sq ? 128 : 168, fy = H - F.bottom - footH;
        const disc = Number(p.originalPrice) > Number(p.price) ? Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100) : 0;
        const top = F.top + 112, colW = disc >= 5 ? fullW * 0.6 : fullW;
        const plan = planName(ctx, p, NAME_RULES.column, sq ? 40 : 56, 26, colW, rep, 'name');
        drawName(ctx, plan, pad, top, P, rep);
        const dp = dealPlan(ctx, fullW, p, rep, sq), infoTop = fy - 22 - dp.h;
        const heroTop = top + Math.max(plan.h, sq ? 130 : 200) + 10, hero = { x: pad, y: heroTop, w: fullW, h: Math.max(220, infoTop - heroTop - 6) };
        drawHero(ctx, p, img, hero, P, rep, 0);
        if (disc >= 5) seal(ctx, W - pad - (sq ? 92 : 128), top + (sq ? 92 : 128), sq ? 92 : 128, `-${disc}%`, 'OFF', P, rep);
        drawDeal(ctx, pad, infoTop, dp, P, rep);
        plate(ctx, pad, fy, fullW, footH, d, assets, P, rep);
    }

    /** The price is the headline: huge number on top, the product under it, the name and store plate at the foot. */
    function boldLayout(ctx, W, H, F, d, assets, P, rep) {
        const pad = 56, p = d.products[0], img = assets.products[0], fullW = W - pad * 2, sq = F.id === 'square';
        header(ctx, pad, F.top, fullW, d, assets, P, rep, d.badge);
        const footH = sq ? 128 : 168, fy = H - F.bottom - footH, top = F.top + 112;
        const dp = dealPlan(ctx, fullW, p, rep, sq), was = Number(p.originalPrice) > Number(p.price);
        drawDeal(ctx, pad, top, dp, P, rep, was ? 'NOW  UGX' : 'UGX');
        const plan = planName(ctx, p, NAME_RULES.spotlight, sq ? 42 : 54, 26, fullW, rep, 'name');
        const infoTop = fy - 22 - plan.h, heroTop = top + dp.h + 10;
        drawHero(ctx, p, img, { x: pad, y: heroTop, w: fullW, h: Math.max(220, infoTop - heroTop - 8) }, P, rep, 0);
        drawName(ctx, plan, pad, infoTop, P, rep);
        plate(ctx, pad, fy, fullW, footH, d, assets, P, rep);
    }

    function drawHero(ctx, p, img, box, P, rep, idx) {
        if (!img) { rep.upscale[idx] = 99; return; }
        const s = (p.mode === 'cutout') ? heroCutout(ctx, img, box, P) : heroPhoto(ctx, img, box, P);
        rep.upscale[idx] = Math.round(s * 100) / 100;       // how many times the photo was stretched to fill its place
    }

    function collectionLayout(ctx, W, H, F, d, assets, P, rep, band) {
        const pad = 56, list = d.products, n = list.length, HH = K().helpers;
        if (band) {         // 'Catalogue': the title sits on a darker band with rounded corners
            const sqb = F.id === 'square', bh = F.top + (sqb ? 168 : 232);
            ctx.save(); ctx.fillStyle = P.dark ? mix(P.bg1, '#000000', 0.28) : mix(P.bg2, '#000000', 0.06);
            HH.rr(ctx, 0, -60, W, bh + 60, 56); ctx.fill(); ctx.restore();
        }
        header(ctx, pad, F.top, W - pad * 2, d, assets, P, rep, '');
        const sq = F.id === 'square', footH = sq ? 128 : 168, fy = H - F.bottom - footH;
        const head = d.badge || 'NEW ARRIVALS';
        let y = F.top + (sq ? 100 : 118);
        const hf = fitText(rep, 'headline', 'The headline', ctx, head, 700, sq ? 54 : 84, 40, W - pad * 2 - 40, 1, 40);
        text(ctx, hf.lines[0], pad, y + hf.size * 0.9, { size: hf.size, weight: 700, color: P.text }); track(rep, P.bg1, P.text);
        ctx.fillStyle = P.accent; HH.rr(ctx, pad, y + hf.size * 1.12, 120, 8, 4); ctx.fill();
        y += hf.size * 1.12 + (sq ? 26 : 40);
        const three = n === 3 && sq, cells = n === 3 && !three ? 4 : n, cols = three ? 3 : (cells <= 2 ? cells : 2), rows = Math.ceil(cells / cols);
        const gap = sq ? 20 : 26, gridH = fy - (sq ? 20 : 26) - y, cw = (W - pad * 2 - gap * (cols - 1)) / cols, ch = (gridH - gap * (rows - 1)) / rows;
        for (let i = 0; i < cells; i++) {
            const c = i % cols, r = Math.floor(i / cols), x = pad + c * (cw + gap), yy = y + r * (ch + gap);
            ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8; HH.rr(ctx, x, yy, cw, ch, 28); ctx.fillStyle = P.card; ctx.fill(); ctx.restore();
            if (i >= n) {           // the "more in store" cell
                miniMark(ctx, x + cw / 2, yy + ch / 2 - 34, 44, P.brandOnCard, P.cardAccent);
                text(ctx, 'More in our store', x + cw / 2, yy + ch / 2 + 50, { size: 30, weight: 700, color: P.cardInk, align: 'center' });
                text(ctx, 'Scan the QR below', x + cw / 2, yy + ch / 2 + 90, { size: 24, weight: 400, color: P.cardMuted, align: 'center' });
                continue;
            }
            const p = list[i], img = assets.products[i];
            const nS = cw < 340 ? 26 : 32, nL = cw < 340 ? 3 : 2, pS = cw < 340 ? 30 : 36, textH = nL * nS * 1.15 + pS + 30, imgBox = { x: x + 14, y: yy + 14, w: cw - 28, h: ch - textH - 22 };
            ctx.save(); HH.rr(ctx, imgBox.x, imgBox.y, imgBox.w, imgBox.h, 20); ctx.clip();
            ctx.fillStyle = mix(P.brandOnCard, '#FFFFFF', 0.9); ctx.fillRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h);
            if (img) {
                if (p.mode === 'cutout') { const s = Math.min((imgBox.w * 0.82) / iw(img), (imgBox.h * 0.86) / ih(img)); ctx.drawImage(img, imgBox.x + (imgBox.w - iw(img) * s) / 2, imgBox.y + (imgBox.h - ih(img) * s) / 2, iw(img) * s, ih(img) * s); rep.upscale[i] = Math.round(s * 100) / 100; }
                else { const s = Math.max(imgBox.w / iw(img), imgBox.h / ih(img)); ctx.drawImage(img, imgBox.x + (imgBox.w - iw(img) * s) / 2, imgBox.y + (imgBox.h - ih(img) * s) / 2, iw(img) * s, ih(img) * s); rep.upscale[i] = Math.round(s * 100) / 100; }
            } else rep.upscale[i] = 99;
            ctx.restore();
            const tx = x + 20, tw = cw - 40, ty = yy + ch - textH + 4;
            const sn = splitName(p.name, nL === 3 ? NAME_RULES.cardNarrow.title : NAME_RULES.card.title, 0); if (sn.titleCut) rep.shortened.push('name:' + i);
            const nf = fitText(rep, 'name:' + i, 'A product name', ctx, sn.title, 700, nS, 22, tw, nL, 22);
            lines(ctx, nf.lines, tx, ty + nf.size * 0.9, nf.size * 1.15, { size: nf.size, weight: 700, color: P.cardInk });
            const price = Number(p.price);
            const label = price > 0 ? `UGX ${money(price)}` : 'Ask for price';
            const pf = fitText(rep, 'price:' + i, 'A price', ctx, label, 700, pS, 22, tw, 1, 22);
            text(ctx, pf.lines[0], tx, yy + ch - 20, { size: pf.size, weight: 700, color: P.brandOnCard });
            if (Number(p.originalPrice) > price && price > 0) {
                const dp = Math.round(((p.originalPrice - price) / p.originalPrice) * 100);
                if (dp >= 5) { const bw = 96, bh = 42; HH.rr(ctx, x + cw - bw - 24 + 6, imgBox.y + 12, bw, bh, 21); ctx.fillStyle = GOLD; ctx.fill(); text(ctx, `-${dp}%`, x + cw - bw / 2 - 18, imgBox.y + 12 + bh / 2 + 1, { size: 26, weight: 700, color: INK, align: 'center', base: 'middle' }); }
            }
        }
        plate(ctx, pad, fy, W - pad * 2, footH, d, assets, P, rep);
    }

    /** The banner as a grey texture, so a banner in one colour never fights the brand colour. (Pixel loop, because canvas filters are missing on iPhone Safari.) */
    function bannerTexture(img) {
        const s = Math.min(1, 480 / iw(img)), w = Math.max(1, Math.round(iw(img) * s)), h = Math.max(1, Math.round(ih(img) * s));
        const c = env.createCanvas(w, h), x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
        try { const d = x.getImageData(0, 0, w, h), a = d.data; for (let i = 0; i < a.length; i += 4) { const g = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]; a[i] = a[i + 1] = a[i + 2] = g; } x.putImageData(d, 0, 0); } catch (e) { /* keep colour */ }
        return c;
    }

    // ---- backdrop ---------------------------------------------------------------------------------------------------
    function backdrop(ctx, W, H, P, banner, show) {
        ctx.fillStyle = gradient(ctx, 0, 0, W * 0.6, H, [[0, P.bg1], [1, P.bg2]]); ctx.fillRect(0, 0, W, H);
        if (banner && show) {
            // the store's own banner, tinted into the background so the post feels like THEIR shop
            // the texture fades to nothing towards the bottom, so there is never a visible edge
            const tex = bannerTexture(banner), s = Math.max(W / iw(tex), (H * 0.5) / ih(tex)), texH = Math.ceil(ih(tex) * s);
            const layer = env.createCanvas(W, texH), lx = layer.getContext('2d');
            lx.drawImage(tex, (W - iw(tex) * s) / 2, 0, iw(tex) * s, ih(tex) * s);
            lx.globalCompositeOperation = 'destination-in';
            const fade = lx.createLinearGradient(0, 0, 0, texH); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(0.55, 'rgba(0,0,0,.55)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
            lx.fillStyle = fade; lx.fillRect(0, 0, W, texH);
            ctx.save(); ctx.globalAlpha = P.dark ? 0.3 : 0.16; ctx.drawImage(layer, 0, 0); ctx.restore();
        }
        ctx.save(); ctx.globalAlpha = P.dark ? 0.045 : 0.05; ctx.fillStyle = P.dark ? '#FFFFFF' : P.brand;
        ctx.beginPath(); ctx.arc(W * 0.96, H * 0.04, W * 0.34, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }

    // ---- public ---------------------------------------------------------------------------------------------------
    async function ensureFonts() { try { if (root.document && root.document.fonts && root.document.fonts.load) await Promise.all([root.document.fonts.load('400 40px Poppins'), root.document.fonts.load('700 40px Poppins')]); } catch (e) { /* system font */ } }

    async function render(canvas, data, opts) {
        opts = opts || {};
        if (!K() || typeof root.NextaQR === 'undefined') throw new Error('The design tools did not load. Refresh the page.');
        if (!data.store || !data.store.url) throw new Error('No store link to put in the QR code');
        const F = FORMATS.find((f) => f.id === data.format) || FORMATS[1];
        const style = data.style || 'spotlight';
        const d = Object.assign({ mood: 'deep', showLogo: true, showBanner: true, showPhone: false }, data, { style });
        if (style !== 'collection' && style !== 'catalogue') d.products = (d.products || []).slice(0, 1); else d.products = (d.products || []).slice(0, 4);
        await ensureFonts();
        const [logo, banner] = await Promise.all([loadImage(d.store.logo), loadImage(d.store.banner)]);
        const assets = { logo, banner, products: await Promise.all(d.products.map((p) => loadImage(p.image))) };
        const scale = opts.scale || 1;
        canvas.width = Math.round(F.w * scale); canvas.height = Math.round(F.h * scale);
        const ctx = canvas.getContext('2d'), P = palette(d.store.color, d.mood);
        const rep = { upscale: [], shrunk: [], truncated: [], shortened: [], contrast: null, assets: { logo: !!d.store.logo && d.showLogo !== false && !logo, banner: !!d.store.banner && d.showBanner !== false && !banner } };
        ctx.save(); ctx.scale(scale, scale);
        backdrop(ctx, F.w, F.h, P, assets.banner, d.showBanner);
        if (style === 'collection') collectionLayout(ctx, F.w, F.h, F, d, assets, P, rep);
        else if (style === 'catalogue') collectionLayout(ctx, F.w, F.h, F, d, assets, P, rep, true);
        else if (style === 'arch') archLayout(ctx, F.w, F.h, F, d, assets, P, rep, 'arch');
        else if (style === 'round') archLayout(ctx, F.w, F.h, F, d, assets, P, rep, 'round');
        else if (style === 'soft') archLayout(ctx, F.w, F.h, F, d, assets, P, rep, 'soft');
        else if (style === 'drop') dropLayout(ctx, F.w, F.h, F, d, assets, P, rep);
        else if (style === 'bold') boldLayout(ctx, F.w, F.h, F, d, assets, P, rep);
        else spotlightLayout(ctx, F.w, F.h, F, d, assets, P, rep, F.id === 'square');
        ctx.restore();
        rep.format = F; rep.palette = { bg: P.bg1, text: P.text, accent: P.accent };
        return rep;
    }

    root.NextaPosts = { STYLES, FORMATS, MOODS, BADGES, render, palette, loadImage, env, _splitName: splitName };
    if (typeof module !== 'undefined' && module.exports) module.exports = root.NextaPosts;
})(typeof window !== 'undefined' ? window : globalThis);
