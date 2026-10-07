class StoreDetailManager {
    constructor() {
        this.store = null;
        this.products = [];
        this.productsPage = 1;
        this.productsPagination = null;
        this.currentCategory = 'all';
        this.currentSort = 'popular';
        this.priceRange = { min: null, max: null };
        // Real min/max/step of this store's catalogue — drives the price slider.
        this.priceBounds = null;
        this.searchTerm = '';
        this.isFollowing = false;
        // Labels come from the shared list in js/categories.js (same ones sellers pick in the product form).
        this.categoryLabels = new Proxy({}, { get: (_, id) => (window.NXCategories ? window.NXCategories.label(id) : String(id)) });
        this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));
    }

    async init() {
        this.setupEventListeners();
        this.setupMobileSidebar();
        this.setupProductEventListeners();
        this.showLoadingStates();
        await this.loadStoreData();
        if (!this.store) return; // unavailable — loadStoreData() already rendered why; nothing else to load
        this.renderStoreFilters();
        // Follow state and the first page of products don't depend on each
        // other, so they load together. The products are what the page is
        // for; the follow state only decides the button's label, so it may
        // hold the page loader for a short grace period at most (a slow or
        // hung follow lookup used to be able to run the loader into its
        // 7 s "timed out waiting for: page" cap on its own). If it lands
        // later, the button simply updates when it does.
        const followState = this.loadFollowState();
        await this.loadProducts();
        await Promise.race([followState, new Promise(resolve => setTimeout(resolve, 1500))]);
        this.updateCartUI();
        this.resumePendingAction();
    }

    /** Builds the sidebar filter panel from THIS store's actual inventory.
     *  A filter dimension that has zero or one possible value across the
     *  store's products is hidden entirely — an empty or single-option
     *  filter isn't useful. A store with zero products gets no filter
     *  panel at all (only the About card remains). Marketplace-level
     *  filters are untouched: they stay global by design. */
    renderStoreFilters() {
        const filters = document.getElementById('storeFilters');
        if (!filters) return;

        // With no products there is nothing to filter, so the whole panel and
        // the mobile Filters button go away (About moves out of the drawer).
        const hasProducts = this.store?.productCount > 0;
        const toggleBtn = document.querySelector('.mobile-sidebar-toggle');
        if (toggleBtn) toggleBtn.hidden = !hasProducts;
        if (!hasProducts) {
            filters.hidden = true;
            return;
        }
        filters.hidden = false;

        // Categories present in this store's inventory.
        const categories = [...new Set((this.store?.categories || []).filter(Boolean))];
        const categorySection = document.getElementById('categorySection');
        const categoryList = document.getElementById('categoryList');
        if (categories.length > 1 && categoryList) {
            categorySection.hidden = false;
            categoryList.innerHTML = [
                { value: 'all', label: 'All Products' },
                ...categories
                    .sort()
                    .map(value => ({ value, label: this.categoryLabels[value] || value }))
            ].map(c => `
                <li class="${this.currentCategory === c.value ? 'active' : ''}">
                    <a href="#" data-category="${c.value}">${window.NXCategories ? NXCategories.iconHTML(c.value, 20) : ''}<span>${app.escapeHtml(c.label)}</span></a>
                </li>
            `).join('');
        } else {
            // Zero or one category → the filter can't exclude anything.
            categorySection.hidden = true;
            this.currentCategory = 'all';
        }

        // Price slider only makes sense when the store's prices actually
        // differ: one product, or every product at the same price, means
        // there's nothing to slide between.
        const priceSection = document.getElementById('priceSection');
        const range = this.store?.priceRange;
        const canSlide = (this.store?.productCount || 0) > 1 && range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min;
        if (canSlide) {
            priceSection.hidden = false;
            if (!this.priceBounds) this.setupPriceSlider(range);
        } else {
            priceSection.hidden = true;
            this.priceBounds = null;
            this.priceRange = { min: null, max: null };
        }
        this.renderFilterState();
    }

    /* ---------------------------------------------------------------
       Price slider — two thumbs on one track, in real UGX values.
       The ends are this store's cheapest and dearest product. The scale
       is logarithmic, not linear: a store selling beads at UGX 5,000 and
       a sofa at UGX 3,000,000 would otherwise squeeze every bead into the
       first sliver of the track and make cheap items impossible to pick
       out. Prices snap to 2 significant figures (3,500 · 12,000 · 240,000)
       so labels never read 12,347. Dragging updates the labels live; the
       products reload once the shopper lets go (input vs change).
       The <input>s hold POSITIONS (0–1000); priceAt() turns one into UGX.
       --------------------------------------------------------------- */
    roundSig(v, sig = 2) {
        if (!(v > 0)) return 0;
        const pow = Math.pow(10, Math.floor(Math.log10(v)) - (sig - 1));
        return Math.round(v / pow) * pow;
    }

    /** Slider position (0–1000) → price. Ends are the exact min / max. */
    priceAt(pos) {
        const { lo, hi, base, top } = this.priceBounds;
        if (pos <= 0) return lo;
        if (pos >= top) return hi;
        const v = base * Math.pow(hi / base, pos / top);
        return Math.min(hi, Math.max(lo, this.roundSig(v)));
    }

    /** Price → slider position (for restoring a saved filter). */
    posOf(price) {
        const { lo, hi, base, top } = this.priceBounds;
        if (price <= lo) return 0;
        if (price >= hi) return top;
        return Math.round((Math.log(price / base) / Math.log(hi / base)) * top);
    }

    /** Short money label for tight spaces: UGX 950,000 stays as is, UGX 1,250,000 → UGX 1.25M. */
    moneyShort(value) {
        const n = Number(value) || 0;
        if (n >= 1e9) return `UGX ${+(n / 1e9).toFixed(2)}B`;
        if (n >= 1e6) return `UGX ${+(n / 1e6).toFixed(2)}M`;
        return app.formatCurrency(n);
    }

    setupPriceSlider(range) {
        const minEl = document.getElementById('minPrice');
        const maxEl = document.getElementById('maxPrice');
        if (!minEl || !maxEl) return;

        const lo = Math.max(0, Math.floor(range.min));
        const hi = Math.max(Math.ceil(range.max), lo + 1);
        const top = 1000, gap = 10;   // 100 stops; thumbs stay at least one stop apart
        this.priceBounds = { lo, hi, base: Math.max(lo, 1), top, gap };

        [minEl, maxEl].forEach(el => { el.min = '0'; el.max = String(top); el.step = String(gap); });
        minEl.value = String(this.priceRange.min === null ? 0 : this.posOf(this.priceRange.min));
        maxEl.value = String(this.priceRange.max === null ? top : this.posOf(this.priceRange.max));
        document.getElementById('priceEndMin').textContent = this.moneyShort(lo);
        document.getElementById('priceEndMax').textContent = this.moneyShort(hi);

        let commitTimer = null;
        const commit = () => {
            clearTimeout(commitTimer);
            commitTimer = setTimeout(() => {
                const a = Number(minEl.value), b = Number(maxEl.value);
                // A thumb sitting on its end means "no limit on that side".
                this.priceRange = { min: a <= 0 ? null : this.priceAt(a), max: b >= top ? null : this.priceAt(b) };
                this.renderFilterState();
                this.loadProducts(1, false);
            }, 220);
        };
        const onInput = (which) => () => {
            const a = Number(minEl.value), b = Number(maxEl.value);
            // Thumbs can touch but never cross.
            if (which === 'min' && a > b - gap) minEl.value = String(Math.max(0, b - gap));
            if (which === 'max' && b < a + gap) maxEl.value = String(Math.min(top, a + gap));
            // Whichever thumb was touched last sits on top, so two thumbs
            // stacked at one end can't trap each other.
            (which === 'min' ? minEl : maxEl).style.zIndex = '3';
            (which === 'min' ? maxEl : minEl).style.zIndex = '2';
            this.syncPriceSliderUI();
        };
        minEl.addEventListener('input', onInput('min'));
        maxEl.addEventListener('input', onInput('max'));
        minEl.addEventListener('change', commit);
        maxEl.addEventListener('change', commit);
        this.syncPriceSliderUI();
    }

    /** Repaints labels, the filled part of the track and the a11y text. */
    syncPriceSliderUI() {
        if (!this.priceBounds) return;
        const { top } = this.priceBounds;
        const minEl = document.getElementById('minPrice');
        const maxEl = document.getElementById('maxPrice');
        const a = Number(minEl.value), b = Number(maxEl.value);
        const pa = this.priceAt(a), pb = this.priceAt(b);
        // Fractions (0–1) for the CSS that lines the filled bar up with the
        // thumbs' centres — see .price-slider-fill.
        const track = document.getElementById('priceTrack');
        if (track) { track.style.setProperty('--a', String(a / top)); track.style.setProperty('--b', String(b / top)); }
        const minLabel = document.getElementById('priceMinLabel');
        const maxLabel = document.getElementById('priceMaxLabel');
        if (minLabel) minLabel.textContent = this.moneyShort(pa);
        if (maxLabel) maxLabel.textContent = b >= top ? `${this.moneyShort(pb)}+` : this.moneyShort(pb);
        minEl.setAttribute('aria-valuetext', app.formatCurrency(pa));
        maxEl.setAttribute('aria-valuetext', app.formatCurrency(pb));
    }

    resetPriceSlider() {
        this.priceRange = { min: null, max: null };
        if (!this.priceBounds) return;
        document.getElementById('minPrice').value = '0';
        document.getElementById('maxPrice').value = String(this.priceBounds.top);
        this.syncPriceSliderUI();
    }

    hasActiveFilters() {
        return this.currentCategory !== 'all' || !!this.searchTerm || this.priceRange.min !== null || this.priceRange.max !== null;
    }

    /** Everything that mirrors "which filters are on": the removable chips
     *  above the grid, the sidebar's Clear-all link, and the count on the
     *  mobile Filters button. */
    renderFilterState() {
        const chips = [];
        if (this.currentCategory !== 'all') chips.push({ key: 'category', icon: 'fa-tag', catIcon: this.currentCategory, label: this.categoryLabels[this.currentCategory] || this.currentCategory });
        if (this.searchTerm) chips.push({ key: 'search', icon: 'fa-magnifying-glass', label: `“${this.searchTerm.length > 22 ? this.searchTerm.slice(0, 22) + '…' : this.searchTerm}”` });
        if (this.priceRange.min !== null || this.priceRange.max !== null) {
            const a = this.priceRange.min, b = this.priceRange.max;
            const label = a !== null && b !== null ? `${this.moneyShort(a)} – ${this.moneyShort(b)}` : (a !== null ? `From ${this.moneyShort(a)}` : `Up to ${this.moneyShort(b)}`);
            chips.push({ key: 'price', icon: 'fa-coins', label });
        }

        const box = document.getElementById('activeFilters');
        if (box) {
            box.hidden = !chips.length;
            box.innerHTML = chips.map(c => `<button type="button" class="filter-chip" data-remove-filter="${c.key}" aria-label="Remove filter ${app.escapeHtml(c.label)}">${c.catIcon && window.NXCategories ? NXCategories.iconHTML(c.catIcon, 16) : `<i class="fas ${c.icon}"></i>`}<span>${app.escapeHtml(c.label)}</span><i class="fas fa-xmark filter-chip-x"></i></button>`).join('')
                + (chips.length > 1 ? '<button type="button" class="filter-chip-clear" data-remove-filter="all">Clear all</button>' : '');
        }
        const clear = document.getElementById('clearAllFilters');
        if (clear) clear.hidden = !chips.length;

        const badge = document.querySelector('.mobile-sidebar-toggle .filter-count');
        if (badge) { badge.textContent = String(chips.length); badge.hidden = !chips.length; }
    }

    removeFilter(key) {
        if (key === 'category' || key === 'all') this.currentCategory = 'all';
        if (key === 'search' || key === 'all') {
            this.searchTerm = '';
            const input = document.getElementById('storeSearch');
            if (input) input.value = '';
            this.closeSearchPreview();
        }
        if (key === 'price' || key === 'all') this.resetPriceSlider();
        this.renderStoreFilters();
        this.loadProducts(1, false);
    }

    /** Re-fires a favorite toggle or "message seller" open that got
     *  interrupted by a login redirect (see app.requireLogin), so the
     *  shopper doesn't have to remember to click it again. */
    resumePendingAction() {
        const favorite = app.consumePendingAction('favorite-product');
        if (favorite) {
            this.toggleFavorite(favorite.productId);
            return;
        }
        if (app.consumePendingAction('contact-seller')) {
            this.openContactModal();
            return;
        }
        const follow = app.consumePendingAction('follow-store');
        if (follow && follow.storeId === this.store?.id) {
            this.toggleFollow();
        }
    }

    showLoadingStates() {
        // Show loading states for all dynamic content
        document.getElementById('storeLoadingState')?.classList.add('active');
        document.getElementById('storeContent')?.classList.add('hidden');
        
        document.getElementById('productsLoadingState')?.classList.add('active');
        document.getElementById('productsContent')?.classList.add('hidden');
    }

    hideLoadingStates() {
        // Hide loading states and show actual content
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
        
        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');
    }

    setupEventListeners() {
        // Category filtering — delegated on the list because
        // renderStoreFilters() re-renders its items per store.
        const categoryList = document.getElementById('categoryList');
        if (categoryList) {
            categoryList.addEventListener('click', (e) => {
                const link = e.target.closest('a[data-category]');
                if (!link) return;
                e.preventDefault();
                categoryList.querySelectorAll('li').forEach(li => li.classList.remove('active'));
                link.parentElement.classList.add('active');
                this.currentCategory = link.dataset.category || 'all';
                this.renderFilterState();
                this.loadProducts(1, false);
            });
        }

        // Sort functionality
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.currentSort = e.target.value;
                this.loadProducts(1, false);
            });
        }

        // Price slider is wired in setupPriceSlider() once the store's real
        // price range is known. Removable filter chips + Clear all:
        document.getElementById('activeFilters')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-remove-filter]');
            if (btn) this.removeFilter(btn.dataset.removeFilter);
        });
        document.getElementById('clearAllFilters')?.addEventListener('click', () => this.removeFilter('all'));

        // Search functionality
        const searchInput = document.getElementById('storeSearch');
        if (searchInput) {
            searchInput.addEventListener('input', app.debounce((e) => {
                this.searchTerm = e.target.value.trim();
                this.renderSearchPreview(this.searchTerm);
                this.renderFilterState();
                this.loadProducts(1, false);
            }, 120));
            searchInput.addEventListener('focus', () => this.renderSearchPreview(searchInput.value));
            searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') this.closeSearchPreview(); });
            document.addEventListener('click', e => { if (!document.getElementById('storeSearchBar')?.contains(e.target)) this.closeSearchPreview(); });
        }

        // View toggle
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const grid = document.getElementById('productsGrid');
                grid.classList.toggle('list-view', btn.dataset.view === 'list');
            });
        });

        // Cart open/close/checkout wiring now lives in js/cart.js, shared by
        // every page with the drawer-style cart markup — see setupCartDrawer().

        // Store actions
        document.getElementById('followBtn')?.addEventListener('click', () => this.toggleFollow());
        document.getElementById('contactBtn')?.addEventListener('click', () => this.openContactModal());
        document.getElementById('shareBtn')?.addEventListener('click', () => this.openShareModal());

        // Modal handling
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.modal').classList.remove('open');
            });
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('open');
                }
            });
        });

        // Share buttons
        document.querySelectorAll('.share-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleShare(btn.dataset.platform));
        });
    }

    setupMobileSidebar() {
        const sidebar = document.getElementById('storeSidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (!sidebar) return;

        // Filters button in the top bar (only visible below 1024px via CSS),
        // with a small count of how many filters are on.
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'mobile-sidebar-toggle btn btn-outline btn-sm';
        toggleBtn.innerHTML = '<i class="fas fa-sliders"></i> <span>Filters</span><span class="filter-count" hidden>0</span>';
        toggleBtn.setAttribute('aria-label', 'Open filters');
        toggleBtn.setAttribute('aria-controls', 'storeSidebar');
        toggleBtn.setAttribute('aria-expanded', 'false');
        const navRight = document.querySelector('.nav-right');
        if (navRight) navRight.insertBefore(toggleBtn, navRight.firstChild);

        const setOpen = (open) => {
            sidebar.classList.toggle('open', open);
            overlay?.classList.toggle('active', open);
            document.body.classList.toggle('store-drawer-open', open);
            toggleBtn.setAttribute('aria-expanded', String(open));
            if (open) sidebar.querySelector('.sidebar-drawer-close')?.focus({ preventScroll: true });
            else if (document.activeElement && sidebar.contains(document.activeElement)) toggleBtn.focus({ preventScroll: true });
        };
        this.setDrawerOpen = setOpen;

        toggleBtn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
        overlay?.addEventListener('click', () => setOpen(false));
        document.getElementById('sidebarClose')?.addEventListener('click', () => setOpen(false));
        document.getElementById('drawerApply')?.addEventListener('click', () => setOpen(false));
        document.getElementById('drawerReset')?.addEventListener('click', () => this.removeFilter('all'));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('open')) setOpen(false); });
        // Rotating the phone / widening the window past the breakpoint must not leave a locked page behind.
        window.matchMedia('(min-width: 1025px)').addEventListener('change', (e) => { if (e.matches) setOpen(false); });

        // "About this store" lives in the sidebar on desktop. On narrow
        // screens the sidebar is a hidden drawer, so the About card moves
        // below the products instead of being buried behind Filters.
        const info = document.getElementById('storeInfoSection');
        const content = document.querySelector('.store-content');
        const scroll = sidebar.querySelector('.sidebar-scroll');
        if (info && content && scroll) {
            const place = (narrow) => {
                if (narrow && info.parentElement !== content) content.appendChild(info);
                else if (!narrow && info.parentElement !== scroll) scroll.appendChild(info);
                info.classList.toggle('store-info-standalone', narrow);
                if (this.store) this.renderStoreMap();
            };
            const mq = window.matchMedia('(max-width: 1024px)');
            place(mq.matches);
            mq.addEventListener('change', (e) => place(e.matches));
        }
    }

    /** Which store this page is for. A store's own address is /<slug>
     *  (nextastores.com/<slug>), so the slug is the path. The older
     *  store-detail.html?store=<slug-or-id> form is still understood, and
     *  is rewritten to the clean address once the store has loaded. */
    storeKeyFromLocation() {
        const fromQuery = new URLSearchParams(window.location.search).get('store');
        if (fromQuery) return fromQuery;
        const seg = window.location.pathname.replace(/^\/+|\/+$/g, '');
        return /^[A-Za-z0-9-]+$/.test(seg) && seg !== 'store-detail' ? decodeURIComponent(seg) : '';
    }

    /** Old-style URL in the address bar (store-detail.html?store=...): show the
     *  store's clean address instead, so what people copy from the bar is the
     *  same link the seller shares. Other query params and the hash are kept. */
    useCleanAddress() {
        try {
            if (!this.store?.slug) return;
            const params = new URLSearchParams(window.location.search);
            if (!params.has('store')) return;
            params.delete('store');
            const rest = params.toString();
            window.history.replaceState(null, '', `/${encodeURIComponent(this.store.slug)}${rest ? `?${rest}` : ''}${window.location.hash}`);
        } catch (e) { /* purely cosmetic */ }
    }

    async loadStoreData() {
        try {
            const storeSlug = this.storeKeyFromLocation();

            // The backend resolves the store from a `?store=<slug>` query
            // string on /store/public (see resolveContextStore in the API) —
            // it does not accept the slug as a path segment. This used to be
            // called as `/store/public/${storeId}`, which never matched any
            // route and 404'd every time, silently falling through to the
            // "current user's own store" endpoint instead. That meant a
            // customer opening any seller's storefront link never actually
            // saw that seller's store.
            const endpoint = storeSlug
                ? `/store/public?store=${encodeURIComponent(storeSlug)}`
                : '/store/public';
            const response = await app.apiRequest(endpoint);

            this.store = response.data; document.documentElement.style.setProperty("--store-accent", this.store.bannerColor || this.store.accentColor || this.store.primaryColor || "#01B075");
            this.useCleanAddress();
            this.renderStoreInfo();
            this.loadSellerPresence();
        } catch (error) {
            console.error('Failed to load store data:', error);
            this.renderStoreUnavailable(error.code, error.store);
        }
    }

    /* Online/offline for the store owner (item 1 of the presence spec).
       /store/public above doesn't carry it — GET /api/presence/store/:slug
       is the dedicated endpoint, built specifically for a storefront
       header opened by someone who isn't signed in (so can't hold a
       stream) and for this page's own first paint before any stream
       snapshot has arrived. Signed-in visitors additionally get live
       updates once presence.js's own stream (open on every signed-in page)
       reports back on the "store:<slug>" watch key set below; a
       signed-out visitor only ever sees this one-off snapshot. */
    loadSellerPresence() {
        if (!this.store?.slug || !window.NextaPresence) return;
        const key = `store:${this.store.slug}`;
        const dot = document.getElementById('storeSellerPresenceDot');
        const label = document.getElementById('storeSellerPresence');
        if (dot) dot.setAttribute('data-presence-key', key);
        if (label) label.setAttribute('data-presence-key', key);
        window.NextaPresence.setWatch([key]);
        app.apiRequest(`/presence/store/${encodeURIComponent(this.store.slug)}`)
            .then(res => { if (res?.data) window.NextaPresence.seed(key, res.data); })
            .catch(() => { /* presence is a nice-to-have; the header just shows nothing */ });
    }

    async loadFollowState() {
        if (!this.store?.id) return;
        try {
            const response = await app.apiRequest(`/store/follow/${encodeURIComponent(this.store.id)}`);
            this.isFollowing = !!response.data?.following;
            if (typeof response.data?.followers === 'number') this.store.followers = response.data.followers;
            this.renderFollowButton();
            this.renderTrustSignals();
        } catch (error) {
            console.warn('Could not load follow state:', error);
            this.renderFollowButton();
        }
    }

    /** 1,242 stays 1,242; 12,400 → 12.4K; 1,250,000 → 1.25M — so a very
     *  popular store never stretches its pill. */
    formatCount(n) {
        const v = Number(n) || 0;
        if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
        if (v >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
        return v.toLocaleString();
    }

    // Single source of truth for the "product count + follower count" pill
    // row under the store name. Called on initial render and again whenever
    // the follower count changes (follow/unfollow, or a fresh /store/follow
    // read) so that number never drifts out of sync. Badges are NOT repeated
    // here — they already have their own row above the description.
    renderTrustSignals() {
        const trust = document.getElementById('storeTrustSignals');
        if (!trust || !this.store) return;
        const products = this.store.productCount || 0;
        const followers = this.store.followers || 0;
        trust.innerHTML = `<span title="${products.toLocaleString()} listed products"><i class="fas fa-box"></i> ${this.formatCount(products)} ${products === 1 ? 'listed product' : 'listed products'}</span><span title="${followers.toLocaleString()} followers"><i class="fas fa-users"></i> ${this.formatCount(followers)} ${followers === 1 ? 'follower' : 'followers'}</span>`;
    }

    /** Badge row with an overflow chip: the first few badges show in full,
     *  anything beyond collapses into "+N" (full list in its tooltip), so a
     *  seller holding every badge never blows out the header. */
    renderHeroBadges() {
        const all = Array.isArray(this.store?.badges) ? this.store.badges : [];
        const limit = 3;
        let html = app.renderSellerBadges(this.store, { limit });
        if (all.length > limit) {
            const rest = all.slice(limit);
            html += `<span class="seller-badge seller-badge--more" title="${app.escapeHtml(rest.map(b => b.label).join(', '))}" aria-label="${rest.length} more badges">+${rest.length}</span>`;
        }
        return html;
    }

    /** Clamps the store description to a few lines and only offers "Read
     *  more" when the text genuinely overflows — short descriptions look
     *  exactly as before, a 1,000-character one can't push the buttons
     *  off-screen. */
    setupDescriptionClamp() {
        const wrap = document.getElementById('storeDescriptionWrap');
        const text = document.getElementById('storeDescription');
        const toggle = document.getElementById('storeDescriptionToggle');
        if (!wrap || !text || !toggle) return;
        wrap.classList.remove('is-expanded');
        toggle.textContent = 'Read more';
        toggle.setAttribute('aria-expanded', 'false');
        const measure = () => {
            if (wrap.classList.contains('is-expanded')) return;
            toggle.hidden = !(text.scrollHeight > text.clientHeight + 1);
        };
        requestAnimationFrame(measure);
        if (!this._descBound) {
            this._descBound = true;
            toggle.addEventListener('click', () => {
                const open = wrap.classList.toggle('is-expanded');
                toggle.textContent = open ? 'Show less' : 'Read more';
                toggle.setAttribute('aria-expanded', String(open));
            });
            let t = null;
            window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(measure, 150); });
        }
    }

    renderFollowButton() {
        const btn = document.getElementById('followBtn');
        if (!btn) return;
        btn.innerHTML = this.isFollowing ? '<i class="fas fa-heart"></i> Following' : '<i class="fas fa-heart"></i> Follow';
        btn.classList.toggle('btn-primary', this.isFollowing);
        btn.classList.toggle('btn-outline', !this.isFollowing);
        btn.setAttribute('aria-pressed', String(this.isFollowing));
    }

    renderStoreInfo() {
        if (!this.store) return;

        document.title = `${this.store.name} - NextaStore`;

        // The current page origin is the canonical host. This also covers the
        // legacy store-detail.html?store=... form and keeps the canonical URL
        // correct when the platform moves domains without a frontend edit.
        if (this.store.slug) {
            let canonical = document.querySelector('link[rel="canonical"]');
            if (!canonical) {
                canonical = document.createElement('link');
                canonical.rel = 'canonical';
                document.head.appendChild(canonical);
            }
            canonical.href = new URL(`/${encodeURIComponent(this.store.slug)}`, window.location.origin).href;
        }

        // Update breadcrumb
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = `
                <a href="/marketplace">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="storeBreadcrumb">${app.escapeHtml(this.store.name)}</span>
            `;
        }

        // Unified banner: color and/or image both come from the store record,
        // rendered the same way here as everywhere else in the app (see
        // js/store-banner.js). The accent bar keeps the store's color visible
        // even if this page's layout changes above the fold.
        const banner = document.getElementById('storeBanner');
        if (banner) banner.innerHTML = '';
        window.NextaStoreBanner?.applyStoreBanner(this.store, {
            full: banner,
            accents: [document.getElementById('storeAccentBar')]
        });

        // Update logo with proper styling
        const logo = document.getElementById('storeLogo');
        if (logo) {
            if (this.store.logo) {
                logo.style.backgroundImage = this.cssUrl(this.store.logo);
                logo.style.backgroundSize = 'cover';
                logo.style.backgroundPosition = 'center';
                logo.innerHTML = '';
            } else {
                logo.style.backgroundImage = 'none';
                logo.textContent = app.getInitial(this.store.name);
            }
        }

        this.renderTierDecor();
        this.renderOwnerPreview();

        // Update store info
        const nameEl = document.getElementById('storeName');
        nameEl.textContent = this.store.name;
        nameEl.title = this.store.name;
        document.getElementById('storeDescription').textContent = this.store.description || 'Welcome to our store!';
        this.setupDescriptionClamp();
        const badges = document.getElementById('storeBadges'); if (badges) badges.innerHTML = this.renderHeroBadges();
        this.renderTrustSignals();

        // Update location if available
        const location = [];
        if (this.store.district) {
            location.push(this.store.district);
        }
        if (this.store.address) {
            location.push(this.store.address);
        }
        if (location.length > 0) {
            const locEl = document.getElementById('storeLocation');
            locEl.textContent = location.join(', ');
            locEl.title = location.join(', ');
            locEl.parentElement.style.display = 'flex';
        } else {
            document.getElementById('storeLocation').parentElement.style.display = 'none';
        }

        // "About this store" card — only claims the backend actually
        // supports (verified flag, product count, location). Completed-order
        // counts used to appear here too, but NextaStore only connects buyer
        // and seller (fulfillment happens off-platform between them), so it
        // can't vouch for whether an order was really completed — not a
        // verifiable trust signal, same reasoning that retired star ratings.
        // The old static "response time / shipping" rows were placeholders
        // with no data behind them and leaked seller-only marketing into the
        // buyer view.
        const infoCard = document.getElementById('storeInfoCard');
        if (infoCard) {
            const infoRows = [];
            const productCount = this.store.productCount || 0;
            infoRows.push(`<div class="info-row"><i class="fas fa-box"></i><span>${productCount.toLocaleString()} ${productCount === 1 ? 'product' : 'products'} listed</span></div>`);
            if (location.length) {
                infoRows.push(`<div class="info-row"><i class="fas fa-location-dot"></i><span>${app.escapeHtml(location.join(', '))}</span></div>`);
            }
            // Free-text directions from the seller can run long — clamped
            // to a few lines with its own Show more toggle.
            if (this.store.detailedDirections && String(this.store.detailedDirections).trim()) {
                infoRows.push(`<div class="info-row info-row--directions"><i class="fas fa-route"></i><div class="info-directions"><p class="info-directions-text">${app.escapeHtml(String(this.store.detailedDirections).trim())}</p><button type="button" class="info-directions-toggle" hidden aria-expanded="false">Show more</button></div></div>`);
            }
            // The backend only ever includes phoneNumber in this payload
            // when the seller has opted to show it (Store.phonePublic) —
            // see serializePublicStore in nextastore-backend/src/helpers.js
            // — so presence here already means "safe to show".
            if (this.store.phoneNumber) {
                const tel = this.store.phoneNumber.replace(/[^\d+]/g, '');
                infoRows.push(`<div class="info-row"><i class="fas fa-phone"></i><span><a href="tel:${app.escapeHtml(tel)}">${app.escapeHtml(this.store.phoneNumber)}</a></span></div>`);
            }
            infoCard.innerHTML = infoRows.join('');
            this.setupDirectionsClamp(infoCard);
        }

        this.renderStoreMap();

        // Show store actions
        const storeActions = document.querySelector('.store-actions');
        if (storeActions) {
            storeActions.style.display = 'flex';
        }

        // Hide loading state for store info
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
    }

    /** Directions text: clamp to 3 lines, offer Show more only when needed. */
    setupDirectionsClamp(root) {
        const text = root.querySelector('.info-directions-text');
        const toggle = root.querySelector('.info-directions-toggle');
        if (!text || !toggle) return;
        requestAnimationFrame(() => { toggle.hidden = !(text.scrollHeight > text.clientHeight + 1); });
        toggle.addEventListener('click', () => {
            const open = text.classList.toggle('is-expanded');
            toggle.textContent = open ? 'Show less' : 'Show more';
            toggle.setAttribute('aria-expanded', String(open));
        });
    }

    /** Map preview under the About card, sized to the space it's actually
     *  in (sidebar on desktop, full width below the products on mobile). */
    renderStoreMap() {
        const mapPreview = document.getElementById('storeMapPreview');
        if (!mapPreview || !this.store) return;
        const coords = this.store.mapCoordinates;
        const [lat, lng] = coords ? String(coords).split(',').map(Number) : [NaN, NaN];
        if (!(Number.isFinite(lat) && Number.isFinite(lng))) { mapPreview.style.display = 'none'; return; }
        mapPreview.style.display = 'block';
        mapPreview.innerHTML = '';
        // Measure the slot itself (not its padded parent card, which made the
        // frame wider than the space it sits in and clip on desktop).
        const width = Math.max(200, Math.min(Math.round(mapPreview.getBoundingClientRect().width) || 260, 560));
        window.NextaStoreMapPreview?.render(mapPreview, {
            lat, lng, width, height: width > 400 ? 200 : 140,
            mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}`
        });
    }

    /** The store's paid-commitment tier, or null. Whitelisted: the tone ends up
     *  in class names and a data attribute. */
    get tier() {
        const t = this.store?.tier;
        return t && ['verified', 'gold', 'platinum'].includes(t.tone) ? t : null;
    }

    /** What a badge buys on the storefront itself: a ribbon on the banner, a
     *  medal on the logo, a tier-coloured frame, a "why trust this seller"
     *  card, and (see renderProducts) a mark on every product. All of it is
     *  driven by data-tier on the hero, so an unbadged store renders exactly
     *  as before. */
    renderTierDecor() {
        const hero = document.getElementById('storeHero');
        if (!hero) return;
        hero.querySelectorAll('.tier-ribbon, .tier-medal').forEach(el => el.remove());
        document.getElementById('storeTrustCard')?.remove();
        const tier = this.tier;
        if (!tier) { delete hero.dataset.tier; return; }
        hero.dataset.tier = tier.tone;

        const icon = /^fa-[a-z0-9-]{1,32}$/.test(tier.icon || '') ? tier.icon : 'fa-circle-check';
        const ribbon = document.createElement('div');
        ribbon.className = `tier-ribbon tier-ribbon--${tier.tone}`;
        ribbon.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i><span></span>`;
        ribbon.querySelector('span').textContent = tier.label;
        document.getElementById('storeBanner')?.after(ribbon);

        const wrap = document.querySelector('.store-logo-wrap');
        if (wrap) {
            const medal = document.createElement('span');
            medal.className = `tier-medal tier-medal--${tier.tone}`;
            medal.title = tier.label;
            medal.setAttribute('role', 'img');
            medal.setAttribute('aria-label', tier.label);
            medal.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i>`;
            wrap.appendChild(medal);
        }

        // Buyer-facing explanation, using only what the badge is derived from
        // (confirmed, paid coverage) - see sellerBadges() in the API.
        const badge = (this.store.badges || []).find(b => b.tone === tier.tone);
        const infoSection = document.getElementById('storeInfoSection');
        if (infoSection && badge) {
            const card = document.createElement('div');
            card.className = `store-trust-card store-trust-card--${tier.tone}`;
            card.id = 'storeTrustCard';
            card.innerHTML = `<div class="store-trust-card-icon"><i class="fas ${icon}" aria-hidden="true"></i></div><div><strong></strong><p></p></div>`;
            card.querySelector('strong').textContent = tier.label;
            card.querySelector('p').textContent = `${badge.reason || 'A long-standing seller on NextaStore'}. Confirmed by us, not self-declared.`;
            infoSection.prepend(card);
        }
    }

    /** Only the OWNER's own view carries `store.preview` (the API never sends
     *  it to anyone else). It turns their storefront into a status page for
     *  it: a lapsed store gets the rolling shutter over its banner and a
     *  renew strip; one about to lapse gets a countdown strip; a draft a
     *  reminder that shoppers can't see it yet. */
    renderOwnerPreview() {
        document.getElementById('storePreviewStrip')?.remove();
        document.body.classList.remove('store-lapsed');
        document.getElementById('storeBanner')?.querySelector('.banner-shutter')?.remove();
        const preview = this.store?.preview;
        if (!preview || !['draft', 'lapsed', 'ending'].includes(preview.state)) return;

        const strip = document.createElement('div');
        strip.id = 'storePreviewStrip';
        strip.className = `preview-strip preview-strip--${preview.state}`;
        strip.setAttribute('role', 'status');
        const fmt = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; } };
        let icon, title, text, cta;
        if (preview.state === 'lapsed') {
            icon = 'fa-lock';
            title = preview.hadPaidPlan ? 'Your month has ended - this store is closed' : 'Your free trial has ended - this store is closed';
            text = `Shoppers see a closed shop${preview.endedAt ? ` (since ${fmt(preview.endedAt)})` : ''} and can't order. Only you can see this page.`;
            cta = { href: '/subscription', label: 'Renew to reopen', icon: 'fa-key' };
            document.body.classList.add('store-lapsed');
            const shutter = document.createElement('div');
            shutter.className = 'banner-shutter';
            shutter.setAttribute('aria-hidden', 'true');
            shutter.innerHTML = '<span class="banner-shutter-tag"><i class="fas fa-lock"></i> Closed</span>';
            document.getElementById('storeBanner')?.appendChild(shutter);
        } else if (preview.state === 'ending') {
            const d = preview.daysLeft;
            icon = 'fa-hourglass-half';
            title = d <= 0 ? 'Last day: your store closes today' : `${d} day${d === 1 ? '' : 's'} left ${preview.onTrial ? 'on your free trial' : 'in your paid month'}`;
            text = 'When time runs out shoppers will see a closed shop. Renew now to stay open without a gap.';
            cta = { href: '/subscription', label: 'Renew now', icon: 'fa-rotate' };
        } else {
            icon = 'fa-eye-slash';
            title = 'Only you can see this store';
            text = 'It isn\u2019t launched yet, so shoppers get a \u201cstill being set up\u201d page.';
            cta = { href: '/dashboard', label: 'Open dashboard', icon: 'fa-gauge' };
        }
        strip.innerHTML = `<i class="fas ${icon} preview-strip-icon" aria-hidden="true"></i><div class="preview-strip-copy"><strong></strong><span></span></div><a class="btn btn-sm preview-strip-cta"><i class="fas ${cta.icon}"></i> <span></span></a>`;
        strip.querySelector('strong').textContent = title;
        strip.querySelector('.preview-strip-copy span').textContent = text;
        const a = strip.querySelector('a');
        a.href = cta.href;
        a.querySelector('span').textContent = cta.label;
        document.getElementById('storeAccentBar')?.after(strip);
    }

    /** CSS url() from a stored image reference, quoted and escaped so a stored
     *  value can never end the url() early. */
    cssUrl(ref) {
        const u = app.resolveImageUrl(ref);
        return u ? `url("${String(u).replace(/["\\\n\r)]/g, c => encodeURIComponent(c))}")` : 'none';
    }

    /** Renders why the store couldn't be shown — a distinct, appropriately
     *  toned state per reason, not one generic "not found" for every case:
     *    STORE_DRAFT    — the seller hasn't launched yet. Common when a
     *                     seller shares their own link early, or someone
     *                     revisits a link from before launch. Encouraging,
     *                     not alarming — nothing is wrong.
     *    STORE_INACTIVE — the store launched but its trial lapsed without
     *                     a confirmed payment. Neutral wording that never
     *                     surfaces *why* to a shopper (that's between the
     *                     seller and the platform) — just that it isn't
     *                     taking orders right now, with a nudge elsewhere.
     *    (anything else) — genuinely missing, deleted, or a network error.
     *                      Keeps the original "not found" copy. */
    renderStoreUnavailable(code, closedStore = null) {
        const copy = {
            STORE_DRAFT: {
                icon: 'fa-hourglass-half',
                title: 'This Store Is Still Being Set Up',
                description: 'The seller hasn\u2019t finished launching this store yet — check back soon.',
                crumb: 'Store Not Yet Open',
                body: 'This store is still being set up by its owner. It\u2019ll appear here as soon as they launch it.',
            },
            STORE_INACTIVE: {
                icon: 'fa-store-slash',
                title: 'This Store Isn\u2019t Available Right Now',
                description: 'It isn\u2019t taking orders at the moment — check back later, or explore other stores in the meantime.',
                crumb: 'Store Unavailable',
                body: 'This store isn\u2019t accepting orders right now. In the meantime, there are plenty of other great stores on NextaStore.',
            },
        }[code] || {
            icon: 'fa-store-slash',
            title: 'Store Not Found',
            description: 'This store may have been removed or the link is incorrect.',
            crumb: 'Store Not Found',
            body: 'This store may have been removed or the link is incorrect.',
        };

        // Hide loading states
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');

        // No store → no filter panel and no about card to render.
        const filters = document.getElementById('storeFilters');
        if (filters) filters.hidden = true;
        const infoSection = document.getElementById('storeInfoSection');
        if (infoSection) infoSection.hidden = true;

        document.getElementById('storeName').textContent = copy.title;
        document.getElementById('storeDescription').textContent = copy.description;
        document.getElementById('storeBadges').innerHTML = '';
        document.getElementById('storeDescriptionToggle')?.setAttribute('hidden', '');
        document.querySelector('.mobile-sidebar-toggle')?.setAttribute('hidden', '');
        document.getElementById('productsCount')?.replaceChildren();
        document.getElementById('storeLocation').textContent = 'Unknown';
        const trust = document.getElementById('storeTrustSignals'); if (trust) trust.innerHTML = '';

        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = `
                <a href="/marketplace">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current">${copy.crumb}</span>
            `;
        }

        // Hide the store actions
        const storeActions = document.querySelector('.store-actions');
        if (storeActions) {
            storeActions.style.display = 'none';
        }

        // A store that WAS open and has closed gets its own page: its shop sign,
        // logo and colour, with the shutter down. It says only "closed for
        // now" - never why (a lapsed plan is the seller's business), and it
        // is a real 404 from the API so search engines drop it.
        if (code === 'STORE_INACTIVE' && closedStore && closedStore.name) {
            this.renderClosedShop(closedStore);
            return;
        }

        document.getElementById('productsGrid').innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas ${copy.icon}"></i></div>
                <h3>${copy.title}</h3>
                <p>${copy.body}</p>
                <a href="/marketplace" class="btn btn-primary"><i class="fas fa-store"></i> Browse Other Stores</a>
            </div>
        `;
    }

    /** The visitor's view of a store that has closed: the whole screen is the
     *  shopfront with its shutter rolled down (sign, awning, shutter, "Closed
     *  for now", and a way out to the marketplace). It replaces the page - no
     *  header, filters or product panel. Only shoppers get this; the owner of
     *  a lapsed store never reaches here (the API sends them the real store
     *  with `preview`, see renderOwnerPreview). Built with DOM APIs /
     *  textContent (the name comes from a seller), colour only if it is a
     *  plain hex value. */
    renderClosedShop(closed) {
        const name = String(closed.name).slice(0, 80);
        const color = /^#[0-9a-f]{3,8}$/i.test(closed.bannerColor || '') ? closed.bannerColor : '#0B3B2B';
        document.title = `${name} - Closed - NextaStore`;
        let robots = document.querySelector('meta[name="robots"]');
        if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
        robots.content = 'noindex, nofollow';
        document.getElementById('storeName').textContent = name;
        document.getElementById('storeDescription').textContent = 'This shop is closed for now.';
        document.getElementById('storeAccentBar')?.style.setProperty('background', color);
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);

        document.getElementById('closedShopScreen')?.remove();
        const screen = document.createElement('div');
        screen.id = 'closedShopScreen';
        screen.className = 'closed-screen';
        screen.setAttribute('role', 'main');
        screen.setAttribute('style', `--shop-color:${color};`);
        screen.innerHTML = `
            <div class="closed-screen-shop">
                <div class="closed-screen-top">
                    <a href="/marketplace" class="closed-screen-back" data-back-link data-back-fallback="/marketplace" data-back-fallback-label="Back to marketplace"><i class="fas fa-arrow-left" aria-hidden="true"></i> <span data-back-label>Back</span></a>
                </div>
                <div class="closed-shop-sign">
                    <span class="closed-shop-logo" id="closedShopLogo"></span>
                    <h1 class="closed-shop-name" id="closedShopName"></h1>
                </div>
                <div class="closed-shop-awning" aria-hidden="true"></div>
                <div class="closed-shop-window">
                    <div class="closed-shop-shutter" aria-hidden="true">
                        <span class="closed-shop-handle"></span>
                    </div>
                    <div class="closed-shop-door-sign"><i class="fas fa-lock" aria-hidden="true"></i> Closed for now</div>
                </div>
                <div class="closed-screen-ground">
                    <p class="closed-shop-note">This shop isn\u2019t open right now. Explore other stores while you wait.</p>
                    <a href="/marketplace" class="btn btn-primary"><i class="fas fa-store" aria-hidden="true"></i> Browse Other Stores</a>
                </div>
            </div>`;
        document.body.appendChild(screen);
        window.NextaBack?.wire(screen);
        document.body.classList.add('store-closed-public');
        document.getElementById('closedShopName').textContent = name;
        const logo = document.getElementById('closedShopLogo');
        if (closed.logo) { logo.style.backgroundImage = this.cssUrl(closed.logo); logo.classList.add('has-image'); }
        else logo.textContent = app.getInitial(name);
    }

    async loadProducts(page = 1, append = false) {
        try {
            const storeKey = this.storeKeyFromLocation() || this.store?.slug || this.store?.id;
            if (!storeKey) throw new Error('Store not specified.');

            const params = new URLSearchParams({
                store: storeKey,
                page: String(page),
                limit: '24',
                sort: this.currentSort
            });
            if (this.currentCategory !== 'all') params.set('category', this.currentCategory);
            if (this.searchTerm) params.set('q', this.searchTerm);
            if (this.priceRange.min !== null) params.set('minPrice', String(this.priceRange.min));
            if (this.priceRange.max !== null) params.set('maxPrice', String(this.priceRange.max));

            const response = await app.apiRequest(`/products?${params.toString()}`);
            this.products = append ? [...this.products, ...(response.data || [])] : (response.data || []);
            this.productsPage = page;
            this.productsPagination = response.pagination || null;
            this.renderProducts();
            this.loadFavoriteStates();
        } catch (error) {
            console.error('Failed to load products:', error);
            this.products = [];
            this.productsPagination = null;
            this.renderProducts();
        }
    }

    /** Sets each visible product card's heart to match the shopper's saved
     *  favorites. Signed-out visitors make no requests at all, and each
     *  product is only ever checked once — "Load more" or a filter change
     *  re-paints hearts from what's already known instead of re-asking the
     *  server about every card on the page. */
    setHeart(productId, on) {
        const btn = document.querySelector(`.product-card[data-product-id="${CSS.escape(String(productId))}"] .favorite-btn`);
        const icon = btn?.querySelector('i');
        if (!btn || !icon) return;
        icon.classList.toggle('fas', on);
        icon.classList.toggle('far', !on);
        btn.classList.toggle('is-favorite', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    async loadFavoriteStates() {
        if (!this.products?.length) return;
        this.favoriteIds = this.favoriteIds || new Set();
        this.favoriteChecked = this.favoriteChecked || new Set();
        this.favoriteIds.forEach(id => this.setHeart(id, true));
        if (!app.token) return;
        const pending = this.products.filter(p => !this.favoriteChecked.has(p.id));
        if (!pending.length) return;
        // One request for the whole page. An older backend (or the mock API)
        // has no /favorites/check: there "check" is read as a product id and
        // the answer has no list in it, so anything that isn't an array falls
        // through to the old one-request-per-card lookup below.
        try {
            const ids = pending.slice(0, 60).map(p => encodeURIComponent(p.id)).join(',');
            const bulk = await app.apiRequest(`/favorites/check?ids=${ids}`);
            if (Array.isArray(bulk?.data?.favorited)) {
                const saved = new Set(bulk.data.favorited);
                pending.slice(0, 60).forEach(p => {
                    this.favoriteChecked.add(p.id);
                    if (saved.has(p.id)) { this.favoriteIds.add(p.id); this.setHeart(p.id, true); }
                });
                if (pending.length <= 60) return;
                pending.splice(0, 60);
            }
        } catch (error) { /* fall through to the per-card lookup */ }
        await Promise.all(pending.map(async (product) => {
            try {
                const response = await app.apiRequest(`/favorites/${encodeURIComponent(product.id)}`);
                this.favoriteChecked.add(product.id);
                if (response.data?.favorited) { this.favoriteIds.add(product.id); this.setHeart(product.id, true); }
            } catch (error) { /* leave the heart in its default state */ }
        }));
    }

    renderSearchPreview(term) {
        const bar = document.getElementById('storeSearchBar');
        const dropdown = document.getElementById('storeSearchPreview');
        const q = (term || '').trim().toLowerCase();
        if (!bar || !dropdown) return;
        if (q.length < 2) { this.closeSearchPreview(); return; }
        const matches = (this.products || []).filter(p => String(p.name || '').toLowerCase().includes(q)).slice(0, 6);
        if (!matches.length) { dropdown.innerHTML = `<div class="search-preview-empty">No products match “${app.escapeHtml(term)}”.</div>`; bar.classList.add('open'); return; }
        dropdown.innerHTML = matches.map(p => `<a class="search-preview-item" href="${app.productLink(p, this.store?.slug)}"><span class="search-preview-thumb" style="${app.productThumb(p) ? `background-image:url('${app.escapeHtml(app.productThumb(p))}')` : ''}">${app.productThumb(p) ? '' : '<i class="fas fa-box"></i>'}</span><span><span class="search-preview-name">${app.escapeHtml(p.name)}</span><span class="search-preview-meta">${app.formatCurrency(p.price)}</span></span></a>`).join('');
        bar.classList.add('open');
    }

    closeSearchPreview() { document.getElementById('storeSearchBar')?.classList.remove('open'); }

    /** "24 products" / "Showing 24 of 130 products" + the mobile drawer's
     *  "Show N results" button label. */
    renderProductsCount() {
        const shown = this.products.length;
        const total = this.productsPagination?.total ?? shown;
        const el = document.getElementById('productsCount');
        if (el) {
            el.textContent = !total ? '' : (shown < total
                ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} products`
                : `${total.toLocaleString()} ${total === 1 ? 'product' : 'products'}`);
        }
        const apply = document.getElementById('drawerApply');
        if (apply) apply.textContent = total ? `Show ${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}` : 'No results';
    }

    renderProducts() {
        const grid = document.getElementById('productsGrid');
        const filtered = [...this.products];

        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');

        const heading = document.getElementById('productsHeading');
        if (heading) {
            const activeLabel = this.currentCategory !== 'all'
                ? (this.categoryLabels[this.currentCategory] || this.currentCategory)
                : null;
            heading.textContent = activeLabel ? `Shop ${activeLabel}` : 'Shop this store';
            heading.dataset.count = String(this.productsPagination?.total ?? filtered.length);
        }
        this.renderProductsCount();
        this.renderFilterState();

        if (!filtered.length) {
            const hasActiveFilters = this.hasActiveFilters();
            grid.innerHTML = hasActiveFilters ? `
                <div class="empty-state store-empty-state" style="grid-column: 1/-1;">
                    <div class="empty-icon"><i class="fas fa-filter-circle-xmark"></i></div>
                    <h3>No products match your filters</h3>
                    <p>Try a different category, price range, or search term.</p>
                    <button class="btn btn-outline" onclick="resetFilters()">Reset Filters</button>
                </div>
            ` : `
                <div class="empty-state store-empty-state" style="grid-column: 1/-1;">
                    <div class="empty-icon"><i class="fas fa-store"></i></div>
                    <h3>This store is still stocking its shelves</h3>
                    <p>${app.escapeHtml(this.store?.name || 'This store')} hasn't added any products yet. Check back soon, or message the seller directly.</p>
                    <div class="store-empty-actions">
                        <button class="btn btn-outline" id="emptyStateMessageBtn"><i class="fas fa-comment"></i> Message seller</button>
                        <a href="/marketplace" class="btn btn-primary"><i class="fas fa-store"></i> Browse Other Stores</a>
                    </div>
                </div>
            `;
            document.getElementById('emptyStateMessageBtn')?.addEventListener('click', () => this.openContactModal());
            return;
        }

        const esc = (v) => app.escapeHtml(String(v ?? ''));
        const total = this.productsPagination?.total ?? filtered.length;
        const remaining = Math.max(total - filtered.length, 0);
        const hasMore = this.productsPagination?.page < this.productsPagination?.pages;

        grid.innerHTML = filtered.map(product => {
            const thumb = app.productThumb(product);
            const hasDiscount = product.originalPrice && product.originalPrice > product.price;
            const pct = hasDiscount ? Math.min(99, Math.max(1, Math.round((1 - product.price / product.originalPrice) * 100))) : 0;
            const fallback = `<div class="product-image-fallback"><i class="fas ${esc(product.icon || 'fa-box')}"></i></div>`;
            return `
            <div class="product-card" data-product-id="${esc(product.id)}"${this.tier ? ` data-tier="${this.tier.tone}"` : ''} tabindex="0" role="link" aria-label="${esc(product.name)}">
                <div class="product-image">
                    ${thumb
                        ? `<img src="${esc(thumb)}" alt="${esc(product.name)}" loading="lazy" decoding="async" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${esc(fallback)}">`
                        : fallback}
                    <button class="favorite-btn" aria-label="Save to favorites"><i class="far fa-heart"></i></button>
                    ${pct ? `<span class="discount-badge">-${pct}%</span>` : ''}
                    ${app.renderTierMark(this.tier)}
                </div>
                <div class="product-details">
                    <div class="product-text">
                        <h3 title="${esc(product.name)}">${esc(product.name)}</h3>
                        <p class="product-price">
                            <span class="current-price">${product.listingType === 'service' ? 'From ' : ''}${app.formatCurrency(product.price)}</span>
                            ${hasDiscount ? `<span class="original-price">${app.formatCurrency(product.originalPrice)}</span>` : ''}
                        </p>
                    </div>
                    ${product.listingType && product.listingType !== 'physical'
                        ? '<button class="btn btn-outline btn-sm"><i class="fas fa-message"></i> <span>Enquire</span></button>'
                        : '<button class="btn btn-primary btn-sm add-to-cart"><i class="fas fa-cart-plus"></i> <span>Add to Cart</span></button>'}
                </div>
            </div>`;
        }).join('') + (hasMore
            ? `<div class="load-more-row"><button type="button" class="btn btn-outline" id="storeLoadMoreProducts">Load more${remaining ? ` (${remaining.toLocaleString()} more)` : ''}</button></div>` : '');

        document.getElementById('storeLoadMoreProducts')?.addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = 'Loading…';
            this.loadProducts(this.productsPage + 1, true);
        });
    }

    setupProductEventListeners() {
        const grid = document.getElementById('productsGrid');
        if (!grid || grid.dataset.cartEventsBound === '1') return;
        grid.dataset.cartEventsBound = '1';
        grid.addEventListener('click', (e) => {
            const card = e.target.closest('.product-card');
            if (!card) return;
            const productId = card.dataset.productId;
            if (e.target.closest('.add-to-cart')) { e.stopPropagation(); this.addToCart(productId); }
            else if (e.target.closest('.favorite-btn')) { e.stopPropagation(); this.toggleFavorite(productId); }
            else this.viewProductDetail(productId);
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('button, a')) return;
            const card = e.target.closest('.product-card');
            if (!card) return;
            e.preventDefault();
            this.viewProductDetail(card.dataset.productId);
        });
    }

    addToCart(productId, quantity = 1) {
        const product = this.products.find(p => p.id === productId);
        if (!product) return;
        // The owner can view their own lapsed / draft store; it still takes no
        // orders (the API refuses them too), so don't fill a cart that can't check out.
        if (['lapsed', 'draft'].includes(this.store?.preview?.state)) {
            app.showAlert('This store is closed to shoppers, so nothing can be added to a cart.', 'error');
            return;
        }
        try { window.NextaCart.add(product, quantity, this.store); app.showAlert(`Added ${quantity} item(s) to cart`, 'success'); }
        catch (error) { app.showAlert(error.message, 'error'); }
    }

    updateCartUI() {
        const count = window.NextaCart?.count() || 0;
        document.querySelectorAll('.cart-count').forEach(el => el.textContent = count);
        const root = document.querySelector('.cart-items');
        if (root) window.NextaCart.renderMiniCart(root);
    }

    async toggleFavorite(productId) {
        if (!app.requireLogin('Log in to save items to your favorites.', { type: 'favorite-product', productId })) return;
        this.favoriteIds = this.favoriteIds || new Set();
        const wasOn = this.favoriteIds.has(productId) || !!document.querySelector(`.product-card[data-product-id="${CSS.escape(String(productId))}"] .favorite-btn i.fas`);
        // Optimistic: flip the heart now, undo if the server says no.
        if (wasOn) this.favoriteIds.delete(productId); else this.favoriteIds.add(productId);
        this.setHeart(productId, !wasOn);
        try {
            await app.apiRequest(`/favorites/${encodeURIComponent(productId)}`, { method: wasOn ? 'DELETE' : 'POST' });
            app.showAlert(wasOn ? 'Removed from favorites' : 'Added to favorites', 'success');
        } catch (error) {
            if (wasOn) this.favoriteIds.add(productId); else this.favoriteIds.delete(productId);
            this.setHeart(productId, wasOn);
            app.showAlert(error.message || 'Could not update your favorites. Please try again.', 'error');
        }
    }

    viewProductDetail(productId) {
        const storeKey = this.store?.slug || this.storeKeyFromLocation();
        const product = (this.products || []).find(p => p.id === productId);
        window.location.href = app.productLink({ id: productId, name: product?.name }, storeKey);
    }

    async toggleFollow() {
        if (!app.requireLogin('Log in to follow this store.', { type: 'follow-store', storeId: this.store?.id })) return;
        if (!this.store?.id) return;
        const btn = document.getElementById('followBtn');
        if (!btn || btn.disabled) return;
        const wasFollowing = this.isFollowing;
        btn.disabled = true;
        try {
            const response = await app.apiRequest(`/store/follow/${encodeURIComponent(this.store.id)}`, {
                method: wasFollowing ? 'DELETE' : 'POST'
            });
            this.isFollowing = !!response.data?.following;
            if (typeof response.data?.followers === 'number') this.store.followers = response.data.followers;
            this.renderFollowButton();
            this.renderTrustSignals();
            app.showAlert(this.isFollowing ? 'You are now following this store' : 'Unfollowed this store', 'success');
        } catch (error) {
            console.error('Failed to update store follow:', error);
            app.showAlert(error.message || 'Could not update your follow. Please try again.', 'error');
        } finally {
            btn.disabled = false;
            this.renderFollowButton();
        }
    }

    openContactModal() {
        if (!app.requireLogin('Log in to message this seller.', { type: 'contact-seller' })) return;
        app.openMessageSellerModal({ store: this.store, product: this.getContextProduct?.() || null });
    }

    async handleContactSubmit() { /* handled by app.openMessageSellerModal */ }

    openShareModal() {
        document.getElementById('shareModal').classList.add('open');
    }

    handleShare(platform) {
        const url = window.location.href;
        const title = `Check out ${this.store?.name || 'this amazing store'} on NextaStore!`;

        switch (platform) {
            case 'whatsapp':
                window.open(`https://wa.me/?text=${encodeURIComponent(title + ' ' + url)}`, '_blank');
                break;
            case 'facebook':
                window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank');
                break;
            case 'twitter':
                window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`, '_blank');
                break;
            case 'copy':
                navigator.clipboard.writeText(url).then(() => {
                    app.showAlert('Link copied to clipboard!', 'success');
                });
                break;
        }

        document.getElementById('shareModal').classList.remove('open');
    }

    updateQuantity(productId, change) { try { window.NextaCart.change(productId, change); } catch (e) { app.showAlert(e.message, 'error'); } }

    removeFromCart(productId) { window.NextaCart.remove(productId); }
}

// Global functions for event handlers
let storeDetailManager;

function updateCartQuantity(productId, change) {
    storeDetailManager?.updateQuantity(productId, change);
}

function removeFromCart(productId) {
    storeDetailManager?.removeFromCart(productId);
}

function resetFilters() {
    storeDetailManager?.removeFilter('all');
}

// Initialize
if (document.querySelector('.store-content')) {
    storeDetailManager = new StoreDetailManager();
}