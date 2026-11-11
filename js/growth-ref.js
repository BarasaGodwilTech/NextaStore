/**
 * NextaRef: remembers which partner sent a visitor, so the code survives until they sign up.
 * Load this on every public page of the MAIN site (and on the invite page). It does three things:
 *   1. reads ?ref=CODE (or ?c=CODE) from the URL and stores it for 30 days,
 *   2. lets the signup form prefill and send it:   NextaRef.prefill(input) / NextaRef.get()
 *   3. lets the form clear it after signup:        NextaRef.clear()
 * Latest link wins (the person in front of you at the moment of signing up is who they meant).
 *
 * Storage: localStorage AND a cookie. localStorage is private to one address, so a code picked up on
 * circle.nextastore.com would be invisible on nextastore.com. When the page is on a subdomain (or the main
 * site of a subdomain setup), the cookie is scoped to the parent domain so the signup page still sees it.
 * The invite page also passes the code in the signup link (?ref=), which is the primary route.
 * Everything is wrapped in try/catch: private mode must never break signup.
 */
(function (root) {
    'use strict';
    const KEY = 'nx_ref';
    const MAX_AGE_MS = 30 * 86400000;

    function normalize(raw) {
        const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const m = s.match(/^(CIRCLE|CREW)([A-HJKMNP-Z2-9]{5})$/);
        return m ? `${m[1]}-${m[2]}` : null;
    }
    /** The domain a cookie should be shared on, or '' to keep it on this host only (localhost, bare IPs, path mode). */
    function cookieDomain() {
        try {
            const cfg = root.NEXTA_HOSTS, h = String(root.location.hostname).toLowerCase();
            if (/^\d+(\.\d+){3}$/.test(h) || !h.includes('.')) return '';
            if (cfg && cfg.mode === 'subdomain' && cfg.main) { const m = new URL(cfg.main).hostname.toLowerCase(); return (h === m || h.endsWith(`.${m}`)) ? `.${m}` : ''; }
            const m = h.match(/^(?:circle|crew|www)\.(.+\..+)$/);
            return m ? `.${m[1]}` : '';
        } catch (err) { return ''; }
    }
    function readCookie() {
        try { const m = document.cookie.match(/(?:^|;\s*)nx_ref=([^;]+)/); return m ? JSON.parse(decodeURIComponent(m[1])) : null; } catch (err) { return null; }
    }
    function writeCookie(v) {
        try {
            const dom = cookieDomain();
            const secure = root.location.protocol === 'https:' ? '; Secure' : '';
            const body = v ? `${encodeURIComponent(JSON.stringify(v))}; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}` : '; Max-Age=0';
            document.cookie = `nx_ref=${v ? body : ''}; Path=/; SameSite=Lax${secure}${dom ? `; Domain=${dom}` : ''}`;
        } catch (err) { /* cookies blocked: carry on */ }
    }
    function valid(v) { return v && normalize(v.code) && Date.now() - v.at <= MAX_AGE_MS ? v : null; }

    function get() {
        try { const v = valid(JSON.parse(localStorage.getItem(KEY))); if (v) return v; } catch (err) { /* fall through to the cookie */ }
        return valid(readCookie());
    }
    function save(code, via) {
        const clean = normalize(code);
        if (!clean) return null;
        const rec = { code: clean, at: Date.now(), via: via || 'link' };
        try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (err) { /* storage unavailable: the cookie may still work */ }
        writeCookie(rec);
        return clean;
    }
    function clear() { try { localStorage.removeItem(KEY); } catch (err) { /* ignore */ } writeCookie(null); }
    function capture() {
        try {
            const p = new URLSearchParams(root.location.search);
            let raw = p.get('ref') || p.get('c');
            if (!raw) { const m = root.location.pathname.match(/^\/i\/([A-Za-z0-9-]{1,24})\/?$/); if (m) raw = m[1]; }   // the short link /i/CODE
            if (raw) return save(raw, 'link');
        } catch (err) { /* ignore */ }
        return null;
    }
    /** Fill a signup input with the remembered code. Returns the stored record, or null. */
    function prefill(input) {
        const v = get();
        if (v && input && !input.value) input.value = v.code;
        return v;
    }

    capture();
    root.NextaRef = { get, save, clear, prefill, normalize };
})(window);
