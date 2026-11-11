/**
 * WIP 114: the browser side of "Continue with Google" (js/google-signin.js + AuthManager.googleCredential in js/auth.js), NO browser.
 * Google's own script is replaced by a stand-in that records what the page asked it to draw. Does not check how anything looks.
 * Run:  node scripts/google-ui-smoke.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(e));

const el = (init = {}) => ({ classList: { add() {}, remove() {} }, hidden: false, innerHTML: '', checked: true, value: '', dataset: {}, _a: init._a || {}, getAttribute(k) { return this._a[k] ?? null; }, getBoundingClientRect: () => ({ width: 500 }), scrollIntoView() {}, ...init });

function page({ config, mode = 'login', signupTerms = true, chosenType = null, apiResult, apiByPath = null, apiError, blocked = false }) {
    const slot = el({ _a: { 'data-mode': mode }, hidden: true });
    const wrap = el({ hidden: true });
    const rendered = [], inits = [], alerts = [], stored = [], redirects = [], calls = [];
    const terms = el({ checked: signupTerms });
    const doc = {
        querySelectorAll: (s) => (s === '[data-google-signin]' ? [slot] : s === '[data-google-wrap]' ? [wrap] : []),
        querySelector: (s) => (s === '#loginForm' && mode === 'login') || (s === '#signupForm' && mode === 'signup') ? el() : (s === 'input[name="accountType"]:checked' && chosenType ? { value: chosenType } : null),
        getElementById: (id) => (id === 'agreeTerms' && mode === 'signup' ? terms : null),
        createElement: () => { const s = el(); setTimeout(() => (blocked ? s.onerror && s.onerror() : s.onload && s.onload()), 0); return s; },
        addEventListener() {}, dispatchEvent() {},
        head: { appendChild: () => {} }
    };
    const google = { accounts: { id: { initialize: (o) => inits.push(o), renderButton: (node, o) => rendered.push({ node, o }) } } };
    const app = {
        token: null, user: null, remembered: false, shareSession() {},
        apiRequest: async (p, o) => { calls.push({ p, body: o && o.body ? JSON.parse(o.body) : null }); if (p === '/auth/config') { if (config === 'down') throw new Error('offline'); return { data: { google: config } }; } if (apiByPath && apiByPath[p]) return apiByPath[p]; if (apiError) throw new Error(apiError); return apiResult; },
        showAlert: (m, t) => alerts.push([t, m]), validateForm: () => true
    };
    const win = { location: { search: mode === 'signup' && chosenType === 'seller' ? '?type=seller' : '', replace: (u) => redirects.push(u), href: '' }, ...(blocked ? {} : { google }) };
    const sandbox = { window: win, document: doc, app, console, setTimeout, clearTimeout, Promise, URLSearchParams, JSON, Math, Object, String, Number, Date, Array, Error,
        TokenStorage: { write: (k, v, persist) => stored.push([k, JSON.parse(v) ? k : k, persist]), read: () => null, clear() {} }, SessionData: { claim() {}, clearEnded() {} }, NextaRef: { get: () => null, clear() {} },
        sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null } };
    sandbox.TokenStorage.write = (k, v, persist) => stored.push([k, persist]);
    win.window = win; win.document = doc; vm.createContext(sandbox);
    const load = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
    return { sandbox, win, slot, wrap, terms, rendered, inits, alerts, stored, redirects, calls, load };
}

(async () => {
    console.log('The button');
    let p = page({ config: { clientId: 'cid-123.apps.googleusercontent.com' } }); p.load('google-signin.js'); await tick(60);
    check('with Google set up, the area is shown and Google\'s button is drawn with OUR client id (read from the server, not typed into the page)', p.wrap.hidden === false && p.inits[0] && p.inits[0].client_id === 'cid-123.apps.googleusercontent.com' && p.rendered.length === 1 && p.slot.hidden === false);
    check('the login page asks for "Continue with Google", the pill shape, and never auto-selects an account', p.rendered[0].o.text === 'continue_with' && p.rendered[0].o.shape === 'pill' && p.inits[0].auto_select === false);
    check('the button width stays inside Google\'s 400px limit', p.rendered[0].o.width <= 400 && p.rendered[0].o.width >= 200);
    p = page({ config: { clientId: 'x' }, mode: 'signup' }); p.load('google-signin.js'); await tick(60);
    check('the signup page asks for "Sign up with Google"', p.rendered[0].o.text === 'signup_with');
    p = page({ config: null }); p.load('google-signin.js'); await tick(60);
    check('Google not set up on the server: nothing is shown, nothing is loaded, the email form is untouched', p.wrap.hidden === true && p.inits.length === 0 && p.rendered.length === 0);
    p = page({ config: 'down' }); p.load('google-signin.js'); await tick(60);
    check('the server cannot be asked: same quiet result, no error shown to the person', p.wrap.hidden === true && p.alerts.length === 0 && unhandled.length === 0);
    p = page({ config: { clientId: 'x' }, blocked: true }); p.load('google-signin.js'); await tick(80);
    check('Google\'s script blocked (ad blocker, school network): a plain note says email still works', /continue with your email/.test(p.slot.innerHTML) && p.wrap.hidden === false);

    console.log('\nAfter Google answers');
    const loginOk = { token: 'jwt-1', user: { id: 'u1', name: 'Ann Mukasa', role: 'buyer', emailVerified: true }, isNew: false, linked: false };
    p = page({ config: { clientId: 'x' }, apiResult: loginOk }); p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.token.value' }); await tick(60);
    const call = p.calls.find((c) => c.p === '/auth/google');
    check('the token goes to POST /auth/google, with the account type and remember-me', call && call.body.credential === 'g.token.value' && call.body.accountType === 'buyer' && call.body.rememberMe === false);
    check('the session is stored like a normal login (user first, then token) and the app knows who is signed in', p.stored.map((s) => s[0]).join() === 'nextastore_user,nextastore_token' && p.sandbox.app.token === 'jwt-1' && p.sandbox.app.user.id === 'u1');
    await tick(800);
    check('an existing person is welcomed back and taken to where they were going', p.alerts.some((a) => /Welcome back, Ann/.test(a[1])) && p.redirects.length === 1, JSON.stringify(p.redirects));

    p = page({ config: { clientId: 'x' }, mode: 'signup', chosenType: 'seller', apiResult: { token: 't', user: { id: 'u2', name: 'Shop Owner', role: 'seller' }, isNew: true } }); p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(900);
    check('signup as a shop owner: the chosen account type is sent, and a NEW seller goes to store setup', p.calls.find((c) => c.p === '/auth/google').body.accountType === 'seller' && p.redirects[0] === '/onboarding');

    // Changed on purpose (WIP 115): there is no terms box to tick any more. Agreement is stated beside the button, so Google is one tap.
    p = page({ config: { clientId: 'x' }, mode: 'signup', apiResult: loginOk }); p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(900);
    check('signup with Google is one tap: no checkbox stands in the way, and the credential is sent', p.calls.some((c) => c.p === '/auth/google') && !p.alerts.some((a) => /agree to the Terms/.test(a[1])));

    // They chose "Sell" but Google matched an account that is only a buyer: their shop is opened and they go to store setup.
    p = page({ config: { clientId: 'x' }, mode: 'signup', chosenType: 'seller', apiByPath: { '/auth/google': { token: 't', user: { id: 'u3', name: 'Ann Mukasa', role: 'buyer' }, isNew: false, linked: false }, '/user/become-seller': { data: { id: 'u3', name: 'Ann Mukasa', role: 'seller' } } } });
    p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(1100);
    check('signup choosing Sell with an EXISTING buyer account: the shop is opened and they go to /onboarding, not the marketplace', p.calls.some((c) => c.p === '/user/become-seller') && p.redirects[0] === '/onboarding', JSON.stringify(p.redirects));
    p = page({ config: { clientId: 'x' }, mode: 'signup', apiByPath: { '/auth/google': { token: 't', user: { id: 'u3', name: 'Ann Mukasa', role: 'buyer' }, isNew: false } } });
    p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(1100);
    check('...but choosing Shop with that same account does NOT make them a seller', !p.calls.some((c) => c.p === '/user/become-seller') && p.redirects[0] === '/marketplace', JSON.stringify(p.redirects));
    p = page({ config: { clientId: 'x' }, mode: 'login', chosenType: null, apiByPath: { '/auth/google': { token: 't', user: { id: 'u3', name: 'Ann Mukasa', role: 'buyer' }, isNew: false } } });
    p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(1100);
    check('on the LOGIN page nobody is ever turned into a seller', !p.calls.some((c) => c.p === '/user/become-seller'));

    p = page({ config: { clientId: 'x' }, apiError: 'This account is suspended. Please contact NextaStore support.' }); p.load('auth.js'); p.load('google-signin.js'); await tick(60);
    p.inits[0].callback({ credential: 'g.t.v' }); await tick(60);
    check('a refusal from the server is shown as the person-readable message, and no session is stored', p.alerts.some((a) => a[0] === 'error' && /suspended/.test(a[1])) && p.stored.length === 0 && p.redirects.length === 0);
    check('no unhandled errors anywhere', unhandled.length === 0, unhandled.map((e) => e && e.stack || e).join(' | ').slice(0, 300));

    console.log('\nThe pages');
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const f of ['login.html', 'signup.html']) {
        const h = read(f);
        check(`${f}: Google block is hidden until the server says it is set up, and loads after auth.js`, /data-google-wrap hidden/.test(h) && /data-google-signin/.test(h) && h.indexOf('google-signin.js') > h.indexOf('js/auth.js'));
    }
    check('signup.html puts Google above the email form and states the agreement beside it (no box to tick first)', (() => { const h = read('signup.html'); return h.indexOf('data-google-signin') > -1 && h.indexOf('data-google-signin') < h.indexOf('id="signupForm"') && /By continuing with Google you agree to our/.test(h) && !/tick the agreement box/.test(h); })());
    const v = read('verify-email.html');
    check('verify-email: updates the saved copy of the user, offers a new link on failure, handles "already verified"', /emailVerified = true/.test(v) && /verifyResendBtn/.test(v) && /Already verified/.test(v));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
