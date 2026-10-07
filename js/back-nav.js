/* ==========================================================================
   NextaStore — smart "Back" (js/back-nav.js)

   Back used to be hard-wired to "Back to marketplace", which is wrong most of
   the time: someone who opens a store from Favorites, a notification or the
   cart wants to return THERE. This file makes every back control behave like
   a real Back button, with a sensible fallback when there is nowhere to go.

   Markup — put this on any link that means "go back":

     <a href="/marketplace" data-back-link
        data-back-fallback="/marketplace"            (optional, default /marketplace)
        data-back-fallback-label="Back to marketplace"> (optional)
        <i class="fas fa-arrow-left"></i> <span data-back-label>Back</span>
     </a>

   Rules
     1. Arrived from another page of this site  -> history.back() (same scroll
        position, same filters, same tab). Label reads just "Back".
     2. Arrived cold (shared link, bookmark, typed URL, another website, or
        straight after signing in) -> go to the fallback. The label then names
        that fallback ("Back to store", "Back to marketplace") so the person
        knows where the arrow leads.
   The link's real href is always the fallback, so open-in-new-tab, long-press
   and middle-click still land somewhere sensible.

   Pages that render a back link later (e.g. the closed-store screen) call
   NextaBack.wire(container); pages that only learn the fallback after loading
   data (the product page learns its store) just update data-back-fallback and
   call NextaBack.refresh().
   ========================================================================== */
(function () {
    'use strict';

    // Pages that make no sense to return to: you only pass through them. Going
    // "back" to the login form right after signing in would feel broken.
    var PASS_THROUGH = [
        '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email',
        '/onboarding', '/offline', '/nextastore-loading-everyone', '/nextastore-loading-seller'
    ];

    function normalisePath(p) {
        return (p || '/').replace(/\.html$/i, '').replace(/\/+$/, '') || '/';
    }

    /** True when the page before this one is a real, worthwhile page of this site. */
    function canGoBack(referrer, currentLocation, historyLength) {
        try {
            var ref = referrer === undefined ? document.referrer : referrer;
            var loc = currentLocation || window.location;
            var len = historyLength === undefined ? window.history.length : historyLength;
            if (!ref || len < 2) return false;
            var from = new URL(ref, loc.href);
            if (from.origin !== loc.origin) return false;
            var fromPath = normalisePath(from.pathname);
            if (fromPath === normalisePath(loc.pathname) && from.search === loc.search) return false;
            if (PASS_THROUGH.indexOf(fromPath) !== -1) return false;
            if (fromPath.indexOf('/errors/') === 0) return false;
            // /p/<id> only ever redirects (to the product's own address), so it is never a page to go back to.
            if (fromPath.indexOf('/p/') === 0) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function fallbackOf(link) {
        return link.getAttribute('data-back-fallback') || '/marketplace';
    }

    function setLabel(link, text) {
        var el = link.querySelector('[data-back-label]');
        if (el) el.textContent = text;
        else if (!link.querySelector('i, svg, img')) link.textContent = text;
    }

    /** Re-read each link's state: real href, label, accessible name. */
    function refresh(root) {
        var scope = root && root.querySelectorAll ? root : document;
        var links = scope.querySelectorAll('[data-back-link]');
        var back = canGoBack();
        Array.prototype.forEach.call(links, function (link) {
            var fallback = fallbackOf(link);
            var fallbackLabel = link.getAttribute('data-back-fallback-label') || 'Back';
            link.setAttribute('href', fallback);
            setLabel(link, back ? 'Back' : fallbackLabel);
            if (back) link.setAttribute('title', 'Back to the previous page');
            else link.setAttribute('title', fallbackLabel);
            link.setAttribute('data-back-mode', back ? 'history' : 'fallback');
        });
    }

    function onClick(e) {
        var link = e.currentTarget;
        // Let ctrl/cmd/shift/middle-click open the fallback in a new tab as usual.
        if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!canGoBack()) return; // plain link to the fallback
        e.preventDefault();
        // No "did it work?" timer on purpose: on a slow mobile connection the
        // earlier page can take a second to arrive, and a timer would wrongly
        // kick the person to the fallback mid-navigation.
        window.history.back();
    }

    /** Attach to every [data-back-link] under root (idempotent). */
    function wire(root) {
        var scope = root && root.querySelectorAll ? root : document;
        Array.prototype.forEach.call(scope.querySelectorAll('[data-back-link]'), function (link) {
            if (link.__nextaBackWired) return;
            link.__nextaBackWired = true;
            link.addEventListener('click', onClick);
        });
        refresh(scope);
    }

    window.NextaBack = { wire: wire, refresh: refresh, canGoBack: canGoBack };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { wire(document); });
    else wire(document);

    // Returning via bfcache shows the page as it was; the label is still right.
})();
