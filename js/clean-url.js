/*
 * Clean addresses: nextastores.com/dashboard, never /dashboard.html.
 *
 * The real 301 redirect from /page.html to /page belongs to the web server (see
 * nextastore-backend/README.md, "Clean URLs"). This is the safety net for
 * everywhere that redirect is not in place yet - local development, a static
 * host that serves files as-is, an old bookmark that gets past a cache: if a
 * page is opened as /something.html, the address bar is rewritten to
 * /something (query string and #hash kept) without reloading anything, so what
 * people see, copy and share is the clean link.
 *
 * Loaded first in the <head> of every page in the site root. It must stay
 * dependency-free and must never throw. `npm run qa:static` fails if a page is
 * added without it, which is what keeps future pages clean too.
 */
(function () {
    try {
        var path = window.location.pathname;
        if (!/\.html$/i.test(path)) return;
        // Only single-segment pages in the site root; anything nested (/errors/404.html)
        // is left alone.
        if (!/^\/[A-Za-z0-9_-]+\.html$/i.test(path)) return;
        var clean = /^\/index\.html$/i.test(path) ? '/' : path.replace(/\.html$/i, '');
        window.history.replaceState(window.history.state, '', clean + window.location.search + window.location.hash);
    } catch (e) { /* purely cosmetic */ }
})();
