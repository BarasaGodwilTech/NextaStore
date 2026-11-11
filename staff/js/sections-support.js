/* Sections: Tickets (support desk), Follow-ups, Canned replies, Nexi handoffs, Announcements, Seller payments. */
(function (root) {
    'use strict';
    const S = root.Staff, api = S.api;
    const { h, mount, icon, date, ago, money, num, label, badge, toast, askBox, confirmBox, drawer, listView, opts, pageHead, kv } = S;

    const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
    const CATEGORIES = ['general', 'orders', 'payments', 'account', 'seller', 'listing', 'report', 'technical', 'other'];
    const STATUSES = ['open', 'pending', 'resolved', 'closed'];
    const sel = (name, labelText, list, value) => ({ name, label: labelText, type: 'select', value, options: list.map((v) => ({ value: v, label: label(v) })) });
    const slaText = (t) => { if (!t.slaDueAt || ['resolved', 'closed'].includes(t.status)) return '—'; return t.breached ? h('span', { class: 'badge bad' }, `Overdue ${ago(t.slaDueAt).replace(' ago', '')}`) : `Due ${ago(t.slaDueAt)}`; };
    let directory = null;
    const loadDirectory = async () => { if (!directory) directory = await api.get('/staff/directory').catch(() => []); return directory; };

    // ---- Ticket workspace -------------------------------------------------------------------------------------------------
    async function openTicket(id, refresh) {
        const d = drawer('Ticket'); mount(d.body, h('div', { class: 'skel' }));
        const load = async () => {
            const [x, people, canned] = await Promise.all([api.get(`/tickets/${encodeURIComponent(id)}`), S.can('tickets.manage') ? loadDirectory() : [], S.can('tickets.manage') ? api.swr('/canned-replies', { query: { kind: 'reply' }, ttl: 60000 }).then((r) => r.templates).catch(() => []) : []]);
            const t = x.ticket; d.setTitle(`#${t.number} ${t.subject}`);
            const patch = async (body) => { try { await api.put(`/tickets/${t.id}`, body); await load(); refresh && refresh(); } catch (e) { toast(e.message, 'bad'); } };
            const mk = (value, list, onChange, aria, mapper) => { const s = h('select', { 'aria-label': aria, onchange: () => onChange(s.value) }, list.map((v) => { const o = mapper ? mapper(v) : { value: v, label: label(v) }; return h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label); })); return s; };
            const manage = S.can('tickets.manage');
            const controls = manage ? h('div', { class: 'toolbar' },
                h('label', { class: 'f' }, 'Status', mk(t.status, STATUSES, (v) => patch({ status: v }), 'Status')), h('label', { class: 'f' }, 'Priority', mk(t.priority, PRIORITIES, (v) => patch({ priority: v }), 'Priority')),
                h('label', { class: 'f' }, 'Category', mk(t.category, CATEGORIES, (v) => patch({ category: v }), 'Category')),
                h('label', { class: 'f' }, 'Assignee', mk(t.assignee ? t.assignee.id : '', [{ id: '', name: 'Unassigned' }, ...people], (v) => patch({ assigneeId: v || null }), 'Assignee', (p) => ({ value: p.id, label: p.name })))) : kv([['Status', badge(t.status)], ['Priority', badge(t.priority)]]);
            const thread = x.messages.map((m) => h('div', { class: `msg ${m.internal ? 'internal' : (m.kind === 'staff' ? 'staff' : (m.kind === 'system' ? 'system' : ''))}` }, m.kind === 'system' ? null : h('div', { class: 'by' }, h('strong', null, m.author), m.internal ? badge('internal note', 'warn') : null, h('span', null, date(m.at))), m.body));
            let internal = false;
            const box = h('textarea', { rows: 4, maxlength: 8000, 'aria-label': 'Message', placeholder: 'Write a reply to the customer…' });
            const modeBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', onclick: () => { internal = !internal; modeBtn.setAttribute('aria-pressed', String(internal)); modeBtn.textContent = internal ? 'Internal note (staff only)' : 'Reply to customer'; box.placeholder = internal ? 'Only staff can see this note…' : 'Write a reply to the customer…'; } }, 'Reply to customer');
            const cannedSel = canned.length ? h('select', { 'aria-label': 'Insert a saved reply', onchange: () => { const c = canned.find((r) => r.id === cannedSel.value); if (c) { box.value = (box.value ? box.value + '\n\n' : '') + S.renderTemplate(c.body, { name: x.ticket.requester.name, first_name: String(x.ticket.requester.name || '').split(' ')[0], staff_name: String(S.state.me.name).split(' ')[0] }); } cannedSel.value = ''; } }, h('option', { value: '' }, 'Insert saved reply…'), canned.map((c) => h('option', { value: c.id }, `${c.title}`))) : null;
            const send = h('button', { class: 'btn primary', type: 'button', onclick: async () => { if (!box.value.trim()) return; send.disabled = true; try { await api.post(`/tickets/${t.id}/messages`, { body: box.value.trim(), internal }); await load(); refresh && refresh(); } catch (e) { toast(e.message, 'bad'); send.disabled = false; } } }, 'Send');
            const c = x.customer;
            mount(d.body, h('div', { class: 'stack' },
                h('div', { class: 'row' }, badge(t.status), badge(t.priority), badge(t.category, ''), h('span', { class: 'muted small' }, `SLA: `), slaText(t)),
                controls,
                h('div', null, thread, !thread.length ? h('p', { class: 'muted' }, 'No messages.') : null),
                manage && h('div', { class: 'card stack' }, box, h('div', { class: 'row spread' }, h('div', { class: 'row' }, modeBtn, cannedSel), send)),
                h('section', { class: 'card' }, h('h2', null, 'Customer'), c ? [kv([['Name', c.name], ['Email', c.email], ['Type', c.role], ['Status', badge(c.accountStatus)], ['Verified', c.emailVerified ? 'Yes' : 'No'], ['Joined', date(c.createdAt, false)], c.store && ['Store', c.store.name], ['Tickets', num(c.tickets)]]),
                    c.orders && c.orders.length ? h('ul', { class: 'timeline' }, c.orders.map((o) => h('li', null, h('a', { href: '#orders/' + o.id, onclick: () => d.close() }, `${money(o.total)} · ${label(o.status)} · ${date(o.createdAt, false)}`)))) : null,
                    S.can('users.view') ? h('button', { class: 'btn sm', type: 'button', onclick: () => { d.close(); S.openUser(c.id); } }, 'Open full profile') : null] : h('p', { class: 'muted' }, `${t.requester.name} · ${t.requester.email}${S.can('users.view') ? ' (not a registered account)' : ''}`))));
        };
        try { await load(); } catch (e) { mount(d.body, h('div', { class: 'banner bad' }, e.message)); }
    }
    async function newTicket(done) {
        await askBox({ title: 'New ticket', wide: true, confirm: 'Create ticket', fields: [{ name: 'requesterEmail', label: 'Customer email', type: 'email', required: true }, { name: 'requesterName', label: 'Customer name', max: 80 }, { name: 'subject', label: 'Subject', required: true, max: 160 }, sel('category', 'Category', CATEGORIES, 'general'), sel('priority', 'Priority', PRIORITIES, 'normal'), { name: 'body', label: 'What happened?', type: 'textarea', required: true, rows: 5, max: 8000 }, { name: 'assignToMe', label: 'Assign to me', type: 'checkbox', value: true }],
            submit: async (v) => { await api.post('/tickets', v); } }).then((r) => { if (r) { toast('Ticket created.', 'good'); done(); } });
    }
    S.register({ key: 'tickets', title: 'Tickets', icon: 'ticket', group: 'work', any: ['tickets.view'], badge: 'tickets', async render({ arg }) {
        if (arg) openTicket(arg);
        const counts = await api.get('/tickets/counts').catch(() => null);
        const wrap = h('div', null, pageHead('Support desk', 'Customer questions and problems, with response targets by priority.', S.can('tickets.manage') && h('button', { class: 'btn primary', type: 'button', onclick: () => newTicket(() => window.dispatchEvent(new HashChangeEvent('hashchange'))) }, icon('plus'), 'New ticket')));
        let lv;
        const quick = (text, n, params, tone) => h('button', { class: `stat ${tone || ''}`, type: 'button', style: 'text-align:left;cursor:pointer', onclick: () => { const q = new URLSearchParams(params); ['status', 'assignee', 'priority', 'breached'].forEach((k) => { const el = document.getElementById('flt_' + k); if (el) { el.value = q.get(k) || ''; el.dispatchEvent(new Event('change')); } }); } }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, text));
        if (counts) wrap.append(h('div', { class: 'stats' }, quick('Active', counts.active, { status: 'active' }), quick('Assigned to me', counts.mine, { status: 'active', assignee: 'me' }), quick('Unassigned', counts.unassigned, { status: 'active', assignee: 'unassigned' }, counts.unassigned ? 'warn' : ''), quick('Past SLA', counts.breached, { breached: '1' }, counts.breached ? 'bad' : ''), quick('Urgent', counts.urgent, { status: 'active', priority: 'urgent' }, counts.urgent ? 'warn' : '')));
        lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Subject, number or customer' }, { key: 'status', label: 'Status', type: 'select', value: 'active', options: [{ value: 'active', label: 'Active' }, ...STATUSES.map((s) => ({ value: s, label: label(s) })), { value: '', label: 'All' }] }, { key: 'priority', label: 'Priority', type: 'select', options: opts(PRIORITIES, 'Any priority') }, { key: 'assignee', label: 'Assignee', type: 'select', options: [{ value: '', label: 'Anyone' }, { value: 'me', label: 'Me' }, { value: 'unassigned', label: 'Unassigned' }] }, { key: 'category', label: 'Category', type: 'select', options: opts(CATEGORIES, 'Any category') }, { key: 'breached', label: 'SLA', type: 'select', options: [{ value: '', label: 'Any' }, { value: '1', label: 'Past due' }] }],
            load: async (p) => { const r = await api.get('/tickets', { query: p }); return { rows: r.tickets, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'Ticket', render: (t) => h('div', null, h('strong', null, `#${t.number} ${t.subject}`), t.preview ? h('div', { class: 'muted small' }, t.preview) : null) }, { label: 'Customer', render: (t) => t.requester.name }, { label: 'Priority', render: (t) => badge(t.priority) }, { label: 'Status', render: (t) => badge(t.status) }, { label: 'Assignee', render: (t) => t.assignee ? t.assignee.name : h('span', { class: 'muted' }, 'Unassigned') }, { label: 'SLA', render: slaText }, { label: 'Updated', render: (t) => ago(t.lastMessageAt || t.createdAt) }],
            onRow: (t) => openTicket(t.id, () => lv.querySelector('button[aria-label=Refresh]').click()), rowLabel: (t) => `Open ticket ${t.number}`, empty: 'No tickets match.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Follow-ups ------------------------------------------------------------------------------------------------------
    const FU = ['open', 'in_progress', 'done', 'cancelled'];
    S.register({ key: 'followups', title: 'Follow-ups', icon: 'tasks', group: 'work', any: ['followups.manage'], badge: 'followups', async render() {
        const people = await loadDirectory();
        const edit = async (f, done) => {
            const r = await askBox({ title: f ? 'Edit follow-up' : 'New follow-up', confirm: 'Save', fields: [{ name: 'title', label: 'What needs doing?', value: f ? f.title : '', required: true, max: 120 }, { name: 'note', label: 'Notes', type: 'textarea', rows: 3, value: f ? f.note : '', max: 1000 }, sel('status', 'Status', FU, f ? f.status : 'open'), { name: 'dueAt', label: 'Due date', type: 'date', value: f && f.dueAt ? String(f.dueAt).slice(0, 10) : '' }, { name: 'assignedToId', label: 'Assigned to', type: 'select', value: f && f.assignedTo ? f.assignedTo.id : '', options: [{ value: '', label: 'Unassigned' }, ...people.map((p) => ({ value: p.id, label: `${p.name} (${p.role})` }))] }],
                submit: async (v) => { const body = { title: v.title, note: v.note, status: v.status, dueAt: v.dueAt ? new Date(v.dueAt + 'T12:00:00').toISOString() : null, assignedToId: v.assignedToId || null, relatedUserId: f && f.relatedUser ? f.relatedUser.id : null }; if (f) await api.put(`/follow-ups/${f.id}`, body); else await api.post('/follow-ups', body); } });
            if (r) { toast('Saved.', 'good'); done(); }
        };
        const wrap = h('div', null); let lv;
        const refresh = () => lv.querySelector('button[aria-label=Refresh]').click();
        wrap.append(pageHead('Follow-ups', 'Internal tasks for the team.', h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null, refresh) }, icon('plus'), 'New follow-up')));
        lv = listView({ filters: [{ key: 'status', label: 'Status', type: 'select', options: opts(FU, 'Any status') }, { key: 'assignee', label: 'Assigned', type: 'select', options: [{ value: '', label: 'Everyone' }, { value: 'me', label: 'Me' }] }],
            load: async (p) => { const rows = await api.get('/follow-ups', { query: p }); return { rows, page: 1, pages: 1, total: rows.length }; },
            columns: [{ label: 'Task', render: (f) => h('div', null, h('strong', null, f.title), f.note ? h('div', { class: 'muted small' }, f.note) : null) }, { label: 'Status', render: (f) => badge(f.status) }, { label: 'Assigned', render: (f) => f.assignedTo ? f.assignedTo.name : '—' }, { label: 'Related', render: (f) => f.relatedUser ? f.relatedUser.name : '—' }, { label: 'Due', render: (f) => f.dueAt ? date(f.dueAt, false) : '—' }],
            onRow: (f) => edit(f, refresh), rowLabel: (f) => `Edit ${f.title}`, empty: 'Nothing to follow up.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Canned replies ----------------------------------------------------------------------------------------------------
    // ---- Nexi handoffs --------------------------------------------------------------------------------------------------------
    S.register({ key: 'nexi', title: 'Nexi handoffs', icon: 'bot', group: 'work', any: ['nexi.view'], async render() {
        const wrap = h('div', null, pageHead('Nexi handoffs', 'Conversations the AI assistant passed to a person.'));
        try {
            const r = await api.get('/nexi-handoffs'); const rows = Array.isArray(r) ? r : (r && (r.handoffs || r.rows || r.items)) || [];
            wrap.append(rows.length ? S.table([{ label: 'When', render: (x) => date(x.createdAt || x.at) }, { label: 'Who', render: (x) => x.name || x.email || x.visitor || '—' }, { label: 'Reason', render: (x) => x.reason || x.topic || '—' }, { label: 'Summary', render: (x) => String(x.summary || x.message || '').slice(0, 200) }], rows) : h('div', { class: 'card empty' }, 'No handoffs right now.'));
        } catch (e) { wrap.append(h('div', { class: 'banner warn' }, e.message || 'The assistant service is not reachable right now.')); }
        return wrap;
    } });

    // ---- Announcements ---------------------------------------------------------------------------------------------------------
    S.register({ key: 'announcements', title: 'Announcements', icon: 'megaphone', group: 'comms', any: ['announcements.manage'], async render() {
        const wrap = h('div', null); const slot = h('div', null);
        const toIso = (v) => (v ? new Date(v).toISOString() : null);
        const local = (v) => { if (!v) return ''; const d = new Date(v); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
        const edit = async (a) => { const r = await askBox({ title: a ? 'Edit announcement' : 'New announcement', wide: true, fields: [{ name: 'title', label: 'Title', value: a ? a.title : '', required: true, max: 120 }, { name: 'body', label: 'Message (up to 500 characters)', type: 'textarea', rows: 3, value: a ? a.body : '', max: 500 }, { ...sel('tone', 'Style', ['info', 'warning', 'success'], a ? a.tone : 'info'), help: 'Changes the banner colour. Info = blue (news), Warning = amber (something people should be careful about, like downtime), Success = green (good news).' }, { ...sel('audience', 'Show to', ['all', 'sellers', 'buyers'], a ? a.audience : 'all'), help: 'Who sees the banner on the marketplace. Sellers = store owners. Buyers = shoppers.' }, { name: 'startsAt', label: 'Starts (optional)', type: 'datetime-local', value: a ? local(a.startsAt) : '', help: 'Leave empty to start straight away.' }, { name: 'endsAt', label: 'Ends (optional)', type: 'datetime-local', value: a ? local(a.endsAt) : '' }, { name: 'isActive', label: 'Live (turn off to hide it without deleting)', type: 'checkbox', value: a ? a.isActive : true, hint: 'Shown on the marketplace while live and within its dates.' }],
            submit: async (v) => { const body = { ...v, startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt) }; if (a) await api.put(`/announcements/${a.id}`, body); else await api.post('/announcements', body); } }); if (r) { toast('Saved.', 'good'); load(); } };
        async function load() {
            const rows = await api.get('/announcements');
            mount(slot, S.table([{ label: 'Announcement', render: (a) => h('div', null, h('strong', null, a.title), h('div', { class: 'muted small' }, String(a.body || '').slice(0, 120))) }, { label: 'Audience', render: (a) => label(a.audience) }, { label: 'Style', render: (a) => badge(a.tone, a.tone === 'warning' ? 'warn' : a.tone === 'success' ? 'good' : 'info') }, { label: 'Window', render: (a) => `${a.startsAt ? date(a.startsAt, false) : 'now'} → ${a.endsAt ? date(a.endsAt, false) : 'no end'}` }, { label: 'State', render: (a) => badge(a.isActive ? 'live' : 'draft') },
                { label: '', render: (a) => h('span', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(a) }, 'Edit'), h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { const r = await confirmBox({ title: 'Delete announcement?', text: a.title, danger: true, confirm: 'Delete', submit: () => api.del(`/announcements/${a.id}`) }); if (r) load(); } }, 'Delete')) }], rows, { empty: 'No announcements yet.' }));
        }
        wrap.append(pageHead('Announcements', 'Short notices shown across the marketplace.', h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, icon('plus'), 'New announcement')), slot); await load(); return wrap;
    } });

    // ---- Seller payments -------------------------------------------------------------------------------------------------------
    S.register({ key: 'payments', title: 'Seller payments', icon: 'cash', group: 'finance', any: ['subscriptions.review', 'finance.view'], badge: 'payments', async render() {
        const review = S.can('subscriptions.review');
        const wrap = h('div', null, pageHead('Seller payments', 'Mobile money payments sellers reported for their Seller Pass. Approve only once the money has actually arrived.'));
        let lv; const refresh = () => lv.querySelector('button[aria-label=Refresh]').click();
        lv = listView({ filters: [{ key: 'status', label: 'Status', type: 'select', value: 'pending', options: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: '', label: 'All' }] }],
            load: async (p) => { const rows = await api.get('/subscription-payments', { query: p }); return { rows, page: 1, pages: 1, total: rows.length }; },
            columns: [{ label: 'Store', render: (p) => h('div', null, h('strong', null, p.store ? p.store.name : '—'), h('div', { class: 'muted small' }, p.store && p.store.owner ? p.store.owner.email : '')) }, { label: 'Amount', render: (p) => money(p.amount) }, { label: 'Method', render: (p) => h('div', null, label(p.method), h('div', { class: 'muted small mono' }, p.reference || '')) }, { label: 'Period', render: (p) => p.periodMonths ? `${p.periodMonths} mo` : '—' }, { label: 'Submitted', render: (p) => date(p.submittedAt) }, { label: 'Status', render: (p) => badge(p.status) },
                { label: '', render: (p) => review && p.status === 'pending' ? h('span', { class: 'row' }, h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { const r = await confirmBox({ title: 'Approve this payment?', text: `${money(p.amount)} from ${p.store ? p.store.name : 'this store'} (ref ${p.reference || 'none'}). The seller\'s access is extended straight away.`, confirm: 'Approve', submit: () => api.put(`/subscription-payments/${p.id}/approve`) }); if (r) { toast('Approved.', 'good'); refresh(); } } }, 'Approve'), h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { const r = await askBox({ title: 'Reject payment', intro: 'The seller is told why.', danger: true, confirm: 'Reject', fields: [{ name: 'note', label: 'Reason', type: 'textarea', rows: 3, max: 500, required: true }], submit: (v) => api.put(`/subscription-payments/${p.id}/reject`, { note: v.note }) }); if (r) { toast('Rejected.', 'good'); refresh(); } } }, 'Reject')) : (p.note ? h('span', { class: 'muted small' }, p.note) : null) }],
            empty: 'No payments here.' });
        wrap.append(lv); return wrap;
    } });
})(window);
