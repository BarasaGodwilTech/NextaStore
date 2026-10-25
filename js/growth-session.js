/**
 * Signs you in on circle. / crew. when you are already signed in on the main site.
 *
 * Why this exists: NextaStore keeps the sign-in token in the browser's localStorage, and localStorage is
 * private to ONE address. A person who is signed in on nextastore.com is, to the browser, a stranger on
 * circle.nextastore.com. This script hands the session over safely, once, and keeps the two in step.
 *
 * It must run BEFORE api.js / main.js, so load it as a plain blocking <script> in <head>:
 *   <script src="/js/growth-hosts.js"></script>
 *   <script src="/js/growth-session.js" data-auth="required"></script>     (data-auth="optional" on public pages)
 *
 * How the hand-over works (only between YOUR three hosts, taken from NextaHosts, never from the URL):
 *   1. no token here  ->  go to  <main>/auth-bridge?to=<this page>
 *   2. the bridge page (on the main site) reads its token and sends you back to  <this page>#nxs=<token>
 *      (a #fragment is never sent to any server). If the main site has no session it sends you to /login.
 *   3. this script stores the token, removes the #fragment from the address bar, and the page loads normally.
 *   4. after the page loads, a hidden frame asks the bridge "is this still the same session?". Signed out on
 *      the main site, or switched to another account? Then this page follows (signs out / switches).
 * Honest limit: a token in a fragment is fine for a short hop between your own hosts, but the long-term fix
 * is a session cookie scoped to .yourdomain.com. See docs/03_INTEGRATION_GUIDE.md.
 */
(function () {
    'use strict';
    var H = window.NextaHosts;
    if (window.__nxAbout) return;   // signed-out visitor heading to the about page: do not bounce them to the bridge
    if (!H || H.mode !== 'subdomain' || !H.isProgramHost) return;

    var KEYS = ['nextastore_token', 'nextastore_user', 'nextastore_remember'];
    var script = document.currentScript;
    var needsAuth = !script || script.getAttribute('data-auth') !== 'optional';
    var ls; try { ls = window.localStorage; ls.getItem('x'); } catch (e) { return; }   // storage blocked: nothing we can do here

    function b64uDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
    function tokenOk(t) {
        if (!t || typeof t !== 'string') return false;
        var parts = t.split('.'); if (parts.length !== 3) return false;
        try { var exp = JSON.parse(b64uDecode(parts[1])).exp; return !exp || exp * 1000 > Date.now() + 10000; } catch (e) { return false; }
    }
    function hash(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h.toString(16); }
    function mine() { var t = ls.getItem(KEYS[0]); return tokenOk(t) ? t : null; }
    function clearLocal() { KEYS.forEach(function (k) { try { ls.removeItem(k); } catch (e) { /* ignore */ } }); }
    function bridgeUrl() { return H.origins.main + '/auth-bridge?to=' + encodeURIComponent(location.href); }

    // 1. Coming back from the bridge: take the token and tidy the address bar.
    var badHandOver = false;
    if (location.hash.indexOf('#nxs=') === 0) {
        try {
            var d = JSON.parse(b64uDecode(location.hash.slice(5)));
            if (d && tokenOk(d.t)) {
                ls.setItem(KEYS[0], d.t);
                if (d.u) ls.setItem(KEYS[1], d.u); else ls.removeItem(KEYS[1]);
                if (d.r) ls.setItem(KEYS[2], d.r); else ls.removeItem(KEYS[2]);
            } else { badHandOver = true; }
        } catch (e) { badHandOver = true; }                   // a damaged hand-over is the same as none
        history.replaceState(null, '', location.pathname + location.search);
    }
    // One guard against an endless bounce: if the main site handed us something unusable, do not ask again in this tab.
    try { if (badHandOver) sessionStorage.setItem('nx_sso_bad', '1'); else if (mine()) sessionStorage.removeItem('nx_sso_bad'); } catch (e) { /* ignore */ }

    var token = mine();

    // 2. Nothing here: ask the main site.
    if (!token && needsAuth) {
        var refused = false; try { refused = sessionStorage.getItem('nx_sso_bad') === '1'; } catch (e) { /* ignore */ }
        if (!refused) { location.replace(bridgeUrl()); return; }
    }
    if (!token) return;

    // 3. Keep both sides honest after the page has loaded.
    window.addEventListener('load', function () {
        var frame = document.createElement('iframe');
        frame.hidden = true; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1; frame.title = 'session check';
        frame.src = H.origins.main + '/auth-bridge?mode=check&parent=' + encodeURIComponent(location.origin);
        window.addEventListener('message', function (e) {
            if (e.origin !== H.origins.main || e.source !== frame.contentWindow || !e.data || e.data.type !== 'nx-session') return;
            var now = mine();
            if (!e.data.has) {
                // Signed out on the main site. Follow, once.
                if (now && !sessionStorage.getItem('nx_sso_out')) { sessionStorage.setItem('nx_sso_out', '1'); clearLocal(); location.reload(); }
            } else if (now && e.data.sig !== hash(now)) {
                // Signed in as someone else (or renewed). Fetch the current session.
                if (!sessionStorage.getItem('nx_sso_swap')) { sessionStorage.setItem('nx_sso_swap', '1'); clearLocal(); location.replace(bridgeUrl()); }
            } else { sessionStorage.removeItem('nx_sso_out'); sessionStorage.removeItem('nx_sso_swap'); }
            frame.remove();
        });
        document.body.appendChild(frame);
    });
})();
