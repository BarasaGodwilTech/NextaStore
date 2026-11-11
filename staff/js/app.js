/* Staff Console shell: boot, session guard, role-aware navigation, hash router, step-up confirmation, live counts. */
(function (root) {
    'use strict';
    const Staff = root.Staff;
    const { h, mount, icon, toast, overlay, initials, api } = Object.assign({}, Staff, { api: Staff.api });

    const sections = Staff.sections;   // sections register themselves via Staff.register (ui.js): { key, title, icon, group, any: [perms], render(ctx), badge }

    const state = { me: null, counts: {} };
    const can = (p) => !!(state.me && state.me.permissions && state.me.permissions.includes(p));
    const canAny = (list) => !list || !list.length || list.some(can);
    Staff.state = state; Staff.can = can; Staff.canAny = canAny;

    const GROUPS = [['work', 'Work'], ['market', 'Marketplace'], ['finance', 'Money'], ['comms', 'Messages'], ['team', 'Team & security'], ['me', 'You']];

    // ---- Session handling --------------------------------------------------------------------------------------------
    let lost = false;
    function sessionLost(code) {
        if (lost) return; lost = true;
        const msg = { STAFF_SESSION_IDLE: 'You were signed out because of inactivity.', STAFF_SESSION_EXPIRED: 'Your session reached its maximum length.', STAFF_INACTIVE: 'This account is no longer active.' }[code] || 'Your session ended.';
        mount(document.body, h('div', { class: 'overlay-lock', role: 'alertdialog', 'aria-label': 'Signed out' },
            h('div', { class: 'card', style: 'max-width:380px' }, h('h2', null, 'Signed out'), h('p', { class: 'muted' }, `${msg} Sign in again to continue.`), h('a', { class: 'btn primary block', href: 'login?reason=' + encodeURIComponent(code || '') }, 'Sign in'))));
    }
    api.onSessionLost = sessionLost;

    // Step-up: sensitive actions ask for the person's PIN first. Resolves true when confirmed. (An authenticator code works too, for a forgotten PIN.)
    let reauthPending = null;
    api.onReauth = () => {
        if (reauthPending) return reauthPending;
        reauthPending = new Promise((resolve) => {
            const body = h('div', { class: 'stack' });
            let ov;
            const pad = Staff.pinPad({ onDone: async (pin) => { await api.post('/auth/reauth', { pin }); ov.close(true); } });
            const forgot = () => {
                const input = h('input', { name: 'v', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, class: 'code-input', required: true, 'aria-label': 'Authenticator code' });
                const err = h('div', { class: 'err', role: 'alert' });
                const form = h('form', { class: 'stack', novalidate: true }, h('p', { class: 'why' }, 'Enter the 6-digit code from your authenticator app to confirm it is you, then choose a new PIN.'), input, err, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => mount(body, ...main()) }, 'Back'), h('button', { class: 'btn primary', type: 'submit' }, 'Continue')));
                form.addEventListener('submit', async (e) => { e.preventDefault(); err.textContent = ''; try { await api.post('/auth/reauth', { code: input.value.trim() }); await Staff.changePinDialog({ viaCode: input.value.trim() }); ov.close(true); } catch (x) { err.textContent = x.message; } });
                mount(body, h('h2', null, 'Forgot your PIN?'), form); input.focus();
            };
            const main = () => [h('div', { class: 'lock' }, icon('lock')), h('h2', null, 'Enter your PIN'), h('p', { class: 'why' }, 'This action is sensitive, so we double-check it is you. It is recorded in the audit log.'), pad.el, h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'link-btn', type: 'button', onclick: forgot }, 'Forgot PIN?'), h('button', { class: 'link-btn', type: 'button', onclick: () => ov.close(false) }, 'Cancel'))];
            mount(body, ...main());
            ov = overlay(h('div', { class: 'modal pin-modal' }, body), { label: 'Enter your PIN', onClose: (r) => { reauthPending = null; resolve(r === true); } });
            setTimeout(() => pad.focus(), 30);
        });
        return reauthPending;
    };

    /** Choose a PIN (first time, or after "forgot"). `viaCode` is a just-verified authenticator code used for the reset path. Resolves true when saved. */
    Staff.changePinDialog = ({ first = false, viaCode = null, currentRequired = false } = {}) => new Promise((resolve) => {
        let step = 'new', chosen = '', current = ''; let ov; const body = h('div', { class: 'stack' });
        const draw = () => {
            const title = step === 'current' ? 'Enter your current PIN' : step === 'new' ? (first ? 'Create your security PIN' : 'Choose a new PIN') : 'Type it once more';
            const hint = step === 'new' ? 'Six digits you can remember. Not 123456 or 111111. You will type it before sensitive actions like approving payments or changing who has access.' : step === 'again' ? 'To make sure you typed what you meant.' : '';
            const pad = Staff.pinPad({ onDone: async (pin) => {
                if (step === 'current') { current = pin; step = 'new'; return draw(); }
                if (step === 'new') { if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new Error('Too easy to guess. Pick another.'); chosen = pin; step = 'again'; return draw(); }
                if (pin !== chosen) { step = 'new'; chosen = ''; draw(); throw new Error('The two PINs did not match. Start again.'); }
                if (viaCode) await api.post('/me/pin/reset', { code: viaCode, newPin: chosen }); else if (currentRequired) await api.post('/me/pin/change', { currentPin: current, newPin: chosen }); else await api.post('/me/pin', { pin: chosen });
                ov.close(true);
            } });
            mount(body, h('div', { class: 'lock' }, icon('lock')), h('h2', null, title), hint ? h('p', { class: 'why' }, hint) : null, pad.el, first ? null : h('button', { class: 'link-btn', type: 'button', onclick: () => ov.close(false) }, 'Cancel'));
            setTimeout(() => pad.focus(), 30);
        };
        if (currentRequired && !viaCode) step = 'current';
        draw();
        ov = overlay(h('div', { class: 'modal pin-modal' }, body), { label: 'Security PIN', onClose: (r) => resolve(r === true) });
    });

    // ---- Layout ---------------------------------------------------------------------------------------------------------
    const view = h('main', { class: 'main', id: 'main', tabindex: '-1' });
    const nav = h('nav', { class: 'nav', 'aria-label': 'Console sections' });
    const side = h('aside', { class: 'side', id: 'side' }, nav);
    let current = null;

    function visible() { return sections.filter((s) => canAny(s.any)); }

    function buildNav() {
        const vis = visible();
        mount(nav, GROUPS.map(([g, label]) => {
            const items = vis.filter((s) => s.group === g);
            if (!items.length) return null;
            return h('div', { class: 'nav-group' }, h('div', { class: 'nav-label' }, label),
                items.map((s) => h('a', { href: `#${s.key}`, dataset: { key: s.key }, 'aria-current': current === s.key ? 'page' : null }, icon(s.icon), h('span', null, s.title),
                    state.counts[s.badge] ? h('span', { class: 'count', 'aria-label': `${state.counts[s.badge]} need attention` }, state.counts[s.badge] > 99 ? '99+' : state.counts[s.badge]) : null)));
        }));
    }

    async function route() {
        document.body.classList.remove('nav-open');
        const vis = visible();
        const [keyRaw, ...rest] = (location.hash || '').replace(/^#/, '').split('/');
        const sec = vis.find((s) => s.key === keyRaw) || vis[0];
        if (!sec) { mount(view, h('div', { class: 'card empty' }, 'Your role has no console sections yet. Ask a Super Admin to review your access.')); return; }
        current = sec.key; buildNav();
        document.title = `${sec.title} · NextaStore Staff`;
        mount(view, Staff.skeleton(sec.skeleton || 'page'));
        try {
            const node = await sec.render({ me: state.me, can, canAny, arg: rest.join('/'), refresh: route });
            if (current === sec.key) { node.classList && node.classList.add('fade-in'); mount(view, node); view.focus({ preventScroll: true }); }
        } catch (err) {
            if (current === sec.key) mount(view, h('div', { class: 'banner bad' }, err && err.message ? err.message : 'This page could not be loaded.'));
        }
    }

    async function loadCounts() {
        const out = {}; const jobs = [];
        if (can('tickets.view')) jobs.push(api.get('/tickets/counts', { poll: true }).then((c) => { out.tickets = (c.breached || 0) + (c.unassigned || 0); }).catch(() => {}));
        if (can('subscriptions.review')) jobs.push(api.get('/overview', { poll: true }).then((o) => { out.payments = o.attention.pendingPayments || 0; out.reports = o.attention.openReports || 0; out.orders = o.attention.flaggedOrders || 0; out.followups = o.attention.myFollowUps || 0; }).catch(() => {}));
        else if (can('dashboard.view')) jobs.push(api.get('/overview', { poll: true }).then((o) => { out.reports = o.attention.openReports || 0; out.orders = o.attention.flaggedOrders || 0; out.followups = o.attention.myFollowUps || 0; }).catch(() => {}));
        await Promise.all(jobs);
        state.counts = out; buildNav();
    }

    function shell() {
        const me = state.me;
        const menuBtn = h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'side', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu'));
        const acct = h('a', { class: 'me-btn', href: '#account', 'aria-label': 'Your account' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(me.name)), h('span', { class: 'who' }, me.name, h('small', null, me.role ? me.role.name : '')));
        const out = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onclick: async () => { try { await api.post('/auth/logout'); } catch (e) { /* ignore */ } location.replace('login'); } }, icon('logout'));
        mount(document.body,
            h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
            h('header', { class: 'topbar' }, menuBtn, h('span', { class: 'brand' }, h('img', { src: '../assets/brand/svg/icon.svg', alt: '' }), h('span', null, 'NextaStore', h('small', null, 'Staff Console'))), h('button', { class: 'search-btn', type: 'button', 'aria-label': 'Search everything', onclick: () => Staff.openPalette() }, icon('search'), h('span', { class: 't' }, 'Search people, orders, tickets…'), h('kbd', null, 'Ctrl K')), h('span', { class: 'spacer' }), h('span', { class: 'role-chip' }, me.role ? me.role.name : 'Staff'), acct, out),
            h('div', { class: 'shell' }, side, view));
    }

    const me_role = () => (state.me && state.me.role ? state.me.role.key : '');

    async function boot() {
        try {
            state.me = await api.get('/me');
        } catch (err) { location.replace('login'); return; }
        api.setCsrf(state.me.session && state.me.session.csrfToken);
        if (state.me.mustChangePassword) {
            // Forced change (invited, migrated or reset-by-staff accounts): nothing else is reachable until it is done.
            mount(document.body, h('div', { class: 'overlay-lock' }, h('div', { class: 'card', style: 'max-width:420px;text-align:left' },
                h('h2', null, 'Choose a new password'), h('p', { class: 'muted' }, 'Your account needs a new password before you can continue.'),
                Staff.passwordForm(() => location.reload()))));
            return;
        }
        document.body.dataset.theme = Staff.ROLE_THEME[me_role()] || '';
        if (!state.me.pinSet) { shell(); buildNav(); mount(view, h('div', { class: 'card empty' }, 'One quick step before you start…')); await Staff.changePinDialog({ first: true }); state.me = await api.get('/me'); api.setCsrf(state.me.session && state.me.session.csrfToken); buildNav(); }
        else { shell(); buildNav(); }
        window.addEventListener('hashchange', route);
        await route();
        loadCounts(); setTimeout(() => { if (can('dashboard.view')) api.prefetch('/overview'); if (can('staff.view')) api.prefetch('/roles'); }, 1500);
        setInterval(() => { if (!document.hidden && !lost) loadCounts(); }, 60000);
        // Idle guard: the server enforces it; this just tells the person instead of failing on the next click.
        const idleMs = ((state.me.session && state.me.session.idleMinutes) || 30) * 60000;
        let last = Date.now();
        ['click', 'keydown', 'pointerdown'].forEach((e) => document.addEventListener(e, () => { last = Date.now(); }, { passive: true }));
        setInterval(() => { if (!lost && Date.now() - last > idleMs - 60000) { toast('You will be signed out soon because of inactivity.', 'warn'); last = Date.now() - idleMs + 90000; } }, 30000);
    }

    // ---- Command palette (Ctrl/Cmd + K): jump to any page, or search people, stores, orders, tickets and staff you may see -----------------
    let paletteOpen = false;
    Staff.openPalette = () => {
        if (paletteOpen) return; paletteOpen = true;
        const input = h('input', { type: 'search', placeholder: 'Type a name, email, order number or ticket…', 'aria-label': 'Search', autocomplete: 'off' });
        const list = h('ul', { role: 'listbox' });
        const foot = h('div', { class: 'foot' }, h('kbd', null, '↑'), ' ', h('kbd', null, '↓'), ' to move · ', h('kbd', null, 'Enter'), ' to open · ', h('kbd', null, 'Esc'), ' to close');
        let items = []; let idx = 0; let reqId = 0;
        const pages = () => visible().map((x) => ({ type: 'page', title: x.title, sub: 'Go to page', go: x.key, icon: x.icon }));
        const draw = () => {
            mount(list, items.length ? items.map((it, i) => h('li', null, h('a', { role: 'option', 'aria-selected': String(i === idx), href: '#' + it.go, onclick: () => ov.close() }, it.icon ? icon(it.icon) : null, h('span', null, h('strong', null, it.title), it.sub ? h('div', { class: 'muted small' }, it.sub) : null), h('small', null, it.type)))) : h('li', { class: 'empty' }, 'No matches.'));
        };
        const run = Staff.debounce(async () => {
            const q = input.value.trim(); const my = ++reqId;
            const pg = pages().filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()));
            if (q.length < 2) { items = pg; idx = 0; return draw(); }
            try { const r = await api.get('/search', { query: { q }, poll: true }); if (my !== reqId) return; items = [...r.results, ...pg]; } catch (e) { items = pg; }
            idx = 0; draw();
        }, 200);
        input.addEventListener('input', run);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
            else if (e.key === 'Enter' && items[idx]) { e.preventDefault(); location.hash = '#' + items[idx].go; ov.close(); }
        });
        const ov = Staff.overlay(h('div', { class: 'palette' }, input, list, foot), { cls: 'palette-scrim', label: 'Search', onClose: () => { paletteOpen = false; } });
        items = pages(); draw();
    };
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.me) { e.preventDefault(); Staff.openPalette(); } });

    Staff.boot = boot;
    document.addEventListener('DOMContentLoaded', boot);
})(window);
