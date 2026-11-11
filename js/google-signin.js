/**
 * "Continue with Google" button for login.html and signup.html.
 *
 * It asks the server (GET /auth/config) whether Google sign-in is set up and which client id to use, so the id is never typed into a page.
 * Not set up, or Google's script blocked (an ad blocker, a school network): the button area stays empty or says so, and the email form keeps working.
 * When the person approves, Google hands us a signed token; NextaAuth.googleCredential() (js/auth.js) sends it to POST /auth/google.
 *
 * Markup:  <div data-google-signin data-mode="login|signup" hidden></div>   and, around it, anything with [data-google-wrap] to show/hide together.
 */
(function () {
    'use strict';
    var slots = document.querySelectorAll('[data-google-signin]');
    if (!slots.length || typeof app === 'undefined') return;

    // Google is first on the page, so when it appears later than the form would, everything below it jumps. After the first visit we
    // remember that Google is set up here and hold its place (a soft placeholder) from the very first paint.
    var HINT = 'nextastore_google_on';
    var hinted = false; try { hinted = localStorage.getItem(HINT) === '1'; } catch (e) { /* private mode: no hint */ }
    function setHint(on) { try { if (on) localStorage.setItem(HINT, '1'); else localStorage.removeItem(HINT); } catch (e) { /* ignore */ } }
    if (hinted) { show(true); slots.forEach(function (slot) { slot.hidden = false; slot.classList.add('is-loading'); }); }

    function show(on) { document.querySelectorAll('[data-google-wrap]').forEach(function (n) { n.hidden = !on; }); }
    var G_LOGO = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';
    function setupButton(slot) {
        var signup = slot.getAttribute('data-mode') === 'signup';
        slot.hidden = false; slot.classList.remove('is-loading');
        slot.innerHTML = '<button type="button" class="auth-google-fake">' + G_LOGO + '<span>' + (signup ? 'Sign up with Google' : 'Continue with Google') + '</span></button>' +
            '<p class="auth-google-note auth-google-setup" role="status">Test mode: Google sign-in is not switched on yet. Put your Google Web client ID in <b>GOOGLE_CLIENT_ID</b> in <b>nextastore-backend/.env</b> and restart the server (steps: docs/AUTH_SETUP.md). This note and button never appear on the live site.</p>';
        var b = slot.querySelector('.auth-google-fake'), n = slot.querySelector('.auth-google-setup');
        b.addEventListener('click', function () { n.classList.add('is-flash'); setTimeout(function () { n.classList.remove('is-flash'); }, 1200); if (app.showAlert) app.showAlert('Google sign-in is not set up on this server yet. See the note under the button.', 'info'); });
    }
    function loadGoogle() {
        return new Promise(function (resolve, reject) {
            if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
            var s = document.createElement('script');
            s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
            var timer = setTimeout(function () { reject(new Error('timeout')); }, 10000);
            s.onload = function () { clearTimeout(timer); resolve(); };
            s.onerror = function () { clearTimeout(timer); reject(new Error('blocked')); };
            document.head.appendChild(s);
        });
    }

    var asked = (window.NextaAuth && window.NextaAuth.config) ? window.NextaAuth.config.then(function (d) { return { data: d }; }) : app.apiRequest('/auth/config');
    asked.then(function (res) {
        var google = res && res.data && res.data.google;
        // Not set up on a test machine (never on the live site): draw the button anyway, with a plain note on what is missing, so the layout can be checked.
        if ((!google || !google.clientId) && res && res.data && res.data.googleSetupHint) { setHint(false); show(true); slots.forEach(setupButton); return; }
        if (!google || !google.clientId) { setHint(false); show(false); slots.forEach(function (slot) { slot.hidden = true; slot.classList.remove('is-loading'); }); return; }   // not set up: nothing is shown
        setHint(true);
        show(true);
        return loadGoogle().then(function () {
            window.google.accounts.id.initialize({
                client_id: google.clientId,
                callback: function (resp) { if (window.NextaAuth && resp && resp.credential) window.NextaAuth.googleCredential(resp.credential, slots[0].getAttribute('data-mode') || 'login'); },
                auto_select: false,
                cancel_on_tap_outside: true,
                use_fedcm_for_prompt: true
            });
            slots.forEach(function (slot) {
                var width = Math.max(220, Math.min(400, Math.round(slot.getBoundingClientRect().width) || 360));
                window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', logo_alignment: 'center', width: width,
                    text: slot.getAttribute('data-mode') === 'signup' ? 'signup_with' : 'continue_with' });
                slot.hidden = false; slot.classList.remove('is-loading');
            });
        }).catch(function () {
            slots.forEach(function (slot) { slot.hidden = false; slot.classList.remove('is-loading'); slot.innerHTML = '<p class="auth-google-note">Google sign-in could not load here. You can still continue with your email.</p>'; });
        });
    }).catch(function () { /* the server could not be asked: the email form is all there is, and it still works */ });
})();
