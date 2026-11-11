/**
 * NextaQuality: the gate between "a seller made a post" and "a seller shared a post".
 *
 * Posts carry the seller's name AND ours, so a blurry, dark, stretched or badly-worded one reflects on both. Three layers:
 *   1. BY CONSTRUCTION  (brand-kit-posts.js): fixed layouts, fitted text, enforced colour contrast, safe margins.
 *      A seller can't drag things around or pick clashing colours, so most bad designs are impossible to make.
 *   2. INPUT CHECKS     (here): is the photo sharp, bright and big enough? is the cutout clean? is the price sane?
 *   3. OUTPUT CHECKS    (here): did any text have to be shrunk or cut off? is every piece of text readable?
 *
 *   await NextaQuality.analysePhoto(img)            -> { w, h, sharp, mean, spread }   (numbers only)
 *   NextaQuality.evaluate(input)                    -> { status, score, items[], canDownload }
 *
 * status:  'ready'    nothing to fix
 *          'fix'      works, but one or more things would make it better   (download allowed, with a nudge)
 *          'blocked'  something would make it look bad; the seller must fix it first (download disabled)
 *
 * Every item = { id, level: 'ok'|'warn'|'block', title, fix }. The wording is for sellers, not engineers.
 * The numeric thresholds are in THRESHOLDS below, in one place, so they can be tuned with real photos.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NextaQuality = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const env = {
        createCanvas(w, h) { const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c; }
    };

    const THRESHOLDS = {
        sharp: { block: 22, warn: 38 },           // edge peak as % of the photo's contrast, at 512px; see analysePhoto
        mean: { block: 60, warn: 90 },           // average brightness 0-255
        spread: { warn: 50 },                    // 5th-to-95th percentile brightness range: low = flat/hazy
        upscale: { block: 1.8, warn: 1.25 },      // how many times a photo must be stretched to fill its place in the post
        minLogoPx: 160,
        discount: { show: 5, suspicious: 90 },   // percent
        contrast: { block: 3.0, warn: 4.5 }      // WCAG ratio for the text we draw
    };

    // ---- measuring a photo ---------------------------------------------------------------------------------------
    /**
     * Looks at a photo and returns plain numbers.
     *   sharp  : how crisp the edges are. We shrink to 512px (so camera resolution doesn't matter), soften sensor noise,
     *            then compare the strongest edges with the photo's own contrast. Blur flattens edge peaks.
     *   mean   : average brightness (0 black ... 255 white)
     *   spread : brightness range between the darkest 5% and lightest 5% (low = foggy, flat, washed out)
     */
    function analysePhoto(source) {
        const w0 = source.naturalWidth || source.width, h0 = source.naturalHeight || source.height;
        if (!w0 || !h0) return null;
        const s = Math.min(1, 512 / Math.max(w0, h0)), w = Math.max(8, Math.round(w0 * s)), h = Math.max(8, Math.round(h0 * s));
        const c = env.createCanvas(w, h), ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(source, 0, 0, w, h);
        let d;
        try { d = ctx.getImageData(0, 0, w, h).data; } catch (e) { return { w: w0, h: h0, unreadable: true }; }
        const g = new Float32Array(w * h), hist = new Uint32Array(256); let sum = 0;
        for (let i = 0; i < w * h; i++) { const y = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; g[i] = y; sum += y; hist[Math.min(255, Math.round(y))]++; }
        // 3x3 soften, then Sobel
        const sm = new Float32Array(w * h);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; sm[i] = (g[i - w - 1] + g[i - w] + g[i - w + 1] + g[i - 1] + g[i] + g[i + 1] + g[i + w - 1] + g[i + w] + g[i + w + 1]) / 9; }
        const mags = new Float32Array((w - 4) * (h - 4)); let en = 0;
        for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
            const i = y * w + x;
            const gx = (sm[i - w + 1] + 2 * sm[i + 1] + sm[i + w + 1]) - (sm[i - w - 1] + 2 * sm[i - 1] + sm[i + w - 1]);
            const gy = (sm[i + w - 1] + 2 * sm[i + w] + sm[i + w + 1]) - (sm[i - w - 1] + 2 * sm[i - w] + sm[i - w + 1]);
            mags[en++] = Math.sqrt(gx * gx + gy * gy) / 4;
        }
        const pct = (hh, total, p) => { let a = 0; for (let i = 0; i < hh.length; i++) { a += hh[i]; if (a >= total * p) return i; } return hh.length - 1; };
        const spread = pct(hist, w * h, 0.95) - pct(hist, w * h, 0.05);
        // Edge peak: the average of the strongest 0.4% of edge pixels, compared with the photo's own contrast.
        // Blur doesn't change contrast, it spreads each edge out, which flattens the peaks.
        const sorted = Float32Array.from(mags.subarray(0, en)).sort();
        const top = Math.max(8, Math.round(en * 0.004)); let topSum = 0;
        for (let i = en - top; i < en; i++) topSum += sorted[i];
        const peak = topSum / top, sharp = Math.round((peak / Math.max(spread, 40)) * 100);
        return { w: w0, h: h0, sharp, mean: sum / (w * h), spread };
    }

    // ---- turning numbers into advice -----------------------------------------------------------------------------
    const money = (n) => Number(n || 0).toLocaleString('en-UG');
    const item = (id, level, title, fix) => ({ id, level, title, fix: fix || '' });

    function checkPhoto(who, info, upscale, out, failed) {
        const tag = who ? `${who}: ` : '';
        if (failed) { out.push(item('photo_failed', 'block', `${tag}We could not load this photo`, 'Check your internet connection and try again, or tap "Use a different photo" to upload it from your phone.')); return; }
        if (!info) { out.push(item('photo_missing', 'block', `${tag}No photo`, 'Pick a product that has a photo, or upload one.')); return; }
        if (info.unreadable) { out.push(item('photo_unreadable', 'block', `${tag}We could not read this photo`, 'Upload the photo again from your phone.')); return; }
        if (info.sharp != null && info.sharp < THRESHOLDS.sharp.block) out.push(item('photo_blurry', 'block', `${tag}The photo is blurry`, 'Hold your phone steady, tap the product on the screen to focus, and take it again in daylight.'));
        else if (info.sharp != null && info.sharp < THRESHOLDS.sharp.warn) out.push(item('photo_soft', 'warn', `${tag}The photo is a little soft`, 'A sharper photo will look much better. Tap to focus before you take it.'));
        if (info.mean != null && info.mean < THRESHOLDS.mean.block) out.push(item('photo_dark', 'block', `${tag}The photo is too dark`, 'Take it near a window or outside in daylight. Avoid the flash.'));
        else if (info.mean != null && info.mean < THRESHOLDS.mean.warn) out.push(item('photo_dim', 'warn', `${tag}The photo is a bit dark`, 'More light makes products look fresher. Try near a window.'));
        else if (info.spread != null && info.spread < THRESHOLDS.spread.warn) out.push(item('photo_flat', 'warn', `${tag}The photo looks flat or hazy`, 'Wipe the camera lens and shoot in clear light.'));
        if (upscale != null && upscale >= THRESHOLDS.upscale.block) out.push(item('photo_small', 'block', `${tag}The photo is too small for this size (${info.w}\u00D7${info.h})`, 'Choose a bigger photo, or pick the Square size, which needs less detail.'));
        else if (upscale != null && upscale >= THRESHOLDS.upscale.warn) out.push(item('photo_stretched', 'warn', `${tag}The photo will look slightly soft at this size`, 'A bigger photo gives a crisper post.'));
    }

    const CUTOUT_ADVICE = {
        cluttered_background: 'The background is too busy to cut out cleanly.',
        busy_background: 'The background is quite busy.',
        low_contrast: 'The product is too close in colour to the background.',
        nothing_found: 'The product is too close in colour to the background.',
        missed_edges: 'Parts of the background are stuck to the product.',
        scattered_shape: 'Parts of the background are stuck to the product.',
        irregular_shape: 'The outline came out uneven.',
        ragged_edge: 'The outline came out jagged.',
        tiny_subject: 'The product is very small in the photo.',
        small_subject: 'The product is small in the photo.',
        product_cut_by_frame: 'The product runs off the edge of the photo.'
    };
    function cutoutReason(reasons) { for (const r of reasons || []) if (CUTOUT_ADVICE[r]) return CUTOUT_ADVICE[r]; return 'The outline was not clean enough.'; }

    function checkPrice(who, p, style, out) {
        const tag = who ? `${who}: ` : '';
        const price = Number(p.price), orig = Number(p.originalPrice);
        if (!(price > 0)) {
            out.push(item('price_missing', style === 'deal' ? 'block' : 'warn', `${tag}No price`, style === 'deal' ? 'The Deal style is built around a price. Add one to the product, or choose Spotlight.' : 'Posts with a price get more messages. Add one to the product.'));
            return;
        }
        if (price >= 1e9) out.push(item('price_huge', 'warn', `${tag}The price looks very large (UGX ${money(price)})`, 'Check the zeros on the product price.'));
        if (style === 'deal') {
            if (!(orig > price)) out.push(item('deal_no_discount', 'block', `${tag}This product has no discount`, 'Deal posts need an old price and a lower new price. Edit the product, or choose Spotlight.'));
            else {
                const pct = Math.round(((orig - price) / orig) * 100);
                if (pct < THRESHOLDS.discount.show) out.push(item('deal_tiny', 'warn', `${tag}The discount is only ${pct}%`, 'Small discounts look weak on a Deal post. Spotlight may suit it better.'));
                if (pct > THRESHOLDS.discount.suspicious) out.push(item('deal_suspicious', 'warn', `${tag}A ${pct}% discount looks like a typing mistake`, 'Please check the old and new prices.'));
            }
        } else if (orig > price) {
            const pct = Math.round(((orig - price) / orig) * 100);
            if (pct > THRESHOLDS.discount.suspicious) out.push(item('deal_suspicious', 'warn', `${tag}A ${pct}% discount looks like a typing mistake`, 'Please check the old and new prices.'));
        }
    }

    /**
     * input = {
     *   style: 'spotlight'|'deal'|'collection', format,
     *   products: [{ name, price, originalPrice, photo: analysePhoto(), mode: 'cutout'|'photo', cutout: result|null, cutoutFellBack: bool }],
     *   store: { logoPx, hasLogo, published },
     *   report: renderPost(...).report   // optional; { upscale:[n], shrunk:[], truncated:[], contrast: number }
     * }
     */
    function evaluate(input) {
        const out = [], list = input.products || [], multi = list.length > 1, style = input.style, rep = input.report || {};
        if (!list.length) out.push(item('no_product', 'block', 'No product chosen', 'Pick a product to make a post for.'));
        if (style === 'collection' && list.length === 1) out.push(item('collection_few', 'block', 'A collection needs at least 2 products', 'Pick 2 to 4 products.'));
        list.forEach((p, i) => {
            const who = multi ? (p.name || `Product ${i + 1}`).slice(0, 26) : '';
            const nameOk = String(p.name || '').trim().length >= 2;
            if (!nameOk) out.push(item('name_missing', 'block', `${who ? who + ': ' : ''}The product has no name`, 'Add a name to the product.'));
            checkPhoto(who, p.photo, rep.upscale ? rep.upscale[i] : null, out, p.photoFailed);
            checkPrice(who, p, style, out);
            if (p.cutoutFellBack) out.push(item('cutout_fallback', 'ok', `${who ? who + ': ' : ''}Shown in a frame instead of a cutout`, `${cutoutReason(p.cutout && p.cutout.reasons)} A plain-coloured background works best for cutouts.`));
            else if (p.mode === 'cutout' && p.cutout && p.cutout.verdict === 'ok') out.push(item('cutout_ok', 'warn', `${who ? who + ': ' : ''}The cutout has small rough spots`, `${cutoutReason(p.cutout.reasons)} Zoom in on the preview and check the edges.`));
        });
        // a name trimmed to fit the design on purpose: say so, but it is not a problem
        const shortened = rep.shortened || [], seen = {};
        shortened.forEach((id) => { const i = id.indexOf(':') > -1 ? Number(id.split(':')[1]) : 0, p = list[i], who = multi && p ? (p.name || '').slice(0, 26) + ': ' : ''; if (seen[id]) return; seen[id] = 1; out.push(item('name_shortened', 'ok', `${who}The name was shortened to fit this design`, 'The full name stays on your store.')); });
        const names = rep.truncated || [];
        names.forEach((id) => out.push(item('text_cut', 'warn', `${id === 'headline' ? 'The headline' : 'A product name'} is too long and was shortened`, 'Use a shorter name for a cleaner post.')));
        (rep.shrunk || []).filter((s) => s.to < s.min).forEach((s) => out.push(item('text_small', 'warn', `${s.label || 'Some text'} had to be made very small`, 'Shorten it so people can read it on a phone.')));
        if (rep.contrast != null && rep.contrast < THRESHOLDS.contrast.block) out.push(item('contrast', 'block', 'Some text would be hard to read on these colours', 'Choose a different colour theme.'));
        else if (rep.contrast != null && rep.contrast < THRESHOLDS.contrast.warn) out.push(item('contrast_low', 'warn', 'Some text is a little faint on these colours', 'A darker or lighter theme will read better.'));

        const s = input.store || {};
        if (s.hasLogo === false) out.push(item('logo_missing', 'warn', 'No store logo', 'Add your logo in Settings so customers recognise your posts.'));
        else if (s.logoPx && s.logoPx < THRESHOLDS.minLogoPx) out.push(item('logo_small', 'warn', 'Your logo is very small and may look fuzzy', 'Upload a bigger logo in Settings.'));
        if (s.logoFailed) out.push(item('logo_failed', 'warn', 'We could not load your logo', 'The post shows your store initials for now. Check your internet connection and try again.'));
        if (s.bannerFailed) out.push(item('banner_failed', 'warn', 'We could not load your banner', 'The post uses your colour only. Check your internet connection and try again.'));
        if (s.published === false) out.push(item('store_draft', 'warn', 'Your store is not live yet', 'The QR code will not work for customers until you launch.'));

        const blocks = out.filter((x) => x.level === 'block').length, warns = out.filter((x) => x.level === 'warn').length;
        const score = Math.max(0, 100 - blocks * 45 - warns * 10);
        const status = blocks ? 'blocked' : warns ? 'fix' : 'ready';
        return { status, score, items: out, canDownload: !blocks, blocks, warns };
    }

    const STATUS_COPY = {
        ready: { label: 'Ready to share', hint: 'This post looks great.' },
        fix: { label: 'Nearly there', hint: 'You can share it, but a quick fix will make it better.' },
        blocked: { label: 'Needs a fix first', hint: 'We hold back posts that would look poor. Fix the red items to unlock Download.' }
    };

    // ---- helpers shared with the renderer --------------------------------------------------------------------------
    function lum(hex) {
        const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
        const f = (i) => { let v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5);
    }
    function contrastRatio(a, b) { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }

    return { analysePhoto, evaluate, contrastRatio, STATUS_COPY, THRESHOLDS, env, _cutoutReason: cutoutReason };
});
