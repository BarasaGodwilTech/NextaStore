/**
 * Templates page (dashboard nav "Templates"): every look in one place, drawn with THIS store's products, logo and colours.
 * Tap a tile and the Promote studio opens on that look. Works the same on a phone.
 *   NextaTemplates.mount(dashboardManager)
 */
(function (root) {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const NEW_POSTS = ['arch', 'drop', 'catalogue', 'bold', 'round', 'soft'];
    const NEW_TPLS = ['opening', 'sale', 'scansign', 'delivery', 'openhours', 'thanks', 'flash', 'newin'];
    const CATS = [{ id: 'all', label: 'All' }, { id: 'posts', label: 'Product posts' }, { id: 'poster', label: 'Posters & signs' }, { id: 'social', label: 'Social' }, { id: 'card', label: 'Business cards' }];
    const MAX_PAR = 3, TILE_MS = 12000, MOUNT_MS = 15000;
    const state = { dash: null, filter: 'all', built: false, token: 0, pending: [], running: 0 };
    const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

    function items() {
        const P = root.NextaPosts, K = root.NextaBrandKit, out = [];
        if (P) P.STYLES.forEach((s) => out.push({ kind: 'post', id: s.id, label: s.label, sub: s.sub, cat: 'posts', fresh: NEW_POSTS.includes(s.id) }));
        if (K) K.TEMPLATES.forEach((t) => out.push({ kind: 'tpl', id: t.id, label: t.label, sub: t.mm ? `Print · ${t.mm[0]} × ${t.mm[1]} mm` : `${t.w} × ${t.h} px`, cat: t.group, fresh: NEW_TPLS.includes(t.id) }));
        return out;
    }
    function buildFilters() {
        const box = $('tpFilters'); box.innerHTML = '';
        CATS.forEach((c) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'tp-chip' + (c.id === state.filter ? ' is-on' : ''); b.textContent = c.label; b.setAttribute('aria-pressed', String(c.id === state.filter));
            b.addEventListener('click', () => { state.filter = c.id; buildFilters(); buildGrid(); });
            box.appendChild(b);
        });
    }
    /** Tiles are drawn three at a time, and a tile that takes too long gives up (and says so) instead of spinning. */
    function pump() {
        while (state.running < MAX_PAR && state.pending.length) {
            const job = state.pending.shift(); state.running++;
            job().catch(() => {}).then(() => { state.running--; pump(); });
        }
    }
    function draw(item, canvas, spin) {
        const tok = state.token, wrap = canvas.parentElement, note = wrap.querySelector('.tp-blank');
        state.pending.push(async () => {
            if (tok !== state.token) return;
            let res = false;
            try {
                const work = item.kind === 'post' ? root.NextaPostStudio.renderTile(canvas, item.id, 420) : root.NextaPromote.thumb(canvas, item.id, 420);
                res = await Promise.race([work, wait(TILE_MS, 'slow')]);
            } catch (e) { res = false; }
            if (tok !== state.token) return;
            const noProducts = !(root.NextaPostStudio._state.products || []).length;
            if (note) note.textContent = res === 'slow' ? 'Preview is taking too long. Tap to use this look anyway.' : (noProducts && item.kind === 'post' ? 'Add a product to see this look' : 'Preview unavailable. Tap to use this look.');
            wrap.classList.toggle('is-blank', res !== true);
            spin.hidden = true;
        });
        pump();
    }
    function open(item) {
        const dash = state.dash; if (!dash) return;
        Promise.resolve(dash.switchSection('promote')).then(() => {
            if (item.kind === 'post') root.NextaPromote.openPost(item.id); else root.NextaPromote.openTemplate(item.id);
            root.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
    function buildGrid() {
        const box = $('tpGrid'); box.innerHTML = ''; state.token++; state.pending = [];
        const list = items().filter((i) => state.filter === 'all' || i.cat === state.filter);
        const io = 'IntersectionObserver' in root ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); e.target._go(); } }), { rootMargin: '300px' }) : null;
        list.forEach((it) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'tp-tile';
            b.innerHTML = `<span class="tp-thumb"><canvas aria-hidden="true"></canvas><span class="tp-spin pm-spin" aria-hidden="true"></span><span class="tp-blank">Add a product to see this look</span>${it.fresh ? '<span class="tp-new">NEW</span>' : ''}</span><span class="tp-name"></span><span class="tp-sub"></span>`;
            b.querySelector('.tp-name').textContent = it.label; b.querySelector('.tp-sub').textContent = it.sub;
            b.setAttribute('aria-label', `Use ${it.label}`);
            b.addEventListener('click', () => open(it));
            const canvas = b.querySelector('canvas'), spin = b.querySelector('.tp-spin');
            b._go = () => draw(it, canvas, spin);
            box.appendChild(b); if (io) io.observe(b); else b._go();
        });
    }
    async function mount(dash) {
        state.dash = dash;
        if (!root.NextaPostStudio || !root.NextaPromote || !root.NextaPosts || !root.NextaBrandKit) throw new Error('The template tools did not load. Refresh the page.');
        const grid = $('tpGrid'); if (grid && !state.built) grid.innerHTML = '<div class="pp-loading"><span class="pm-spin"></span> Getting your templates ready\u2026</div>';
        if (!root.NextaPromote._state.mounted) root.NextaPromote.mount(dash);
        if (!root.NextaPostStudio._state.loadedProducts) await Promise.race([root.NextaPostStudio.mount(dash), wait(MOUNT_MS)]).catch(() => {});   // never wait forever for the product list
        state.built = true; buildFilters(); buildGrid();
    }
    root.NextaTemplates = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
