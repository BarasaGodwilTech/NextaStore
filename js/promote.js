/**
 * NextaPromote: the "Promote" section of the seller dashboard. Wires the controls to NextaBrandKit (js/brand-kit.js),
 * keeps a live preview, and handles download / print PDF / share. Settings are remembered per store in localStorage
 * (best effort: if storage is blocked the studio simply starts from defaults each time).
 */
(function (root) {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const KitT = () => root.NextaBrandKit;

    const SWATCHES = [
        { id: 'ink',    label: 'Deep green', bg: '#0B3B2B' },
        { id: 'green',  label: 'NextaStore green', bg: '#01B075' },
        { id: 'gold',   label: 'Gold', bg: '#FFB038' },
        { id: 'light',  label: 'White', bg: '#FFFFFF' },
        { id: 'coral',  label: 'Coral', bg: '#D9534F' },
        { id: 'teal',   label: 'Teal', bg: '#236B82' },
        { id: 'store',  label: 'My store colour', bg: null }
    ];
    const TAB_GROUPS = [
        { id: 'poster', label: 'Posters & signs', icon: 'fa-image', templates: ['poster', 'sign', 'opening', 'sale', 'scansign', 'delivery', 'openhours', 'thanks'] },
        { id: 'social', label: 'Social', icon: 'fa-mobile-screen', templates: ['story', 'square', 'flash', 'newin'] },
        { id: 'card',   label: 'Business cards', icon: 'fa-address-card', templates: ['card'] }
    ];

    const state = { dash: null, mounted: false, group: 'poster', template: 'poster', side: 'front', swatch: 'ink', store: null, url: '', renderSeq: 0, timer: 0 };

    function storeKey() { return 'nextastore_promote_' + (state.store?.slug || 'store'); }
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(storeKey()) || '{}') || {}; } catch (e) { return {}; } }
    function savePrefs() {
        try {
            localStorage.setItem(storeKey(), JSON.stringify({
                group: state.group, template: state.template, swatch: state.swatch,
                tagline: $('pmTagline').value, cta: $('pmCta').value, showPhone: $('pmShowPhone').checked, phone: $('pmPhone').value,
                showLogo: $('pmShowLogo').checked, owner: $('pmOwner').value, title: $('pmTitle').value, email: $('pmEmail').value, name: $('pmName').value
            }));
        } catch (e) { /* storage blocked: fine */ }
    }
    function toast(msg, type) { try { app.showAlert(msg, type || 'success'); } catch (e) { /* ignore */ } }

    function themeBg() {
        const sw = SWATCHES.find((x) => x.id === state.swatch) || SWATCHES[0];
        const store = state.store?.bannerColor;
        return sw.bg || (/^#[0-9a-f]{6}$/i.test(store || '') ? store : '#0B3B2B');
    }
    function currentData() {
        const bg = themeBg();
        const logo = state.store?.logo ? app.resolveImageUrl(state.store.logo) : '';
        return {
            name: $('pmName').value.trim() || state.store?.name || 'My Store',
            tagline: $('pmTagline').value.trim(),
            cta: $('pmCta').value,
            url: state.url,
            phone: $('pmPhone').value.trim(),
            showPhone: $('pmShowPhone').checked && !!$('pmPhone').value.trim(),
            showLogo: $('pmShowLogo').checked,
            logo,
            owner: $('pmOwner').value.trim(), title: $('pmTitle').value.trim(), email: $('pmEmail').value.trim(),
            theme: { bg }
        };
    }
    function tplInfo() { return KitT().TEMPLATES.find((t) => t.id === state.template); }

    function buildTabs() {
        const tabs = $('pmTabs'); tabs.innerHTML = '';
        TAB_GROUPS.forEach((g) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'pm-tab' + (g.id === state.group ? ' is-on' : ''); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', g.id === state.group);
            b.innerHTML = `<i class="fas ${g.icon}" aria-hidden="true"></i><span>${g.label}</span>`;
            b.addEventListener('click', () => { state.group = g.id; state.template = g.templates[0]; state.side = 'front'; buildTabs(); buildSubtabs(); syncControls(); schedule(0); });
            tabs.appendChild(b);
        });
    }
    function buildSubtabs() {
        let sub = $('pmSub');
        const g = TAB_GROUPS.find((x) => x.id === state.group);
        if (!sub) { sub = document.createElement('div'); sub.id = 'pmSub'; sub.className = 'pm-subtabs'; sub.setAttribute('role', 'group'); $('pmTabs').after(sub); }
        sub.hidden = g.templates.length < 2; sub.innerHTML = '';
        g.templates.forEach((id) => {
            const t = KitT().TEMPLATES.find((x) => x.id === id);
            const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-chip' + (id === state.template ? ' is-on' : ''); b.textContent = t.label;
            b.addEventListener('click', () => { state.template = id; buildSubtabs(); syncControls(); schedule(0); });
            sub.appendChild(b);
        });
    }
    function buildSwatches() {
        const box = $('pmSwatches'); box.innerHTML = '';
        SWATCHES.forEach((sw) => {
            const bg = sw.bg || state.store?.bannerColor || '#0B3B2B';
            const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-swatch' + (sw.id === state.swatch ? ' is-on' : ''); b.style.setProperty('--sw', bg);
            b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', sw.id === state.swatch); b.setAttribute('aria-label', sw.label); b.title = sw.label;
            if (sw.id === 'light') b.classList.add('is-light');
            b.addEventListener('click', () => { state.swatch = sw.id; buildSwatches(); schedule(0); savePrefs(); });
            box.appendChild(b);
        });
    }
    function syncControls() {
        const isCard = state.template === 'card';
        document.querySelectorAll('#promoteSection [data-for="card"]').forEach((el) => { el.hidden = !isCard; });
        document.querySelectorAll('#promoteSection [data-for="not-card"]').forEach((el) => { el.hidden = isCard; });
        $('pmFlip').hidden = !isCard;
        $('pmPhone').hidden = !$('pmShowPhone').checked;
        const t = tplInfo();
        $('pmPdf').hidden = !(t.pdf || isCard);
        $('pmPdf').querySelector('span').textContent = isCard ? 'Print sheet (10 cards, PDF)' : 'Print-ready PDF';
        $('pmDownload').querySelector('span').textContent = isCard ? `Download ${state.side}` : 'Download image';
        $('pmSize').textContent = isCard ? 'Standard 3.5 × 2 in (88.9 × 50.8 mm) card. Print sheet fits 10 per A4.' : (t.mm ? `${t.mm[0]} × ${t.mm[1]} mm · prints sharp at ${t.w} × ${t.h} px` : `${t.w} × ${t.h} px · made for sharing`);
        document.querySelectorAll('#pmFlip .pm-flip-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.side === state.side));
        $('pmShare').hidden = !(navigator.share);
    }

    function schedule(delay) { clearTimeout(state.timer); state.timer = setTimeout(draw, delay == null ? 160 : delay); }
    async function draw() {
        const seq = ++state.renderSeq, canvas = $('pmPreview'), busy = $('pmBusy');
        busy.hidden = false;
        try {
            const tmp = document.createElement('canvas');
            // Preview at ~900px on the long side: sharp on retina phones, quick everywhere.
            const t = tplInfo(), scale = Math.min(1, 900 / Math.max(t.w, t.h));
            await KitT().render(tmp, state.template, currentData(), { scale, side: state.side });
            if (seq !== state.renderSeq) return; // a newer edit superseded this one
            canvas.width = tmp.width; canvas.height = tmp.height; canvas.getContext('2d').drawImage(tmp, 0, 0);
            canvas.style.aspectRatio = `${t.w} / ${t.h}`;
            $('pmPreviewBox').classList.toggle('is-wide', t.w / t.h > 1.2);
            $('pmPreviewBox').classList.toggle('is-tall', t.h / t.w > 1.6);
        } catch (err) {
            toast(err.message || 'Could not draw the preview.', 'error');
        } finally { if (seq === state.renderSeq) busy.hidden = true; }
    }

    // ---- saving / sharing ----------------------------------------------------------------------------------
    function save(blob, filename) {
        const a = document.createElement('a'); const href = URL.createObjectURL(blob);
        a.href = href; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 4000);
        toast('Saved. Check your downloads.');
    }
    function fname(ext, extra) { return `${state.store?.slug || 'store'}-${tplInfo().file}${extra ? '-' + extra : ''}.${ext}`; }
    async function busyBtn(btn, fn) {
        if (btn.disabled) return; btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="pm-spin" aria-hidden="true"></span> Working…';
        try { await fn(); } catch (err) { toast(err.message || 'Something went wrong. Please try again.', 'error'); } finally { btn.disabled = false; btn.innerHTML = old; }
    }
    async function fullCanvas(side) { const c = document.createElement('canvas'); await KitT().render(c, state.template, currentData(), { side: side || state.side }); return c; }

    async function download() { const c = await fullCanvas(); save(await KitT().canvasToBlob(c, 'image/png'), fname('png', state.template === 'card' ? state.side : '')); }
    async function pdf() {
        const t = tplInfo();
        if (state.template === 'card') {
            const front = await KitT().cardSheet(currentData(), 'front'), back = await KitT().cardSheet(currentData(), 'back');
            save(await KitT().pdfFromCanvases([front, back], { widthMm: 210, heightMm: 297 }), fname('pdf', 'sheet'));
        } else {
            const c = await fullCanvas();
            save(await KitT().pdfFromCanvases([c], { widthMm: t.mm[0], heightMm: t.mm[1] }), fname('pdf'));
        }
    }
    async function share() {
        const c = await fullCanvas(), blob = await KitT().canvasToBlob(c, 'image/png'), file = new File([blob], fname('png', state.template === 'card' ? state.side : ''), { type: 'image/png' });
        const payload = { files: [file], title: state.store?.name || 'My store', text: `Visit my store on NextaStore: ${state.url}` };
        if (navigator.canShare && navigator.canShare(payload)) { try { await navigator.share(payload); } catch (e) { if (e && e.name !== 'AbortError') throw e; } }
        else { await download(); }
    }
    async function shareLink() {
        const text = `Visit my store on NextaStore: ${state.url}`;
        if (navigator.share) { try { await navigator.share({ title: state.store?.name || 'My store', text, url: state.url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
        root.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
    async function copyLink() {
        const btn = $('pmCopy'), done = () => { const o = btn.innerHTML; btn.innerHTML = '<i class="fas fa-check"></i> Copied'; setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1800); };
        try { await navigator.clipboard.writeText(state.url); done(); }
        catch (e) { $('pmUrl').select(); try { document.execCommand('copy') ? done() : toast('Press and hold the link to copy it.', 'warning'); } catch (e2) { toast('Press and hold the link to copy it.', 'warning'); } }
    }

    function bindOnce() {
        const redraw = () => { schedule(); savePrefs(); };
        ['pmName', 'pmTagline', 'pmOwner', 'pmTitle', 'pmEmail', 'pmPhone'].forEach((id) => $(id).addEventListener('input', redraw));
        ['pmCta', 'pmShowLogo'].forEach((id) => $(id).addEventListener('change', redraw));
        $('pmShowPhone').addEventListener('change', () => { syncControls(); if ($('pmShowPhone').checked) $('pmPhone').focus({ preventScroll: true }); redraw(); });
        document.querySelectorAll('#pmFlip .pm-flip-btn').forEach((b) => b.addEventListener('click', () => { state.side = b.dataset.side; syncControls(); schedule(0); }));
        $('pmDownload').addEventListener('click', (e) => busyBtn(e.currentTarget, download));
        $('pmPdf').addEventListener('click', (e) => busyBtn(e.currentTarget, pdf));
        $('pmShare').addEventListener('click', (e) => busyBtn(e.currentTarget, share));
        $('pmCopy').addEventListener('click', copyLink);
        $('pmShareLink').addEventListener('click', shareLink);
        $('pmQrPng').addEventListener('click', (e) => busyBtn(e.currentTarget, async () => save(await KitT().canvasToBlob(KitT().qrCanvas(state.url, 1200), 'image/png'), `${state.store?.slug || 'store'}-qr-code.png`)));
        $('pmQrSvg').addEventListener('click', (e) => busyBtn(e.currentTarget, async () => save(new Blob([KitT().qrSvg(state.url)], { type: 'image/svg+xml' }), `${state.store?.slug || 'store'}-qr-code.svg`)));
        root.addEventListener('storage', () => {});
    }

    /** Two modes: "Product posts" (js/post-studio.js, the default) and the store posters / business cards below. */
    function setMode(mode) {
        const posts = mode !== 'store';
        $('pmPostsPanel').hidden = !posts; $('pmStorePanel').hidden = posts;
        document.querySelectorAll('#promoteSection .pp-mode').forEach((b) => { const on = b.dataset.ppMode === (posts ? 'posts' : 'store'); b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
        try { localStorage.setItem('nextastore_promote_mode', posts ? 'posts' : 'store'); } catch (e) { /* ignore */ }
        if (!posts) draw();
    }
    function bindModes() {
        document.querySelectorAll('#promoteSection .pp-mode').forEach((b) => { if (b._pp) return; b._pp = true; b.addEventListener('click', () => setMode(b.dataset.ppMode)); });
    }

    function mount(dash) {
        state.dash = dash; state.store = dash.currentStore || {};
        state.url = dash.publicStoreUrl(state.store.slug || 'my-store');
        const prefs = loadPrefs();
        state.group = TAB_GROUPS.some((g) => g.id === prefs.group) ? prefs.group : 'poster';
        const g = TAB_GROUPS.find((x) => x.id === state.group);
        state.template = g.templates.includes(prefs.template) ? prefs.template : g.templates[0];
        state.swatch = SWATCHES.some((s) => s.id === prefs.swatch) ? prefs.swatch : 'ink';
        state.side = 'front';

        $('pmUrl').value = state.url;
        $('pmName').value = prefs.name != null && prefs.name !== '' ? prefs.name : (state.store.name || '');
        $('pmTagline').value = prefs.tagline != null ? prefs.tagline : '';
        if (prefs.tagline == null && state.store.tagline) $('pmTagline').value = String(state.store.tagline).slice(0, 70);
        $('pmCta').value = prefs.cta && [...$('pmCta').options].some((o) => o.value === prefs.cta) ? prefs.cta : $('pmCta').options[0].value;
        $('pmPhone').value = prefs.phone != null ? prefs.phone : (state.store.phoneNumber || '');
        $('pmShowPhone').checked = prefs.showPhone != null ? !!prefs.showPhone : !!(state.store.phoneNumber && state.store.phonePublic !== false);
        $('pmShowLogo').checked = prefs.showLogo !== false;
        $('pmOwner').value = prefs.owner != null ? prefs.owner : (app.user?.name || '');
        $('pmTitle').value = prefs.title != null ? prefs.title : 'Owner';
        $('pmEmail').value = prefs.email != null ? prefs.email : '';
        $('pmDraftNote').hidden = state.store.isPublished !== false;

        buildTabs(); buildSubtabs(); buildSwatches(); syncControls();
        if (!state.mounted) { bindOnce(); state.mounted = true; }
        try { const q = KitT().qrCanvas(state.url, 440), c = $('pmQrCanvas'); c.width = q.width; c.height = q.height; c.getContext('2d').drawImage(q, 0, 0); } catch (e) { /* QR too long for the offline encoder */ toast('This store link is too long for a QR code. Shorten your store address in Settings.', 'warning'); }
        bindModes();
        let mode = 'posts'; try { mode = localStorage.getItem('nextastore_promote_mode') || 'posts'; } catch (e) { /* ignore */ }
        if (root.NextaPostStudio && $('pmPostsPanel')) { setMode(mode); root.NextaPostStudio.mount(dash); }
        else { if ($('pmPostsPanel')) $('pmPostsPanel').hidden = true; if ($('pmStorePanel')) $('pmStorePanel').hidden = false; draw(); }
    }


    /** A small picture of one template with the seller's own data (used by the Templates page). */
    async function thumb(canvas, id, maxPx) {
        const T = KitT().TEMPLATES.find((t) => t.id === id); if (!T) return false;
        const tmp = document.createElement('canvas');
        await KitT().render(tmp, id, currentData(), { scale: Math.min(1, maxPx / Math.max(T.w, T.h)), side: 'front' });
        canvas.width = tmp.width; canvas.height = tmp.height; canvas.getContext('2d').drawImage(tmp, 0, 0); canvas.style.aspectRatio = `${T.w} / ${T.h}`;
        return true;
    }
    /** Jump straight to a poster / card / social template. */
    function openTemplate(id) {
        const g = TAB_GROUPS.find((x) => x.templates.includes(id)); if (!g) return;
        state.group = g.id; state.template = id; state.side = 'front';
        setMode('store'); buildTabs(); buildSubtabs(); syncControls(); schedule(0);
    }
    function openPost(styleId) { setMode('posts'); if (root.NextaPostStudio) root.NextaPostStudio.useStyle(styleId); }

    root.NextaPromote = { mount, save, thumb, openTemplate, openPost, _state: state };
})(window);
