/**
 * NextaBrandKit: draws a seller's printable and shareable marketing pieces (poster, counter sign, WhatsApp status,
 * square post, business cards) on a <canvas>, with the store's own QR code on every one. Works offline: the QR
 * comes from js/growth-qr.js (NextaQR) and nothing is fetched except the seller's own logo.
 *
 *   NextaBrandKit.TEMPLATES                       -> [{ id, label, w, h, ... }]
 *   await NextaBrandKit.render(canvas, id, data)  -> draws the template into `canvas` (sets its pixel size)
 *   NextaBrandKit.qrCanvas(url, px, { fg, bg })   -> a plain QR canvas (for the "Download QR" button)
 *   NextaBrandKit.qrSvg(url, { fg, bg })          -> SVG string
 *   NextaBrandKit.pdfFromCanvases([canvas...], { widthMm, heightMm }) -> Blob (application/pdf), one page each
 *   NextaBrandKit.cardSheet(data)                 -> canvas: A4 sheet with 10 business cards + cut marks
 *   NextaBrandKit.canvasToBlob(canvas, type, q)   -> Promise<Blob>
 *
 * data = { name, tagline, phone, url, logo, cta, owner, title, email, theme: { bg, fg, accent }, showPhone, showLogo }
 * Layouts are drawn on a fixed design grid and scaled, so every size stays proportional.
 */
(function (root) {
    'use strict';

    const FONT = "Poppins, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

    const TEMPLATES = [
        { id: 'poster',  group: 'poster', label: 'Poster (A4)',        w: 2480, h: 3508, mm: [210, 297], pdf: true,  file: 'poster-a4' },
        { id: 'sign',    group: 'poster', label: 'Counter sign (A5)',  w: 1748, h: 2480, mm: [148, 210], pdf: true,  file: 'counter-sign-a5' },
        { id: 'story',   group: 'social', label: 'WhatsApp status',    w: 1080, h: 1920, file: 'whatsapp-status' },
        { id: 'square',  group: 'social', label: 'Square post',        w: 1080, h: 1080, file: 'square-post' },
        { id: 'card',    group: 'card',   label: 'Business card',      w: 1050, h: 600,  mm: [88.9, 50.8], file: 'business-card' }
    ];

    // ---- colour helpers -------------------------------------------------------------------------------------
    function hex(c) { return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : null; }
    function rgb(c) { const h = hex(c) || '#0B3B2B'; return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
    function luminance(c) { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
    function isDark(c) { return luminance(c) < 0.38; }
    function mix(a, b, t) { const A = rgb(a), B = rgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
    function themeFrom(data) {
        const t = data.theme || {};
        const bg = hex(t.bg) || '#0B3B2B';
        const dark = isDark(bg);
        return {
            bg, dark,
            fg: hex(t.fg) || (dark ? '#FFFFFF' : '#0B3B2B'),
            // accent is the highlight colour: gold on dark backgrounds, deep green on light ones
            accent: hex(t.accent) || (dark ? '#FFB038' : '#008558'),
            soft: dark ? mix(bg, '#FFFFFF', 0.12) : mix(bg, '#000000', 0.06),
            muted: dark ? mix(bg, '#FFFFFF', 0.72) : mix(bg, '#000000', 0.62),
            qrFg: dark ? mix(bg, '#000000', 0.35) : mix('#0B3B2B', '#000000', 0.2)
        };
    }

    // ---- canvas helpers -------------------------------------------------------------------------------------
    function rr(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function font(weight, size) { return `${weight} ${Math.round(size)}px ${FONT}`; }
    function wrap(ctx, text, maxW) {
        const words = String(text || '').split(/\s+/).filter(Boolean), lines = []; let line = '';
        for (const w of words) {
            const t = line ? line + ' ' + w : w;
            if (ctx.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
        }
        if (line) lines.push(line);
        return lines;
    }
    /** Largest size (from `size` down to `min`) at which `text` fits in `maxW` x `maxLines`. Returns { size, lines }. */
    function fit(ctx, text, weight, size, min, maxW, maxLines) {
        for (let s = size; s >= min; s -= 2) {
            ctx.font = font(weight, s);
            const lines = wrap(ctx, text, maxW);
            if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { size: s, lines };
        }
        ctx.font = font(weight, min);
        let lines = wrap(ctx, text, maxW).slice(0, maxLines);
        const last = lines.length - 1;
        if (last >= 0) { let l = lines[last]; while (l.length > 1 && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1); if (l !== lines[last] || wrap(ctx, text, maxW).length > maxLines) lines[last] = l + '…'; }
        return { size: min, lines };
    }
    function drawLines(ctx, lines, cx, y, lh, align) {
        ctx.textAlign = align || 'center'; ctx.textBaseline = 'alphabetic';
        lines.forEach((l, i) => ctx.fillText(l, cx, y + i * lh));
        return y + lines.length * lh;
    }
    function initials(name) { return String(name || 'N').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'N'; }

    /**
     * Loads an image so it can be drawn into a canvas AND exported. Order:
     *   1. straight from its address with CORS (works when the image host allows it, and for data: / blob: images)
     *   2. through our own image route, /api/media/proxy, for images in our storage bucket (which is on another origin
     *      and usually sends no CORS headers, so a browser will show it but refuses to let a canvas read it)
     * Resolves to an Image, or null if neither works. Each try gives up after 12 seconds, so nothing can hang.
     */
    let imageTimeoutMs = 8000;      // tests shorten this; a real browser reports a failed load straight away
    function tryImage(url, cors) {
        return new Promise((resolve) => {
            const img = new Image(); let done = false;
            const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
            const t = setTimeout(() => end(null), imageTimeoutMs);
            if (cors) img.crossOrigin = 'anonymous';
            img.onload = () => end(img); img.onerror = () => end(null);
            img.src = url;
        });
    }
    const imageCache = new Map();
    function loadImageSafe(src) {
        if (!src) return Promise.resolve(null);
        if (imageCache.has(src)) return imageCache.get(src);
        const p = (async () => {
            if (/^(data|blob):/i.test(src)) return tryImage(src, false);
            const direct = await tryImage(src, true);
            if (direct) return direct;
            const api = (typeof app !== 'undefined' && app && app.apiBaseUrl) || '';   // `app` is a global const, not a window property
            if (!api || !/^https?:/i.test(src)) return null;
            return tryImage(`${String(api).replace(/\/+$/, '')}/media/proxy?u=${encodeURIComponent(src)}`, true);
        })();
        imageCache.set(src, p);
        p.then((v) => {                                      // a failure is remembered for 20 s (so 20 tiles do not each wait out the
        if (!v) { const t = setTimeout(() => imageCache.delete(src), 20000); if (t && t.unref) t.unref(); }   // same dead image), then retried
    });
        return p;
    }
    function loadLogo(src) { return loadImageSafe(src); }
    function drawLogo(ctx, img, name, cx, cy, r, t) {
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
        ctx.fillStyle = t.dark ? '#FFFFFF' : t.soft; ctx.fill();
        if (img) {
            ctx.clip();
            const s = Math.max((r * 2) / img.width, (r * 2) / img.height);
            ctx.drawImage(img, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s);
        } else {
            ctx.fillStyle = t.dark ? mix(t.bg, '#000000', 0.2) : t.bg; ctx.font = font(700, r * 0.82); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(initials(name), cx, cy + r * 0.04);
        }
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.lineWidth = Math.max(2, r * 0.05); ctx.strokeStyle = t.accent; ctx.stroke(); ctx.restore();
    }
    /** Draws the QR with a white quiet zone (4 modules) inside a rounded white card. `size` is the card's side. */
    function drawQR(ctx, url, x, y, size, t, opts = {}) {
        const q = NextaQR.encode(url);
        const quiet = 4, mods = q.size + quiet * 2, cell = Math.floor((size * 100) / mods) / 100;
        ctx.save();
        ctx.fillStyle = '#FFFFFF';
        if (opts.shadow) { ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = size * 0.08; ctx.shadowOffsetY = size * 0.03; }
        rr(ctx, x, y, size, size, opts.radius == null ? size * 0.07 : opts.radius); ctx.fill();
        ctx.restore();
        const inner = cell * mods, ox = x + (size - inner) / 2 + quiet * cell, oy = y + (size - inner) / 2 + quiet * cell;
        ctx.fillStyle = opts.fg || t.qrFg;
        for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.modules[r][c]) ctx.fillRect(Math.round((ox + c * cell) * 100) / 100, Math.round((oy + r * cell) * 100) / 100, cell + 0.6, cell + 0.6);
    }
    function backdrop(ctx, W, H, t, style) {
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.globalAlpha = t.dark ? 0.10 : 0.07; ctx.fillStyle = t.dark ? '#FFFFFF' : t.accent;
        ctx.beginPath(); ctx.arc(W * 0.92, H * 0.06, Math.min(W, H) * 0.34, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(W * 0.04, H * 0.97, Math.min(W, H) * 0.26, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // thin accent band at the very top
        ctx.fillStyle = t.accent; ctx.fillRect(0, 0, W, Math.max(8, H * 0.008));
        if (style === 'footer') { ctx.fillStyle = t.dark ? mix(t.bg, '#000000', 0.25) : t.soft; ctx.fillRect(0, H - H * 0.075, W, H * 0.075); }
    }
    function urlLabel(url) { return String(url || '').replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
    function poweredBy(ctx, W, H, t, size) {
        ctx.font = font(400, size); ctx.fillStyle = t.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Powered by NextaStore', W / 2, H - H * 0.0375);
    }
    function pill(ctx, text, cx, cy, size, t, filled) {
        ctx.font = font(700, size);
        const w = ctx.measureText(text).width + size * 1.8, h = size * 2.1;
        rr(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
        if (filled) { ctx.fillStyle = t.accent; ctx.fill(); ctx.fillStyle = isDark(t.accent) ? '#FFFFFF' : '#0B3B2B'; }
        else { ctx.lineWidth = Math.max(2, size * 0.1); ctx.strokeStyle = t.accent; ctx.stroke(); ctx.fillStyle = t.fg; }
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, cx, cy + size * 0.04);
    }

    // ---- layouts --------------------------------------------------------------------------------------------
    // Poster, counter sign and WhatsApp status share one vertical layout drawn on a 1000-unit-wide grid.
    function verticalLayout(ctx, W, H, d, t, logo, mode) {
        const u = W / 1000;
        backdrop(ctx, W, H, t, 'footer');
        const cx = W / 2, pad = 90 * u, maxW = W - pad * 2;
        const tall = H / W; // 1.414 (A4/A5) or 1.78 (story)
        let y = (mode === 'story' ? 170 : 92) * u;

        if (d.showLogo !== false) { const r = (mode === 'sign' ? 60 : 66) * u; drawLogo(ctx, logo, d.name, cx, y + r, r, t); y += r * 2 + 28 * u; }

        const nameFit = fit(ctx, String(d.name || 'My Store').toUpperCase(), 700, 88 * u, 44 * u, maxW, 2);
        ctx.font = font(700, nameFit.size); ctx.fillStyle = t.fg;
        y = drawLines(ctx, nameFit.lines, cx, y + nameFit.size * 0.9, nameFit.size * 1.12) ;
        if (d.tagline) {
            const tf = fit(ctx, d.tagline, 400, 40 * u, 26 * u, maxW, 2);
            ctx.font = font(400, tf.size); ctx.fillStyle = t.accent;
            y = drawLines(ctx, tf.lines, cx, y + 14 * u + tf.size * 0.8, tf.size * 1.3);
        }

        // QR card sits in the middle of the remaining space
        const footer = H * 0.075;
        const textBlock = (mode === 'story' ? 380 : 345) * u;           // CTA + url + phone under the QR
        const qrMax = Math.min(W - pad * 2, 780 * u);
        const free = H - footer - y - textBlock - 30 * u;
        const qrSize = Math.max(380 * u, Math.min(qrMax, free));
        const qrY = y + Math.max(18 * u, (free - qrSize) / 2) + 8 * u;
        drawQR(ctx, d.url, cx - qrSize / 2, qrY, qrSize, t, { shadow: true, radius: 36 * u });
        y = qrY + qrSize + 70 * u;

        const cta = String(d.cta || 'Scan to shop online').toUpperCase();
        const cf = fit(ctx, cta, 700, 64 * u, 34 * u, maxW, 2);
        ctx.font = font(700, cf.size); ctx.fillStyle = t.fg;
        y = drawLines(ctx, cf.lines, cx, y, cf.size * 1.15);

        ctx.font = font(400, 34 * u); ctx.fillStyle = t.muted; ctx.textAlign = 'center';
        ctx.fillText('Point your phone camera at the code', cx, y + 18 * u);
        y += 30 * u + 56 * u;

        const label = urlLabel(d.url);
        const lf = fit(ctx, label, 700, 40 * u, 24 * u, maxW - 60 * u, 1);
        pill(ctx, lf.lines[0], cx, y, lf.size / (1), t, true);
        y += 92 * u;

        if (d.showPhone && d.phone) {
            ctx.font = font(700, 46 * u); ctx.fillStyle = t.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(d.phone, cx, y);
        }
        poweredBy(ctx, W, H, t, 26 * u);
    }

    function squareLayout(ctx, W, H, d, t, logo) {
        const u = W / 1000;
        backdrop(ctx, W, H, t, 'footer');
        const pad = 70 * u, colW = 440 * u;
        // left: text column
        let y = 100 * u;
        if (d.showLogo !== false) { drawLogo(ctx, logo, d.name, pad + 56 * u, y + 56 * u, 56 * u, t); y += 140 * u; }
        const nf = fit(ctx, String(d.name || 'My Store').toUpperCase(), 700, 84 * u, 44 * u, colW, 3);
        ctx.font = font(700, nf.size); ctx.fillStyle = t.fg;
        y = drawLines(ctx, nf.lines, pad, y + nf.size * 0.9, nf.size * 1.12, 'left');
        if (d.tagline) {
            const tf = fit(ctx, d.tagline, 400, 36 * u, 24 * u, colW, 3);
            ctx.font = font(400, tf.size); ctx.fillStyle = t.accent;
            y = drawLines(ctx, tf.lines, pad, y + 16 * u + tf.size * 0.8, tf.size * 1.3, 'left');
        }
        const cf = fit(ctx, String(d.cta || 'Scan to shop online').toUpperCase(), 700, 48 * u, 28 * u, colW, 2);
        const bottom = H - H * 0.075 - 60 * u;
        ctx.font = font(700, cf.size); ctx.fillStyle = t.fg;
        const label = urlLabel(d.url); const lf = fit(ctx, label, 700, 28 * u, 18 * u, colW, 1);
        let by = bottom - (d.showPhone && d.phone ? 60 * u : 0) - 70 * u - cf.lines.length * cf.size * 1.15;
        drawLines(ctx, cf.lines, pad, by + cf.size * 0.9, cf.size * 1.15, 'left');
        ctx.font = font(700, lf.size); ctx.fillStyle = t.accent; ctx.textAlign = 'left';
        ctx.fillText(lf.lines[0], pad, bottom - (d.showPhone && d.phone ? 60 * u : 0) - 8 * u);
        if (d.showPhone && d.phone) { ctx.font = font(700, 34 * u); ctx.fillStyle = t.fg; ctx.fillText(d.phone, pad, bottom); }
        // right: QR
        const qs = 440 * u; drawQR(ctx, d.url, W - pad - qs, (H - H * 0.075 - qs) / 2, qs, t, { shadow: true, radius: 30 * u });
        poweredBy(ctx, W, H, t, 22 * u);
    }

    function cardFront(ctx, W, H, d, t, logo) {
        const u = W / 1050;
        ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
        ctx.save(); ctx.globalAlpha = t.dark ? 0.10 : 0.07; ctx.fillStyle = t.dark ? '#FFFFFF' : t.accent;
        ctx.beginPath(); ctx.arc(W * 0.98, H * 0.02, H * 0.78, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        ctx.fillStyle = t.accent; ctx.fillRect(0, 0, 18 * u, H);
        const pad = 80 * u, maxW = W - pad * 2 - (d.showLogo !== false ? 150 * u : 0);
        if (d.showLogo !== false) drawLogo(ctx, logo, d.name, W - pad - 60 * u, pad + 50 * u, 56 * u, t);
        let y = 120 * u;
        const owner = d.owner || d.name || 'Your Name';
        const of = fit(ctx, owner, 700, 62 * u, 36 * u, maxW, 1);
        ctx.font = font(700, of.size); ctx.fillStyle = t.fg; y = drawLines(ctx, of.lines, pad, y, 0, 'left') ; y += 0;
        ctx.font = font(400, 30 * u); ctx.fillStyle = t.accent; ctx.textAlign = 'left';
        const sub = [d.title, d.owner ? d.name : ''].filter(Boolean).join(' · ');
        const sf = fit(ctx, sub || d.tagline || '', 400, 30 * u, 22 * u, maxW, 2);
        ctx.font = font(400, sf.size); ctx.fillStyle = t.accent;
        drawLines(ctx, sf.lines, pad, 120 * u + 52 * u, sf.size * 1.3, 'left');
        // contact lines at the bottom
        const rows = [];
        if (d.showPhone && d.phone) rows.push(['phone', d.phone]);
        if (d.email) rows.push(['mail', d.email]);
        rows.push(['web', urlLabel(d.url)]);
        let ry = H - pad - (rows.length - 1) * 54 * u;
        rows.forEach(([k, v]) => {
            ctx.fillStyle = t.accent; ctx.beginPath(); ctx.arc(pad + 9 * u, ry - 10 * u, 8 * u, 0, Math.PI * 2); ctx.fill();
            const f = fit(ctx, v, 400, 32 * u, 20 * u, W - pad * 2 - 40 * u, 1);
            ctx.font = font(400, f.size); ctx.fillStyle = t.fg; ctx.textAlign = 'left'; ctx.fillText(f.lines[0], pad + 40 * u, ry);
            ry += 54 * u;
        });
    }
    function cardBack(ctx, W, H, d, t, logo) {
        const u = W / 1050;
        // back is always light so the QR prints with the best contrast
        const bt = Object.assign({}, t, { bg: '#FFFFFF', dark: false, fg: '#0B3B2B', muted: '#52615B', soft: '#EAF0ED' });
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = t.dark ? t.bg : t.accent; ctx.fillRect(0, H - 22 * u, W, 22 * u);
        const qs = 400 * u, qx = 70 * u, qy = (H - 22 * u - qs) / 2;
        ctx.save(); ctx.fillStyle = '#F7FAF8'; rr(ctx, qx - 10 * u, qy - 10 * u, qs + 20 * u, qs + 20 * u, 30 * u); ctx.fill(); ctx.restore();
        drawQR(ctx, d.url, qx, qy, qs, t, { radius: 24 * u, fg: '#0B3B2B' });
        const tx = qx + qs + 60 * u, maxW = W - tx - 60 * u;
        let y = 150 * u;
        const cf = fit(ctx, String(d.cta || 'Scan to shop'), 700, 58 * u, 34 * u, maxW, 2);
        ctx.font = font(700, cf.size); ctx.fillStyle = '#0B3B2B'; y = drawLines(ctx, cf.lines, tx, y, cf.size * 1.15, 'left');
        const nf = fit(ctx, d.name || '', 700, 34 * u, 22 * u, maxW, 2);
        ctx.font = font(700, nf.size); ctx.fillStyle = bt.dark ? '#0B3B2B' : (t.dark ? mix(t.bg, '#FFB038', 0.0) : t.accent);
        ctx.fillStyle = t.dark ? '#008558' : t.accent;
        y = drawLines(ctx, nf.lines, tx, y + 14 * u + nf.size * 0.6, nf.size * 1.2, 'left');
        ctx.font = font(400, 26 * u); ctx.fillStyle = '#52615B'; ctx.textAlign = 'left';
        drawLines(ctx, wrap(ctx, 'Point your camera at the code to see every product.', maxW), tx, y + 20 * u + 20 * u, 36 * u, 'left');
        const lf = fit(ctx, urlLabel(d.url), 700, 28 * u, 18 * u, maxW, 1);
        ctx.font = font(700, lf.size); ctx.fillStyle = '#0B3B2B'; ctx.fillText(lf.lines[0], tx, H - 70 * u);
    }

    // ---- public API -----------------------------------------------------------------------------------------
    async function ensureFonts() {
        try { if (document.fonts && document.fonts.load) await Promise.all([document.fonts.load(font(400, 40)), document.fonts.load(font(700, 40))]); } catch (e) { /* fall back to system font */ }
    }
    function tpl(id) { const t = TEMPLATES.find((x) => x.id === id); if (!t) throw new Error('Unknown template ' + id); return t; }

    async function render(canvas, id, data, opts = {}) {
        if (typeof NextaQR === 'undefined') throw new Error('QR generator missing');
        if (!data || !data.url) throw new Error('No store link to put in the QR code');
        const T = tpl(id); await ensureFonts();
        const logo = data.showLogo === false ? null : await loadLogo(data.logo);
        const scale = opts.scale || 1; // preview passes <1 for speed; downloads use 1
        canvas.width = Math.round(T.w * scale); canvas.height = Math.round(T.h * scale);
        const ctx = canvas.getContext('2d');
        ctx.save(); ctx.scale(scale, scale);
        const t = themeFrom(data);
        const side = opts.side || 'front';
        if (id === 'card') (side === 'back' ? cardBack : cardFront)(ctx, T.w, T.h, data, t, logo);
        else if (id === 'square') squareLayout(ctx, T.w, T.h, data, t, logo);
        else verticalLayout(ctx, T.w, T.h, data, t, logo, id);
        ctx.restore();
        return canvas;
    }

    function qrCanvas(url, px, o = {}) {
        const q = NextaQR.encode(url), quiet = 4, mods = q.size + quiet * 2, cell = Math.max(1, Math.floor(px / mods));
        const dim = cell * mods, c = document.createElement('canvas'); c.width = c.height = dim;
        const ctx = c.getContext('2d'); ctx.fillStyle = o.bg || '#FFFFFF'; ctx.fillRect(0, 0, dim, dim); ctx.fillStyle = o.fg || '#0B3B2B';
        for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.modules[r][k]) ctx.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
        return c;
    }
    function qrSvg(url, o = {}) {
        const q = NextaQR.encode(url), quiet = 4, dim = q.size + quiet * 2; let d = '';
        for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.modules[r][k]) d += `M${k + quiet} ${r + quiet}h1v1h-1z`;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 12}" height="${dim * 12}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${o.bg || '#FFFFFF'}"/><path d="${d}" fill="${o.fg || '#0B3B2B'}"/></svg>`;
    }

    /** A4 sheet at 300 dpi: 2 columns x 5 rows of 3.5 x 2 inch cards, light cut marks. */
    async function cardSheet(data, side) {
        const W = 2480, H = 3508, cw = 1050, ch = 600, gx = 190, gy = 254;
        const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H;
        const ctx = sheet.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
        const one = document.createElement('canvas'); await render(one, 'card', data, { side });
        for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++) ctx.drawImage(one, gx + c * cw, gy + r * ch);
        ctx.strokeStyle = '#9EADA7'; ctx.lineWidth = 3;
        const mark = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
        for (let c = 0; c <= 2; c++) { const x = gx + c * cw; mark(x, gy - 60, x, gy - 14); mark(x, gy + 5 * ch + 14, x, gy + 5 * ch + 60); }
        for (let r = 0; r <= 5; r++) { const y = gy + r * ch; mark(gx - 60, y, gx - 14, y); mark(gx + 2 * cw + 14, y, gx + 2 * cw + 60, y); }
        return sheet;
    }

    function canvasToBlob(canvas, type, q) {
        return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the file. Try again.'))), type || 'image/png', q));
    }

    // ---- tiny PDF writer: each page is one full-page JPEG ------------------------------------------------------
    async function pdfFromCanvases(canvases, o = {}) {
        const wPt = (o.widthMm || 210) / 25.4 * 72, hPt = (o.heightMm || 297) / 25.4 * 72;
        const enc = new TextEncoder(), parts = []; let size = 0, objs = []; const offsets = [];
        const push = (u8) => { parts.push(u8); size += u8.length; };
        const str = (s) => push(enc.encode(s));
        const jpegs = [];
        for (const c of canvases) { const b = await canvasToBlob(c, 'image/jpeg', 0.92); jpegs.push({ bytes: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height }); }
        const n = canvases.length;
        // object numbers: 1 catalog, 2 pages, then per page: page, content, image
        const pageObj = (i) => 3 + i * 3, contObj = (i) => 4 + i * 3, imgObj = (i) => 5 + i * 3;
        str('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
        const begin = (num) => { offsets[num] = size; str(`${num} 0 obj\n`); };
        begin(1); str('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        begin(2); str(`<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => pageObj(i) + ' 0 R').join(' ')}] >>\nendobj\n`);
        jpegs.forEach((j, i) => {
            begin(pageObj(i)); str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> >> /Contents ${contObj(i)} 0 R >>\nendobj\n`);
            const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`;
            begin(contObj(i)); str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
            begin(imgObj(i)); str(`<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`);
            push(j.bytes); str('\nendstream\nendobj\n');
        });
        const total = 3 + n * 3, xref = size;
        str(`xref\n0 ${total}\n0000000000 65535 f \n`);
        for (let k = 1; k < total; k++) str(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
        str(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
        return new Blob(parts, { type: 'application/pdf' });
    }

    // Drawing helpers, shared with js/brand-kit-posts.js so product posts speak the same visual language as the store posters.
    const helpers = { rr, font, wrap, fit, drawLines, initials, loadLogo, loadImageSafe, setImageTimeout: (ms) => { imageTimeoutMs = ms; }, drawLogo, drawQR, mix, hex, rgb, luminance, isDark, urlLabel, FONT };
    root.NextaBrandKit = { TEMPLATES, render, qrCanvas, qrSvg, cardSheet, pdfFromCanvases, canvasToBlob, themeFrom, isDark, helpers };
})(typeof window !== 'undefined' ? window : globalThis);
