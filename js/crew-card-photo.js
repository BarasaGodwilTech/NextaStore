/**
 * NextaCardPhoto: the Crew ID card photo, checked on the phone before it is sent.
 *
 *   NextaCardPhoto.analyse(file)        -> { w, h, sharp, mean, spread, border, face }   measured from the picture
 *   NextaCardPhoto.rate(stats)          -> { score, level, blocked, checks[] }            pure: numbers in, verdict out
 *   NextaCardPhoto.prepare(file, stats) -> 'data:image/jpeg;base64,...'                   a 3:4 head-and-shoulders crop, 720 x 960
 *   NextaCardPhoto.mount(el, opts)      -> the picker with guide + live rating (used by the join step and the dashboard)
 *
 * What it blocks: only a photo that cannot work on a card (too small, far too dark or washed out, blurred past use).
 * Everything else is advice ("warn"). The server does not judge the picture; a person on the review team does.
 * The face check uses the browser's FaceDetector where it exists (Chrome on Android, some desktops). Elsewhere the
 * check is simply not shown: no guess is made. All thresholds are in T and were set on synthetic pictures, so they
 * need tuning on real photos taken on real phones.
 */
(function (root) {
    'use strict';

    const T = {
        minSide: 360, goodSide: 560,              // shortest side in pixels
        sharpBad: 18, sharpWarn: 45,              // variance of the Laplacian on a 256 px wide copy of the middle of the picture
        darkBad: 38, darkWarn: 80, lightWarn: 205, lightBad: 240,   // mean brightness 0..255
        flatGood: 22, flatWarn: 48,               // spread of brightness along the edges (plain background = low)
        faceMin: 0.16, faceMax: 0.62              // the face's share of the picture width when a face is found
    };
    const OUT_W = 720, OUT_H = 960;

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Numbers in, verdict out. Each check is ok | warn | bad (bad blocks) | na (could not be measured here: not shown). */
    function rate(s) {
        const checks = [];
        const add = (key, label, state, tip) => checks.push({ key, label, state, tip: tip || '' });
        const side = Math.min(s.w, s.h);
        add('size', 'Big enough', side < T.minSide ? 'bad' : side < T.goodSide ? 'warn' : 'ok', side < T.minSide ? 'This photo is too small to print on a card. Take a new one with the phone camera.' : side < T.goodSide ? 'A little small. It will print, but a bigger photo looks better.' : '');
        add('sharp', 'Sharp', s.sharp < T.sharpBad ? 'bad' : s.sharp < T.sharpWarn ? 'warn' : 'ok', s.sharp < T.sharpBad ? 'It is blurred. Hold the phone still, wipe the lens and take it again.' : s.sharp < T.sharpWarn ? 'A little soft. Hold still for a moment before you press.' : '');
        const light = s.mean < T.darkBad ? 'bad' : s.mean > T.lightBad ? 'bad' : s.mean < T.darkWarn || s.mean > T.lightWarn ? 'warn' : 'ok';
        add('light', 'Good light', light, s.mean < T.darkWarn ? (light === 'bad' ? 'It is far too dark. Face a window or step into daylight.' : 'A bit dark. Face a window so the light falls on your face.') : s.mean > T.lightWarn ? (light === 'bad' ? 'It is washed out. Turn away from the bright light or move into shade.' : 'A bit bright. Avoid direct sun on your face.') : '');
        add('background', 'Plain background', s.border > T.flatWarn ? 'warn' : s.border > T.flatGood ? 'warn' : 'ok', s.border > T.flatGood ? 'The background is busy. Stand in front of a plain wall or door.' : '');
        if (s.face) {
            if (!s.face.found) add('face', 'Face in view', 'warn', 'We could not see a face. Look at the camera, with your whole face in the picture.');
            else {
                const share = s.face.width;
                add('face', 'Face in view', 'ok');
                add('framing', 'Framed well', share < T.faceMin ? 'warn' : share > T.faceMax ? 'warn' : Math.abs(s.face.cx - 0.5) > 0.2 ? 'warn' : 'ok', share < T.faceMin ? 'You are too far away. Come closer: head and shoulders.' : share > T.faceMax ? 'You are too close. Move back so your shoulders show.' : Math.abs(s.face.cx - 0.5) > 0.2 ? 'Centre your face in the picture.' : '');
            }
        }
        const bad = checks.filter((c) => c.state === 'bad'), warn = checks.filter((c) => c.state === 'warn');
        const score = Math.max(0, Math.round(100 - bad.length * 45 - warn.length * 14));
        return { score, level: bad.length ? 'poor' : warn.length ? 'ok' : 'good', blocked: bad.length > 0, checks };
    }

    // ---- reading the picture
    async function decode(file) {
        if (!file || !/^image\//.test(file.type || '')) throw new Error('Choose a photo from your camera or gallery.');
        if (file.size > 12 * 1024 * 1024) throw new Error('That photo is too large. Take it again at a lower quality.');
        if (root.createImageBitmap) { try { return await root.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back to <img> */ } }
        return new Promise((res, rej) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('That photo could not be read. Choose another.')); }; im.src = u; });
    }
    const dims = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });
    const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

    function measure(src) {
        const { w, h } = dims(src);
        const sw = 256, sh = Math.max(32, Math.round(256 * h / w));
        const c = canvasOf(sw, sh), x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(src, 0, 0, sw, sh);
        const d = x.getImageData(0, 0, sw, sh).data, g = new Float32Array(sw * sh);
        let sum = 0;
        for (let i = 0, p = 0; i < d.length; i += 4, p++) { g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += g[p]; }
        const mean = sum / g.length;
        // sharpness: variance of a 4-neighbour Laplacian over the middle 60% (where the face is)
        const x0 = Math.floor(sw * 0.2), x1 = Math.ceil(sw * 0.8), y0 = Math.floor(sh * 0.2), y1 = Math.ceil(sh * 0.8);
        let n = 0, s1 = 0, s2 = 0;
        for (let yy = Math.max(1, y0); yy < Math.min(sh - 1, y1); yy++) for (let xx = Math.max(1, x0); xx < Math.min(sw - 1, x1); xx++) {
            const i = yy * sw + xx, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - sw] - g[i + sw];
            s1 += l; s2 += l * l; n++;
        }
        const sharp = n ? s2 / n - (s1 / n) * (s1 / n) : 0;
        // background: how much the brightness varies along the left and right edges and the top (a plain wall is flat)
        const ed = []; const bw = Math.max(4, Math.round(sw * 0.1)), bh = Math.max(4, Math.round(sh * 0.1));
        for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) if (xx < bw || xx >= sw - bw || yy < bh) ed.push(g[yy * sw + xx]);
        const em = ed.reduce((a, b) => a + b, 0) / ed.length, border = Math.sqrt(ed.reduce((a, b) => a + (b - em) * (b - em), 0) / ed.length);
        return { w, h, sharp, mean, border };
    }

    async function findFace(src) {
        if (!root.FaceDetector) return null;
        try {
            const det = new root.FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
            const faces = await det.detect(src); const { w, h } = dims(src);
            if (!faces.length) return { found: false };
            const b = faces.map((f) => f.boundingBox).sort((a, c) => c.width * c.height - a.width * a.height)[0];
            return { found: true, width: b.width / w, cx: (b.x + b.width / 2) / w, cy: (b.y + b.height / 2) / h, count: faces.length };
        } catch (e) { return null; }   // the detector exists but failed: say nothing about faces
    }

    async function analyse(file) {
        const src = await decode(file);
        const s = measure(src); s.face = await findFace(src);
        if (src.close) src.close();
        return s;
    }

    /** A 3:4 crop (centred on the face when one was found, otherwise on the middle, a little high) at 720 x 960. */
    async function prepare(file, stats) {
        const src = await decode(file), { w, h } = dims(src);
        let cw = w, ch = w * OUT_H / OUT_W;
        if (ch > h) { ch = h; cw = h * OUT_W / OUT_H; }
        const f = stats && stats.face && stats.face.found ? stats.face : null;
        let cx = f ? f.cx * w : w / 2, cy = f ? f.cy * h + ch * 0.08 : h * 0.46;
        const sx = Math.min(Math.max(cx - cw / 2, 0), w - cw), sy = Math.min(Math.max(cy - ch / 2, 0), h - ch);
        const c = canvasOf(OUT_W, OUT_H), x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, OUT_W, OUT_H); x.imageSmoothingQuality = 'high';
        x.drawImage(src, sx, sy, cw, ch, 0, 0, OUT_W, OUT_H);
        if (src.close) src.close();
        return c.toDataURL('image/jpeg', 0.86);
    }

    const GUIDE = '<ul class="gp-photoguide" aria-label="How to take the photo"><li><i class="fas fa-sun" aria-hidden="true"></i>Face a window or daylight</li><li><i class="fas fa-square" aria-hidden="true"></i>Stand in front of a plain wall</li><li><i class="fas fa-user" aria-hidden="true"></i>Head and shoulders, look at the camera</li><li><i class="fas fa-glasses" aria-hidden="true"></i>No hat or sunglasses</li></ul>';
    const STATE_ICON = { ok: 'fa-circle-check', warn: 'fa-circle-exclamation', bad: 'fa-circle-xmark' };

    /**
     * The picker. opts: { onChange(state) }   state = { file, stats, rating } or null when cleared
     * Returns { get(): state|null, setExisting(url) }. The picture, the rating bar and the checks update as soon as a photo is chosen.
     */
    function mount(el, opts) {
        opts = opts || {};
        el.innerHTML = `<div class="gp-photo">${GUIDE}
            <label class="gp-photo-pick" for="gpCardPhotoIn"><input class="gp-sr" id="gpCardPhotoIn" type="file" accept="image/*" capture="user">
                <span class="gp-photo-frame" id="gpPhotoFrame" aria-hidden="true"><svg viewBox="0 0 56 72" width="56" height="72"><circle cx="28" cy="26" r="13" fill="#fff" stroke="#566761" stroke-width="2"/><path d="M4 72c0-18 11-28 24-28s24 10 24 28z" fill="#fff" stroke="#566761" stroke-width="2"/></svg></span>
                <span class="gp-up-pill" id="gpPhotoPill">+ Take or choose a photo</span></label>
            <div class="gp-photo-rate" id="gpPhotoRate" hidden aria-live="polite"></div></div>`;
        const $ = (id) => el.querySelector('#' + id);
        let state = null, seq = 0;
        const draw = (rating) => {
            const box = $('gpPhotoRate'); if (!rating) { box.hidden = true; box.innerHTML = ''; return; }
            const label = rating.level === 'good' ? 'Great photo' : rating.level === 'ok' ? 'Good enough, could be better' : 'Please take it again';
            box.hidden = false; box.className = `gp-photo-rate is-${rating.level}`;
            box.innerHTML = `<div class="gp-photo-score"><b>${esc(label)}</b><span>${rating.score}/100</span></div><div class="gp-bar" role="progressbar" aria-valuenow="${rating.score}" aria-valuemin="0" aria-valuemax="100" aria-label="Photo rating"><i style="width:${rating.score}%"></i></div>
                <ul>${rating.checks.map((c) => `<li class="is-${c.state}"><i class="fas ${STATE_ICON[c.state]}" aria-hidden="true"></i><span><b>${esc(c.label)}</b>${c.tip ? `<small>${esc(c.tip)}</small>` : ''}</span></li>`).join('')}</ul>`;
        };
        $('gpCardPhotoIn').addEventListener('change', async () => {
            const f = $('gpCardPhotoIn').files[0], mine = ++seq;
            if (!f) return;
            const box = $('gpPhotoRate'); box.hidden = false; box.className = 'gp-photo-rate'; box.innerHTML = '<p class="gp-muted">Checking your photo…</p>';
            try {
                const stats = await analyse(f); if (mine !== seq) return;
                const rating = rate(stats);
                state = { file: f, stats, rating };
                const frame = $('gpPhotoFrame'), u = URL.createObjectURL(f);
                frame.innerHTML = `<img alt="Your card photo" src="${u}">`; frame.classList.add('is-set'); $('gpPhotoPill').textContent = 'Change photo';
                draw(rating);
            } catch (e) {
                if (mine !== seq) return;
                state = null; draw(null); box.hidden = false; box.className = 'gp-photo-rate is-poor'; box.innerHTML = `<p role="alert">${esc(e.message || 'That photo could not be read. Choose another.')}</p>`;
            }
            if (opts.onChange) opts.onChange(state);
        });
        return { get: () => state, setExisting(url) { const frame = $('gpPhotoFrame'); frame.innerHTML = `<img alt="Your current card photo" src="${url}">`; frame.classList.add('is-set'); $('gpPhotoPill').textContent = 'Change photo'; } };
    }

    root.NextaCardPhoto = { T, rate, analyse, prepare, mount, OUT_W, OUT_H };
}(typeof window !== 'undefined' ? window : globalThis));
