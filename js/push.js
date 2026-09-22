/* ==========================================================================
   NextaStore — Web Push subscribe/unsubscribe plumbing (package 2A)
   --------------------------------------------------------------------------
   This is the plain wiring: turn the browser's push permission into a
   PushSubscription, hand it to the server, take it back down again, and keep
   every open tab's bell in sync while a push is delivered. It deliberately
   does NOT contain the soft pre-permission prompt (with its 3-day/14-day
   snooze), the iPhone "Add to Home Screen" guidance, or the settings-page
   copy explaining consent — those are package 2B, layered on top of the
   `enable()` / `disable()` / `isSubscribed()` calls this file exposes so
   that layer never has to touch pushManager or the /api/push/* routes
   directly.

   Depends on `app` (js/main.js, loaded first) for apiRequest() and the
   notification-bell refresh it already owns, and on the service worker
   registered inline by each page (see service-worker.js for the `push`,
   `notificationclick` and `pushsubscriptionchange` handlers this pairs
   with).
   ========================================================================== */
(function () {
    'use strict';

    if (window.NextaPush) return;

    function supported() {
        return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
    }

    /* Web Push wants the VAPID public key as a raw Uint8Array, but a key
       that survives a JSON response has to be base64url text first. */
    function urlBase64ToUint8Array(base64Url) {
        const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
        const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes;
    }

    /* Every place this module hands a subscription to the server. Reused by
       enable() (a fresh subscribe) and by the pushsubscriptionchange relay
       below (the browser rotated an existing one on its own) so both paths
       send the exact same shape the backend validates against. */
    async function registerSubscription(sub) {
        const json = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
        if (!json || !json.endpoint || !json.keys) return;
        await app.apiRequest('/push/subscribe', {
            method: 'POST',
            body: JSON.stringify({
                endpoint: json.endpoint,
                keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
                userAgent: (navigator.userAgent || '').slice(0, 300)
            })
        });
    }

    const NextaPush = {
        supported,

        /** 'granted' | 'denied' | 'default' | 'unsupported'. Never triggers
         *  the browser's own permission dialog — that only happens inside
         *  enable(), and only as a direct result of a person's own click. */
        permission() {
            return supported() ? Notification.permission : 'unsupported';
        },

        /** Server-side push configuration plus, when signed in, how many of
         *  this person's devices are currently registered. Safe to call
         *  before login: /push/public-key is intentionally unauthenticated
         *  (see routes/push.js), and the device count just comes back 0. */
        async serverStatus() {
            const keyRes = await app.apiRequest('/push/public-key');
            const enabled = !!keyRes?.data?.enabled;
            const publicKey = keyRes?.data?.publicKey || null;
            if (!enabled || !app.token) return { enabled, publicKey, subscribedDevices: 0 };
            try {
                const statusRes = await app.apiRequest('/push/status');
                return { enabled, publicKey, subscribedDevices: Number(statusRes?.data?.subscribedDevices) || 0 };
            } catch (err) {
                // A logged-in person whose status check happened to fail still
                // gets an accurate enabled/publicKey answer; the device count
                // just falls back to "unknown" rather than blocking on it.
                return { enabled, publicKey, subscribedDevices: 0 };
            }
        },

        /** The browser's own PushSubscription object, or null. This is the
         *  ground truth for "is this device subscribed right now" — separate
         *  from whether the server still has a row for it (a signed-out
         *  session, a password reset, etc. can delete that row without ever
         *  touching the browser's own subscription; package 2B's
         *  re-registration flow is what reconciles the two). */
        async getSubscription() {
            if (!supported()) return null;
            try {
                const reg = await navigator.serviceWorker.ready;
                return await reg.pushManager.getSubscription();
            } catch (err) {
                return null;
            }
        },

        async isSubscribed() {
            return !!(await this.getSubscription());
        },

        /** Requests permission (only ever from a person's own click — never
         *  called on page load), subscribes this browser, and tells the
         *  server. Throws with a `.reason` of 'unsupported', 'unconfigured',
         *  or 'denied'/'default' (the two possible non-granted permission
         *  results) so a caller can show the right message without string-
         *  matching. */
        async enable() {
            if (!supported()) {
                const err = new Error('This browser doesn\u2019t support push notifications.');
                err.reason = 'unsupported';
                throw err;
            }
            const { enabled, publicKey } = await this.serverStatus();
            if (!enabled || !publicKey) {
                const err = new Error('Push notifications aren\u2019t set up on this server yet.');
                err.reason = 'unconfigured';
                throw err;
            }

            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                const err = new Error(permission === 'denied'
                    ? 'Notifications are blocked for this site. Allow them from your browser\u2019s site settings and try again.'
                    : 'Notifications weren\u2019t turned on.');
                err.reason = permission;
                throw err;
            }

            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicKey)
                });
            }
            await registerSubscription(sub);
            document.dispatchEvent(new CustomEvent('ns-push-state-changed', { detail: { subscribed: true } }));
            return sub;
        },

        /** Unsubscribes this browser and best-effort tells the server. Never
         *  throws on the server half — a device that already dropped its
         *  local subscription should still look "off" even if the network
         *  request to clean up the server-side row failed; there's nothing
         *  a caller could usefully do differently in that case. */
        async disable() {
            const sub = await this.getSubscription();
            if (!sub) {
                document.dispatchEvent(new CustomEvent('ns-push-state-changed', { detail: { subscribed: false } }));
                return;
            }
            const endpoint = sub.endpoint;
            try { await sub.unsubscribe(); } catch (err) { /* best effort */ }
            try {
                await app.apiRequest('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
            } catch (err) { /* the local unsubscribe above is what actually matters */ }
            document.dispatchEvent(new CustomEvent('ns-push-state-changed', { detail: { subscribed: false } }));
        },

        /** Settings page "Send a test" button. Surfaces the server's own
         *  message (rate limit, no device registered, not configured)
         *  rather than inventing one, since /push/test already distinguishes
         *  those cases. */
        async sendTest() {
            return app.apiRequest('/push/test', { method: 'POST' });
        },

        /** A password change bumps tokenVersion and drops every push device
         *  row this person has server-side (see PUT /user/me), so a stolen
         *  old token can't keep receiving pushes. The browser's own
         *  PushSubscription is never touched by that — only the server-side
         *  row is gone — so if this device still holds one, quietly hand it
         *  back to the server under the fresh token instead of waiting for
         *  the person to notice their notifications stopped and dig back
         *  through Settings. Called once, right after a successful password
         *  change (js/dashboard.js), with app.token already the new one.
         *  Silent either way: never requests permission, never surfaces an
         *  error — the bell and the Settings toggle already show accurate
         *  status on their own next time either one is opened. */
        async reregisterAfterCredentialChange() {
            try {
                const sub = await this.getSubscription();
                if (sub) await registerSubscription(sub);
            } catch (err) { /* best effort */ }
        },

        _init() {
            if (!('serviceWorker' in navigator)) return;
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data || {};
                if (data.type === 'ns-push-received') {
                    // A push arrived while this tab was open — nudge the bell
                    // now instead of waiting for the next poll. Best effort:
                    // a signed-out tab (no app.token) has nothing to refresh.
                    if (app && app.token && typeof app.refreshNotificationBadge === 'function') {
                        app.refreshNotificationBadge();
                    }
                } else if (data.type === 'ns-push-subscription-changed') {
                    // The browser rotated or renewed the subscription on its
                    // own (Chrome/Firefox). A null subscription means the
                    // browser lost it entirely and there's nothing to hand
                    // off; a signed-out tab can't authenticate the call
                    // either, so it's silently skipped until next sign-in.
                    if (data.subscription && app && app.token) {
                        registerSubscription(data.subscription).catch(() => {});
                    }
                }
            });
        }
    };

    window.NextaPush = NextaPush;
    NextaPush._init();
})();
