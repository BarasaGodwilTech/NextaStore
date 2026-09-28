/* ==========================================================================
   NextaStore — Boot Loading Overlay controller
   Pairs with css/loading-overlay.css and the #nxLoader markup at the top of
   <body>. Loaded synchronously, before any other script, so window.NextaLoader
   exists the moment main.js (and each page's manager) needs it.

   How a page uses it: #nxLoader carries data attributes that configure
   everything — no per-page inline script required.

     data-nx-theme="general|seller"   which brand palette to use
     data-nx-wait="app page"          space-separated readiness keys this
                                       page will report before content shows
     data-nx-timeout="7000"           hard safety cap in ms (see below)
     data-nx-phrases="A|B|C"          rotating status lines

   Other scripts call window.NextaLoader.ready('app') / .ready('page') once
   their part is actually done — main.js reports 'app' right after its auth
   check settles, and each page's manager (marketplace.js, dashboard.js,
   etc.) reports 'page' once its real data has been fetched and rendered.
   The overlay — and the content-hiding rule in the CSS — only lifts once
   every key a page declared has reported in.

   Nothing should ever be able to trap someone behind this forever: a hard
   timeout force-reveals the page even if something never calls ready(), and
   a "continue anyway" link appears shortly before that so people aren't
   just staring at a stuck percentage. Both are on by default and can't be
   disabled per page — a broken fetch should never be worse than a slightly
   early reveal. ---------------------------------------------------------- */
(function () {
    var el = document.getElementById('nxLoader');
    if (!el) return; // this page doesn't use the overlay — nothing to do

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var waitKeys = (el.getAttribute('data-nx-wait') || 'app').trim().split(/\s+/).filter(Boolean);
    var timeout = parseInt(el.getAttribute('data-nx-timeout'), 10);
    if (!timeout || timeout < 1500) timeout = 7000;
    var phrases = (el.getAttribute('data-nx-phrases') || '')
        .split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!phrases.length) phrases = ['Loading NextaStore'];

    var statusEl = document.getElementById('nxStatus');
    var pctEl = document.getElementById('nxPct');
    var waveEl = document.getElementById('nxWaveFill');
    var menEl = document.getElementById('nxMeniscus');
    var wrapEl = document.getElementById('nxLogoWrap');
    var pipEl = document.getElementById('nxPip');
    var skipEl = document.getElementById('nxSkip');

    var pending = {};
    waitKeys.forEach(function (k) { pending[k] = true; });

    var stopped = false;   // stops the animation loop
    var finished = false;  // finish() has run (idempotent guard)

    function remainingKeys() {
        return Object.keys(pending).filter(function (k) { return pending[k]; });
    }

    // ---- status phrase rotation ----
    var phraseTimer = null;
    if (!reduced && phrases.length > 1 && statusEl) {
        var pi = 0;
        phraseTimer = setInterval(function () {
            pi = (pi + 1) % phrases.length;
            statusEl.style.opacity = 0;
            setTimeout(function () {
                if (!statusEl) return;
                statusEl.textContent = phrases[pi];
                statusEl.style.opacity = 1;
            }, 350);
        }, 2400);
    }

    // ---- liquid-fill progress trickle (fills fast, eases, holds under
    // 100% until finish() runs) ----
    var VIEW_H = 220;
    function wavePoints(level, t) {
        var pts = [], segments = 10;
        for (var i = 0; i <= segments; i++) {
            var x = -20 + (260 / segments) * i;
            var y = level
                + (reduced ? 0 : Math.sin(x * 0.03 + t * 0.0016) * 2.0)
                + (reduced ? 0 : Math.sin(x * 0.08 + t * 0.0026) * 0.8);
            pts.push([x, y]);
        }
        return pts;
    }
    function fillPath(pts) {
        var d = 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
        for (var i = 1; i < pts.length; i++) d += ' L ' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
        var last = pts[pts.length - 1], first = pts[0];
        d += ' L ' + last[0].toFixed(1) + ',260 L ' + first[0].toFixed(1) + ',260 Z';
        return d;
    }
    function linePath(pts) {
        var d = 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
        for (var i = 1; i < pts.length; i++) d += ' L ' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
        return d;
    }

    var pct = 0;
    function tick(now) {
        if (stopped) return;
        var step = pct < 55 ? 2.4 : pct < 82 ? 0.95 : pct < 95 ? 0.15 : 0;
        pct = Math.min(95, pct + step);
        var level = VIEW_H - (pct / 100) * VIEW_H;
        var pts = wavePoints(level, now);
        if (waveEl) waveEl.setAttribute('d', fillPath(pts));
        if (menEl) menEl.setAttribute('d', linePath(pts));
        if (pctEl) pctEl.textContent = Math.round(pct) + '%';
        setTimeout(function () { requestAnimationFrame(tick); }, 45);
    }
    requestAnimationFrame(tick);

    // ---- "this is taking a while" affordance + hard safety timeout, so a
    // slow or broken API call can never trap someone on this screen ----
    var stuckTimer = setTimeout(function () {
        if (!finished && skipEl) skipEl.classList.add('is-visible');
    }, Math.max(3500, timeout - 2500));

    var hardTimer = setTimeout(function () {
        if (finished) return;
        var left = remainingKeys();
        if (left.length) console.warn('[NextaLoader] timed out after ' + timeout + 'ms waiting for: ' + left.join(', '));
        finish();
    }, timeout);

    function finish() {
        if (finished) return;
        finished = true;
        stopped = true;
        clearTimeout(stuckTimer);
        clearTimeout(hardTimer);
        if (phraseTimer) clearInterval(phraseTimer);

        var flat = wavePoints(0, 0).map(function (p) { return [p[0], 0]; });
        if (waveEl) waveEl.setAttribute('d', fillPath(flat));
        if (menEl) menEl.setAttribute('d', linePath(flat));
        if (pctEl) pctEl.textContent = '100%';
        if (wrapEl) wrapEl.classList.add('is-complete');
        if (pipEl) pipEl.classList.add('is-pop');

        var settle = reduced ? 60 : 480;
        setTimeout(function () {
            document.documentElement.classList.remove('nx-loading');
            setTimeout(function () { if (el && el.parentNode) el.remove(); }, 500);
        }, settle);
    }

    if (skipEl) skipEl.addEventListener('click', finish);

    window.NextaLoader = {
        /** Call once a required part of the page is genuinely ready — e.g.
         *  window.NextaLoader.ready('app') from main.js after the auth
         *  check settles, or .ready('page') from a page manager once its
         *  real data has loaded and rendered. Safe to call more than once,
         *  for a key this page never declared waiting on, or when the
         *  overlay has already finished — always a no-op in those cases. */
        ready: function (key) {
            key = key || 'page';
            if (Object.prototype.hasOwnProperty.call(pending, key)) pending[key] = false;
            if (!remainingKeys().length) finish();
        },
        /** Alias kept for the standalone preview pages, which call
         *  NextaLoader.finish() directly with no keys to wait on. */
        finish: finish,
        forceFinish: finish
    };

    if (!waitKeys.length) finish();
})();
