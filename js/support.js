/* Help & Support page: open a ticket, and (signed in) read and answer your tickets here.
 * `app` is a top-level `const` in main.js, so it is NOT on `window`. Always test with `typeof app`. */
(function () {
    'use strict';
    const form = document.getElementById('supportForm');
    if (!form) return;
    const $ = (id) => document.getElementById(id);
    const err = $('supportError'), done = $('supportDone'), list = $('myTickets'), guest = $('supportGuest');
    const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); kids.forEach((k) => n.append(k)); return n; };
    const hasApp = () => typeof app !== 'undefined' && app && typeof app.apiRequest === 'function';
    const signedIn = () => hasApp() && !!app.token && !!app.user;
    const qs = new URLSearchParams(location.search);
    const STATUS = { open: 'Open', pending: 'Replied', resolved: 'Resolved', closed: 'Closed' };
    const getSeen = (id) => { try { return localStorage.getItem('ns_support_seen_' + id) || ''; } catch (e) { return ''; } };
    const setSeen = (id, v) => { try { localStorage.setItem('ns_support_seen_' + id, v || new Date().toISOString()); } catch (e) { /* private mode */ } };
    const when = (d) => { try { return new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
    let tickets = [], filter = 'all', openId = qs.get('ticket') || '';

    // Other pages (Nexi, orders, Seller Pass) can link here with ?category=&subject=&order=&body=
    function prefill() {
        const cat = qs.get('category'), subj = qs.get('subject'), order = qs.get('order');
        if (cat) { const r = form.querySelector('input[name=category][value="' + CSS.escape(cat) + '"]'); if (r) r.checked = true; }
        if (subj) form.elements.subject.value = subj.slice(0, 160);
        if (order) form.elements.orderId.value = order.slice(0, 40);
        if (qs.get('body')) form.elements.body.value = qs.get('body').slice(0, 5000);
    }
    $('spQuick')?.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-cat]'); if (!b) return;
        const r = form.querySelector('input[name=category][value="' + b.dataset.cat + '"]'); if (r) r.checked = true;
        if (!form.elements.subject.value) form.elements.subject.value = b.dataset.subject || '';
        form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.elements.subject.focus({ preventScroll: true });
    });

    function paintIdentity() {
        const on = signedIn();
        guest.hidden = on; $('supportWho').hidden = !on; $('spGuestNote').hidden = on;
        if (!on) return;
        const name = app.user.name || 'there';
        $('supportWhoName').textContent = 'Signed in as ' + name;
        $('supportWhoMail').textContent = 'We will reply to ' + (app.user.email || 'your email') + ' and in this page';
        $('supportWhoAv').textContent = (name.trim()[0] || 'N').toUpperCase();
        $('spSendNote').textContent = 'Replies appear under “Your tickets”.';
    }

    const needsYou = (t) => t.lastFrom === 'support' && t.status !== 'closed' && getSeen(t.id) < (t.lastReplyAt || '');
    function paintTabs() {
        const tabs = $('spTabs'); if (!tickets.length) { tabs.hidden = true; return; }
        const n = { all: tickets.length, new: tickets.filter(needsYou).length, open: tickets.filter((t) => ['open', 'pending'].includes(t.status)).length, closed: tickets.filter((t) => ['closed', 'resolved'].includes(t.status)).length };
        if (filter === 'new' && !n.new) filter = 'all';
        tabs.hidden = false; tabs.replaceChildren();
        [['all', 'All'], ['new', 'New reply'], ['open', 'Open'], ['closed', 'Closed']].forEach(([k, l]) => {
            if (k === 'new' && !n.new) return;
            const b = el('button', { type: 'button', textContent: l + ' ' + n[k] }); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(filter === k));
            b.addEventListener('click', () => { filter = k; paintTabs(); paintList(); }); tabs.append(b);
        });
        const nc = $('spNewCount'); nc.hidden = !n.new; nc.textContent = n.new === 1 ? '1 new reply' : n.new + ' new replies';
    }
    function paintList() {
        list.replaceChildren();
        const shown = tickets.filter((t) => filter === 'all' || (filter === 'new' && needsYou(t)) || (filter === 'open' && ['open', 'pending'].includes(t.status)) || (filter === 'closed' && ['closed', 'resolved'].includes(t.status)));
        $('spEmpty').hidden = tickets.length > 0 || !signedIn();
        shown.forEach((t) => list.append(ticketRow(t)));
        const target = openId && list.querySelector('[data-id="' + CSS.escape(openId) + '"] .support-open');
        if (target) { openId = ''; target.click(); target.closest('.support-item').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    function ticketRow(t) {
        const fresh = needsYou(t);
        const row = el('li', { className: 'support-item' + (fresh ? ' has-new' : '') }); row.dataset.id = t.id;
        const main = el('span', { className: 'support-open-main' });
        const title = el('strong'); if (fresh) title.append(el('span', { className: 'sp-dot', title: 'New reply' })); title.append(t.subject);
        main.append(title, el('small', { textContent: '#' + t.number + ' · Updated ' + when(t.lastMessageAt || t.updatedAt) }));
        const head = el('button', { type: 'button', className: 'support-open' }, main, el('span', { className: 'support-status s-' + t.status, textContent: STATUS[t.status] || t.status }));
        head.setAttribute('aria-expanded', 'false');
        const thread = el('div', { className: 'support-thread', hidden: true });
        row.append(head, thread);
        head.addEventListener('click', async () => {
            if (!thread.hidden) { thread.hidden = true; row.classList.remove('is-open'); head.setAttribute('aria-expanded', 'false'); return; }
            list.querySelectorAll('.support-thread').forEach((x) => { x.hidden = true; x.parentNode.classList.remove('is-open'); });
            thread.hidden = false; row.classList.add('is-open'); head.setAttribute('aria-expanded', 'true');
            await loadThread(t, thread, row);
        });
        return row;
    }
    async function loadThread(t, thread, row) {
        thread.replaceChildren(el('div', { className: 'sp-skel' }));
        try {
            const d = (await app.apiRequest('/support/tickets/' + encodeURIComponent(t.id))).data; thread.replaceChildren();
            const msgs = el('div', { className: 'support-msgs' });
            d.messages.forEach((m) => msgs.append(el('div', { className: 'support-msg ' + m.from }, el('strong', { textContent: m.author }), el('time', { textContent: when(m.at) }), el('p', { textContent: m.body }))));
            thread.append(msgs); requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
            const last = d.messages[d.messages.length - 1]; setSeen(t.id, last ? last.at : null);
            row.classList.remove('has-new'); row.querySelector('.sp-dot')?.remove(); t.lastReplyAt = last ? last.at : t.lastReplyAt; t.status = d.status || t.status;
            const pillEl = row.querySelector('.support-status'); pillEl.className = 'support-status s-' + t.status; pillEl.textContent = STATUS[t.status] || t.status;
            paintTabs();
            if (d.status === 'closed') { thread.append(el('p', { className: 'support-closed-note', textContent: 'This ticket is closed. Open a new one if you still need help.' })); return; }
            const box = el('textarea', { rows: 2, maxLength: 5000, placeholder: 'Write a reply…' }); box.setAttribute('aria-label', 'Reply to support');
            const send = el('button', { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'Reply' });
            send.addEventListener('click', async () => {
                if (box.value.trim().length < 2) { box.focus(); return; }
                send.disabled = true; send.textContent = 'Sending…';
                try { await app.apiRequest('/support/tickets/' + encodeURIComponent(t.id) + '/messages', { method: 'POST', body: JSON.stringify({ body: box.value }) }); await loadThread(t, thread, row); }
                catch (e) { send.disabled = false; send.textContent = 'Reply'; if (app.showAlert) app.showAlert(e.message || 'Could not send.', 'error'); }
            });
            thread.append(el('div', { className: 'support-reply' }, box, send));
        } catch (e) { thread.replaceChildren(el('p', { className: 'support-closed-note', textContent: e.message || 'Could not load this ticket.' })); }
    }

    async function loadMine() {
        paintIdentity();
        if (!signedIn()) return;
        list.replaceChildren(el('li', null, el('div', { className: 'sp-skel' })), el('li', null, el('div', { className: 'sp-skel' })));
        try { tickets = (await app.apiRequest('/support/tickets')).data || []; } catch (e) { tickets = []; }
        list.replaceChildren(); paintTabs(); paintList();
    }
    async function loadFast() {
        if (!hasApp()) return;
        try {
            const c = await app.apiRequest('/assistant/handoff-contact'); if (!c || !c.enabled) return;
            $('spFast').hidden = false; $('spFastLink').href = 'https://wa.me/' + c.whatsappDigits + '?text=' + encodeURIComponent('Hello, I need help from NextaStore support.');
            $('spFastText').textContent = 'Chat with the ' + (c.label || 'NextaStore support team') + ' on WhatsApp.' + (c.hoursNote ? ' ' + c.hoursNote : '');
        } catch (e) { /* optional */ }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = '';
        const v = Object.fromEntries(new FormData(form)); if (!v.orderId) delete v.orderId;
        if (signedIn()) { delete v.name; delete v.email; }
        const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Sending…';
        try {
            const r = await app.apiRequest('/support/tickets', { method: 'POST', body: JSON.stringify(v) });
            form.hidden = true; done.hidden = false;
            done.replaceChildren(el('strong', { textContent: 'Message sent' }), el('span', { textContent: r.data.message || 'Thanks. We will be in touch.' }));
            const again = el('button', { type: 'button', className: 'btn btn-outline btn-sm', textContent: 'Send another message' });
            again.addEventListener('click', () => { form.reset(); form.hidden = false; done.hidden = true; btn.disabled = false; btn.textContent = 'Send to support'; });
            done.append(again); openId = r.data.id || ''; loadMine();
        } catch (x) { err.textContent = x.message || 'Could not send your message. Please try again.'; btn.disabled = false; btn.textContent = 'Send to support'; }
    });

    prefill();
    const start = () => { loadMine(); loadFast(); };
    // The signed-in user record can arrive a moment after the page script runs, so paint once, then refresh.
    if (hasApp() && app.token && !app.user) { paintIdentity(); setTimeout(start, 350); } else start();
})();
