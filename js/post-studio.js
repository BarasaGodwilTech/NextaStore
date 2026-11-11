/**
 * NextaPostStudio: the "Product posts" side of the seller dashboard's Promote section.
 *
 * A seller picks a product, a look and a size; the store's logo, banner, colour, phone and QR are applied
 * automatically (js/brand-kit-posts.js). The studio:
 *   - cuts the background out of a photo when asked (js/nexta-cutout.js) and quietly falls back to a framed photo
 *     if the cutout would not look clean;
 *   - checks the result on every change (js/nexta-quality.js) and DISABLES Download / Share while something would
 *     make the post look poor, saying exactly what to fix;
 *   - writes a caption to go with the picture.
 *
 *   NextaPostStudio.mount(dashboardManager)
 */
(function (root) {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const esc = (v) => (typeof app !== 'undefined' && app && app.escapeHtml ? app.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const money = (n) => Math.round(Number(n || 0)).toLocaleString('en-UG');
    const P = () => root.NextaPosts, Cut = () => root.NextaCutout, Q = () => root.NextaQuality;

    const state = {
        dash: null, mounted: false, store: null, url: '',
        products: [], loadedProducts: false,
        style: 'spotlight', format: 'portrait', mood: 'deep', badge: 'NEW IN', cta: 'Scan to order',
        selected: [],                 // product ids
        photoIdx: {},                 // product id -> which of its photos
        custom: {},                   // product id -> { img, name } a clean photo the seller uploaded for this post
        cutChoice: null,              // null = automatic (on when the cutout scores high), true / false = the seller's own choice
        strength: 50, pick: null,
        showBanner: true, showLogo: true, showPhone: false,
        seq: 0, timer: 0, last: null, picking: false
    };
    const imgCache = new Map(), infoCache = new WeakMap(), cutCache = new Map();

    // ---- remembered choices (best effort) ------------------------------------------------------------------------
    const key = () => 'nextastore_posts_' + (state.store && state.store.slug || 'store');
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(key()) || '{}') || {}; } catch (e) { return {}; } }
    function savePrefs() { try { localStorage.setItem(key(), JSON.stringify({ style: state.style, format: state.format, mood: state.mood, badge: state.badge, cta: state.cta, showBanner: state.showBanner, showPhone: state.showPhone, showLogo: state.showLogo, cutout: state.cutChoice })); } catch (e) { /* storage blocked */ } }
    const toast = (m, t) => { try { app.showAlert(m, t || 'success'); } catch (e) { /* ignore */ } };

    // ---- data ----------------------------------------------------------------------------------------------------
    function photosOf(p) {
        const list = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : []);
        return list.filter(Boolean).map((u) => app.resolveImageUrl ? app.resolveImageUrl(u) : u);
    }
    function loadImg(src) {
        if (!src) return Promise.resolve(null);
        if (!imgCache.has(src)) imgCache.set(src, P().loadImage(src));
        return imgCache.get(src);
    }
    function analyse(img) { if (!img) return null; if (!infoCache.has(img)) infoCache.set(img, Q().analysePhoto(img)); return infoCache.get(img); }
    function productById(id) { return state.products.find((p) => p.id === id); }
    function stockNote(p) {
        const t = p.listingType || 'physical';
        if (t === 'service') return 'Book by message';
        if (t === 'digital') return 'Instant delivery';
        const n = Number(p.stock);
        if (!(n > 0)) return '';
        return n <= 5 ? `Only ${n} left` : 'In stock';
    }
    const isCollection = () => state.style === 'collection' || state.style === 'catalogue';
    const maxPick = () => (isCollection() ? 4 : 1);

    async function loadProducts() {
        if (state.loadedProducts) return;
        let list = (state.dash && state.dash.products) || [];
        if (!list.length) {
            try { const r = await app.apiRequest('/products?page=1&limit=24&sort=newest'); list = r.data || []; } catch (e) { list = []; }
        }
        state.products = list.filter((p) => !p.deletedAt);
        state.loadedProducts = true;
    }

    // ---- brand strip -----------------------------------------------------------------------------------------------
    function renderBrand() {
        const s = state.store || {}, box = $('ppBrand'); if (!box) return;
        const logo = s.logo ? app.resolveImageUrl(s.logo) : '', banner = s.banner ? app.resolveImageUrl(s.banner) : '';
        const color = /^#[0-9a-f]{6}$/i.test(s.bannerColor || '') ? s.bannerColor : '#00B074';
        const missing = [];
        if (!logo) missing.push('a logo');
        if (!banner) missing.push('a banner');
        box.innerHTML = `
            <div class="pp-brand-id">
                <span class="pp-logo">${logo ? `<img src="${esc(logo)}" alt="">` : `<i class="fas fa-store" aria-hidden="true"></i>`}</span>
                <div><strong>${esc(s.name || 'Your store')}</strong><small>${esc(state.url.replace(/^https?:\/\//, ''))}</small></div>
            </div>
            <div class="pp-brand-bits" aria-label="Branding used on every post">
                <span class="pp-bit"><i class="pp-dot" style="background:${esc(color)}"></i> Brand colour</span>
                <span class="pp-bit ${banner ? '' : 'is-off'}"><i class="fas fa-image" aria-hidden="true"></i> Banner</span>
                <span class="pp-bit ${logo ? '' : 'is-off'}"><i class="fas fa-circle-user" aria-hidden="true"></i> Logo</span>
                <span class="pp-bit"><i class="fas fa-qrcode" aria-hidden="true"></i> QR code</span>
            </div>
            <p class="pp-brand-note">${missing.length ? `Add ${missing.join(' and ')} to make your posts feel more like your shop.` : 'Your logo, banner and colour are applied to every post automatically.'}
                <button type="button" class="pp-link" id="ppToSettings">Edit in Settings</button></p>`;
        const b = $('ppToSettings'); if (b) b.addEventListener('click', () => { try { state.dash.switchSection('settings'); } catch (e) { /* ignore */ } });
    }

    // ---- controls --------------------------------------------------------------------------------------------------
    function seg(id, items, current, onPick) {
        const box = $(id); box.innerHTML = '';
        items.forEach((it) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'pp-seg-btn' + (it.id === current ? ' is-on' : ''); b.setAttribute('aria-pressed', it.id === current);
            b.innerHTML = `<strong>${esc(it.label)}</strong>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}`;
            b.addEventListener('click', () => onPick(it.id)); box.appendChild(b);
        });
    }
    function setStyle(id) {
        state.style = id;
        if (id === 'collection' || id === 'catalogue') { state.badge = state.badge === 'NEW IN' || !state.badge ? 'NEW ARRIVALS' : state.badge; autoPick(); }
        else { if (state.badge === 'NEW ARRIVALS') state.badge = (id === 'deal' || id === 'drop') ? 'ON SALE' : 'NEW IN'; if (state.selected.length > 1) state.selected = state.selected.slice(0, 1); }
        if ((id === 'deal' || id === 'drop') && !state.selected.length) autoPick();
        buildAll(); schedule(0);
    }
    function buildStyles() { seg('ppStyles', P().STYLES, state.style, setStyle); }
    /** A small picture of one style, made from the seller's own products, logo and colours (used by the Templates page). */
    async function renderTile(canvas, styleId, maxPx) {
        const def = P().STYLES.find((x) => x.id === styleId); if (!def) return false;
        const withPhoto = state.products.filter((p) => photosOf(p).length), pool = withPhoto.length ? withPhoto : state.products;
        if (!pool.length) return false;
        let picks;
        if (def.products[1] > 1) { picks = pool.slice(0, 4); if (picks.length < 2) picks = state.products.slice(0, 2); if (picks.length < 2) return false; }
        else picks = [(def.needsDiscount && pool.find((p) => Number(p.originalPrice) > Number(p.price))) || pool[0]];
        const prepared = await Promise.all(picks.map((p, i) => prepare(p, i, { noCut: true })));      // tiles stay quick: no cutouts
        const data = dataFor(prepared); data.style = styleId; data.format = 'portrait';
        data.badge = def.products[1] > 1 ? 'NEW ARRIVALS' : (def.needsDiscount ? 'ON SALE' : 'NEW IN');
        const F = P().FORMATS.find((f) => f.id === 'portrait'), tmp = document.createElement('canvas');
        await P().render(tmp, data, { scale: Math.min(1, maxPx / Math.max(F.w, F.h)) });
        canvas.width = tmp.width; canvas.height = tmp.height; canvas.getContext('2d').drawImage(tmp, 0, 0); canvas.style.aspectRatio = `${F.w} / ${F.h}`;
        return true;
    }
    function buildFormats() { seg('ppFormats', P().FORMATS, state.format, (id) => { state.format = id; buildFormats(); schedule(0); savePrefs(); }); }
    function buildMoods() {
        const box = $('ppMoods'); box.innerHTML = '';
        P().MOODS.forEach((m) => {
            const pal = P().palette(state.store && state.store.bannerColor, m.id);
            const b = document.createElement('button'); b.type = 'button'; b.className = 'pp-mood' + (m.id === state.mood ? ' is-on' : ''); b.setAttribute('aria-pressed', m.id === state.mood);
            b.innerHTML = `<span class="pp-mood-chip" style="background:linear-gradient(135deg,${pal.bg1},${pal.bg2})"><i style="background:${pal.accent}"></i></span><span>${esc(m.label)}</span>`;
            b.addEventListener('click', () => { state.mood = m.id; buildMoods(); schedule(0); savePrefs(); }); box.appendChild(b);
        });
    }
    function buildSelects() {
        const badge = $('ppBadge'); badge.innerHTML = P().BADGES.map((b) => `<option value="${esc(b)}">${b ? esc(b) : 'No label'}</option>`).join(''); badge.value = state.badge;
        $('ppCta').value = [...$('ppCta').options].some((o) => o.value === state.cta) ? state.cta : $('ppCta').options[0].value; state.cta = $('ppCta').value;
        $('ppBanner').checked = state.showBanner; $('ppLogo').checked = state.showLogo; $('ppPhone').checked = state.showPhone;
        $('ppPhoneWrap').hidden = !(state.store && state.store.phoneNumber);
    }

    function autoPick() {
        const need = isCollection() ? Math.min(3, state.products.length) : 1;
        const withPhoto = state.products.filter((p) => photosOf(p).length);
        let pool = withPhoto;
        if (state.style === 'deal' || state.style === 'drop') pool = withPhoto.filter((p) => Number(p.originalPrice) > Number(p.price));
        if (!pool.length) pool = withPhoto;
        const keep = state.selected.filter((id) => productById(id)).slice(0, maxPick());
        // keep what the seller chose; a collection is topped up so it starts with a useful set
        const fill = isCollection() && keep.length < 2 ? pool.filter((p) => !keep.includes(p.id)).slice(0, need - keep.length).map((p) => p.id) : [];
        state.selected = keep.length ? keep.concat(fill) : pool.slice(0, need).map((p) => p.id);
    }

    function buildProducts() {
        const box = $('ppProducts'), hint = $('ppPickHint');
        if (!state.products.length) {
            box.innerHTML = `<div class="pp-empty"><i class="fas fa-box-open" aria-hidden="true"></i><p>Add a product first and it will show up here.</p><a class="btn btn-primary btn-sm" href="/product-form"><i class="fas fa-plus"></i> Add product</a></div>`;
            hint.textContent = ''; return;
        }
        box.innerHTML = '';
        state.products.forEach((p) => {
            const on = state.selected.includes(p.id), ph = photosOf(p)[0] || '';
            const b = document.createElement('button'); b.type = 'button'; b.className = 'pp-prod' + (on ? ' is-on' : ''); b.setAttribute('role', 'option'); b.setAttribute('aria-selected', on);
            b.innerHTML = `<span class="pp-prod-img">${ph ? `<img src="${esc((app.productThumb && app.productThumb(p)) || ph)}" alt="" loading="lazy">` : '<i class="fas fa-box" aria-hidden="true"></i>'}<i class="pp-tick fas fa-check" aria-hidden="true"></i></span><span class="pp-prod-name">${esc(p.name)}</span><span class="pp-prod-price">${Number(p.price) > 0 ? 'UGX ' + money(p.price) : 'No price'}</span>`;
            b.addEventListener('click', () => togglePick(p.id)); box.appendChild(b);
        });
        const n = state.selected.length;
        hint.textContent = isCollection() ? `Pick 2 to 4 products (${n} chosen).` : ((state.style === 'deal' || state.style === 'drop') ? 'Deal posts work best on a product with a lower price than before.' : 'Pick the product you want to promote.');
    }
    function togglePick(id) {
        const i = state.selected.indexOf(id);
        if (isCollection()) { if (i >= 0) state.selected.splice(i, 1); else if (state.selected.length < 4) state.selected.push(id); else toast('A collection holds up to 4 products.', 'warning'); }
        else state.selected = [id];
        state.pick = null; buildProducts(); buildPhotoStep(); schedule(0);
    }

    function buildPhotoStep() {
        const step = $('ppPhotoStep'), single = !isCollection(), p = single ? productById(state.selected[0]) : null;
        step.hidden = !single || !p;
        if (step.hidden) return;
        const photos = photosOf(p), idx = Math.min(state.photoIdx[p.id] || 0, Math.max(0, photos.length - 1)), custom = state.custom[p.id];
        const box = $('ppPhotos'); box.innerHTML = '';
        photos.forEach((u, i) => { const b = document.createElement('button'); b.type = 'button'; const on = !custom && i === idx; b.className = 'pp-thumb' + (on ? ' is-on' : ''); b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', `Photo ${i + 1}`); b.innerHTML = `<img src="${esc(u)}" alt="">`; b.addEventListener('click', () => { delete state.custom[p.id]; state.photoIdx[p.id] = i; state.pick = null; buildPhotoStep(); schedule(0); }); box.appendChild(b); });
        if (custom) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pp-thumb is-on'; b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', 'Your uploaded photo'); b.innerHTML = `<img src="${esc(custom.url)}" alt=""><i class="pp-new">NEW</i>`; box.appendChild(b); }
        $('ppStrength').value = state.strength;
        syncCut(state.last && state.last.prepared && state.last.prepared[0]);
    }

    /** The "Remove background" switch sits under the preview. It follows the seller's choice, or, while they have made
     *  none, whatever the automatic check decided (on only when the cutout scored high). */
    function syncCut(x) {
        const bar = $('ppCutBar'); if (!bar) return;
        const p = isCollection() ? null : productById(state.selected[0]);
        bar.hidden = !p; if (!p) { $('ppCutTools').hidden = true; return; }
        const known = !!x && x.p && x.p.id === p.id, explicit = state.cutChoice;
        const on = explicit !== null ? explicit : (known ? x.mode === 'cutout' : $('ppCutout').checked);
        $('ppCutout').checked = on;
        $('ppCutState').textContent = on ? (explicit === null ? 'On (automatic)' : 'On') : 'Off';
        $('ppCutTools').hidden = !on; $('ppStamp').hidden = !on || !!state.custom[p.id];
        if (known) renderCutStatus(x); else if (explicit === false) $('ppCutStatus').hidden = true;
    }

    // ---- photo upload ----------------------------------------------------------------------------------------------
    function onUpload(e) {
        const f = e.target.files && e.target.files[0], id = state.selected[0]; e.target.value = '';
        if (!f || !id) return;
        if (!/^image\//.test(f.type)) { toast('Please choose a photo.', 'error'); return; }
        const url = URL.createObjectURL(f), img = new Image();
        img.onload = () => { state.custom[id] = { img, url, name: f.name }; state.pick = null; buildPhotoStep(); schedule(0); };
        img.onerror = () => toast('We could not open that photo. Try another one.', 'error');
        img.src = url;
    }

    // ---- build + render --------------------------------------------------------------------------------------------
    function buildAll() { buildStyles(); buildFormats(); buildMoods(); buildProducts(); buildPhotoStep(); }
    function schedule(delay) { clearTimeout(state.timer); state.timer = setTimeout(refresh, delay == null ? 180 : delay); }

    async function prepare(p, i, opts) {
        const custom = state.custom[p.id];
        const src = photosOf(p)[Math.min(state.photoIdx[p.id] || 0, Math.max(0, photosOf(p).length - 1))];
        const img = custom ? custom.img : await loadImg(src);
        const info = analyse(img);
        const out = { p, img, info, image: img, mode: 'photo', cut: null, fellBack: false, failed: !img && !!src };
        const auto = state.cutChoice === null;
        if (img && state.cutChoice !== false && !(opts && opts.noCut) && !isCollection() && i === 0 && info && !info.unreadable) {
            const k = `${custom ? custom.url : src}|${state.strength}|${state.pick ? state.pick.join(',') : ''}`;
            if (!cutCache.has(k)) cutCache.set(k, Cut().remove(img, { strength: state.strength, pickColor: state.pick ? { r: state.pick[0], g: state.pick[1], b: state.pick[2] } : null }));
            const res = await cutCache.get(k); out.cut = res;
            // automatic: only a high score is used, and a miss is silent. The seller's own "on": anything but poor is used.
            if (res && res.ok && (auto ? res.verdict === 'good' : res.verdict !== 'poor')) { out.image = Cut().trim(res, 0.04); out.mode = 'cutout'; out.auto = auto; }
            else out.fellBack = !auto;
        }
        return out;
    }

    function dataFor(prepared) {
        const s = state.store || {};
        return {
            style: state.style, format: state.format, mood: state.mood, badge: state.badge, cta: state.cta,
            showBanner: state.showBanner, showLogo: state.showLogo, showPhone: state.showPhone,
            store: { name: s.name || 'My Store', logo: s.logo ? app.resolveImageUrl(s.logo) : '', banner: s.banner ? app.resolveImageUrl(s.banner) : '', color: s.bannerColor, phone: s.phoneNumber || '', url: state.url },
            products: prepared.map((x) => ({ name: x.p.name, price: x.p.price, originalPrice: x.p.originalPrice, image: x.image, mode: x.mode, tagNote: stockNote(x.p) }))
        };
    }

    async function refresh() {
        const seq = ++state.seq, canvas = $('ppPreview'), busy = $('ppBusy'), empty = $('ppEmpty');
        const picks = state.selected.map(productById).filter(Boolean);
        $('ppPreviewBox').classList.toggle('is-empty', !picks.length);
        if (!picks.length) { syncCut(null); busy.hidden = true; empty.hidden = false; canvas.hidden = true; renderQuality({ status: 'blocked', items: [{ level: 'block', id: 'no_product', title: 'No product chosen', fix: 'Pick a product to make a post for.' }], canDownload: false }); setActions(false); return; }
        empty.hidden = true; canvas.hidden = false; busy.hidden = false;
        const guard = setTimeout(() => { if (seq === state.seq) busy.hidden = true; }, 30000);      // the chip can never spin forever
        try {
            const prepared = await Promise.all(picks.map((p, i) => prepare(p, i)));      // photos load side by side, not one after another
            if (seq !== state.seq) return;
            const data = dataFor(prepared), F = P().FORMATS.find((f) => f.id === state.format);
            const tmp = document.createElement('canvas'), scale = Math.min(1, 900 / Math.max(F.w, F.h));
            const rep = await P().render(tmp, data, { scale });
            if (seq !== state.seq) return;
            canvas.width = tmp.width; canvas.height = tmp.height; canvas.getContext('2d').drawImage(tmp, 0, 0);
            canvas.style.aspectRatio = `${F.w} / ${F.h}`;
            const s = state.store || {}, logoEl = s.logo ? await loadImg(app.resolveImageUrl(s.logo)) : null;
            const ev = Q().evaluate({
                style: state.style, format: state.format, report: rep,
                products: prepared.map((x) => ({ name: x.p.name, price: x.p.price, originalPrice: x.p.originalPrice, photo: x.info || null, photoFailed: x.failed, mode: x.mode, cutout: x.cut, cutoutFellBack: x.fellBack })),
                store: { hasLogo: !!s.logo, logoPx: logoEl ? Math.min(logoEl.naturalWidth || logoEl.width, logoEl.naturalHeight || logoEl.height) : null, published: s.isPublished !== false, logoFailed: !!(rep.assets && rep.assets.logo), bannerFailed: !!(rep.assets && rep.assets.banner) }
            });
            state.last = { ev, prepared };
            renderQuality(ev); setActions(ev.canDownload); syncCut(prepared[0]); $('ppCaptionText').value = caption(prepared);
            $('ppSize').textContent = `${F.w} \u00D7 ${F.h} px \u00B7 ${F.sub}`;
        } catch (err) {
            toast(err.message || 'Could not draw the preview.', 'error');
        } finally { clearTimeout(guard); if (seq === state.seq) busy.hidden = true; }
    }

    function renderCutStatus(x) {
        const el = $('ppCutStatus'); if (!el) return;
        if (!x || isCollection() || state.cutChoice === false) { el.hidden = true; return; }
        const c = x.cut;
        if (state.cutChoice === null) {          // automatic: say so only when it was actually applied
            if (x.mode !== 'cutout' || !c) { el.hidden = true; return; }
            el.hidden = false; el.className = 'pp-cutstatus is-auto';
            el.innerHTML = `<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> <b>We removed the background for you.</b> <span>${c.confidence}% sure it looks clean. Don\u2019t like it? Switch it off above.</span>`;
            return;
        }
        el.hidden = false;
        if (!c) { el.className = 'pp-cutstatus is-warn'; el.innerHTML = '<i class="fas fa-circle-info"></i> Waiting for a photo.'; return; }
        if (x.mode === 'cutout') {
            const good = c.verdict === 'good';
            el.className = 'pp-cutstatus ' + (good ? 'is-good' : 'is-warn');
            el.innerHTML = `<i class="fas ${good ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> ${good ? 'Clean cutout.' : 'Cutout has rough spots.'} <span>${c.confidence}% sure</span>`;
        } else {
            el.className = 'pp-cutstatus is-fallback';
            el.innerHTML = `<i class="fas fa-circle-info"></i> We kept your photo in a frame. ${esc(Q()._cutoutReason(c.reasons))} <span>Try a plainer background, or lower the strength.</span>`;
        }
    }

    // ---- quality panel + actions ----------------------------------------------------------------------------------
    function renderQuality(ev) {
        const box = $('ppQuality'), copy = Q().STATUS_COPY[ev.status] || Q().STATUS_COPY.ready;
        const icon = { ready: 'fa-circle-check', fix: 'fa-circle-exclamation', blocked: 'fa-hand' }[ev.status];
        const items = (ev.items || []).filter((i) => i.level !== 'ok' || ev.items.length < 4);
        box.className = 'pp-quality is-' + ev.status;
        box.innerHTML = `<div class="pp-q-head"><i class="fas ${icon}" aria-hidden="true"></i><div><strong>${esc(copy.label)}</strong><small>${esc(copy.hint)}</small></div></div>` +
            (items.length ? `<ul class="pp-q-list">${items.map((i) => `<li class="is-${i.level}"><i class="fas ${i.level === 'block' ? 'fa-circle-xmark' : i.level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}" aria-hidden="true"></i><span><b>${esc(i.title)}</b>${i.fix ? `<em>${esc(i.fix)}</em>` : ''}</span></li>`).join('')}</ul>` : '');
    }
    function setActions(ok) {
        ['ppDownload', 'ppShare'].forEach((id) => { const b = $(id); if (!b) return; b.disabled = !ok; b.setAttribute('aria-disabled', String(!ok)); b.title = ok ? '' : 'Fix the red items first'; });
        $('ppShare').hidden = !navigator.share;
    }

    function caption(prepared) {
        const url = state.url;
        const line = (p) => { const pr = Number(p.price), o = Number(p.originalPrice); return `${p.name}${pr > 0 ? ' - UGX ' + money(pr) : ''}${o > pr && pr > 0 ? ` (was UGX ${money(o)})` : ''}`; };
        if (isCollection()) return `${state.badge || 'New in our store'}\n${prepared.map((x) => line(x.p)).join('\n')}\n\nOrder here: ${url}`;
        const p = prepared[0] && prepared[0].p; if (!p) return '';
        const d = String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return `${line(p)}${d ? '\n' + d + (String(p.description || '').length > 140 ? '...' : '') : ''}\n\nOrder here: ${url}`;
    }

    // ---- exporting ------------------------------------------------------------------------------------------------
    async function fullBlob() {
        if (!state.last || !state.last.ev.canDownload) throw new Error('Fix the red items first, then try again.');
        const c = document.createElement('canvas'); await P().render(c, dataFor(state.last.prepared), { scale: 1 });
        return NextaBrandKit.canvasToBlob(c, 'image/png');
    }
    const fname = () => `${(state.store && state.store.slug) || 'store'}-${state.style}-${state.format}.png`;
    async function busyBtn(btn, fn) {
        if (btn.disabled) return; btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="pm-spin" aria-hidden="true"></span> Working\u2026';
        try { await fn(); } catch (err) { toast(err.message || 'Something went wrong. Please try again.', 'error'); } finally { btn.innerHTML = old; setActions(!!(state.last && state.last.ev.canDownload)); }
    }
    async function download() { const b = await fullBlob(); if (root.NextaPromote) NextaPromote.save(b, fname()); }
    async function share() {
        const blob = await fullBlob(), file = new File([blob], fname(), { type: 'image/png' }), payload = { files: [file], title: state.store.name, text: $('ppCaptionText').value };
        if (navigator.canShare && navigator.canShare(payload)) { try { await navigator.share(payload); } catch (e) { if (e && e.name !== 'AbortError') throw e; } } else await download();
    }
    async function copyCaption() {
        const t = $('ppCaptionText').value;
        try { await navigator.clipboard.writeText(t); toast('Caption copied. Paste it with your picture.'); }
        catch (e) { $('ppCaptionText').select(); try { document.execCommand('copy'); toast('Caption copied.'); } catch (e2) { toast('Press and hold the text to copy it.', 'warning'); } }
    }

    // ---- tap-to-pick background colour -------------------------------------------------------------------------------
    function togglePicker() {
        const box = $('ppPickBox'), x = state.last && state.last.prepared[0];
        if (!x || !x.img) return;
        state.picking = !state.picking; box.hidden = !state.picking; $('ppPickBtn').setAttribute('aria-pressed', String(state.picking));
        if (!state.picking) return;
        const c = $('ppPickCanvas'), s = Math.min(1, 420 / Math.max(x.img.naturalWidth || x.img.width, x.img.naturalHeight || x.img.height));
        c.width = Math.round((x.img.naturalWidth || x.img.width) * s); c.height = Math.round((x.img.naturalHeight || x.img.height) * s);
        c.getContext('2d').drawImage(x.img, 0, 0, c.width, c.height);
    }
    function onPick(e) {
        const c = $('ppPickCanvas'), r = c.getBoundingClientRect(), px = Math.floor((e.clientX - r.left) * (c.width / r.width)), py = Math.floor((e.clientY - r.top) * (c.height / r.height));
        try { const d = c.getContext('2d').getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data; let R = 0, G = 0, B = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; } const n = d.length / 4; state.pick = [Math.round(R / n), Math.round(G / n), Math.round(B / n)]; }
        catch (err) { toast('We could not read that photo.', 'error'); return; }
        $('ppPickBox').hidden = true; state.picking = false; $('ppPickBtn').setAttribute('aria-pressed', 'false');
        const sw = $('ppPickSwatch'); sw.hidden = false; sw.style.background = `rgb(${state.pick.join(',')})`; schedule(0);
    }

    function bindOnce() {
        $('ppBadge').addEventListener('change', (e) => { state.badge = e.target.value; schedule(); savePrefs(); });
        $('ppCta').addEventListener('change', (e) => { state.cta = e.target.value; schedule(); savePrefs(); });
        $('ppBanner').addEventListener('change', (e) => { state.showBanner = e.target.checked; schedule(); savePrefs(); });
        $('ppLogo').addEventListener('change', (e) => { state.showLogo = e.target.checked; schedule(); savePrefs(); });
        $('ppPhone').addEventListener('change', (e) => { state.showPhone = e.target.checked; schedule(); savePrefs(); });
        $('ppCutout').addEventListener('change', (e) => { state.cutChoice = e.target.checked; state.pick = null; $('ppPickSwatch').hidden = true; savePrefs(); buildPhotoStep(); schedule(0); });
        $('ppStrength').addEventListener('input', (e) => { state.strength = Number(e.target.value); schedule(260); });
        $('ppUploadBtn').addEventListener('click', () => $('ppUpload').click());
        $('ppUpload').addEventListener('change', onUpload);
        $('ppPickBtn').addEventListener('click', togglePicker);
        $('ppPickCanvas').addEventListener('click', onPick);
        $('ppPickReset').addEventListener('click', () => { state.pick = null; $('ppPickSwatch').hidden = true; schedule(0); });
        $('ppDownload').addEventListener('click', (e) => busyBtn(e.currentTarget, download));
        $('ppShare').addEventListener('click', (e) => busyBtn(e.currentTarget, share));
        $('ppCopyCaption').addEventListener('click', copyCaption);
        $('ppWhatsapp').addEventListener('click', () => root.open(`https://wa.me/?text=${encodeURIComponent($('ppCaptionText').value)}`, '_blank', 'noopener'));
    }

    async function mount(dash) {
        if (!$('ppPreview')) return;
        if (!P() || !Cut() || !Q()) { toast('The post tools did not load. Refresh the page.', 'error'); return; }
        state.dash = dash; state.store = dash.currentStore || {}; state.url = dash.publicStoreUrl(state.store.slug || 'my-store');
        const pr = loadPrefs();
        if (P().STYLES.some((s) => s.id === pr.style)) state.style = pr.style;
        if (P().FORMATS.some((f) => f.id === pr.format)) state.format = pr.format;
        if (P().MOODS.some((m) => m.id === pr.mood)) state.mood = pr.mood;
        if (typeof pr.badge === 'string' && P().BADGES.includes(pr.badge)) state.badge = pr.badge;
        if (pr.cta) state.cta = pr.cta;
        state.cutChoice = typeof pr.cutout === 'boolean' ? pr.cutout : null;
        state.showBanner = pr.showBanner !== false; state.showLogo = pr.showLogo !== false; state.showPhone = pr.showPhone != null ? !!pr.showPhone : !!(state.store.phoneNumber && state.store.phonePublic !== false);
        renderBrand();
        $('ppProducts').innerHTML = '<div class="pp-loading"><span class="pm-spin"></span> Loading your products\u2026</div>';
        await loadProducts();
        autoPick(); buildSelects(); buildAll();
        if (!state.mounted) { bindOnce(); state.mounted = true; }
        schedule(0);
    }

    root.NextaPostStudio = { mount, useStyle: setStyle, renderTile, _state: state };
})(window);
