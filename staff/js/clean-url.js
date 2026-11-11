/* Clean addresses for the Staff Console: /staff/login, never /staff/login.html. The real 301 belongs to the web server (see the backend README,
 * "Clean URLs"); this only tidies the address bar when a page is opened by its file name. Cosmetic, dependency-free, must never throw. */
(function () {
    try {
        var p = window.location.pathname;
        if (!/\.html$/i.test(p)) return;
        var clean = p.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
        window.history.replaceState(window.history.state, '', clean + window.location.search + window.location.hash);
    } catch (e) { /* cosmetic */ }
})();
