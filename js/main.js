// Global Application Logic

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------
// "Remember me" is supposed to control more than the JWT's own lifetime —
// it's also supposed to decide whether the browser forgets the session when
// it's closed. Previously both a ticked and an unticked login wrote to
// localStorage, which never clears itself, so an unticked ("don't remember
// me") login still survived closing the tab/browser and looked exactly like
// a remembered one — the checkbox only changed how long the JWT lasted, not
// whether the session outlived the browser session at all.
//
// TokenStorage fixes that: a remembered session writes to localStorage
// (survives closing the browser, until the token's own TTL/renewal expires
// it); an unremembered one writes to sessionStorage (gone the moment the
// tab/browser closes, regardless of the token's TTL). `read()` checks both
// so a page reload finds whichever kind of session is active, and `write()`
// always clears the other storage so a later remembered login can't leave a
// stale copy sitting in sessionStorage (or vice versa) that read() would
// pick up by accident.
const TokenStorage = {
    read(key) {
        return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    },
    write(key, value, persist) {
        if (persist) {
            localStorage.setItem(key, value);
            sessionStorage.removeItem(key);
        } else {
            sessionStorage.setItem(key, value);
            localStorage.removeItem(key);
        }
    },
    clear(key) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    }
};

// ---------------------------------------------------------------------------
// Who does this token belong to?
// ---------------------------------------------------------------------------
// Reads the payload WITHOUT verifying the signature — only the server can do
// that, and it does on every request. This is used purely so the browser can
// notice "the session in storage is not the person I think it is" and for the
// expiry time; never to decide what somebody is allowed to do.
function decodeTokenClaims(token) {
    try {
        const part = (token || '').split('.')[1];
        if (!part) return null;
        const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        return claims && typeof claims === 'object' ? claims : null;
    } catch (err) {
        return null;
    }
}

function tokenUserId(token) {
    const id = decodeTokenClaims(token)?.userId;
    return typeof id === 'string' && id ? id : null;
}

// ---------------------------------------------------------------------------
// Per-person leftovers
// ---------------------------------------------------------------------------
// Signing out (or having a session expire) used to leave the previous
// person's cart, unsent messages and half-finished actions in the browser for
// whoever used it next. Everything user-specific that lives in storage is
// listed here, in one place, so it can be cleared in one place.
//
// The rules:
//   * Every stored item is tagged with WHO owns it (OWNER_KEY holds a user id).
//   * claim(userId) runs whenever a session starts or a page loads with a
//     session. If the stored owner is somebody else, their leftovers are wiped
//     before any page code reads them. No owner yet (a guest's cart) means the
//     data is adopted by whoever signs in, so a guest can still build a cart
//     and log in to check out.
//   * An explicit "Log out" wipes everything and forgets the owner: the person
//     asked this device to forget them.
//   * A session that ENDS ON ITS OWN (expiry, revoked, suspended) keeps the
//     cart and unsent messages so the same person can pick up where they left
//     off, but they stay tied to their owner, so they are wiped the moment a
//     different person signs in. The half-finished "pending action" is always
//     dropped: it was a one-off intent, not something to resume later.
//
// Each helper is wrapped in try/catch because storage can throw (private
// browsing, quota, disabled storage) and that must never break the page.
const SessionData = {
    OWNER_KEY: 'ns_data_owner',
    ENDED_KEY: 'ns_session_ended',          // sessionStorage: who was just signed out, and why
    CART_KEY: 'nextastore_cart_v1',
    FAILED_MESSAGES_KEY: 'ns_messages_failed_v1',
    LEGACY_NOTIFICATION_PREFS_KEY: 'nextastore_notification_prefs', // now stored per user (see dashboard.js)
    PENDING_ACTION_KEY: 'nextastore_pending_action',

    owner() {
        try { return localStorage.getItem(this.OWNER_KEY); } catch (err) { return null; }
    },

    setOwner(userId) {
        try {
            if (userId) localStorage.setItem(this.OWNER_KEY, userId);
            else localStorage.removeItem(this.OWNER_KEY);
        } catch (err) { /* ignore */ }
    },

    /** Removes the previous person's data, and refreshes the in-memory cart
     *  if cart.js has already loaded (it reads storage once, at load). */
    wipe() {
        try {
            localStorage.removeItem(this.CART_KEY);
            localStorage.removeItem(this.FAILED_MESSAGES_KEY);
            localStorage.removeItem(this.LEGACY_NOTIFICATION_PREFS_KEY);
        } catch (err) { /* ignore */ }
        this.dropPendingAction();
        try {
            if (window.NextaCart) {
                window.NextaCart.items = window.NextaCart.read();
                window.NextaCart.notify();
            }
        } catch (err) { /* the cart re-reads storage on the next page load anyway */ }
    },

    dropPendingAction() {
        try { sessionStorage.removeItem(this.PENDING_ACTION_KEY); } catch (err) { /* ignore */ }
    },

    /** This person now owns the leftovers on this device. Returns true if
     *  somebody else's were wiped to make room. */
    claim(userId) {
        if (!userId) return false;
        const previous = this.owner();
        const changed = !!previous && previous !== userId;
        if (changed) this.wipe();
        if (previous !== userId) this.setOwner(userId);
        return changed;
    },

    /** Remembers who was just signed out and why, so login.html can explain it
     *  and can tell whether the person logging back in is that same person. */
    markEnded(userId, reason) {
        try { sessionStorage.setItem(this.ENDED_KEY, JSON.stringify({ userId: userId || null, reason, at: Date.now() })); } catch (err) { /* ignore */ }
    },

    readEnded() {
        try {
            const value = JSON.parse(sessionStorage.getItem(this.ENDED_KEY) || 'null');
            return value && typeof value === 'object' ? value : null;
        } catch (err) { return null; }
    },

    clearEnded() {
        try { sessionStorage.removeItem(this.ENDED_KEY); } catch (err) { /* ignore */ }
    },

    /** In-memory copies of private data (cached message threads, the bell's
     *  notification list) must not outlive the session that fetched them —
     *  whatever ended it (log out, expiry, revocation, suspension). Guarded
     *  because this can run before `app` / the messages page exist. */
    dropMemoryCaches() {
        try { if (typeof app !== 'undefined' && app.notifications) app.notifications.reset(); } catch (err) { /* ignore */ }
        try { if (window.messagesManager && window.messagesManager.threadCache) window.messagesManager.threadCache.clear(); } catch (err) { /* ignore */ }
    },

    /** Called when a session ends. `explicit` = the person chose "Log out". */
    onSessionEnded({ explicit }) {
        this.dropPendingAction();
        this.dropMemoryCaches();
        if (explicit) {
            this.wipe();
            this.setOwner(null);
            this.clearEnded();
            try { localStorage.removeItem('ns_last_activity'); } catch (err) { /* ignore */ }
        }
    }
};

/* Client-side state behind the bell panel.
 *
 * Two notions of "unread" exist ON PURPOSE and never share state:
 *   - the bell's exterior COUNT ("something new since you last looked") —
 *     server `acknowledgedAt`; opening the bell clears it. Owned by
 *     app.applyNotificationCount / refreshNotificationBadge, NOT by this class.
 *   - each ITEM's own unread state ("you haven't dealt with this one") —
 *     server `readAt`; it only changes when that item is tapped/opened, is
 *     marked read, or "Mark all as read" is pressed. Owned here.
 *
 * What this adds on top of the server's state:
 *   - the last list is kept in memory, so re-opening the bell draws at once
 *     (dots included) and the network only revalidates;
 *   - an OVERLAY of items read locally: tapping an item marks it read on
 *     screen immediately, and it stays read on screen even if a list response
 *     that was already in flight (issued before the write landed) still says
 *     unread. That race is what used to make a dot flicker back. An overlay
 *     entry is dropped as soon as the server itself reports the item read (or
 *     reports it unread AFTER our write was confirmed — then the server wins);
 *   - a failed mark-read is retried on the next load, never silently lost.
 * In-memory only; reset() is called whenever a session ends.
 */
class NotificationStore {
    constructor(app) {
        this.app = app;
        this.items = null;            // newest 30 of ALL notifications — null before the first load
        this.loadedAt = 0;
        this.unreadItems = null;      // newest 30 UNREAD ones (server-side ?unread=1) — null until the Unread filter was first used
        this.unreadLoadedAt = 0;
        this.unreadTotal = null;      // the server's item-level unread count, from the most recent response
        this.unreadTotalStartedAt = 0; // when the request behind unreadTotal was issued
        this.overlay = new Map();     // id -> { confirmedAt: ms|null, inflight: bool } — read locally
        // Items read while the Unread filter is showing stay listed (dot gone)
        // until the filter is re-entered, so tapping one doesn't make the list
        // jump under the finger.
        this.keepVisible = new Set();
        this._inflight = { all: null, unread: null };
        this._epoch = 0;              // bumped by reset(): responses from before it are discarded
        this._settleTimer = null;
        this._markAllInFlight = false;
        this._markAllDoneAt = 0;
    }

    reset() {
        this._epoch++;
        this.items = null; this.loadedAt = 0;
        this.unreadItems = null; this.unreadLoadedAt = 0;
        this.unreadTotal = null; this.unreadTotalStartedAt = 0;
        this.overlay.clear();
        this.keepVisible.clear();
        this._inflight = { all: null, unread: null };
        this._markAllInFlight = false;
        clearTimeout(this._settleTimer);
    }

    isUnread(n) { return !!n && !n.readAt && !this.overlay.has(n.id); }

    /* The freshest copy of a notification from either list. */
    find(id) {
        const a = (this.items || []).find(n => n.id === id);
        const b = (this.unreadItems || []).find(n => n.id === id);
        if (a && b) return this.unreadLoadedAt > this.loadedAt ? b : a;
        return a || b || null;
    }

    _everyKnown() {
        const seen = new Map();
        for (const n of [...(this.items || []), ...(this.unreadItems || [])]) if (!seen.has(n.id)) seen.set(n.id, n);
        return [...seen.values()];
    }

    hasData(filter) { return filter === 'unread' ? !!(this.unreadItems || this.items) : !!this.items; }

    /* What the panel lists for a filter. "Unread" is every unread item known
       from EITHER list — the server's unread list can reach past the newest 30,
       the all-list carries anything newer that arrived since — each taken from
       whichever list has its freshest copy. So it works (and appears
       instantly) before the unread list has been fetched, and also against a
       server that predates the filter and just returned everything. */
    visible(filter) {
        if (filter !== 'unread') return this.items || [];
        return this._everyKnown()
            .map(n => this.find(n.id))
            .filter(n => this.isUnread(n) || this.keepVisible.has(n.id))
            .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))
            .slice(0, 30);
    }

    /* The number on the Unread filter. The server's total (which counts past
       the 30 loaded), less the items read on screen that the total still
       includes — i.e. reads whose write hadn't landed when the request behind
       that total was issued. (A read confirmed BEFORE it was issued is already
       out of the total; subtracting it again would undercount.) */
    unreadCountForDisplay() {
        if (this.unreadTotal === null) return this._everyKnown().filter(n => this.isUnread(n)).length;
        let pending = 0;
        for (const [id, entry] of this.overlay) {
            const n = this.find(id);
            if (n && !n.readAt && (entry.confirmedAt === null || entry.confirmedAt > this.unreadTotalStartedAt)) pending++;
        }
        return Math.max(0, this.unreadTotal - pending);
    }

    /* Changes whenever anything a visible row shows changes (content or dot). */
    signature(filter) {
        return this.visible(filter).map(n => `${n.id}|${n.createdAt}|${n.title}|${n.body || ''}|${this.isUnread(n) ? 1 : 0}`).join('~') + `#${this.unreadCountForDisplay()}`;
    }

    /* Fetches a list ('all' = the newest 30; 'unread' = the newest 30 unread).
       Concurrent callers for the same list share one request. Resolves to the
       items, or null if the session ended while it was in flight; rejects on
       a network/server error (callers decide whether that matters). */
    load(filter = 'all') {
        if (!this.app.token) return Promise.resolve(null);
        const kind = filter === 'unread' ? 'unread' : 'all';
        if (this._inflight[kind]) return this._inflight[kind];
        const epoch = this._epoch;
        const startedAt = Date.now();
        this._retryUnconfirmed();
        const request = this.app.apiRequest(kind === 'unread' ? '/notifications?unread=1' : '/notifications', { timeoutMs: 12000 })
            .then(res => {
                if (epoch !== this._epoch) return null;
                this._apply(res.data || [], startedAt, kind, res.unreadCount);
                return kind === 'unread' ? this.unreadItems : this.items;
            })
            .finally(() => { if (this._inflight[kind] === request) this._inflight[kind] = null; });
        this._inflight[kind] = request;
        return request;
    }

    _apply(items, startedAt, kind, unreadCount) {
        for (const [id, entry] of [...this.overlay]) {
            const fromServer = items.find(n => n.id === id);
            // Only an explicit answer about THIS item settles the overlay.
            // Absence proves nothing (it can simply be past the 30 returned),
            // and dropping it there would also drop a still-unsent write.
            if (fromServer && fromServer.readAt) this.overlay.delete(id);                                            // server agrees
            else if (fromServer && entry.confirmedAt && startedAt > entry.confirmedAt) this.overlay.delete(id);     // asked AFTER our write landed: server wins
        }
        const list = items.slice(0, 30);
        if (kind === 'unread') { this.unreadItems = list; this.unreadLoadedAt = Date.now(); }
        else { this.items = list; this.loadedAt = Date.now(); }
        // A response issued before a "Mark all as read" landed still carries
        // the old total — don't let it re-inflate the count.
        if (Number.isFinite(unreadCount) && !this._markAllInFlight && startedAt >= this._markAllDoneAt) { this.unreadTotal = unreadCount; this.unreadTotalStartedAt = startedAt; }
    }

    /* Marks one item read: on screen at once (overlay), on the server in the
       background. Sent with keepalive so it completes even while the page
       navigates to the notification's target. Resolves true/false; never
       rejects. */
    markRead(id) {
        const entry = { confirmedAt: null, inflight: false };
        this.overlay.set(id, entry);
        return this._putRead(id, entry);
    }

    _putRead(id, entry) {
        entry.inflight = true;
        return this.app.apiRequest(`/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT', keepalive: true })
            .then(() => { entry.confirmedAt = Date.now(); return true; })
            // Already gone on the server: nothing left to write — don't retry it forever.
            .catch(err => { if (err && err.status === 404) { entry.confirmedAt = Date.now(); return true; } return false; })
            .finally(() => { entry.inflight = false; });
    }

    _retryUnconfirmed() {
        for (const [id, entry] of this.overlay) {
            if (entry.confirmedAt === null && !entry.inflight) this._putRead(id, entry);
        }
    }

    /* "Mark all as read". The overlay (and the total) change synchronously —
       before the first await — so the caller can repaint immediately; if the
       server refuses, everything is rolled back so nothing is shown read that
       isn't. */
    async markAllRead() {
        const added = [];
        for (const n of this._everyKnown()) {
            if (this.isUnread(n)) {
                const entry = { confirmedAt: null, inflight: true };
                this.overlay.set(n.id, entry);
                added.push([n.id, entry]);
            }
        }
        const previousTotal = this.unreadTotal;
        this.unreadTotal = 0;
        this._markAllInFlight = true;
        try {
            await this.app.apiRequest('/notifications/read-all', { method: 'PUT' });
            const now = Date.now();
            for (const [, entry] of added) { entry.confirmedAt = now; entry.inflight = false; }
            this._markAllDoneAt = now;
            this._markAllInFlight = false;
            return true;
        } catch (err) {
            for (const [id] of added) this.overlay.delete(id);
            this.unreadTotal = previousTotal;
            this._markAllInFlight = false;
            return false;
        }
    }

    /* The server marks a conversation's "New message" notification read when
       that thread is opened. Mirror that here so the panel's dot goes with it
       (and re-check the bell count a moment later — the server does that
       write just after serving the thread, so an immediate count could still
       include it). */
    settleByLink(link) {
        const norm = v => String(v || '').replace(/^\//, '');
        const target = norm(link);
        let changed = false;
        for (const n of this._everyKnown()) {
            if (this.isUnread(n) && norm(n.link) === target) {
                this.overlay.set(n.id, { confirmedAt: Date.now(), inflight: false });
                changed = true;
            }
        }
        if (changed) this.app.syncNotificationDots();
        clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(() => this.app.refreshNotificationBadge(), 1200);
        return changed;
    }
}

class NextaStoreApp {
    constructor() {
        this.notifications = new NotificationStore(this);
        this.notificationFilter = 'all';   // the bell panel's filter: 'all' | 'unread' (reset to 'all' every time the panel opens)
        // Resolves the real NextaStore API automatically:
        //  - a page can override it explicitly with
        //    <meta name="nextastore-api-base" content="https://api.yourdomain.com/api">
        //  - running the frontend from localhost assumes the backend is also
        //    local, on the default dev port
        //  - anything else (a real deployment) assumes the API lives at
        //    /api on the same origin the frontend was served from — the
        //    common setup when the backend also serves the static frontend,
        //    or sits behind the same reverse proxy. If your API is on a
        //    different origin, add the <meta> tag above instead of editing
        //    this file per deployment.
        const metaOverride = document.querySelector('meta[name="nextastore-api-base"]')?.content;
        const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        this.apiBaseUrl = metaOverride || (isLocalHost ? 'http://localhost:4000/api' : `${window.location.origin}/api`);

        // The in-browser MockAPI (js/api.js) is a local-development-only
        // stand-in for the real backend — useful for working on the UI
        // without Postgres running. It is OFF by default now that the real
        // API exists; opt in per-browser-tab with ?mock=1 in the URL (it's
        // never turned on automatically, and never in production, so a
        // real outage can't silently start showing fake data instead of an
        // error).
        this.useMockAPI = new URLSearchParams(window.location.search).get('mock') === '1';
        this.token = TokenStorage.read('nextastore_token');
        this.user = JSON.parse(TokenStorage.read('nextastore_user') || 'null');
        // Which storage this session actually lives in, decided once at
        // login (see auth.js) and carried forward from here: a session
        // found in localStorage was a remembered one, so every later write
        // (renewed token, refreshed user data) goes back to localStorage
        // too; one found only in sessionStorage (or no session at all)
        // keeps behaving like an unremembered one.
        this.remembered = !!localStorage.getItem('nextastore_token');
        this.store = null;
        this.storeLoadFailed = false;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupAuthAwareLinks();
        this.setupCrossTabSync();
        this.checkAuthState();
        // Fired by js/push.js after enable()/disable(), and by the settings
        // page's own toggle — either way, every bell's "Turn on" row on this
        // page should reflect the new state right away rather than on its
        // next open.
        document.addEventListener('ns-push-state-changed', () => this.refreshAllPushBellRows());
        requestAnimationFrame(() => requestAnimationFrame(() => this.dismissPageSkeleton()));
    }

    /** Finding 2: a "Remember me" session lives in localStorage, which is
     *  shared by every tab/window on this browser. Without this, a tab left
     *  open from before somebody else signed in (or before the same person
     *  signed out) just kept running as whoever it thought was logged in —
     *  nothing ever told it the ground had shifted. The `storage` event is
     *  the browser's own notification that ANOTHER tab changed localStorage;
     *  it deliberately never fires for the tab that made the change, or for
     *  sessionStorage at all (which is already per-tab, so it can't be
     *  stale this way). Reloading is simpler and safer than trying to patch
     *  a live page's auth-gated content, cached role, and open polls in
     *  place to match a session it didn't ask for. */
    setupCrossTabSync() {
        window.addEventListener('storage', (e) => {
            if (e.key !== 'nextastore_token' && e.key !== 'nextastore_user') return;
            const stored = localStorage.getItem('nextastore_token');
            if (stored === this.token) return;
            // Step 4 fix: the SAME person's token being swapped for a newer
            // one is just routine renewal happening in another tab (the
            // server hands out a fresh token every so often). Reloading for
            // that threw away whatever was on screen here - an unsent
            // message, a half-filled form - for no reason. Adopt it quietly.
            // Anything else (signed out, or a different person) still reloads.
            // Only for a session that already lives in localStorage; a
            // per-tab (unremembered) session must not be silently moved.
            if (stored && this.token && this.remembered && tokenUserId(stored) === tokenUserId(this.token)) {
                this.token = stored;
                return;
            }
            window.location.reload();
        });
    }

    dismissPageSkeleton() {
        const skeleton = document.querySelector('[data-page-skeleton]');
        if (!skeleton) return;
        skeleton.classList.add('is-hidden');
        setTimeout(() => skeleton.remove(), 220);
    }

    setupEventListeners() {
        // Global form validation
        document.addEventListener('submit', (e) => {
            const form = e.target;
            if (form.hasAttribute('data-validate')) {
                if (!this.validateForm(form)) {
                    e.preventDefault();
                }
            }
        });

        // Close alerts on click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('alert-close')) {
                e.target.closest('.alert')?.remove();
            }
        });
    }

    setupAuthAwareLinks() {
        const links = document.querySelectorAll('[data-auth-aware-link]');
        if (!links.length) return;
        const destination = () => this.user?.role === 'seller' ? 'dashboard.html' : 'marketplace.html';
        links.forEach(link => {
            link.addEventListener('click', e => {
                if (!this.token) return;
                e.preventDefault();
                window.location.href = destination();
            });
        });
    }

    checkAuthState() {
        const authRequired = document.body.hasAttribute('data-auth-required');
        const authPage = document.body.hasAttribute('data-auth-page');

        // A token whose own `exp` has already passed can never succeed, so
        // drop it here rather than letting the page start loading and then
        // yank the user out mid-render.
        let endedReason = null;
        if (this.token && this.isTokenExpired()) {
            this.endSession('expired');
            endedReason = 'expired';
        } else if (this.token) {
            const claimedId = tokenUserId(this.token);
            // The token and the cached `nextastore_user` record must agree
            // on who is signed in. They can briefly disagree mid-write
            // during the stale-tab race finding 2 describes — a renewed
            // token for A lands in storage a tick before/after B's login
            // overwrites nextastore_user, or a slow response finishes after
            // a newer login started. Trust neither half when that happens;
            // end the session rather than risk this page quietly acting as
            // the wrong person until something else notices.
            if (claimedId && this.user && this.user.id !== claimedId) {
                console.warn('[NextaStore auth] Token/user mismatch in storage; ending session.');
                this.endSession('expired');
                endedReason = 'expired';
            } else if (claimedId) {
                // Before any page script reads the cart or unsent messages:
                // if they belong to somebody other than this session's
                // owner, they are cleared now (see SessionData).
                SessionData.claim(claimedId);
            }
        }

        if (authRequired && !this.token) {
            this.redirectToLogin(endedReason);
            return;
        }

        // Finding 3: login/signup/forgot-password/verify-email must never
        // load or act as whoever was previously signed in on this device —
        // these pages are for someone who is (from this page's point of
        // view) NOT authenticated yet. auth.js separately sends an
        // ALREADY-logged-in visitor away from login.html/signup.html instead
        // of showing them the form at all.
        if (authPage) return;

        if (this.token) {
            // Cached role first, for an instant redirect before the network
            // round-trip in loadUserData() resolves — a buyer landing on a
            // seller-only page shouldn't get a flash of dashboard content
            // while we wait on the API.
            this.enforceSellerOnlyPage();
            this.loadUserData();
            this.startSessionExpiryWatch();
        }
    }

    /** Bounces a buyer account off any page marked data-seller-required
     *  (dashboard, product-form, onboarding). Re-checked
     *  after loadUserData() refreshes this.user, in case the cached copy
     *  is stale (e.g. the role changed on another device). */
    enforceSellerOnlyPage() {
        const adminOnly = document.body.hasAttribute('data-admin-required');
        if (adminOnly && this.user && this.user.role !== 'admin') {
            window.location.href = 'marketplace.html';
            return;
        }
        if (adminOnly && !this.user && !this.token) return;
        const sellerOnly = document.body.hasAttribute('data-seller-required');
        if (sellerOnly && this.user && this.user.role !== 'seller') {
            window.location.href = 'marketplace.html';
        }
    }

    validateForm(form) {
        let isValid = true;
        const requiredFields = form.querySelectorAll('[required]');

        requiredFields.forEach(field => {
            const empty = (field.type === 'checkbox' || field.type === 'radio')
                ? !field.checked
                : !field.value.trim();
            if (empty) {
                isValid = false;
                this.showFieldError(field, field.type === 'checkbox' ? 'You need to agree to continue' : 'This field is required');
            } else {
                this.clearFieldError(field);
            }
        });

        return isValid;
    }

    showFieldError(field, message) {
        const errorElement = field.closest('.form-group')?.querySelector('.form-error');
        if (errorElement) {
            errorElement.textContent = message;
        }
        field.classList.add('input-error');
    }

    clearFieldError(field) {
        const errorElement = field.closest('.form-group')?.querySelector('.form-error');
        if (errorElement) {
            errorElement.textContent = '';
        }
        field.classList.remove('input-error');
    }

    async loadUserData() {
        // Step 4 fix: this awaits the network and then WRITES the cached user
        // record. If the session changed while it was in flight (another tab
        // signed somebody else in), the old person's record used to land in
        // storage next to the new person's token, and the next page load's
        // token/user mismatch check then ended the new person's valid
        // session. Compare by PERSON, not by token string: a renewal can
        // legitimately swap this.token during the very request below.
        const startedAs = tokenUserId(this.token);
        const stillTheSameSession = () => !!startedAs
            && tokenUserId(this.token) === startedAs
            && tokenUserId(TokenStorage.read('nextastore_token')) === startedAs;
        try {
            // First try to load from storage (immediate display)
            const storedUser = TokenStorage.read('nextastore_user');
            if (storedUser) {
                this.user = JSON.parse(storedUser);
                this.updateUI();
            }
            
            // Then refresh from API for latest data
            const response = await this.apiRequest('/user/me');
            if (!stillTheSameSession()) return;
            this.user = response.data;
            TokenStorage.write('nextastore_user', JSON.stringify(this.user), this.remembered);
            if (this.user?.role === 'seller') {
                try {
                    const storeResponse = await this.apiRequest('/store');
                    if (!stillTheSameSession()) return;
                    this.store = storeResponse.data || null;
                    this.storeLoadFailed = false;
                } catch (storeError) {
                    // The account shell must still render if the store endpoint
                    // is temporarily unavailable; never block the whole page.
                    this.storeLoadFailed = true;
                    console.warn('Could not refresh seller badge state:', storeError);
                }
            } else {
                this.store = null;
            }
            this.updateUI();
            this.enforceSellerOnlyPage();
            this.startUnreadBadgePolling();
        } catch (error) {
            console.error('Failed to load user data:', error);
            // Fall back to stored copy if API fails
            const storedUser = TokenStorage.read('nextastore_user');
            if (storedUser) {
                this.user = JSON.parse(storedUser);
                this.updateUI();
            }
        }
    }

    /** Gate for buyer actions that require login (saving/wishlisting,
     *  messaging a seller, viewing order history —
     *  checkout is handled separately). Redirects to login with a
     *  `?redirect=` back to the current page (so login.html/auth.js can
     *  return the shopper here afterward) and returns false; returns true
     *  if already logged in so the caller can proceed inline.
     *
     *  `pendingAction`, if given, is stashed in sessionStorage so the page
     *  can re-fire the exact action (not just reload the page) once the
     *  shopper is back — see consumePendingAction(). */
    requireLogin(promptMessage, pendingAction) {
        if (this.token) return true;
        if (pendingAction) sessionStorage.setItem(SessionData.PENDING_ACTION_KEY, JSON.stringify(pendingAction));
        if (promptMessage) this.showAlert(promptMessage, 'warning');
        this.redirectToLogin();
        return false;
    }

    /** Sends the browser to login.html, with `?redirect=` pointing back at
     *  the current page. `reason` is only set when a session that existed a
     *  moment ago just ended ('expired' | 'revoked' | 'suspended'); login.html
     *  uses it to explain what happened and (via SessionData.readEnded) to
     *  hand the page back only to the SAME person, never to whoever happens
     *  to sign in next. */
    redirectToLogin(reason = null) {
        const here = window.location.pathname.split('/').pop() + window.location.search;
        const reasonPart = reason ? `&reason=${encodeURIComponent(reason)}` : '';
        window.location.href = `login.html?redirect=${encodeURIComponent(here)}${reasonPart}`;
    }

    /** The one way a session ends in this browser. `reason` is 'logout' when
     *  the person chose it; anything else ('expired', 'revoked', 'suspended')
     *  is the session ending on its own. Clears the login and cached identity,
     *  records who it was for login.html, and deals with the leftovers as
     *  described on SessionData. Callers decide where to navigate afterwards. */
    endSession(reason = 'expired') {
        clearTimeout(this._sessionWatchTimer);
        document.querySelector('.session-toast')?.remove();
        const userId = tokenUserId(this.token) || this.user?.id || null;
        TokenStorage.clear('nextastore_token');
        TokenStorage.clear('nextastore_user');
        this.token = null;
        this.user = null;
        this.store = null;
        const explicit = reason === 'logout';
        if (!explicit) SessionData.markEnded(userId, reason);
        SessionData.onSessionEnded({ explicit });
        this.renderAccountNavs();
    }

    /** Which server responses mean "this session is over". Everything else
     *  (including a 503 while the database blips) leaves the login alone. */
    sessionEndReasonFor(status, code) {
        if (status === 401 && (code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID')) return 'expired';
        if (status === 401 && code === 'TOKEN_REVOKED') return 'revoked';
        if (status === 403 && code === 'ACCOUNT_SUSPENDED') return 'suspended';
        return null;
    }

    /** Session-expiry watch. This replaces the old fixed-length "no input
     *  for 30 minutes" idle timer, which forced a silent logout on its own
     *  clock — unrelated to *_EXPIRES_IN/*_MAX_AGE in .env, and happy to
     *  end a session while someone was just reading a long listing without
     *  touching the mouse or keyboard.
     *
     *  There is now exactly ONE clock that can end a session: the token's
     *  own `exp`, which the server derives from .env and slides forward on
     *  genuine use (see signSessionToken/attachRenewedToken in
     *  middleware.js — background polls never count). This just watches
     *  that real deadline from the browser side, so:
     *    - the person gets a short warning before it happens instead of
     *      discovering it mid-click, and
     *    - a tab that's just sitting open with nothing to click still gets
     *      cleaned up once the real session is actually over, instead of
     *      looking logged in until the next request happens to fail.
     *  It never ends a session early and never talks to the server on its
     *  own — it only reflects back a deadline the server already set. */
    startSessionExpiryWatch() {
        clearTimeout(this._sessionWatchTimer);
        if (!this.token) return;
        const WARNING_LEAD_MS = 2 * 60 * 1000; // heads-up 2 minutes before the real expiry
        const CHECK_EVERY_MS = 30 * 1000;
        let warned = false;

        const check = () => {
            clearTimeout(this._sessionWatchTimer);
            if (!this.token) return; // ended some other way already
            const expiresAt = this.tokenExpiresAt(this.token);
            if (!expiresAt) { this._sessionWatchTimer = setTimeout(check, CHECK_EVERY_MS); return; }

            const msLeft = expiresAt - Date.now();
            if (msLeft <= 0) {
                // The real, .env-configured session has actually ended. The
                // warning below should already have given the person a
                // chance to stay signed in before this ever fires.
                document.querySelector('.session-toast')?.remove();
                this.endSession('expired');
                if (document.body.hasAttribute('data-auth-required')) this.redirectToLogin('expired');
                return;
            }
            if (!warned && msLeft <= WARNING_LEAD_MS) {
                warned = true;
                this.showSessionExpiryToast();
            }
            this._sessionWatchTimer = setTimeout(check, CHECK_EVERY_MS);
        };
        // Being on a hidden tab only postpones the check; coming back
        // re-checks immediately, so a tab left hidden isn't stale for long.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
        check();
    }

    /** A one-time, dismissible heads-up shown once the real session has
     *  under WARNING_LEAD_MS left. "Stay signed in" makes one ordinary
     *  request; if the server's own sliding-window rule (attachRenewedToken
     *  in middleware.js) allows a renewal at this point, the response
     *  carries a fresh token exactly as any normal click would, and the
     *  watch above restarts against the new expiry. This button grants no
     *  extra time on its own — it only asks now for what browsing normally
     *  would have gotten anyway. Dismissing it changes nothing: the real
     *  timeout still runs on schedule either way. */
    showSessionExpiryToast() {
        if (document.querySelector('.session-toast')) return;
        const toast = document.createElement('div');
        toast.className = 'session-toast';
        toast.innerHTML = `
            <i class="fas fa-clock"></i>
            <span>Your session is about to expire.</span>
            <button type="button" class="session-toast-stay">Stay signed in</button>
            <button type="button" class="session-toast-close" aria-label="Dismiss">&times;</button>
        `;
        document.body.prepend(toast);
        toast.querySelector('.session-toast-stay')?.addEventListener('click', async () => {
            toast.remove();
            try { await this.apiRequest('/user/me'); } catch (err) { /* a real 401 here already ran endSession() inside apiRequest */ }
            this.startSessionExpiryWatch();
        });
        toast.querySelector('.session-toast-close')?.addEventListener('click', () => toast.remove());
    }


    /** Reads back a pending action stashed by requireLogin(), if its `type`
     *  matches what the calling page is asking for. Only clears it on a
     *  match — callers that check multiple types in sequence (e.g.
     *  store-detail.js checking 'favorite-product' then 'contact-seller')
     *  must not have the first mismatched check erase what the second one
     *  is looking for. */
    consumePendingAction(type) {
        const raw = sessionStorage.getItem(SessionData.PENDING_ACTION_KEY);
        if (!raw) return null;
        try {
            const action = JSON.parse(raw);
            if (action && action.type === type) {
                sessionStorage.removeItem(SessionData.PENDING_ACTION_KEY);
                return action;
            }
        } catch (e) {
            sessionStorage.removeItem(SessionData.PENDING_ACTION_KEY);
        }
        return null;
    }

    /** Single logout implementation shared by every page (dashboard sidebar,
     *  marketplace account menu) instead of each one clearing localStorage
     *  and redirecting on its own. */
    async logout() {
        const confirmed = await this.confirm({
            title: 'Log out?',
            message: 'You will need to sign in again to access your account.',
            confirmText: 'Log out',
            tone: 'danger'
        });
        if (!confirmed) return;
        this.endSession('logout');
        window.location.href = 'index.html';
    }

    /** Render a consistent logged-in account control into any header container. */
    openMessageSellerModal({ store, product = null, onSent = null } = {}) {
        if (!store?.id) return;
        document.getElementById('sharedMessageSellerModal')?.remove();
        const modal = document.createElement('div');
        modal.className = 'modal open';
        modal.id = 'sharedMessageSellerModal';
        const storeName = this.escapeHtml(store.name || 'Seller');
        const storeLogo = store.logo ? this.resolveImageUrl(store.logo) : '';
        const productImage = product ? this.productThumb(product) : '';
        modal.innerHTML = `<div class="modal-content message-seller-modal"><button class="modal-close" type="button" aria-label="Close">&times;</button>
            <div class="message-modal-header"><div class="message-seller-avatar">${storeLogo ? `<img src="${this.escapeHtml(storeLogo)}" alt="">` : '<i class="fas fa-store"></i>'}</div><div><span class="eyebrow">Message seller</span><h2>${storeName}</h2><p>Messages stay in your NextaStore inbox.</p></div></div>
            ${product ? `<div class="message-product-context">${productImage ? `<img src="${this.escapeHtml(productImage)}" alt="">` : '<i class="fas fa-box"></i>'}<div><small>About this product</small><strong>${this.escapeHtml(product.name || 'Product')}</strong></div></div>` : ''}
            <form><div class="form-group"><label class="form-label" for="sharedSellerMessage">Message</label><textarea class="form-textarea" id="sharedSellerMessage" maxlength="2000" rows="5" required placeholder="Ask about availability, delivery, sizing…"></textarea><div class="message-safety-note"><i class="fas fa-shield-halved"></i><span>Keep communication inside NextaStore messaging so there is a record if something goes wrong. <a href="safety.html">Trust &amp; Safety</a></span></div></div><div class="message-modal-footer"><span class="message-send-state" data-send-state>Your message will appear in Messages.</span><button class="btn btn-primary" type="submit" data-send-button><i class="fas fa-paper-plane"></i> Send message</button></div></form></div>`;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.querySelector('.modal-close').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('form').addEventListener('submit', async e => {
            e.preventDefault();
            const input = modal.querySelector('#sharedSellerMessage'); const text = input.value.trim(); if (!text) return;
            const button = modal.querySelector('[data-send-button]'); const state = modal.querySelector('[data-send-state]');
            button.disabled = true; input.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…'; state.textContent = 'Sending your message…';
            try {
                await this.apiRequest('/messages', { method: 'POST', body: JSON.stringify({ storeId: store.id, productId: product?.id || null, body: text }) });
                state.textContent = 'Sent — check Messages for replies.'; button.innerHTML = '<i class="fas fa-check"></i> Sent';
                await this.refreshUnreadBadges();
                if (typeof onSent === 'function') onSent();
                setTimeout(() => { close(); window.location.href = 'messages.html'; }, 450);
            } catch (err) { state.textContent = err.message || 'Could not send message'; button.disabled = false; input.disabled = false; button.innerHTML = '<i class="fas fa-paper-plane"></i> Send message'; }
        });
        requestAnimationFrame(() => modal.querySelector('textarea')?.focus());
    }

    renderSellerBadges(store, { compact = false, limit = 3 } = {}) {
        const badges = Array.isArray(store?.badges) ? store.badges.slice(0, limit) : [];
        if (!badges.length) return '';
        return badges.map(b => `<span class="seller-badge seller-badge--${this.escapeHtml(b.tone || 'verified')} ${compact ? 'seller-badge--compact' : ''}" title="${this.escapeHtml(b.reason || b.label)}" aria-label="${this.escapeHtml(b.label)}"><i class="fas ${this.escapeHtml(b.icon || 'fa-award')}"></i><span>${this.escapeHtml(compact ? (b.shortLabel || b.label) : b.label)}</span></span>`).join('');
    }

    renderAccountNav(containerEl) {
        if (!containerEl) return;
        if (!this.token || !this.user) {
            containerEl.innerHTML = `
                <a href="login.html" class="btn btn-outline btn-sm">Login</a>
                <a href="signup.html" class="btn btn-primary btn-sm">Create account</a>`;
            return;
        }

        const role = this.user.role === 'admin' ? 'admin' : (this.user.role === 'seller' ? 'seller' : 'buyer');
        const avatarStyle = this.user.avatar
            ? `style="background-image:url('${this.resolveImageUrl(this.user.avatar)}');background-size:cover;background-position:center"`
            : '';
        const initial = this.escapeHtml(this.getInitial(this.user.name));
        const verify = !this.user.emailVerified
            ? `<button type="button" class="account-menu-item" data-account-action="verify"><i class="fas fa-envelope-circle-check"></i> Verify email</button>` : '';
        // Becoming a seller flips the user's role immediately, but the store
        // itself stays a draft (isPublished: false) until onboarding is
        // finished. Route role==='seller' users who haven't finished
        // onboarding back to it instead of a "Seller dashboard" link that
        // would drop them into a store that isn't live yet.
        const sellerOnboardingDone = role === 'seller' && !!this.store?.isPublished;
        const seller = sellerOnboardingDone
            ? `<a href="dashboard.html" class="account-menu-item"><i class="fas fa-gauge"></i> Seller dashboard</a>`
            : (role === 'seller' ? `<a href="onboarding.html" class="account-menu-item"><i class="fas fa-store"></i> Finish setting up your store</a>` : '');
        const admin = role === 'admin'
            ? `<a href="admin.html" class="account-menu-item"><i class="fas fa-gauge-high"></i> Admin console</a>` : '';
        const becomeSeller = role === 'buyer'
            ? `<button type="button" class="account-menu-item is-divider-top" data-account-action="seller"><i class="fas fa-store"></i> Become a seller</button>` : '';

        containerEl.innerHTML = `
            <div class="notification-nav-wrap" data-notification-nav-wrap>
                <button type="button" class="notification-nav" data-notification-nav aria-label="Notifications" aria-expanded="false">
                    <i class="fas fa-bell"></i><span class="notification-nav-badge hidden" data-notification-nav-badge></span>
                </button>
                <div class="notification-preview" data-notification-preview aria-label="Recent notifications">
                    <div class="notification-preview-head"><strong>Notifications</strong><button type="button" data-notification-read-all>Mark all as read</button></div>
                    <div class="notification-preview-filters" role="group" aria-label="Filter notifications">
                        <button type="button" class="is-active" data-notification-filter="all" aria-pressed="true">All</button>
                        <button type="button" data-notification-filter="unread" aria-pressed="false">Unread<span class="notification-filter-count hidden" data-notification-filter-count></span></button>
                    </div>
                    <button type="button" class="notification-preview-push-row hidden" data-notification-push-row>
                        <i class="fas fa-bell"></i> Turn on push notifications
                    </button>
                    <div class="notification-preview-list" data-notification-preview-list><div class="notification-preview-empty"><i class="fas fa-spinner fa-spin"></i> Loading…</div></div>
                </div>
            </div>
            <div class="account-menu" data-account-menu>
                <button type="button" class="account-menu-trigger" data-account-trigger aria-haspopup="true" aria-expanded="false" aria-label="Open account menu">
                    <span class="user-avatar-circle" ${avatarStyle}>${this.user.avatar ? '' : initial}</span>
                    <span class="account-trigger-name">${this.escapeHtml((this.user.name || 'Account').split(' ')[0])}</span>
                    ${role === 'seller' ? this.renderSellerBadges(this.store, { compact: true, limit: 1 }) : ''}
                    <i class="fas fa-chevron-down" aria-hidden="true"></i>
                </button>
                <div class="account-menu-dropdown" data-account-dropdown role="menu">
                    <div class="account-menu-header">
                        <span class="user-avatar-circle" ${avatarStyle}>${this.user.avatar ? '' : initial}</span>
                        <div><div class="account-menu-name">${this.escapeHtml(this.user.name || 'User')} ${role === 'seller' ? this.renderSellerBadges(this.store, { compact: false, limit: 2 }) : ''}</div><div class="account-menu-role">${role === 'admin' ? this.escapeHtml(this.user.adminLevel === 'super_admin' ? 'Super administrator' : (this.user.adminRole?.name || 'Administrator')) : (role === 'seller' ? 'Seller account' : 'Buyer account')}</div></div>
                    </div>
                    <div class="account-menu-items">
                        ${verify}${seller}${admin}
                        <a href="orders.html" class="account-menu-item"><i class="fas fa-box"></i> Orders</a>
                        <a href="favorites.html" class="account-menu-item"><i class="fas fa-heart"></i> Favorites</a>
                        <a href="following.html" class="account-menu-item"><i class="fas fa-store"></i> Following</a>
                        <a href="messages.html" class="account-menu-item"><i class="fas fa-message"></i> Messages <span class="unread-badge hidden" data-unread-badge></span></a>
                        ${becomeSeller}
                    </div>
                    <button type="button" class="account-menu-item account-menu-logout" data-account-action="logout"><i class="fas fa-right-from-bracket"></i> Log out</button>
                </div>
            </div>`;

        const menu = containerEl.querySelector('[data-account-menu]');
        const notificationWrap = containerEl.querySelector('[data-notification-nav-wrap]');
        const notificationTrigger = containerEl.querySelector('[data-notification-nav]');
        const notificationList = containerEl.querySelector('[data-notification-preview-list]');
        const pushRow = containerEl.querySelector('[data-notification-push-row]');
        const notificationClose = () => { notificationWrap?.classList.remove('open'); notificationTrigger?.setAttribute('aria-expanded','false'); };
        notificationTrigger?.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            // Only one of the account menu / notification preview should ever
            // be open at once — opening this one closes the other first,
            // rather than letting both stack up on top of each other.
            accountClose();
            const open = notificationWrap.classList.toggle('open');
            notificationTrigger.setAttribute('aria-expanded', String(open));
            if (open) {
                // Opening the bell only acknowledges it — the exterior badge
                // clears the moment it is tapped (optimistically, BEFORE the
                // list request, which can be slow), then is confirmed against
                // the server once the acknowledge lands. Each item's own
                // unread highlight in the list is untouched until that
                // specific item is tapped.
                // Every open starts on "All" — a filter left on from last time
                // must never make a brand-new notification look missing.
                this.notificationFilter = 'all';
                this.notifications.keepVisible.clear();
                this.updateNotificationFilterUi();
                this.applyNotificationCount(0);
                const acknowledged = this.apiRequest('/notifications/acknowledge', { method: 'PUT', keepalive: true })
                    .then(() => this.refreshNotificationBadge())
                    .catch(() => {});
                await Promise.all([this.loadNotificationPreview(notificationList), acknowledged]);
            }
        });
        this.refreshPushBellRow(pushRow);
        pushRow?.addEventListener('click', async () => {
            if (!window.NextaPush) return;
            pushRow.disabled = true;
            pushRow.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Turning on…';
            try {
                await window.NextaPush.enable();
                this.showAlert('Push notifications are on.', 'success');
            } catch (err) {
                this.showAlert(err.message, err.reason === 'unconfigured' ? 'warning' : 'error');
            } finally {
                this.refreshAllPushBellRows();
            }
        });
        notificationList?.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('div[data-notification-id]')) { e.preventDefault(); e.target.click(); }
        });
        notificationList?.addEventListener('click', (e) => {
            if (e.target.closest('[data-notification-retry]')) { this.loadNotificationPreview(notificationList); return; }
            this.handleNotificationClick(e, notificationClose);
        });
        containerEl.querySelectorAll('[data-notification-filter]').forEach(btn => {
            btn.addEventListener('click', () => this.setNotificationFilter(btn.dataset.notificationFilter, notificationList));
        });
        containerEl.querySelector('[data-notification-read-all]')?.addEventListener('click', async () => {
            // Every unread dot clears on this tap (the store flags them read
            // synchronously); if the server refuses, they come back. On the
            // Unread filter the list itself empties ("all caught up") and is
            // restored the same way.
            const pending = this.notifications.markAllRead();
            this.notifications.keepVisible.clear();
            this.syncNotificationDots();
            if (this.notificationFilter === 'unread') this.renderNotificationItems(notificationList);
            if (!(await pending)) {
                this.syncNotificationDots();
                if (this.notificationFilter === 'unread') this.renderNotificationItems(notificationList);
                return;
            }
            await this.refreshNotificationBadge();
            this.loadNotificationPreview(notificationList);
        });

        /* A bell item that points at a message thread warms that thread's
           cache on hover / touch-down (messages page only — elsewhere
           messagesManager doesn't exist and this is a no-op). */
        const threadIdOf = el => {
            const a = el && el.closest ? el.closest('a[data-notification-id]') : null;
            const m = a && /^\/?messages\.html\?conversation=([A-Za-z0-9_\-%]+)$/.exec(a.getAttribute('href') || '');
            return m ? decodeURIComponent(m[1]) : null;
        };
        let bellHoverTimer = null, bellTouchTimer = null;
        notificationList?.addEventListener('pointerover', (e) => {
            if (e.pointerType !== 'mouse') return;
            const id = threadIdOf(e.target);
            if (!id) return;
            clearTimeout(bellHoverTimer);
            bellHoverTimer = setTimeout(() => window.messagesManager?.prefetchThread?.(id), 80);
        });
        notificationList?.addEventListener('pointerout', () => clearTimeout(bellHoverTimer));
        notificationList?.addEventListener('touchstart', (e) => {
            const id = threadIdOf(e.target);
            if (!id) return;
            clearTimeout(bellTouchTimer);
            bellTouchTimer = setTimeout(() => window.messagesManager?.prefetchThread?.(id), 40);
        }, { passive: true });
        ['touchmove', 'touchcancel'].forEach(type => notificationList?.addEventListener(type, () => clearTimeout(bellTouchTimer), { passive: true }));

        const trigger = containerEl.querySelector('[data-account-trigger]');
        const accountClose = () => { menu?.classList.remove('open'); trigger?.setAttribute('aria-expanded', 'false'); };
        trigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Same pairing as the bell above: opening the account menu
            // closes the notification preview first so only one shows.
            notificationClose();
            const open = menu.classList.toggle('open');
            trigger.setAttribute('aria-expanded', String(open));
        });
        trigger?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') accountClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); notificationClose(); menu.classList.add('open'); trigger.setAttribute('aria-expanded','true'); containerEl.querySelector('.account-menu-item')?.focus(); }
        });
        containerEl.querySelector('[data-account-dropdown]')?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { accountClose(); trigger?.focus(); } });
        document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) accountClose(); if (notificationWrap && !notificationWrap.contains(e.target)) notificationClose(); }, { once: false });
        containerEl.querySelector('[data-account-action="logout"]')?.addEventListener('click', () => this.logout());
        containerEl.querySelector('[data-account-action="seller"]')?.addEventListener('click', async () => {
            try {
                const response = await this.apiRequest('/user/become-seller', { method: 'POST' });
                this.user = response.data;
                TokenStorage.write('nextastore_user', JSON.stringify(this.user), this.remembered);
                window.location.href = 'onboarding.html';
            } catch (err) { this.showAlert(err.message, 'error'); }
        });
        containerEl.querySelector('[data-account-action="verify"]')?.addEventListener('click', async () => {
            try { await this.apiRequest('/auth/send-verification', { method: 'POST' }); this.showAlert('Check your inbox for a verification link.', 'success'); }
            catch (err) { this.showAlert(err.message, 'error'); }
            accountClose();
        });
        this.refreshUnreadBadges();
    }

    /* Only real notifications ever show in the bell. It used to merge in a
       second feed built from the latest conversations, which put raw message
       text into the dropdown (and duplicated the "New message from X"
       notification the server already creates for every conversation).
       Messages live in Messages; the bell just points at them. */
    notificationIcon(type) {
        return { new_order: 'fa-bag-shopping', new_message: 'fa-message', low_stock: 'fa-box-open', subscription: 'fa-credit-card', new_product: 'fa-tags', store_live: 'fa-store' }[type] || 'fa-bell';
    }

    /* Notification links come from the API, but they end up in an href — so
       only plain same-site page links ("messages.html?conversation=abc",
       "/subscription.html", "dashboard.html#orders") are honoured. Anything
       else (an absolute URL, a javascript: URI, stray characters) is dropped
       and the notification is simply not clickable. */
    safeInternalLink(link) {
        if (typeof link !== 'string') return '';
        const value = link.trim();
        return /^\/?[A-Za-z0-9][A-Za-z0-9_\-\/]*\.html(\?[A-Za-z0-9_\-=&%.]*)?(#[A-Za-z0-9_\-]*)?$/.test(value) ? value : '';
    }

    /* Paints the panel's list for the current filter. Draws from the store,
       so it is instant when the store already holds a list, and shows the same
       dot on every unread item (see notificationItemHtml). Up to 30 items —
       everything the server returns; the list scrolls — so an unread item
       can't be hidden below an arbitrary cut-off where its indicator could
       never be seen. */
    renderNotificationItems(container) {
        const store = this.notifications;
        const filter = this.notificationFilter;
        const items = store.visible(filter);
        const scrollTop = container.scrollTop;
        if (!items.length) {
            container.innerHTML = filter === 'unread'
                ? '<div class="notification-preview-empty"><i class="fas fa-check-double"></i> You\u2019re all caught up.</div>'
                : '<div class="notification-preview-empty"><i class="fas fa-bell-slash"></i> No notifications yet.</div>';
        } else {
            let html = items.map(n => this.notificationItemHtml(n)).join('');
            // Only the newest 30 unread are listed; say so instead of letting
            // the list look complete when it isn't.
            const total = store.unreadCountForDisplay();
            if (filter === 'unread' && items.length >= 30 && total > items.length) {
                html += `<div class="notification-preview-more">Showing your newest ${items.length} of ${total} unread.</div>`;
            }
            container.innerHTML = html;
            container.scrollTop = scrollTop;
        }
        this.updateNotificationFilterUi();
    }

    /* One row. An unread item carries (1) the green dot, (2) the light tint,
       (3) a screen-reader-only "Unread:" prefix — colour is never the only
       signal. The dot is deliberately green, not the bell badge's gold: the
       two mean different things (see NotificationStore). */
    notificationItemHtml(n) {
        const href = this.safeInternalLink(n.link);
        const unread = this.notifications.isUnread(n);
        const inner = `
            <span class="notification-preview-icon"><i class="fas ${this.notificationIcon(n.type)}"></i></span>
            <span class="notification-preview-main">${unread ? '<span class="notification-unread-label">Unread: </span>' : ''}<strong>${this.escapeHtml(n.title)}</strong><span>${this.escapeHtml(n.body || '')}</span><time>${this.escapeHtml(this.formatDate(n.createdAt))}</time></span>
            ${unread ? '<span class="notification-unread-dot" aria-hidden="true"></span>' : ''}`;
        return href
            ? `<a href="${this.escapeHtml(href)}" class="notification-preview-item ${unread ? 'is-unread' : ''}" data-notification-id="${this.escapeHtml(n.id)}" data-notification-unread="${unread ? '1' : '0'}">${inner}</a>`
            : `<div class="notification-preview-item ${unread ? 'is-unread' : ''}" data-notification-id="${this.escapeHtml(n.id)}" data-notification-unread="${unread ? '1' : '0'}" ${unread ? 'role="button" tabindex="0"' : ''}>${inner}</div>`;
    }

    /* Flips ONE rendered row between unread and read in place (no repaint of
       the list): class, data attribute, dot and the screen-reader prefix. */
    paintNotificationItem(el, unread) {
        el.classList.toggle('is-unread', unread);
        el.dataset.notificationUnread = unread ? '1' : '0';
        const dot = el.querySelector('.notification-unread-dot');
        const label = el.querySelector('.notification-unread-label');
        if (!unread) {
            if (dot) dot.remove();
            if (label) label.remove();
        } else {
            if (!dot) el.insertAdjacentHTML('beforeend', '<span class="notification-unread-dot" aria-hidden="true"></span>');
            if (!label) el.querySelector('.notification-preview-main')?.insertAdjacentHTML('afterbegin', '<span class="notification-unread-label">Unread: </span>');
        }
    }

    /* Re-syncs every rendered row (in every open panel) with the store. */
    syncNotificationDots() {
        document.querySelectorAll('[data-notification-id]').forEach(el => {
            const n = this.notifications.find(el.dataset.notificationId);
            if (!n) return;
            const unread = this.notifications.isUnread(n);
            if ((el.dataset.notificationUnread === '1') !== unread) this.paintNotificationItem(el, unread);
        });
        this.updateNotificationFilterUi();
    }

    /* The All / Unread switch: which one is pressed, and the unread number on
       the second. (Hidden at 0 and before anything has loaded.) */
    updateNotificationFilterUi() {
        document.querySelectorAll('[data-notification-filter]').forEach(btn => {
            const active = btn.dataset.notificationFilter === this.notificationFilter;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', String(active));
        });
        const store = this.notifications;
        const known = store.unreadTotal !== null || store.items || store.unreadItems;
        const count = known ? store.unreadCountForDisplay() : 0;
        document.querySelectorAll('[data-notification-filter-count]').forEach(el => {
            el.textContent = count > 99 ? '99+' : String(count);
            el.classList.toggle('hidden', count === 0);
        });
    }

    /* Switches the panel between All and Unread. The Unread list draws at
       once from what is already known (or shows a spinner if nothing is), and
       is then replaced by the server's own unread list, which can reach
       unread items older than the newest 30. */
    setNotificationFilter(filter, container) {
        const next = filter === 'unread' ? 'unread' : 'all';
        if (next === this.notificationFilter) return;
        this.notificationFilter = next;
        this.notifications.keepVisible.clear();
        this.updateNotificationFilterUi();
        if (container) { container.scrollTop = 0; this.loadNotificationPreview(container); }
    }

    /* Panels that are open right now pick up new notifications on the same
       20s tick that refreshes the badge, instead of showing whatever was
       fetched when they were opened. */
    refreshOpenNotificationLists() {
        document.querySelectorAll('[data-notification-nav-wrap].open [data-notification-preview-list]').forEach(list => this.loadNotificationPreview(list));
    }

    /* Stale-while-revalidate: if the store already has something to show for
       the current filter it is drawn immediately (dots and all), then the
       server's copy replaces it only if something actually changed. Only when
       there is nothing to show does the panel need a spinner / a "couldn't
       load" state. */
    async loadNotificationPreview(container) {
        if (!container || !this.token) return;
        const store = this.notifications;
        const filter = this.notificationFilter;
        const hadCache = store.hasData(filter);
        if (hadCache) this.renderNotificationItems(container);
        else container.innerHTML = '<div class="notification-preview-empty"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
        // Deliberately does NOT touch the bell badge — that's the
        // acknowledged-based count and is handled by the caller (opening the
        // dropdown always acknowledges). This list only reflects each item's
        // own readAt-based unread state.
        const before = store.signature(filter);
        try {
            const items = await store.load(filter);
            if (items === null || filter !== this.notificationFilter) return;   // session ended, or the person switched filters meanwhile
            if (!hadCache || store.signature(filter) !== before) this.renderNotificationItems(container);
            else this.updateNotificationFilterUi();
        } catch (err) {
            if (filter === this.notificationFilter && !hadCache) container.innerHTML = '<div class="notification-preview-empty"><i class="fas fa-circle-exclamation"></i> Couldn\u2019t load notifications. <button type="button" class="notification-preview-retry" data-notification-retry>Try again</button></div>';
        }
    }

    /* A tap on a notification marks it read and takes the person to where it
       points. Its dot clears on the tap; the write goes through the store
       (keepalive, retried later if it fails) and we don't wait on it — a
       failed mark-read must never block the redirect, and opening the target
       thread settles message notifications server-side anyway. */
    handleNotificationClick(event, closeDropdown) {
        // Anchors go somewhere; a notification with no link is a plain div,
        // but tapping it must still mark it read (the item-level unread state
        // may only ever clear by tapping that item or "Mark all as read").
        const link = event.target.closest('[data-notification-id]');
        if (!link) return;
        if (link.dataset.notificationUnread === '1') {
            // On the Unread filter the row stays put (its dot is gone) until
            // the filter is re-entered — the list must not shift under a tap.
            if (this.notificationFilter === 'unread') this.notifications.keepVisible.add(link.dataset.notificationId);
            this.paintNotificationItem(link, false);
            const write = this.notifications.markRead(link.dataset.notificationId);   // flags it read synchronously…
            this.updateNotificationFilterUi();                                        // …so the Unread count drops now
            write.then(ok => { if (ok) this.refreshNotificationBadge(); });
        }
        // Ctrl/Cmd/Shift/middle-click keep their normal "open in a new
        // tab/window" behaviour.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;

        // Already on the messages page: switch thread in place instead of
        // reloading the whole page.
        const match = /^\/?messages\.html\?conversation=([A-Za-z0-9_\-%]+)$/.exec(link.getAttribute('href') || '');
        if (match && window.messagesManager?.openConversation) {
            event.preventDefault();
            closeDropdown();
            window.messagesManager.openConversation(decodeURIComponent(match[1]));
        }
    }

    renderAccountNavs() {
        document.querySelectorAll('[data-account-nav]').forEach(el => this.renderAccountNav(el));
        this.applyAuthVisibility();
    }

    /** Elements marked data-hide-when-authed (e.g. a static footer "Login"
     *  link) are only relevant to a signed-out visitor — once someone is
     *  logged in, seeing "Login" again elsewhere on the page reads as a
     *  bug, so these hide themselves as soon as we know there's a session. */
    applyAuthVisibility() {
        const authed = !!(this.token && this.user);
        document.querySelectorAll('[data-hide-when-authed]').forEach(el => {
            el.style.display = authed ? 'none' : '';
        });
    }

    /** Accessible in-site replacement for browser confirm(). */
    confirm({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', tone = 'primary' } = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'site-dialog-overlay';
            overlay.innerHTML = `
                <div class="site-dialog" role="alertdialog" aria-modal="true" aria-labelledby="siteDialogTitle" aria-describedby="siteDialogMessage">
                    <div class="site-dialog-icon tone-${this.escapeHtml(tone)}"><i class="fas ${tone === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-question'}"></i></div>
                    <h2 id="siteDialogTitle">${this.escapeHtml(title)}</h2>
                    <p id="siteDialogMessage">${this.escapeHtml(message)}</p>
                    <div class="site-dialog-actions">
                        <button type="button" class="btn btn-outline" data-dialog-cancel>${this.escapeHtml(cancelText)}</button>
                        <button type="button" class="btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}" data-dialog-confirm>${this.escapeHtml(confirmText)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const confirmBtn = overlay.querySelector('[data-dialog-confirm]');
            const cancelBtn = overlay.querySelector('[data-dialog-cancel]');
            const finish = value => { overlay.remove(); resolve(value); };
            confirmBtn.addEventListener('click', () => finish(true));
            cancelBtn.addEventListener('click', () => finish(false));
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
            overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(false); });
            requestAnimationFrame(() => confirmBtn.focus());
        });
    }

    updateUI() {
        this.renderAccountNavs();
        // Update user name displays (skip form inputs — those are populated
        // with .value by the page that owns them, e.g. dashboard.js loadSettings())
        document.querySelectorAll('[data-user-name]').forEach(el => {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
            el.textContent = this.user?.name || 'User';
        });

        // Update user avatar — a photo if one was uploaded, otherwise an
        // initial (so a brand-new account never shows a broken image)
        document.querySelectorAll('[data-user-avatar]').forEach(el => {
            if (this.user?.avatar) {
                el.style.backgroundImage = `url(${this.resolveImageUrl(this.user.avatar)})`;
                el.style.backgroundSize = 'cover';
                el.style.backgroundPosition = 'center';
                el.textContent = '';
            } else {
                el.style.backgroundImage = '';
                el.textContent = this.getInitial(this.user?.name);
            }
        });
    }

    getInitial(name) {
        return (name || 'U').trim().charAt(0).toUpperCase();
    }

    /**
     * Polls the unread-message count and reflects it into every
     * `[data-unread-badge]` element currently in the DOM (the dashboard
     * sidebar's "Messages" link, the marketplace account menu's, etc.).
     * Called once on load for any logged-in user and again whenever a page
     * re-renders the nav element that contains a badge (see
     * marketplace.js's renderAccountMenu()), then left on a slow
     * background interval — a badge that's a few seconds stale is fine,
     * unlike the open thread itself in messages.js which polls much more
     * tightly.
     */
    /* Unread-notification count for the bell badge on every page. The count
       comes from the lightweight GET /notifications/unread-count (see
       refreshNotificationBadge below); the dropdown's own list fetch already
       includes the same number and reuses it. */
    /* Paints an unread count onto every bell on the page. Split out so the
       dropdown-open path can reuse the count it already fetched. */
    applyNotificationCount(count) {
        document.querySelectorAll('[data-notification-nav-badge]').forEach(el => {
            el.textContent = count > 99 ? '99+' : String(count);
            el.classList.toggle('hidden', count === 0);
            const bell = el.closest('.notification-nav');
            if (bell) {
                bell.setAttribute('aria-label', count === 0
                    ? 'Notifications'
                    : `Notifications, ${count} unread`);
            }
        });
    }

    /* Shows/hides one bell dropdown's "Turn on push notifications" row.
       Hidden whenever push isn't something to offer right now: unsupported
       browser, server has no VAPID keys configured, or this device already
       holds a subscription — in all three cases the row would just be
       clutter (or, in the unconfigured case, a promise the click can't
       keep). Errors fail closed (row hidden) rather than showing a button
       that might not work. */
    async refreshPushBellRow(pushRow) {
        if (!pushRow) return;
        if (!window.NextaPush || !window.NextaPush.supported() || !this.token) {
            pushRow.classList.add('hidden');
            return;
        }
        try {
            const [{ enabled }, subscribed] = await Promise.all([
                window.NextaPush.serverStatus(),
                window.NextaPush.isSubscribed()
            ]);
            pushRow.classList.toggle('hidden', !enabled || subscribed);
        } catch (err) {
            pushRow.classList.add('hidden');
        } finally {
            pushRow.disabled = false;
            pushRow.innerHTML = '<i class="fas fa-bell"></i> Turn on push notifications';
        }
    }

    /* Every bell on the page (normally just one, but nothing stops a layout
       from rendering [data-account-nav] twice) reflects the same push
       state, so a device enabling notifications from one bell shouldn't
       leave a stale "Turn on" row showing in another. */
    refreshAllPushBellRows() {
        document.querySelectorAll('[data-notification-push-row]').forEach(row => this.refreshPushBellRow(row));
    }

    async refreshNotificationBadge() {
        if (!this.token) return;
        try {
            // Count only — this runs on a timer on every page, so it must
            // not download the notification list just to read a number.
            // X-Background-Poll tells the server this request proves a tab
            // is open, not that a person is doing anything (finding 5) — it
            // must never renew or extend the session on its own. The path
            // itself already matches the server's BACKGROUND_PATH pattern,
            // so this header is redundant there today, but it's what makes
            // the *client* the source of truth rather than relying on the
            // server happening to recognise this specific URL.
            const res = await this.apiRequest('/notifications/unread-count', { timeoutMs: 12000, headers: { 'X-Background-Poll': '1' } });
            this.applyNotificationCount(Number(res?.data?.count) || 0);
        } catch (err) {
            // A badge that fails to refresh keeps its last known value rather
            // than flashing to zero on a dropped request.
        }
    }

    async refreshUnreadBadges() {
        if (!this.token) return;
        const messageBadges = (async () => {
            try {
                const res = await this.apiRequest('/messages/unread-count', { timeoutMs: 12000, headers: { 'X-Background-Poll': '1' } });
                const count = res?.data?.count || 0;
                document.querySelectorAll('[data-unread-badge]').forEach(el => {
                    el.textContent = count > 99 ? '99+' : String(count);
                    el.classList.toggle('hidden', count === 0);
                });
                document.title = document.title.replace(/^\(\d+\+?\)\s*/, '');
                if (count > 0 && document.body.hasAttribute('data-show-unread-in-title')) {
                    document.title = `(${count > 99 ? '99+' : count}) ${document.title}`;
                }
            } catch (err) {
                // Never surface this — a badge that fails to update silently
                // just stays at its last known value.
            }
        })();
        // Independent requests: run together rather than one after the other.
        await Promise.all([messageBadges, this.refreshNotificationBadge()]);
        this.refreshOpenNotificationLists();
    }

    startUnreadBadgePolling() {
        if (this._unreadPollTimer) return;
        this.refreshUnreadBadges();
        this._unreadPollTimer = setInterval(() => { if (!document.hidden) this.refreshUnreadBadges(); }, 20000);
        // A tab that was in the background missed its ticks; catch up the
        // moment it's looked at again.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refreshUnreadBadges(); });
    }

    /** Minimal HTML-escaping for any user-typed text interpolated into
     *  innerHTML (e.g. echoing a search term back in a "no matches for..."
     *  message) — without this, typing something like `<img onerror=...>`
     *  into a search box gets executed as markup. */
    optimizeImage(file, { maxDim = 1600, quality = 0.84, preservePng = false } = {}) {
        return new Promise((resolve, reject) => {
            if (!file || !file.type?.startsWith('image/')) return reject(new Error('Please choose an image file.'));
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
                    canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
                    const ctx = canvas.getContext('2d');
                    if (!ctx) throw new Error('Image processing is unavailable in this browser.');
                    if (!preservePng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    const mime = preservePng ? 'image/png' : 'image/jpeg';
                    canvas.toBlob(blob => {
                        URL.revokeObjectURL(objectUrl);
                        if (!blob) return reject(new Error('Could not process this image.'));
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error('Could not read the processed image.'));
                        reader.readAsDataURL(blob);
                    }, mime, quality);
                } catch (err) {
                    URL.revokeObjectURL(objectUrl);
                    reject(err);
                }
            };
            img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not read this image.')); };
            img.src = objectUrl;
        });
    }

    // SECURITY: this MUST also encode quote characters, not just & < >.
    // The previous implementation (div.textContent -> div.innerHTML) relies
    // on the browser's *text node* serializer, which — per the WHATWG HTML
    // spec — escapes only & < > (and NBSP). It deliberately leaves " and '
    // untouched, because quotes only need escaping inside an attribute
    // value, not inside text content. That's exactly how this helper's
    // output gets used all over the app though: dropped straight into
    // `attr="${app.escapeHtml(x)}"` template strings before an innerHTML
    // assignment. Any user-controlled string containing a `"` (e.g. a
    // shared-location label, free text up to 200 chars — see
    // messageContentHtml's `data-label="${label}"`) could close the
    // attribute early and inject arbitrary markup/JS: a real stored-XSS
    // vector. Encoding quotes here too makes the same escaped value safe in
    // BOTH text-node and attribute-value contexts, which is what every
    // call site in this codebase actually needs.
    escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Safe to drop into `style="...url('${x}')"` — i.e. inside a CSS
    // url(' ') that itself sits inside a double-quoted HTML attribute.
    // escapeHtml() alone isn't enough here: it protects the HTML-attribute
    // boundary but leaves the CSS string boundary open, so a value
    // containing a bare `'` (a filename, a label, anything not fully
    // trusted) could close the url('...') early and let the rest of the
    // value run as raw CSS inside the bubble — extra declarations, or
    // (depending on the browser) a second url() pointed somewhere else
    // entirely. Uses CSS's own escape syntax (backslash + hex + space)
    // instead of stripping characters, so the URL itself is never altered,
    // just made inert as a delimiter. Every character outside a small safe
    // set is escaped this way, which also closes off the same risk for
    // parentheses, double quotes, backslashes and whitespace.
    cssUrl(url) {
        if (url == null) return '';
        return String(url).replace(/[^A-Za-z0-9\-._~/:?#[\]@!$&*+,;=%]/g, ch => '\\' + ch.charCodeAt(0).toString(16) + ' ');
    }

    /**
     * Every screen in the app calls this instead of fetch() directly. By
     * default it talks to the real NextaStore API (see apiBaseUrl above).
     * With ?mock=1 in the URL it routes to js/api.js's in-browser MockAPI
     * instead, for working on the UI without Postgres running locally.
     *
     * Deliberately does NOT fall back to the mock on a real request
     * failure: if the API is unreachable, the person needs to see that —
     * silently swapping in fake data on a network error would hide a real
     * outage behind what looks like a working store.
     */
    /** Picks up a renewed session token from a response, if the API sent
     *  one. No-ops when the header is absent (older API, or a token that
     *  isn't due for renewal yet), so this is safe either way.
     *
     *  `requestToken` is the token THIS specific request was made with,
     *  captured by the caller before the request went out (see
     *  apiRequest()). Finding 2: a request made a while ago (a stale tab's
     *  slow poll, or one that was in flight when the session changed) can
     *  finish after the session has already moved on — a different person
     *  logged in on this device, this tab logged out and back in, or
     *  another tab's renewal already landed. Adopting its renewal anyway
     *  would silently overwrite whatever is actually current with a token
     *  for a session that, from here, no longer exists. Only adopt when
     *  BOTH still hold: this is still the active session in memory, AND
     *  storage hasn't moved on to something else since the request left. */
    adoptRenewedToken(response, requestToken) {
        try {
            const fresh = response.headers?.get?.('X-Session-Token');
            if (!fresh || fresh === this.token) return;
            if (!this.token || !requestToken) return;
            if (this.token !== requestToken) return;
            if (TokenStorage.read('nextastore_token') !== requestToken) return;
            this.token = fresh;
            TokenStorage.write('nextastore_token', fresh, this.remembered);
            this.startSessionExpiryWatch();
        } catch (err) {
            // Never let a renewal problem break the request that carried it.
            console.warn('Could not store renewed session token:', err);
        }
    }

    /** Reads the `exp` claim without verifying the signature (the server is
     *  the only thing that can do that, and the only thing that needs to).
     *  This is purely so an already-dead token can be cleared up front
     *  rather than after a request fails — the difference between a clean
     *  "please sign in again" and a half-loaded page that logs you out. */
    tokenExpiresAt(token) {
        const exp = decodeTokenClaims(token)?.exp;
        return typeof exp === 'number' ? exp * 1000 : null;
    }

    isTokenExpired() {
        const expiresAt = this.tokenExpiresAt(this.token);
        // An unreadable token is left alone: let the server be the judge
        // rather than logging somebody out over a parsing quirk.
        if (!expiresAt) return false;
        return Date.now() >= expiresAt;
    }

    async apiRequest(endpoint, options = {}) {
        if (this.useMockAPI && window.MockAPI) {
            return window.MockAPI.handle(endpoint, options);
        }

        // `timeoutMs` is opt-in (uploads on slow mobile connections must not be
        // cut off by a blanket limit); callers that want one — message sends,
        // polls — pass it, and an abort surfaces as a normal, typed error.
        const { timeoutMs, ...fetchOptions } = options;
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                ...(this.token && { 'Authorization': `Bearer ${this.token}` })
            }
        };

        let timer = null;
        let timedOut = false;
        if (timeoutMs && !fetchOptions.signal && typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            fetchOptions.signal = controller.signal;
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        }
        // fetch() only throws for network-level failures (server down,
        // DNS, offline, CORS, our own timeout) — never for a normal 4xx/5xx
        // response. Errors built here carry `isNetwork` so callers can tell a
        // "try again later" failure from a "this request is wrong" one.
        const networkError = () => {
            const err = new Error(timedOut
                ? 'The server took too long to respond. Check your connection and try again.'
                : 'Can\u2019t reach the server. Check your connection and try again.');
            err.isNetwork = true;
            err.isTimeout = timedOut;
            return err;
        };

        try {
            let response;
            const requestToken = this.token;
            try {
                response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
                    ...defaultOptions,
                    ...fetchOptions,
                    headers: { ...defaultOptions.headers, ...(fetchOptions.headers || {}) }
                });
            } catch (err) {
                throw networkError();
            }

            // Sliding expiry: the API hands back a fresh token once the current
            // one is past halfway through its life, so an actively-used session
            // never hits its cap. Read this before the ok/!ok split so a renewal
            // riding along with an error response isn't thrown away.
            this.adoptRenewedToken(response, requestToken);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const endReason = this.sessionEndReasonFor(response.status, error.code);
                const isTokenFailure = !!endReason;
                // Finding 2: only end the CURRENT session over a response
                // that is actually about the token this browser is using
                // right now. A slow 401/403 for a request made with an OLD
                // token — this tab logged out and back in, or another tab
                // changed the session, while the request was in flight —
                // must not wipe out whatever session exists now.
                if (endReason && this.token && requestToken === this.token) {
                    console.warn('[NextaStore auth] Ending session after server auth signal:', error.code, endpoint);
                    this.endSession(endReason);
                    if (document.body.hasAttribute('data-auth-required')) this.redirectToLogin(endReason);
                }
                const failure = new Error(error.message || (isTokenFailure ? 'Your session has expired. Please sign in again.' : 'Request failed.'));
                failure.status = response.status;
                failure.code = error.code || null;
                throw failure;
            }

            try {
                return await response.json();
            } catch (err) {
                // Headers arrived but the body didn't finish (connection cut
                // mid-response, or our timeout fired while it streamed), or the
                // body wasn't JSON at all.
                if (timedOut || err?.name === 'AbortError' || err?.name === 'TypeError') throw networkError();
                const failure = new Error('The server sent an unexpected response. Please try again.');
                failure.status = response.status;
                throw failure;
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    showAlert(message, type = 'success') {
        document.querySelectorAll('.alert').forEach(el => el.remove());
        const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation' };
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.innerHTML = `
            <i class="fas ${icons[type] || icons.success}"></i>
            <span>${this.escapeHtml(message)}</span>
            <button class="alert-close" aria-label="Dismiss">&times;</button>
        `;
        document.body.prepend(alert);
        setTimeout(() => alert.remove(), 4000);
    }

    /**
     * Every image URL the API returns for an uploaded file (product photos,
     * store logo/banner, user avatar/cover) is root-relative, e.g.
     * "/uploads/xyz.jpg" — see nextastore-backend/src/utils.js. That's
     * correct when the API also serves the frontend (same origin in
     * production), but in local dev the frontend runs on its own static
     * server (e.g. :3000) while the API is on :4000, so a plain
     * `<img src="/uploads/...">` resolves against the *page's* origin and
     * 404s even though the file exists on the API. Resolve it against the
     * API's origin instead — a no-op in the same-origin case, and the fix
     * in the split-origin case. Every screen that renders an uploaded image
     * should go through this rather than using the raw field.
     */
    resolveImageUrl(url) {
        if (!url) return '';
        if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
            return url;
        }
        const apiOrigin = this.apiBaseUrl.replace(/\/api\/?$/, '');
        return `${apiOrigin}${url.startsWith('/') ? '' : '/'}${url}`;
    }

    /**
     * The one place an internal link to a store's storefront gets built.
     * Every store has one address: /<slug> (nextastores.com/<slug> in
     * production). Marketplace cards, product pages, messages, the dashboard
     * and a link a seller shares all use it, so a store never has two
     * different URLs depending on how you got there. It is served by the API
     * (see nextastore-backend/src/routes/seo.js), which sends the real
     * store-detail.html page. Falls back to `?store=<id>` only if a store
     * genuinely has no slug yet.
     */
    storeLink(store) {
        if (!store) return 'marketplace.html';
        if (store.slug) return `/${encodeURIComponent(store.slug)}`;
        return store.id ? `store-detail.html?store=${encodeURIComponent(store.id)}` : 'marketplace.html';
    }

    /** Same as storeLink() for callers that only have the slug (or id) string. */
    storeLinkFor(slugOrId) {
        const key = String(slugOrId || '').trim();
        if (!key) return 'marketplace.html';
        // Slugs are lowercase letters, digits and hyphens. Anything else is an id
        // (or unknown), which the storefront page also accepts as ?store=.
        return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)
            ? `/${key}`
            : `store-detail.html?store=${encodeURIComponent(key)}`;
    }

    /**
     * How a store's public address is shown to a person, and which real URL
     * each action should use. One helper so onboarding, Settings and the
     * post-launch banner can never disagree about what the link looks like.
     *
     * - `display`  what people read: host + slug, no scheme and no path in
     *              between (nextastores.com/amina-crafts). The host comes from
     *              the backend's `publicUrl` (SITE_URL), so when the platform
     *              moves to nextastore.ug this follows it with no frontend
     *              change. Local addresses (localhost, LAN IPs, tunnels) are
     *              never shown as the brand address - those are dev plumbing,
     *              not something a seller should see or think is their link.
     * - `shareUrl` what Copy / WhatsApp put on the clipboard: the backend's
     *              real public URL when it supplied one (works in every
     *              environment), else the branded address.
     * - `openUrl`  where "Preview / View store" goes: the same /<slug> page
     *              everyone else gets, on whatever host this page is on. A
     *              draft store still opens for its owner (the page asks the
     *              API, which knows who is looking).
     */
    storeAddress(slug, publicUrl) {
        const BRAND_HOST = 'nextastores.com';
        const clean = String(slug || '').trim();
        let host = BRAND_HOST;
        try {
            if (publicUrl) {
                const u = new URL(publicUrl);
                const local = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname)
                    || /\.(local|ngrok-free\.dev|ngrok-free\.app|ngrok\.io|trycloudflare\.com)$/.test(u.hostname);
                if (!local) host = u.host;
            }
        } catch { /* malformed publicUrl: keep the brand host */ }
        const path = clean ? `/${encodeURIComponent(clean)}` : '/';
        let shareUrl = `https://${host}${path}`;
        try {
            if (publicUrl && clean) shareUrl = new URL(publicUrl).origin + path;
        } catch { /* keep the branded address */ }
        return {
            host,
            prefix: `${host}/`,
            display: clean ? `${host}${path}` : '',
            shareUrl: clean ? shareUrl : '',
            openUrl: clean ? path : ''
        };
    }

    /**
     * The one place a product's list/grid thumbnail is resolved. Prefers a
     * generated small thumbnail (product.thumbnail, or the first entry of
     * product.thumbnails) over the full-size upload, so marketplace/store
     * grids don't ship full-resolution photos just to show a ~200px card.
     * Falls back to the full image for products saved before thumbnails
     * existed. Product detail pages should keep using the full-size
     * image/gallery directly rather than this helper.
     */
    productThumb(product) {
        if (!product) return '';
        const thumb = product.thumbnail
            || (Array.isArray(product.thumbnails) && product.thumbnails[0])
            || product.image
            || (Array.isArray(product.images) && product.images[0])
            || '';
        return this.resolveImageUrl(thumb);
    }

    formatCurrency(amount) {
        return 'UGX ' + Number(amount || 0).toLocaleString('en-UG');
    }

    formatDate(date) {
        return new Intl.DateTimeFormat('en-UG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }).format(new Date(date));
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
}

// Initialize app
const app = new NextaStoreApp();
