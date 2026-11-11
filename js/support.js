/* Help & Support page: open a ticket, and (signed in) follow your tickets. */
(function () {
    'use strict';
    const form = document.getElementById('supportForm');
    if (!form) return;
    const err = document.getElementById('supportError');
    const done = document.getElementById('supportDone');
    const list = document.getElementById('myTickets');
    const card = document.getElementById('myTicketsCard');
    const guest = document.getElementById('supportGuest');
    const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); kids.forEach((k) => n.append(k)); return n; };
    const signedIn = () => !!(window.app && app.token && app.user);

    async function loadMine() {
        if (!signedIn()) { guest.hidden = false; return; }
        try {
            const r = await app.apiRequest('/support/tickets');
            if (!r.data.length) return;
            card.hidden = false; list.replaceChildren();
            r.data.forEach((t) => {
                const row = el('li', { className: 'support-item' }, el('button', { type: 'button', className: 'support-open', textContent: `#${t.number}  ${t.subject}` }), el('span', { className: `support-status s-${t.status}`, textContent: t.status }));
                const thread = el('div', { className: 'support-thread', hidden: true });
                row.append(thread);
                row.firstChild.addEventListener('click', async () => {
                    if (!thread.hidden) { thread.hidden = true; return; }
                    thread.hidden = false; thread.textContent = 'Loading...';
                    try {
                        const d = (await app.apiRequest(`/support/tickets/${t.id}`)).data; thread.replaceChildren();
                        d.messages.forEach((m) => thread.append(el('div', { className: `support-msg ${m.from}` }, el('strong', { textContent: m.author }), el('p', { textContent: m.body }))));
                        if (d.status !== 'closed') {
                            const box = el('textarea', { rows: 3, maxLength: 5000, placeholder: 'Write a reply...' }); const send = el('button', { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'Reply' });
                            send.addEventListener('click', async () => { if (!box.value.trim()) return; send.disabled = true; try { await app.apiRequest(`/support/tickets/${t.id}/messages`, { method: 'POST', body: JSON.stringify({ body: box.value }) }); thread.hidden = true; row.firstChild.click(); } catch (e) { send.disabled = false; app.showAlert(e.message || 'Could not send.', 'error'); } });
                            thread.append(box, send);
                        }
                    } catch (e) { thread.textContent = e.message || 'Could not load this ticket.'; }
                });
                list.append(row);
            });
        } catch (e) { /* the form still works */ }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = '';
        const v = Object.fromEntries(new FormData(form)); const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
        try {
            const r = await app.apiRequest('/support/tickets', { method: 'POST', body: JSON.stringify(v) });
            form.hidden = true; done.hidden = false; done.textContent = r.data.message || 'Thanks. We will be in touch.'; loadMine();
        } catch (x) { err.textContent = x.message || 'Could not send your message. Please try again.'; btn.disabled = false; }
    });
    const start = () => loadMine();
    if (window.app && app.ready && typeof app.ready.then === 'function') app.ready.then(start, start); else setTimeout(start, 400);
})();
