/**
 * NextaCutout: removes the background from a product photo, in the browser, with no upload and no network.
 *
 *   await NextaCutout.remove(source, { strength, pickColor })  -> result (see below)
 *   NextaCutout.trim(result, padPct)                           -> canvas cropped tight around the product
 *   NextaCutout.register('ai', fn)                             -> plug in a machine-learning engine (see bottom)
 *
 * HOW IT WORKS (the "classic" engine)
 *   Product photos are usually taken against a wall, a sheet, a table or the sky. We learn what the background
 *   looks like from the edge of the photo, flood inward from the edges through everything that looks like it,
 *   keep the biggest thing left (the product), then clean and soften the outline.
 *
 * WHY IT RETURNS A CONFIDENCE SCORE
 *   A classical method is excellent on plain backgrounds and unreliable on busy ones. Rather than hand the seller
 *   a ragged cutout, every result is graded 0-100 from objective checks (clutter at the photo edge, strong edges
 *   the cutout left behind, an outline that is too ragged, a subject that is tiny or fills the frame...).
 *   The caller shows "good" results, offers a retry for "ok" ones, and falls back to a framed photo for "poor" ones.
 *
 * result = { ok, canvas, confidence, verdict: 'good'|'ok'|'poor', reasons: [codes], bbox: {x,y,w,h}, stats, mask }
 *   canvas : full-size RGBA canvas, background transparent
 *   bbox   : the product's bounding box in source pixels
 *
 * Works in a browser (document.createElement('canvas')) and in Node with node-canvas
 * (set NextaCutout.env.createCanvas = (w, h) => createCanvas(w, h)).
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NextaCutout = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const env = {
        createCanvas(w, h) { const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c; }
    };
    const engines = {};

    // ---- colour: sRGB -> CIE Lab, so "how different" matches what the eye sees ------------------------------------
    const LIN = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function rgb2lab(r, g, b, out, o) {
        const R = LIN[r], G = LIN[g], B = LIN[b];
        const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
        const y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
        const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const fx = f(x), fy = f(y), fz = f(z);
        out[o] = 116 * fy - 16; out[o + 1] = 500 * (fx - fy); out[o + 2] = 200 * (fy - fz);
    }

    // ---- learn the background from the photo's edge --------------------------------------------------------------
    function kmeans(pts, m, k) {
        // farthest-point start, then a few rounds of "assign, re-average"
        const cent = [[pts[0], pts[1], pts[2]]];
        while (cent.length < k) {
            let best = -1, bestD = -1;
            for (let i = 0; i < m; i += 3) {
                let d = Infinity;
                for (const c of cent) { const dl = pts[i * 3] - c[0], da = pts[i * 3 + 1] - c[1], db = pts[i * 3 + 2] - c[2]; d = Math.min(d, dl * dl + da * da + db * db); }
                if (d > bestD) { bestD = d; best = i; }
            }
            cent.push([pts[best * 3], pts[best * 3 + 1], pts[best * 3 + 2]]);
        }
        const assign = new Uint8Array(m);
        for (let it = 0; it < 8; it++) {
            const sum = cent.map(() => [0, 0, 0, 0]);
            for (let i = 0; i < m; i++) {
                let bi = 0, bd = Infinity;
                for (let c = 0; c < cent.length; c++) { const dl = pts[i * 3] - cent[c][0], da = pts[i * 3 + 1] - cent[c][1], db = pts[i * 3 + 2] - cent[c][2]; const d = dl * dl + da * da + db * db; if (d < bd) { bd = d; bi = c; } }
                assign[i] = bi; const s = sum[bi]; s[0] += pts[i * 3]; s[1] += pts[i * 3 + 1]; s[2] += pts[i * 3 + 2]; s[3]++;
            }
            cent.forEach((c, i) => { const s = sum[i]; if (s[3]) { c[0] = s[0] / s[3]; c[1] = s[1] / s[3]; c[2] = s[2] / s[3]; } });
        }
        const out = cent.map((c) => ({ L: c[0], a: c[1], b: c[2], n: 0, ss: 0 }));
        for (let i = 0; i < m; i++) {
            const c = out[assign[i]], dl = pts[i * 3] - c.L, da = pts[i * 3 + 1] - c.a, db = pts[i * 3 + 2] - c.b;
            c.n++; c.ss += dl * dl + da * da + db * db;
        }
        return out.map((c) => ({ L: c.L, a: c.a, b: c.b, share: c.n / m, spread: c.n ? Math.sqrt(c.ss / c.n) : 0 }));
    }

    function backgroundModel(lab, w, h, pick) {
        if (pick) {
            const o = [0, 0, 0]; rgb2lab(pick.r | 0, pick.g | 0, pick.b | 0, o, 0);
            return { clusters: [{ L: o[0], a: o[1], b: o[2], share: 1, spread: 5 }], misfit: 0, picked: true };
        }
        const band = Math.max(2, Math.round(Math.min(w, h) * 0.025));
        const samples = [];
        for (let y = 0; y < h; y++) {
            const edgeRow = y < band || y >= h - band;
            for (let x = 0; x < w; x++) {
                if (edgeRow || x < band || x >= w - band) { const i = (y * w + x) * 3; samples.push(lab[i], lab[i + 1], lab[i + 2]); }
            }
        }
        const m = samples.length / 3, pts = Float32Array.from(samples);
        let clusters = kmeans(pts, m, 3).filter((c) => c.share >= 0.12);
        if (!clusters.length) clusters = kmeans(pts, m, 1);
        // How much of the edge does NOT look like any one of the clusters? High = a busy, cluttered background.
        let misfit = 0;
        for (let i = 0; i < m; i++) {
            let d = Infinity;
            for (const c of clusters) { const dl = pts[i * 3] - c.L, da = pts[i * 3 + 1] - c.a, db = pts[i * 3 + 2] - c.b; d = Math.min(d, Math.sqrt(dl * dl + da * da + db * db)); }
            if (d > 16) misfit++;
        }
        return { clusters, misfit: misfit / m, picked: false };
    }

    // ---- small image-processing helpers (all on 1-channel arrays) ------------------------------------------------
    function erode(src, w, h) {
        const out = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (src[i] && src[i - 1] && src[i + 1] && src[i - w] && src[i + w]) out[i] = 1;
        }
        return out;
    }
    function dilate(src, w, h) {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (src[i] || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) out[i] = 1;
        }
        return out;
    }
    function boxBlur(src, w, h) {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let s = 0, c = 0;
            for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += src[yy * w + xx]; c++; } }
            out[y * w + x] = Math.round(s / c);
        }
        return out;
    }
    function labelComponents(fg, w, h) {
        const label = new Int32Array(w * h), sizes = [0], stack = new Int32Array(w * h);
        let next = 0;
        for (let s = 0; s < w * h; s++) {
            if (!fg[s] || label[s]) continue;
            next++; let sp = 0, size = 0; stack[sp++] = s; label[s] = next;
            while (sp) {
                const i = stack[--sp]; size++;
                const x = i % w;
                if (x > 0 && fg[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
                if (x < w - 1 && fg[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
                if (i >= w && fg[i - w] && !label[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
                if (i < w * (h - 1) && fg[i + w] && !label[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
            }
            sizes.push(size);
        }
        return { label, sizes, count: next };
    }

    /** Area of the convex hull of a set of points [x0,y0,x1,y1,...] (monotone chain). */
    function hullArea(flat) {
        const pts = []; for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
        pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (pts.length < 3) return 0;
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [], up = [];
        for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
        for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
        const hull = lo.slice(0, -1).concat(up.slice(0, -1)); let a = 0;
        for (let i = 0; i < hull.length; i++) { const p = hull[i], q = hull[(i + 1) % hull.length]; a += p[0] * q[1] - q[0] * p[1]; }
        return Math.abs(a) / 2;
    }

    // ---- the classic engine ---------------------------------------------------------------------------------------
    function classic(data, w, h, opts) {
        const n = w * h, lab = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) rgb2lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);
        const model = backgroundModel(lab, w, h, opts.pickColor);

        // margin < 0  =>  "this pixel looks like the background".  Shadows are darker versions of the background, so a
        // drop in lightness counts for less than a change in colour.
        const strength = Math.min(100, Math.max(1, opts.strength || 50));
        const base = 7 + strength * 0.2;
        const margin = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
            let best = Infinity;
            for (const c of model.clusters) {
                let dl = L - c.L; if (dl < 0) dl *= 0.55;
                const da = a - c.a, db = b - c.b;
                const t = Math.min(40, base + 1.5 * c.spread);
                best = Math.min(best, Math.sqrt(dl * dl + da * da + db * db) - t);
            }
            margin[i] = best;
        }

        // flood in from the edges through everything background-like
        const bg = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
        const seed = (i) => { if (!bg[i] && margin[i] < 0) { bg[i] = 1; stack[sp++] = i; } };
        for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
        while (sp) {
            const i = stack[--sp], x = i % w;
            if (x > 0) seed(i - 1);
            if (x < w - 1) seed(i + 1);
            if (i >= w) seed(i - w);
            if (i < n - w) seed(i + w);
        }
        let fg = new Uint8Array(n);
        for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1;

        // keep the product: the biggest piece, plus any piece that is a real part of it (e.g. a lid beside a jar)
        const comp = labelComponents(fg, w, h);
        let largest = 0; for (let c = 1; c <= comp.count; c++) largest = Math.max(largest, comp.sizes[c]);
        const keepMin = Math.max(largest * 0.12, n * 0.002);
        const totalBefore = comp.sizes.reduce((a, b) => a + b, 0);
        const keep = new Uint8Array(comp.count + 1); for (let c = 1; c <= comp.count; c++) keep[c] = comp.sizes[c] >= keepMin ? 1 : 0;
        let fgCount = 0;
        for (let i = 0; i < n; i++) { if (fg[i] && !keep[comp.label[i]]) fg[i] = 0; if (fg[i]) fgCount++; }

        // enclosed pockets that are clearly background (the hole in a mug handle, the gap in a bag strap)
        const pocketSeed = new Uint8Array(n); let pockets = 0;
        for (let i = 0; i < n; i++) pocketSeed[i] = fg[i] && margin[i] < -3 ? 1 : 0;
        const pc = labelComponents(pocketSeed, w, h);
        const minPocket = Math.max(40, n * 0.004);
        for (let c = 1; c <= pc.count; c++) {
            if (pc.sizes[c] < minPocket) continue;
            let sum = 0, sq = 0, cnt = 0;
            for (let i = 0; i < n; i++) if (pc.label[i] === c) { const L = lab[i * 3]; sum += L; sq += L * L; cnt++; }
            const mean = sum / cnt, sd = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
            if (sd > 3.5) continue;                       // has texture or print on it: that is part of the product
            for (let i = 0; i < n; i++) if (pc.label[i] === c) { fg[i] = 0; fgCount--; }
            pockets++;
        }

        // soft, slightly tucked-in outline so no halo of old background survives
        const tucked = erode(erode(fg, w, h), w, h);
        const alphaBin = new Uint8Array(n); for (let i = 0; i < n; i++) alphaBin[i] = tucked[i] ? 255 : 0;
        const alpha = boxBlur(boxBlur(alphaBin, w, h), w, h);

        // ---- grade it --------------------------------------------------------------------------------------------
        const reasons = []; let score = 100;
        const fgRatio = fgCount / n;
        let borderFg = 0, borderN = 0;
        for (let x = 0; x < w; x++) { borderN += 2; borderFg += fg[x] + fg[(h - 1) * w + x]; }
        for (let y = 1; y < h - 1; y++) { borderN += 2; borderFg += fg[y * w] + fg[y * w + w - 1]; }
        borderFg /= borderN;

        // strong edges the cutout left behind (clutter, or parts of the product that were cut off)
        const grown = dilate(dilate(dilate(fg, w, h), w, h), w, h);
        let strong = 0, strongOutside = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const gx = lab[(i + 1) * 3] - lab[(i - 1) * 3], gy = lab[(i + w) * 3] - lab[(i - w) * 3];
            if (gx * gx + gy * gy > 26 * 26) { strong++; if (!grown[i]) strongOutside++; }
        }
        const orphan = strong ? strongOutside / strong : 0;

        // how ragged is the outline? 1 = a perfect circle; clean products sit well below ~2.6
        let perim = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (fg[i] && (!fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w])) perim++; }
        const ragged = fgCount ? perim / (2 * Math.sqrt(Math.PI * fgCount)) : 9;

        // solidity: product area / convex-hull area. Blobs of clutter stuck to the product pull it down.
        const bpts = [];
        for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) { const i = y * w + x; if (fg[i] && (!fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w])) bpts.push(x, y); }
        const hull = bpts.length ? hullArea(bpts) : 0;
        const solidity = hull ? Math.min(1, fgCount / hull) : 0;

        const penalise = (cond, pts, code) => { if (cond) { score -= pts; reasons.push(code); } };
        if (!opts.pickColor) penalise(model.misfit > 0.35, 38, 'cluttered_background');
        else penalise(false, 0, '');
        if (!opts.pickColor && model.misfit > 0.15 && model.misfit <= 0.35) { score -= 14; reasons.push('busy_background'); }
        penalise(fgRatio < 0.04, 75, 'tiny_subject');
        if (fgRatio >= 0.04) penalise(fgRatio < 0.10, 22, 'small_subject');
        penalise(fgRatio > 0.92, 65, 'low_contrast');
        if (fgRatio <= 0.92) penalise(fgRatio > 0.80, 18, 'fills_frame');
        penalise(borderFg > 0.5, 30, 'product_cut_by_frame');
        if (borderFg <= 0.5) penalise(borderFg > 0.3, 12, 'product_touches_edge');
        penalise(orphan > 0.30, 50, 'missed_edges');
        if (orphan <= 0.30) penalise(orphan > 0.12, 16, 'missed_edges');
        penalise(solidity < 0.62, 28, 'scattered_shape');
        if (solidity >= 0.62) penalise(solidity < 0.74, 10, 'irregular_shape');
        penalise(ragged > 3.4, 26, 'ragged_edge');
        if (ragged <= 3.4) penalise(ragged > 2.6, 10, 'rough_edge');
        penalise(comp.count > 0 && largest / Math.max(1, totalBefore) < 0.5, 12, 'scattered');

        // when lots of strong edges were left outside the cutout it is not trustworthy, whatever else scored well
        if (orphan > 0.30) score = Math.min(score, 40);
        const confidence = Math.max(0, Math.min(100, Math.round(score)));
        return {
            alpha, fg, confidence, reasons: reasons.filter(Boolean),
            stats: { fgRatio, borderFg, misfit: model.misfit, orphan, ragged, solidity, pockets, clusters: model.clusters.length, picked: model.picked }
        };
    }

    // ---- public API ----------------------------------------------------------------------------------------------
    function sourceSize(src) { return { w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height }; }
    function verdictOf(c) { return c >= 72 ? 'good' : c >= 48 ? 'ok' : 'poor'; }

    async function remove(source, opts) {
        opts = opts || {};
        const engineName = opts.engine || 'classic';
        const { w: sw, h: sh } = sourceSize(source);
        if (!sw || !sh) return { ok: false, verdict: 'poor', confidence: 0, reasons: ['no_image'] };

        const maxWork = opts.maxWork || 720, s = Math.min(1, maxWork / Math.max(sw, sh));
        const w = Math.max(2, Math.round(sw * s)), h = Math.max(2, Math.round(sh * s));
        const work = env.createCanvas(w, h), wctx = work.getContext('2d');
        wctx.drawImage(source, 0, 0, w, h);
        let img;
        try { img = wctx.getImageData(0, 0, w, h); }
        catch (e) { return { ok: false, verdict: 'poor', confidence: 0, reasons: ['unreadable'], error: e }; }

        // a PNG that is already transparent needs nothing doing
        let clear = 0, edgeN = 0;
        for (let x = 0; x < w; x++) { edgeN += 2; clear += (img.data[x * 4 + 3] < 20) + (img.data[((h - 1) * w + x) * 4 + 3] < 20); }
        if (edgeN && clear / edgeN > 0.6) {
            const out = env.createCanvas(sw, sh); out.getContext('2d').drawImage(source, 0, 0, sw, sh);
            return { ok: true, canvas: out, confidence: 100, verdict: 'good', reasons: ['already_transparent'], bbox: { x: 0, y: 0, w: sw, h: sh }, stats: {} };
        }

        let res;
        if (engineName !== 'classic' && engines[engineName]) {
            // an external engine supplies the alpha; we still grade it the same way
            const alphaFull = await engines[engineName](source, { w, h });
            const a = alphaFull instanceof Uint8Array ? alphaFull : Uint8Array.from(alphaFull);
            const fg = new Uint8Array(w * h); for (let i = 0; i < fg.length; i++) fg[i] = a[i] > 127 ? 1 : 0;
            res = { alpha: a, fg, confidence: 90, reasons: [], stats: { engine: engineName } };
        } else {
            res = classic(img.data, w, h, opts);
        }

        // bounding box of the product (work coordinates -> source pixels)
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (res.alpha[y * w + x] > 100) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) return { ok: false, verdict: 'poor', confidence: 0, reasons: ['nothing_found'], stats: res.stats };
        const bbox = { x: Math.floor(x0 / s), y: Math.floor(y0 / s), w: Math.ceil((x1 - x0 + 1) / s), h: Math.ceil((y1 - y0 + 1) / s) };

        // apply the mask to the full-size photo (the mask is smoothed up to full size by the canvas)
        const mask = env.createCanvas(w, h), mctx = mask.getContext('2d'), md = mctx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) md.data[i * 4 + 3] = res.alpha[i];
        mctx.putImageData(md, 0, 0);
        const out = env.createCanvas(sw, sh), octx = out.getContext('2d');
        octx.drawImage(source, 0, 0, sw, sh);
        octx.globalCompositeOperation = 'destination-in';
        octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
        octx.drawImage(mask, 0, 0, sw, sh);
        octx.globalCompositeOperation = 'source-over';

        const confidence = res.confidence;
        return { ok: true, canvas: out, confidence, verdict: verdictOf(confidence), reasons: res.reasons, bbox, stats: res.stats, mask: { w, h, alpha: res.alpha } };
    }

    /** Crops a cutout tight around the product, leaving padPct (0-0.5) of breathing room on every side. */
    function trim(result, padPct) {
        const p = padPct == null ? 0.04 : padPct, b = result.bbox, src = result.canvas;
        const padX = Math.round(b.w * p), padY = Math.round(b.h * p);
        const x = Math.max(0, b.x - padX), y = Math.max(0, b.y - padY);
        const w = Math.min(src.width - x, b.w + padX * 2), h = Math.min(src.height - y, b.h + padY * 2);
        const out = env.createCanvas(w, h); out.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
        return out;
    }

    /**
     * Plug in a better engine, for example a machine-learning model that returns a per-pixel alpha.
     *   NextaCutout.register('ai', async (source, { w, h }) => Uint8Array(w * h))   // 0 = background, 255 = product
     * Then call remove(img, { engine: 'ai' }). The result is graded and trimmed exactly like the classic engine.
     */
    function register(name, fn) { engines[name] = fn; }

    return { remove, trim, register, env, _classic: classic, _rgb2lab: rgb2lab };
});
