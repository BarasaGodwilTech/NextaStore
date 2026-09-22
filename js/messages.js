class MessagesManager {
    constructor() {
        this.conversations = [];
        this.conversationsPagination = null;
        this.threadPagination = null;
        this.threadMessages = [];
        this.searchQuery = '';
        this.filter = 'all';
        const params = new URLSearchParams(window.location.search); this.activeConversationId = params.get('conversation'); this.focusComposerOnOpen = params.get('focusComposer') === '1'; this.newMessageContext = params.get('store') ? { storeId: params.get('store'), productId: params.get('product') || null, orderId: params.get('order') || null } : null;
        this.pollTimer = null;
        this.maxLength = 2000;
        // Tracks whether opening the current thread pushed a dedicated
        // history entry yet (see pushOrReplaceThreadHistory / handlePopState
        // below) — see those for why this exists.
        this._threadHistoryPushed = false;
        // Guards the in-app back arrow against double-firing. Mobile taps
        // can register two 'click' events in quick succession (a genuine
        // double-tap, or a stray duplicate from the touch layer) — without
        // this, a second click landing before the first has finished
        // closing the thread used to be treated as "close it again", which
        // for history-based closing meant a second history.back() call
        // consuming an extra entry it had no business touching (see
        // goBackFromThread below for how this used to produce the "back
        // sometimes lands on a blank page" bug).
        this._navBusy = false;
        // Request-token counter used by openConversation. MUST start as a
        // number: left undefined, ++undefined is NaN and NaN !== NaN, which
        // made every open bail out before rendering.
        this._openConversationToken = 0;
        // In-memory (never persisted) cache of recently seen threads, so a
        // tap paints instantly and the network only revalidates — see
        // js/thread-cache.js. Null if that script didn't load; every use goes
        // through _cache(), which copes with that.
        this.threadCache = typeof ThreadCache === 'function' ? new ThreadCache({ ownerId: app.user?.id || null }) : null;
        // Which conversation's MESSAGES are currently drawn in the pane (as
        // opposed to merely "selected": a skeleton or error state is
        // selected but not painted), and whose header is drawn.
        this._paintedConversationId = null;
        this._headerConversationId = null;
        this._threadMeta = null;
        // id -> request token of the open/revalidation currently on the wire
        // for that thread. The 8s poll stands down while one is.
        this._revalidating = new Map();
        // Optimistic-send bookkeeping: every message whose network send has
        // not finished yet (across conversations), and the per-conversation
        // promise chains that keep sends in the order they were written.
        this._pendingSends = new Map();
        this._sendChains = new Map();
        this._creatingConversation = false;
        // False until the first conversation-list response lands, so nothing
        // repaints the list (e.g. to clear an unread badge) before there is
        // a list — that would flash "No conversations yet".
        this._conversationsLoaded = false;
        this.init();
    }

    /* Legacy name. Only the first message of a brand-new conversation ever
       blocks another send now (see setCreating); the attach-menu handlers
       still ask "is a send blocking me?" through this. */
    get sending() { return this._creatingConversation; }

    async init() {
        this.syncViewportHeight();
        this.setupEventListeners();
        window.addEventListener('popstate', () => this.handlePopState());
        // The list request is started now but not awaited on the deep-link
        // path: a notification tap used to wait for the whole list before it
        // even began asking for the thread — two round trips in a row. The
        // thread payload carries its own buyer/store/product, so its header
        // no longer needs the list.
        const listLoad = this.loadConversations();
        if (!this.activeConversationId) await listLoad;
        this.updatePaneAccessibility();
        if (this.activeConversationId) {
            // Deep link straight into a conversation (e.g. from a
            // notification). Rewrite this entry to the bare list URL first
            // so opening the thread below pushes a real, dedicated history
            // entry — otherwise a deep link would skip the "close thread"
            // step that opening one from the list gets for free.
            if (history.replaceState) history.replaceState(null, '', 'messages.html');
            await Promise.all([listLoad, this.openConversation(this.activeConversationId)]);
            if (this.focusComposerOnOpen) {
                this.focusComposerOnOpen = false;
                requestAnimationFrame(() => {
                    const input = document.getElementById('threadReplyInput');
                    input?.focus({ preventScroll: true });
                    this.autoResizeInput();
                });
            }
            // Whichever response landed last, the open thread is a read one.
            const openRow = this.conversations.find(c => c.id === this.activeConversationId);
            if (openRow && openRow.unreadCount) { openRow.unreadCount = 0; this.renderConversationList(); }
        } else if (this.newMessageContext) {
            // Same reasoning as the branch above — a "Message seller" deep
            // link (messages.html?store=X&product=Y) is itself the page's
            // very first history entry, so opening the composer needs to
            // push its own dedicated entry too. Without this, hardware/
            // gesture back from a brand-new, not-yet-sent conversation
            // skipped past the list entirely and left the messages page —
            // the same family of bug as the conversation deep-link case.
            if (history.replaceState) history.replaceState(null, '', 'messages.html');
            await this.prepareNewConversation();
        }
        this.pollTimer = setInterval(() => this.poll(), 8000);
        // A backgrounded tab has nobody watching it, so an 8s network poll
        // there is pure waste (battery, data, and a server request nobody
        // benefits from). Pausing while hidden and refreshing immediately on
        // return also means whatever tab the person switches back to is
        // never more than a moment stale.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            } else if (!this.pollTimer) {
                this.poll();
                this.pollTimer = setInterval(() => this.poll(), 8000);
            }
        });
    }

    /* ---- History / back-button handling ----
       Previously this page only ever called history.replaceState, so
       opening a conversation never added a step to browser history.
       Pressing back (hardware back, a swipe-back gesture, or the in-thread
       arrow) therefore skipped straight past the conversation list and
       left the whole messages page — the "back keeps taking me back
       further than expected" bug. Chat apps (WhatsApp Web, Messenger)
       instead treat "thread open" as its own history step: one back closes
       the thread, a second back leaves the page. We push exactly one entry
       the first time a thread (or a brand-new, not-yet-sent conversation)
       is opened, then just replace it while switching between
       conversations, so there's always exactly one step to undo — never a
       stack of stale entries.

       IMPORTANT: the in-app back arrow below (goBackFromThread) does NOT
       use history.back(). It used to, and that's what caused the
       intermittent "back sometimes lands on a blank page" bug on mobile:
       history.back() only closes the thread as a *side effect* of the
       popstate event it triggers, which fires on a later tick — so a
       second tap landing in that gap (a genuine double-tap, or the touch
       layer's own duplicate 'click') fired a *second* history.back()
       before the first had been "used up" by its popstate, walking one
       entry further than intended: off the bottom of this page's own
       history and onto whatever preceded it — often nothing at all in an
       installed PWA/deep-linked tab, which renders as a blank page.
       goBackFromThread() closes the thread immediately and directly
       instead, then flattens the current entry back to the bare list URL
       with replaceState (not by travelling through it), so there is
       nothing left for a stray second tap to over-consume. Hardware back /
       an edge-swipe gesture — which JS can't intercept before it happens —
       still goes through the browser's own real history.back() internally;
       handlePopState is what catches that case and runs the identical
       close routine, so both paths end up in the same state. */
    pushOrReplaceThreadHistory(url) {
        if (!history.pushState) return;
        if (this._threadHistoryPushed) history.replaceState({ nsThread: true }, '', url);
        else { history.pushState({ nsThread: true }, '', url); this._threadHistoryPushed = true; }
    }

    /* Resets every bit of "a thread/composer is open" state and shows the
       conversation list again. Shared by the in-app back button, hardware/
       gesture back (via handlePopState below) and history clean-up — one
       function, always run in full, so the list is never left
       half-restored (the root cause, elsewhere, of a "blank" pane). */
    closeThreadView() {
        this._threadHistoryPushed = false;
        this.activeConversationId = null;
        this.newMessageContext = null;
        this._paintedConversationId = null;
        this._headerConversationId = null;
        document.getElementById('threadView')?.classList.add('hidden');
        document.getElementById('threadEmptyState')?.classList.remove('hidden');
        this.closeThreadMobile();
        this.renderConversationList();
    }

    /* The in-app back arrow's actual handler — see the big comment above
       for why this never calls history.back(). _navBusy guards against a
       stray duplicate tap re-running this before the pane-slide transition
       (and, more importantly, the replaceState below) has settled. */
    goBackFromThread() {
        if (this._navBusy) return;
        this._navBusy = true;
        this.closeThreadView();
        if (history.replaceState) history.replaceState(null, '', 'messages.html');
        setTimeout(() => { this._navBusy = false; }, 350);
    }

    handlePopState() {
        const params = new URLSearchParams(window.location.search);
        const id = params.get('conversation');
        const storeId = params.get('store');
        if (id) {
            if (id !== this.activeConversationId) {
                this._threadHistoryPushed = true;
                this.openConversation(id, { silent: true });
            }
        } else if (storeId) {
            // Forward navigation back into a not-yet-sent "Message seller"
            // compose step (see prepareNewConversation), or landing here
            // fresh via popstate after opening it.
            if (!this.newMessageContext || this.newMessageContext.storeId !== storeId) {
                this._threadHistoryPushed = true;
                this.newMessageContext = { storeId, productId: params.get('product') || null, orderId: params.get('order') || null };
                this.prepareNewConversation({ silent: true });
            }
        } else {
            this.closeThreadView();
        }
    }

    /* ---- Real viewport height, computed once here instead of trusted from
       CSS (dvh/svh) ----
       A plain browser tab and the same page launched as an installed PWA
       resolve `100dvh`/`100svh` to different pixel values on some engines
       for the exact same physical screen — that mismatch is what made the
       shell's height (and therefore what stayed on/off screen) differ
       between the two. Measuring the *visual* viewport ourselves and
       writing it to `--app-vh` (see body.messages-page in css/messages.css)
       makes both environments agree, always, because both now read the
       same JS-computed number instead of each asking the engine to define
       "dynamic viewport" its own way. Also covers the on-screen keyboard on
       browsers that don't honour `interactive-widget=resizes-content`. */
    syncViewportHeight() {
        const vv = window.visualViewport;
        const h = vv ? vv.height : window.innerHeight;
        document.documentElement.style.setProperty('--app-vh', (h / 100) + 'px');
        // iOS Safari can pan the visual viewport down (offsetTop > 0)
        // instead of resizing it when a focused input sits inside a
        // position:fixed ancestor — that's the "focusing search/composer
        // shoves the topbar off the top of the screen" bug. Snapping the
        // real document scroll back to 0 undoes the pan without touching
        // the keyboard or the focused field itself.
        if (vv && vv.offsetTop && document.scrollingElement) {
            document.scrollingElement.scrollTop = 0;
        }
    }

    /* ---- Custom pull-to-refresh ----
       Generic enough to drive both panes (see css/messages.css .ptr-indicator
       for why this has to be hand-rolled instead of relying on the browser's
       native gesture). `container` is the element that actually scrolls;
       `indicator` is its dedicated sibling row that grows to reveal itself;
       `onRelease` is called once the pull clears the threshold and must
       return a Promise — the indicator stays in its "loading" state until
       that resolves (or rejects), then collapses either way. */
    bindPullToRefresh(container, indicator, onRelease) {
        if (!container || !indicator) return;
        const THRESHOLD = 62;
        const MAX_PULL = 92;
        let startY = null;
        let pulling = false;
        let busy = false;

        container.addEventListener('touchstart', e => {
            if (busy || container.scrollTop > 0) { startY = null; return; }
            startY = e.touches[0].clientY;
            pulling = false;
        }, { passive: true });

        container.addEventListener('touchmove', e => {
            if (startY === null || busy) return;
            const dy = e.touches[0].clientY - startY;
            if (dy <= 0) { return; }
            if (container.scrollTop > 0) { startY = null; indicator.style.height = '0px'; return; }
            pulling = true;
            // Rubber-band resistance so the pull feels bounded, not linear.
            const pull = Math.min(MAX_PULL, dy * 0.5);
            indicator.style.height = pull + 'px';
            indicator.classList.toggle('is-ready', pull >= THRESHOLD);
            e.preventDefault();
        }, { passive: false });

        const finish = () => {
            if (!pulling) { startY = null; return; }
            const pulledEnough = indicator.classList.contains('is-ready');
            pulling = false;
            startY = null;
            if (!pulledEnough) { indicator.style.height = '0px'; return; }
            busy = true;
            indicator.classList.remove('is-ready');
            indicator.classList.add('is-loading');
            indicator.style.height = THRESHOLD + 'px';
            Promise.resolve().then(onRelease).catch(() => {}).finally(() => {
                busy = false;
                indicator.classList.remove('is-loading');
                indicator.style.height = '0px';
            });
        };
        container.addEventListener('touchend', finish, { passive: true });
        container.addEventListener('touchcancel', finish, { passive: true });
    }

    setupEventListeners() {
        const form = document.getElementById('threadReplyForm');
        const input = document.getElementById('threadReplyInput');
        form?.addEventListener('submit', e => { e.preventDefault(); this.sendReply(); });
        input?.addEventListener('input', () => { this.updateComposerState(); this.autoResizeInput(); });
        input?.addEventListener('keydown', e => {
            // isComposing guards against IME text composition (accented
            // characters, CJK input methods, predictive keyboards): the
            // Enter that confirms a character choice would otherwise be
            // mistaken for "send" and fire the message mid-composition.
            //
            // On a touch device, Enter is left alone entirely (falls
            // through to the textarea's own default: insert a newline).
            // Touch keyboards don't have a separate physical Enter key the
            // way a desktop does — it's the same on-screen key someone
            // taps constantly while just composing a longer message — so
            // treating it as "send" here meant a phone user trying to
            // start a new paragraph instead fired the message half-written,
            // every time. Sending on a touch device is the Send button's
            // job only; Enter-to-send stays a desktop/hardware-keyboard
            // convenience.
            if (this.isTouchDevice()) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.sendReply();
            }
        });
        this.updateComposerState();

        const searchInput = document.getElementById('conversationSearchInput');
        const searchClear = document.getElementById('conversationSearchClear');
        searchInput?.addEventListener('input', () => {
            this.searchQuery = searchInput.value.trim().toLowerCase();
            searchClear?.classList.toggle('hidden', !searchInput.value);
            this.renderConversationList();
        });
        searchClear?.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            this.searchQuery = '';
            searchClear.classList.add('hidden');
            this.renderConversationList();
            searchInput?.focus();
        });

        document.getElementById('threadBackBtn')?.addEventListener('click', () => this.goBackFromThread());

        /* Conversation rows — ONE delegated set of listeners on the list
           body instead of per-row handlers re-bound on every render (the
           list is rebuilt by innerHTML on every change). Besides the click
           that opens a thread, three intent signals warm the ThreadCache so
           that click paints instantly: a mouse resting on a row (short
           dwell, so sweeping across the list fetches nothing), a finger
           touching down on one (cancelled if it turns into a scroll), and
           keyboard focus. All three only ever PEEK — see prefetchThread. */
        const listBody = document.getElementById('conversationListBody');
        if (listBody) {
            const rowId = el => el && el.closest ? (el.closest('[data-conversation-id]')?.dataset.conversationId || null) : null;
            const HOVER_INTENT_MS = 80;
            const TOUCH_INTENT_MS = 40;
            let hoverTimer = null, hoverId = null, touchTimer = null;
            const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = null; hoverId = null; };
            const cancelTouch = () => { clearTimeout(touchTimer); touchTimer = null; };
            listBody.addEventListener('click', e => { const id = rowId(e.target); if (id) this.openConversation(id); });
            listBody.addEventListener('pointerover', e => {
                if (e.pointerType !== 'mouse') return;
                const id = rowId(e.target);
                if (!id || id === hoverId) return;
                cancelHover();
                hoverId = id;
                hoverTimer = setTimeout(() => { hoverTimer = null; this.prefetchThread(id); }, HOVER_INTENT_MS);
            });
            listBody.addEventListener('pointerout', e => {
                if (e.pointerType !== 'mouse') return;
                const row = e.target.closest ? e.target.closest('[data-conversation-id]') : null;
                if (row && !row.contains(e.relatedTarget)) cancelHover();
            });
            listBody.addEventListener('touchstart', e => {
                const id = rowId(e.target);
                if (!id) return;
                cancelTouch();
                touchTimer = setTimeout(() => { touchTimer = null; this.prefetchThread(id); }, TOUCH_INTENT_MS);
            }, { passive: true });
            ['touchmove', 'touchcancel'].forEach(type => listBody.addEventListener(type, cancelTouch, { passive: true }));
            // Keyboard only: a pointer focusing the row is immediately
            // followed by the click that opens it anyway.
            listBody.addEventListener('focusin', e => {
                const id = rowId(e.target);
                if (id && e.target.matches && e.target.matches(':focus-visible')) this.prefetchThread(id);
            });
        }

        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.dataset.filter === this.filter) return;
                this.filter = tab.dataset.filter;
                document.querySelectorAll('.filter-tab').forEach(t => {
                    const active = t === tab;
                    t.classList.toggle('is-active', active);
                    t.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                this.renderConversationList();
            });
        });

        const threadMessagesEl = document.getElementById('threadMessages');
        threadMessagesEl?.addEventListener('scroll', () => this.updateScrollButton());
        document.getElementById('scrollBottomBtn')?.addEventListener('click', () => {
            threadMessagesEl?.scrollTo({ top: threadMessagesEl.scrollHeight, behavior: 'smooth' });
            this.hasUnseenNewMessages = false;
            this.updateScrollButton();
        });

        // On a phone/tablet's on-screen keyboard, opening it shrinks the
        // *visual* viewport (visualViewport) while the layout viewport
        // (window.innerHeight) stays the same — the page doesn't resize,
        // the keyboard just covers the bottom of it. Without watching
        // visualViewport specifically, the thread's scroll position stayed
        // wherever it was in layout-viewport terms, which put it visually
        // UNDER the keyboard: a reader mid-conversation who tapped the
        // composer would suddenly find the last few messages (and often
        // the composer itself) hidden behind the keyboard until they
        // scrolled manually. Re-anchoring on every visualViewport resize —
        // to the bottom if that's where they already were, otherwise held
        // at the same distance from the new bottom — keeps their place
        // correctly whether the keyboard is opening or closing.
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                if (!threadMessagesEl) return;
                const distanceFromBottom = threadMessagesEl.scrollHeight - threadMessagesEl.scrollTop - threadMessagesEl.clientHeight;
                const wasNearBottom = distanceFromBottom < 40;
                requestAnimationFrame(() => {
                    if (wasNearBottom) threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
                    else threadMessagesEl.scrollTop = Math.max(0, threadMessagesEl.scrollHeight - threadMessagesEl.clientHeight - distanceFromBottom);
                });
            });
        }
        // Delegated (the message list is rebuilt wholesale on every send/poll,
        // so per-card listeners would need re-binding every time) — opens the
        // enlarged in-app map preview instead of leaving the platform.
        threadMessagesEl?.addEventListener('click', e => {
            const card = e.target.closest('.message-location-card');
            if (card) {
                const { lat, lng, label } = card.dataset;
                if (lat && lng) this.openLocationPreview(parseFloat(lat), parseFloat(lng), label);
                return;
            }
            const retryBtn = e.target.closest('[data-retry-message]');
            if (retryBtn) { this.retryMessage(retryBtn.dataset.retryMessage); return; }
            const discardBtn = e.target.closest('[data-discard-message]');
            if (discardBtn) { this.discardMessage(discardBtn.dataset.discardMessage); return; }
        });

        /* ---- Attachment menu ("+" button next to the composer) ----
           A single popover shared by both attachment kinds instead of two
           separate buttons — keeps the composer row from getting crowded
           on narrow phones, and gives room for more attachment kinds later
           without another icon fighting for space next to Send. */
        const attachBtn = document.getElementById('composerAttachBtn');
        attachBtn?.addEventListener('click', e => {
            e.stopPropagation();
            this.toggleAttachMenu();
        });
        document.addEventListener('click', e => {
            const wrap = document.getElementById('composerAttach');
            if (wrap && !wrap.contains(e.target)) this.closeAttachMenu();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closeAttachMenu();
        });

        // Re-evaluate which pane should be inert (see updatePaneAccessibility)
        // whenever the viewport crosses the mobile/desktop breakpoint —
        // rotating a phone/foldable, or resizing a desktop window across
        // it, shouldn't leave a pane stuck inert (or stuck interactive)
        // for the layout it's no longer in.
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.updatePaneAccessibility(), 150);
        });

        // Keep --app-vh (see syncViewportHeight) current on every event that
        // can change the real visible viewport: rotation, the URL bar
        // showing/hiding in a plain browser tab, and the on-screen keyboard.
        window.addEventListener('resize', () => this.syncViewportHeight());
        window.addEventListener('orientationchange', () => this.syncViewportHeight());
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => this.syncViewportHeight());
            window.visualViewport.addEventListener('scroll', () => this.syncViewportHeight());
        }

        // Pull-to-refresh: conversation list (top) re-fetches the latest
        // conversations; an open thread (top) loads older history — same
        // gesture, same indicator, reusing the exact calls the "Load more" /
        // "Load older" buttons already make so nothing about how those
        // requests behave changes, just how they can be triggered.
        this.bindPullToRefresh(
            document.getElementById('conversationList'),
            document.getElementById('convListPtr'),
            () => this.loadConversations({ silent: true, preserveLoaded: true })
        );
        this.bindPullToRefresh(
            document.getElementById('threadMessages'),
            document.getElementById('threadPtr'),
            () => (this.threadPagination?.hasMore ? this.loadOlderMessages() : Promise.resolve())
        );
    }

    /* ---- Mobile single-pane navigation ---- */
    openThreadMobile() {
        document.getElementById('messagesShell')?.classList.add('is-thread-active');
        this.updatePaneAccessibility();
    }
    closeThreadMobile() {
        document.getElementById('messagesShell')?.classList.remove('is-thread-active');
        this.updatePaneAccessibility();
    }

    /* On the mobile single-pane layout, the pane not currently shown is
       still in the DOM — just slid off-screen with a CSS transform, not
       display:none — so without this, a Tab press (external keyboard) or a
       screen reader swipe could still land on conversation rows, or on the
       composer/back button, while they're invisible off to the side. Marks
       whichever pane is off-screen `inert` so it's skipped entirely, same
       as it visually already is. Scoped to the mobile breakpoint only —
       on the two-pane desktop/tablet layout both panes are genuinely
       visible and must stay interactive. */
    updatePaneAccessibility() {
        const shell = document.getElementById('messagesShell');
        if (!shell) return;
        const isMobile = window.matchMedia('(max-width: 880px)').matches;
        const threadActive = shell.classList.contains('is-thread-active');
        document.getElementById('conversationList')?.toggleAttribute('inert', isMobile && threadActive);
        document.getElementById('conversationThread')?.toggleAttribute('inert', isMobile && !threadActive);
    }

    // A primary input whose most precise pointer is coarse (a finger, not
    // a mouse/trackpad) — i.e. a phone or tablet, including a touch
    // laptop's tablet mode. Deliberately not just "window width < 880px":
    // a narrow desktop browser window is still a mouse+keyboard device and
    // should keep Enter-to-send and autofocus; a large-screen tablet held
    // in landscape is still touch-only and should get neither. Cached
    // after the first check since a device's pointer type doesn't change
    // mid-session.
    isTouchDevice() {
        if (this._isTouchDevice === undefined) {
            this._isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
        }
        return this._isTouchDevice;
    }

    // Stealing focus into the composer the instant a thread opens is a
    // desktop nicety (you can start typing right away) and a mobile
    // annoyance (it pops the on-screen keyboard immediately, covering half
    // the thread, before the reader has even finished reading what's
    // there) — so this only actually focuses on a non-touch device.
    focusComposerIfDesktop() {
        if (this.isTouchDevice()) return;
        document.getElementById('threadReplyInput')?.focus();
    }

    autoResizeInput() {
        const input = document.getElementById('threadReplyInput');
        if (!input) return;
        input.style.height = 'auto';
        const max = 140;
        input.style.height = Math.min(input.scrollHeight, max) + 'px';
        // Only show a scrollbar once there's genuinely more text than the
        // capped height can display — otherwise the box shows a scroll
        // affordance (or a sliver of scrollable space) before anyone has
        // typed anything at all, which is what CSS's default overflow-y:
        // hidden on this field is normally there to prevent; this just
        // re-enables scrolling for the one case that actually needs it.
        input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
    }

    updateScrollButton() {
        const container = document.getElementById('threadMessages');
        const btn = document.getElementById('scrollBottomBtn');
        if (!container || !btn) return;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const scrolledUp = distanceFromBottom >= 120;
        btn.classList.toggle('hidden', !scrolledUp);
        // The "new messages" pill only makes sense while actually scrolled
        // away from the bottom — once the reader scrolls back down
        // themselves (independent of tapping this button), there's nothing
        // left to flag, so clear it here too rather than only on click.
        if (!scrolledUp && this.hasUnseenNewMessages) this.hasUnseenNewMessages = false;
        btn.classList.toggle('has-new', scrolledUp && !!this.hasUnseenNewMessages);
        const label = btn.querySelector('.scroll-bottom-btn-label');
        if (label) label.classList.toggle('hidden', !(scrolledUp && this.hasUnseenNewMessages));
    }

    /* ---- Attachment menu ---- */
    toggleAttachMenu(forceOpen) {
        const menu = document.getElementById('composerAttachMenu');
        const btn = document.getElementById('composerAttachBtn');
        if (!menu || !btn) return;
        const willOpen = forceOpen !== undefined ? forceOpen : menu.classList.contains('hidden');
        // Recompute the menu's contents right as it opens rather than
        // trusting whatever was built at thread-load time — app.store (used
        // to decide whether "Share store location" belongs in the list) can
        // still be mid-fetch the instant a thread first opens, since it
        // loads independently of the conversation itself. Rebuilding here
        // guarantees a seller always sees the full, correct option set the
        // moment they actually tap "+", not just after the next 8s poll
        // happens to catch up.
        if (willOpen) this.updateAttachMenu();
        menu.classList.toggle('hidden', !willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        btn.classList.toggle('is-active', willOpen);
    }
    closeAttachMenu() { this.toggleAttachMenu(false); }

    /* Rebuilds the attachment menu's contents for whichever conversation is
       currently open. "Share a product" only ever appears for the seller
       side of a thread — a buyer has no store to share from — so this has
       to be recomputed every time the open conversation changes rather
       than being static markup. */
    updateAttachMenu() {
        const menu = document.getElementById('composerAttachMenu');
        if (!menu) return;
        // The list row when there is one, else the open thread's own payload
        // (same buyer shape) — e.g. a deep link to a conversation older than
        // the first list page, which has no row.
        const conv = this.activeConversationId
            ? (this.conversations.find(c => c.id === this.activeConversationId) || (this._threadMeta && this._threadMeta.id === this.activeConversationId ? this._threadMeta : null))
            : null;
        const isSeller = !!(conv && app.user && conv.buyer?.id !== app.user.id);
        const items = [{ icon: 'fa-location-dot', action: 'location', label: 'Share your location' }];
        // A seller sharing their location almost always means "here's where
        // to find/collect from us" — their store's registered address, not
        // wherever they personally happen to be standing. Only offered once
        // that address actually has map coordinates saved (store settings).
        if (isSeller && this.parseStoreCoordinates(app.store)) items.push({ icon: 'fa-shop', action: 'store-location', label: 'Share store location' });
        if (isSeller) items.push({ icon: 'fa-box-open', action: 'product', label: 'Share a product' });
        menu.innerHTML = items.map(i => `<button type="button" class="attach-menu-item" data-attach-action="${i.action}"><span class="attach-menu-item-icon"><i class="fas ${i.icon}"></i></span><span>${i.label}</span></button>`).join('');
        menu.querySelectorAll('[data-attach-action]').forEach(btn => btn.addEventListener('click', () => {
            this.closeAttachMenu();
            if (btn.dataset.attachAction === 'location') this.shareLocation();
            else if (btn.dataset.attachAction === 'store-location') this.shareStoreLocation();
            else if (btn.dataset.attachAction === 'product') this.openProductPicker();
        }));
    }

    /* Store.mapCoordinates is saved as a free-form "lat,lng" string by the
       existing map picker in store settings — parsed defensively since it
       can be empty or malformed for a store that never set a location. */
    parseStoreCoordinates(store) {
        const raw = store?.mapCoordinates;
        if (!raw || typeof raw !== 'string') return null;
        const [latStr, lngStr] = raw.split(',').map(s => s.trim());
        const lat = parseFloat(latStr), lng = parseFloat(lngStr);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        return { lat, lng };
    }

    /* Shares the seller's own store location (address the shopper can find
       them at), distinct from shareLocation() above which grabs the
       device's live GPS position. Opens the confirm-before-send preview
       rather than sending immediately — see openAttachmentConfirm. */
    async shareStoreLocation() {
        if (this.sending) return;
        const coords = this.parseStoreCoordinates(app.store);
        if (!coords) { app.showAlert('Add your store\u2019s location in Store Settings first.', 'warning'); return; }
        const input = document.getElementById('threadReplyInput');
        const caption = input?.value.trim() || '';
        if (input) { input.value = ''; this.autoResizeInput(); this.updateComposerState(); }
        this.openAttachmentConfirm({
            attachment: { type: 'location', lat: coords.lat, lng: coords.lng, label: app.store?.name ? `${app.store.name} — store location` : 'Store location' },
            defaultCaption: caption
        });
    }

    setAttachEnabled(enabled) {
        const btn = document.getElementById('composerAttachBtn');
        if (btn) btn.disabled = !enabled;
    }

    /* Grabs the device's current position, then opens the confirm-before-
       send preview instead of sending it straight away — a live GPS fix
       shared into a chat is exactly the kind of thing worth a second look
       first (accuracy can be off indoors, or the tap could've been a
       mis-tap on the attach menu). Whatever the sender had already typed
       rides along as the default caption in that preview. */
    async shareLocation() {
        if (this.sending) return;
        if (!navigator.geolocation) { app.showAlert('Location sharing isn\u2019t supported on this device.', 'warning'); return; }
        const input = document.getElementById('threadReplyInput');
        const caption = input?.value.trim() || '';
        app.showAlert('Getting your location\u2026', 'success');
        navigator.geolocation.getCurrentPosition(
            pos => {
                if (input) { input.value = ''; this.autoResizeInput(); this.updateComposerState(); }
                this.openAttachmentConfirm({
                    attachment: { type: 'location', lat: pos.coords.latitude, lng: pos.coords.longitude },
                    defaultCaption: caption
                });
            },
            err => {
                app.showAlert(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Couldn\u2019t get your location. Try again.', 'error');
            },
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
    }

    /* Lets a seller pick one of their own store's products to drop into
       the chat as a rich card. Fetches straight from the store's own
       catalog (GET /products with no storeId resolves to "my store" for
       an authenticated seller — see resolveContextStore on the API side)
       rather than trusting anything about the conversation's existing
       product, since a seller should be able to reference ANY item in
       their collection, not just the one the thread happens to be about. */
    async openProductPicker() {
        document.getElementById('attachProductModal')?.remove();
        const modal = document.createElement('div');
        modal.className = 'attach-product-modal';
        modal.id = 'attachProductModal';
        modal.innerHTML = `<div class="attach-product-panel">
            <div class="attach-product-panel-head">
                <h3>Share a product</h3>
                <button type="button" class="modal-close" aria-label="Close">&times;</button>
            </div>
            <div class="attach-product-search"><i class="fas fa-search" aria-hidden="true"></i><input type="search" placeholder="Search your products" id="attachProductSearch" autocomplete="off"></div>
            <div class="attach-product-list" id="attachProductList"><div class="loading-spinner-inline"><i class="fas fa-spinner fa-spin"></i></div></div>
        </div>`;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('.modal-close').addEventListener('click', close);
        document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });

        let products = [];
        try {
            const r = await app.apiRequest('/products?limit=60&sort=newest');
            products = r.data || [];
        } catch (err) {
            app.showAlert(err.message, 'error');
            close();
            return;
        }

        const listEl = modal.querySelector('#attachProductList');
        const renderList = items => {
            if (!items.length) { listEl.innerHTML = `<div class="empty-state compact"><div class="empty-icon"><i class="fas fa-box-open"></i></div><h3>No products found</h3><p>${products.length ? 'Try a different search.' : 'Add products to your store to share them here.'}</p></div>`; return; }
            listEl.innerHTML = items.map(p => {
                const thumb = app.productThumb(p);
                return `<button type="button" class="attach-product-item" data-product-id="${app.escapeHtml(p.id)}">
                    <span class="attach-product-thumb" ${thumb ? `style="background-image:url('${app.cssUrl(thumb)}')"` : ''}>${thumb ? '' : '<i class="fas fa-box"></i>'}</span>
                    <span class="attach-product-info"><strong>${app.escapeHtml(p.name)}</strong><span>${app.escapeHtml(app.formatCurrency(p.price))}${p.stock === 0 ? ' · Out of stock' : ''}</span></span>
                    <i class="fas fa-chevron-right" aria-hidden="true"></i>
                </button>`;
            }).join('');
            listEl.querySelectorAll('[data-product-id]').forEach(el => el.addEventListener('click', () => {
                const product = products.find(p => p.id === el.dataset.productId);
                close();
                const input = document.getElementById('threadReplyInput');
                const caption = input?.value.trim() || '';
                if (input) { input.value = ''; this.autoResizeInput(); this.updateComposerState(); }
                this.openAttachmentConfirm({
                    attachment: { type: 'product', productId: el.dataset.productId },
                    optimisticProduct: product,
                    defaultCaption: caption
                });
            }));
        };
        renderList(products);
        modal.querySelector('#attachProductSearch').addEventListener('input', e => {
            const q = e.target.value.trim().toLowerCase();
            renderList(q ? products.filter(p => p.name.toLowerCase().includes(q)) : products);
        });
        requestAnimationFrame(() => modal.querySelector('#attachProductSearch')?.focus());
    }

    /* The "here's what you're about to send — send it?" step shared by all
       three attachment flows above. Previously each of them sent as soon
       as a location/product was picked, with no chance to change your
       mind, fix a mis-tap, or add/edit a caption after the fact (only
       whatever was already typed *before* opening the picker rode along).
       This renders the exact same card the recipient will see — via
       messageContentHtml, the very function that builds real message
       bubbles — plus an editable caption field, before anything actually
       goes out. */
    openAttachmentConfirm({ attachment, optimisticProduct = null, defaultCaption = '' }) {
        document.getElementById('attachConfirmModal')?.remove();
        const modal = document.createElement('div');
        modal.className = 'attach-confirm-modal';
        modal.id = 'attachConfirmModal';

        let previewMeta = {};
        if (attachment.type === 'product' && optimisticProduct) {
            previewMeta = { productId: optimisticProduct.id, name: optimisticProduct.name, price: Number(optimisticProduct.price), image: app.productThumb(optimisticProduct), stock: optimisticProduct.stock };
        } else if (attachment.type === 'location') {
            previewMeta = { lat: attachment.lat, lng: attachment.lng, label: attachment.label || null };
        }
        const title = attachment.type === 'product' ? 'Share this product?' : 'Share this location?';
        const cardHtml = this.messageContentHtml({ type: attachment.type, metadata: previewMeta, body: '' });

        modal.innerHTML = `<div class="attach-confirm-panel">
            <div class="attach-confirm-head"><h3>${title}</h3><button type="button" class="modal-close" aria-label="Close">&times;</button></div>
            <div class="attach-confirm-body">
                <div class="attach-confirm-preview">${cardHtml}</div>
                <label class="attach-confirm-caption-label" for="attachConfirmCaption">Add a caption (optional)</label>
                <textarea id="attachConfirmCaption" class="attach-confirm-caption" maxlength="2000" rows="2" placeholder="Type a message\u2026"></textarea>
            </div>
            <div class="attach-confirm-footer">
                <button type="button" class="btn btn-outline" id="attachConfirmCancel">Cancel</button>
                <button type="button" class="btn btn-primary" id="attachConfirmSend"><i class="fas fa-paper-plane"></i> Send</button>
            </div>
        </div>`;
        document.body.appendChild(modal);

        const captionInput = modal.querySelector('#attachConfirmCaption');
        captionInput.value = defaultCaption;
        // Fills in the actual map tiles, same as a real thread message —
        // reuses the exact same rendering pass, not a separate one.
        if (attachment.type === 'location') this.renderLocationPreviews(modal);
        // The card itself can still be tapped to sanity-check the pin
        // before committing, exactly like a real message bubble would.
        modal.querySelector('.attach-confirm-preview')?.addEventListener('click', e => {
            const card = e.target.closest('.message-location-card');
            if (!card || !card.dataset.lat) return;
            this.openLocationPreview(parseFloat(card.dataset.lat), parseFloat(card.dataset.lng), card.dataset.label);
        });

        // Cancelling doesn't discard whatever caption was typed in this
        // dialog — it goes back into the main composer so the person
        // doesn't have to retype it if they just wanted to back out of the
        // attachment itself, not the message.
        const restoreCaptionToComposer = () => {
            const composer = document.getElementById('threadReplyInput');
            const typed = captionInput.value.trim();
            if (composer && typed) {
                composer.value = typed;
                this.autoResizeInput();
                this.updateComposerState();
            }
        };
        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) { restoreCaptionToComposer(); close(); } });
        modal.querySelector('.modal-close').addEventListener('click', () => { restoreCaptionToComposer(); close(); });
        modal.querySelector('#attachConfirmCancel').addEventListener('click', () => { restoreCaptionToComposer(); close(); });
        document.addEventListener('keydown', function onEsc(e) {
            if (e.key !== 'Escape') return;
            // If the enlarged map preview is open on top of this dialog
            // (via the click handler just above), let ITS OWN Escape
            // handler close just that first — otherwise both close at
            // once, which reads as this whole confirmation getting
            // dismissed by an Escape that was only meant to back out of
            // the bigger map.
            if (document.getElementById('locationPreviewModal')) return;
            restoreCaptionToComposer();
            close();
            document.removeEventListener('keydown', onEsc);
        });
        modal.querySelector('#attachConfirmSend').addEventListener('click', () => {
            const body = captionInput.value.trim();
            close();
            this.sendMessagePayload({ body, attachment, optimisticProduct });
        });

        requestAnimationFrame(() => captionInput.focus());
    }

    /* Renders every not-yet-rendered map slot currently in the DOM (small
       in-bubble previews and, via a direct call, the enlarged modal).
       Pulled out into its own pass rather than rendered inline in the HTML
       string builders because NextaStoreMapPreview needs a real, laid-out
       element to measure and stitch tiles into — it can't be expressed as
       a string of markup the way the rest of a message bubble is.
       Uses OpenStreetMap raster tiles directly (same module as the
       storefront/order-detail map previews) instead of embedding OSM's
       own slippy-map page in an iframe, which is what was dragging that
       page's zoom controls and "Report a problem" / donate / API-terms
       links into a 120px-tall bubble. */
    renderLocationPreviews(root = document) {
        root.querySelectorAll('.message-location-preview[data-map-lat]:not([data-rendered])').forEach(el => {
            const lat = parseFloat(el.dataset.mapLat), lng = parseFloat(el.dataset.mapLng);
            if (Number.isNaN(lat) || Number.isNaN(lng)) return;
            window.NextaStoreMapPreview?.render(el, { lat, lng, zoom: 15, width: el.clientWidth || 300, height: el.clientHeight || 120 });
            el.dataset.rendered = '1';
        });
    }

    /* Enlarges a shared-location card in place instead of sending the person
       straight to Google Maps in a new tab. "Open in Google Maps" inside
       this modal is still there for whoever actually wants turn-by-turn
       directions, but now that's a deliberate tap on its own, not a side
       effect of just wanting a bigger look at the pin. */
    openLocationPreview(lat, lng, label) {
        document.getElementById('locationPreviewModal')?.remove();
        const modal = document.createElement('div');
        modal.className = 'location-preview-modal';
        modal.id = 'locationPreviewModal';
        const safeLabel = app.escapeHtml(label || 'Shared location');
        const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
        modal.innerHTML = `<div class="location-preview-panel">
            <div class="location-preview-head"><h3>${safeLabel}</h3><button type="button" class="modal-close" aria-label="Close">&times;</button></div>
            <div class="location-preview-map" id="locationPreviewMap"></div>
            <div class="location-preview-footer">
                <a class="btn btn-outline" href="${mapsUrl}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Open in Google Maps</a>
            </div>
        </div>`;
        document.body.appendChild(modal);
        const mapSlot = modal.querySelector('#locationPreviewMap');
        // FIX: `mapsUrl` is deliberately NOT passed to render() here.
        // NextaStoreMapPreview lays a full-bleed <a target="_blank"> over
        // the whole map whenever it's given a mapsUrl (see map-preview.js —
        // it's meant for the small, non-interactive previews elsewhere in
        // the app that have no modal of their own to expand into). Passing
        // it here meant tapping *anywhere on the enlarged map itself* —
        // inside the very modal whose whole point is staying in the app —
        // silently redirected to Google Maps in a new tab. The explicit
        // "Open in Google Maps" button below is the only way out now, same
        // as the comment on this modal already promised.
        if (mapSlot) window.NextaStoreMapPreview?.render(mapSlot, { lat, lng, zoom: 16, width: mapSlot.clientWidth || 400, height: mapSlot.clientHeight || 300 });
        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('.modal-close').addEventListener('click', close);
        document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
    }

    /* Renders a single message's inner content — a plain text bubble, or a
       rich card for a product/location attachment (with an optional
       typed caption underneath, when the sender added one). Also reused,
       unmodified, to render the "here's what you're about to send" preview
       in openAttachmentConfirm() — it only ever reads m.type/metadata/body,
       nothing message-specific, so a not-yet-sent draft object works here
       exactly like a real message does. */
    messageContentHtml(m) {
        const meta = m.metadata || {};
        if (m.type === 'product') {
            // meta.image is a raw path snapshotted server-side (e.g.
            // "/uploads/xyz.jpg") — it has to go through resolveImageUrl
            // like every other uploaded image, or it 404s whenever the
            // frontend and API run on different origins/ports (exactly the
            // local dev setup this project ships with).
            const image = meta.image ? app.resolveImageUrl(meta.image) : '';
            const caption = m.body ? `<div class="attachment-caption">${app.escapeHtml(m.body)}</div>` : '';
            const outOfStock = meta.stock === 0;
            return `<a class="message-product-card" href="product-detail.html?id=${encodeURIComponent(meta.productId || '')}" target="_blank" rel="noopener">
                <span class="message-product-thumb" ${image ? `style="background-image:url('${app.cssUrl(image)}')"` : ''}>${image ? '' : '<i class="fas fa-box"></i>'}</span>
                <span class="message-product-info">
                    <span class="message-product-eyebrow"><i class="fas fa-box-open" aria-hidden="true"></i>Shared product</span>
                    <strong>${app.escapeHtml(meta.name || 'Product')}</strong>
                    <span class="message-product-bottom"><span class="message-product-price">${app.escapeHtml(app.formatCurrency(meta.price || 0))}</span>${outOfStock ? '<span class="message-product-oos">Out of stock</span>' : ''}</span>
                </span>
                <span class="message-card-go" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
            </a>${caption}`;
        }
        if (m.type === 'location') {
            const lat = meta.lat, lng = meta.lng;
            const hasCoords = typeof lat === 'number' && typeof lng === 'number';
            const caption = m.body ? `<div class="attachment-caption">${app.escapeHtml(m.body)}</div>` : '';
            const label = meta.label ? app.escapeHtml(meta.label) : 'Shared location';
            // A button, not a link that opens Google Maps in a new tab —
            // tapping this only enlarges the map in place (openLocationPreview);
            // leaving the platform is now an explicit choice made from
            // inside that preview (see the fix note there), never the
            // default outcome of a tap here or in that preview. The label
            // and "tap to view" hint are laid over the map itself (a
            // bottom scrim, like a real map app's pin card) instead of
            // sitting underneath in a separate plain row — reads as one
            // cohesive location card instead of a map thumbnail with a
            // caption stapled on.
            //
            // The expand icon and scrim are siblings of
            // `.message-location-preview`, NOT children of it — that inner
            // span is the exact element renderLocationPreviews() hands to
            // NextaStoreMapPreview.render(), which does a full
            // `container.innerHTML = …` to lay in the stitched map tiles.
            // Nesting the overlay badges inside it would just get them
            // wiped out the instant the map finishes rendering.
            return `<button type="button" class="message-location-card" ${hasCoords ? `data-lat="${lat}" data-lng="${lng}"` : ''} data-label="${label}">
                <span class="message-location-media">
                    <span class="message-location-preview" ${hasCoords ? `data-map-lat="${lat}" data-map-lng="${lng}"` : ''}>${hasCoords ? '' : '<span class="message-location-pin"><i class="fas fa-location-dot"></i></span>'}</span>
                    <span class="message-location-expand" aria-hidden="true"><i class="fas fa-expand"></i></span>
                    <span class="message-location-scrim">
                        <span class="message-location-pin-badge"><i class="fas fa-location-dot"></i></span>
                        <span class="message-location-text"><strong>${label}</strong><span>${hasCoords ? 'Tap to view full map' : 'Location unavailable'}</span></span>
                    </span>
                </span>
            </button>${caption}`;
        }
        return `<span>${app.escapeHtml(m.body)}</span>`;
    }


    async prepareNewConversation({ silent = false } = {}) {
        try {
            const r = await app.apiRequest(`/store/public/${encodeURIComponent(this.newMessageContext.storeId)}`);
            const store = r.data; const productId=this.newMessageContext.productId;
            document.getElementById('threadEmptyState')?.classList.add('hidden'); document.getElementById('threadView')?.classList.remove('hidden');
            // No conversation exists yet, so there's no "conversation:<id>"
            // key for this thread — watch/seed the store instead (the same
            // "store:<slug>" key store-detail.js uses), same as any other
            // signed-out-visible seller status.
            const presenceKey = store.slug ? `store:${store.slug}` : null;
            const presenceDot = presenceKey ? `<span class="presence-dot" data-presence-key="${presenceKey}" data-presence-dot aria-hidden="true"></span>` : '';
            const presenceLabel = presenceKey ? `<span class="thread-header-status" data-presence-key="${presenceKey}" data-presence-label></span>` : '';
            const avatar = store.logo ? `<span class="thread-header-avatar" style="background-image:url('${app.cssUrl(app.resolveImageUrl(store.logo))}')">${presenceDot}</span>` : `<span class="thread-header-avatar"><i class="fas fa-store"></i>${presenceDot}</span>`;
            // A brand-new, not-yet-sent conversation is still with a real
            // store — tapping the name/avatar takes the shopper to that
            // store's page, same as an already-open thread (see
            // renderThread). The subtitle here always has something
            // meaningful to say ("About a product" / "New conversation" /
            // an order reference), so — unlike renderThread — there's no
            // redundant-store-name case to guard against.
            const storeKey = store.slug || store.id;
            document.getElementById('threadHeader').innerHTML = `<a class="thread-header-identity" href="store-detail.html?store=${encodeURIComponent(storeKey)}" aria-label="Open ${app.escapeHtml(store.name)}'s store">${avatar}<div><strong>${app.escapeHtml(store.name)}</strong><span>${productId ? 'About a product' : 'New conversation'}${this.newMessageContext.orderId ? ` · Order #${app.escapeHtml(this.newMessageContext.orderId)}` : ''}</span>${presenceLabel}</div></a>`;
            if (window.NextaPresence && presenceKey) {
                window.NextaPresence.setWatch([...this.conversations.map(c => `conversation:${c.id}`), presenceKey]);
                // Note: this still needs its own network round trip — the
                // /store/public response above
                // doesn't carry presence, and there is no live stream
                // watching a brand-new store key until setWatch (just
                // above) reopens one — a one-off seed is what makes the
                // dot show anything before that snapshot lands.
                app.apiRequest(`/presence/store/${encodeURIComponent(store.slug)}`)
                    .then(res => { if (res?.data) window.NextaPresence.seed(presenceKey, res.data); })
                    .catch(() => { /* presence is a nice-to-have here; the header just shows nothing */ });
            }
            // A first message to this store that failed before the
            // conversation even existed yet is persisted under a
            // store+product key (see loadFailedMessagesFor) rather than a
            // conversation id, since there was no conversation id to key it
            // on at send time. Reattach it here so reopening (or reloading)
            // this same "message seller" link shows the failed bubble with
            // its Resend/Delete controls instead of it just being gone.
            this.threadMessages = this.loadFailedMessagesFor(null, this.newMessageContext);
            this._paintedConversationId = null;
            this._headerConversationId = null;
            this._threadMeta = null;
            const container = document.getElementById('threadMessages');
            if (this.threadMessages.length) {
                this.paintThreadMessages(container);
            } else {
                container.innerHTML = `<div class="new-conversation-prompt"><i class="fas fa-message"></i><h3>Message ${app.escapeHtml(store.name)}</h3><p>Your message will open a conversation with this seller.</p></div>`;
            }
            this.updateComposerState();
            this.updateAttachMenu();
            this.setAttachEnabled(true);
            if (!silent) this.pushOrReplaceThreadHistory(`messages.html?store=${encodeURIComponent(this.newMessageContext.storeId)}${productId ? `&product=${encodeURIComponent(productId)}` : ''}${this.newMessageContext.orderId ? `&order=${encodeURIComponent(this.newMessageContext.orderId)}` : ''}`);
            this.openThreadMobile();
            this.focusComposerIfDesktop();
        } catch (e) { if (!silent) app.showAlert(e.message, 'error'); }
    }

    async poll() {
        // preserveLoaded: a background poll re-fetches everything already
        // loaded (not just the first 20) and reconstructs an equivalent
        // page/limit for "Load more" — otherwise the very next 8s tick
        // after someone clicked "Load more" once (or several times) would
        // quietly collapse their expanded list back down to page one,
        // discarding conversations that were on screen a moment ago with
        // no warning and no scroll-position excuse for it.
        await this.loadConversations({ silent: true, preserveLoaded: true });
        if (this.activeConversationId) await this.pollActiveThread();
    }

    /* Cheap signature of "what would actually look different on screen" —
       just the fields renderConversationList reads — used to skip a poll's
       repaint entirely when nothing has changed. A full innerHTML rebuild
       every 8s regardless of whether anything moved was wasted work every
       single tick (the overwhelmingly common case, most polls land on a
       quiet inbox), and worse than just wasteful: it also blew away
       anything transient sitting in that DOM at the moment, e.g. a
       "Couldn't load / Try again" retry button state or an in-progress
       :hover/:focus a screen reader or keyboard user had landed on. */
    _conversationsSignature(list) {
        return JSON.stringify(list.map(c => [c.id, c.unreadCount, c.updatedAt, c.lastMessage?.id, c.lastMessage?.body, c.lastMessage?.type, c.lastMessage?.createdAt]));
    }

    /* Feeds presence.js from a conversation list response: each
       conversation already carries the counterpart's { online,
       lastActiveAt } (see routes/messages.js), which seeds the state map
       as a fallback for whenever the live stream isn't up yet or is
       blocked; and the full id list becomes the watch set, so the stream
       (opened by presence.js itself, on every signed-in page) reports back
       on exactly the people whose conversations are currently on screen.
       Safe to call every poll tick — setWatch() only reopens the stream
       when the id list actually changed. */
    updatePresenceFromConversations(list) {
        if (!window.NextaPresence) return;
        list.forEach(c => { if (c.presence) window.NextaPresence.seed(`conversation:${c.id}`, c.presence); });
        window.NextaPresence.setWatch(list.map(c => `conversation:${c.id}`));
    }

    async loadConversations({ silent = false, page = 1, append = false, preserveLoaded = false } = {}) {
        const body = document.getElementById('conversationListBody');
        try {
            let data, pagination;
            if (preserveLoaded && this.conversations.length && this.conversationsPagination) {
                const loadedPages = Math.max(1, this.conversationsPagination.page || 1);
                // preserveLoaded is only ever true from poll()'s background
                // refresh (see the one call site above) — never from an
                // actual click or page load — so this is exactly the
                // "proves a tab is open, not that a person is doing
                // anything" case X-Background-Poll exists for (finding 5).
                const response = await app.apiRequest(`/messages/conversations?page=1&limit=${loadedPages * 20}`, { headers: { 'X-Background-Poll': '1' } });
                data = response.data || [];
                const total = response.pagination?.total ?? data.length;
                // Reconstructed in terms of the normal 20-per-page paging
                // (rather than the bigger one-shot limit just used) so
                // "Load more" and its hasMore check stay in terms
                // renderConversationList already understands.
                pagination = { page: loadedPages, limit: 20, total, pages: Math.ceil(total / 20) || 1 };
            } else {
                const response = await app.apiRequest(`/messages/conversations?page=${page}&limit=20`);
                data = response.data || [];
                pagination = response.pagination || null;
            }

            const merged = append ? [...this.conversations, ...data] : data;
            // Seed + (re)watch presence from whatever the list just
            // returned, regardless of which branch below actually
            // repaints — a poll that finds nothing else changed (the
            // signature check just below) still carries fresh presence,
            // and skipping this here would mean it's only ever applied on
            // a full render.
            this.updatePresenceFromConversations(merged);
            if (preserveLoaded) {
                const nextSig = this._conversationsSignature(merged);
                if (nextSig === this._lastConversationsSignature) {
                    this.conversations = merged;
                    this.conversationsPagination = pagination;
                    this._conversationsLoaded = true;
                    return;
                }
                this._lastConversationsSignature = nextSig;
            } else {
                this._lastConversationsSignature = this._conversationsSignature(merged);
            }
            this.conversations = merged;
            this.conversationsPagination = pagination;
            this._conversationsLoaded = true;
            this.renderConversationList();
        } catch (error) {
            if (!silent && body) {
                body.innerHTML = `<div class="empty-state compact"><div class="empty-icon"><i class="fas fa-circle-exclamation"></i></div><h3>Couldn’t load messages</h3><p>${app.escapeHtml(error.message)}</p><button type="button" class="btn btn-outline btn-sm" id="retryMessagesBtn">Try again</button></div>`;
                document.getElementById('retryMessagesBtn')?.addEventListener('click', () => this.loadConversations());
            }
            // A silent background poll failing shouldn't interrupt anyone
            // or spam a toast every 8s — same reasoning as
            // pollActiveThread's catch below; the next tick just retries.
        }
    }

    /* Short, human line for a conversation's last message in the list —
       mirrors previewText() on the backend (used for notification bodies)
       so the same message reads the same way in both places. A product or
       location attachment sent with no typed caption has an empty `body`;
       showing that raw empty string used to render as "No messages yet"
       even though a message plainly had been sent — this describes the
       attachment itself instead. */
    previewText(message) {
        const { body, type, metadata } = message;
        if (type === 'product') return `Shared a product${metadata?.name ? `: ${metadata.name}` : ''}`;
        if (type === 'location') return `Shared a location${metadata?.label ? `: ${metadata.label}` : ''}`;
        return body || 'No messages yet';
    }

    previewHtml(message) {
        const { type } = message;
        const preview = this.previewText(message);
        const icon = type === 'product'
            ? '<i class="fas fa-box" aria-hidden="true"></i>'
            : type === 'location'
                ? '<i class="fas fa-location-dot" aria-hidden="true"></i>'
                : '';
        return `${icon}${icon ? ' ' : ''}${app.escapeHtml(preview)}`;
    }

    relativeTime(value) {
        if (!value) return '';
        const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
        const abs = Math.abs(seconds);
        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        if (abs < 60) return rtf.format(seconds, 'second');
        if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
        if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
        return app.formatDate(value);
    }

    /* "Today" / "Yesterday" / weekday / date label used for thread day dividers. */
    formatDayLabel(value) {
        const d = new Date(value);
        const now = new Date();
        const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString('en-UG', { weekday: 'long' });
        return d.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }

    updateTotalBadge() {
        const badge = document.getElementById('conversationTotalBadge');
        if (!badge) return;
        const total = this.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        if (total > 0) { badge.textContent = `${total > 99 ? '99+' : total} unread`; badge.classList.remove('hidden'); }
        else { badge.classList.add('hidden'); }
    }

    renderConversationList() {
        const body = document.getElementById('conversationListBody');
        if (!body) return;
        if (!this._conversationsLoaded) return;   // never paint "No conversations yet" before the first list response
        this.updateTotalBadge();
        if (!this.conversations.length) {
            body.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="fas fa-comments"></i></div><h3>No conversations yet</h3><p>${app.user?.role === 'seller' ? 'When shoppers message your store, their conversations will appear here.' : 'Open a product or store and choose “Message seller” to start a conversation.'}</p><a href="marketplace.html" class="btn btn-primary btn-sm">Browse marketplace</a></div>`;
            return;
        }

        const query = this.searchQuery;
        const matches = c => {
            if (this.filter === 'unread' && !(c.unreadCount > 0)) return false;
            if (!query) return true;
            const buyerView = app.user && c.buyer?.id === app.user.id;
            const title = (buyerView ? c.store?.name : (c.buyer?.name || c.store?.name)) || '';
            const haystack = `${title} ${c.lastMessage ? this.previewText(c.lastMessage) : ''} ${c.product?.name || ''}`.toLowerCase();
            return haystack.includes(query);
        };
        const list = this.conversations.filter(matches);

        if (!list.length) {
            if (query) {
                body.innerHTML = `<div class="empty-state compact conversation-search-empty"><div class="empty-icon"><i class="fas fa-magnifying-glass"></i></div><h3>No matches</h3><p>No conversations match “${app.escapeHtml(this.searchQuery)}”.</p></div>`;
            } else {
                body.innerHTML = `<div class="empty-state compact conversation-search-empty"><div class="empty-icon"><i class="fas fa-check-double"></i></div><h3>All caught up</h3><p>You have no unread conversations.</p></div>`;
            }
            return;
        }

        body.innerHTML = list.map(c => {
            const buyerView = app.user && c.buyer?.id === app.user.id;
            const title = buyerView ? c.store?.name : (c.buyer?.name || c.store?.name || 'Conversation');
            const avatar = buyerView ? c.store?.logo : null;
            const productThumb = c.product ? app.productThumb(c.product) : '';
            const preview = c.lastMessage ? this.previewText(c.lastMessage) : 'No messages yet';
            // Only a real message has a meaningful "time of last message" —
            // falling back to the conversation's own updatedAt (its
            // creation time, effectively) produced a contradictory "No
            // messages yet · 14 minutes ago", as if a message had in fact
            // been sent 14 minutes ago. No message yet means no timestamp.
            const ts = c.lastMessage?.createdAt || null;
            return `<button type="button" class="conversation-item ${c.id === this.activeConversationId ? 'active' : ''} ${c.unreadCount > 0 ? 'is-unread' : ''}" data-conversation-id="${app.escapeHtml(c.id)}" aria-current="${c.id === this.activeConversationId ? 'true' : 'false'}">
                <span class="conversation-item-thumb" ${avatar ? `style="background-image:url('${app.cssUrl(app.resolveImageUrl(avatar))}')"` : ''}>${avatar ? '' : `<i class="fas ${buyerView ? 'fa-store' : 'fa-user'}"></i>`}<span class="presence-dot" data-presence-key="conversation:${app.escapeHtml(c.id)}" data-presence-dot aria-hidden="true"></span></span>
                <span class="conversation-item-info">
                    <span class="conversation-item-topline"><span class="conversation-item-name">${app.escapeHtml(title)}</span><time>${app.escapeHtml(this.relativeTime(ts))}</time></span>
                    ${c.product ? `<span class="conversation-product-context">${productThumb ? `<span class="conversation-product-thumb" style="background-image:url('${app.cssUrl(productThumb)}')"></span>` : '<i class="fas fa-box"></i>'}<span>${app.escapeHtml(c.product.name)}</span></span>` : ''}
                    <span class="conversation-item-preview">${c.lastMessage ? this.previewHtml(c.lastMessage) : app.escapeHtml(preview)}</span>
                </span>
                ${c.unreadCount > 0 ? `<span class="conversation-unread-count" aria-label="${c.unreadCount} unread">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : ''}
            </button>`;
        }).join('') + (!query && this.conversationsPagination?.page < this.conversationsPagination?.pages
            ? '<button type="button" class="btn btn-outline btn-sm messages-load-more" id="messagesLoadMore">Load more conversations</button>' : '');

        // Row clicks / prefetch intents are delegated from #conversationListBody (see setupEventListeners) — nothing to re-bind per render.
        document.getElementById('messagesLoadMore')?.addEventListener('click', () => {
            this.loadConversations({ page: (this.conversationsPagination?.page || 1) + 1, append: true });
        });
    }

    /* ---- Opening a thread: paint first, then revalidate ----
       The old flow was "fire the request, draw NOTHING until it (and then a
       second, unrelated badge request) came back, and only then slide the
       pane in" — a blank beat on every tap that is exactly as long as the
       person's connection is slow. Now, in this order, all on the tap's own
       frame:
         1. the pane opens and the history entry is pushed;
         2. the thread is painted from the in-memory ThreadCache if it has
            been seen (or prefetched) — otherwise from the conversation
            list's own data, as a header plus skeleton bubbles, so the
            composer is usable at once;
         3. the row's unread badge clears locally.
       THEN the network runs: a normal (non-peek) GET, which is what marks
       the thread read on the server, and its result is reconciled into
       what's on screen with no flicker (see renderThread's 'revalidate'
       mode). The unread-badge refresh no longer sits in front of any of it.

       modes:  foreground (default)  a person opened it — everything above
               background: true      the poll loop's fallback reload — the
                                     thread is already on screen, so only
                                     revalidate; never touches history,
                                     panes, or the session-renewal clock
               keepCurrent: true     promoting the "message seller" compose
                                     screen into its just-created thread —
                                     don't swap the visible messages for a
                                     skeleton while the fetch runs. */
    async openConversation(id, { silent = false, background = false, keepCurrent = false } = {}) {
        // A monotonically increasing token — the single source of truth for
        // "is this specific call to openConversation still the one that
        // matters". Id-equality alone can't tell two calls for the SAME
        // conversation apart (leave A, reopen A while a slower earlier
        // request for A is still out): the stale one used to be able to land
        // after the fresh one and overwrite it with older data. Every call
        // bumps this and captures its own value; only the call whose token
        // still matches when its request resolves may render.
        const requestToken = ++this._openConversationToken;
        const alreadyShown = this._paintedConversationId === id && this.activeConversationId === id;
        const switching = this.activeConversationId !== id;
        this.activeConversationId = id;
        const cache = this._cache();

        if (!background) {
            if (switching) this.hasUnseenNewMessages = false;
            const conv = this.conversations.find(c => c.id === id);
            if (!alreadyShown) {
                const cached = cache ? cache.get(id) : null;
                if (cached) {
                    this.renderThread(cached.data, { mode: 'open', fromCache: true });
                } else {
                    if (!keepCurrent) this.renderThreadSkeleton(id, conv);
                    // A hover/touchstart prefetch for this thread may already
                    // be on the wire. Paint from it the moment it lands —
                    // unless the real request below beats it, in which case
                    // there is nothing left to paint.
                    const inflight = cache ? cache.inflight(id) : null;
                    if (inflight) {
                        inflight.then(data => {
                            if (data && requestToken === this._openConversationToken && this._paintedConversationId !== id) {
                                this.renderThread(data, { mode: 'open', fromCache: true });
                            }
                        });
                    }
                }
            }
            if (!silent) this.pushOrReplaceThreadHistory(`messages.html?conversation=${encodeURIComponent(id)}`);
            this.openThreadMobile();
            // Opening a thread reads it — clear the row's badge now rather
            // than after the round trip. The real GET below is what makes it
            // true on the server; if that fails, the next list poll restores
            // the honest count.
            if (conv) conv.unreadCount = 0;
            this.renderConversationList();
        }

        this._revalidating.set(id, requestToken);
        try {
            // `background` is only set by the poll loop's fallback reload: a
            // reload the tab does on its own is not the person doing
            // anything, so it must not renew the session.
            const data = await this._fetchThread(id, { background, timeoutMs: 20000 });
            if (requestToken !== this._openConversationToken || this.activeConversationId !== id) return;
            const firstPaint = this._paintedConversationId !== id;
            if (cache) cache.set(id, data);
            // Anchors the incremental poll (see pollActiveThread) to this
            // exact moment on the SERVER's clock and to this conversation,
            // so the very next 8s tick can ask for "what's new since here"
            // instead of re-fetching the whole thread again.
            this.threadSince = data.pagination?.serverTime || null;
            this.threadSinceConversationId = id;
            this.renderThread(data, { mode: firstPaint ? 'open' : 'revalidate' });
            // cache.set() above stored the bare latest page; what's on screen
            // may also hold older history the reader loaded — re-sync so the
            // cache never shrinks below what was shown.
            this._syncThreadCache();
            const conv = this.conversations.find(c => c.id === id);
            if (conv && conv.unreadCount) { conv.unreadCount = 0; this.renderConversationList(); }
            // The server marked this thread's bell notification read when it
            // served the GET — mirror that in the open bell panel too.
            if (app.notifications) app.notifications.settleByLink(`messages.html?conversation=${id}`);
            // Fire and forget: the badges are a nicety, never a gate.
            app.refreshUnreadBadges();
        } catch (error) {
            if (requestToken !== this._openConversationToken) return;
            // A definitive "no" (deleted, or not yours any more) beats any
            // cached copy: drop it and say so.
            if (error && (error.status === 404 || error.status === 403)) {
                if (cache) cache.delete(id);
                this.renderThreadError(id, error);
                return;
            }
            // Otherwise (network blip, timeout): if the thread is already on
            // screen — from cache, or a background reload of an open one —
            // keep showing it; the poll retries in 8s. Only when there is
            // nothing to fall back on does the pane show an error.
            if (this._paintedConversationId === id) return;
            this.renderThreadError(id, error);
        } finally {
            if (this._revalidating.get(id) === requestToken) this._revalidating.delete(id);
        }
    }

    /* ThreadCache access. setOwner() runs on every touch so a different
       signed-in user id (account switch, session ended and another began)
       drops everything before it can be read. */
    _cache() {
        if (!this.threadCache) return null;
        this.threadCache.setOwner(app.user?.id || null);
        return this.threadCache;
    }

    /* One place that knows how to ask the server for a thread.
       peek: true is the prefetch form — GET .../peek is the server's
       side-effect-free twin (it does not mark messages read: a hover is not
       a read; and an older server without the route 404s, harmlessly), and
       the request is flagged as background traffic so it can't renew the
       session either. */
    async _fetchThread(id, { background = false, peek = false, timeoutMs = 20000 } = {}) {
        const response = await app.apiRequest(
            `/messages/conversations/${encodeURIComponent(id)}${peek ? '/peek' : ''}`,
            { timeoutMs, ...((background || peek) ? { headers: { 'X-Background-Poll': '1' } } : {}) }
        );
        return response.data;
    }

    /* Event-driven prefetch — called on a mouse dwell, a touch-down, or
       keyboard focus on a conversation row (see setupEventListeners) and on
       a bell notification that points at a thread. Warms the ThreadCache so
       the tap that (usually) follows paints instantly. Cheap by design:
       skipped when the thread is already on screen or fresh in the cache,
       when one is already in flight, when at most two others are, when the
       tab is hidden or offline, and on Data Saver / 2G connections. */
    prefetchThread(id) {
        const cache = this._cache();
        if (!cache || !id || !app.token) return;
        if (id === this.activeConversationId && this._paintedConversationId === id) return;
        if (cache.isFresh(id) || cache.inflight(id) || cache.inflightCount >= 2) return;
        if (!this._prefetchAllowed()) return;
        cache.prefetch(id, () => this._fetchThread(id, { peek: true, timeoutMs: 8000 }));
    }

    _prefetchAllowed() {
        if (document.hidden || navigator.onLine === false) return false;
        const connection = navigator.connection;
        if (connection && (connection.saveData || /(^|-)2g$/.test(connection.effectiveType || ''))) return false;
        return true;
    }

    /* Shown while a thread that isn't cached is loading. The header comes
       straight from the conversation list's own data (so it is right at
       once); the body is a few shimmering bubbles. Deliberately clears
       this.threadMessages: a message sent from here must be appended to THIS
       conversation's (empty-for-now) list, not to whatever thread was open
       a moment ago. */
    renderThreadSkeleton(id, conv) {
        document.getElementById('threadEmptyState')?.classList.add('hidden');
        document.getElementById('threadView')?.classList.remove('hidden');
        const header = document.getElementById('threadHeader');
        if (conv) {
            this.renderThreadHeader({ id, store: conv.store, buyer: conv.buyer, product: conv.product }, conv);
        } else if (header) {
            header.innerHTML = '<div class="thread-header-identity"><span class="thread-header-avatar skeleton"></span><div><strong class="thread-skeleton-title skeleton"></strong></div></div>';
            this._headerConversationId = null;
        }
        const container = document.getElementById('threadMessages');
        if (container) {
            container.setAttribute('aria-busy', 'true');
            container.innerHTML = '<div class="thread-skeleton" aria-hidden="true">'
                + ['', ' is-mine', '', ' is-mine', ''].map((mine, i) => `<span class="thread-skeleton-bubble skeleton${mine} is-w${(i % 3) + 1}"></span>`).join('')
                + '</div>';
        }
        this._paintedConversationId = null;
        this._threadMeta = null;
        this.threadMessages = [];
        this.threadPagination = null;
        this.updateComposerState();
    }

    /* The thread couldn't be fetched and nothing is on screen to fall back
       on. In-pane message + Try again, rather than an endless skeleton. */
    renderThreadError(id, error) {
        const container = document.getElementById('threadMessages');
        if (!container || this.activeConversationId !== id) return;
        container.removeAttribute('aria-busy');
        container.innerHTML = `<div class="empty-state compact thread-load-error"><div class="empty-icon"><i class="fas fa-circle-exclamation"></i></div><h3>Couldn’t load this conversation</h3><p>${app.escapeHtml(error?.message || 'Please try again.')}</p><button type="button" class="btn btn-outline btn-sm" id="retryThreadBtn">Try again</button></div>`;
        document.getElementById('retryThreadBtn')?.addEventListener('click', () => this.openConversation(id, { silent: true }));
    }

    /* Lightweight refresh for a thread that's already open, used by the 8s
       poll loop instead of re-fetching the whole visible message window
       every tick. Asks the server only for what's changed since the last
       check — new messages, plus read-receipt flips on messages *we* sent
       — and patches just that into the already-rendered thread. Falls back
       to a full reload (openConversation) if there's no valid cursor yet,
       the active conversation changed since the cursor was set, or the
       server reports the gap was too big to fill incrementally (truncated:
       true — e.g. the tab was asleep for a long time). */
    async pollActiveThread() {
        const id = this.activeConversationId;
        if (!id) return;
        // An open / revalidation is already on the wire for this thread;
        // a second request now would only race it.
        if (this._revalidating.has(id)) return;
        if (!this.threadSince || this.threadSinceConversationId !== id || this._paintedConversationId !== id) {
            return this.openConversation(id, { silent: true, background: true });
        }
        try {
            // Same reasoning as loadConversations' preserveLoaded branch
            // above: this is the 8s background tick for a thread that's
            // already open, not something the person just did, so it must
            // not count as activity for session-renewal purposes.
            const response = await app.apiRequest(`/messages/conversations/${encodeURIComponent(id)}?since=${encodeURIComponent(this.threadSince)}`, { headers: { 'X-Background-Poll': '1' } });
            if (this.activeConversationId !== id) return;
            const { messages: newMessages = [], readUpdates = [], presence: threadPresenceData } = response.data || {};
            const { truncated, serverTime } = response.data?.pagination || {};
            if (window.NextaPresence && threadPresenceData) window.NextaPresence.seed(`conversation:${id}`, threadPresenceData);
            if (truncated) return this.openConversation(id, { silent: true, background: true });

            let changed = false;
            if (readUpdates.length) {
                const readMap = new Map(readUpdates.map(r => [r.id, r.readAt]));
                this.threadMessages = this.threadMessages.map(m => readMap.has(m.id) ? { ...m, readAt: readMap.get(m.id) } : m);
                changed = true;
            }
            // The server's poll window deliberately overlaps the previous
            // one by a few seconds (so nothing can fall in a gap), so the
            // same message can be delivered more than once — and one of OUR
            // OWN messages can arrive here before its POST reply does.
            // _ingestServerMessages de-duplicates by id and swaps a matching
            // optimistic bubble for the real message instead of showing both.
            const { added, changed: ingested } = this._ingestServerMessages(newMessages);
            if (ingested) changed = true;
            this.threadSince = serverTime || this.threadSince;

            if (changed) {
                const container = document.getElementById('threadMessages');
                if (container) {
                    const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
                    // Flag genuinely new (not just read-receipt-updated)
                    // messages from the other person that arrive while the
                    // reader is scrolled up reviewing older history — see
                    // updateScrollButton for where this shows up as the
                    // "New messages" pill instead of the bare arrow.
                    if (added.some(m => m.senderId !== app.user?.id) && !wasAtBottom) this.hasUnseenNewMessages = true;
                    this.paintThreadMessages(container);
                    if (wasAtBottom) container.scrollTop = container.scrollHeight;
                    this.updateScrollButton();
                }
                this._syncThreadCache();
                if (added.length) {
                    const conv = this.conversations.find(c => c.id === id);
                    if (conv) conv.unreadCount = 0;
                    if (app.notifications) app.notifications.settleByLink(`messages.html?conversation=${id}`);
                    await app.refreshUnreadBadges();
                }
            }
        } catch (error) {
            // A silent background refresh failing (network blip) shouldn't
            // interrupt the person or spam an error toast every 8s — the
            // next tick just tries again.
        }
    }

    /* Folds server messages into this.threadMessages in place. By id first;
       then by `clientId` — the id this client stamped on its own optimistic
       bubble (the same value the server stored as the idempotency key) — so
       our own message arriving by poll REPLACES its pending/failed bubble
       rather than sitting next to it. Returns which were genuinely new. */
    _ingestServerMessages(list) {
        const known = new Set(this.threadMessages.map(m => m.id));
        const added = [];
        let changed = false;
        for (const sm of list || []) {
            if (known.has(sm.id)) continue;
            known.add(sm.id);
            const idx = sm.clientId ? this.threadMessages.findIndex(m => m.id === sm.clientId) : -1;
            if (idx !== -1) {
                this.removeFailedMessage(this.threadMessages[idx]);
                this.threadMessages[idx] = sm;
                changed = true;
                continue;
            }
            this.threadMessages.push(sm);
            added.push(sm);
            changed = true;
        }
        return { added, changed };
    }

    /* Optimistic bubbles (still sending, or failed) exist only on this
       client — they must never be written into the cache as if the server
       had confirmed them. */
    _isLocalOnly(message) {
        return !!(message.pending || message.failed || String(message.id).startsWith('pending-'));
    }

    /* Keeps the cache entry for the open thread in step with what is on
       screen (a poll delivered messages, "load older" prepended history), so
       leaving and coming back shows it as it is now, not as it was at the
       last full fetch. Does not refresh the entry's age. */
    _syncThreadCache() {
        const id = this.activeConversationId;
        const cache = this._cache();
        if (!cache || !id || this._paintedConversationId !== id) return;
        cache.patch(id, data => ({
            ...data,
            messages: this.threadMessages.filter(m => !this._isLocalOnly(m)),
            pagination: this.threadPagination || data.pagination
        }));
    }

    /* Repaints #threadMessages from this.threadMessages (plus the "load
       older" button when there's more history above) and re-wires the two
       things a fresh innerHTML swap always wipes out: that button's click
       listener, and the location-card map renders. This exact three-line
       sequence used to be duplicated across five different call sites —
       every optimistic-send, poll, retry, and pagination path rebuilding
       the container had its own copy — which is exactly the kind of thing
       that quietly drifts out of sync the next time only one of the five
       gets updated. Every caller still owns its own scroll-position
       handling around this call, since that genuinely differs by context
       (jump to bottom on a fresh load, hold position on a poll, anchor to
       the old top on "load older"). */
    paintThreadMessages(container) {
        if (!container) return;
        container.removeAttribute('aria-busy');
        container.innerHTML = (this.threadPagination?.hasMore ? '<button type="button" class="btn btn-outline btn-sm messages-load-older" id="messagesLoadOlder">Load older messages</button>' : '')
            + (this.threadMessages.length ? this.buildMessagesHtml(this.threadMessages) : '<div class="empty-state compact"><p>No messages in this conversation yet.</p></div>');
        document.getElementById('messagesLoadOlder')?.addEventListener('click', () => this.loadOlderMessages());
        this.renderLocationPreviews(container);
    }

    /* Builds the HTML for a run of messages, inserting day dividers and
       collapsing the meta line (time + read receipt) onto only the last
       bubble of each consecutive same-sender run so grouped messages read
       as one block instead of repeating a timestamp on every line. */
    buildMessagesHtml(messages) {
        let html = '';
        let lastDayKey = null;
        let lastSenderId = null;
        let lastTime = null;
        const GROUP_WINDOW_MS = 5 * 60 * 1000;
        messages.forEach((m, idx) => {
            const created = new Date(m.createdAt);
            const dayKey = created.toDateString();
            if (dayKey !== lastDayKey) {
                html += `<div class="thread-day-divider"><span>${app.escapeHtml(this.formatDayLabel(m.createdAt))}</span></div>`;
                lastDayKey = dayKey; lastSenderId = null; lastTime = null;
            }
            const mine = app.user && m.senderId === app.user.id;
            const grouped = lastSenderId === m.senderId && lastTime !== null && (created - lastTime) < GROUP_WINDOW_MS;
            const next = messages[idx + 1];
            const sameAsNext = next && next.senderId === m.senderId && new Date(next.createdAt).toDateString() === dayKey && (new Date(next.createdAt) - created) < GROUP_WINDOW_MS;
            // data-status is the single, styleable source of truth for the three
            // send states (pending -> sent -> read, or failed) — the icon /
            // tick itself comes from CSS, the words are for screen readers.
            const receipt = mine
                ? (m.pending ? `<span class="message-receipt is-pending" data-status="pending"><i class="fas fa-clock"></i><span class="sr-only">Sending</span></span>`
                    : (m.failed ? `<span class="message-receipt is-failed" data-status="failed"><i class="fas fa-triangle-exclamation"></i><span class="sr-only">Failed to send</span></span>`
                        : `<span class="message-receipt" data-status="${m.readAt ? 'read' : 'sent'}"><span class="sr-only">${m.readAt ? 'Read' : 'Sent'}</span></span>`))
                : '';
            // A failed send gets its own always-visible retry/discard row —
            // never bundled into the "meta" line the way a normal timestamp
            // is, because that line only renders when a message ISN'T
            // grouped with the next one (sameAsNext), and a failed message
            // needs its retry control visible unconditionally regardless of
            // grouping.
            const metaTime = m.pending ? 'Sending\u2026' : (m.failed ? 'Not sent' : app.escapeHtml(this.relativeTime(m.createdAt)));
            const meta = sameAsNext ? '' : `<span class="thread-message-meta">${m.failed ? '' : `<time>${metaTime}</time>`}${receipt}</span>`;
            const failedActions = m.failed ? `<div class="message-failed-actions">
                <span class="message-failed-label"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Message failed to send</span>
                <button type="button" class="message-failed-retry" data-retry-message="${app.escapeHtml(m.id)}"><i class="fas fa-rotate-right" aria-hidden="true"></i> Resend</button>
                <button type="button" class="message-failed-discard" data-discard-message="${app.escapeHtml(m.id)}" aria-label="Delete this message">Delete</button>
            </div>` : '';
            const kind = m.type && m.type !== 'text' ? ` is-attachment is-${m.type}` : '';
            html += `<div class="thread-message ${mine ? 'is-mine' : ''} ${grouped ? 'is-grouped' : ''}${kind}${m.pending ? ' is-pending' : ''}${m.failed ? ' is-failed' : ''}">${this.messageContentHtml(m)}${meta}${failedActions}</div>`;
            lastSenderId = m.senderId; lastTime = created;
        });
        return html;
    }

    /* Header for an open thread. `thread` (the API's thread payload) and a
       conversation-list row carry the same { buyer, store, product } shapes,
       so the header is drawn from whichever is available — the list row when
       it has it, the thread payload otherwise. That is what makes a deep
       link to a conversation OLDER than the first list page draw the right
       name/avatar/link (it used to fall back to the store's own name, even
       for the store's owner looking at a buyer). */
    renderThreadHeader(thread, conv) {
        const header = document.getElementById('threadHeader');
        if (!header) return;
        const src = conv || thread;
        const store = src.store || thread.store || {};
        const buyerView = !!(app.user && src.buyer?.id === app.user.id);
        const party = buyerView ? store.name : src.buyer?.name;
        const avatarUrl = buyerView ? store.logo : null;
        const presenceKey = `conversation:${thread.id}`;
        const presenceDot = `<span class="presence-dot" data-presence-key="${presenceKey}" data-presence-dot aria-hidden="true"></span>`;
        const avatar = avatarUrl ? `<span class="thread-header-avatar" style="background-image:url('${app.cssUrl(app.resolveImageUrl(avatarUrl))}')">${presenceDot}</span>` : `<span class="thread-header-avatar"><i class="fas ${buyerView ? 'fa-store' : 'fa-user'}"></i>${presenceDot}</span>`;
        // Subtitle only ever has something genuinely new to say — the
        // product this conversation is about, when there is one. Falling
        // back to the store's own name used to repeat the title verbatim
        // right underneath itself whenever a conversation had no product.
        const subtitle = src.product ? `<span>${app.escapeHtml(src.product.name)}</span>` : '';
        // Presence.js fills this in from its state map (empty and hidden —
        // see .thread-header-status:empty — until something is known).
        const presenceLabel = `<span class="thread-header-status" data-presence-key="${presenceKey}" data-presence-label></span>`;
        const name = app.escapeHtml(party || store.name || 'Conversation');
        const inner = `${avatar}<div><strong>${name}</strong>${subtitle}${presenceLabel}</div>`;
        // Chatting with a store (the buyer side of a thread) can jump
        // straight to that store's page from the header. There's no
        // equivalent profile page for a buyer, so the seller side stays a
        // plain, non-clickable heading.
        if (buyerView && store.id) {
            const storeKey = store.slug || store.id;
            header.innerHTML = `<a class="thread-header-identity" href="store-detail.html?store=${encodeURIComponent(storeKey)}" aria-label="Open ${name}'s store">${inner}</a>`;
        } else {
            header.innerHTML = `<div class="thread-header-identity">${inner}</div>`;
        }
        this._headerConversationId = thread.id;
    }

    /* What this.threadMessages should be once `fresh` (the server's latest
       page for this thread) is applied:
         - the server's page, plus
         - any OLDER server messages the reader already loaded via "Load
           older" (a revalidation only ever returns the latest page — without
           this, every revalidation quietly threw the extra history away),
         - locally-persisted failed sends for this conversation,
         - sends still in flight (pending) — a snapshot landing mid-send, or
           leaving a thread and coming back before its send settles, must
           not make the bubble vanish.
       Optimistic bubbles whose message the server already has (matched by
       clientId) are dropped so nothing shows twice. */
    _mergeThreadMessages(threadId, fresh, { keepOlder = false } = {}) {
        const freshIds = new Set(fresh.map(m => m.id));
        const freshClientIds = new Set(fresh.map(m => m.clientId).filter(Boolean));
        const firstFreshAt = fresh.length ? new Date(fresh[0].createdAt).getTime() : Infinity;
        const older = keepOlder
            ? this.threadMessages.filter(m => !this._isLocalOnly(m) && !freshIds.has(m.id) && new Date(m.createdAt).getTime() < firstFreshAt)
            : [];
        const local = new Map();
        for (const m of this.loadFailedMessagesFor(threadId, null)) local.set(m.id, m);
        for (const m of this._pendingSends.values()) {
            if (m.pending && m.conversationId === threadId) local.set(m.id, m);
        }
        const localOnly = [...local.values()].filter(m => !freshIds.has(m.id) && !freshClientIds.has(m.id));
        return { messages: [...older, ...fresh, ...localOnly], keptOlder: older.length > 0 };
    }

    /* Cheap "would anything look different" check between two message lists
       (id, read state, and send status are all that a bubble depends on). */
    _sameMessages(a, b) {
        if (a.length !== b.length) return false;
        const key = m => `${m.id}|${m.readAt || ''}|${m.failed ? 'f' : (m.pending ? 'p' : 's')}`;
        for (let i = 0; i < a.length; i++) if (key(a[i]) !== key(b[i])) return false;
        return true;
    }

    /* Draws a thread.
         mode 'open'        first paint of this thread (from cache OR network):
                            always lands on the newest message.
         mode 'revalidate'  a fresh copy of what's already on screen: repaints
                            only if something actually changed, and holds the
                            reader's scroll place (anchored by distance from
                            the bottom) instead of yanking them anywhere.
         fromCache          the data may be stale — don't let its presence
                            snapshot overwrite a fresher live one. */
    renderThread(thread, { mode = 'revalidate', fromCache = false } = {}) {
        const container = document.getElementById('threadMessages');
        if (!container) return;
        document.getElementById('threadEmptyState')?.classList.add('hidden');
        document.getElementById('threadView')?.classList.remove('hidden');

        // The other party's presence for THIS thread rides along on every
        // conversation-open and since-poll response (routes/messages.js's
        // threadPresence()) — seed it here too, not just from the list, so a
        // deep link straight into a thread still shows something before the
        // stream's own snapshot arrives.
        const presenceKey = `conversation:${thread.id}`;
        if (window.NextaPresence && thread.presence && !fromCache) window.NextaPresence.seed(presenceKey, thread.presence);

        const sameThread = this._paintedConversationId === thread.id;
        const revalidating = mode === 'revalidate' && sameThread;
        const { messages: next, keptOlder } = this._mergeThreadMessages(thread.id, thread.messages || [], { keepOlder: revalidating });
        const conv = this.conversations.find(c => c.id === thread.id);
        this._threadMeta = thread;

        if (mode === 'open' || this._headerConversationId !== thread.id) this.renderThreadHeader(thread, conv);

        if (revalidating && this._sameMessages(next, this.threadMessages)) {
            // Nothing visible changed. Skip the repaint entirely (no flicker,
            // no scroll jump, keeps hover/focus state) — but keep pagination
            // honest.
            if (!keptOlder) this.threadPagination = thread.pagination || null;
            this.updateAttachMenu();
            return;
        }

        const known = new Set(this.threadMessages.map(m => m.id));
        const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const arrivals = revalidating ? next.filter(m => !known.has(m.id) && !this._isLocalOnly(m) && m.senderId !== app.user?.id) : [];

        this.threadPagination = keptOlder ? this.threadPagination : (thread.pagination || null);
        this.threadMessages = next;
        this.paintThreadMessages(container);
        this._paintedConversationId = thread.id;

        if (mode === 'open' || wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        } else {
            // Anchoring by distance-from-bottom (not raw scrollTop) keeps a
            // reader who scrolled up to review history in place even as new
            // messages append below.
            container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - distanceFromBottom);
            if (arrivals.length) this.hasUnseenNewMessages = true;
        }
        this.autoResizeInput();
        this.updateScrollButton();
        this.updateAttachMenu();
        this.setAttachEnabled(true);
    }

    async loadOlderMessages() {
        if (!this.activeConversationId || !this.threadPagination?.hasMore || !this.threadPagination.nextBefore) return;
        const conversationId = this.activeConversationId;
        const button = document.getElementById('messagesLoadOlder');
        if (button) { button.disabled = true; button.textContent = 'Loading…'; }
        const container = document.getElementById('threadMessages');
        const previousHeight = container?.scrollHeight || 0;
        try {
            const response = await app.apiRequest(`/messages/conversations/${encodeURIComponent(conversationId)}?before=${encodeURIComponent(this.threadPagination.nextBefore)}&limit=100`);
            // The thread can have been switched (or closed) while this was
            // in flight — a stale response landing after the reader has
            // already moved to a different conversation must not splice
            // that conversation's older history into whatever's open now.
            if (this.activeConversationId !== conversationId) return;
            const older = response.data?.messages || [];
            this.threadPagination = response.data?.pagination || null;
            if (!container) return;
            this.threadMessages = [...older, ...this.threadMessages];
            this.paintThreadMessages(container);
            container.scrollTop = (container.scrollHeight - previousHeight);
            this.updateScrollButton();
            this._syncThreadCache();
        } catch (error) {
            if (this.activeConversationId !== conversationId) return;
            // Leave the already-loaded messages exactly as they were and
            // put the button back to a clickable, honest state instead of
            // leaving it stuck on "Loading…" forever — that used to read as
            // the thread being permanently broken rather than one failed
            // request the reader can just retry.
            const retryButton = document.getElementById('messagesLoadOlder');
            if (retryButton) { retryButton.disabled = false; retryButton.textContent = 'Load older messages'; }
            app.showAlert(error.message || 'Couldn\u2019t load older messages. Try again.', 'error');
        }
    }

    updateComposerState() {
        const input = document.getElementById('threadReplyInput');
        const counter = document.getElementById('messageCharCount');
        const send = document.getElementById('threadSendBtn');
        if (!input) return;
        const len = input.value.length;
        if (counter) counter.textContent = `${len}/${this.maxLength}`;
        if (counter) counter.classList.toggle('is-near-limit', len > this.maxLength * .9);
        // Only creating a brand-new conversation holds the Send button
        // (there is no thread to queue behind yet). In an existing thread
        // you can keep writing and sending while earlier messages are still
        // on the wire — see _enqueueSend.
        if (send) send.disabled = this._creatingConversation || !input.value.trim() || len > this.maxLength || (!this.activeConversationId && !this.newMessageContext);
    }

    /* "Message seller" first-send latch. The first message is what CREATES
       the conversation, so a second one can't be addressed until that
       returns — the only case where sending waits on anything. Note what it
       does NOT do any more: it no longer disables the textarea. Disabling a
       focused textarea drops focus, which on a phone closes the on-screen
       keyboard after every single message. */
    setCreating(value) {
        this._creatingConversation = value;
        const send = document.getElementById('threadSendBtn');
        if (send) {
            if (!send.dataset.original) send.dataset.original = send.innerHTML;
            send.innerHTML = value ? '<i class="fas fa-spinner fa-spin"></i><span>Sending…</span>' : send.dataset.original;
        }
        this.updateComposerState();
    }

    /* Plain-text send from the composer — just hands the typed body to the
       shared send path below. Clears the input immediately (optimistic UI),
       same as the attachment senders do. */
    async sendReply() {
        const input = document.getElementById('threadReplyInput');
        const body = input?.value.trim() || '';
        if (this._creatingConversation || !body) return;
        if (input) { input.value = ''; this.autoResizeInput(); this.updateComposerState(); }
        await this.sendMessagePayload({ body });
    }

    /* Single send path shared by the composer (plain text), shareLocation()
       and openProductPicker() (attachments).

       Every message has exactly one of three states, and the person sees the
       first one on the same frame as the tap:
         pending  a clock, from the tap until the server answers;
         sent     a tick, once the server's own copy replaces the bubble
                  (turns into a double tick when the other side reads it);
         failed   a warning with Resend / Delete — kept, persisted across
                  reloads, never silently dropped.
       Nothing waits on anything else: the bubble is painted, the
       conversation-list preview and ordering are updated, and the request is
       queued (per conversation, so messages arrive in the order they were
       written) — see _enqueueSend and dispatchOptimisticMessage.
       Handles both starting a brand-new conversation (no
       activeConversationId yet, just a newMessageContext from a "Message
       seller" link) and replying within an existing one. */
    async sendMessagePayload({ body = '', attachment = null, optimisticProduct = null } = {}) {
        if (this._creatingConversation) return;
        const trimmedBody = (body || '').trim();
        if (!trimmedBody && !attachment) return;
        if (trimmedBody.length > this.maxLength) { app.showAlert(`Messages can be up to ${this.maxLength} characters.`, 'warning'); return; }
        if (!this.activeConversationId && !this.newMessageContext) return;

        // Doubles as the idempotency `clientId` sent with every network
        // attempt for this message (see dispatchOptimisticMessage) — the
        // SAME id on the first send and on every Resend, so the backend's
        // own dedup (findMessageByClientId, server-side) can recognise a
        // retry of an attempt that actually succeeded but whose response
        // never made it back (dropped connection, timeout) and return the
        // existing message instead of inserting a second copy.
        const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let optimisticMeta = {};
        if (attachment?.type === 'product' && optimisticProduct) {
            optimisticMeta = { productId: optimisticProduct.id, name: optimisticProduct.name, price: Number(optimisticProduct.price), image: app.productThumb(optimisticProduct), stock: optimisticProduct.stock };
        } else if (attachment?.type === 'location') {
            optimisticMeta = { lat: attachment.lat, lng: attachment.lng, label: attachment.label || null };
        }
        const optimisticMessage = {
            id: tempId, body: trimmedBody, type: attachment?.type || 'text', metadata: optimisticMeta,
            senderId: app.user?.id, createdAt: new Date().toISOString(), pending: true,
            // Stamped at the moment the send is fired, not re-read later —
            // this is what a retry or a background failure actually
            // targets, instead of whichever conversation happens to be open
            // by the time the request finally goes out or gets retried.
            // conversationId is null for a brand-new, not-yet-created
            // conversation; in that case _newMessageContext is the snapshot
            // of exactly which store/product it was meant to open with.
            conversationId: this.activeConversationId || null,
            _newMessageContext: this.activeConversationId ? null : (this.newMessageContext ? { ...this.newMessageContext } : null),
            // Kept so a failed send can be retried later with the exact
            // same content/attachment (see retryMessage). Never read by any
            // renderer.
            _payload: { body: trimmedBody, attachment, optimisticProduct }
        };

        const container = document.getElementById('threadMessages');
        this.threadMessages = [...(this.activeConversationId ? this.threadMessages : []), optimisticMessage];
        if (container) {
            this.paintThreadMessages(container);
            container.scrollTop = container.scrollHeight;
        }
        // The list row moves to the top with the new preview right now,
        // rather than after a refetch of the whole list.
        if (optimisticMessage.conversationId) this._patchConversationPreview(optimisticMessage.conversationId, optimisticMessage);
        return this._enqueueSend(optimisticMessage);
    }

    /* Runs an optimistic message's network send.
       - Established conversation: sends are chained per conversation, so two
         quick messages can never reach the server (and the other person) in
         the wrong order, while the composer stays fully usable.
       - Not-yet-created conversation: this send creates it, so it runs alone
         behind the "creating" latch (see setCreating). */
    _enqueueSend(optimisticMessage) {
        this._pendingSends.set(optimisticMessage.id, optimisticMessage);
        const done = () => { this._pendingSends.delete(optimisticMessage.id); };
        const key = optimisticMessage.conversationId;
        if (!key) {
            this.setCreating(true);
            return this.dispatchOptimisticMessage(optimisticMessage).finally(() => { done(); this.setCreating(false); });
        }
        const previous = this._sendChains.get(key) || Promise.resolve();
        // dispatchOptimisticMessage never rejects (it turns every failure
        // into the "failed" state), so the chain can't get stuck.
        const next = previous.then(() => this.dispatchOptimisticMessage(optimisticMessage)).finally(done);
        this._sendChains.set(key, next);
        next.finally(() => { if (this._sendChains.get(key) === next) this._sendChains.delete(key); });
        return next;
    }

    /* True when the conversation an optimistic message belongs to (its
       stamped conversationId, or — for a not-yet-created conversation —
       its stamped _newMessageContext) is the one actually on screen right
       now. Used to decide whether a send's outcome should touch the
       visible thread at all: a reply typed in conversation A and a retry
       fired from conversation A must never repaint conversation B just
       because B happens to be open by the time either one resolves. */
    isViewingMessage(optimisticMessage) {
        if (optimisticMessage.conversationId) return this.activeConversationId === optimisticMessage.conversationId;
        const ctx = optimisticMessage._newMessageContext;
        if (!ctx) return false;
        return !this.activeConversationId && !!this.newMessageContext
            && this.newMessageContext.storeId === ctx.storeId
            && (this.newMessageContext.productId || null) === (ctx.productId || null);
    }

    /* Performs the actual network send for an optimistic bubble that's
       already sitting in this.threadMessages (or, for a retry of a message
       whose conversation isn't the one currently open, only in the failed-
       message store) — built fresh by sendMessagePayload above, or reused
       as-is by retryMessage below. Sharing this means a retry goes through
       EXACTLY the same success/failure handling a first attempt does.

       Always sends to the conversation the message was originally
       addressed to (optimisticMessage.conversationId /
       _newMessageContext), never to whichever conversation happens to be
       open at the moment the request actually resolves.

       SUCCESS is reconciled in place. Both POST routes already return the
       stored message (with the clientId echoed back), so the pending bubble
       is swapped for the server's copy directly — the old code instead
       re-fetched the whole thread and then the whole conversation list, two
       more sequential round trips during which the bubble sat on "Sending…"
       even though the server had long since accepted it.

       FAILURE (including a request that hangs past the timeout) flips the
       bubble to failed in place, with its content and attachment intact, and
       persists it to localStorage so it survives a reload — see
       retryMessage/discardMessage. The same clientId rides along on every
       attempt, so a Resend of a message that actually went through (just with
       a lost response) is recognised server-side instead of duplicated. */
    async dispatchOptimisticMessage(optimisticMessage) {
        const viewingNow = () => this.isViewingMessage(optimisticMessage);
        const { body: trimmedBody, attachment } = optimisticMessage._payload;
        const SEND_TIMEOUT_MS = 20000;
        const creating = !optimisticMessage.conversationId;
        let result;
        // Only the network call lives inside this try. If the server
        // accepted the message, nothing that goes wrong afterwards while
        // updating the screen may flip it to "failed" — that would offer a
        // Resend for something already delivered.
        try {
            if (creating) {
                const ctx = optimisticMessage._newMessageContext;
                if (!ctx) throw new Error('This conversation is no longer available.');
                const r = await app.apiRequest('/messages', { method: 'POST', timeoutMs: SEND_TIMEOUT_MS, body: JSON.stringify({ storeId: ctx.storeId, productId: ctx.productId, body: trimmedBody, attachment: attachment || undefined, clientId: optimisticMessage.id }) });
                result = { conversationId: r.data.conversationId, message: r.data.message };
            } else {
                const r = await app.apiRequest(`/messages/conversations/${encodeURIComponent(optimisticMessage.conversationId)}`, { method: 'POST', timeoutMs: SEND_TIMEOUT_MS, body: JSON.stringify({ body: trimmedBody, attachment: attachment || undefined, clientId: optimisticMessage.id }) });
                result = { conversationId: optimisticMessage.conversationId, message: r.data };
            }
        } catch (error) {
            optimisticMessage.pending = false;
            optimisticMessage.failed = true;
            this.persistFailedMessage(optimisticMessage);
            if (viewingNow()) {
                const idx = this.threadMessages.findIndex(m => m.id === optimisticMessage.id);
                if (idx !== -1) {
                    this.threadMessages[idx] = { ...this.threadMessages[idx], pending: false, failed: true };
                    const container = document.getElementById('threadMessages');
                    if (container) this.paintThreadMessages(container);
                }
                app.showAlert(error.message || 'Message failed to send.', 'error');
                this.focusComposerIfDesktop();
            }
            return;
        }

        try {
            if (creating) {
                // Only promote the not-yet-created compose screen into a
                // real open thread if the sender is still actually looking
                // at that same "message this store" context — if they've
                // since moved on, this send completing in the background
                // must not yank them into a thread they didn't ask to see.
                // (Evaluated BEFORE conversationId is stamped below: once it
                // is, isViewingMessage compares against the open thread.)
                const promote = viewingNow();
                // Drop a persisted failed copy while the message still
                // carries its ORIGINAL (store+product) key — after the id is
                // stamped the lookup would miss it and a Resend that
                // succeeded would reappear as failed on the next visit.
                this.removeFailedMessage(optimisticMessage);
                optimisticMessage.conversationId = result.conversationId;
                this._settleSent(optimisticMessage, result.message, { viewing: promote });
                if (promote) {
                    this.activeConversationId = result.conversationId;
                    this.newMessageContext = null;
                    // Not awaited: it only fetches the full header and
                    // pagination for the thread already on screen
                    // (keepCurrent: no skeleton over the bubble just sent).
                    this.openConversation(result.conversationId, { keepCurrent: true });
                }
                // The new conversation isn't in the list yet.
                this.loadConversations({ silent: true, preserveLoaded: true });
            } else {
                this._settleSent(optimisticMessage, result.message, { viewing: viewingNow() });
            }
        } catch (bookkeepingError) {
            console.error('[messages] post-send update failed', bookkeepingError);
        }
        if (viewingNow()) this.focusComposerIfDesktop();
    }

    /* pending -> sent. Swaps the optimistic bubble for the server's own copy
       (which carries the real id, timestamp and read state), keeps the cache
       and the list preview in step, and repaints only if that thread is the
       one on screen. If a poll already delivered this message (matched by
       clientId) there is nothing to swap — the temporary copy is just
       dropped so it isn't shown twice. */
    _settleSent(optimisticMessage, serverMessage, { viewing = false } = {}) {
        this.removeFailedMessage(optimisticMessage);
        if (!serverMessage) return;
        const convId = optimisticMessage.conversationId;
        if (convId) {
            const cache = this._cache();
            if (cache) cache.upsertMessage(convId, serverMessage);
            this._patchConversationPreview(convId, serverMessage);
        }
        if (!viewing) return;
        const idx = this.threadMessages.findIndex(m => m.id === optimisticMessage.id);
        const alreadyHave = this.threadMessages.some(m => m.id === serverMessage.id);
        if (idx !== -1) {
            if (alreadyHave) this.threadMessages.splice(idx, 1);
            else this.threadMessages[idx] = serverMessage;
        } else if (!alreadyHave) {
            this.threadMessages.push(serverMessage);
        }
        const container = document.getElementById('threadMessages');
        if (container) {
            const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
            this.paintThreadMessages(container);
            if (wasAtBottom) container.scrollTop = container.scrollHeight;
            this.updateScrollButton();
        }
    }

    /* Updates one conversation's row (last-message preview, recency, and its
       place at the top of the list) from a message this client just sent or
       had confirmed — no list refetch. The list's own poll converges
       anything this can't know. */
    _patchConversationPreview(conversationId, message) {
        const conv = this.conversations.find(c => c.id === conversationId);
        if (!conv) return;
        conv.lastMessage = { body: message.body, type: message.type, metadata: message.metadata, senderId: message.senderId, createdAt: message.createdAt };
        conv.updatedAt = message.createdAt;
        this.conversations = [conv, ...this.conversations.filter(c => c !== conv)];
        this._lastConversationsSignature = this._conversationsSignature(this.conversations);
        this.renderConversationList();
    }

    /* Re-attempts a message that failed to send, in place: same bubble,
       same position in the thread, same typed content/attachment — the
       sender never has to retype or reselect anything. Always resends to
       optimisticMessage's own stamped conversation (see
       dispatchOptimisticMessage), which — since the retry button only
       ever appears on the thread currently being viewed — is always the
       thread this fires from anyway. */
    async retryMessage(tempId) {
        if (this._creatingConversation) return;
        const idx = this.threadMessages.findIndex(m => m.id === tempId && m.failed);
        if (idx === -1) return;
        this.threadMessages[idx] = { ...this.threadMessages[idx], pending: true, failed: false };
        const container = document.getElementById('threadMessages');
        if (container) this.paintThreadMessages(container);
        await this._enqueueSend(this.threadMessages[idx]);
    }

    /* Lets the sender explicitly give up on a failed message instead of
       retrying it. Removes just that one bubble — everything else in the
       thread is untouched — and drops it from the persisted failed-message
       store so it doesn't reappear on the next reload. */
    discardMessage(tempId) {
        const idx = this.threadMessages.findIndex(m => m.id === tempId && m.failed);
        if (idx === -1) return;
        const [removed] = this.threadMessages.splice(idx, 1);
        this.removeFailedMessage(removed);
        const container = document.getElementById('threadMessages');
        if (container) this.paintThreadMessages(container);
    }

    /* ---- Failed-message persistence ----
       A failed send is kept in localStorage, keyed by the conversation it
       was addressed to, so it survives a page reload and reappears (with
       its Resend/Delete controls) the next time that conversation is
       opened — instead of the in-memory-only bubble that used to vanish
       the moment this.threadMessages got replaced by anything else
       (switching threads, a reload, even just the next full poll refresh
       in some paths). Keyed on conversation id when one exists, or on the
       store+product a not-yet-created conversation was addressed to
       otherwise, so a retry (or just reopening later) always lands back
       on the right thread. Wrapped defensively since localStorage can
       throw (private browsing, quota, disabled storage) — a failed *save
       of the failure state* shouldn't itself become a second error. */
    _failedStoreKey(conversationId, newMessageContext) {
        if (conversationId) return `conv:${conversationId}`;
        return `new:${newMessageContext?.storeId || ''}:${newMessageContext?.productId || ''}`;
    }
    _readFailedStore() {
        try { return JSON.parse(localStorage.getItem('ns_messages_failed_v1') || '{}') || {}; }
        catch { return {}; }
    }
    _writeFailedStore(store) {
        try { localStorage.setItem('ns_messages_failed_v1', JSON.stringify(store)); } catch { /* ignore */ }
    }
    /* Who an unsent message belongs to. Every stored entry is stamped with the
       sender's user id and only that user is ever shown it: if the other party
       to a conversation (or anyone else) signs in on the same browser later,
       they must never see the previous person's unsent text with a Resend
       button that would send it as THEM. Entries with no stamp (saved before
       this existed) are treated as nobody's and ignored. */
    _failedOwnerId() {
        return app.user?.id || tokenUserId(app.token) || null;
    }
    persistFailedMessage(optimisticMessage) {
        const ownerId = this._failedOwnerId();
        if (!ownerId) return; // can't attribute it to anyone, so don't keep it
        const key = this._failedStoreKey(optimisticMessage.conversationId, optimisticMessage._newMessageContext);
        const store = this._readFailedStore();
        const list = (store[key] || []).filter(m => m.id !== optimisticMessage.id);
        list.push({ ...optimisticMessage, _ownerId: ownerId });
        store[key] = list;
        this._writeFailedStore(store);
    }
    removeFailedMessage(optimisticMessage) {
        const key = this._failedStoreKey(optimisticMessage.conversationId, optimisticMessage._newMessageContext);
        const store = this._readFailedStore();
        if (!store[key]) return;
        store[key] = store[key].filter(m => m.id !== optimisticMessage.id);
        if (!store[key].length) delete store[key];
        this._writeFailedStore(store);
    }
    loadFailedMessagesFor(conversationId, newMessageContext) {
        const key = this._failedStoreKey(conversationId, newMessageContext);
        const ownerId = this._failedOwnerId();
        if (!ownerId) return [];
        return (this._readFailedStore()[key] || []).filter(m => m && m._ownerId === ownerId);
    }
}
window.messagesManager = new MessagesManager();
