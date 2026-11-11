// ---------------------------------------------------------------------------
// Where may a login send the person afterwards?
// ---------------------------------------------------------------------------
// /login?redirect=<page> is set by main.js when something needed a login.
// It is user-controllable input (anyone can craft a link to it), so it is never
// navigated to as-is. It must be a plain page name in THIS site (no scheme, no
// host, no path, so no `https://evil.example`, `//evil.example` or
// `javascript:...`), and:
//   * it must be a page the new person's role can actually open, and
//   * if the redirect exists because a session just ENDED, it is only honoured
//     for the same person whose session ended. Otherwise the next person to
//     sign in on a shared device was dropped onto the previous person's page.
// Keep the role list in step with the data-seller-required attributes in the HTML
// (npm run qa:static checks this). There is no admin role on the marketplace any more: staff
// use the separate Staff Console (/staff), which has its own sign-in and shares nothing with this.
const AUTH_PAGES = ['/login', '/signup', '/forgot-password', '/verify-email'];
const SELLER_ONLY_PAGES = ['/dashboard', '/product-form', '/onboarding', '/subscription'];
// Three shapes: a page in the site root (`cart.html?x=1`), a store's own
// address, which is a bare slug (`amina-crafts`, opened as /amina-crafts), or a
// product's own address, a store slug and a product part
// (`amina-crafts/blue-sofa-x7k2m9ab`). The product part is letters, digits and
// hyphens only, so none of them can carry a scheme, a host (`//evil.example`,
// `https://...`), a dot or a backslash.
const REDIRECT_PATTERN = /^[A-Za-z0-9_-]+(?:\.html)?(?:\/[A-Za-z0-9-]+)?(?:[?#][^\s\\]*)?$/;

// Why the person was sent to the login page (main.js sets ?reason=).
const SESSION_END_MESSAGES = {
    expired: 'Your session has expired. Please sign in again.',
    revoked: 'You were signed out because your password changed or your sessions were ended. Please sign in again.',
    suspended: 'This account is suspended. Please contact NextaStore support.'
};

function homeFor(user) {
    return user?.role === 'seller' ? '/dashboard' : '/marketplace';
}

/** Returns the page to open after login, or null if `raw` must be ignored. */
function safeRedirect(raw, user, reason) {
    if (!raw || !user || !REDIRECT_PATTERN.test(raw)) return null;
    // Pages have clean addresses (/dashboard, not /dashboard.html). An old link
    // that still says `.html` is accepted and held to exactly the same rules as
    // the clean one, so `redirect=dashboard` and `redirect=dashboard.html`
    // can never differ in what they allow.
    // Only the FIRST part names a page: `dashboard/anything` is held to the
    // seller rule, it never slips past it by having a second part.
    const name = raw.split(/[?#]/)[0].split('/')[0].toLowerCase().replace(/\.html$/, '');
    const page = `/${name}`;
    if (AUTH_PAGES.includes(page)) return null;
    // Anything under /staff or /admin is never a valid post-login destination here.
    if (page === '/staff' || page === '/admin' || page === '/admin-growth') return null;
    if (SELLER_ONLY_PAGES.includes(page) && user.role !== 'seller') return null;
    if (reason) {
        const ended = SessionData.readEnded();
        if (!ended || !ended.userId || ended.userId !== user.id) return null;
    }
    // Everything is opened from the site root, whichever page login is on: a
    // page (/cart?x=1) or a store's own address (/amina-crafts). A legacy
    // `.html` ending is dropped, and the home page is just `/`.
    const clean = raw.replace(/^([A-Za-z0-9_-]+)\.html(?=$|[?#\/])/i, '$1');
    return /^index(?=$|[?#])/i.test(clean) ? clean.replace(/^index/i, '/') : `/${clean}`;
}

class AuthManager {
    constructor() {
        this.init();
    }

    init() {
        // One look at /auth/config serves this file and js/google-signin.js: is Google set up, and is email working right now?
        this.config = (typeof app !== 'undefined' ? app.apiRequest('/auth/config').then((r) => (r && r.data) || null) : Promise.resolve(null)).catch(() => null);
        this.setupEventListeners();
        this.applyEmailAvailability();
        this.showSessionNotice();
        // An already-logged-in visitor landing on login.html or signup.html
        // is sent straight to where they'd end up anyway, instead of being
        // shown a form for something they've already done (and, per finding
        // 3, instead of main.js loading/polling as them on an auth page —
        // see checkAuthState's `authPage` branch). Reuses the exact same
        // safeRedirect() the real login flow uses, so a `?redirect=` on the
        // URL is honoured the same way here as it would be after actually
        // submitting the form.
        if (app.token) {
            const params = new URLSearchParams(window.location.search);
            const destination = safeRedirect(params.get('redirect'), app.user, params.get('reason')) || homeFor(app.user);
            window.location.replace(destination);
        }
    }

    /** Explains why the person is looking at the login page after a session
     *  ended (previously ?reason=expired was sent and never read). */
    showSessionNotice() {
        const notice = document.getElementById('sessionNotice');
        if (!notice) return;
        const reason = new URLSearchParams(window.location.search).get('reason');
        const message = Object.prototype.hasOwnProperty.call(SESSION_END_MESSAGES, reason) ? SESSION_END_MESSAGES[reason] : '';
        if (!message) return;
        notice.textContent = message;
        notice.hidden = false;
    }

    setupEventListeners() {
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        const signupForm = document.getElementById('signupForm');
        if (signupForm) {
            signupForm.addEventListener('submit', (e) => this.handleSignup(e));
        }

        const byId = (id) => document.getElementById(id);
        // Two steps: the email address first (Continue), then the password (login) or the name and password (sign-up).
        byId('emailForm')?.addEventListener('submit', (e) => this.handleEmailStep(e));
        document.querySelectorAll('[data-change-email]').forEach((b) => b.addEventListener('click', () => this.goToStep('email')));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.dataset.authStep === 'next') this.goToStep('email'); });
        byId('resendBtn')?.addEventListener('click', () => this.resendConfirmation());
        byId('changeEmailBtn')?.addEventListener('click', () => { this.hideCheckEmail(); const f = byId('email'); if (f) f.value = ''; this.goToStep('email'); });
        byId('googleInsteadBtn')?.addEventListener('click', () => { this.hideCheckEmail(); this.goToStep('email', { focus: false }); document.querySelector('[data-google-signin]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
        // A fresh edit clears the red "required" / "not valid" message under that field.
        byId('email')?.addEventListener('input', () => app.clearFieldError(byId('email')));
    }

    // -----------------------------------------------------------------------
    // The two steps
    // -----------------------------------------------------------------------
    /** Step 1 -> 2: check the address looks like an email, then show the password step (login) or the details step (sign-up). */
    handleEmailStep(e) {
        e.preventDefault();
        const input = document.getElementById('email');
        if (!app.validateForm(e.target)) return;
        const email = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            app.showFieldError(input, 'Enter a valid email address, like you@example.com');
            input.focus();
            return;
        }
        input.value = email;
        app.clearFieldError(input);
        this.goToStep('next');
    }

    /** Shows 'email' (step 1) or 'next' (step 2). The page reacts to `nx:authstep` to change its headline and button text. */
    goToStep(step, { focus = true } = {}) {
        const toNext = step === 'next';
        const first = document.querySelector('[data-step="email"]');
        const second = document.querySelector('[data-step="next"]');
        if (!first || !second) return;
        const email = document.getElementById('email').value.trim();
        document.querySelectorAll('[data-chip-email]').forEach((n) => { n.textContent = email; });
        document.querySelectorAll('[data-chip-avatar]').forEach((n) => { n.textContent = (email.charAt(0) || '?').toUpperCase(); });
        document.querySelectorAll('[data-forgot-link]').forEach((a) => { a.setAttribute('href', '/forgot-password' + (email ? '?email=' + encodeURIComponent(email) : '')); });
        first.hidden = toNext;
        second.hidden = !toNext;
        document.body.dataset.authStep = toNext ? 'next' : 'email';
        document.querySelectorAll('[data-auth-card]').forEach((c) => { c.dataset.authStep = toNext ? 'next' : 'email'; });
        document.getElementById('signupExists')?.setAttribute('hidden', '');
        document.dispatchEvent(new CustomEvent('nx:authstep', { detail: { step: toNext ? 'next' : 'email' } }));
        if (!focus) return;
        const target = toNext ? (second.querySelector('input:not([type="hidden"]):not([disabled])')) : document.getElementById('email');
        // A phone keyboard opening on its own would hide the page, but the person just tapped Continue, so here it is what they expect.
        if (target) setTimeout(() => target.focus({ preventScroll: false }), 30);
    }

    /** The submit button of whichever step is showing. */
    activeSubmit() {
        return document.querySelector('.auth-step:not([hidden]) button[type="submit"]') || document.querySelector('button[type="submit"]');
    }

    // -----------------------------------------------------------------------
    // "Confirm your email": what the person sees after signing up, or when they try to sign in before confirming
    // -----------------------------------------------------------------------
    /** Email is the way to confirm a password sign-up. When it is not working (no service set up, or a provider outage), say so and steer to Google. */
    async applyEmailAvailability() {
        const form = document.getElementById('signupForm');
        const notice = document.getElementById('emailDown');
        if (!form || !notice) return;                      // the login page keeps working for people who already confirmed
        const cfg = await this.config;
        if (!cfg || !cfg.email || cfg.email.available !== false) return;
        this.markEmailDown(!!(cfg.google && cfg.google.clientId));
    }

    markEmailDown(google) {
        const form = document.getElementById('signupForm');
        const notice = document.getElementById('emailDown');
        if (!form || !notice) return;
        const first = document.getElementById('emailForm');
        this.emailDown = true;
        notice.textContent = google
            ? 'Signing up with an email address is temporarily unavailable, because we cannot send confirmation emails right now. Please continue with Google, or come back in a little while.'
            : 'Signing up is temporarily unavailable, because we cannot send confirmation emails right now. Please try again in a little while.';
        notice.hidden = false;
        [first, form].filter(Boolean).forEach((f) => {
            f.classList.add('is-unavailable');
            f.querySelectorAll('input, button, select, textarea').forEach((el) => { el.disabled = true; });
        });
    }

    showCheckEmail({ email, emailSent, devLink, mode }) {
        const panel = document.getElementById('checkEmail');
        if (!panel) { app.showAlert(`Check ${email} for a confirmation link.`, 'success'); return; }
        this.pendingEmail = email;
        const intro = document.getElementById('checkEmailIntro');
        const title = document.getElementById('checkEmailTitle');
        panel.querySelector('[data-check-email]').textContent = email;
        if (emailSent === false) {
            title.textContent = 'We could not send the email';
            intro.textContent = 'Your account is saved, but the confirmation email did not go out just now. Tap the button to try again, or continue with Google.';
        } else if (mode === 'login') {
            title.textContent = 'Please confirm your email';
            intro.textContent = 'You need to confirm your address before you can sign in. We sent a link to:';
        } else {
            title.textContent = 'Check your inbox';
            intro.textContent = 'We sent a confirmation link to the address below. Open it to finish creating your account.';
        }
        this.showDevLink(devLink);
        document.getElementById('authMain').hidden = true;
        document.querySelector('.auth-header')?.classList.add('is-compact');   // the page title above would just repeat itself
        document.getElementById('sessionNotice')?.setAttribute('hidden', '');
        panel.hidden = false;
        panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this.startCooldown(emailSent === false || mode === 'login' ? 0 : 60);
        // In "login" mode nothing was just sent, so the first resend is available at once.
    }

    hideCheckEmail() {
        clearInterval(this.cooldownTimer);
        document.getElementById('checkEmail').hidden = true;
        document.getElementById('authMain').hidden = false;
        document.querySelector('.auth-header')?.classList.remove('is-compact');
    }

    showDevLink(link) {
        const box = document.getElementById('checkEmailDev');
        if (!box) return;
        box.hidden = !link;
        if (link) document.getElementById('checkEmailDevLink').setAttribute('href', link);
    }

    startCooldown(seconds) {
        const btn = document.getElementById('resendBtn');
        clearInterval(this.cooldownTimer);
        let left = Math.max(0, seconds | 0);
        const paint = () => { btn.disabled = left > 0; btn.textContent = left > 0 ? `Resend email (${left}s)` : 'Resend email'; };
        paint();
        if (left <= 0) return;
        this.cooldownTimer = setInterval(() => { left -= 1; paint(); if (left <= 0) clearInterval(this.cooldownTimer); }, 1000);
    }

    async resendConfirmation() {
        const btn = document.getElementById('resendBtn');
        if (!this.pendingEmail || btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Sending\u2026';
        try {
            const res = await app.apiRequest('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: this.pendingEmail }) });
            const d = (res && res.data) || {};
            this.showDevLink(d.devLink);
            app.showAlert(`If ${this.pendingEmail} is waiting to be confirmed, a new link is on its way.`, 'success');
            this.startCooldown(d.cooldownSeconds || 60);
        } catch (error) {
            app.showAlert(error.message, 'error');
            this.startCooldown(error.code === 'EMAIL_UNAVAILABLE' ? 0 : 10);
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        if (!app.validateForm(e.target)) return;
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        // This checkbox existed in login.html but nothing ever read it, so
        // "Remember me" was decorative: every login got the same lifetime.
        // Ticked = long session; unticked = the short, sliding one.
        const rememberMe = !!document.getElementById('rememberMe')?.checked;

        try {
            this.setLoading(true);
            const response = await app.apiRequest('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password, rememberMe })
            });

            // Decide where to go BEFORE anything below clears the record of
            // who was signed out (safeRedirect reads it). A `redirect` that
            // fails any check is ignored, not an error: the person just lands
            // on their role's home instead.
            const params = new URLSearchParams(window.location.search);
            const destination = safeRedirect(params.get('redirect'), response.user, params.get('reason')) || homeFor(response.user);

            // Ticked = keep the session in localStorage, so it survives
            // closing the browser (until the long-lived token itself
            // expires/is renewed). Unticked = sessionStorage, so the
            // session is gone the moment the tab/browser closes, even
            // though the short JWT underneath would otherwise still be
            // valid. TokenStorage.write() also clears the OTHER storage,
            // so logging in unticked on a browser that had a previous
            // remembered session doesn't leave that old copy behind.
            // User record BEFORE the token: other tabs reload when the TOKEN
            // changes, and must find the matching user record already there
            // (a reload between the two writes would see one person's token
            // beside another's record and end the session).
            TokenStorage.write('nextastore_user', JSON.stringify(response.user), rememberMe);
            TokenStorage.write('nextastore_token', response.token, rememberMe);
            app.token = response.token;
            app.user = response.user;
            app.remembered = rememberMe;
            app.shareSession();     // other open tabs pick this sign-in up (see SessionSync in main.js)
            // If a DIFFERENT person used this browser before, their cart and
            // unsent messages are cleared now (see SessionData).
            SessionData.claim(response.user.id);
            SessionData.clearEnded();

            app.showAlert(`Welcome back, ${response.user.name.split(' ')[0]}!`, 'success');
            setTimeout(() => {
                // .replace(), not .href — swaps this login.html entry out of
                // history instead of stacking the destination on top of it.
                // With .href, pressing back from the destination landed the
                // (already logged-in) person right back on the login page,
                // since it was still sitting in history one step behind.
                window.location.replace(destination);
            }, 700);
        } catch (error) {
            if (error.code === 'EMAIL_NOT_VERIFIED') { this.showCheckEmail({ email: error.email || email, mode: 'login' }); return; }
            // A wrong password is explained right under the password box (and the box gets the focus); only a network failure is a pop-up.
            const pw = document.getElementById('password');
            if (error.isNetwork || !pw) { app.showAlert(error.message, 'error'); }
            else { app.showFieldError(pw, error.message); pw.focus(); pw.select(); }
        } finally {
            this.setLoading(false);
        }
    }

    async handleSignup(e) {
        e.preventDefault();
        const form = e.target;

        // Belt-and-braces: the document-level `data-validate` listener in
        // main.js also runs validateForm() on this same submit event, but it
        // fires on the BUBBLE phase — after this handler. Left unchecked
        // here, this handler was reaching the API call before that later
        // check ever ran, so an unticked "I agree to the Terms of Service
        // and Privacy Policy" box (or any other empty required field) never
        // actually blocked account creation; the error message appeared at
        // the same moment the account was already being created. Running
        // the same validator here first closes that gap for every required
        // field on this form, not just the terms checkbox.
        if (!app.validateForm(form)) {
            const firstInvalid = form.querySelector('.input-error');
            firstInvalid?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }

        const name = document.getElementById('name').value.trim();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;

        if (password.length < 8) {
            app.showFieldError(document.getElementById('password'), 'Use a password with at least 8 characters');
            document.getElementById('password').focus();
            return;
        }

        const accountType = document.querySelector('input[name="accountType"]:checked')?.value || 'buyer';

        // NextaStore Circle / Crew: an invite code, if the person has one (from a link they opened,
        // remembered for 30 days by growth-ref.js, or typed by hand). Optional; never blocks signup.
        const referralInput = document.getElementById('referralCode');
        const typedRef = referralInput ? referralInput.value.trim() : '';
        const ref = (typeof NextaRef !== 'undefined') ? NextaRef.get() : null;
        const referral = {};
        if (typedRef) {
            referral.referralCode = typedRef.slice(0, 24);
            referral.referralVia = ref && ref.code === typedRef.toUpperCase() ? 'link' : 'code';
        }

        try {
            this.setLoading(true);
            const response = await app.apiRequest('/auth/signup', {
                method: 'POST',
                body: JSON.stringify({ name, email, password, accountType, ...referral })
            });
            try { if (typeof NextaRef !== 'undefined') NextaRef.clear(); } catch (e) { /* ignore */ }

            // The offline demo API (js/api.js) has no email step and answers with a session straight away: honour that.
            if (!response.verificationRequired && response.token && response.user) {
                TokenStorage.write('nextastore_user', JSON.stringify(response.user), false);
                TokenStorage.write('nextastore_token', response.token, false);
                app.token = response.token; app.user = response.user; app.remembered = false; app.shareSession();
                SessionData.claim(response.user.id); SessionData.clearEnded();
                setTimeout(() => window.location.replace(response.user.role === 'seller' ? '/onboarding' : '/marketplace'), 800);
                return;
            }
            // No session yet: the address has to be confirmed first (the server sends the link). Whether they chose to shop or sell is
            // kept on the account, so opening the link takes a seller straight to setting up their shop.
            this.showCheckEmail({ email: response.email || email, emailSent: response.emailSent, devLink: response.devLink, mode: 'signup' });
        } catch (error) {
            if (error.code === 'EMAIL_UNAVAILABLE') { const cfg = await this.config; this.markEmailDown(!!(cfg && cfg.google && cfg.google.clientId)); }
            const taken = document.getElementById('signupExists');
            if (taken && /already exists/i.test(error.message || '')) {
                // Say it where the person is looking, and offer the two ways out: sign in with that address, or use another one.
                const link = taken.querySelector('[data-signin-link]');
                if (link) link.setAttribute('href', '/login?email=' + encodeURIComponent(email));
                taken.hidden = false;
                taken.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                app.showAlert(error.message, 'error');
            }
        } finally {
            this.setLoading(false);
        }
    }

    /**
     * "Continue with Google": the signed token Google gave the page goes to the server, which checks it and answers like a normal login
     * ({ token, user }, plus isNew / linked). On the signup page a brand-new person must have ticked the terms first, and the
     * account type and invite code they chose are passed along (they only matter if this turns out to be a NEW account).
     */
    async googleCredential(credential, mode) {
        const isSignup = mode === 'signup';
        const accountType = document.querySelector('input[name="accountType"]:checked')?.value || (new URLSearchParams(window.location.search).get('type') === 'seller' ? 'seller' : 'buyer');
        const rememberMe = !!document.getElementById('rememberMe')?.checked;
        const referralInput = document.getElementById('referralCode');
        const typedRef = referralInput ? referralInput.value.trim() : '';
        const ref = (typeof NextaRef !== 'undefined') ? NextaRef.get() : null;
        const referral = {};
        if (typedRef) { referral.referralCode = typedRef.slice(0, 24); referral.referralVia = ref && ref.code === typedRef.toUpperCase() ? 'link' : 'code'; }
        else if (ref && ref.code) { referral.referralCode = String(ref.code).slice(0, 24); referral.referralVia = 'link'; }

        try {
            this.setLoading(true);
            const response = await app.apiRequest('/auth/google', { method: 'POST', body: JSON.stringify({ credential, accountType, rememberMe, ...referral }) });
            try { if (response.isNew && typeof NextaRef !== 'undefined') NextaRef.clear(); } catch (e) { /* ignore */ }
            const params = new URLSearchParams(window.location.search);
            const destination = safeRedirect(params.get('redirect'), response.user, params.get('reason')) || homeFor(response.user);
            // Same order and storage rules as handleLogin(): the user record before the token, and "Remember me" decides where the session lives.
            TokenStorage.write('nextastore_user', JSON.stringify(response.user), rememberMe);
            TokenStorage.write('nextastore_token', response.token, rememberMe);
            app.token = response.token; app.user = response.user; app.remembered = rememberMe; app.shareSession();
            SessionData.claim(response.user.id); SessionData.clearEnded();
            // They chose "Sell" on the sign-up page but Google matched an account that is only a buyer: open their shop now, the same way
            // "Become a seller" in the account menu does, instead of dropping a would-be seller onto the marketplace.
            if (isSignup && accountType === 'seller' && !response.isNew && response.user.role === 'buyer') {
                const upgraded = await app.apiRequest('/user/become-seller', { method: 'POST' });
                response.user = upgraded.data;
                TokenStorage.write('nextastore_user', JSON.stringify(response.user), rememberMe);
                app.user = response.user;
                app.shareSession();
                app.showAlert('Welcome back! Let\u2019s set up your store.', 'success');
                setTimeout(() => window.location.replace('/onboarding'), 800);
                return;
            }
            if (response.isNew) {
                app.showAlert(response.user.role === 'seller' ? 'Account created! Let\u2019s set up your store.' : 'Account created! Start exploring the marketplace.', 'success');
                setTimeout(() => window.location.replace(response.user.role === 'seller' ? '/onboarding' : (destination || '/marketplace')), 800);
            } else {
                app.showAlert(`Welcome back, ${response.user.name.split(' ')[0]}!`, 'success');
                setTimeout(() => window.location.replace(destination), 700);
            }
        } catch (error) {
            app.showAlert(error.message, 'error');
            this.setLoading(false);
        }
    }

    setLoading(isLoading) {
        const submitBtn = this.activeSubmit();
        if (submitBtn) {
            submitBtn.disabled = isLoading || !!this.emailDown;   // stays off while email sign-up is unavailable
            if (!submitBtn.dataset.originalText) {
                submitBtn.dataset.originalText = submitBtn.innerHTML;
            }
            submitBtn.innerHTML = isLoading ?
                '<i class="fas fa-spinner fa-spin"></i> Please wait\u2026' :
                submitBtn.dataset.originalText;
        }
    }
}

if (document.querySelector('#loginForm') || document.querySelector('#signupForm')) {
    const authManager = new AuthManager();
    window.NextaAuth = authManager;        // js/google-signin.js hands Google's token to this
}
