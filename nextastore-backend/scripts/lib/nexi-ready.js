'use strict';
/*
 * WIP 95: shared "stable ready state" helpers for the Nexi real-browser suites
 * (assistant-ui-browser-test.js, assistant-browser-test.js). Test-only; nothing here ships to users.
 *
 * Why: these suites used fixed sleeps (waitForTimeout) to wait for the hero to render, the starters and
 * the handoff contact to load, and for focus/scroll to settle. Under CPU load the sleeps were too short
 * and the suites flaked. Everything below waits for a STATE instead, and never retries an assertion.
 *
 *   const nexi = require('./lib/nexi-ready');
 *   await nexi.track(page);                   // BEFORE page.goto: records the widget's own API calls
 *   await page.goto(url);
 *   await nexi.waitReady(page, { starters: true, contact: 'on' });   // hero + starters + contact resolved
 *   await nexi.press(page, 'Tab');            // key press that waits for focus/scroll to settle first and after
 */

// Runs in the page before any script. Wraps fetch for the widget's assistant endpoints only, and records, per
// endpoint, how many requests are still in flight. A request counts as finished one macrotask AFTER its body
// has been read, so the widget's own .then() handlers (which run as microtasks) have already executed.
function trackerInit() {
  var st = window.__nxApi = { seen: {}, pending: {} };
  var realFetch = window.fetch;
  if (!realFetch) return;
  window.fetch = function (input) {
    var url = String(typeof input === 'string' ? input : (input && input.url) || '');
    var m = url.match(/\/assistant\/(starters|handoff-contact)(?:[?#]|$)/);
    if (!m) return realFetch.apply(this, arguments);
    var key = m[1];
    st.seen[key] = true; st.pending[key] = (st.pending[key] || 0) + 1;
    var release = function () { setTimeout(function () { st.pending[key] -= 1; }, 0); };
    return realFetch.apply(this, arguments).then(function (res) {
      ['json', 'text'].forEach(function (name) {
        var orig = res[name]; if (typeof orig !== 'function') return;
        res[name] = function () { st.pending[key] += 1; var p = orig.apply(this, arguments); p.then(release, release); return p; };
      });
      release();
      return res;
    }, function (err) { release(); throw err; });
  };
}

async function track(page) { await page.addInitScript(trackerInit); }

/**
 * Waits until the page is in a stable, interactive state:
 *  - the page's loading veil is gone and its reveal transition has finished (hero visible, so focus() works)
 *  - the hero chat (if present) is rendered with its composer and at least one starter
 *  - opts.starters: the /starters request was made, answered (any status) and its handler has run
 *  - opts.contact:  the /handoff-contact request was made and its handler has run, AND every handoff link has
 *                   left its loading state: 'on'  -> has a https://wa.me/ href; 'off' -> no href; 'any' -> either
 * opts.dock: the floating assistant dock (.nexi-dock) exists (pages without a hero chat).
 * opts.hero defaults to true when #heroChat exists.
 */
async function waitReady(page, opts) {
  opts = opts || {};
  await page.waitForFunction(function (o) {
    if (document.documentElement.classList.contains('nx-loading')) return false;
    // revealed: the loading veil is gone and no visibility/opacity transition is still running (the page's reveal is a
    // transition; while it runs, computed visibility is 'hidden' and element.focus() silently does nothing)
    if (document.getElementById('nxLoader')) return false;
    var running = document.getAnimations().some(function (an) { return typeof CSSTransition !== 'undefined' && an instanceof CSSTransition && an.playState === 'running' && /^(visibility|opacity)$/.test(an.transitionProperty); });
    if (running) return false;
    var hero = document.querySelector('#heroChat, .hero-chat');
    if (o.hero !== false && hero) {
      if (!hero.querySelector('.hero-chat-head') || !hero.querySelector('textarea')) return false;
      if (getComputedStyle(hero).visibility !== 'visible') return false;
      if (!hero.querySelector('.nexi-chip') && !hero.querySelector('.nexi-msg')) return false; // starters, or a restored conversation
    }
    if (o.dock && !document.querySelector('.nexi-dock')) return false;
    var api = window.__nxApi || { seen: {}, pending: {} };
    if (o.starters && (!api.seen.starters || api.pending.starters > 0)) return false;
    if (o.contact) {
      if (!api['seen']['handoff-contact'] || api.pending['handoff-contact'] > 0) return false;
      var links = [].slice.call(document.querySelectorAll('.nexi-handoff-link'));
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        if (a.classList.contains('is-loading')) return false;
        var href = a.getAttribute('href');
        if (o.contact === 'on' && !/^https:\/\/wa\.me\/\d+\?text=/.test(href || '')) return false;
        if (o.contact === 'off' && href) return false;
      }
    }
    return true;
  }, opts, { timeout: 20000, polling: 'raf' });
}

// In-page predicate: the starter rows are at rest (scroll position unchanged for 3 consecutive frames) and each
// row's prev/next arrows already reflect that position. The widget updates the arrows from an async 'scroll' event,
// so right after a focus change they can lag; a focused arrow that then hides drops focus to <body>.
function settledInPage() {
  return new Promise(function (resolve) {
    var rows = [].slice.call(document.querySelectorAll('.nexi-starters-row'));
    var last = null, stable = 0;
    (function frame() {
      var snap = rows.map(function (r) { return r.scrollLeft + '|' + r.scrollWidth + '|' + r.clientWidth; }).join(',') + '#' + window.scrollY;
      var consistent = rows.every(function (r) {
        var box = r.parentElement; if (!box) return true;
        var prev = box.querySelector('.nexi-starters-arrow--prev'), next = box.querySelector('.nexi-starters-arrow--next');
        if (!prev || !next) return true;
        var max = Math.max(0, r.scrollWidth - r.clientWidth);
        if (r.clientWidth === 0) return true; // not rendered (hidden panel): nothing to settle
        // both arrows hide only when the row fits; at either end the one that cannot move is dimmed (aria-disabled), not hidden
        return prev.hidden === (max <= 1) && next.hidden === (max <= 1)
          && (max <= 1 || (prev.getAttribute('aria-disabled') === String(r.scrollLeft <= 1) && next.getAttribute('aria-disabled') === String(r.scrollLeft >= max - 1)));
      });
      if (snap === last && consistent) stable += 1; else { stable = 0; last = snap; }
      if (stable >= 3) return resolve(true);
      requestAnimationFrame(frame);
    })();
  });
}

/** Resolves once focus/scroll state is at rest (see settledInPage). Rejects on timeout; there is no retry. */
async function settle(page) {
  await Promise.race([
    page.evaluate(settledInPage),
    new Promise(function (_, rej) { setTimeout(function () { rej(new Error('nexi-ready: page did not settle within 10s')); }, 10000).unref(); })
  ]);
}

/** Press a key only when the page is at rest, then wait for the effect of that key to come to rest too. */
async function press(page, key) { await settle(page); await page.keyboard.press(key); await settle(page); }

module.exports = { track, waitReady, settle, press, trackerInit };
