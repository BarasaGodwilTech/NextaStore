/* ==========================================================================
   NextaStore — universal overlay positioning engine
   --------------------------------------------------------------------------
   Every floating panel in the app (account menu, notification preview, search
   previews, dashboard global search) used to be a `position:absolute` child of
   its trigger, anchored with `right:0`. That works on desktop, where the
   trigger sits near the right edge of a wide viewport, and breaks on mobile in
   two separate ways:

     1. CLIPPING. `position:absolute` is clipped by any ancestor that scrolls.
        `css/mobile.css` gives `.navbar-menu` `overflow-x:auto`, and per the
        CSS overflow spec an `auto` on one axis forces the other axis to `auto`
        too — so on index.html the dropdowns *did* open, they were just clipped
        to the ~44px tall nav strip and looked like nothing happened at all.

     2. OVERFLOW. A 380px wide panel right-anchored to a bell icon that sits in
        the middle of a 430px viewport hangs off the left edge of the screen.
        `max-width:calc(100vw - 24px)` caps the width but does nothing about
        the position, which is why "Notifications" rendered as "ications".

   This module fixes both, once, for every panel on every page, by switching
   open panels to `position:fixed` and computing coordinates from the trigger's
   own bounding box — clamped into the visual viewport with a gutter, flipped
   above the trigger when there is more room up there, and height-capped so the
   panel scrolls internally instead of running off the bottom of the screen.

   `position:fixed` also escapes every scrolling ancestor, so problem 1 goes
   away regardless of what a page's CSS does with `overflow`.

   Nothing here changes open/close behaviour. Panels keep their existing
   markup, their existing `.open` class toggles and their existing event
   listeners; the DOM is never reparented, so "click outside to close" checks
   like `menu.contains(e.target)` keep working exactly as before.
   ========================================================================== */
(function () {
    'use strict';

    if (window.NextaOverlays) return;

    var GUTTER = 10;          // breathing room from every viewport edge
    var ANCHOR_GAP = 8;       // space between trigger and panel
    var MIN_PANEL_HEIGHT = 170; // below this we prefer flipping above
    var MOBILE_MAX = 640;
    var Z_INDEX = '4000';     // above sticky headers (max used in app CSS: 2000)

    /* Registry of every floating panel in the app.
       - panel  : the element that floats
       - anchor : what it should line up with (falls back to `host`)
       - host   : the positioned wrapper, used for width matching + open state
       - align  : 'end' right-aligns to the anchor, 'start' left-aligns,
                  'stretch' matches the host's width (search previews)
       - scroll : optional child that should scroll instead of the panel */
    var REGISTRY = [
        {
            panel: '.account-menu-dropdown',
            anchor: '.account-menu-trigger',
            host: '.account-menu',
            align: 'end'
        },
        {
            panel: '.notification-preview',
            anchor: '.notification-nav',
            host: '.notification-nav-wrap',
            align: 'end',
            scroll: '.notification-preview-list'
        },
        {
            panel: '.search-preview-dropdown',
            host: '.marketplace-search, .stores-search, .store-search-wrap, .search-bar',
            align: 'stretch'
        },
        {
            // This panel is a *sibling* of the search input, not a child, so
            // the host is the bar and the anchor is looked up inside it.
            panel: '.search-results-dropdown',
            host: '.top-bar, .dashboard-search, .topbar-search',
            anchor: '.search-bar, #globalSearchBar',
            align: 'end',
            scroll: '.search-results-content'
        },
        {
            panel: '.cart-preview, .filter-menu, .menu-dropdown, [data-overlay-panel]',
            host: '[data-overlay-host]',
            align: 'end'
        }
    ];

    /* Inline properties this module owns. Cleared before each measurement so a
       panel is always measured at its natural CSS size, never at whatever size
       we squeezed it into on the previous pass. */
    var MANAGED = ['position', 'top', 'left', 'right', 'bottom', 'width',
        'maxWidth', 'maxHeight', 'margin', 'zIndex', 'overflowY'];

    function clearManaged(el) {
        for (var i = 0; i < MANAGED.length; i++) el.style[MANAGED[i]] = '';
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        // A panel hidden via an inline `display:none` (dashboard search) or by
        // its wrapper lacking `.open` reports a zero-area box.
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    /* A transformed / filtered / contained ancestor becomes the containing
       block for `position:fixed` descendants, so viewport coordinates have to
       be rebased against it. Rare in this codebase but cheap to handle, and it
       keeps the engine correct if someone later adds a CSS animation to a
       header. */
    function fixedContainingBlock(el) {
        var p = el.parentElement;
        while (p && p !== document.body && p !== document.documentElement) {
            var cs = window.getComputedStyle(p);
            var contain = cs.contain || '';
            if ((cs.transform && cs.transform !== 'none') ||
                (cs.perspective && cs.perspective !== 'none') ||
                (cs.filter && cs.filter !== 'none') ||
                (cs.backdropFilter && cs.backdropFilter !== 'none') ||
                /transform|perspective|filter/.test(cs.willChange || '') ||
                /paint|layout|strict|content/.test(contain)) {
                return p;
            }
            p = p.parentElement;
        }
        return null;
    }

    function viewport() {
        var vv = window.visualViewport;
        return {
            width: Math.round(vv ? vv.width : document.documentElement.clientWidth),
            height: Math.round(vv ? vv.height : window.innerHeight),
            offsetLeft: vv ? vv.offsetLeft : 0,
            offsetTop: vv ? vv.offsetTop : 0
        };
    }

    /* Pure geometry, split out from the DOM work so it can be reasoned about
       (and unit-tested) on its own. Takes plain rects, returns plain numbers. */
    var MIN_PANEL_WIDTH = 160;

    function computeBox(natural, anchor, host, vp, align) {
        var mobile = vp.width <= MOBILE_MAX;
        // A viewport can briefly measure as 0 mid-orientation-change, and a
        // negative width would serialise to invalid CSS that the browser drops
        // — leaving the panel at its unclamped stylesheet size, i.e. the exact
        // bug this module exists to prevent. Floor it.
        var maxWidth = Math.max(MIN_PANEL_WIDTH, vp.width - (GUTTER * 2));

        // ---- horizontal -----------------------------------------------------
        var width;
        if (mobile) {
            // On a phone a menu that spans the content column reads better than
            // a narrow card floating under one icon, and it can never overflow.
            width = maxWidth;
        } else if (align === 'stretch') {
            width = Math.min(Math.max(host.width, natural.width), maxWidth);
        } else {
            width = Math.min(natural.width, maxWidth);
        }
        width = Math.max(MIN_PANEL_WIDTH, Math.min(width, maxWidth));

        var left;
        if (mobile) {
            left = GUTTER;
        } else if (align === 'start') {
            left = anchor.left;
        } else if (align === 'stretch') {
            left = host.left;
        } else {
            left = anchor.right - width; // right-aligned, matching the CSS intent
        }
        // Clamp into the viewport. This is the line that stops "Notifications"
        // from becoming "ications".
        left = Math.min(Math.max(GUTTER, left), Math.max(GUTTER, vp.width - GUTTER - width));

        // ---- vertical -------------------------------------------------------
        var spaceBelow = vp.height - anchor.bottom - ANCHOR_GAP - GUTTER;
        var spaceAbove = anchor.top - ANCHOR_GAP - GUTTER;
        var flip = spaceBelow < Math.min(natural.height, MIN_PANEL_HEIGHT) && spaceAbove > spaceBelow;

        var top, maxHeight;
        if (flip) {
            maxHeight = Math.max(spaceAbove, MIN_PANEL_HEIGHT);
            top = Math.max(GUTTER, anchor.top - ANCHOR_GAP - Math.min(natural.height, maxHeight));
        } else {
            top = anchor.bottom + ANCHOR_GAP;
            maxHeight = Math.max(spaceBelow, MIN_PANEL_HEIGHT);
            // If the panel is taller than the room below AND that room is
            // genuinely tiny, nudge it up rather than letting it hang off.
            if (top + Math.min(natural.height, maxHeight) > vp.height - GUTTER) {
                top = Math.max(GUTTER, vp.height - GUTTER - Math.min(natural.height, maxHeight));
            }
        }

        return { left: left, top: top, width: width, maxWidth: maxWidth, maxHeight: maxHeight, flip: flip };
    }

    function place(panel, anchorEl, hostEl, align, scrollSel) {
        var vp = viewport();

        // Measure at natural size, with our own overrides stripped first.
        clearManaged(panel);
        var natural = panel.getBoundingClientRect();
        var anchor = anchorEl.getBoundingClientRect();
        var host = hostEl ? hostEl.getBoundingClientRect() : anchor;

        var box = computeBox(natural, anchor, host, vp, align);
        var left = box.left, top = box.top, width = box.width;
        var maxWidth = box.maxWidth, maxHeight = box.maxHeight, flip = box.flip;

        // Rebase if `fixed` resolves against something other than the viewport.
        var cb = fixedContainingBlock(panel);
        if (cb) {
            var cbRect = cb.getBoundingClientRect();
            left -= cbRect.left;
            top -= cbRect.top;
        } else {
            left += vp.offsetLeft;
            top += vp.offsetTop;
        }

        panel.style.position = 'fixed';
        panel.style.margin = '0';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        panel.style.width = Math.round(width) + 'px';
        panel.style.maxWidth = Math.round(maxWidth) + 'px';
        panel.style.maxHeight = Math.round(maxHeight) + 'px';
        panel.style.zIndex = Z_INDEX;

        // Scrolling: prefer an inner list so sticky headers inside the panel
        // (e.g. the notification "Mark notifications read" bar) stay put.
        var scroller = scrollSel ? panel.querySelector(scrollSel) : null;
        if (scroller) {
            var chromeHeight = panel.getBoundingClientRect().height - scroller.getBoundingClientRect().height;
            scroller.style.maxHeight = Math.max(120, Math.round(maxHeight - chromeHeight - 2)) + 'px';
            scroller.style.overflowY = 'auto';
            scroller.style.webkitOverflowScrolling = 'touch';
        } else {
            panel.style.overflowY = 'auto';
        }
        panel.style.webkitOverflowScrolling = 'touch';
        panel.setAttribute('data-overlay-placed', flip ? 'above' : 'below');
    }

    var pending = false;

    function reposition() {
        pending = false;
        for (var i = 0; i < REGISTRY.length; i++) {
            var entry = REGISTRY[i];
            var panels = document.querySelectorAll(entry.panel);
            for (var j = 0; j < panels.length; j++) {
                var panel = panels[j];
                if (!isVisible(panel)) {
                    if (panel.hasAttribute('data-overlay-placed')) {
                        clearManaged(panel);
                        panel.removeAttribute('data-overlay-placed');
                    }
                    continue;
                }
                var host = entry.host ? panel.closest(entry.host) : null;
                var anchor = (entry.anchor && (host || document).querySelector(entry.anchor)) ||
                    host || panel.parentElement;
                if (!anchor) continue;
                try {
                    place(panel, anchor, host, entry.align || 'end', entry.scroll);
                } catch (err) {
                    // Never let a positioning failure break the page — fall
                    // back to whatever the stylesheet already does.
                    clearManaged(panel);
                }
            }
        }
    }

    function schedule() {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(reposition);
    }

    /* Triggers. Class toggles are the main signal (`.open` added to a wrapper),
       but inline `style.display` changes and re-rendered account navs matter
       too, so we watch the tree broadly and coalesce into one frame. */
    function start() {
        var observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-expanded']
        });

        ['click', 'keyup', 'focusin', 'input'].forEach(function (evt) {
            document.addEventListener(evt, schedule, true);
        });
        ['resize', 'orientationchange'].forEach(function (evt) {
            window.addEventListener(evt, schedule);
        });
        window.addEventListener('scroll', schedule, true);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', schedule);
            window.visualViewport.addEventListener('scroll', schedule);
        }
        schedule();
    }

    window.NextaOverlays = {
        /** Re-measure and re-place every open overlay on the page. */
        refresh: schedule,
        /** Register an extra panel, e.g. from a page-specific script. */
        register: function (entry) {
            if (entry && entry.panel) { REGISTRY.push(entry); schedule(); }
        },
        /** Exposed for tests — pure geometry, no DOM. */
        _computeBox: computeBox
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
