/* Staff Console UI toolkit: DOM builder (never innerHTML with data), inline SVG icons, dialogs, tables, formatting. */
(function (root) {
    'use strict';
    const Staff = root.Staff = root.Staff || {};

    // ---- DOM builder ------------------------------------------------------------------------------------------
    // h('div', { class: 'x', onclick: fn, dataset: {a: 1} }, 'text', childNode, [arrayOfChildren])
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k === 'text') el.textContent = v;
            else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }   // CSSOM, so the page CSP needs no inline-style allowance
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
            else el.setAttribute(k, v === true ? '' : String(v));
        }
        add(el, kids);
        return el;
    }
    function add(el, kids) {
        for (const kid of kids.flat(Infinity)) {
            if (kid === null || kid === undefined || kid === false) continue;
            el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
        }
        return el;
    }
    const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
    const mount = (el, ...kids) => add(clear(el), kids);

    // ---- Icons (static, trusted path data only) --------------------------------------------------------------
    const ICONS = {
        dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
        store: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
        box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
        bag: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
        flag: '<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
        ticket: '<path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/><path d="M13 6v12"/>',
        tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        bot: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01M16 14h.01"/>',
        cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
        megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l8 5V5L7 10H4a1 1 0 0 0-1 1z"/><path d="M19 8a5 5 0 0 1 0 8"/>',
        sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3"/>',
        lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
        logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
        menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
        x: '<path d="M18 6L6 18M6 6l12 12"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
        alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        check: '<path d="M20 6L9 17l-5-5"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        growth: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
        id: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M15 9h3M15 13h3M6 17c.6-1.7 1.7-2.5 3-2.5s2.4.8 3 2.5"/>',
        pin: '<path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'
    };
    function icon(name) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
        s.innerHTML = ICONS[name] || ICONS.list;     // trusted constants only
        return s;
    }

    // ---- Formatting ---------------------------------------------------------------------------------------------
    const pad = (n) => String(n).padStart(2, '0');
    function date(v, withTime = true) {
        if (!v) return '—';
        const d = new Date(v); if (Number.isNaN(d.getTime())) return '—';
        const day = `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${d.getFullYear()}`;
        return withTime ? `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
    }
    function ago(v) {
        if (!v) return 'never';
        const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
        if (!Number.isFinite(s)) return '—';
        if (s < 0) { const f = -s; return f < 3600 ? `in ${Math.max(1, Math.round(f / 60))} min` : f < 86400 ? `in ${Math.round(f / 3600)} h` : `in ${Math.round(f / 86400)} d`; }
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
        return date(v, false);
    }
    const money = (n) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
    const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
    const label = (s) => String(s || '').replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

    const TONES = { active: 'good', ok: 'good', approved: 'good', paid: 'good', resolved: 'good', done: 'good', delivered: 'good', live: 'good', verified: 'good',
        pending: 'warn', invited: 'warn', open: 'warn', processing: 'warn', in_progress: 'warn', high: 'warn', requested: 'warn', applied: 'warn', review: 'warn', draft: 'warn', normal: '', low: '',
        suspended: 'bad', restricted: 'bad', rejected: 'bad', cancelled: 'bad', urgent: 'bad', declined: 'bad', frozen: 'bad', closed: '', shipped: 'info' };
    const badge = (text, tone) => h('span', { class: `badge ${tone !== undefined ? tone : (TONES[String(text).toLowerCase().replace(/ /g, '_')] || '')}` }, label(text));

    // ---- Toast ------------------------------------------------------------------------------------------------------
    function toast(message, tone) {
        let box = document.querySelector('.toasts');
        if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(box); }
        const t = h('div', { class: `toast ${tone || ''}` }, message);
        box.appendChild(t);
        setTimeout(() => t.remove(), tone === 'bad' ? 7000 : 4000);
    }

    // ---- Modal / drawer -------------------------------------------------------------------------------------------------
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    function overlay(node, { cls = '', label: aria, onClose } = {}) {
        const prev = document.activeElement;
        const scrim = h('div', { class: `scrim ${cls}` }, node);
        node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); if (aria) node.setAttribute('aria-label', aria);
        const close = (result) => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if (prev && prev.focus) prev.focus(); if (onClose) onClose(result); };
        function onKey(e) {
            if (e.key === 'Escape') { e.stopPropagation(); close(null); return; }
            if (e.key === 'Tab') {
                const f = [...node.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(scrim);
        const first = node.querySelector('[autofocus],input,select,textarea') || node.querySelector('button');
        if (first) setTimeout(() => first.focus(), 0);
        return { close, scrim };
    }

    function fieldEl(f) {
        const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
        let input;
        if (f.type === 'select') {
            input = h('select', { id, name: f.name }, (f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
        } else if (f.type === 'textarea') {
            input = h('textarea', { id, name: f.name, rows: f.rows || 4, maxlength: f.max, placeholder: f.placeholder || '' }); input.value = f.value || '';
        } else if (f.type === 'checkbox') {
            input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
            return { input, wrap: h('label', { class: 'check', for: id }, input, h('span', null, f.label, f.hint ? h('span', { class: 'muted' }, ` ${f.hint}`) : null)) };
        } else {
            input = h('input', { id, name: f.name, type: f.type || 'text', maxlength: f.max, placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', inputmode: f.inputmode, min: f.min, max: f.type === 'number' ? f.maxValue : undefined, step: f.step }); input.value = f.value ?? '';
        }
        if (f.required) input.required = true;
        return { input, wrap: h('label', { class: 'f', for: id }, h('span', { class: 'lbl' }, f.label, f.help && Staff.help ? Staff.help(f.help, f.label) : null), input, f.hint ? h('span', { class: 'hint' }, f.hint) : null) };
    }
    function readField(f, input) {
        if (f.type === 'checkbox') return input.checked;
        if (f.type === 'number') return input.value === '' ? null : Number(input.value);
        return typeof input.value === 'string' ? input.value.trim() : input.value;
    }

    /** A form dialog. Resolves to { name: value } or null. `submit(values)` may throw to show an inline error and stay open. */
    function askBox({ title, intro, fields = [], confirm = 'Save', danger = false, wide = false, submit, body }) {
        return new Promise((resolve) => {
            const inputs = fields.map(fieldEl);
            const errBox = h('div', { class: 'err', role: 'alert' });
            const okBtn = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit' }, confirm);
            const form = h('form', { class: 'stack', novalidate: true },
                h('h2', null, title), intro ? (intro instanceof Node ? intro : h('p', { class: 'muted' }, intro)) : null, body || null,
                inputs.map((x) => x.wrap), errBox,
                h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ov.close(null) }, 'Cancel'), okBtn));
            const modal = h('div', { class: `modal ${wide ? 'wide' : ''}` }, form);
            const ov = overlay(modal, { label: title, onClose: resolve });
            form.addEventListener('submit', async (e) => {
                e.preventDefault(); errBox.textContent = '';
                const values = {};
                for (let i = 0; i < fields.length; i++) {
                    const v = readField(fields[i], inputs[i].input);
                    if (fields[i].required && (v === '' || v === null)) { errBox.textContent = `${fields[i].label} is required.`; inputs[i].input.focus(); return; }
                    values[fields[i].name] = v;
                }
                okBtn.disabled = true;
                try { if (submit) await submit(values); ov.close(values); }
                catch (err) { errBox.textContent = err && err.message ? err.message : 'Something went wrong.'; okBtn.disabled = false; }
            });
        });
    }
    const confirmBox = ({ title, text, confirm = 'Confirm', danger = false, submit }) => askBox({ title, intro: text, confirm, danger, submit });

    /** A right-hand panel. Returns { body, head, close, setTitle }. */
    function drawer(title, { onClose } = {}) {
        const titleEl = h('h2', null, title);
        const head = h('div', { class: 'drawer-head' }, titleEl, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => ov.close(null) }, icon('x')));
        const body = h('div', { class: 'drawer-body' });
        const ov = overlay(h('div', { class: 'drawer' }, head, body), { cls: 'drawer-scrim', label: title, onClose });
        return { body, head, close: ov.close, setTitle: (t) => { titleEl.textContent = t; } };
    }

    // ---- Lists --------------------------------------------------------------------------------------------------------
    function table(columns, rows, { onRow, empty = 'Nothing here yet.', rowLabel } = {}) {
        if (!rows.length) return h('div', { class: 'card empty' }, empty);
        let data = rows.slice(), sortKey = -1, dir = 1;
        const tbody = h('tbody');
        const paint = () => mount(tbody, data.map((r) => {
            const tr = h('tr', onRow ? { class: 'click', tabindex: 0, role: 'button', 'aria-label': rowLabel ? rowLabel(r) : null } : {},
                columns.map((c) => h('td', { class: c.class || '', 'data-label': c.label || null }, c.render ? c.render(r) : (r[c.key] ?? '—'))));
            if (onRow) {
                tr.addEventListener('click', (e) => { if (!e.target.closest('button,a,input,select,label')) onRow(r); });
                tr.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); onRow(r); } });
            }
            return tr;
        }));
        const heads = columns.map((c, i) => {
            if (!c.sort) return h('th', { scope: 'col' }, c.label);
            const b = h('button', { class: 'th-sort', type: 'button', onclick: () => { dir = sortKey === i ? -dir : 1; sortKey = i; data.sort((a, z) => { const x = c.sort(a), y = c.sort(z); return (x > y ? 1 : x < y ? -1 : 0) * dir; }); heads.forEach((th, j) => th.setAttribute('aria-sort', j === i ? (dir > 0 ? 'ascending' : 'descending') : 'none')); paint(); } }, c.label);
            return h('th', { scope: 'col', 'aria-sort': 'none' }, b);
        });
        paint();
        return h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, heads)), tbody));
    }
    function pager(state, onPage) {
        if (!state || !state.pages || state.pages <= 1) return state && state.total != null ? h('div', { class: 'pager' }, `${num(state.total)} result${state.total === 1 ? '' : 's'}`) : null;
        return h('div', { class: 'pager' }, h('span', null, `Page ${state.page} of ${state.pages} · ${num(state.total)} results`),
            h('span', { class: 'row' },
                h('button', { class: 'btn sm', type: 'button', disabled: state.page <= 1, onclick: () => onPage(state.page - 1) }, 'Previous'),
                h('button', { class: 'btn sm', type: 'button', disabled: state.page >= state.pages, onclick: () => onPage(state.page + 1) }, 'Next')));
    }
    const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

    /**
     * A filterable, paged list. `load(params)` -> { rows, page, pages, total }.
     * filters: [{ key, label, type: 'search'|'select', options: [{value,label}], value }]
     */
    function listView({ filters = [], load, columns, onRow, empty, rowLabel, extra }) {
        const params = { page: 1 };
        filters.forEach((f) => { if (f.value) params[f.key] = f.value; });
        const results = h('div', null, h('div', { class: 'skel' }));
        const bar = h('div', { class: 'toolbar' });
        let reqId = 0;
        async function run() {
            const my = ++reqId;
            results.setAttribute('aria-busy', 'true');
            try {
                const out = await load({ ...params });
                if (my !== reqId) return;
                mount(results, table(columns, out.rows, { onRow, empty, rowLabel }), pager(out, (p) => { params.page = p; run(); }));
            } catch (err) { if (my === reqId) mount(results, h('div', { class: 'banner bad' }, err.message || 'Could not load this list.')); }
            results.removeAttribute('aria-busy');
        }
        const rerun = debounce(() => { params.page = 1; run(); });
        for (const f of filters) {
            const id = `flt_${f.key}`;
            let input;
            if (f.type === 'select') {
                input = h('select', { id, onchange: () => { params[f.key] = input.value; params.page = 1; run(); } }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value || '') }, o.label)));
                bar.appendChild(h('label', { class: 'f', for: id }, f.label, input));
            } else {
                input = h('input', { id, type: 'search', placeholder: f.placeholder || 'Search…', value: f.value || '', oninput: () => { params[f.key] = input.value.trim(); rerun(); } });
                bar.appendChild(h('label', { class: 'f search', for: id }, f.label, input));
            }
        }
        bar.appendChild(h('button', { class: 'btn', type: 'button', onclick: run, 'aria-label': 'Refresh' }, icon('refresh'), 'Refresh'));
        if (extra) bar.appendChild(extra);
        run();
        return h('div', null, bar, results);
    }
    const opts = (pairs, anyLabel) => [...(anyLabel ? [{ value: '', label: anyLabel }] : []), ...pairs.map((p) => (Array.isArray(p) ? { value: p[0], label: p[1] } : { value: p, label: label(p) }))];

    const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), actions.length ? h('div', { class: 'row' }, actions) : null);
    const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]));

    function copyText(text) {
        const done = () => toast('Copied to clipboard.', 'good');
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(done, () => toast('Copy failed. Select the text and copy it manually.', 'bad'));
        const ta = h('textarea', { 'aria-hidden': 'true' }); ta.style.position = 'fixed'; ta.style.left = '-999px'; ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed.', 'bad'); } ta.remove();
        return Promise.resolve();
    }
    function saveText(filename, text, type = 'text/plain') {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = h('a', { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    Staff.sections = []; Staff.register = (sec) => { Staff.sections.push(sec); };
    Object.assign(Staff, { h, add, clear, mount, icon, date, ago, money, num, initials, label, badge, toast, overlay, askBox, confirmBox, drawer, table, pager, listView, opts, pageHead, kv, debounce, copyText, saveText });
})(window);
