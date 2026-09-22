/* ==========================================================================
   NextaStore — soft pre-permission push prompt (package 2B)
   --------------------------------------------------------------------------
   Package 2A (js/push.js) is the plumbing: NextaPush.enable()/disable() and
   the bell's on-demand "Turn on" row. Neither one ever asks anybody to turn
   push on — a person has to go find the bell or the Settings toggle first.
   This file is the other half: a banner that shows up on its own and offers,
   in the app's own words, before the browser's native permission dialog
   ever appears. Clicking "Turn on" is what calls NextaPush.enable() and
   triggers that native dialog — this file never asks the browser for
   permission on its own, and never calls enable() except from that click.

   Three things this file owns that package 2A deliberately left out:
     1. The banner itself, with consent copy explaining what it's for, and
        a snooze that backs off from 3 days to 14 days rather than nagging
        on every page load.
     2. iPhone "Add to Home Screen" guidance: Safari only supports Web Push
        for a site installed to the home screen (iOS 16.4+), so on an iPhone
        that hasn't done that yet, NextaPush.supported() is false and the
        enable banner would have nothing to offer — this shows the one thing
        that actually helps instead.
     3. Re-registering this device's existing subscription after a password
        change, via NextaPush.reregisterAfterCredentialChange() — see
        js/push.js. That one is silent and needs no banner at all.

   Depends on `app` and `window.NextaPush` (js/main.js, js/push.js — both
   loaded first).
   ========================================================================== */
(function () {
    'use strict';

    if (window.NextaPushPrompt) return;

    var STORAGE_KEY = 'ns_push_prompt_v1';
    var SHOW_DELAY_MS = 2500;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var FIRST_SNOOZE_DAYS = 3;
    var LATER_SNOOZE_DAYS = 14;

    // ---- snooze bookkeeping ------------------------------------------------
    // Plain per-browser state, not per-person: it only ever says "don't ask
    // again for a while", never anything that would leak across accounts, so
    // it isn't part of SessionData's per-owner cleanup in js/main.js and is
    // deliberately left alone on sign-out/sign-in.
    function readState() {
        try {
            var v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            return (v && typeof v === 'object') ? v : { dismissCount: 0, snoozeUntil: 0 };
        } catch (err) {
            return { dismissCount: 0, snoozeUntil: 0 };
        }
    }

    function writeState(state) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
    }

    function isSnoozed() {
        return Date.now() < (readState().snoozeUntil || 0);
    }

    /** First dismissal backs off 3 days, every one after that backs off 14 —
     *  a person who said "not now" twice is telling us something different
     *  from a person who said it once. */
    function snooze() {
        var state = readState();
        var count = (state.dismissCount || 0) + 1;
        var days = count <= 1 ? FIRST_SNOOZE_DAYS : LATER_SNOOZE_DAYS;
        writeState({ dismissCount: count, snoozeUntil: Date.now() + days * DAY_MS });
    }

    function clearSnooze() {
        writeState({ dismissCount: 0, snoozeUntil: 0 });
    }

    // ---- iOS "Add to Home Screen" detection --------------------------------
    function isIos() {
        var ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) ||
            // iPadOS 13+ identifies itself as a Mac, distinguishable only by
            // having touch points a real Mac doesn't.
            (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    }

    function isStandalone() {
        return navigator.standalone === true ||
            (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
    }

    /** Web Push for an installed home-screen app arrived in iOS 16.4. Below
     *  that, "add to home screen" would not unlock anything, so there is
     *  nothing honest to tell someone on an older iPhone. */
    function iosVersion() {
        var m = /OS (\d+)_(\d+)/.exec(navigator.userAgent || '');
        return m ? parseFloat(m[1] + '.' + m[2]) : null;
    }

    function iosCouldSupportPushIfInstalled() {
        var v = iosVersion();
        return v !== null && v >= 16.4;
    }

    function shouldOfferIosGuidance() {
        return isIos() && !isStandalone() && iosCouldSupportPushIfInstalled() &&
            !(window.NextaPush && window.NextaPush.supported());
    }

    // ---- banner --------------------------------------------------------------
    function remove() {
        var el = document.querySelector('.push-soft-prompt');
        if (el) el.remove();
    }

    function renderEnable() {
        if (document.querySelector('.push-soft-prompt')) return;
        var el = document.createElement('div');
        el.className = 'push-soft-prompt';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML =
            '<i class="fas fa-bell push-soft-prompt-icon" aria-hidden="true"></i>' +
            '<div class="push-soft-prompt-body">' +
            '<strong>Turn on notifications?</strong>' +
            '<p>Hear about new messages, order updates and price drops \u2014 nothing else, and you can turn it off anytime in Settings.</p>' +
            '</div>' +
            '<div class="push-soft-prompt-actions">' +
            '<button type="button" class="push-soft-prompt-enable">Turn on</button>' +
            '<button type="button" class="push-soft-prompt-dismiss">Not now</button>' +
            '</div>';
        document.body.appendChild(el);

        var enableBtn = el.querySelector('.push-soft-prompt-enable');
        var dismissBtn = el.querySelector('.push-soft-prompt-dismiss');

        enableBtn.addEventListener('click', function () {
            enableBtn.disabled = true;
            enableBtn.textContent = 'Turning on\u2026';
            window.NextaPush.enable().then(function () {
                clearSnooze();
                remove();
                if (app && typeof app.showAlert === 'function') app.showAlert('Push notifications are on.', 'success');
            }, function (err) {
                remove();
                // A denied permission is the browser's own remembered choice
                // — asking again next visit would just send the person to
                // fight their own browser settings. Anything else (dismissed
                // the native dialog without choosing, a momentary server
                // hiccup) is worth trying again later.
                if (err.reason !== 'denied') snooze();
                if (app && typeof app.showAlert === 'function') {
                    app.showAlert(err.message, err.reason === 'unconfigured' ? 'warning' : 'error');
                }
            });
        });

        dismissBtn.addEventListener('click', function () {
            snooze();
            remove();
        });
    }

    function renderIosGuidance() {
        if (document.querySelector('.push-soft-prompt')) return;
        var el = document.createElement('div');
        el.className = 'push-soft-prompt push-soft-prompt-ios';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML =
            '<i class="fas fa-arrow-up-from-bracket push-soft-prompt-icon" aria-hidden="true"></i>' +
            '<div class="push-soft-prompt-body">' +
            '<strong>Get notifications on iPhone</strong>' +
            '<p>Tap <i class="fas fa-arrow-up-from-bracket" aria-hidden="true"></i> Share, then \u201cAdd to Home Screen.\u201d ' +
            'iPhone only delivers notifications to the installed app, not the browser tab.</p>' +
            '</div>' +
            '<div class="push-soft-prompt-actions">' +
            '<button type="button" class="push-soft-prompt-dismiss">Got it</button>' +
            '</div>';
        document.body.appendChild(el);
        el.querySelector('.push-soft-prompt-dismiss').addEventListener('click', function () {
            snooze();
            remove();
        });
    }

    /** Decides whether to show anything at all, and which variant. Exposed
     *  on NextaPushPrompt so tests can call it directly instead of waiting
     *  out the real SHOW_DELAY_MS timer. */
    async function maybeShow() {
        if (typeof app === 'undefined' || !app || !app.token) return; // signed-in only
        if (document.querySelector('.push-soft-prompt')) return;
        if (isSnoozed()) return;

        if (shouldOfferIosGuidance()) {
            renderIosGuidance();
            return;
        }

        if (!window.NextaPush || !window.NextaPush.supported()) return;
        if (window.NextaPush.permission() !== 'default') return; // already decided, one way or the other

        try {
            var already = await window.NextaPush.isSubscribed();
            if (already) return;
            var status = await window.NextaPush.serverStatus();
            if (!status.enabled || !status.publicKey) return;
        } catch (err) {
            return; // can't confirm it's worth asking, so say nothing rather than guess
        }

        renderEnable();
    }

    function start() {
        setTimeout(function () { maybeShow(); }, SHOW_DELAY_MS);
        // If this device gets subscribed through some other route while the
        // banner happens to be open (the bell's own "Turn on" row, another
        // tab), stop asking.
        document.addEventListener('ns-push-state-changed', function (e) {
            if (e && e.detail && e.detail.subscribed) remove();
        });
    }

    window.NextaPushPrompt = {
        _maybeShow: maybeShow,
        _isSnoozed: isSnoozed
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
