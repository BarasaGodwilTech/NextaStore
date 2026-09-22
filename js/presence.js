/* ==========================================================================
   NextaStore — Presence client (round 11, step 3, browser half)
   --------------------------------------------------------------------------
   Talks to routes/presence.js (see PRESENCE_BACKEND_CHANGELOG.md for the
   server side). Two jobs:

     1. ANNOUNCE: while this tab is open, visible and signed in, it holds a
        long-lived POST /api/presence/stream open. Being connected IS this
        person's own presence — nothing here is polled, nothing here has to
        ask "am I online". This runs on every signed-in page (loaded after
        js/ui-overlays.js everywhere, per qa-static.js's script-order pins),
        not just messages/store pages, so browsing the dashboard still
        counts as "online" for someone messaging you elsewhere on the site.

     2. WATCH: messages.js and store-detail.js tell this module which
        "conversation:<id>" / "store:<slug>" keys they care about
        (setWatch), and it renders the resulting online/offline state into
        any element in the page carrying data-presence-key="<key>" — a dot
        (data-presence-dot) and/or a label (data-presence-label). Because
        both of those pages rebuild their markup with innerHTML constantly,
        render() re-scans the DOM from scratch on every state change rather
        than holding element references; callers don't need to re-wire
        anything, the same way paintThreadMessages() doesn't need to re-wire
        anything either.

   Depends on `app` (js/main.js, loaded first) for apiBaseUrl and the
   session token. Exposes window.NextaPresence.
   ========================================================================== */
(function () {
    'use strict';

    if (window.NextaPresence) return;

    // ---- tunables (mirror the server's own, see src/presence.js DEFAULTS) --
    const HIDDEN_TIMEOUT_MS = 60 * 1000;      // stop streaming after this long hidden
    const MIN_RECONNECT_MS = 1000;
    const MAX_RECONNECT_MS = 30 * 1000;
    const AUTH_POLL_MS = 5000;                // catches sign-in/out with no page navigation

    // key -> { online, lastActiveAt, at }. `at` is whichever clock stamped
    // the freshest thing we've applied for that key (server time for a live
    // event/snapshot, our own Date.now() for a REST seed) — used only to
    // stop an out-of-order event from undoing a newer one, per key.
    const state = new Map();

    let desiredKeys = new Set();       // what the current page wants to watch
    let currentSignature = null;       // watch signature the active stream was opened with
    let currentController = null;      // AbortController for the in-flight fetch
    let streamHealthy = false;         // true once a snapshot has arrived on the current stream
    let stopped = false;               // true = don't auto-reconnect (signed out, 401/403, replaced)
    // The token that was live when the SERVER told us to stop (401/403,
    // end:replaced, end:session-ended). The auth poll below only restarts a
    // stopped stream for a DIFFERENT token (a fresh sign-in) — restarting for
    // the same one would re-open a stream the server just refused every 5s
    // (and, past the per-user tab cap, make tabs replace each other in turn).
    let hardStopToken = null;
    let reconnectDelay = MIN_RECONNECT_MS;
    let reconnectTimer = null;
    let hiddenTimer = null;

    function hasAuth() {
        return typeof app !== 'undefined' && !!app && !!app.token;
    }

    function keySignature() {
        return [...desiredKeys].sort().join('\u0001');
    }

    // ------------------------------------------------------------ rendering
    function formatLabel(entry) {
        if (!entry) return '';
        if (entry.online) return 'Online';
        if (!entry.lastActiveAt) return 'Offline';
        const ms = Date.now() - new Date(entry.lastActiveAt).getTime();
        if (!Number.isFinite(ms) || ms < 60 * 1000) return 'Active just now';
        if (ms < 60 * 60 * 1000) return `Active ${Math.max(1, Math.round(ms / 60000))}m ago`;
        if (ms < 24 * 60 * 60 * 1000) return `Active ${Math.max(1, Math.round(ms / 3600000))}h ago`;
        if (ms < 2 * 24 * 60 * 60 * 1000) return 'Active yesterday';
        if (ms < 7 * 24 * 60 * 60 * 1000) return `Active ${Math.round(ms / 86400000)}d ago`;
        return 'Offline';
    }

    // Re-scans the whole document rather than tracking elements: both call
    // sites (messages.js thread header, conversation rows) rebuild their
    // markup with innerHTML on basically every render, which would
    // otherwise orphan any element reference this module tried to hold on
    // to. Cheap enough to run on every event — this fires at most a few
    // times a minute per open tab.
    function render() {
        document.querySelectorAll('[data-presence-key]').forEach((el) => {
            const key = el.getAttribute('data-presence-key');
            const entry = key ? state.get(key) : null;
            if (el.hasAttribute('data-presence-dot')) {
                el.classList.toggle('is-online', !!(entry && entry.online));
                el.classList.toggle('is-offline', !!entry && !entry.online);
                el.classList.toggle('is-unknown', !entry);
            }
            if (el.hasAttribute('data-presence-label')) {
                const text = formatLabel(entry);
                if (el.textContent !== text) el.textContent = text;
            }
        });
    }
    // A relative "Active 5m ago" label goes stale on its own even with no
    // new event — refresh the text periodically so a thread left open
    // doesn't keep reading "Active just now" an hour later.
    setInterval(render, 30 * 1000);

    // Pages rebuild the markup that carries these attributes with innerHTML
    // (a thread opened, the conversation list repainted after a poll or a
    // click). The fresh dot/label has no state class or text until render()
    // runs again, and with a healthy stream nothing else would call it until
    // the next presence EVENT — minutes away, so an opened conversation
    // would show no status at all. Repaint whenever nodes carrying a
    // data-presence-key are added. render() only edits classes and (when
    // changed) label text, so it can't retrigger this in a loop.
    let renderQueued = false;
    function queueRender() {
        if (renderQueued) return;
        renderQueued = true;
        Promise.resolve().then(() => { renderQueued = false; render(); });
    }
    function carriesPresence(node) {
        return node.nodeType === 1 && (node.hasAttribute('data-presence-key') || !!node.querySelector('[data-presence-key]'));
    }
    if (typeof MutationObserver === 'function') {
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.addedNodes) { if (carriesPresence(n)) { queueRender(); return; } }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // --------------------------------------------------------- state entry
    function applySnapshot(map) {
        const at = Date.now();
        for (const [key, val] of Object.entries(map || {})) {
            if (!val) continue;
            state.set(key, { online: !!val.online, lastActiveAt: val.lastActiveAt || null, at: typeof val.at === 'number' ? val.at : at });
        }
        render();
    }

    function applyEvent(data) {
        if (!data || !data.key) return;
        const existing = state.get(data.key);
        // `at` lets an event that crossed the snapshot on the wire lose to
        // whichever one actually happened later (see routes/presence.js).
        if (existing && typeof existing.at === 'number' && typeof data.at === 'number' && data.at < existing.at) return;
        state.set(data.key, { online: !!data.online, lastActiveAt: data.lastActiveAt || null, at: typeof data.at === 'number' ? data.at : Date.now() });
        render();
    }

    // ------------------------------------------------------------- parsing
    function parseFrame(frame) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
            if (!line || line[0] === ':') continue; // ": ping" keep-alive comment
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return null;
        try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch (err) { return null; }
    }

    // ------------------------------------------------------------ the loop
    async function runStream(watchKeys) {
        const controller = new AbortController();
        currentController = controller;
        let expectedEnd = false; // 'reconnect' (max age) / 'shutdown' — not a failure, reconnect fast
        try {
            const res = await fetch(`${app.apiBaseUrl}/presence/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${app.token}`,
                    // Same reasoning as messages.js's poll: opening/holding
                    // this stream is not, itself, something the person did.
                    'X-Background-Poll': '1'
                },
                body: JSON.stringify({ watch: watchKeys }),
                signal: controller.signal
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) { stopped = true; hardStopToken = app.token || null; }
                return; // any other status: fall through to the backoff reconnect below
            }
            if (!res.body || typeof res.body.getReader !== 'function') {
                // A browser or proxy that won't stream a fetch body. REST
                // seeding (seed(), called from messages.js/store-detail.js
                // with data they fetched anyway) is the fallback; there is
                // nothing more this loop can do.
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                    const raw = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const parsed = parseFrame(raw);
                    if (!parsed) continue;
                    if (parsed.event === 'snapshot') {
                        streamHealthy = true;
                        reconnectDelay = MIN_RECONNECT_MS;
                        applySnapshot(parsed.data && parsed.data.presence);
                    } else if (parsed.event === 'presence') {
                        applyEvent(parsed.data);
                    } else if (parsed.event === 'end') {
                        const reason = parsed.data && parsed.data.reason;
                        if (reason === 'replaced' || reason === 'session-ended') { stopped = true; hardStopToken = app.token || null; }
                        else expectedEnd = true; // 'reconnect' or 'shutdown'
                    }
                }
            }
        } catch (err) {
            // Aborted by us (watch changed, page hidden, unload) or a plain
            // network drop — either way, just fall through to reconnect
            // logic below, which no-ops if `stopped` or hidden.
        } finally {
            streamHealthy = false;
            if (currentController === controller) currentController = null;
            if (!stopped && !document.hidden) {
                if (expectedEnd) { reconnectDelay = MIN_RECONNECT_MS; scheduleReconnect(true); }
                else scheduleReconnect(false);
            }
        }
    }

    function scheduleReconnect(fast) {
        clearTimeout(reconnectTimer);
        const delay = fast ? 250 : reconnectDelay;
        reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
            ensureStream();
        }, delay);
    }

    function abortCurrent() {
        if (currentController) { try { currentController.abort(); } catch (err) { /* already gone */ } currentController = null; }
        streamHealthy = false;
    }

    function closeStream() {
        abortCurrent();
        clearTimeout(reconnectTimer);
    }

    // The single decision point for "should a stream be running right now",
    // called from every trigger below (watch changes, visibility, online,
    // pageshow, the auth poll, and a stream's own natural end) instead of
    // each of them separately deciding whether to open or close one.
    function ensureStream() {
        if (!hasAuth()) { stopped = true; closeStream(); return; }
        if (document.hidden) return; // the hidden timer below handles closing; don't open while hidden
        stopped = false;
        const sig = keySignature();
        if (currentController && sig === currentSignature) return; // already streaming the right thing
        abortCurrent();
        clearTimeout(reconnectTimer);
        currentSignature = sig;
        runStream([...desiredKeys]);
    }

    // ------------------------------------------------------------- public
    function setWatch(keys) {
        desiredKeys = new Set((keys || []).filter(Boolean));
        ensureStream();
    }

    // REST payloads (conversation list, thread open/poll, the public store
    // status) carry a `{ online, lastActiveAt }` presence alongside their
    // normal data — seed the state map from them. Only applied while the
    // stream isn't up: once it is, live events are always fresher and a
    // slower REST response landing after them must not undo one.
    function seed(key, presence) {
        if (!key || !presence || streamHealthy) return;
        state.set(key, { online: !!presence.online, lastActiveAt: presence.lastActiveAt || null, at: Date.now() });
        render();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearTimeout(hiddenTimer);
            hiddenTimer = setTimeout(closeStream, HIDDEN_TIMEOUT_MS);
        } else {
            clearTimeout(hiddenTimer);
            ensureStream();
        }
    });
    window.addEventListener('pageshow', () => ensureStream());
    window.addEventListener('online', () => { reconnectDelay = MIN_RECONNECT_MS; ensureStream(); });
    window.addEventListener('beforeunload', closeStream);

    // There's no login/logout event on `app` to hook — the ordinary case
    // (this.logout(), redirectToLogin) navigates away anyway, which drops
    // the stream for free. This just catches the rarer case of a session
    // ending without a navigation (the idle-expiry watch on a page that
    // isn't data-auth-required) so a stale stream doesn't keep trying to
    // reconnect with a token that's already gone, and the reverse: a tab
    // that was open through a sign-in.
    setInterval(() => {
        if (hasAuth()) { if (stopped && app.token !== hardStopToken) ensureStream(); }
        else closeStream();
    }, AUTH_POLL_MS);

    window.NextaPresence = {
        setWatch,
        seed,
        formatLabel,
        render,
        stats: () => ({ keys: desiredKeys.size, states: state.size, streaming: !!currentController, healthy: streamHealthy, stopped })
    };

    function start() {
        if (!hasAuth()) return; // the auth-poll interval above picks up a later sign-in
        ensureStream();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
