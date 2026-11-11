/* Sections: Message templates, Broadcasts, and the one-to-one "Message this person" dialog. */
(function (root) {
    'use strict';
    const S = root.Staff, api = S.api;
    const { h, mount, icon, date, ago, num, label, badge, toast, overlay, confirmBox, pageHead } = S;

    const KIND_INFO = { reply: ['Ticket reply', 'Used inside a support ticket. The customer gets it as your reply.'], email: ['Email', 'Sent to a person\'s email address, with a subject line.'], notification: ['In-app notice', 'Shows in the bell icon inside NextaStore. Short and friendly works best.'] };
    const render = (text, vars) => String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (vars[k.toLowerCase()] ? vars[k.toLowerCase()] : m));
    S.renderTemplate = render;
    const sampleVars = (name) => { const n = String(name || 'Amina Nakato').trim(); return { name: n, first_name: n.split(/\s+/)[0], staff_name: String((S.state.me && S.state.me.name) || 'Sam').split(/\s+/)[0] }; };
    const loadTemplates = (kind) => api.swr('/canned-replies', { query: kind ? { kind } : {}, ttl: 60000 });
    const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.code !== 'REAUTH_CANCELLED') toast(e.message, 'bad'); return null; } };

    /** Variable chips that insert {{first_name}} etc. at the cursor of `target`. */
    function varChips(variables, target) {
        return h('div', { class: 'chips', 'aria-label': 'Insert a variable' }, h('span', { class: 'muted small' }, 'Insert:'), variables.map((v) => h('button', { type: 'button', title: `${v.label}, for example ${v.example}`, onclick: () => {
            const t = `{{${v.key}}}`; const el = target(); const s = el.selectionStart || 0, e = el.selectionEnd || 0; el.value = el.value.slice(0, s) + t + el.value.slice(e); el.focus(); el.setSelectionRange(s + t.length, s + t.length); el.dispatchEvent(new Event('input'));
        } }, v.label)));
    }
    const previewBox = (subject, body, withSubject) => h('div', { class: 'preview-box' }, withSubject ? h('div', { class: 'subj' }, subject || '(no subject yet)') : null, body || 'Your message will look like this.');

    // ---- Message one person --------------------------------------------------------------------------------------------------
    S.contactDialog = async (user) => {
        const data = await loadTemplates();
        const tpls = data.templates.filter((t) => t.kind !== 'reply'); const vars = data.variables;
        const vals = sampleVars(user.name);
        const email = h('input', { type: 'checkbox', checked: true }), inapp = h('input', { type: 'checkbox', checked: true });
        const pick = h('select', { 'aria-label': 'Start from a template' }, h('option', { value: '' }, 'Start from a template (optional)'), tpls.map((t) => h('option', { value: t.id }, `${KIND_INFO[t.kind][0]}: ${t.title}`)));
        const subject = h('input', { maxlength: 150, placeholder: 'Subject (emails only)' }); const body = h('textarea', { rows: 7, maxlength: 4000, placeholder: `Write to ${user.name.split(' ')[0]}…` });
        const prev = h('div', null); const err = h('div', { class: 'err', role: 'alert' });
        const draw = () => mount(prev, previewBox(render(subject.value, vals), render(body.value, vals), email.checked));
        [subject, body, email].forEach((x) => x.addEventListener('input', draw)); email.addEventListener('change', draw);
        pick.addEventListener('change', () => { const t = tpls.find((x) => x.id === pick.value); if (t) { subject.value = t.subject || ''; body.value = t.body; draw(); } });
        const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send message');
        let ov;
        const form = h('form', { class: 'stack', novalidate: true }, h('h2', null, `Message ${user.name}`),
            h('p', { class: 'muted' }, `${user.email}. They will see your message as coming from NextaStore, not from you personally. It is saved in their notes.`),
            h('div', { class: 'row' }, h('label', { class: 'check' }, email, h('span', null, 'Email')), h('label', { class: 'check' }, inapp, h('span', null, 'In-app notification')), S.help('Email goes to their inbox (only if their address is verified). The in-app notice appears under the bell inside NextaStore. Pick both to be sure they see it.', 'Where it is sent')),
            pick, h('label', { class: 'f' }, 'Subject', subject), h('label', { class: 'f' }, h('span', { class: 'lbl' }, 'Message', S.help('Words in double curly brackets, like {{first_name}}, are replaced with the real name before sending. The preview below shows how it will read.', 'Variables')), body), varChips(vars, () => body),
            h('div', { class: 'explain' }, h('b', null, 'Preview'), prev), err, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ov.close(false) }, 'Cancel'), send));
        form.addEventListener('submit', async (e) => {
            e.preventDefault(); err.textContent = '';
            const channels = [email.checked && 'email', inapp.checked && 'in_app'].filter(Boolean);
            if (!channels.length) { err.textContent = 'Choose email, in-app, or both.'; return; }
            send.disabled = true;
            try { const r = await api.post(`/users/${encodeURIComponent(user.id)}/contact`, { channels, subject: subject.value, body: body.value });
                const bits = [r.email === 'sent' && 'email sent', r.email === 'skipped_unverified' && 'email skipped (address not verified)', r.email === 'not_configured' && 'email service is not set up (logged only)', r.email === 'failed' && 'email failed', r.inApp === 'sent' && 'in-app notice sent'].filter(Boolean);
                toast(`Done: ${bits.join(', ')}.`, r.email === 'failed' ? 'warn' : 'good'); ov.close(true); }
            catch (x) { err.textContent = x.message; send.disabled = false; }
        });
        ov = overlay(h('div', { class: 'modal wide' }, form), { label: 'Message this person' }); draw();
    };

    // ---- Templates ---------------------------------------------------------------------------------------------------------------
    S.register({ key: 'templates', title: 'Templates', icon: 'message', group: 'comms', any: ['tickets.view', 'canned.manage', 'users.contact'], skeleton: 'table', async render() {
        const manage = S.can('canned.manage'); let kind = ''; const slot = h('div', null);
        const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['', 'All'], ['reply', 'Ticket replies'], ['email', 'Emails'], ['notification', 'In-app notices']].map(([k, t]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === kind), dataset: { k }, onclick: () => { kind = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k))); load(); } }, t)));
        const edit = guard(async (c) => {
            const { variables } = await loadTemplates(); const k = h('select', { 'aria-label': 'Type' }, Object.entries(KIND_INFO).map(([v, [t]]) => h('option', { value: v, selected: v === (c ? c.kind : (kind || 'reply')) }, t)));
            const title = h('input', { value: c ? c.title : '', maxlength: 80, required: true }), subject = h('input', { value: c ? c.subject : '', maxlength: 150 }), group = h('input', { value: c ? c.category : '', maxlength: 30, placeholder: 'e.g. billing' }), body = h('textarea', { rows: 8, maxlength: 4000, required: true }); body.value = c ? c.body : '';
            const prev = h('div', null), kindHelp = h('p', { class: 'muted small' }), err = h('div', { class: 'err', role: 'alert' }), vals = sampleVars('Amina Nakato');
            const draw = () => { kindHelp.textContent = KIND_INFO[k.value][1]; mount(prev, previewBox(render(subject.value, vals), render(body.value, vals), k.value === 'email')); };
            [k, subject, body].forEach((x) => x.addEventListener('input', draw)); draw();
            let ov; const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save template');
            const form = h('form', { class: 'stack', novalidate: true }, h('h2', null, c ? 'Edit template' : 'New template'),
                h('label', { class: 'f' }, 'What is it for?', k, kindHelp), h('label', { class: 'f' }, 'Name', title), h('label', { class: 'f' }, h('span', { class: 'lbl' }, 'Email subject', S.help('Only used for emails and notices. Leave empty for ticket replies.', 'Subject')), subject),
                h('label', { class: 'f' }, 'Group (optional)', group), h('label', { class: 'f' }, h('span', { class: 'lbl' }, 'Text', S.help('Write it once, reuse it forever. {{first_name}} becomes the person\'s first name when you use the template.', 'Variables')), body), varChips(variables, () => body),
                h('div', { class: 'explain' }, h('b', null, 'Preview with a sample name'), prev), err, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ov.close(false) }, 'Cancel'), save));
            form.addEventListener('submit', async (e) => { e.preventDefault(); err.textContent = ''; save.disabled = true; try { const payload = { kind: k.value, title: title.value, subject: subject.value, category: group.value, body: body.value }; if (c) await api.put(`/canned-replies/${c.id}`, payload); else await api.post('/canned-replies', payload); toast('Template saved.', 'good'); ov.close(true); load(); } catch (x) { err.textContent = x.message; save.disabled = false; } });
            ov = overlay(h('div', { class: 'modal wide' }, form), { label: 'Template' });
        });
        async function load() {
            mount(slot, S.skeleton('table'));
            const { templates } = await api.get('/canned-replies', { query: kind ? { kind } : {} });
            mount(slot, S.table([{ label: 'Name', sort: (c) => c.title.toLowerCase(), render: (c) => h('div', null, h('strong', null, c.title), c.subject ? h('div', { class: 'muted small' }, c.subject) : null) }, { label: 'Type', sort: (c) => c.kind, render: (c) => badge(KIND_INFO[c.kind] ? KIND_INFO[c.kind][0] : c.kind, 'info') }, { label: 'Group', render: (c) => c.category || '—' }, { label: 'Starts with', render: (c) => h('span', { class: 'muted' }, String(c.body).slice(0, 90)) },
                manage ? { label: '', render: (c) => h('span', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(c) }, 'Edit'), h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { if (await confirmBox({ title: 'Delete this template?', text: c.title, danger: true, confirm: 'Delete', submit: () => api.del(`/canned-replies/${c.id}`) })) load(); }) }, 'Delete')) } : { label: '', render: () => null }], templates, { empty: 'No templates here yet.' }));
        }
        const wrap = h('div', null, pageHead('Templates', 'Ready-made messages so you answer faster and everyone sounds the same.', manage && h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, icon('plus'), 'New template')),
            S.intro('templates', 'How templates work', 'A template is a message you write once and reuse. Staff pick it when answering a ticket, messaging a person, or sending a broadcast.', ['Use {{first_name}} and the system fills in the real name.', 'Ticket replies appear in the "Insert saved reply" menu inside tickets.', 'Emails and in-app notices are available from a person\'s profile (Message) and from Broadcasts.']), tabs, slot);
        await load(); return wrap;
    } });

    // ---- Broadcasts ---------------------------------------------------------------------------------------------------------------
    S.register({ key: 'broadcast', title: 'Broadcasts', icon: 'megaphone', group: 'comms', any: ['broadcasts.send'], skeleton: 'table', async render() {
        const [auds, tplData] = await Promise.all([api.get('/broadcasts/audiences'), loadTemplates()]);
        const tpls = tplData.templates.filter((t) => t.kind !== 'reply'); const vars = tplData.variables;
        let audience = 'sellers';
        const radios = h('div', { class: 'audience', role: 'radiogroup', 'aria-label': 'Who should get it?' }, auds.map((a) => { const r = h('input', { type: 'radio', name: 'aud', value: a.key, checked: a.key === audience, onchange: () => { audience = a.key; } }); return h('label', null, r, h('span', null, h('span', { class: 'c' }, num(a.count)), a.label)); }));
        const email = h('input', { type: 'checkbox', checked: true }), inapp = h('input', { type: 'checkbox', checked: true });
        const title = h('input', { maxlength: 100, placeholder: 'A name only you see, e.g. November trial reminder' }), subject = h('input', { maxlength: 150, placeholder: 'Email subject / notice title' }), body = h('textarea', { rows: 7, maxlength: 4000, placeholder: 'Write your message…' });
        const pick = h('select', { 'aria-label': 'Start from a template' }, h('option', { value: '' }, 'Start from a template (optional)'), tpls.map((t) => h('option', { value: t.id }, `${KIND_INFO[t.kind][0]}: ${t.title}`)));
        const prev = h('div', null), err = h('div', { class: 'err', role: 'alert' }); const vals = sampleVars('Amina Nakato');
        const draw = () => mount(prev, previewBox(render(subject.value, vals), render(body.value, vals), email.checked));
        [subject, body].forEach((x) => x.addEventListener('input', draw)); email.addEventListener('change', draw);
        pick.addEventListener('change', () => { const t = tpls.find((x) => x.id === pick.value); if (t) { subject.value = t.subject || ''; body.value = t.body; if (!title.value) title.value = t.title; draw(); } });
        const history = h('div', null);
        async function loadHistory() { const rows = await api.get('/broadcasts'); mount(history, S.table([{ label: 'Name', render: (b) => h('div', null, h('strong', null, b.title), h('div', { class: 'muted small' }, `${date(b.createdAt)} · ${b.sentByLabel}`)) }, { label: 'Group', render: (b) => label(b.audience) }, { label: 'People', render: (b) => num(b.recipients) }, { label: 'Delivered', render: (b) => `${num(b.inAppSent)} in-app · ${num(b.emailSent)} email${b.emailFailed ? ` · ${num(b.emailFailed)} failed` : ''}` }, { label: 'Status', render: (b) => badge(b.status === 'sending' ? 'sending' : 'sent', b.status === 'sent' ? 'good' : 'warn') }], rows, { empty: 'Nothing sent yet.' })); }
        const review = h('button', { class: 'btn primary', type: 'button' }, 'Review and send');
        review.addEventListener('click', guard(async () => {
            err.textContent = '';
            const channels = [email.checked && 'email', inapp.checked && 'in_app'].filter(Boolean);
            if (!channels.length) { err.textContent = 'Choose email, in-app, or both.'; return; }
            const pv = await api.post('/broadcasts/preview', { audience });
            const who = pv.total === 1 ? '1 person' : `${num(pv.total)} people`;
            const ok = await confirmBox({ title: `Send to ${who}?`, danger: true, confirm: `Send to ${who}`,
                text: h('div', { class: 'stack' }, h('div', { class: 'explain' }, h('b', null, pv.label), `: ${who}${channels.includes('email') ? `, of whom ${num(pv.emailable)} have a verified email` : ''}. ${pv.sample.length ? `For example: ${pv.sample.join(', ')}.` : ''}`), previewBox(render(subject.value, vals), render(body.value, vals), channels.includes('email')), h('p', { class: 'muted small' }, 'This cannot be undone or recalled. You will be asked for your PIN.')),
                submit: () => api.post('/broadcasts', { audience, channels, title: title.value || subject.value, subject: subject.value, body: body.value, confirmCount: pv.total }) });
            if (ok) { toast('Broadcast is being delivered.', 'good'); loadHistory(); }
        }));
        const wrap = h('div', { class: 'stack' }, pageHead('Broadcasts', 'Send one message to a whole group: all sellers, all shoppers, or newcomers.'),
            S.intro('broadcast', 'Before you send', 'A broadcast reaches many real people at once, so take a moment.', ['Pick the smallest group that needs to hear it.', 'You see exactly who will receive it and a preview before anything is sent.', 'Only people with a verified email get the email. In-app notices reach everyone in the group.']),
            h('section', { class: 'card' }, h('h2', null, '1. Who should get it?'), radios),
            h('section', { class: 'card stack' }, h('h2', null, '2. What do you want to say?'), h('div', { class: 'row' }, h('label', { class: 'check' }, email, h('span', null, 'Email')), h('label', { class: 'check' }, inapp, h('span', null, 'In-app notification'))), pick,
                h('label', { class: 'f' }, 'Name (for your records)', title), h('label', { class: 'f' }, 'Subject', subject), h('label', { class: 'f' }, h('span', { class: 'lbl' }, 'Message', S.help('{{first_name}} becomes each person\'s own first name.', 'Variables')), body), varChips(vars, () => body), h('div', { class: 'explain' }, h('b', null, 'Preview with a sample name'), prev), err, h('div', null, review)),
            h('section', null, h('h2', { class: 'sect' }, 'Sent before'), history));
        draw(); await loadHistory(); return wrap;
    } });
})(window);
