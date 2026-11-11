/* Sign-in, invitation and password-reset pages.
 *   password  ->  authenticator code (or recovery code)  ->  [first time: enrol authenticator + save recovery codes]  ->  console
 * The password alone never opens a session; the server enforces that, this page just walks the person through it. */
(function () {
    'use strict';
    const { h, mount, api, icon, copyText, saveText } = window.Staff;
    const A = api;
    const view = document.getElementById('view');
    const page = document.body.dataset.page;
    const GO = './';
    let countdown = null;

    const REASONS = {
        STAFF_SESSION_IDLE: ['You were signed out after a period of inactivity.', 'warn'],
        STAFF_SESSION_EXPIRED: ['Your session reached its maximum length. Please sign in again.', 'warn'],
        STAFF_SESSION_ENDED: ['Your session ended. Please sign in again.', 'warn'],
        STAFF_INACTIVE: ['This staff account is not active.', 'bad'],
        loggedout: ['You have been signed out.', 'good']
    };
    const q = new URLSearchParams(location.search);
    const WHY = {
        first_login: ['Welcome. We will set up two-step verification now.', 'good'],
        new_device: ['We do not recognise this browser yet, so please confirm it is you with your authenticator code.', 'info'],
        suspicious: ['This sign-in looks different from usual (new network, browser or recent failed attempts), so we need your authenticator code.', 'warn'],
        privileged_role: ['Your role has the most powerful access, so it always confirms with a code.', 'info']
    };
    const rememberBox = (days) => { const cb = h('input', { type: 'checkbox', checked: true, id: 'remember' }); return { cb, el: h('label', { class: 'check', for: 'remember' }, cb, h('span', null, `Remember this browser for ${days} days. `, h('span', { class: 'muted' }, 'Untick on a shared or public computer.'))) }; };

    const errBox = () => h('div', { class: 'err', role: 'alert' });
    const field = (label, attrs, hint) => { const input = h('input', attrs); return { input, el: h('label', { class: 'f' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null) }; };
    function stopCountdown() { if (countdown) { clearInterval(countdown); countdown = null; } }
    function guard(btn, err, fn) {
        return async (e) => {
            e.preventDefault(); err.textContent = ''; btn.disabled = true;
            try { await fn(); } catch (ex) { err.textContent = ex.message || 'Something went wrong.'; if (ex.code === 'STAFF_CHALLENGE_EXPIRED') setTimeout(() => credentialsView(ex.message), 1200); }
            btn.disabled = false;
        };
    }
    const card = (title, lead, ...rest) => mount(view, h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...rest);

    // ---- shared: password field + strength hint -------------------------------------------------------------------
    function strength(pw) {
        let score = 0;
        if (pw.length >= 12) score += 40; if (pw.length >= 16) score += 20;
        if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 15; if (/\d/.test(pw)) score += 10; if (/[^A-Za-z0-9]/.test(pw)) score += 15;
        return Math.min(100, score);
    }
    function newPasswordFields() {
        const pw = field('New password', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12 }, 'At least 12 characters. A passphrase of several words works well.');
        const again = field('Confirm new password', { type: 'password', autocomplete: 'new-password', required: true });
        const bar = h('i'); const meter = h('div', { class: 'pw-meter', 'aria-hidden': 'true' }, bar);
        pw.input.addEventListener('input', () => { const s = strength(pw.input.value); bar.style.width = `${s}%`; bar.style.background = s < 50 ? 'var(--danger)' : s < 80 ? '#c78a00' : 'var(--brand)'; });
        return { pw, again, nodes: [pw.el, meter, again.el], value() { if (pw.input.value !== again.input.value) throw new Error('The two passwords do not match.'); return pw.input.value; } };
    }

    // ---- sign in ------------------------------------------------------------------------------------------------------
    function credentialsView(notice) {
        stopCountdown();
        const email = field('Work email', { type: 'email', autocomplete: 'username', required: true, autofocus: true, spellcheck: 'false' });
        const pass = field('Password', { type: 'password', autocomplete: 'current-password', required: true });
        const err = errBox(); const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Continue');
        const reason = REASONS[q.get('reason')];
        const form = h('form', { novalidate: true }, email.el, pass.el, err, btn,
            h('button', { class: 'link-btn', type: 'button', onclick: () => forgotView() }, 'Forgot your password?'));
        form.addEventListener('submit', guard(btn, err, async () => {
            if (!email.input.value.trim() || !pass.input.value) throw new Error('Enter your email and password.');
            const r = await A.post('/auth/login', { email: email.input.value.trim(), password: pass.input.value });
            pass.input.value = '';
            if (r.step === 'done') { location.replace(GO); return; }      // remembered browser, nothing unusual: the password was enough
            r.step === 'mfa_setup' ? setupView(r) : mfaView(r);
        }));
        card('Sign in to the console', 'Staff accounts only.',
            notice ? h('div', { class: 'banner warn' }, notice) : (reason ? h('div', { class: `banner ${reason[1]}` }, reason[0]) : null), form);
    }

    function startCountdown(seconds, target, onExpire) {
        stopCountdown();
        const end = Date.now() + seconds * 1000;
        const tick = () => {
            const left = Math.max(0, Math.round((end - Date.now()) / 1000));
            target.textContent = `This step expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
            if (!left) { stopCountdown(); onExpire(); }
        };
        tick(); countdown = setInterval(tick, 1000);
    }

    function mfaView(ch, useRecovery = false) {
        const input = field(useRecovery ? 'Recovery code' : 'Authenticator code',
            useRecovery ? { type: 'text', autocomplete: 'off', required: true, autofocus: true, spellcheck: 'false', placeholder: 'xxxx-xxxx-xxxx' }
                : { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, required: true, autofocus: true, class: 'code-input', placeholder: '000000' },
            useRecovery ? 'Each recovery code works once.' : 'The 6-digit code from your authenticator app.');
        const err = errBox(); const clock = h('p', { class: 'small muted' });
        const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Verify and sign in');
        const rem = rememberBox(ch.trustDays || 30); const why = WHY[ch.reason];
        const form = h('form', { novalidate: true }, why ? h('div', { class: `banner ${why[1]}` }, why[0]) : null, input.el, rem.el, err, btn, clock,
            h('button', { class: 'link-btn', type: 'button', onclick: () => mfaView(ch, !useRecovery) }, useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'),
            h('button', { class: 'link-btn', type: 'button', onclick: () => credentialsView() }, 'Start again'));
        form.addEventListener('submit', guard(btn, err, async () => {
            const v = input.input.value.replace(/\s/g, '');
            if (!v) throw new Error(useRecovery ? 'Enter a recovery code.' : 'Enter the 6-digit code.');
            await A.post('/auth/mfa/verify', { challenge: ch.challenge, trustDevice: rem.cb.checked, ...(useRecovery ? { recoveryCode: v } : { code: v }) });
            location.replace(GO);
        }));
        card(`Welcome back${ch.name ? ', ' + ch.name.split(' ')[0] : ''}`, 'Two-step verification', form);
        startCountdown(ch.expiresInSeconds || 300, clock, () => credentialsView('That sign-in timed out. Please start again.'));
    }

    // ---- MFA enrolment (first sign-in, and after an invitation) ---------------------------------------------------------
    async function setupView(ch) {
        card('Set up two-step verification', 'Staff accounts need an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).', h('div', { class: 'skel' }));
        let info;
        try { info = await A.post('/auth/mfa/setup/begin', { challenge: ch.challenge }); }
        catch (e) { return credentialsView(e.message); }
        const qr = h('div', { class: 'qrbox' });
        try { window.NextaQR.render(qr, info.otpauthUri, { scale: 5, margin: 2 }); } catch (e) { qr.textContent = 'Could not draw the QR code. Use the key below.'; }
        const grouped = String(info.secret).replace(/(.{4})/g, '$1 ').trim();
        const code = field('6-digit code from the app', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, required: true, class: 'code-input', placeholder: '000000' });
        const err = errBox(); const clock = h('p', { class: 'small muted' }); const rem = rememberBox(ch.trustDays || 30);
        const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Turn on and sign in');
        const form = h('form', { novalidate: true },
            h('ol', { class: 'small' }, h('li', null, 'Open your authenticator app and add an account.'), h('li', null, 'Scan this QR code, or type the key.'), h('li', null, 'Enter the 6-digit code it shows.')),
            qr, h('div', null, h('div', { class: 'small muted' }, 'Setup key'), h('div', { class: 'secret mono' }, grouped),
                h('button', { class: 'link-btn', type: 'button', onclick: () => copyText(info.secret) }, 'Copy key')),
            code.el, rem.el, err, btn, clock);
        form.addEventListener('submit', guard(btn, err, async () => {
            const v = code.input.value.replace(/\s/g, '');
            if (!v) throw new Error('Enter the 6-digit code.');
            const me = await A.post('/auth/mfa/setup/confirm', { challenge: ch.challenge, code: v, trustDevice: rem.cb.checked });
            recoveryView(me.recoveryCodes || []);
        }));
        card('Set up two-step verification', `Protecting ${info.account || 'your account'}.`, form);
        startCountdown(ch.expiresInSeconds || 300, clock, () => credentialsView('That setup timed out. Please sign in again to continue.'));
    }

    function recoveryView(codes) {
        stopCountdown();
        const ok = h('input', { type: 'checkbox', id: 'saved' }); const go = h('button', { class: 'btn primary block', type: 'button', disabled: true, onclick: () => location.replace(GO) }, 'Continue to the console');
        ok.addEventListener('change', () => { go.disabled = !ok.checked; });
        const text = codes.join('\n');
        card('Save your recovery codes', 'You are signed in and two-step verification is on. Next you will choose a 6-digit PIN for sensitive actions. If you lose your phone, each of these codes lets you in once. They are shown only this one time.',
            h('div', { class: 'banner warn' }, icon('alert'), h('span', null, 'Store them in a password manager or print them. Anyone who has a code and your password can sign in.')),
            h('div', { class: 'codes', 'aria-label': 'Recovery codes' }, codes.map((c) => h('span', null, c))),
            h('div', { class: 'row' },
                h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(text) }, icon('copy'), 'Copy'),
                h('button', { class: 'btn sm', type: 'button', onclick: () => saveText('nextastore-staff-recovery-codes.txt', `NextaStore Staff recovery codes\nEach code works once.\n\n${text}\n`) }, icon('download'), 'Download')),
            h('label', { class: 'check', for: 'saved' }, ok, h('span', null, 'I have saved these codes somewhere safe.')), go);
    }

    // ---- forgot password -----------------------------------------------------------------------------------------------
    function forgotView() {
        stopCountdown();
        const email = field('Work email', { type: 'email', autocomplete: 'username', required: true, autofocus: true });
        const err = errBox(); const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Email me a reset link');
        const form = h('form', { novalidate: true }, email.el, err, btn, h('button', { class: 'link-btn', type: 'button', onclick: () => credentialsView() }, 'Back to sign in'));
        form.addEventListener('submit', guard(btn, err, async () => {
            if (!email.input.value.trim()) throw new Error('Enter your work email.');
            const r = await A.post('/auth/forgot', { email: email.input.value.trim() });
            card('Check your inbox', r.message || 'If that address belongs to a staff account, a reset link is on its way.',
                h('div', { class: 'banner' }, 'The link works once and expires soon. After resetting, you will still need your authenticator code to sign in.'),
                h('button', { class: 'btn block', type: 'button', onclick: () => credentialsView() }, 'Back to sign in'));
        }));
        card('Reset your password', 'We will email a link to your work address.', form);
    }

    // ---- invitation / reset pages (token in the URL; removed from the address bar immediately) -----------------------
    function takeToken() {
        const t = q.get('token') || '';
        if (t) history.replaceState(null, '', location.pathname);
        return t;
    }
    function linkProblem(msg) {
        card('This link will not work', msg || 'It may have expired or already been used.',
            h('a', { class: 'btn block', href: 'login' }, 'Go to sign in'), h('p', { class: 'small muted' }, 'Ask a Super Admin to send a new invitation, or use "Forgot your password?" on the sign-in page.'));
    }
    async function inviteFlow() {
        const token = takeToken();
        if (!token) return linkProblem('The invitation link is incomplete.');
        let info; try { info = await A.post('/auth/link-info', { token, type: 'invite' }); } catch (e) { return linkProblem(e.message); }
        const np = newPasswordFields(); const err = errBox(); const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Set password and continue');
        const form = h('form', { novalidate: true }, ...np.nodes, err, btn);
        form.addEventListener('submit', guard(btn, err, async () => {
            const password = np.value();
            const r = await A.post('/auth/accept-invite', { token, password });
            await setupView({ ...r, expiresInSeconds: 300 });
        }));
        card(`Welcome, ${info.name}`, `You have been invited to the NextaStore Staff Console as ${info.role || 'a staff member'} (${info.email}). Choose a password, then set up your authenticator.`, form);
    }
    async function resetFlow() {
        const token = takeToken();
        if (!token) return linkProblem('The reset link is incomplete.');
        let info; try { info = await A.post('/auth/link-info', { token, type: 'password_reset' }); } catch (e) { return linkProblem(e.message); }
        const np = newPasswordFields(); const err = errBox(); const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Change password');
        const form = h('form', { novalidate: true }, ...np.nodes, err, btn);
        form.addEventListener('submit', guard(btn, err, async () => {
            const r = await A.post('/auth/reset', { token, password: np.value() });
            card('Password changed', r.message || 'Sign in with your new password and your authenticator code.',
                h('div', { class: 'banner good' }, 'All other sessions for this account were signed out.'), h('a', { class: 'btn primary block', href: 'login' }, 'Go to sign in'));
        }));
        card('Choose a new password', `For ${info.email}.`, form);
    }

    if (page === 'invite') inviteFlow(); else if (page === 'reset') resetFlow(); else credentialsView();
})();
