/* Staff Console UI kit, part 2: explanations (help pop-ups, page intros), charts, the PIN pad, role capability preview, skeletons.
 * Everything is built with h() (never innerHTML with data) so the strict CSP and escaping rules keep holding. */
(function (root) {
    'use strict';
    const S = root.Staff;
    const { h, mount } = S;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v)); kids.flat().forEach((c) => { if (c) e.appendChild(c); }); return e; };
    const store = { get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

    // ---- Help pop-ups -------------------------------------------------------------------------------------------------
    let openPop = null;
    function closePop() { if (openPop) { openPop.pop.hidden = true; openPop.btn.setAttribute('aria-expanded', 'false'); openPop = null; } }
    document.addEventListener('click', (e) => { if (openPop && !e.target.closest('.help-wrap')) closePop(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { const b = openPop.btn; closePop(); b.focus(); } });
    /** A small "?" that opens a plain-language explanation. `text` may be a string or a node. */
    S.help = (text, title) => {
        const pop = h('div', { class: 'pop', role: 'tooltip', hidden: true }, title ? h('strong', null, title) : null, text instanceof Node ? text : h('div', null, text));
        const btn = h('button', { class: 'help', type: 'button', 'aria-label': `What does ${title || 'this'} mean?`, 'aria-expanded': 'false', onclick: (e) => {
            e.preventDefault(); e.stopPropagation();
            if (openPop && openPop.pop === pop) return closePop();
            closePop(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); openPop = { pop, btn };
        } }, '?');
        return h('span', { class: 'help-wrap' }, btn, pop);
    };

    /** A dismissible "what is this page for" card. Remembered per browser; the person can bring it back from the page's ? button. */
    S.intro = (key, title, text, bullets) => {
        const k = `staff.intro.${key}`;
        if (store.get(k) === '1') return null;
        const box = h('aside', { class: 'intro' }, h('div', { class: 'grow' }, h('strong', null, title), h('p', null, text), bullets && bullets.length ? h('ul', null, bullets.map((b) => h('li', null, b))) : null),
            h('button', { class: 'btn sm', type: 'button', onclick: () => { store.set(k, '1'); box.remove(); } }, 'Got it'));
        return box;
    };

    // ---- Charts (SVG, no library) ---------------------------------------------------------------------------------------
    /** values: [n]; labels: [string] (same length). Bars with a baseline, a max gridline and a title tooltip per bar. */
    S.barChart = (values, labels, { height = 150, fmt = S.num, ariaLabel = 'Bar chart' } = {}) => {
        const W = 560, pad = { l: 8, r: 8, t: 14, b: 22 }, n = values.length || 1, max = Math.max(1, ...values);
        const bw = (W - pad.l - pad.r) / n;
        const bars = values.map((v, i) => { const bh = Math.max(2, (v / max) * (height - pad.t - pad.b)); return svg('rect', { class: 'bar', x: pad.l + i * bw + bw * 0.14, y: height - pad.b - bh, width: bw * 0.72, height: bh, rx: 3 }, (() => { const t = svg('title'); t.textContent = `${labels[i]}: ${fmt(v)}`; return t; })()); });
        const tick = (i) => { const t = svg('text', { class: 'ax', x: pad.l + i * bw + bw / 2, y: height - 6, 'text-anchor': 'middle' }); t.textContent = labels[i]; return t; };
        const every = Math.ceil(n / 8);
        const top = svg('text', { class: 'ax', x: pad.l, y: 10 }); top.textContent = fmt(max);
        const root_ = svg('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': ariaLabel, preserveAspectRatio: 'none' },
            svg('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: pad.t, y2: pad.t }), svg('line', { class: 'base', x1: pad.l, x2: W - pad.r, y1: height - pad.b, y2: height - pad.b }), top, bars, values.map((_, i) => (i % every === 0 ? tick(i) : null)));
        return root_;
    };
    S.sparkline = (values, { w = 96, hgt = 28 } = {}) => {
        const max = Math.max(1, ...values), min = Math.min(...values, 0), n = Math.max(1, values.length - 1);
        const pts = values.map((v, i) => `${(i / n) * w},${hgt - 3 - ((v - min) / (max - min || 1)) * (hgt - 6)}`).join(' ');
        return svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'spark', 'aria-hidden': 'true' }, svg('polyline', { points: pts }));
    };
    /** parts: [{ label, value, tone: 'a'|'b'|'c'|'d' }]. */
    S.donut = (parts, { size = 120, center = '' } = {}) => {
        const total = parts.reduce((s, p) => s + p.value, 0) || 1, r = 42, c = 2 * Math.PI * r; let off = 0;
        const arcs = parts.map((p) => { const len = (p.value / total) * c; const a = svg('circle', { class: `arc ${p.tone || 'a'}`, cx: 50, cy: 50, r, 'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 50 50)' }); off += len; return a; });
        const mid = svg('text', { class: 'mid', x: 50, y: 55, 'text-anchor': 'middle' }); mid.textContent = center;
        return h('div', { class: 'donut' }, svg('svg', { viewBox: '0 0 100 100', width: size, height: size, role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.value}`).join(', ') }, svg('circle', { class: 'track', cx: 50, cy: 50, r }), arcs, mid),
            h('ul', null, parts.map((p) => h('li', null, h('i', { class: `dot ${p.tone || 'a'}` }), `${p.label} · ${S.num(p.value)}`))));
    };
    S.statTile = (n, l, { href, tone, spark, hint } = {}) => h(href ? 'a' : 'div', { class: `stat ${tone || ''}`, href: href || null }, h('div', { class: 'n' }, n, spark ? S.sparkline(spark) : null), h('div', { class: 'l' }, l, hint ? S.help(hint, l) : null));

    // ---- PIN pad --------------------------------------------------------------------------------------------------------
    /**
     * Six dots and a keypad (digits also work from the keyboard). `onDone(pin)` may return a promise; throw to show an error and clear.
     * Returns { el, reset, focus }.
     */
    S.pinPad = ({ length = 6, onDone }) => {
        let val = ''; let busy = false;
        const dots = Array.from({ length }, () => h('i', { class: 'pd' }));
        const msg = h('div', { class: 'err center', role: 'alert' });
        const el = h('div', { class: 'pinpad', tabindex: 0, 'aria-label': 'Enter your 6 digit PIN' }, h('div', { class: 'pdots', 'aria-hidden': 'true' }, dots), msg);
        const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < val.length));
        async function push(d) {
            if (busy || val.length >= length) return; val += d; msg.textContent = ''; paint();
            if (val.length === length) { busy = true; el.classList.add('busy'); try { await onDone(val); } catch (e) { msg.textContent = e.message || 'That did not work.'; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); } busy = false; el.classList.remove('busy'); val = ''; paint(); }
        }
        const key = (label, fn, cls) => h('button', { class: `pk ${cls || ''}`, type: 'button', onclick: fn }, label);
        const pad = h('div', { class: 'pkeys' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => push(d))), h('span'), key('0', () => push('0')), key('⌫', () => { if (!busy) { val = val.slice(0, -1); paint(); } }, 'del'));
        pad.querySelector('.del').setAttribute('aria-label', 'Delete last digit');
        el.append(pad);
        el.addEventListener('keydown', (e) => { if (/^\d$/.test(e.key)) { e.preventDefault(); push(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); if (!busy) { val = val.slice(0, -1); paint(); } } });
        return { el, reset() { val = ''; paint(); msg.textContent = ''; }, focus() { el.focus(); } };
    };

    // ---- Role capability preview ---------------------------------------------------------------------------------------
    /**
     * "What will this person be able to do?" Plain-language, grouped like the role editor. `role` = { name, description, permissions, rank };
     * `catalog` = the /roles catalog ({ groups: [{ key, label, permissions: [{ key, label, description, sensitive }] }] }).
     */
    S.capabilities = (role, catalog, { compact = false } = {}) => {
        if (!role) return h('p', { class: 'muted' }, 'Choose a role to see what it allows.');
        const has = new Set(role.permissions || []);
        const can = [], cannot = [];
        for (const g of catalog.groups) {
            const mine = g.permissions.filter((p) => has.has(p.key));
            if (mine.length) can.push(h('div', { class: 'cap-group' }, h('div', { class: 'cap-title' }, g.label), h('ul', null, mine.map((p) => h('li', { class: 'yes' }, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('span', null, h('strong', null, p.label), compact ? null : h('span', { class: 'muted' }, ` — ${p.description}`)), p.sensitive ? h('span', { class: 'badge warn pin-tag', title: 'Asks for this person\'s PIN each time' }, 'PIN') : null)))));
            else cannot.push(g.label);
        }
        const sensitive = catalog.groups.flatMap((g) => g.permissions).filter((p) => has.has(p.key) && p.sensitive).length;
        return h('div', { class: 'caps', 'aria-live': 'polite' },
            h('div', { class: 'caps-head' }, h('strong', null, role.name), h('span', { class: 'badge info' }, `${has.size} permission${has.size === 1 ? '' : 's'}`), sensitive ? h('span', { class: 'badge warn' }, `${sensitive} need a PIN`) : null),
            role.description ? h('p', { class: 'muted small' }, role.description) : null,
            can.length ? can : h('p', { class: 'muted' }, 'This role cannot do anything yet.'),
            cannot.length ? h('p', { class: 'cap-no small' }, h('strong', null, 'No access to: '), cannot.join(', ')) : null);
    };

    // ---- Skeletons ---------------------------------------------------------------------------------------------------------
    S.skeleton = (kind = 'page') => {
        const bar = (w) => h('div', { class: 'skel', style: `width:${w}%` });
        if (kind === 'table') return h('div', { class: 'card sk-table', 'aria-busy': 'true' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'sk-row' }, bar(30), bar(20), bar(15), bar(15))));
        return h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div', { class: 'skel sk-title' }), h('div', { class: 'stats' }, [1, 2, 3, 4].map(() => h('div', { class: 'stat' }, h('div', { class: 'skel sk-num' }), bar(60)))), h('div', { class: 'card' }, bar(40), h('div', { class: 'skel sk-block' })));
    };

    // ---- Roles -> colours, copy ---------------------------------------------------------------------------------------------
    S.ROLE_THEME = { super_admin: 'owner', platform_admin: 'ops', finance_manager: 'money', growth_manager: 'growth', trust_safety_lead: 'safety', moderator: 'safety', support_lead: 'support', support_agent: 'support', support_trainee: 'support', store_manager: 'ops', auditor: 'audit' };
    S.ROLE_HOME = {
        owner: 'Everything about the platform, and the controls for your team.', ops: 'Day-to-day operations across stores, orders and people.', money: 'Payments to review and money coming in.',
        growth: 'Circle and Crew partners, campaigns and risk.', safety: 'Reports, restrictions and anything that needs a decision.', support: 'Your tickets, the customers waiting, and quick replies.', audit: 'Read-only oversight of activity and payments.'
    };
})(window);
