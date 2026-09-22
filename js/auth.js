// ---------------------------------------------------------------------------
// Where may a login send the person afterwards?
// ---------------------------------------------------------------------------
// login.html?redirect=<page> is set by main.js when something needed a login.
// It is user-controllable input (anyone can craft a link to it), so it is never
// navigated to as-is. It must be a plain page name in THIS site (no scheme, no
// host, no path, so no `https://evil.example`, `//evil.example` or
// `javascript:...`), and:
//   * it must be a page the new person's role can actually open, and
//   * if the redirect exists because a session just ENDED, it is only honoured
//     for the same person whose session ended. Otherwise the next person to
//     sign in on a shared device was dropped onto the previous person's page.
// Keep the two role lists in step with the data-seller-required /
// data-admin-required attributes in the HTML (npm run qa:static checks this).
const AUTH_PAGES = ['login.html', 'signup.html', 'forgot-password.html', 'verify-email.html'];
const SELLER_ONLY_PAGES = ['dashboard.html', 'product-form.html', 'onboarding.html', 'subscription.html'];
const ADMIN_ONLY_PAGES = ['admin.html'];
const REDIRECT_PATTERN = /^[A-Za-z0-9_-]+\.html(?:[?#][^\s\\]*)?$/;

// Why the person was sent to the login page (main.js sets ?reason=).
const SESSION_END_MESSAGES = {
    expired: 'Your session has expired. Please sign in again.',
    revoked: 'You were signed out because your password changed or your sessions were ended. Please sign in again.',
    suspended: 'This account is suspended. Please contact NextaStore support.'
};

function homeFor(user) {
    if (user?.role === 'admin') return 'admin.html';
    return user?.role === 'seller' ? 'dashboard.html' : 'marketplace.html';
}

/** Returns the page to open after login, or null if `raw` must be ignored. */
function safeRedirect(raw, user, reason) {
    if (!raw || !user || !REDIRECT_PATTERN.test(raw)) return null;
    const page = raw.split(/[?#]/)[0].toLowerCase();
    if (AUTH_PAGES.includes(page)) return null;
    if (ADMIN_ONLY_PAGES.includes(page) && user.role !== 'admin') return null;
    if (SELLER_ONLY_PAGES.includes(page) && user.role !== 'seller') return null;
    if (reason) {
        const ended = SessionData.readEnded();
        if (!ended || !ended.userId || ended.userId !== user.id) return null;
    }
    return raw;
}

class AuthManager {
    constructor() {
        this.init();
    }

    init() {
        this.setupEventListeners();
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
    }

    async handleLogin(e) {
        e.preventDefault();
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
            app.showAlert(error.message, 'error');
        } finally {
            this.setLoading(false);
        }
    }

    async handleSignup(e) {
        e.preventDefault();
        const name = document.getElementById('name').value.trim();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        if (password !== confirmPassword) {
            app.showAlert('Passwords do not match', 'error');
            return;
        }
        if (password.length < 8) {
            app.showAlert('Use a password with at least 8 characters', 'error');
            return;
        }

        const accountType = document.querySelector('input[name="accountType"]:checked')?.value || 'buyer';

        try {
            this.setLoading(true);
            const response = await app.apiRequest('/auth/signup', {
                method: 'POST',
                body: JSON.stringify({ name, email, password, accountType })
            });

            // No "Remember me" control on signup, so this matches an
            // unticked login: sessionStorage, cleared when the browser
            // closes. See handleLogin() above for why that's now the
            // deliberate behavior rather than always using localStorage.
            TokenStorage.write('nextastore_user', JSON.stringify(response.user), false);
            TokenStorage.write('nextastore_token', response.token, false);
            app.token = response.token;
            app.user = response.user;
            app.remembered = false;
            // A brand-new account must not inherit a previous person's cart
            // or unsent messages from this browser.
            SessionData.claim(response.user.id);
            SessionData.clearEnded();

            // Sellers land in the store-setup wizard; buyers go straight to
            // the marketplace — there's no store for them to build.
            if (response.user.role === 'seller') {
                app.showAlert('Account created! Let\u2019s set up your store.', 'success');
                // .replace() for the same reason as handleLogin() above —
                // signup.html shouldn't be a "back" destination once the
                // account exists and the person has moved on.
                setTimeout(() => { window.location.replace('onboarding.html'); }, 800);
            } else {
                app.showAlert('Account created! Start exploring the marketplace.', 'success');
                setTimeout(() => { window.location.replace('marketplace.html'); }, 800);
            }
        } catch (error) {
            app.showAlert(error.message, 'error');
        } finally {
            this.setLoading(false);
        }
    }

    setLoading(isLoading) {
        const submitBtn = document.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = isLoading;
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
}
