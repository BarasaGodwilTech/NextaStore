/**
 * NextaCrewCard: the Crew ID card, drawn on a canvas so what is on screen is exactly what is saved.
 *
 *   NextaCrewCard.render(canvas, data, { side: 'front'|'back', scale })   draws one side (600 x 940 logical units)
 *   NextaCrewCard.sheet(data, scale)                                      front + back side by side, for saving
 *   NextaCrewCard.mount(el, opts)                                         the dashboard section: card, flip, save, change photo
 *
 * data: { name, rankIndex, rankLabel, areas[], code, link, since, photo (an image or null), unlocked, leads, needed }
 * A locked card shows a blurred photo, a lock and progress toward the target; it has no back (the QR waits for the unlock).
 * The picture is a portrait lanyard badge in the Crew deep green and gold: the photo sits in an open ring with a gold dot,
 * the same mark as the logo. Needs NextaQR (js/growth-qr.js) for the back.
 */
(function (root) {
    'use strict';

    const W = 600, H = 940;
    const C = { deep: '#062A1D', ink: '#0B3B2B', forest: '#0F5A41', gold: '#FFB038', goldSoft: '#FFD88A', white: '#FFFFFF', mint: '#2EDDA2' };
    const FONT = "Poppins, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function rrect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
    /** The largest size (down to min) at which the text fits maxW; if it still does not fit it is cut with an ellipsis. */
    function fit(x, text, maxW, size, min, weight) {
        let s = size; x.font = `${weight} ${s}px ${FONT}`;
        while (s > min && x.measureText(text).width > maxW) { s -= 1; x.font = `${weight} ${s}px ${FONT}`; }
        let t = String(text);
        if (x.measureText(t).width > maxW) { while (t.length > 1 && x.measureText(t + '…').width > maxW) t = t.slice(0, -1); t = t.trimEnd() + '…'; }
        return t;
    }
    const spaced = (x, text, cx, y, gap) => { const chars = [...text]; const w = chars.reduce((a, c) => a + x.measureText(c).width + gap, -gap); let px = cx - w / 2; x.textAlign = 'left'; chars.forEach((c) => { x.fillText(c, px, y); px += x.measureText(c).width + gap; }); };

    function background(x) {
        rrect(x, 0, 0, W, H, 44); x.save(); x.clip();
        const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, C.deep); g.addColorStop(0.55, C.ink); g.addColorStop(1, '#17503C');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        x.strokeStyle = 'rgba(255,176,56,.10)'; x.lineWidth = 3;
        [[560, 880, 190], [560, 880, 250], [40, 60, 120]].forEach(([cx, cy, r]) => { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke(); });
        x.restore();
        // lanyard slot
        rrect(x, 240, 30, 120, 22, 11); x.fillStyle = 'rgba(0,0,0,.45)'; x.fill(); x.strokeStyle = 'rgba(255,255,255,.22)'; x.lineWidth = 2; x.stroke();
    }
    /** The open ring and gold dot: the NextaStore mark. */
    function ringMark(x, cx, cy, r, lw, dotR) {
        x.save(); x.lineCap = 'round'; x.strokeStyle = C.gold; x.lineWidth = lw;
        const a0 = -Math.PI / 2 + 0.5, a1 = a0 + Math.PI * 2 - 0.95;     // a gap in the ring at the top right
        x.beginPath(); x.arc(cx, cy, r, a0, a1); x.stroke();
        const mid = a1 + 0.475; x.fillStyle = C.gold; x.beginPath(); x.arc(cx + Math.cos(mid) * r, cy + Math.sin(mid) * r, dotR, 0, Math.PI * 2); x.fill();
        x.restore();
    }
    function header(x) {
        ringMark(x, 98, 112, 20, 5, 6);
        x.textBaseline = 'alphabetic'; x.textAlign = 'left'; x.fillStyle = C.white; x.font = `800 30px ${FONT}`; x.fillText('NextaStore', 132, 114);
        x.fillStyle = C.gold; x.font = `700 15px ${FONT}`; x.fillText('CREW · FIELD TEAM', 134, 136);
    }
    function medal(x, cx, cy, r, index) {
        const g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r); g.addColorStop(0, '#FFE7B0'); g.addColorStop(1, index >= 2 ? '#E58E00' : '#F2A93A');
        x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = g; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(6,42,29,.55)'; x.stroke();
        x.strokeStyle = C.ink; x.lineWidth = Math.max(3, r / 6); x.lineCap = 'round'; x.lineJoin = 'round';
        const i = Math.max(0, Math.min(3, index | 0));
        if (i === 3) { x.fillStyle = C.ink; x.beginPath(); for (let k = 0; k < 10; k++) { const rr = k % 2 ? r * 0.28 : r * 0.62, a = -Math.PI / 2 + k * Math.PI / 5; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } x.closePath(); x.fill(); return; }
        const n = i === 0 ? 0 : i; if (!n) { x.beginPath(); x.arc(cx, cy, r * 0.32, 0, Math.PI * 2); x.stroke(); return; }
        for (let k = 0; k < n; k++) { const y = cy + (k - (n - 1) / 2) * r * 0.5; x.beginPath(); x.moveTo(cx - r * 0.45, y + r * 0.12); x.lineTo(cx, y - r * 0.2); x.lineTo(cx + r * 0.45, y + r * 0.12); x.stroke(); }
    }
    /** A very soft copy of the photo made without ctx.filter (Safari lacks it): shrink to a few pixels, then stretch back. */
    function blurred(photo) {
        const s = document.createElement('canvas'); s.width = 12; s.height = 16; s.getContext('2d').drawImage(photo, 0, 0, 12, 16); return s;
    }
    function photoCircle(x, cx, cy, r, photo, soft) {
        x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.clip();
        x.fillStyle = '#17503C'; x.fillRect(cx - r, cy - r, r * 2, r * 2);
        if (photo) {
            const src = soft ? blurred(photo) : photo, w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
            const side = Math.min(w, h * 0.78), sx = (w - side) / 2, sy = Math.max(0, Math.min(h - side, h * 0.04));
            x.imageSmoothingQuality = 'high'; x.drawImage(src, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
        } else {
            x.fillStyle = 'rgba(255,255,255,.14)'; x.beginPath(); x.arc(cx, cy - r * 0.18, r * 0.34, 0, Math.PI * 2); x.fill();
            x.beginPath(); x.ellipse(cx, cy + r * 0.78, r * 0.72, r * 0.52, 0, 0, Math.PI * 2); x.fill();
        }
        if (soft) { x.fillStyle = 'rgba(6,42,29,.5)'; x.fillRect(cx - r, cy - r, r * 2, r * 2); }
        x.restore();
    }
    function lock(x, cx, cy, s) {
        x.save(); x.fillStyle = 'rgba(6,42,29,.82)'; x.beginPath(); x.arc(cx, cy, s * 1.05, 0, Math.PI * 2); x.fill(); x.strokeStyle = C.gold; x.lineWidth = 4; x.stroke();
        x.fillStyle = C.gold; rrect(x, cx - s * 0.5, cy - s * 0.12, s, s * 0.78, 8); x.fill();
        x.strokeStyle = C.gold; x.lineWidth = Math.max(5, s * 0.16); x.lineCap = 'round'; x.beginPath(); x.arc(cx, cy - s * 0.12, s * 0.3, Math.PI, 0); x.stroke();
        x.fillStyle = C.ink; x.beginPath(); x.arc(cx, cy + s * 0.2, s * 0.09, 0, Math.PI * 2); x.fill();
        x.restore();
    }
    function band(x, left, right) {
        x.save(); rrect(x, 0, 0, W, H, 44); x.clip(); x.fillStyle = 'rgba(0,0,0,.32)'; x.fillRect(0, H - 104, W, 104); x.restore();
        x.textBaseline = 'alphabetic'; x.textAlign = 'left'; x.fillStyle = C.goldSoft; x.font = `700 13px ${FONT}`; x.fillText(left[0], 44, H - 62);
        x.fillStyle = C.white; x.font = `700 28px ${FONT}`; x.fillText(fit(x, left[1], 250, 28, 18, 700), 44, H - 28);
        x.textAlign = 'right'; x.fillStyle = C.goldSoft; x.font = `700 13px ${FONT}`; x.fillText(right[0], W - 44, H - 62);
        x.fillStyle = C.white; x.font = `600 22px ${FONT}`; x.fillText(fit(x, right[1], 250, 22, 14, 600), W - 44, H - 28);
    }

    function front(x, d) {
        background(x); header(x);
        const cx = W / 2, cy = 372, r = 150;
        photoCircle(x, cx, cy, r, d.photo, !d.unlocked); ringMark(x, cx, cy, r + 24, 7, 10);
        if (!d.unlocked) lock(x, cx, cy, 44);
        x.textBaseline = 'alphabetic'; x.textAlign = 'center'; x.fillStyle = C.white;
        x.fillText(fit(x, d.name || 'Crew member', 500, 46, 26, 800), cx, 604);
        if (d.unlocked) {
            const lab = String(d.rankLabel || 'Trailhead'); x.font = `700 24px ${FONT}`;
            const total = 52 + 12 + x.measureText(lab).width, left = cx - total / 2;   // medal and label centred as a pair
            medal(x, left + 26, 664, 26, d.rankIndex || 0);
            x.textAlign = 'left'; x.fillStyle = C.goldSoft; x.fillText(lab, left + 64, 673);
            x.fillStyle = 'rgba(255,255,255,.18)'; x.fillRect(44, 722, W - 88, 2);
            x.textAlign = 'left'; x.fillStyle = C.gold; x.font = `700 13px ${FONT}`; x.fillText('WORK AREAS', 44, 758);
            const areas = (d.areas || []).slice(0, 3).join('  ·  ') || 'Not set';
            x.fillStyle = C.white; x.font = `600 24px ${FONT}`; x.fillText(fit(x, areas, W - 88, 24, 15, 600), 44, 796);
            band(x, ['CREW ID', d.code || ''], ['MEMBER SINCE', d.since || '']);
        } else {
            const need = d.needed || 5, have = Math.min(d.leads || 0, need);
            x.textAlign = 'center'; x.fillStyle = C.goldSoft; x.font = `700 22px ${FONT}`; x.fillText('Card locked', cx, 668);
            x.fillStyle = 'rgba(255,255,255,.78)'; x.font = `500 19px ${FONT}`; x.fillText(`Log ${need} businesses to unlock it`, cx, 704);
            rrect(x, 80, 744, W - 160, 16, 8); x.fillStyle = 'rgba(255,255,255,.16)'; x.fill();
            if (have) { rrect(x, 80, 744, Math.max(16, (W - 160) * have / need), 16, 8); x.fillStyle = C.gold; x.fill(); }
            x.fillStyle = C.white; x.font = `700 20px ${FONT}`; x.fillText(`${have} of ${need} logged`, cx, 796);
            band(x, ['CREW ID', 'Locked'], ['STATUS', 'In progress']);
        }
    }
    function back(x, d) {
        background(x); header(x);
        const qr = root.NextaQR && d.link ? root.NextaQR.encode(d.link) : null, box = 330, bx = (W - box) / 2, by = 190;
        rrect(x, bx - 22, by - 22, box + 44, box + 44, 28); x.fillStyle = C.white; x.fill();
        if (qr) { const m = qr.modules, n = qr.size, cell = Math.floor(box / (n + 2)), off = (box - cell * n) / 2; x.fillStyle = C.ink; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) x.fillRect(Math.round(bx + off + c * cell), Math.round(by + off + r * cell), cell, cell); }
        x.textBaseline = 'alphabetic'; x.textAlign = 'center'; x.fillStyle = C.white; x.font = `800 34px ${FONT}`; x.fillText('Scan to open your shop', W / 2, 628);
        x.fillStyle = 'rgba(255,255,255,.82)'; x.font = `500 20px ${FONT}`; x.fillText(fit(x, `with ${d.name || 'your Crew member'}'s code`, 500, 20, 14, 500), W / 2, 666);
        x.fillStyle = 'rgba(255,255,255,.16)'; x.fillRect(44, 712, W - 88, 2);
        x.fillStyle = C.goldSoft; x.font = `700 14px ${FONT}`; spaced(x, 'OFFICIAL NEXTASTORE CREW ID', W / 2, 756, 2);
        x.textAlign = 'center';
        x.fillStyle = 'rgba(255,255,255,.72)'; x.font = `500 17px ${FONT}`;
        x.fillText('This card shows the holder is a member of the', W / 2, 792); x.fillText('NextaStore Crew field team.', W / 2, 818);
        band(x, ['CREW ID', d.code || ''], ['WEB', (d.host || 'nextastores.com')]);
    }

    function render(canvas, data, opts) {
        opts = opts || {}; const scale = opts.scale || Math.min(2, root.devicePixelRatio || 1);
        canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
        const x = canvas.getContext('2d'); x.setTransform(scale, 0, 0, scale, 0, 0); x.clearRect(0, 0, W, H);
        (opts.side === 'back' && data.unlocked ? back : front)(x, data);
        return canvas;
    }
    function sheet(data, scale) {
        const a = render(document.createElement('canvas'), data, { side: 'front', scale }), gap = Math.round(40 * scale);
        if (!data.unlocked) return a;
        const b = render(document.createElement('canvas'), data, { side: 'back', scale });
        const c = document.createElement('canvas'); c.width = a.width + gap + b.width; c.height = a.height;
        const x = c.getContext('2d'); x.drawImage(a, 0, 0); x.drawImage(b, a.width + gap, 0);
        return c;
    }
    async function fontsReady() { try { if (document.fonts && document.fonts.load) await Promise.race([Promise.all([document.fonts.load(`800 40px Poppins`), document.fonts.load(`600 20px Poppins`)]), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* system font is fine */ } }
    function loadImage(src) { return new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }); }

    /**
     * The dashboard section.
     * opts: { data (as for render, without photo), photoUrl() -> Promise<blob|null>, replacePhoto(dataUrl) -> Promise, toast(msg), canChange }
     */
    function mount(el, opts) {
        const d = Object.assign({}, opts.data); let side = 'front', photoObj = null, objUrl = null;
        const locked = !d.unlocked;
        el.innerHTML = `<div class="gp-idcard${locked ? ' is-locked' : ''}">
            <div class="gp-idcard-stage"><canvas id="gpIdCanvas" role="img" aria-label="${esc(locked ? 'Your Crew ID card, locked' : 'Your Crew ID card')}"></canvas></div>
            <div class="gp-idcard-side">
                ${locked ? `<p class="gp-muted" id="gpIdLockNote">${d.hasPhoto ? `You have logged <b>${d.leads} of ${d.needed}</b> businesses. Your card unlocks at ${d.needed}, and we tell you the moment it does.` : 'Add your photo so your card is ready the moment it unlocks.'}</p>` : '<p class="gp-muted">Save it to your phone. Show it to shop owners when you visit.</p>'}
                <div class="gp-row">
                    ${locked ? '' : '<button type="button" class="gp-btn is-primary" id="gpIdSave"><i class="fas fa-download" aria-hidden="true"></i> Save to phone</button><button type="button" class="gp-btn" id="gpIdFlip" aria-pressed="false"><i class="fas fa-rotate" aria-hidden="true"></i> Show back</button>'}
                    ${opts.canChange ? '<button type="button" class="gp-btn" id="gpIdChange"><i class="fas fa-camera" aria-hidden="true"></i> Change photo</button>' : ''}
                </div>
                <div id="gpIdChangeBox" hidden></div>
            </div></div>`;
        const $ = (id) => el.querySelector('#' + id), canvas = $('gpIdCanvas');
        const redraw = () => render(canvas, Object.assign({}, d, { photo: photoObj }), { side });
        redraw();
        (async () => {
            await fontsReady(); redraw();
            let blob = null; try { blob = await opts.photoUrl(); } catch (e) { blob = null; }
            if (blob) { objUrl = URL.createObjectURL(blob); photoObj = await loadImage(objUrl); redraw(); }
        })();
        $('gpIdFlip')?.addEventListener('click', (e) => { side = side === 'front' ? 'back' : 'front'; e.currentTarget.setAttribute('aria-pressed', String(side === 'back')); e.currentTarget.lastChild.textContent = side === 'back' ? ' Show front' : ' Show back'; redraw(); });
        $('gpIdSave')?.addEventListener('click', () => {
            const c = sheet(Object.assign({}, d, { photo: photoObj }), 2);
            c.toBlob((b) => { if (!b) { opts.toast && opts.toast('Could not save the card. Try again.'); return; } const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `nextastore-crew-card-${String(d.code || 'id').toLowerCase()}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }, 'image/png');
        });
        $('gpIdChange')?.addEventListener('click', () => {
            const box = $('gpIdChangeBox'); if (!box.hidden) { box.hidden = true; return; }
            box.hidden = false; box.innerHTML = '<div id="gpIdPicker"></div><div class="gp-error" id="gpIdErr" role="alert"></div><div class="gp-row"><button type="button" class="gp-btn is-primary" id="gpIdUse" disabled>Use this photo</button><button type="button" class="gp-btn" id="gpIdCancel">Cancel</button></div>';
            const use = box.querySelector('#gpIdUse'), err = box.querySelector('#gpIdErr');
            const pick = root.NextaCardPhoto.mount(box.querySelector('#gpIdPicker'), { onChange: (s) => { use.disabled = !s || s.rating.blocked; err.textContent = ''; } });
            box.querySelector('#gpIdCancel').onclick = () => { box.hidden = true; box.innerHTML = ''; };
            use.onclick = async () => {
                const s = pick.get(); if (!s || s.rating.blocked) return;
                use.disabled = true; err.textContent = '';
                try {
                    const url = await root.NextaCardPhoto.prepare(s.file, s.stats); await opts.replacePhoto(url);
                    photoObj = await loadImage(url); d.hasPhoto = true; redraw(); box.hidden = true; box.innerHTML = '';
                    const note = $('gpIdLockNote'); if (note) note.innerHTML = `You have logged <b>${d.leads} of ${d.needed}</b> businesses. Your card unlocks at ${d.needed}, and we tell you the moment it does.`;
                    opts.toast && opts.toast('Photo updated.');
                } catch (ex) { err.textContent = ex.message || 'Could not save the photo. Please try again.'; use.disabled = false; }
            };
        });
        return { redraw, destroy() { if (objUrl) URL.revokeObjectURL(objUrl); } };
    }

    root.NextaCrewCard = { render, sheet, mount, W, H };
}(typeof window !== 'undefined' ? window : globalThis));
