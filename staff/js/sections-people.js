/* Sections: Overview, Users (360), Stores, Products, Orders, Buyer reports. */
(function (root) {
    'use strict';
    const S = root.Staff, api = S.api;
    const { h, mount, icon, date, ago, money, num, label, badge, toast, askBox, confirmBox, drawer, listView, opts, pageHead, kv } = S;

    const sub = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);
    const miniList = (rows, empty, render) => rows && rows.length ? h('ul', { class: 'timeline' }, rows.map((r) => h('li', null, render(r)))) : h('p', { class: 'muted' }, empty);
    const reasonField = (text) => ({ name: 'note', label: text || 'Reason', type: 'textarea', rows: 3, max: 500, required: true });

    // ---- Overview ------------------------------------------------------------------------------------------------------
    const QUICK = [
        ['tickets.view', 'tickets', 'ticket', 'Open tickets', 'Answer customers, oldest first.'], ['subscriptions.review', 'payments', 'cash', 'Review payments', 'Approve Seller Pass payments once the money arrived.'],
        ['users.view', 'users', 'users', 'Find a person', 'Look up any shopper or seller.'], ['users.contact', 'users', 'message', 'Message someone', 'Open their profile and choose Message.'],
        ['reports.review', 'reports', 'flag', 'Buyer reports', 'Decide what to do about reports.'], ['orders.view', 'orders', 'bag', 'Flagged orders', 'Orders that need a second look.'],
        ['growth.view', 'growth', 'growth', 'Circle & Crew', 'Partners, campaigns and risk.'], ['broadcasts.send', 'broadcast', 'megaphone', 'Send a broadcast', 'Tell a whole group something.'],
        ['staff.manage', 'staff', 'id', 'Manage team', 'Invite staff and review what they can do.'], ['audit.view', 'audit', 'list', 'Audit log', 'Who did what, and when.']
    ];
    const HERO_ACTION = { support: ['tickets', 'Open my tickets', 'tickets.view'], money: ['payments', 'Review payments', 'subscriptions.review'], growth: ['growth', 'Open Circle & Crew', 'growth.view'], safety: ['reports', 'Open reports', 'reports.review'], ops: ['orders', 'Look at orders', 'orders.view'], owner: ['staff', 'Review your team', 'staff.view'], audit: ['audit', 'Open the audit log', 'audit.view'] };
    S.register({ key: 'overview', title: 'Home', icon: 'dashboard', group: 'work', any: ['dashboard.view'], async render({ me, can }) {
        const o = await api.swr('/overview', { onFresh: () => {} });
        const theme = S.ROLE_THEME[me.role ? me.role.key : ''] || 'ops';
        const stat = (n, l, href, tone, hint) => (n === null || n === undefined) ? null : S.statTile(num(n), l, { href, tone, hint });
        const a = o.attention || {}, hd = o.headline || {}, t = a.tickets;
        const attention = [
            t && stat(t.breached, 'Tickets past their deadline', '#tickets', t.breached ? 'bad' : '', 'Every ticket has a reply deadline (SLA). These are already late, so answer them first.'), t && stat(t.unassigned, 'Tickets nobody owns', '#tickets', t.unassigned ? 'warn' : ''), t && stat(t.mine, 'Assigned to you', '#tickets'),
            stat(a.pendingPayments, 'Seller payments to review', '#payments', a.pendingPayments ? 'warn' : '', 'A seller says they paid for their Seller Pass. Approve only after you see the money in the MTN/Airtel statement.'), stat(a.openReports, 'Open buyer reports', '#reports', a.openReports ? 'warn' : ''),
            stat(a.flaggedOrders, 'Flagged orders', '#orders', a.flaggedOrders ? 'warn' : '', 'Orders the system or a staff member marked as needing a second look.'), stat(a.myFollowUps, 'Your follow-ups', '#followups'),
            stat(a.pendingInvites, 'Staff invites waiting', '#staff'), stat(a.staffWithoutMfa, 'Staff without two-step', '#security', a.staffWithoutMfa ? 'bad' : '')
        ].filter(Boolean);
        const root_ = h('div', null);
        const hero = HERO_ACTION[theme];
        root_.append(h('div', { class: 'home-hero' }, h('div', null, h('h1', null, `Hello, ${me.name.split(' ')[0]}`), h('p', null, `${S.ROLE_HOME[theme]} Last sign-in ${ago(me.lastLoginAt)}.`)), hero && can(hero[2]) ? h('a', { class: 'btn', href: '#' + hero[0] }, hero[1]) : null));
        const intro = S.intro('home', 'Welcome to your console', 'Everything here is built around your role, so you only see what you can use.', ['Press Ctrl+K (or ⌘K) anywhere to search people, orders and tickets, or jump to a page.', 'Actions that change money or access ask for your 6-digit PIN. That is normal, and it is recorded.', 'Look for the small ? buttons: they explain any term in plain language.']);
        if (intro) root_.append(intro);
        const quick = QUICK.filter(([perm]) => can(perm)).slice(0, 6);
        if (quick.length) root_.append(h('div', { class: 'quick' }, quick.map(([, key, ic, title, d]) => h('a', { href: '#' + key }, h('span', { class: 'ic' }, icon(ic)), h('span', null, h('strong', null, title), h('span', { class: 'd' }, d))))));
        if (attention.length) root_.append(h('h2', { class: 'sect' }, 'Needs attention'), h('div', { class: 'stats' }, attention));
        const head = [stat(hd.users, 'Accounts'), stat(hd.sellers, 'Sellers'), stat(hd.stores, 'Live stores'), stat(hd.restricted, 'Restricted stores', null, hd.restricted ? 'warn' : '', 'Stores a staff member hid from shoppers. They can be restored from the Stores page.'), stat(hd.newToday, 'New in 24 hours')].filter(Boolean);
        if (head.length) root_.append(h('h2', { class: 'sect' }, 'Marketplace'), h('div', { class: 'stats' }, head));
        if (can('analytics.view')) {
            const slot = h('div', null, S.skeleton('table')); root_.append(h('h2', { class: 'sect' }, 'Last 30 days'), slot);
            api.swr('/analytics').then((d) => {
                const lab = d.series.map((x) => x.date.slice(5));
                const chart = (key, title, fmt) => { const vals = d.series.map((x) => x[key]); const total = vals.reduce((s2, x) => s2 + x, 0); return h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h3', null, title), h('strong', null, fmt(total))), S.barChart(vals, lab, { fmt, ariaLabel: `${title}, daily for 30 days, total ${fmt(total)}` })); };
                const months = d.months.map((m) => m.month), rev = d.months.map((m) => m.revenue);
                mount(slot, h('div', { class: 'grid2' }, chart('signups', 'New sign-ups', num), chart('orders', 'Orders placed', num)),
                    h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h3', null, 'Seller Pass revenue, last 6 months'), S.help('Money from sellers paying for their monthly Seller Pass. It is not the value of shoppers\' orders.', 'Seller Pass revenue')), S.barChart(rev, months, { fmt: money, ariaLabel: 'Seller Pass revenue per month' })));
            }).catch((e) => mount(slot, h('div', { class: 'banner bad' }, e.message)));
        }
        if (o.recent) root_.append(h('h2', { class: 'sect' }, 'Recent activity'), miniList(o.recent, 'No activity yet.', (r) => [h('div', { class: 'when' }, `${date(r.at)} · ${r.actorLabel || 'System'}`), h('div', null, label(r.action))]));
        return root_;
    } });

    // ---- Users --------------------------------------------------------------------------------------------------------
    async function openUser(id, refresh) {
        const d = drawer('Account'); mount(d.body, h('div', { class: 'skel' }));
        const load = async () => {
            const x = await api.get(`/users/${encodeURIComponent(id)}`); const u = x.user; d.setTitle(u.name);
            const act = (text, fn, cls) => h('button', { class: `btn sm ${cls || ''}`, type: 'button', onclick: async () => { try { await fn(); await load(); refresh && refresh(); } catch (e) { if (e.code !== 'REAUTH_CANCELLED') toast(e.message, 'bad'); } } }, text);
            const actions = h('div', { class: 'row' },
                S.can('users.edit') && act('Edit details', async () => { await askBox({ title: 'Edit account', fields: [{ name: 'name', label: 'Name', value: u.name, required: true, max: 80 }, { name: 'email', label: 'Email', type: 'email', value: u.email, required: true }, { name: 'role', label: 'Account type', type: 'select', value: u.role, options: [{ value: 'buyer', label: 'Buyer' }, { value: 'seller', label: 'Seller' }] }], submit: (v) => api.put(`/users/${u.id}`, v) }); }),
                S.can('users.suspend') && (u.accountStatus === 'suspended'
                    ? act('Reactivate', async () => { await confirmBox({ title: 'Reactivate account?', text: `${u.name} will be able to sign in again.`, confirm: 'Reactivate', submit: () => api.put(`/users/${u.id}`, { accountStatus: 'active' }) }); })
                    : act('Suspend', async () => { await askBox({ title: 'Suspend account', intro: 'They are signed out everywhere and cannot sign in. The reason is recorded.', danger: true, confirm: 'Suspend', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', rows: 3, max: 300, required: true }], submit: (v) => api.put(`/users/${u.id}`, { accountStatus: 'suspended', reason: v.reason }) }); }, 'danger')),
                S.can('users.contact') && h('button', { class: 'btn sm primary', type: 'button', onclick: () => S.contactDialog(u).then(() => load()).catch((e) => toast(e.message, 'bad')) }, icon('message'), 'Message'),
                S.can('users.password_reset') && act('Send password reset', async () => { await confirmBox({ title: 'Email a password reset link?', text: `A reset link goes to ${u.email}. You never see the password.`, confirm: 'Send link', submit: async () => { const r = await api.post(`/users/${u.id}/password-reset`); toast(r.message, r.emailed ? 'good' : 'warn'); } }); }),
                S.can('users.sessions') && act('Sign out everywhere', async () => { await confirmBox({ title: 'Sign out everywhere?', text: 'All of their devices are signed out.', confirm: 'Sign out', submit: () => api.post(`/users/${u.id}/sign-out`) }); toast('Signed out.', 'good'); }));
            const noteForm = S.can('users.notes') && h('form', { class: 'stack', onsubmit: async (e) => { e.preventDefault(); const t = e.target.elements.body; try { await api.post(`/users/${u.id}/notes`, { body: t.value }); await load(); } catch (er) { toast(er.message, 'bad'); } } },
                h('label', { class: 'f' }, 'Add an internal note', h('textarea', { name: 'body', rows: 2, maxlength: 2000, required: true })), h('div', null, h('button', { class: 'btn sm primary', type: 'submit' }, 'Add note')));
            mount(d.body, h('div', { class: 'stack' },
                sub('Profile', kv([['Email', u.email], ['Type', badge(u.role, '')], ['Status', badge(u.accountStatus)], ['Email verified', u.emailVerified ? 'Yes' : 'No'], ['Google linked', u.googleLinked ? 'Yes' : 'No'], ['Joined', date(u.createdAt)], ['Last active', ago(u.lastActiveAt)],
                    u.store && ['Store', `${u.store.name} (${u.store.moderationStatus})`], u.store && ['Seller Pass', u.store.subscription && (u.store.subscription.status || u.store.subscription.state) || '—']]), actions),
                x.tickets && sub('Support tickets', miniList(x.tickets, 'None.', (t) => h('a', { href: '#tickets/' + t.id, onclick: () => d.close() }, `#${t.number} ${t.subject} `, badge(t.status)))),
                x.orders && sub('Recent orders', miniList(x.orders, 'None.', (o) => h('a', { href: '#orders/' + o.id, onclick: () => d.close() }, `${money(o.total)} · ${label(o.status)} · ${date(o.createdAt, false)}${o.flaggedAt ? ' · flagged' : ''}`))),
                x.payments && sub('Seller Pass payments', miniList(x.payments, 'None.', (p) => `${money(p.amount)} · ${p.periodMonths} mo · ${label(p.status)} · ${date(p.submittedAt, false)}`)),
                x.reports && sub('Reports filed', miniList(x.reports, 'None.', (r) => `${label(r.reason)} · ${date(r.createdAt, false)}${r.reviewedAt ? '' : ' · open'}`)),
                x.notes && sub('Internal notes', noteForm, miniList(x.notes, 'No notes yet.', (n) => [h('div', { class: 'when' }, `${n.authorName} · ${date(n.createdAt)}`), h('div', { style: 'white-space:pre-wrap' }, n.body)])),
                x.audit && sub('Account history', miniList(x.audit, 'Nothing recorded.', (r) => [h('div', { class: 'when' }, `${date(r.at)} · ${r.actor ? r.actor.name : 'System'}`), label(r.action)]))));
        };
        try { await load(); } catch (e) { mount(d.body, h('div', { class: 'banner bad' }, e.message)); }
    }
    S.openUser = openUser;
    S.register({ key: 'users', title: 'Users', icon: 'users', group: 'market', any: ['users.view'], async render({ arg }) {
        if (arg) openUser(arg);
        const wrap = h('div', null, pageHead('Users', 'Buyers and sellers on the marketplace. Staff accounts are managed under Staff.'));
        let refreshList; const lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Name, email or id' }, { key: 'role', label: 'Type', type: 'select', options: opts(['buyer', 'seller'], 'All types') }, { key: 'accountStatus', label: 'Status', type: 'select', options: opts(['active', 'suspended'], 'Any status') }],
            load: async (p) => { const r = await api.get('/users', { query: p }); return { rows: r.users, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'Name', render: (u) => h('div', null, h('strong', null, u.name), h('div', { class: 'muted small' }, u.email)) }, { label: 'Type', render: (u) => badge(u.role, '') }, { label: 'Status', render: (u) => badge(u.accountStatus) }, { label: 'Store', render: (u) => u.store ? u.store.name : '—' }, { label: 'Last active', render: (u) => ago(u.lastActiveAt) }],
            onRow: (u) => openUser(u.id, () => {}), rowLabel: (u) => `Open ${u.name}`, empty: 'No accounts match.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Stores & products ---------------------------------------------------------------------------------------------------
    const moderate = (kind, id, current, onDone) => {
        if (current === 'restricted') return confirmBox({ title: `Restore this ${kind}?`, text: 'It becomes visible on the marketplace again and the owner is told.', confirm: 'Restore', submit: async () => { await api.put(`/${kind}s/${id}/moderation`, { status: 'ok' }); } }).then((r) => { if (r) { toast('Restored.', 'good'); onDone(); } });
        return askBox({ title: `Restrict this ${kind}`, intro: `It is hidden from shoppers straight away. The owner is told, with your reason.`, danger: true, confirm: 'Restrict', fields: [reasonField('Reason (shown to the owner)')], submit: (v) => api.put(`/${kind}s/${id}/moderation`, { status: 'restricted', note: v.note }) }).then((r) => { if (r) { toast('Restricted.', 'good'); onDone(); } });
    };
    S.register({ key: 'stores', title: 'Stores', icon: 'store', group: 'market', any: ['stores.view'], async render() {
        const wrap = h('div', null, pageHead('Stores', 'Review stores and restrict any that break the rules.'));
        const lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Name, slug, owner email or id' }, { key: 'filter', label: 'Show', type: 'select', options: opts([['live', 'Live'], ['restricted', 'Restricted'], ['draft', 'Drafts'], ['verified', 'Verified'], ['lapsed', 'Lapsed Seller Pass']], 'All stores') }],
            load: async (p) => { const r = await api.get('/stores', { query: p }); return { rows: r.stores, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'Store', render: (s) => h('div', null, h('strong', null, s.name), h('div', { class: 'muted small' }, `/${s.slug}`)) }, { label: 'Owner', render: (s) => s.owner ? s.owner.name : '—' }, { label: 'State', render: (s) => [badge(s.moderationStatus), ' ', s.verified ? badge('verified') : null, ' ', s.isPublished ? null : badge('draft')] }, { label: 'Products', render: (s) => num(s.products) }, { label: 'Joined', render: (s) => date(s.createdAt, false) }],
            onRow: (s) => openStore(s.id, () => lv.querySelector('button[aria-label=Refresh]').click()), rowLabel: (s) => `Open ${s.name}`, empty: 'No stores match.' });
        wrap.append(lv); return wrap;
    } });
    async function openStore(id, refresh) {
        const d = drawer('Store'); mount(d.body, h('div', { class: 'skel' }));
        try {
            const { store: s } = await api.get(`/stores/${encodeURIComponent(id)}`); d.setTitle(s.name);
            mount(d.body, h('div', { class: 'stack' }, sub('Details', kv([['Slug', `/${s.slug}`], ['District', s.district], ['State', badge(s.moderationStatus)], s.moderationNote && ['Restriction note', s.moderationNote], ['Published', s.isPublished ? 'Yes' : 'No'], ['Verified', s.verified ? 'Yes' : 'No'], ['Owner', s.owner ? `${s.owner.name} (${s.owner.email})` : '—'], ['Contact', s.contactEmail], ['Phone', s.phoneNumber], ['Address', s.address], ['Orders', num(s.orders)], ['Products', num(s.products)], ['Joined', date(s.createdAt)]]),
                h('div', { class: 'row' }, S.can('stores.manage') && h('button', { class: `btn sm ${s.moderationStatus === 'restricted' ? '' : 'danger'}`, type: 'button', onclick: () => moderate('store', s.id, s.moderationStatus, () => { d.close(); refresh && refresh(); }) }, s.moderationStatus === 'restricted' ? 'Restore store' : 'Restrict store'),
                    s.owner && S.can('users.view') && h('button', { class: 'btn sm', type: 'button', onclick: () => { d.close(); openUser(s.owner.id); } }, 'Open owner')))));
        } catch (e) { mount(d.body, h('div', { class: 'banner bad' }, e.message)); }
    }
    S.register({ key: 'products', title: 'Products', icon: 'box', group: 'market', any: ['products.view'], async render() {
        const wrap = h('div', null, pageHead('Products', 'Listings across all stores. Restrict a listing to hide it from shoppers.'));
        const lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Product name' }, { key: 'filter', label: 'Show', type: 'select', options: opts([['restricted', 'Restricted only']], 'All listings') }],
            load: async (p) => { const r = await api.get('/products', { query: p }); return { rows: r.products, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'Product', render: (p) => h('div', { class: 'row' }, p.image ? h('img', { src: p.image, alt: '', width: 40, height: 40, style: 'border-radius:8px;object-fit:cover', referrerpolicy: 'no-referrer' }) : null, h('div', null, h('strong', null, p.name), h('div', { class: 'muted small' }, p.category || ''))) }, { label: 'Store', render: (p) => p.store ? p.store.name : '—' }, { label: 'Price', render: (p) => money(p.price) }, { label: 'Stock', render: (p) => num(p.stock) }, { label: 'State', render: (p) => badge(p.moderationStatus) },
                { label: '', render: (p) => S.can('products.moderate') ? h('button', { class: `btn sm ${p.moderationStatus === 'restricted' ? '' : 'danger'}`, type: 'button', onclick: () => moderate('product', p.id, p.moderationStatus, () => lv.querySelector('button[aria-label=Refresh]').click()) }, p.moderationStatus === 'restricted' ? 'Restore' : 'Restrict') : null }],
            empty: 'No products match.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Orders -----------------------------------------------------------------------------------------------------------
    async function openOrder(id, refresh) {
        const d = drawer('Order'); mount(d.body, h('div', { class: 'skel' }));
        try {
            const o = await api.get(`/orders/${encodeURIComponent(id)}`); d.setTitle(`Order ${o.id.slice(-8).toUpperCase()}`);
            mount(d.body, h('div', { class: 'stack' }, sub('Summary', kv([['Status', badge(o.status)], ['Payment', badge(o.paymentStatus || '—', '')], ['Total', money(o.total)], ['Store', o.store && o.store.name], ['Customer', o.customerName], ['Phone', o.customerPhone], ['Fulfilment', label(o.fulfillmentMethod)], ['Address', o.deliveryAddress], ['Payment method', o.paymentMethod], o.cancelReason && ['Cancelled', `${o.cancelReason}`], ['Placed', date(o.createdAt)], o.flaggedAt && ['Flagged', `${o.flagReason || 'Yes'} · ${date(o.flaggedAt)}`]]),
                o.flaggedAt && S.can('orders.manage') && h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { const r = await askBox({ title: 'Clear flag', intro: 'Say why this order is fine. It is recorded.', fields: [reasonField('Note')], submit: (v) => api.put(`/orders/${o.id}/clear-flag`, { note: v.note }) }); if (r) { toast('Flag cleared.', 'good'); d.close(); refresh && refresh(); } } }, 'Clear flag'))),
                Array.isArray(o.items) && sub('Items', miniList(o.items, 'No items.', (i) => `${i.quantity} × ${i.productName} · ${money(i.unitPrice)}`))));
        } catch (e) { mount(d.body, h('div', { class: 'banner bad' }, e.message)); }
    }
    S.register({ key: 'orders', title: 'Orders', icon: 'bag', group: 'market', any: ['orders.view'], badge: 'orders', async render({ arg }) {
        if (arg) openOrder(arg);
        const wrap = h('div', null, pageHead('Orders', 'Look up an order to help a customer or review a flagged one. Staff cannot change what was ordered.'));
        const lv = listView({ filters: [{ key: 'q', label: 'Search', placeholder: 'Order id, customer or phone' }, { key: 'status', label: 'Status', type: 'select', options: opts(['pending', 'processing', 'shipped', 'delivered', 'cancelled'], 'Any status') }, { key: 'flagged', label: 'Flags', type: 'select', options: [{ value: '', label: 'All' }, { value: '1', label: 'Flagged only' }] }],
            load: async (p) => { const r = await api.get('/orders', { query: p }); return { rows: r.orders, page: r.page, pages: r.pages, total: r.total }; },
            columns: [{ label: 'Order', render: (o) => h('div', null, h('strong', null, o.id.slice(-8).toUpperCase()), h('div', { class: 'muted small' }, date(o.createdAt))) }, { label: 'Customer', render: (o) => o.customerName }, { label: 'Store', render: (o) => o.store ? o.store.name : '—' }, { label: 'Total', render: (o) => money(o.total) }, { label: 'Status', render: (o) => [badge(o.status), o.flaggedAt ? [' ', badge('flagged', 'warn')] : null] }],
            onRow: (o) => openOrder(o.id, () => lv.querySelector('button[aria-label=Refresh]').click()), rowLabel: (o) => `Open order ${o.id.slice(-8)}`, empty: 'No orders match.' });
        wrap.append(lv); return wrap;
    } });

    // ---- Reports -----------------------------------------------------------------------------------------------------------
    S.register({ key: 'reports', title: 'Buyer reports', icon: 'flag', group: 'market', any: ['reports.review'], badge: 'reports', async render() {
        const wrap = h('div', null, pageHead('Buyer reports', 'Problems buyers reported on their orders.'));
        const lv = listView({ filters: [{ key: 'status', label: 'Show', type: 'select', value: 'open', options: [{ value: 'open', label: 'Open' }, { value: 'reviewed', label: 'Reviewed' }, { value: '', label: 'All' }] }],
            load: async (p) => { const rows = await api.get('/reports', { query: p }); return { rows, page: 1, pages: 1, total: rows.length }; },
            columns: [{ label: 'Reason', render: (r) => h('div', null, h('strong', null, label(r.reason)), r.details ? h('div', { class: 'muted small' }, String(r.details).slice(0, 160)) : null) }, { label: 'Order', render: (r) => r.order ? h('a', { href: '#orders/' + r.order.id }, `${r.order.id.slice(-8).toUpperCase()} · ${money(r.order.total)}`) : '—' }, { label: 'Store', render: (r) => r.order && r.order.store ? r.order.store.name : '—' }, { label: 'Filed', render: (r) => date(r.createdAt) },
                { label: '', render: (r) => r.reviewedAt ? badge('reviewed', 'good') : h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api.put(`/reports/${r.id}/review`); toast('Marked as reviewed.', 'good'); lv.querySelector('button[aria-label=Refresh]').click(); } catch (e) { toast(e.message, 'bad'); } } }, 'Mark reviewed') }],
            empty: 'No reports.' });
        wrap.append(lv); return wrap;
    } });
})(window);
