/* Sections: Staff, Roles, Security, Audit log, Settings, Circle & Crew, My account. */
(function (root) {
    'use strict';
    const S = root.Staff, api = S.api;
    const { h, mount, icon, date, ago, money, num, label, badge, toast, askBox, confirmBox, drawer, listView, opts, pageHead, kv } = S;
    const sub = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);
    const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.code !== 'REAUTH_CANCELLED') toast(e.message, 'bad'); return null; } };


    /** Add / edit a staff member, with a live "what will they be able to do?" panel that follows the chosen role. */
    function staffForm({ title, intro, member, roleOpts, roles, catalog, confirm, submit }) {
        return new Promise((resolve) => {
            const f = (text, node, hint) => h('label', { class: 'f' }, text, node, hint ? h('span', { class: 'hint' }, hint) : null);
            const name = h('input', { name: 'name', value: member ? member.name : '', maxlength: 80, required: true, autocomplete: 'off' });
            const email = member ? null : h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' });
            const job = h('input', { name: 'jobTitle', value: member ? member.jobTitle : '', maxlength: 80 });
            const sel = h('select', { name: 'roleId', 'aria-label': 'Role' }, roleOpts.map((o) => h('option', { value: o.value, selected: member && member.role && o.value === member.role.id }, o.label)));
            const status = member && member.status !== 'invited' ? h('select', { name: 'status', 'aria-label': 'Status' }, [['active', 'Active'], ['suspended', 'Suspended']].map(([v, t]) => h('option', { value: v, selected: member.status === v }, t))) : null;
            const preview = h('div', null); const err = h('div', { class: 'err', role: 'alert' }); const ok = h('button', { class: 'btn primary', type: 'submit' }, confirm);
            const draw = () => mount(preview, S.capabilities(roles.find((r) => r.id === sel.value), catalog));
            sel.addEventListener('change', draw); draw();
            let ov;
            const form = h('form', { class: 'stack', novalidate: true }, h('h2', null, title), intro ? h('p', { class: 'muted' }, intro) : null,
                h('div', { class: 'staff-form' }, h('div', { class: 'stack' }, f('Full name', name), email ? f('Work email', email, 'The invitation goes here.') : null, f('Job title (optional)', job),
                    f('Role', sel, 'The role decides everything this person can see and do. Check the panel on the right.'), status ? f('Status', status) : null),
                    h('div', null, h('div', { class: 'small muted', style: 'margin-bottom:6px' }, 'What this person will be able to do'), preview)),
                err, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ov.close(null) }, 'Cancel'), ok));
            form.addEventListener('submit', async (e) => {
                e.preventDefault(); err.textContent = '';
                const v = { name: name.value.trim(), jobTitle: job.value.trim(), roleId: sel.value, ...(email ? { email: email.value.trim() } : {}), ...(status ? { status: status.value } : {}) };
                if (!v.name || (email && !v.email)) { err.textContent = 'Name and email are required.'; return; }
                ok.disabled = true; try { await submit(v); ov.close(v); } catch (x) { err.textContent = x.message; ok.disabled = false; }
            });
            ov = S.overlay(h('div', { class: 'modal wide' }, form), { label: title, onClose: resolve });
        });
    }

    // ---- Password form (also used for the forced change) ---------------------------------------------------------------
    S.passwordForm = (done) => {
        const f = (name, text, ac) => h('label', { class: 'f' }, text, h('input', { name, type: 'password', autocomplete: ac, required: true, minlength: name === 'currentPassword' ? null : 12 }));
        const err = h('div', { class: 'err', role: 'alert' }); const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
        const form = h('form', { class: 'stack', novalidate: true }, f('currentPassword', 'Current password', 'current-password'), f('newPassword', 'New password (12+ characters)', 'new-password'), f('again', 'Confirm new password', 'new-password'), err, h('div', null, btn));
        form.addEventListener('submit', async (e) => {
            e.preventDefault(); err.textContent = ''; const v = Object.fromEntries(new FormData(form));
            if (v.newPassword !== v.again) { err.textContent = 'The two new passwords do not match.'; return; }
            btn.disabled = true;
            try { await api.post('/me/password', { currentPassword: v.currentPassword, newPassword: v.newPassword }); toast('Password changed. Other devices were signed out.', 'good'); form.reset(); done && done(); }
            catch (x) { err.textContent = x.message; } btn.disabled = false;
        });
        return form;
    };

    // ---- Staff ----------------------------------------------------------------------------------------------------------------
    S.register({ key: 'staff', title: 'Staff', icon: 'id', group: 'team', any: ['staff.view', 'staff.manage'], async render() {
        const manage = S.can('staff.manage');
        const [rolesRes] = await Promise.all([api.swr('/roles', { ttl: 20000 })]); const roles = rolesRes.roles; const catalog = rolesRes.catalog;
        const roleOpts = roles.filter((r) => r.rank < (S.state.me.role ? S.state.me.role.rank : 0) || (S.state.me.role && S.state.me.role.key === 'super_admin' && r.key !== 'super_admin')).map((r) => ({ value: r.id, label: `${r.name}` }));
        const showInvite = (inv, who) => { if (inv && inv.devLink) askBox({ title: 'Invite link (development only)', intro: `Email delivery is not configured, so here is the link for ${who}. In production it is only ever emailed.`, confirm: 'Copy link', fields: [{ name: 'l', label: 'Link', value: inv.devLink }], submit: async () => { S.copyText(inv.devLink); } }); else toast(inv && inv.delivered === false ? 'The email could not be sent. Try resending shortly.' : `Invitation emailed to ${who}.`, inv && inv.delivered === false ? 'warn' : 'good'); };
        const wrap = h('div', null); let lv; const refresh = () => lv.querySelector('button[aria-label=Refresh]').click();
        const invite = () => staffForm({ title: 'Invite a staff member', intro: 'They get an email to set a password, set up their authenticator and choose a PIN.', confirm: 'Send invitation', member: null, roleOpts, roles, catalog,
            submit: async (v) => { const r = await api.post('/staff', v); showInvite(r.invite, v.email); } }).then((r) => { if (r) refresh(); });
        const open = (m) => { const d = drawer(m.name);
            const act = (text, fn, cls) => h('button', { class: `btn sm ${cls || ''}`, type: 'button', onclick: guard(async () => { const r = await fn(); if (r !== false) { d.close(); refresh(); } }) }, text);
            const same = m.id === S.state.me.id;
            mount(d.body, h('div', { class: 'stack' }, sub('Profile', kv([['Email', m.email], ['Title', m.jobTitle], ['Role', m.role && m.role.name], ['Status', badge(m.status)], ['Authenticator', m.mfaEnabled ? 'Enrolled' : 'Not set up'], ['Security PIN', m.pinSet ? 'Set' : 'Not set yet'], ['Last sign-in', m.lastLoginAt ? `${date(m.lastLoginAt)} (${m.lastLoginIp || 'unknown IP'})` : 'Never'], m.lockedUntil && new Date(m.lockedUntil) > new Date() && ['Locked until', date(m.lockedUntil)], ['Added', date(m.createdAt, false)]])),
                m.role && sub('What this person can do', S.capabilities(roles.find((r) => r.id === m.role.id), catalog, { compact: true })),
                manage && !same && sub('Actions', h('div', { class: 'row' },
                    act('Edit access', async () => { const opts2 = roleOpts.some((o) => o.value === (m.role && m.role.id)) ? roleOpts : [...roleOpts, { value: m.role.id, label: m.role.name }]; const r = await staffForm({ title: `Edit ${m.name}`, intro: 'Changing the role changes what they can do straight away.', confirm: 'Save changes', member: m, roleOpts: opts2, roles, catalog, submit: (v) => api.put(`/staff/${m.id}`, v) }); return !!r; }),
                    m.status === 'active' && act('Reset PIN', async () => { const r = await confirmBox({ title: 'Clear their PIN?', text: `${m.name} will choose a new PIN the next time they sign in (and must use their authenticator code to do so). Use this if they forgot it and cannot reset it themselves.`, confirm: 'Clear PIN', submit: () => api.post(`/staff/${m.id}/reset-pin`) }); return !!r; }),
                    m.status === 'invited' && act('Resend invite', async () => { const r = await api.post(`/staff/${m.id}/resend-invite`); showInvite(r.invite, m.email); }),
                    m.status === 'active' && act('Send password reset', async () => { const r = await confirmBox({ title: 'Send a password reset?', text: `${m.name} gets an email link and is signed out everywhere.`, confirm: 'Send', submit: async () => { const x = await api.post(`/staff/${m.id}/send-reset`); if (x.devLink) S.copyText(x.devLink); } }); return !!r; }),
                    act('Reset authenticator', async () => { const r = await confirmBox({ title: 'Reset their authenticator?', text: `${m.name} will have to enrol a new device at the next sign-in. Use this when a phone is lost.`, danger: true, confirm: 'Reset', submit: () => api.post(`/staff/${m.id}/reset-mfa`) }); return !!r; }, 'danger'),
                    act('Sign out everywhere', async () => { const r = await confirmBox({ title: 'End all their sessions?', text: m.name, confirm: 'Sign out', submit: () => api.post(`/staff/${m.id}/revoke-sessions`) }); return !!r; }),
                    m.lockedUntil && new Date(m.lockedUntil) > new Date() && act('Unlock', async () => { await api.post(`/staff/${m.id}/unlock`); return true; }),
                    act('Remove account', async () => { const r = await confirmBox({ title: 'Remove this staff account?', text: 'Their access ends immediately. The audit log keeps everything they did.', danger: true, confirm: 'Remove', submit: () => api.del(`/staff/${m.id}`) }); return !!r; }, 'danger'))),
                same && h('p', { class: 'muted' }, 'This is you. Use My account to change your own details.')));
        };
        wrap.append(pageHead('Staff', 'Everyone with access to this console.', manage && h('button', { class: 'btn primary', type: 'button', onclick: invite }, icon('plus'), 'Invite staff')));
        lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Name or email' }, { key: 'status', label: 'Status', type: 'select', options: opts(['active', 'invited', 'suspended'], 'Any status') }, { key: 'roleId', label: 'Role', type: 'select', options: [{ value: '', label: 'Any role' }, ...roles.map((r) => ({ value: r.id, label: r.name }))] }],
            load: async (p) => { const rows = await api.get('/staff', { query: p }); return { rows, page: 1, pages: 1, total: rows.length }; },
            columns: [{ label: 'Name', render: (m) => h('div', null, h('strong', null, m.name), h('div', { class: 'muted small' }, m.email)) }, { label: 'Role', render: (m) => m.role ? m.role.name : '—' }, { label: 'Status', render: (m) => badge(m.status) }, { label: 'Authenticator', render: (m) => m.mfaEnabled ? badge('on', 'good') : badge('off', 'warn') }, { label: 'Last sign-in', render: (m) => ago(m.lastLoginAt) }],
            onRow: open, rowLabel: (m) => `Open ${m.name}`, empty: 'No staff match.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Roles -----------------------------------------------------------------------------------------------------------------
    S.register({ key: 'roles', title: 'Roles & access', icon: 'key', group: 'team', any: ['staff.view', 'staff.manage', 'roles.manage'], async render() {
        const manage = S.can('roles.manage'); const wrap = h('div', null); const slot = h('div', null);
        async function load() {
            const r = await api.get('/roles'); const roles = r.roles; const groups = r.catalog.groups; const yours = new Set(r.you.permissions);
            const edit = async (role) => {
                const boxes = {}; const body = h('div', null, groups.map((g) => h('div', { class: 'perm-group' }, h('h3', null, g.label), h('div', { class: 'perm-grid' }, g.permissions.map((p) => { const cb = h('input', { type: 'checkbox', checked: role ? role.permissions.includes(p.key) : false, disabled: !yours.has(p.key) }); boxes[p.key] = cb; return h('label', { class: 'check' }, cb, h('span', null, p.label, h('span', { class: 'muted' }, ` ${p.description}`), p.sensitive ? h('span', { class: 'badge warn pin-tag' }, 'PIN') : null)); })))));
                const out = await askBox({ title: role ? `Edit ${role.name}` : 'New custom role', wide: true, intro: 'You can only grant permissions you hold yourself. Higher rank can manage lower rank.', body, fields: [{ name: 'name', label: 'Role name', value: role ? role.name : '', required: true, max: 60 }, { name: 'description', label: 'What is this role for?', value: role ? role.description : '', max: 300 }, { name: 'rank', label: 'Rank (1–99; decides who can manage whom)', type: 'number', value: role ? role.rank : 10, min: 1 }],
                    submit: async (v) => { const permissions = Object.keys(boxes).filter((k) => boxes[k].checked); const bodyOut = { ...v, permissions, rank: Number(v.rank) }; if (role) await api.put(`/roles/${role.id}`, bodyOut); else await api.post('/roles', bodyOut); } });
                if (out) { toast('Role saved.', 'good'); load(); }
            };
            const allPerms = groups.flatMap((g) => g.permissions);
            const matrix = h('div', { class: 'tablewrap' }, h('table', { class: 'matrix' }, h('thead', null, h('tr', null, h('th', null, 'Permission'), roles.map((x) => h('th', { class: 'rot', scope: 'col' }, x.name)))),
                h('tbody', null, groups.map((g) => [h('tr', null, h('td', { colspan: roles.length + 1, style: 'background:var(--line-soft);font-weight:700' }, g.label)), ...g.permissions.map((p) => h('tr', null, h('td', { title: p.description }, p.label), roles.map((x) => h('td', { class: x.permissions.includes(p.key) ? 'yes' : 'no', 'aria-label': x.permissions.includes(p.key) ? 'Allowed' : 'Not allowed' }, x.permissions.includes(p.key) ? '✓' : '–'))))]))));
            mount(slot, S.table([{ label: 'Role', render: (x) => h('div', null, h('strong', null, x.name), x.isSystem ? [' ', badge('built-in', 'info')] : null, h('div', { class: 'muted small' }, x.description || '')) }, { label: 'Rank', render: (x) => x.rank }, { label: 'People', render: (x) => num(x.members) }, { label: 'Permissions', render: (x) => `${x.permissions.length} of ${allPerms.length}` },
                { label: '', render: (x) => manage && !x.isSystem ? h('span', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: guard(() => edit(x)) }, 'Edit'), h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { const o = await confirmBox({ title: 'Delete this role?', text: `${x.name}. It must have no members.`, danger: true, confirm: 'Delete', submit: () => api.del(`/roles/${x.id}`) }); if (o) load(); }) }, 'Delete')) : null }], roles, { empty: 'No roles.' }),
                h('h2', { class: 'sect' }, 'Permission matrix'), matrix);
            slot.dataset.ready = '1'; wrap.querySelector('[data-new-role]') || null; S._newRole = () => edit(null);
        }
        wrap.append(pageHead('Roles & access', 'What each role can do. Built-in roles are fixed; add custom roles for anything more specific.', manage && h('button', { class: 'btn primary', type: 'button', 'data-new-role': '1', onclick: guard(() => S._newRole()) }, icon('plus'), 'New custom role')), slot); await load(); return wrap;
    } });

    // ---- Security ----------------------------------------------------------------------------------------------------------------
    S.register({ key: 'security', title: 'Security', icon: 'shield', group: 'team', any: ['security.manage'], async render() {
        const [o, sess] = await Promise.all([api.get('/security/overview'), api.get('/security/sessions')]);
        const stat = (n, l, tone) => h('div', { class: `stat ${tone || ''}` }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l)); const p = o.policy;
        const wrap = h('div', null, pageHead('Security', 'Sign-in health and live sessions across the console.'));
        wrap.append(h('div', { class: 'stats' }, stat(o.activeStaff, 'Active staff'), stat(o.withoutMfa, 'Without authenticator', o.withoutMfa ? 'bad' : ''), stat(o.lockedAccounts, 'Locked accounts', o.lockedAccounts ? 'warn' : ''), stat(o.liveSessions, 'Live sessions'), stat(o.signIns24h, 'Sign-ins (24 h)'), stat(o.failedSignIns24h, 'Failed attempts (24 h)', o.failedSignIns24h > 10 ? 'warn' : '')),
            sub('Policy in force', kv([['Authenticator', p.mfaRequired ? 'Required for every sign-in' : 'Optional'], ['Minimum password', `${p.minPasswordLength} characters`], ['Idle timeout', `${p.idleMinutes} minutes`], ['Maximum session', `${p.absoluteHours} hours`], ['Sessions per person', p.maxSessions], ['Lock-out', `${p.lockoutAttempts} failures → ${p.lockoutMinutes} minutes`], ['Re-confirm sensitive actions', `after ${p.reauthMinutes} minutes`], ['IP allow-list', p.ipAllowlistEnabled ? 'On' : 'Off']]), h('p', { class: 'muted small' }, 'These are set on the server and cannot be loosened from here.')),
            sub('Live sessions', S.table([{ label: 'Person', render: (s) => h('div', null, h('strong', null, s.staff.name), h('div', { class: 'muted small' }, `${s.staff.email} · ${s.staff.role}`)) }, { label: 'Device', render: (s) => s.device }, { label: 'IP', render: (s) => h('span', { class: 'mono' }, s.ip || '—') }, { label: 'Started', render: (s) => date(s.createdAt) }, { label: 'Last seen', render: (s) => ago(s.lastSeenAt) },
                { label: '', render: (s) => s.current ? badge('this session', 'info') : h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { const r = await confirmBox({ title: 'End this session?', text: `${s.staff.name} on ${s.device}`, danger: true, confirm: 'End session', submit: () => api.del(`/security/sessions/${s.id}`) }); if (r) S.state.refresh && S.state.refresh(); window.dispatchEvent(new HashChangeEvent('hashchange')); }) }, 'End') }], sess, { empty: 'No live sessions.' })));
        return wrap;
    } });

    // ---- Audit log -----------------------------------------------------------------------------------------------------------------
    S.register({ key: 'audit', title: 'Audit log', icon: 'list', group: 'team', any: ['audit.view'], async render() {
        const wrap = h('div', null);
        const exp = S.can('audit.export') ? h('button', { class: 'btn', type: 'button', onclick: guard(async () => { const q = {}; ['q', 'group', 'from', 'to'].forEach((k) => { const el = document.getElementById('flt_' + k); if (el && el.value) q[k] = el.value; }); await api.download('/audit/export', q, `staff-audit-${new Date().toISOString().slice(0, 10)}.csv`); toast('Export downloaded.', 'good'); }) }, icon('download'), 'Export CSV') : null;
        wrap.append(pageHead('Audit log', 'A permanent record of staff actions and sign-ins. Entries cannot be edited or deleted.'));
        const lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Action, person or id' }, { key: 'group', label: 'Type', type: 'select', options: [{ value: '', label: 'Everything' }, { value: 'security', label: 'Sign-ins & staff security' }, { value: 'growth', label: 'Circle & Crew' }] }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
            load: async (p) => { if (p.to) p.to = new Date(p.to + 'T23:59:59').toISOString(); if (p.from) p.from = new Date(p.from + 'T00:00:00').toISOString(); const r = await api.get('/audit', { query: p }); return { rows: r.rows, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'When', render: (r) => date(r.at) }, { label: 'Who', render: (r) => h('div', null, r.actorLabel || 'System', r.ip ? h('div', { class: 'muted small mono' }, r.ip) : null) }, { label: 'Action', render: (r) => h('strong', null, label(r.action)) }, { label: 'Target', render: (r) => r.targetUser ? r.targetUser.name : (r.targetType ? `${label(r.targetType)}${r.targetId ? ' ' + String(r.targetId).slice(-6) : ''}` : '—') }],
            onRow: (r) => { const d = drawer(label(r.action)); mount(d.body, sub('Entry', kv([['When', date(r.at)], ['Who', r.actorLabel || 'System'], ['IP', r.ip], ['Device', r.userAgent], ['Target', r.targetType && `${r.targetType} ${r.targetId || ''}`], ['Account', r.targetUser && `${r.targetUser.name} (${r.targetUser.email})`]]), h('h3', null, 'Details'), h('pre', { class: 'mono', style: 'white-space:pre-wrap;word-break:break-word' }, JSON.stringify(r.metadata || {}, null, 2)))); },
            rowLabel: (r) => `Open ${label(r.action)}`, empty: 'No entries match.', extra: exp });
        wrap.append(lv); return wrap;
    } });

    // ---- Settings & payment methods --------------------------------------------------------------------------------------------------
    S.register({ key: 'settings', title: 'Settings', icon: 'sliders', group: 'finance', any: ['settings.manage'], async render() {
        const [st, methods] = await Promise.all([api.get('/settings'), api.get('/payment-methods')]);
        const wrap = h('div', null, pageHead('Settings', 'Payment details sellers see, support contact and payment methods.'));
        const SETTING_HELP = { mtnMomoCode: 'The merchant code or number sellers pay to when buying a Seller Pass with MTN Mobile Money.', mtnMomoName: 'The name sellers should see on their phone when they pay, so they know it is the right account.', mtnMomoInstructions: 'Plain steps shown to the seller, e.g. "Dial *165#, choose Pay, enter the code".', airtelMoneyCode: 'The merchant code or number for Airtel Money payments.', airtelMoneyName: 'The account name shown on the seller\'s phone for Airtel payments.', airtelMoneyInstructions: 'Plain steps shown to the seller for Airtel Money.', supportWhatsappNumber: 'International format without + or spaces, e.g. 256700000000. Shoppers tap it to chat.', supportContactLabel: 'The name on the WhatsApp button, e.g. "NextaStore Support".', supportHoursNote: 'When people can expect a reply, e.g. "Mon–Sat, 8am–6pm".' };
        const fields = [['mtnMomoCode', 'MTN MoMo code'], ['mtnMomoName', 'MTN MoMo account name'], ['mtnMomoInstructions', 'MTN MoMo instructions'], ['airtelMoneyCode', 'Airtel Money code'], ['airtelMoneyName', 'Airtel Money account name'], ['airtelMoneyInstructions', 'Airtel Money instructions'], ['supportWhatsappNumber', 'Support WhatsApp number'], ['supportContactLabel', 'Support contact label'], ['supportHoursNote', 'Support hours note']];
        const form = h('form', { class: 'stack', novalidate: true }, h('div', { class: 'grid2' }, fields.map(([k, l]) => h('label', { class: 'f' }, h('span', { class: 'lbl' }, l, SETTING_HELP[k] ? S.help(SETTING_HELP[k], l) : null), h('input', { name: k, value: st[k] || '', maxlength: 240 })))), h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'supportWhatsappEnabled', checked: !!st.supportWhatsappEnabled }), h('span', null, 'Show WhatsApp support to shoppers')), h('div', { class: 'err', role: 'alert' }), h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')));
        form.addEventListener('submit', async (e) => { e.preventDefault(); const err = form.querySelector('.err'); err.textContent = ''; const body = {}; fields.forEach(([k]) => { body[k] = form.elements[k].value.trim(); }); body.supportWhatsappEnabled = form.elements.supportWhatsappEnabled.checked; try { await api.put('/settings', body); toast('Settings saved.', 'good'); } catch (x) { if (x.code !== 'REAUTH_CANCELLED') err.textContent = x.message; } });
        const slot = h('div', null);
        async function loadMethods() {
            const rows = await api.get('/payment-methods');
            const edit = async (m) => { const r = await askBox({ title: m ? 'Edit payment method' : 'New payment method', fields: [!m && { name: 'code', label: 'Code (camelCase, cannot change later)', required: true, max: 40, help: 'A short internal name with no spaces, like mtnMomo. The system uses it to recognise the method, so it cannot be changed later.' }, { name: 'label', label: 'Label', value: m ? m.label : '', required: true, max: 60 }, { name: 'currency', label: 'Currency', value: m ? m.currency : 'UGX', max: 10 }, { name: 'environment', help: 'Live = real money, shown to sellers. Test = for trying things out, never shown to real sellers.', label: 'Environment', type: 'select', value: m ? m.environment : 'live', options: [{ value: 'live', label: 'Live' }, { value: 'test', label: 'Test' }] }, { name: 'sortOrder', help: 'Lower numbers appear first when sellers choose how to pay.', label: 'Sort order', type: 'number', value: m ? m.sortOrder : 0 }, { name: 'isActive', label: 'Available to shoppers', type: 'checkbox', value: m ? m.isActive : true }].filter(Boolean),
                submit: async (v) => { const b = { ...v, sortOrder: Number(v.sortOrder) || 0 }; if (m) await api.put(`/payment-methods/${m.id}`, b); else await api.post('/payment-methods', b); } }); if (r) { toast('Saved.', 'good'); loadMethods(); } };
            mount(slot, h('div', { class: 'spread' }, h('h2', null, 'Payment methods'), h('button', { class: 'btn primary sm', type: 'button', onclick: guard(() => edit(null)) }, icon('plus'), 'Add method')),
                S.table([{ label: 'Method', render: (m) => h('div', null, h('strong', null, m.label), h('div', { class: 'muted small mono' }, m.code)) }, { label: 'Currency', render: (m) => m.currency }, { label: 'Environment', render: (m) => badge(m.environment, m.environment === 'live' ? 'good' : 'warn') }, { label: 'State', render: (m) => badge(m.isActive ? 'live' : 'draft') },
                    { label: '', render: (m) => h('span', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: guard(() => edit(m)) }, 'Edit'), h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { const o = await confirmBox({ title: 'Delete this payment method?', text: m.label, danger: true, confirm: 'Delete', submit: () => api.del(`/payment-methods/${m.id}`) }); if (o) loadMethods(); }) }, 'Delete')) }], rows, { empty: 'No payment methods.' }));
        }
        wrap.append(sub('Payments & support contact', form), h('div', { class: 'card' }, slot)); await loadMethods(); return wrap;
    } });

    // ---- Circle & Crew -------------------------------------------------------------------------------------------------------------------
    const G = '/growth';
    S.register({ key: 'growth', title: 'Circle & Crew', icon: 'growth', group: 'finance', any: ['growth.view'], async render() {
        const rev = S.can('growth.review'), settings = S.can('growth.settings');
        const wrap = h('div', null, pageHead('Circle & Crew', 'Partner programs: members, applications, risk and campaigns.'));
        const tabs = [['overview', 'Overview'], ['partners', 'Partners'], ['queue', 'Review queue'], ['flags', 'Risk flags'], ['campaigns', 'Campaigns']];
        const body = h('div', null); let active = 'overview';
        const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, t]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === active), dataset: { k }, onclick: () => show(k) }, t)));
        const partnerDrawer = async (id, refresh) => { const d = drawer('Partner'); mount(d.body, h('div', { class: 'skel' }));
            try { const x = await api.get(`${G}/partners/${encodeURIComponent(id)}`); const p = x.partner; d.setTitle(p.displayName || 'Partner');
                const act = (text, fn, cls) => h('button', { class: `btn sm ${cls || ''}`, type: 'button', onclick: guard(async () => { const r = await fn(); if (r) { toast('Done.', 'good'); d.close(); refresh && refresh(); } }) }, text);
                const reason = (title, path, danger) => askBox({ title, danger, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 3, required: true, max: 300 }], submit: (v) => api.put(path, v) });
                mount(d.body, h('div', { class: 'stack' }, sub('Profile', kv([['Program', label(p.program)], ['Status', badge(p.status)], ['Code', p.code], ['Rank', p.rankKey && label(p.rankKey)], ['Phone', p.phone], ['Quality score', p.qualityScore], p.frozenReason && ['Frozen because', p.frozenReason], ['Joined', date(p.joinedAt || p.createdAt, false)]]),
                    rev && h('div', { class: 'row' }, p.program === 'crew' && p.status === 'applied' && [act('Approve application', async () => !!(await confirmBox({ title: 'Approve this Crew member?', text: 'Check their ID photo and phone first.', confirm: 'Approve', submit: () => api.put(`${G}/crew/${p.id}/approve`) }))), act('Reject', () => reason('Reject application', `${G}/crew/${p.id}/reject`, true), 'danger')],
                        p.status === 'active' && act('Freeze', () => reason('Freeze partner', `${G}/partners/${p.id}/freeze`, true), 'danger'), p.status === 'frozen' && act('Unfreeze', async () => { await api.put(`${G}/partners/${p.id}/unfreeze`); return true; }))),
                    x.balances && sub('Balances', kv(Object.entries(x.balances).filter(([, v]) => typeof v === 'number').map(([k, v]) => [label(k.replace(/([A-Z])/g, ' $1').toLowerCase()), money(v)]))),
                    x.flags && x.flags.length ? sub('Flags', h('ul', { class: 'timeline' }, x.flags.map((f) => h('li', null, `${label(f.code)} · ${label(f.status)} · ${date(f.createdAt, false)}`)))) : null,
                    x.referrals ? sub(`Referrals (${x.referrals.length})`, h('ul', { class: 'timeline' }, x.referrals.slice(0, 15).map((r) => h('li', null, `${label(r.stage)} · ${date(r.createdAt, false)}`)))) : null)); }
            catch (e) { mount(d.body, h('div', { class: 'banner bad' }, e.message)); } };
        const views = {
            async overview() { const o = await api.get(`${G}/overview`); const st = (n, l, tone) => h('div', { class: `stat ${tone || ''}` }, h('div', { class: 'n' }, typeof n === 'number' ? num(n) : n), h('div', { class: 'l' }, l));
                return h('div', { class: 'stack' }, h('div', { class: 'stats' }, st(o.pendingCrewApplications, 'Crew applications', o.pendingCrewApplications ? 'warn' : ''), st(o.pendingUpgrades, 'Upgrade requests'), st(o.openFlags, 'Open risk flags', o.openFlags ? 'warn' : ''), st(o.commissionsInReview.count, 'Commissions in review'), st(o.payoutQueue.count, 'Payout queue'), st(o.payoutQueue.overdue, 'Payouts overdue', o.payoutQueue.overdue ? 'bad' : ''), st(money(o.totalOwedToPartners), 'Owed to partners'), st(o.liveCampaigns, 'Live campaigns')),
                    sub('Partners by program', S.table([{ label: 'Program', render: (r) => label(r.program) }, { label: 'Status', render: (r) => badge(r.status) }, { label: 'Count', render: (r) => num(r._count._all) }], o.partners, { empty: 'No partners yet.' }))); },
            async partners() { let lv; const refresh = () => lv.querySelector('button[aria-label=Refresh]').click(); lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Name, code or phone' }, { key: 'program', label: 'Program', type: 'select', options: opts(['circle', 'crew'], 'Both') }, { key: 'status', label: 'Status', type: 'select', options: opts(['applied', 'active', 'frozen', 'rejected', 'retired'], 'Any status') }],
                load: async (p) => { const rows = await api.get(`${G}/partners`, { query: p }); return { rows, page: 1, pages: 1, total: rows.length }; },
                columns: [{ label: 'Name', render: (p) => h('div', null, h('strong', null, p.displayName), h('div', { class: 'muted small mono' }, p.code || '')) }, { label: 'Program', render: (p) => label(p.program) }, { label: 'Status', render: (p) => badge(p.status) }, { label: 'Rank', render: (p) => p.rankKey ? label(p.rankKey) : '—' }, { label: 'Joined', render: (p) => date(p.joinedAt, false) }], onRow: (p) => partnerDrawer(p.id, refresh), rowLabel: (p) => `Open ${p.displayName}`, empty: 'No partners match.' }); return lv; },
            async queue() { const rows = await api.get(`${G}/review-queue`); const redo = () => show('queue');
                return S.table([{ label: 'Partner', render: (c) => c.partner ? `${c.partner.displayName} (${label(c.partner.program)})` : '—' }, { label: 'Amount', render: (c) => money(c.amount) }, { label: 'Type', render: (c) => label(c.type) }, { label: 'Risk', render: (c) => h('div', null, c.riskScore, c.riskReasons && c.riskReasons.length ? h('div', { class: 'muted small' }, c.riskReasons.map(label).join(', ')) : null) }, { label: 'Queued', render: (c) => ago(c.createdAt) },
                    { label: '', render: (c) => rev ? h('span', { class: 'row' }, h('button', { class: 'btn sm primary', type: 'button', onclick: guard(async () => { if (await confirmBox({ title: 'Release this commission?', text: money(c.amount), confirm: 'Release', submit: () => api.put(`${G}/commissions/${c.id}/release`) })) redo(); }) }, 'Release'), h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { if (await askBox({ title: 'Void commission', danger: true, confirm: 'Void', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 3, required: true, max: 300 }], submit: (v) => api.put(`${G}/commissions/${c.id}/void`, v) })) redo(); }) }, 'Void')) : null }], rows, { empty: 'Nothing is waiting for review.' }); },
            async flags() { const rows = await api.get(`${G}/flags`, { query: { status: 'open' } }); const redo = () => show('flags');
                return S.table([{ label: 'Flag', render: (f) => h('strong', null, label(f.code)) }, { label: 'Partner', render: (f) => f.partner ? `${f.partner.displayName} (${label(f.partner.program)})` : '—' }, { label: 'Raised', render: (f) => ago(f.createdAt) },
                    { label: '', render: (f) => rev ? h('span', { class: 'row' }, ['dismissed', 'confirmed'].map((o) => h('button', { class: `btn sm ${o === 'confirmed' ? 'danger' : ''}`, type: 'button', onclick: guard(async () => { if (await askBox({ title: o === 'confirmed' ? 'Confirm this flag' : 'Dismiss this flag', fields: [{ name: 'note', label: 'Note', type: 'textarea', rows: 3, max: 300 }], submit: (v) => api.put(`${G}/flags/${f.id}`, { outcome: o, note: v.note }) })) redo(); }) }, o === 'confirmed' ? 'Confirm' : 'Dismiss'))) : null }], rows, { empty: 'No open flags.' }); },
            async campaigns() { const rows = await api.get(`${G}/campaigns`); const redo = () => show('campaigns');
                const create = guard(async () => {
                    const demo = h('div', { class: 'ex' }); const paint = (pct) => { const base = 10000, extra = Math.round((base * pct) / 100 / 100) * 100; demo.textContent = pct > 0 ? `Example: a partner earns UGX 10,000 commission on a sale. With a ${pct}% boost they receive UGX ${(base + extra).toLocaleString('en-US')} (UGX ${extra.toLocaleString('en-US')} extra, paid by NextaStore).` : 'With 0% nothing extra is paid. The campaign only appears as an announcement.'; };
                    paint(10);
                    setTimeout(() => { const i = document.querySelector('.modal input[name=boostPercent]'); if (i) i.addEventListener('input', () => paint(Math.max(0, Math.min(50, Number(i.value) || 0)))); }, 50);
                    const explain = h('div', { class: 'explain' }, h('b', null, 'What is a campaign?'), h('p', { style: 'margin:4px 0' }, 'A short promotion for Circle and Crew partners. While it is live, partners earn extra on every commission they make.'), demo);
                    if (await askBox({ title: 'New campaign', wide: true, confirm: 'Create campaign', body: explain,
                        fields: [{ name: 'title', label: 'Campaign name', required: true, max: 80, hint: 'Partners see this name, e.g. "Back to school boost".', help: 'Choose something short that tells partners why there is a bonus.' },
                            { name: 'program', label: 'Who can earn the boost?', type: 'select', help: 'Circle = shoppers who recommend NextaStore. Crew = field agents who sign up sellers. "Both" boosts everyone.', options: [{ value: '', label: 'Both programs (Circle and Crew)' }, { value: 'circle', label: 'Circle only' }, { value: 'crew', label: 'Crew only' }] },
                            { name: 'boostPercent', label: 'Extra reward (%)', type: 'number', value: 10, min: 0, maxValue: 50, step: 1, hint: 'From 0 to 50. 10 means partners get 10% more than their normal commission.', help: 'The reward boost is a percentage ADDED on top of the normal commission. It costs NextaStore money, so keep it modest. Normal commission rules, caps and fraud checks still apply, and the boost is the first extra to be trimmed if a cap is hit.' },
                            { name: 'startsAt', label: 'Starts', type: 'datetime-local', required: true, help: 'Only commissions earned after this moment get the boost.' }, { name: 'endsAt', label: 'Ends', type: 'datetime-local', required: true, help: 'The boost stops automatically at this time. You can also end a campaign early from the list.' }],
                        submit: (v) => { if (new Date(v.endsAt) <= new Date(v.startsAt)) throw new Error('The end must be after the start.'); if (v.boostPercent < 0 || v.boostPercent > 50) throw new Error('The extra reward must be between 0 and 50.'); return api.post(`${G}/campaigns`, { title: v.title, program: v.program || undefined, boostPercent: Number(v.boostPercent), startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString() }); } })) redo(); });
                return h('div', null, settings ? h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn primary', type: 'button', onclick: create }, icon('plus'), 'New campaign')) : null,
                    S.intro('campaigns', 'What campaigns do', 'A campaign is a time-limited bonus for partners. While it is live, every commission earned in its window is increased by the extra-reward percentage.', ['Live campaigns appear to partners in their dashboard.', 'You cannot go above 50%.', 'End a campaign early with "End now" if something goes wrong.']),
                    S.table([{ label: 'Campaign', render: (c) => h('strong', null, c.title) }, { label: 'Program', render: (c) => c.program ? label(c.program) : 'Both' }, { label: 'Extra reward', render: (c) => `+${c.boostPercent || 0}%` }, { label: 'Window', render: (c) => `${date(c.startsAt, false)} → ${date(c.endsAt, false)}` }, { label: 'State', render: (c) => badge(c.isActive ? 'live' : 'draft') },
                        { label: '', render: (c) => settings && c.isActive ? h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { if (await confirmBox({ title: 'End this campaign now?', text: c.title, danger: true, confirm: 'End', submit: () => api.put(`${G}/campaigns/${c.id}/end`) })) redo(); }) }, 'End now') : null }], rows, { empty: 'No campaigns.' })); }
        };
        async function show(k) { active = k; bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k))); mount(body, h('div', { class: 'skel' })); try { mount(body, await views[k]()); } catch (e) { mount(body, h('div', { class: 'banner bad' }, e.message)); } }
        wrap.append(bar, body); await show('overview'); return wrap;
    } });

    // ---- My account ------------------------------------------------------------------------------------------------------------------------
    S.register({ key: 'account', title: 'My account', icon: 'user', group: 'me', async render({ me }) {
        const [sessions, devices] = await Promise.all([api.get('/me/sessions'), api.get('/me/devices')]); const wrap = h('div', null, pageHead('My account', `${me.name} · ${me.role ? me.role.name : ''}`));
        const prof = h('form', { class: 'stack', novalidate: true }, h('label', { class: 'f' }, 'Name', h('input', { name: 'name', value: me.name, required: true, maxlength: 80 })), h('label', { class: 'f' }, 'Job title', h('input', { name: 'jobTitle', value: me.jobTitle || '', maxlength: 80 })), h('div', { class: 'muted small' }, `Email: ${me.email} (change it by asking a Super Admin)`), h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
        prof.addEventListener('submit', async (e) => { e.preventDefault(); try { const m = await api.put('/me', { name: prof.elements.name.value, jobTitle: prof.elements.jobTitle.value }); Object.assign(S.state.me, m, { session: S.state.me.session }); toast('Saved.', 'good'); } catch (x) { toast(x.message, 'bad'); } });
        const codesSlot = h('div', null);
        const regen = guard(async () => { if (!(await confirmBox({ title: 'Create new recovery codes?', text: 'Your old codes stop working immediately. Save the new ones somewhere safe.', confirm: 'Create codes' }))) return; const r = await api.post('/me/recovery-codes'); mount(codesSlot, h('div', { class: 'card' }, h('div', { class: 'banner warn' }, 'Shown once. Store them in a password manager.'), h('div', { class: 'codes' }, r.recoveryCodes.map((c) => h('code', null, c))), h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => S.copyText(r.recoveryCodes.join('\n')) }, icon('copy'), 'Copy'), h('button', { class: 'btn sm', type: 'button', onclick: () => S.saveText('nextastore-recovery-codes.txt', r.recoveryCodes.join('\n')) }, icon('download'), 'Download')))); });
        const sessList = h('div', null);
        const drawSessions = (rows) => mount(sessList, S.table([{ label: 'Device', render: (s) => [s.device, s.current ? [' ', badge('this device', 'info')] : null] }, { label: 'IP', render: (s) => h('span', { class: 'mono' }, s.ip || '—') }, { label: 'Signed in', render: (s) => date(s.createdAt) }, { label: 'Last active', render: (s) => ago(s.lastSeenAt) }, { label: '', render: (s) => s.current ? null : h('button', { class: 'btn sm', type: 'button', onclick: guard(async () => { await api.del(`/me/sessions/${s.id}`); drawSessions(await api.get('/me/sessions')); }) }, 'Sign out') }], rows));
        drawSessions(sessions);
        const devList = h('div', null);
        const drawDevices = (rows) => mount(devList, rows.length ? S.table([{ label: 'Browser', render: (d) => [d.label, d.current ? [' ', badge('this browser', 'info')] : null] }, { label: 'Last used', render: (d) => ago(d.lastSeenAt) }, { label: 'Trusted until', render: (d) => date(d.trustedUntil, false) },
            { label: '', render: (d) => h('button', { class: 'btn sm', type: 'button', onclick: guard(async () => { await api.del(`/me/devices/${d.id}`); drawDevices(await api.get('/me/devices')); toast('Forgotten. That browser will ask for your code next time.', 'good'); }) }, 'Forget') }], rows) : h('p', { class: 'muted' }, 'No remembered browsers. You will be asked for your authenticator code every time you sign in.'));
        drawDevices(devices);
        const pinBtn = h('button', { class: 'btn sm', type: 'button', onclick: guard(async () => { const ok = await S.changePinDialog({ currentRequired: true }); if (ok) toast('PIN changed.', 'good'); }) }, 'Change my PIN');
        wrap.append(sub('Profile', prof), sub('Password', S.passwordForm()), sub('Two-step verification', h('p', { class: 'muted small' }, 'You enter an authenticator code on your first sign-in, on a new browser, and whenever a sign-in looks suspicious.'), kv([['Authenticator', me.mfaEnabled ? 'On' : 'Off'], ['Recovery codes left', num(me.recoveryCodesLeft)]]), h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: regen }, 'Create new recovery codes')), codesSlot),
            sub('Security PIN', h('p', { class: 'muted' }, 'Your 6-digit PIN is asked before sensitive actions: approving payments, changing who has access, exporting the audit log, and sending broadcasts. It keeps a stranger on your unlocked computer from doing damage.'), h('div', { class: 'row' }, pinBtn, h('span', { class: 'muted small' }, 'Forgot it? Use "Forgot PIN?" on the PIN screen; it asks for your authenticator code.'))),
            sub('Remembered browsers', h('p', { class: 'muted' }, 'On a remembered browser you sign in with your password alone, unless something looks unusual. Forget any you do not recognise.'), devList),
            sub('Where you are signed in', sessList, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { const r = await api.post('/me/sessions/revoke-others'); toast(`${r.revoked} other session${r.revoked === 1 ? '' : 's'} signed out.`, 'good'); drawSessions(await api.get('/me/sessions')); }) }, 'Sign out all other devices'))));
        return wrap;
    } });
})(window);
