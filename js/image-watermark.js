/* Store watermark for product photos (WIP 49).
 *
 * Stamps one centered lockup onto a photo so a product picture is recognisably that store's and can't be
 * lifted and reused by another one. It is burned into the pixels in the browser when the seller adds a photo
 * (the server has no image library), so it travels with the file everywhere: product page, grids, shared
 * links, saved copies.
 *
 * The design, top to bottom (all centered, all capitals):
 *     [N]  LISTED ON NEXTASTORE          small, widely spaced, with the brand mark
 *     STORE NAME                          large, hollow outlined letters (see-through, so the product shows)
 *     ───────────── ◆ ─────────────      thin rule with a diamond, exactly as wide as the name
 * The outline is two strokes (a thin dark one under a brighter light one) so it reads on both light and dark
 * photos without any filled shape covering the product.
 *
 * Only new photos are stamped, once. Photos already saved on a product are never re-stamped.
 * NextaWatermark.apply(dataUrl, { storeName }) -> Promise<jpeg data URL>
 */
(function () {
    'use strict';
    var LOGO_SRC = 'assets/brand/png/icon/icon-128.png';
    var FONT = 'Poppins, "Segoe UI", Arial, sans-serif';
    var TAGLINE = 'LISTED ON NEXTASTORE';
    var logoPromise = null;

    function loadImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = reject;
            img.src = src;
        });
    }
    function getLogo() {
        if (!logoPromise) logoPromise = loadImage(LOGO_SRC).catch(function () { return null; });
        return logoPromise;
    }
    function shorten(name) {
        name = String(name || '').replace(/\s+/g, ' ').trim();
        return name.length > 24 ? name.slice(0, 23).trim() + '\u2026' : name;
    }

    // Letter-spaced text, measured and drawn one character at a time (canvas letterSpacing isn't everywhere).
    function spacedWidth(ctx, text, spacing) {
        var total = 0;
        for (var i = 0; i < text.length; i++) total += ctx.measureText(text.charAt(i)).width + (i < text.length - 1 ? spacing : 0);
        return total;
    }
    function drawSpaced(ctx, text, x, y, spacing, mode) {
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (mode === 'stroke') ctx.strokeText(ch, x, y); else ctx.fillText(ch, x, y);
            x += ctx.measureText(ch).width + spacing;
        }
    }

    async function apply(dataUrl, opts) {
        opts = opts || {};
        var name = shorten(opts.storeName).toUpperCase() || 'NEXTASTORE';
        var results = await Promise.all([loadImage(dataUrl), getLogo()]);
        var img = results[0], logo = results[1];
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        // Size everything from the store name, then shrink the whole lockup if it's wider than ~72% of the photo.
        var big = Math.max(18, Math.min(w, h) * 0.085);
        ctx.textBaseline = 'alphabetic';
        ctx.font = '700 ' + big + 'px ' + FONT;
        var nameW = spacedWidth(ctx, name, big * 0.06);
        var maxW = w * 0.72;
        if (nameW > maxW) big *= maxW / nameW;
        var minBig = 9;                                         // never let tiny photos produce unreadable specks
        if (big < minBig) big = minBig;

        var sp = big * 0.06;                                    // spacing of the big name
        ctx.font = '700 ' + big + 'px ' + FONT;
        nameW = spacedWidth(ctx, name, sp);

        var small = big * 0.36, smallSp = small * 0.32;
        var iconSize = small * 1.7, iconGap = small * 0.7;
        ctx.font = '600 ' + small + 'px ' + FONT;
        var tagW = spacedWidth(ctx, TAGLINE, smallSp);
        var tagRowW = (logo ? iconSize + iconGap : 0) + tagW;

        // Vertical layout, centered on the photo as one block.
        var rowGap = big * 0.34;
        var blockH = iconSize + rowGap + big * 0.72 + rowGap * 0.9 + 2;
        var top = (h - blockH) / 2;
        var tagCy = top + iconSize / 2;
        var nameBase = top + iconSize + rowGap + big * 0.72;    // 0.72 ~ cap height of Poppins
        var ruleY = nameBase + rowGap * 0.9;
        var cx = w / 2;

        // 1) Tagline row: brand mark + spaced capitals, soft shadow so it holds on any background.
        var rowX = cx - tagRowW / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = small * 0.5;
        if (logo) {
            ctx.globalAlpha = 0.7;
            ctx.drawImage(logo, rowX, top, iconSize, iconSize);
            ctx.globalAlpha = 1;
        }
        ctx.font = '600 ' + small + 'px ' + FONT;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        drawSpaced(ctx, TAGLINE, rowX + (logo ? iconSize + iconGap : 0), tagCy + small * 0.04, smallSp, 'fill');
        ctx.restore();

        // 2) Store name: hollow letters. Dark hairline underneath, light line on top, barely-there fill.
        ctx.font = '700 ' + big + 'px ' + FONT;
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        var nx = cx - nameW / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        drawSpaced(ctx, name, nx, nameBase, sp, 'fill');
        ctx.strokeStyle = 'rgba(0,0,0,0.40)';
        ctx.lineWidth = Math.max(1.6, big * 0.045);
        drawSpaced(ctx, name, nx, nameBase, sp, 'stroke');
        ctx.strokeStyle = 'rgba(255,255,255,0.80)';
        ctx.lineWidth = Math.max(0.9, big * 0.022);
        drawSpaced(ctx, name, nx, nameBase, sp, 'stroke');

        // 3) Rule with a centered diamond, same width as the name.
        var d = big * 0.11, half = nameW / 2;
        function ruleSegments(color, lw) {
            ctx.strokeStyle = color; ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(cx - half, ruleY); ctx.lineTo(cx - d * 2.6, ruleY);
            ctx.moveTo(cx + d * 2.6, ruleY); ctx.lineTo(cx + half, ruleY);
            ctx.stroke();
        }
        function diamond() {
            ctx.beginPath();
            ctx.moveTo(cx, ruleY - d); ctx.lineTo(cx + d, ruleY); ctx.lineTo(cx, ruleY + d); ctx.lineTo(cx - d, ruleY);
            ctx.closePath();
        }
        ruleSegments('rgba(0,0,0,0.35)', Math.max(1.6, big * 0.03));
        ruleSegments('rgba(255,255,255,0.75)', Math.max(0.9, big * 0.015));
        diamond(); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(0.8, big * 0.012); ctx.stroke();

        return canvas.toDataURL('image/jpeg', 0.86);
    }

    window.NextaWatermark = { apply: apply };
})();
