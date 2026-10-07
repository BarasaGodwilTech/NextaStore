/* ==========================================================================
   Marketplace page (WIP 50 rebuild)

   Cards: stores and products are real links (<a>), so middle-click / open in a
   new tab / long-press all work and there is no nested button-in-a-button.
   Images are lazy <img> tags with a fallback (broken URL -> colour / initial /
   icon), never CSS background-image strings built from raw data.
   Paging: the first page size follows the grid (columns x rows) so the last
   row is never half empty; "Show more" loads the next page of the SAME size.
   State lives in the URL (?category=, ?search=) so a filtered view can be
   shared or refreshed.
   ========================================================================== */
(function () {
    'use strict';

    const FA_ICON = /^fa-[a-z0-9-]{1,32}$/;
    const HEX = /^#[0-9a-f]{3,8}$/i;
    const TIERS = ['verified', 'gold', 'platinum'];
    const NBSP = '\u00a0';

    let compactFmt = null;
    try { compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }); } catch (e) { compactFmt = null; }

    /** 1234 -> "1,234"; 12345 -> "12.3K"; 1250000 -> "1.3M". Never throws. */
    function compact(n) {
        n = Number(n);
        if (!Number.isFinite(n) || n < 0) n = 0;
        if (n < 10000 || !compactFmt) return Math.round(n).toLocaleString('en-UG');
        return compactFmt.format(n);
    }
    function full(n) { n = Number(n); return (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0).toLocaleString('en-UG'); }
    /** "UGX 25,000" with a non-breaking space; absurdly large prices fall back to "UGX 1.2T". */
    function price(n) {
        n = Number(n);
        if (!Number.isFinite(n) || n < 0) n = 0;
        const text = n >= 1e12 ? 'UGX ' + compact(n) : app.formatCurrency(n);
        return text.replace(' ', NBSP);
    }
    const SORTS = ['popular', 'newest', 'price-low', 'price-high'];
    /** "25,000" / "25000" / " 25 000 " -> 25000; blank or nonsense -> null. */
    function parsePrice(v) {
        const digits = String(v ?? '').replace(/\D/g, '').slice(0, 12);
        return digits ? Number(digits) : null;
    }
    function plural(n, one, many) { return n === 1 ? one : many; }
    function initialOf(name) { return (Array.from(String(name || '').trim())[0] || '?').toUpperCase(); }
    function safeColor(c) { return HEX.test(String(c || '')) ? c : (window.NextaStoreBanner?.DEFAULT_BANNER_COLOR || '#00B074'); }
    function esc(v) { return app.escapeHtml(String(v ?? '')); }

class MarketplaceManager {
    constructor() {
        this.stores = [];
        this.products = [];
        this.storesTotal = 0;
        this.productsTotal = 0;
        this.productsPage = 1;
        this.productsPages = 1;
        this.currentFilter = 'all';
        this.searchTerm = '';
        this.sort = 'popular';
        this.minPrice = null;
        this.maxPrice = null;
        this.favoriteIds = new Set();
        this.favoriteChecked = new Set();
        this.hasRendered = false;
        this.loadingMore = false;
        this.searchRequestId = 0;
        this.catalogRequestId = 0;
        this.catalogSearchDebounce = null;

        // Page sizes follow the grid so the last row is full:
        // stores 2 / 3 / 4 / 5 columns, products 2-4 / 6 columns (see marketplace.css).
        const vw = window.innerWidth || 1024;
        this.storePageSize = vw >= 1280 ? 15 : (vw < 760 ? 8 : 12);
        this.productPageSize = vw >= 1280 ? 18 : 12;

        this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));
    }

    async init() {
        this.readUrlState();
        this.setupEventListeners();
        app.renderAccountNavs();
        this.setupHero();
        this.renderHeroSkeleton();
        this.renderSkeletons();
        this.updateTitles();
        await this.applyCatalogFilters();
    }

    /** ?category=food&search=mug -> initial filter state (validated). */
    readUrlState() {
        const params = new URLSearchParams(window.location.search);
        const cat = (params.get('category') || '').toLowerCase();
        if (cat && window.NXCategories && window.NXCategories.get(cat)) this.currentFilter = cat;
        this.searchTerm = (params.get('search') || '').trim().slice(0, 100);
        if (SORTS.includes(params.get('sort'))) this.sort = params.get('sort');
        this.minPrice = parsePrice(params.get('min'));
        this.maxPrice = parsePrice(params.get('max'));
        if (this.minPrice !== null && this.maxPrice !== null && this.minPrice > this.maxPrice) [this.minPrice, this.maxPrice] = [this.maxPrice, this.minPrice];
        const input = document.getElementById('marketplaceSearch');
        if (input && this.searchTerm) input.value = this.searchTerm;
    }

    syncUrl() {
        try {
            const params = new URLSearchParams();
            if (this.searchTerm) params.set('search', this.searchTerm);
            if (this.currentFilter && this.currentFilter !== 'all') params.set('category', this.currentFilter);
            if (this.sort !== 'popular') params.set('sort', this.sort);
            if (this.minPrice !== null) params.set('min', String(this.minPrice));
            if (this.maxPrice !== null) params.set('max', String(this.maxPrice));
            const qs = params.toString();
            window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
        } catch (e) { /* history API unavailable: the page still works */ }
    }

    get isFiltered() { return !!this.searchTerm || (this.currentFilter && this.currentFilter !== 'all') || this.minPrice !== null || this.maxPrice !== null; }
    /** Search and category change the stores list; the price range and sort only change products. */
    get hasStoreFilter() { return !!this.searchTerm || (this.currentFilter && this.currentFilter !== 'all'); }
    get hasPriceFilter() { return this.minPrice !== null || this.maxPrice !== null; }

    // ---- Hero --------------------------------------------------------------
    setupHero() {
        // The hero chat (Nexi). It shares one conversation with the floating assistant button.
        if (window.NexiAssistant) window.NexiAssistant.mountHero(document.getElementById('heroChat'));
        const cats = document.getElementById('heroCategoryCount');
        if (cats && window.NXCategories) cats.textContent = String(window.NXCategories.list.length);
        if (app.user?.role === 'seller') {
            const t = document.getElementById('ctaTitle'), x = document.getElementById('ctaText'), b = document.getElementById('ctaBtn');
            if (t) t.textContent = 'Ready to list something new?';
            if (x) x.textContent = 'Add a product to your store and put it in front of shoppers across the marketplace.';
            if (b) { b.href = '/product-form'; b.textContent = 'Add a product'; }
            document.querySelectorAll('[data-hero-sell]').forEach(a => {
                a.href = '/product-form';
                const icon = a.querySelector('i');
                a.textContent = 'Add a product';
                if (icon) { a.append(' '); a.append(icon); }
            });
        }
    }

    // ---- Hero store cards: four "market stalls" (awning in each store's own colour), shown once ----
    renderHeroSkeleton() {
        const el = document.getElementById('heroCollage');
        if (!el) return;
        const tile = '<span class="hero-stall is-skel skeleton" aria-hidden="true"></span>';
        el.innerHTML = `<div class="hero-col">${tile}${tile}</div><div class="hero-col">${tile}${tile}</div>`;
    }

    /** Mixes a hex colour with white (amount 0..1) for the lighter awning stripe. */
    lightenHex(hex, amount) {
        let h = String(hex || '').replace('#', '');
        if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
        if (h.length < 6) return '#ffffff';
        const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
        if (n.some(Number.isNaN)) return '#ffffff';
        return '#' + n.map(v => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0')).join('');
    }

    /** stores: array from the API, or null when the request failed (then the cards are hidden). */
    renderHeroStores(stores) {
        if (this.heroCollageDone) return;
        const el = document.getElementById('heroCollage');
        const hero = el && el.closest('.marketplace-hero');
        if (!el) return;
        const list = Array.isArray(stores) ? stores : [];
        // Prefer stores that look finished (logo, banner, products, a badge); keep the API order within a score.
        const score = (s) => (s.logo ? 1 : 0) + (s.banner ? 1 : 0) + (Number(s.productCount) > 0 ? 1 : 0) + ((s.badges || []).length ? 1 : 0);
        const picks = list.map((s, i) => ({ s, i, k: score(s) })).sort((a, b) => b.k - a.k || a.i - b.i).slice(0, 4).map(x => x.s);
        if (!picks.length) {
            el.hidden = true;
            hero?.classList.add('no-collage');
            return;
        }
        el.hidden = false;
        hero?.classList.remove('no-collage');
        const C = window.NXCategories;
        const stall = (s) => {
            const name = String(s.name || '').trim() || 'Unnamed store';
            const initial = esc(initialOf(name));
            const bc = safeColor(s.bannerColor);
            const tier = s.tier && TIERS.includes(s.tier.tone) ? s.tier.tone : '';
            const logo = s.logo
                ? `<img src="${esc(app.resolveImageUrl(s.logo))}" alt="" loading="lazy" decoding="async" data-fallback="logo" data-initial="${initial}">` : initial;
            const badge = app.renderSellerBadges(s, { limit: 1, more: false, compact: true });
            const district = String(s.district || '').trim().slice(0, 60);
            const products = Number(s.productCount) || 0;
            const cats = C ? [...new Set((Array.isArray(s.categories) ? s.categories : []).map(c => String(c || '').toLowerCase()).filter(Boolean))].slice(0, 3) : [];
            return `<a class="hero-stall"${tier ? ` data-tier="${tier}"` : ''} href="${esc(app.storeLink(s))}" style="--bc:${esc(bc)};--bc2:${esc(this.lightenHex(bc, 0.42))}" aria-label="${esc(name)}${district ? ', ' + esc(district) : ''}. Visit store">
                <span class="hero-stall-awning" aria-hidden="true"></span>
                <span class="hero-stall-logo" aria-hidden="true">${logo}</span>
                <span class="hero-stall-name">${esc(name)}</span>
                ${badge ? `<span class="hero-stall-badge">${badge}</span>` : ''}
                ${district ? `<span class="hero-stall-place"><i class="fas fa-location-dot" aria-hidden="true"></i><span>${esc(district)}</span></span>` : ''}
                <span class="hero-stall-foot">
                    <span class="hero-stall-cats" aria-hidden="true">${cats.map(c => `<span class="mk-cat">${C.iconHTML(c, 16)}</span>`).join('')}</span>
                    <span class="hero-stall-count"><b>${esc(compact(products))}</b> ${plural(products, 'product', 'products')}</span>
                </span>
            </a>`;
        };
        const cards = picks.map(stall);
        // two staggered columns: cards 1+3 on the left, 2+4 on the right
        el.innerHTML = `<div class="hero-col">${[cards[0], cards[2]].filter(Boolean).join('')}</div><div class="hero-col">${[cards[1], cards[3]].filter(Boolean).join('')}</div>`;
        this.heroCollageDone = true;
    }

    /** Real numbers from the API (the old card showed fixed, made-up figures). */
    updateHeroStats(storesTotal, productsTotal, stores) {
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove('is-pending');
            el.textContent = value === null ? '\u2013' : compact(value);
            if (value !== null) el.title = full(value);
        };
        set('heroStoreCount', storesTotal);
        set('heroProductCount', productsTotal);

        const stack = document.getElementById('heroStack');
        if (!stack) return;
        const shown = (stores || []).slice(0, 4);
        if (!shown.length) { stack.hidden = true; return; }
        stack.hidden = false;
        const more = Math.max(0, (Number(storesTotal) || 0) - shown.length);
        stack.innerHTML = shown.map(s => {
            const initial = esc(initialOf(s.name));
            return `<span class="hero-stack-item">${s.logo
                ? `<img src="${esc(app.resolveImageUrl(s.logo))}" alt="" loading="lazy" decoding="async" data-fallback="logo" data-initial="${initial}">`
                : initial}</span>`;
        }).join('') + (more ? `<span class="hero-stack-item hero-stack-more">+${esc(compact(more))}</span>` : '');
    }

    /** Only needed when the page opens already filtered (the unfiltered first page carries the totals). */
    async loadHeroStatsUnfiltered() {
        const [s, p] = await Promise.allSettled([
            app.apiRequest('/store/public/all?limit=8'),
            app.apiRequest('/products/public?limit=4')
        ]);
        this.renderHeroStores(s.status === 'fulfilled' ? (s.value.data || []) : null);
        this.updateHeroStats(
            s.status === 'fulfilled' ? (s.value.pagination?.total ?? null) : null,
            p.status === 'fulfilled' ? (p.value.pagination?.total ?? null) : null,
            s.status === 'fulfilled' ? (s.value.data || []) : []
        );
    }

    // ---- Loading / busy ----------------------------------------------------
    renderSkeletons() {
        const stores = document.getElementById('storesSkeleton');
        const products = document.getElementById('productsSkeleton');
        if (stores) stores.innerHTML = Array.from({ length: this.storePageSize }, () => `
            <div class="mk-store mk-skel-card" aria-hidden="true">
                <div class="mk-store-banner skeleton"></div>
                <div class="mk-store-body">
                    <div class="mk-store-logo skeleton"></div>
                    <div class="skeleton mk-skel-line" style="width:70%"></div>
                    <div class="skeleton mk-skel-line mk-skel-line--sm" style="width:95%"></div>
                    <div class="skeleton mk-skel-line mk-skel-line--sm" style="width:60%"></div>
                    <div class="skeleton mk-skel-btn"></div>
                </div>
            </div>`).join('');
        if (products) products.innerHTML = Array.from({ length: this.productPageSize }, () => `
            <div class="mk-product mk-skel-card" aria-hidden="true">
                <div class="mk-product-image skeleton"></div>
                <div class="mk-product-info">
                    <div class="skeleton mk-skel-line mk-skel-line--sm" style="width:50%"></div>
                    <div class="skeleton mk-skel-line" style="width:90%"></div>
                    <div class="skeleton mk-skel-line" style="width:45%"></div>
                </div>
            </div>`).join('');
    }

    /** First load: skeletons. Later filter changes: keep the old cards, dimmed, so the page doesn't jump. */
    setBusy(on, which = ['stores', 'products']) {
        which.forEach(kind => {
            const skeleton = document.getElementById(kind + 'LoadingState');
            const content = document.getElementById(kind + 'Content');
            if (!skeleton || !content) return;
            if (on && !this.hasRendered) {
                skeleton.classList.add('active');
                content.classList.add('hidden');
            } else {
                skeleton.classList.remove('active');
                content.classList.remove('hidden');
                content.classList.toggle('is-busy', on);
                content.setAttribute('aria-busy', on ? 'true' : 'false');
            }
        });
        if (!on) ['stores', 'products'].forEach(kind => { const c = document.getElementById(kind + 'Content'); if (c) { c.classList.remove('is-busy'); c.setAttribute('aria-busy', 'false'); } });
    }

    // ---- Events ------------------------------------------------------------
    setupEventListeners() {
        // Category icon tiles (built from the shared list in js/categories.js)
        this.renderCategoryTiles();
        // Featured stores tabs get the same category icons as the tiles
        if (window.NXCategories) document.querySelectorAll('.filter-tab[data-filter]').forEach(tab => {
            tab.insertAdjacentHTML('afterbegin', NXCategories.iconHTML(tab.dataset.filter, 18));
        });
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => this.setActiveFilter(tab.dataset.filter));
        });
        this.syncCategoryUi();

        const root = document.querySelector('.marketplace-container');
        if (root) {
            // One capture-phase listener handles every broken image (error events don't bubble).
            root.addEventListener('error', (e) => this.handleImageError(e.target), true);
            // Retry / clear buttons inside empty and error states.
            root.addEventListener('click', (e) => {
                const fav = e.target.closest('[data-fav]');
                if (fav) { e.preventDefault(); this.toggleFavorite(fav.dataset.fav); return; }
                const btn = e.target.closest('[data-mk-action]');
                if (!btn) return;
                const action = btn.dataset.mkAction;
                if (action === 'retry') this.applyCatalogFilters();
                if (action === 'clear') this.clearFilters();
                if (action === 'clear-search') this.clearSearch();
                if (action === 'clear-category') this.setActiveFilter('all');
                if (action === 'clear-price') this.setPrice(null, null);
            });
        }

        document.getElementById('productsLoadMore')?.addEventListener('click', () => this.loadMoreProducts());
        document.getElementById('productsSort')?.addEventListener('change', (e) => {
            this.sort = SORTS.includes(e.target.value) ? e.target.value : 'popular';
            this.applyCatalogFilters({ only: 'products' });
        });
        document.getElementById('priceForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.setPrice(parsePrice(document.getElementById('priceMin')?.value), parsePrice(document.getElementById('priceMax')?.value));
        });

        // Marketplace search — live preview dropdown: as the shopper types,
        // show matching products/stores so they can confirm before
        // navigating. The grids behind the dropdown update as well.
        const searchInput = document.getElementById('marketplaceSearch');
        if (searchInput) {
            let searchDebounceTimeout;
            searchInput.addEventListener('input', (e) => {
                const value = e.target.value;
                this.searchMarketplace(value);
                clearTimeout(searchDebounceTimeout);
                searchDebounceTimeout = setTimeout(() => this.renderSearchPreview(value), 200);
            });
            searchInput.addEventListener('focus', () => this.renderSearchPreview(searchInput.value));
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    if (this.movePreview(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
                } else if (e.key === 'Enter') {
                    const active = this.previewItems()[this.previewIndex ?? -1];
                    if (active && active.href) { e.preventDefault(); window.location.href = active.href; return; }
                    this.closeSearchPreview();
                } else if (e.key === 'Escape') { searchInput.blur(); this.closeSearchPreview(); }
            });
            document.addEventListener('click', (e) => {
                if (!document.getElementById('marketplaceSearchBar')?.contains(e.target)) this.closeSearchPreview();
            });
        }
    }

    /** Broken photo -> the colour / initial / icon the card already knows how to show. */
    handleImageError(img) {
        if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
        const kind = img.dataset.fallback;
        const parent = img.parentElement;
        if (kind === 'banner') { img.remove(); return; }
        if (kind === 'logo' && parent) { parent.textContent = img.dataset.initial || '?'; return; }
        if (kind === 'product' && parent) {
            const icon = FA_ICON.test(img.dataset.icon || '') ? img.dataset.icon : 'fa-box';
            img.insertAdjacentHTML('beforebegin', `<i class="fas ${icon}" aria-hidden="true"></i>`);
            img.remove();
        }
    }

    closeSearchPreview() {
        document.getElementById('marketplaceSearchBar')?.classList.remove('open');
        const input = document.getElementById('marketplaceSearch');
        if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
        this.previewIndex = -1;
    }

    /** Suggestion rows in the order they appear (stores, products, "See more results"). */
    previewItems() {
        return [...document.querySelectorAll('#searchPreviewDropdown .search-preview-item, #searchPreviewDropdown .search-preview-submit')];
    }

    /** Arrow keys move through the suggestions; Enter opens the highlighted one (aria-activedescendant keeps focus in the box). */
    movePreview(step) {
        const bar = document.getElementById('marketplaceSearchBar');
        const items = this.previewItems();
        const input = document.getElementById('marketplaceSearch');
        if (!bar?.classList.contains('open') || !items.length || !input) return false;
        const last = this.previewIndex ?? -1;
        const next = last < 0 ? (step > 0 ? 0 : items.length - 1) : (last + step + items.length) % items.length;
        items.forEach((el, i) => { el.classList.toggle('is-active', i === next); el.setAttribute('aria-selected', String(i === next)); });
        this.previewIndex = next;
        input.setAttribute('aria-activedescendant', items[next].id);
        items[next].scrollIntoView({ block: 'nearest' });
        return true;
    }

    /** Gives every suggestion the id / role the combobox needs, and opens the box for screen readers. */
    decoratePreview() {
        this.previewItems().forEach((el, i) => { el.id = 'sp-opt-' + i; el.setAttribute('role', 'option'); el.setAttribute('aria-selected', 'false'); });
        document.querySelectorAll('#searchPreviewDropdown .search-preview-group-label').forEach(el => el.setAttribute('role', 'presentation'));
        const input = document.getElementById('marketplaceSearch');
        if (input) { input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant'); }
        this.previewIndex = -1;
    }

    /** Builds the up-to-6-result preview dropdown from a live, server-side
     *  search (debounced 200ms by the caller) rather than filtering
     *  whatever page of the catalog happens to already be loaded — that
     *  way the dropdown finds a match anywhere in the catalog, not just
     *  among the handful of stores/products currently rendered in the
     *  grid below. */
    async renderSearchPreview(term) {
        const bar = document.getElementById('marketplaceSearchBar');
        const dropdown = document.getElementById('searchPreviewDropdown');
        if (!bar || !dropdown) return;

        const q = (term || '').trim();
        if (q.length < 2) {
            bar.classList.remove('open');
            return;
        }

        const requestId = ++this.searchRequestId;
        dropdown.innerHTML = '<div class="search-preview-empty"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';
        bar.classList.add('open');

        try {
            // Keep store and product autocomplete independent. A failure in
            // one catalog must never turn the entire search UI into
            // "Search is unavailable". Products use the dedicated public
            // catalog endpoint, which is also the source for the marketplace
            // grid; stores use the lightweight store search endpoint.
            const [storesResult, productsResult] = await Promise.allSettled([
                app.apiRequest(`/store/search?q=${encodeURIComponent(q)}&limit=6`),
                app.apiRequest(`/products/public?q=${encodeURIComponent(q)}&limit=6`)
            ]);
            if (requestId !== this.searchRequestId) return;
            const stores = storesResult.status === 'fulfilled' ? (storesResult.value.data?.stores || []) : [];
            const products = productsResult.status === 'fulfilled' ? (productsResult.value.data || []) : [];
            const hasSearchError = storesResult.status === 'rejected' && productsResult.status === 'rejected';

            if (!stores.length && !products.length) {
                dropdown.innerHTML = `<div class="search-preview-empty">${hasSearchError ? 'Search is temporarily unavailable. Please try again.' : `No matches for "${app.escapeHtml(q)}"`}</div>`;
                return;
            }

            let html = '';
            if (stores.length) {
                html += '<div class="search-preview-group-label">Stores</div>';
                html += stores.slice(0, 3).map(s => `
                    <a href="${esc(app.storeLink(s))}" class="search-preview-item">
                        <span class="search-preview-thumb">${s.logo ? `<img src="${esc(app.resolveImageUrl(s.logo))}" alt="" loading="lazy" decoding="async" data-fallback="logo" data-initial="${esc(initialOf(s.name))}">` : '<i class="fas fa-store"></i>'}</span>
                        <span class="search-preview-info"><span class="search-preview-name">${app.escapeHtml(s.name)}</span><span class="search-preview-meta">Store</span></span>
                    </a>`).join('');
            }
            if (products.length) {
                html += '<div class="search-preview-group-label">Products</div>';
                html += products.slice(0, 6).map(p => `
                    <a href="${esc(app.productLink(p))}" class="search-preview-item">
                        <span class="search-preview-thumb">${app.productThumb(p) ? `<img src="${esc(app.productThumb(p))}" alt="" loading="lazy" decoding="async" data-fallback="product" data-icon="fa-box">` : '<i class="fas fa-box"></i>'}</span>
                        <span class="search-preview-info"><span class="search-preview-name">${app.escapeHtml(p.name)}</span><span class="search-preview-meta">${app.escapeHtml(p.storeName || '')}</span></span>
                        <span class="search-preview-price">${app.formatCurrency(p.price)}</span>
                    </a>`).join('');
            }
            html += `<a class="search-preview-submit" href="/marketplace?search=${encodeURIComponent(q)}">See more results for "${app.escapeHtml(q)}"</a>`;
            dropdown.innerHTML = html;
            this.decoratePreview();
        } catch (error) {
            if (requestId !== this.searchRequestId) return;
            dropdown.innerHTML = '<div class="search-preview-empty">Search is unavailable right now. Please try again.</div>';
        }
    }

    // ---- Data --------------------------------------------------------------
    /** Query string for the current search + category, plus paging. */
    catalogQuery(extra = {}) {
        const p = new URLSearchParams();
        if (this.searchTerm) p.set('q', this.searchTerm);
        if (this.currentFilter && this.currentFilter !== 'all') p.set('category', this.currentFilter);
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p.toString();
    }

    /** Same as catalogQuery() plus the product-only controls (sort, price range). */
    productQuery(extra = {}) {
        const p = new URLSearchParams(this.catalogQuery());
        if (this.sort !== 'popular') p.set('sort', this.sort);
        if (this.minPrice !== null) p.set('minPrice', String(this.minPrice));
        if (this.maxPrice !== null) p.set('maxPrice', String(this.maxPrice));
        Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
        return p.toString();
    }

    async loadMarketplaceData() { return this.applyCatalogFilters(); }

    // Re-fetches stores and products from the server for the current
    // category + search (both endpoints filter and page server-side), so a
    // store or product outside the first page can still be found. Stores and
    // products load independently: if one request fails the other still
    // renders and the failed section gets its own "Try again".
    async applyCatalogFilters(opts = {}) {
        const productsOnly = opts.only === 'products';
        const requestId = ++this.catalogRequestId;
        this.updateTitles();
        this.syncUrl();
        this.syncToolbar();
        this.renderActiveFilters();
        this.setBusy(true, productsOnly ? ['products'] : ['stores', 'products']);

        const [storesRes, productsRes] = await Promise.allSettled([
            productsOnly ? Promise.resolve(null) : app.apiRequest('/store/public/all?' + this.catalogQuery({ limit: this.storePageSize })),
            app.apiRequest('/products/public?' + this.productQuery({ limit: this.productPageSize, page: 1 }))
        ]);
        // A newer filter/search request already landed - drop this stale response.
        if (requestId !== this.catalogRequestId) return;

        this.hasRendered = true;
        this.setBusy(false);

        if (!productsOnly) {
            if (storesRes.status === 'fulfilled') {
                const r = storesRes.value;
                this.stores = Array.isArray(r.data) ? r.data : [];
                this.storesTotal = Number(r.pagination?.total ?? this.stores.length) || 0;
                this.renderStores();
            } else {
                console.error('Error loading stores:', storesRes.reason);
                this.renderSectionError('stores');
            }
        }

        if (productsRes.status === 'fulfilled') {
            const r = productsRes.value;
            this.products = Array.isArray(r.data) ? r.data : [];
            this.productsTotal = Number(r.pagination?.total ?? this.products.length) || 0;
            this.productsPage = 1;
            this.productsPages = Number(r.pagination?.pages) || 1;
            this.renderProducts();
        } else {
            console.error('Error loading products:', productsRes.reason);
            this.renderSectionError('products');
        }

        if (productsOnly) return;

        // Hero numbers are about the whole marketplace, so only an unfiltered response can fill them.
        // The hero store cards come from the stores list, so sort order does not matter.
        if (!this.isFiltered) {
            if (storesRes.status === 'fulfilled') this.renderHeroStores(this.stores);
            else if (!this.heroCollageDone && !this.heroLoaded) { this.heroLoaded = true; this.loadHeroStatsUnfiltered(); }
            this.updateHeroStats(
                storesRes.status === 'fulfilled' ? this.storesTotal : null,
                productsRes.status === 'fulfilled' ? this.productsTotal : null,
                storesRes.status === 'fulfilled' ? this.stores : []
            );
        } else if (!this.heroLoaded) {
            this.heroLoaded = true;
            this.loadHeroStatsUnfiltered();
        }

        // A heart tapped while signed out is finished once the shopper comes back from login.
        if (!this.pendingFavoriteDone) {
            this.pendingFavoriteDone = true;
            const pending = app.consumePendingAction && app.consumePendingAction('favorite-product');
            if (pending && pending.productId && app.token) this.toggleFavorite(pending.productId);
        }
    }

    async loadMoreProducts() {
        if (this.loadingMore || this.productsPage >= this.productsPages) return;
        const requestId = this.catalogRequestId;
        const btn = document.getElementById('productsLoadMore');
        this.loadingMore = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Loading\u2026'; }
        try {
            const res = await app.apiRequest('/products/public?' + this.productQuery({ limit: this.productPageSize, page: this.productsPage + 1 }));
            if (requestId !== this.catalogRequestId) return;
            const have = new Set(this.products.map(p => p.id));
            const fresh = (Array.isArray(res.data) ? res.data : []).filter(p => !have.has(p.id));
            this.products.push(...fresh);
            this.productsPage += 1;
            this.productsPages = Number(res.pagination?.pages) || this.productsPages;
            this.productsTotal = Number(res.pagination?.total ?? this.productsTotal) || this.productsTotal;
            document.getElementById('trendingProducts')?.insertAdjacentHTML('beforeend', fresh.map(p => this.productCardHTML(p)).join(''));
            this.updateProductsFooter();
            this.paintFavorites(fresh);
        } catch (error) {
            console.error('Error loading more products:', error);
            if (btn) { btn.textContent = 'Couldn\u2019t load more \u2013 try again'; }
        } finally {
            this.loadingMore = false;
            if (btn) { btn.disabled = false; if (btn.textContent === 'Loading\u2026') btn.textContent = 'Show more products'; }
        }
    }

    // ---- Section copy ------------------------------------------------------
    updateTitles() {
        const C = window.NXCategories;
        const cat = this.currentFilter && this.currentFilter !== 'all' ? this.currentFilter : '';
        const label = cat && C ? C.label(cat) : '';
        let stores = 'Featured stores', products = 'Trending products';
        if (this.searchTerm) {
            const q = '\u201c' + this.searchTerm + '\u201d';
            stores = 'Stores matching ' + q + (label ? ' in ' + label : '');
            products = 'Products matching ' + q + (label ? ' in ' + label : '');
        } else if (label) {
            stores = label + ' stores';
            products = label + ' products';
        }
        if (!this.searchTerm && !label && this.sort !== 'popular') {
            products = { newest: 'Newest products', 'price-low': 'Products: lowest price first', 'price-high': 'Products: highest price first' }[this.sort] || products;
        }
        const st = document.getElementById('storesTitle'); if (st) st.textContent = stores;
        const pt = document.getElementById('productsTitle'); if (pt) pt.textContent = products;
    }

    /** Link to the full directory, carrying the current search/category across. */
    storesDirectoryHref() {
        const p = new URLSearchParams();
        if (this.searchTerm) p.set('q', this.searchTerm);
        if (this.currentFilter && this.currentFilter !== 'all') p.set('category', this.currentFilter);
        const qs = p.toString();
        return '/stores' + (qs ? '?' + qs : '');
    }

    // ---- Stores ------------------------------------------------------------
    renderStores() { this.renderStoreCards(this.stores); }

    renderStoreCards(stores) {
        const container = document.getElementById('storesGrid');
        if (!container) return;
        const more = document.getElementById('storesMore');
        const count = document.getElementById('storesCount');
        const href = this.storesDirectoryHref();
        const headLink = document.getElementById('viewAllStoresLink');
        if (headLink) headLink.href = href;

        if (!stores.length) {
            if (more) more.hidden = true;
            if (count) count.textContent = '';
            container.innerHTML = this.stateHTML('fa-store', this.hasStoreFilter ? 'No stores match' : 'No stores yet',
                this.hasStoreFilter ? 'Try another word, or clear the filters to see every store.' : 'Stores will appear here as sellers open them.',
                this.hasStoreFilter ? { action: 'clear', label: 'Clear search and filters' } : { href: '/signup', label: 'Open the first store' });
            return;
        }

        if (count) count.textContent = full(this.storesTotal) + ' ' + plural(this.storesTotal, 'store', 'stores') + (this.hasStoreFilter ? ' found' : '');
        container.innerHTML = stores.map(s => this.storeCardHTML(s)).join('');

        if (more) {
            more.hidden = false;
            const link = document.getElementById('storesViewAll');
            if (link) {
                link.href = href;
                link.innerHTML = `View all ${esc(compact(this.storesTotal))} ${plural(this.storesTotal, 'store', 'stores')} <i class="fas fa-arrow-right" aria-hidden="true"></i>`;
            }
        }
    }

    storeCardHTML(store) {
        const name = String(store.name || '').trim() || 'Unnamed store';
        const initial = esc(initialOf(name));
        const href = esc(app.storeLink(store));
        const tier = store.tier && TIERS.includes(store.tier.tone) ? store.tier.tone : '';

        const banner = store.banner
            ? `<img src="${esc(app.resolveImageUrl(store.banner))}" alt="" loading="lazy" decoding="async" data-fallback="banner">` : '';
        const logo = store.logo
            ? `<img src="${esc(app.resolveImageUrl(store.logo))}" alt="" loading="lazy" decoding="async" data-fallback="logo" data-initial="${initial}">` : initial;

        const badges = app.renderSellerBadges(store, { limit: 1, more: true });
        const description = String(store.description || '').trim().slice(0, 300);
        const district = String(store.district || '').trim().slice(0, 80);

        // Up to 3 category icons (+N). Unknown ids get the generic icon from categories.js.
        const C = window.NXCategories;
        const cats = C ? [...new Set((Array.isArray(store.categories) ? store.categories : []).map(c => String(c || '').toLowerCase()).filter(Boolean))] : [];
        const catsHTML = cats.length ? `
                    <div class="mk-store-cats" title="${esc(cats.map(c => C.label(c)).join(', '))}">
                        ${cats.slice(0, 3).map(c => `<span class="mk-cat">${C.iconHTML(c, 16)}</span>`).join('')}
                        ${cats.length > 3 ? `<span class="mk-cat mk-cat--more">+${cats.length - 3}</span>` : ''}
                        <span class="mk-sr">Sells ${esc(cats.map(c => C.label(c)).join(', '))}</span>
                    </div>` : '';

        const followers = Number(store.followers) || 0;
        const products = Number(store.productCount) || 0;

        return `
            <article class="mk-store"${tier ? ` data-tier="${tier}"` : ''} data-store-id="${esc(store.id)}">
                <div class="mk-store-banner" style="--bc:${esc(safeColor(store.bannerColor))}">${banner}</div>
                <div class="mk-store-body">
                    <div class="mk-store-logo">${logo}</div>
                    <div class="mk-store-main">
                    <h3 class="mk-store-name" title="${esc(name)}"><a class="mk-store-link" href="${href}"><span class="store-name-text">${esc(name)}</span></a></h3>
                    ${badges ? `<div class="mk-store-badges">${badges}</div>` : ''}
                    <p class="mk-store-desc${description ? '' : ' is-empty'}">${description ? esc(description) : 'No description yet'}</p>
                    ${district ? `<p class="mk-store-place" title="${esc(district)}"><i class="fas fa-location-dot" aria-hidden="true"></i><span>${esc(district)}</span></p>` : ''}
                    ${catsHTML}
                    </div>
                    <div class="mk-store-meta">
                        <span class="mk-stat" title="${esc(full(followers))} ${plural(followers, 'follower', 'followers')}"><i class="fas fa-users" aria-hidden="true"></i><b>${esc(compact(followers))}</b><span class="mk-stat-word"> ${plural(followers, 'follower', 'followers')}</span></span>
                        <span class="mk-stat" title="${esc(full(products))} ${plural(products, 'product', 'products')}"><i class="fas fa-box" aria-hidden="true"></i><b>${esc(compact(products))}</b><span class="mk-stat-word"> ${plural(products, 'product', 'products')}</span></span>
                    </div>
                    <span class="mk-store-cta" aria-hidden="true">Visit store</span>
                </div>
            </article>`;
    }

    // ---- Products ----------------------------------------------------------
    renderTrendingProducts() { this.renderProducts(); }
    renderProductCards(products) { this.products = products; this.renderProducts(); }

    renderProducts() {
        const container = document.getElementById('trendingProducts');
        if (!container) return;
        const more = document.getElementById('productsMore');
        const count = document.getElementById('productsCount');

        if (!this.products.length) {
            if (more) more.hidden = true;
            if (count) count.textContent = '';
            container.innerHTML = this.stateHTML('fa-box-open', this.isFiltered ? 'No products match' : 'No products yet',
                this.isFiltered ? 'Try another word, or clear the filters to see every product.' : 'Check back soon for new listings.',
                this.isFiltered ? { action: 'clear', label: 'Clear search and filters' } : null);
            return;
        }
        container.innerHTML = this.products.map(p => this.productCardHTML(p)).join('');
        this.updateProductsFooter();
        this.paintFavorites(this.products);
    }

    updateProductsFooter() {
        const more = document.getElementById('productsMore');
        const note = document.getElementById('productsShown');
        const btn = document.getElementById('productsLoadMore');
        const count = document.getElementById('productsCount');
        if (count) count.textContent = full(this.productsTotal) + ' ' + plural(this.productsTotal, 'product', 'products') + (this.isFiltered ? ' found' : '');
        const remaining = Math.max(0, this.productsTotal - this.products.length);
        const hasMore = this.productsPage < this.productsPages && remaining > 0;
        if (more) more.hidden = !hasMore && this.products.length >= this.productsTotal;
        if (note) note.textContent = `Showing ${full(this.products.length)} of ${full(this.productsTotal)}`;
        if (btn) {
            btn.hidden = !hasMore;
            if (!this.loadingMore) btn.textContent = `Show more products (${full(remaining)} left)`;
        }
    }

    productCardHTML(p) {
        const thumb = app.productThumb(p);
        const name = String(p.name || '').trim() || 'Untitled product';
        const storeName = String(p.storeName || '').trim() || 'Local store';
        const icon = FA_ICON.test(p.icon || '') ? p.icon : 'fa-box';
        const href = esc(app.productLink({ id: p.id, name: p.name }, p.storeSlug || p.storeId || ''));

        const cur = Number(p.price), was = Number(p.originalPrice);
        const hasDiscount = Number.isFinite(cur) && Number.isFinite(was) && was > cur && cur >= 0;
        const pct = hasDiscount ? Math.min(99, Math.max(1, Math.round((1 - cur / was) * 100))) : 0;

        const type = p.listingType === 'service' ? 'service' : (p.listingType === 'digital' ? 'digital' : 'physical');
        const stock = Number(p.stock);
        const soldOut = type === 'physical' && Number.isFinite(stock) && stock <= 0;
        const chip = type === 'service' ? '<span class="mk-chip"><i class="fas fa-screwdriver-wrench" aria-hidden="true"></i>Service</span>'
            : type === 'digital' ? '<span class="mk-chip"><i class="fas fa-cloud-arrow-down" aria-hidden="true"></i>Digital</span>' : '';

        const media = thumb
            ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" data-fallback="product" data-icon="${esc(icon)}">`
            : `<i class="fas ${icon}" aria-hidden="true"></i>`;

        return `
            <article class="mk-product${soldOut ? ' is-soldout' : ''}" data-product-id="${esc(p.id)}">
                <div class="mk-product-image">
                    ${media}
                    ${pct ? `<span class="product-badge">-${pct}%</span>` : ''}
                    ${chip}
                    ${soldOut ? '<span class="mk-soldout">Sold out</span>' : ''}
                    ${app.renderTierMark(p.sellerTier)}
                </div>
                <button type="button" class="mk-fav" data-fav="${esc(p.id)}" aria-pressed="false" aria-label="Save ${esc(name)} to favorites"><i class="far fa-heart" aria-hidden="true"></i></button>
                <div class="mk-product-info">
                    <p class="mk-product-store" title="${esc(storeName)}"><i class="fas fa-store" aria-hidden="true"></i><span>${esc(storeName)}</span></p>
                    <h4 class="mk-product-name" title="${esc(name)}"><a class="mk-product-link" href="${href}">${esc(name)}</a></h4>
                    <div class="mk-product-price">
                        <span class="current-price">${type === 'service' ? '<span class="mk-from">From</span> ' : ''}${esc(price(cur))}</span>
                        ${hasDiscount ? `<span class="product-original-price">${esc(price(was))}</span>` : ''}
                    </div>
                </div>
            </article>`;
    }

    // ---- Favorites (hearts) --------------------------------------------------
    // Same API and behaviour as the store page: signed-out shoppers are sent to log in and
    // the tap is finished when they come back; signed-in shoppers get ONE request per page of
    // cards (/favorites/check) and each product is only asked about once.
    setHeart(productId, on) {
        document.querySelectorAll(`.mk-product[data-product-id="${CSS.escape(String(productId))}"] .mk-fav`).forEach(btn => {
            const icon = btn.querySelector('i');
            if (icon) { icon.classList.toggle('fas', on); icon.classList.toggle('far', !on); }
            btn.classList.toggle('is-favorite', on);
            btn.setAttribute('aria-pressed', String(on));
            const name = btn.getAttribute('aria-label').replace(/^(Save|Remove) /, '').replace(/ (to|from) favorites$/, '');
            btn.setAttribute('aria-label', `${on ? 'Remove' : 'Save'} ${name} ${on ? 'from' : 'to'} favorites`);
        });
    }

    paintFavorites(list) {
        this.favoriteIds.forEach(id => this.setHeart(id, true));
        this.loadFavoriteStates(list);
    }

    async loadFavoriteStates(list) {
        if (!app.token || !Array.isArray(list)) return;
        const pending = list.map(p => p.id).filter(id => id && !this.favoriteChecked.has(id));
        for (let i = 0; i < pending.length; i += 60) {
            const chunk = pending.slice(i, i + 60);
            try {
                const res = await app.apiRequest('/favorites/check?ids=' + chunk.map(encodeURIComponent).join(','));
                if (!Array.isArray(res?.data?.favorited)) continue;
                const saved = new Set(res.data.favorited);
                chunk.forEach(id => {
                    this.favoriteChecked.add(id);
                    if (saved.has(id)) { this.favoriteIds.add(id); this.setHeart(id, true); }
                });
            } catch (error) { /* hearts simply stay empty if this fails */ }
        }
    }

    async toggleFavorite(productId) {
        if (!app.requireLogin('Log in to save items to your favorites.', { type: 'favorite-product', productId })) return;
        const wasOn = this.favoriteIds.has(productId);
        if (wasOn) this.favoriteIds.delete(productId); else this.favoriteIds.add(productId);
        this.setHeart(productId, !wasOn); // instant; undone below if the server says no
        try {
            await app.apiRequest(`/favorites/${encodeURIComponent(productId)}`, { method: wasOn ? 'DELETE' : 'POST' });
            app.showAlert(wasOn ? 'Removed from favorites' : 'Added to favorites', 'success');
        } catch (error) {
            if (wasOn) this.favoriteIds.add(productId); else this.favoriteIds.delete(productId);
            this.setHeart(productId, wasOn);
            app.showAlert(error.message || 'Could not update your favorites. Please try again.', 'error');
        }
    }

    // ---- Shared states -----------------------------------------------------
    stateHTML(icon, title, text, action) {
        const btn = !action ? '' : (action.href
            ? `<a class="btn btn-primary" href="${esc(action.href)}">${esc(action.label)}</a>`
            : `<button type="button" class="btn btn-outline" data-mk-action="${esc(action.action)}">${esc(action.label)}</button>`);
        return `<div class="mk-state"><div class="empty-icon"><i class="fas ${icon}" aria-hidden="true"></i></div><h3>${esc(title)}</h3><p>${esc(text)}</p>${btn}</div>`;
    }

    /** A request failed: say so (the old page showed a "coming soon" message here) and offer a retry. */
    renderSectionError(kind) {
        const isStores = kind === 'stores';
        const container = document.getElementById(isStores ? 'storesGrid' : 'trendingProducts');
        if (container) container.innerHTML = this.stateHTML('fa-triangle-exclamation',
            isStores ? 'Couldn\u2019t load stores' : 'Couldn\u2019t load products',
            'Check your connection and try again.', { action: 'retry', label: 'Try again' });
        const more = document.getElementById(isStores ? 'storesMore' : 'productsMore');
        if (more) more.hidden = true;
        const count = document.getElementById(isStores ? 'storesCount' : 'productsCount');
        if (count) count.textContent = '';
    }

    renderEmptyState() { this.renderSectionError('stores'); this.renderSectionError('products'); }

    // ---- Filters -----------------------------------------------------------
    setActiveFilter(filter) {
        this.currentFilter = filter || 'all';
        this.syncCategoryUi();
        this.applyCatalogFilters();
    }

    clearFilters() {
        const input = document.getElementById('marketplaceSearch');
        if (input) input.value = '';
        const heroInput = document.getElementById('heroSearch');
        if (heroInput) heroInput.value = '';
        clearTimeout(this.catalogSearchDebounce);
        this.searchTerm = '';
        this.minPrice = null;
        this.maxPrice = null;
        this.closeSearchPreview();
        this.setActiveFilter('all');
    }

    clearSearch() {
        ['marketplaceSearch', 'heroSearch'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        clearTimeout(this.catalogSearchDebounce);
        this.searchTerm = '';
        this.closeSearchPreview();
        this.applyCatalogFilters();
    }

    /** Price range from the toolbar (null = no limit on that side). A reversed range is put the right way round. */
    setPrice(min, max) {
        if (min !== null && max !== null && min > max) [min, max] = [max, min];
        this.minPrice = min;
        this.maxPrice = max;
        this.applyCatalogFilters({ only: 'products' });
    }

    /** Keeps the sort box and the two price boxes in step with the state (URL, chips, Clear). */
    syncToolbar() {
        const sort = document.getElementById('productsSort');
        if (sort && sort.value !== this.sort) sort.value = this.sort;
        const min = document.getElementById('priceMin'), max = document.getElementById('priceMax');
        if (min && document.activeElement !== min) min.value = this.minPrice === null ? '' : full(this.minPrice);
        if (max && document.activeElement !== max) max.value = this.maxPrice === null ? '' : full(this.maxPrice);
    }

    /** "Filtered by: [“shirt” x] [Food x] [UGX 10,000 - 50,000 x]  Clear all" above the stores. */
    renderActiveFilters() {
        const bar = document.getElementById('activeFilters');
        if (!bar) return;
        const chips = [];
        const chip = (action, text, what) => `<button type="button" class="mk-fchip" data-mk-action="${action}"><span>${esc(text)}</span><i class="fas fa-xmark" aria-hidden="true"></i><span class="mk-sr">Remove ${esc(what)} filter</span></button>`;
        if (this.searchTerm) chips.push(chip('clear-search', '\u201c' + this.searchTerm + '\u201d', 'search'));
        if (this.currentFilter && this.currentFilter !== 'all') chips.push(chip('clear-category', window.NXCategories ? NXCategories.label(this.currentFilter) : this.currentFilter, 'category'));
        if (this.hasPriceFilter) {
            const range = this.minPrice !== null && this.maxPrice !== null ? `${price(this.minPrice)} \u2013 ${price(this.maxPrice)}`
                : this.minPrice !== null ? `From ${price(this.minPrice)}` : `Up to ${price(this.maxPrice)}`;
            chips.push(chip('clear-price', range, 'price'));
        }
        bar.hidden = !chips.length;
        bar.innerHTML = chips.length ? `<span class="mk-active-label">Filtered by</span>${chips.join('')}${chips.length > 1 ? '<button type="button" class="mk-fclear" data-mk-action="clear">Clear all</button>' : ''}` : '';
    }

    /** Icon tiles: Trending + Sell first, then every category in the shared list order. */
    renderCategoryTiles() {
        const grid = document.getElementById('categoryGrid');
        const C = window.NXCategories;
        if (!grid || !C) return;
        const tile = (attrs, icon, label, extra = '') =>
            `<${attrs.tag} class="cat-tile${extra}" role="listitem" ${attrs.html}>` +
            `<span class="cat-tile-art">${C.iconHTML(icon, 56)}</span><span class="cat-tile-label">${C.escape(label)}</span></${attrs.tag}>`;
        const sellHref = app.user?.role === 'seller' ? '/product-form' : '/signup';
        grid.innerHTML =
            tile({ tag: 'button', html: 'type="button" data-tile="trending"' }, 'trending', 'Trending', ' cat-tile--action') +
            tile({ tag: 'a', html: `href="${sellHref}" data-tile="sell"` }, 'sell', 'Sell', ' cat-tile--action') +
            C.list.map(c => tile({ tag: 'button', html: `type="button" data-category="${c.id}" aria-label="${C.escape(c.label)}"` }, c.id, c.short)).join('');

        grid.addEventListener('click', (e) => {
            const el = e.target.closest('.cat-tile');
            if (!el) return;
            if (el.dataset.tile === 'trending') {
                this.setActiveFilter('all');
                document.getElementById('trendingProducts')?.closest('section')?.scrollIntoView({ behavior: 'smooth' });
            } else if (el.dataset.category) {
                // Tapping the active tile again clears the filter.
                this.filterByCategory(this.currentFilter === el.dataset.category ? 'all' : el.dataset.category);
            }
        });

        const toggle = document.getElementById('catTilesToggle');
        toggle?.addEventListener('click', () => {
            const collapsed = grid.classList.toggle('is-collapsed');
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            document.getElementById('catTilesToggleText').textContent = collapsed ? 'All categories' : 'Show fewer';
            toggle.querySelector('.fa-chevron-down, .fa-chevron-up')?.classList.toggle('fa-chevron-up', !collapsed);
            toggle.querySelector('.fa-chevron-down, .fa-chevron-up')?.classList.toggle('fa-chevron-down', collapsed);
        });
        document.getElementById('catFilterClear')?.addEventListener('click', () => this.setActiveFilter('all'));
        this.syncCategoryUi();
    }

    /** Keeps the tiles' active state and the "Showing: X" chip in step with the current filter. */
    syncCategoryUi() {
        const C = window.NXCategories;
        const grid = document.getElementById('categoryGrid');
        const filter = this.currentFilter;
        document.querySelectorAll('.filter-tab').forEach(tab => {
            const on = tab.dataset.filter === filter;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        grid?.querySelectorAll('[data-category]').forEach(el => {
            const on = el.dataset.category === filter;
            el.classList.toggle('is-active', on);
            el.setAttribute('aria-pressed', on ? 'true' : 'false');
            // A selected category hidden behind "All categories" must stay visible.
            if (on && grid.classList.contains('is-collapsed') && getComputedStyle(el).display === 'none') {
                document.getElementById('catTilesToggle')?.click();
            }
        });
        const chip = document.getElementById('catFilterChip');
        if (chip && C) {
            const showing = filter && filter !== 'all';
            chip.hidden = !showing;
            if (showing) document.getElementById('catFilterChipText').textContent = 'Showing: ' + C.label(filter);
        }
    }

    filterByCategory(category) {
        this.setActiveFilter(category);
        // Scroll to stores section
        document.querySelector('.marketplace-stores')?.scrollIntoView({ behavior: 'smooth' });
    }

    // Debounced so a fast typist doesn't fire one request per keystroke -
    // the live preview dropdown (renderSearchPreview) already gives
    // instant feedback while this settles.
    searchMarketplace(searchTerm) {
        this.searchTerm = String(searchTerm || '').trim().slice(0, 100);
        const heroInput = document.getElementById('heroSearch');
        if (heroInput && heroInput.value.trim() !== this.searchTerm) heroInput.value = this.searchTerm;
        clearTimeout(this.catalogSearchDebounce);
        this.catalogSearchDebounce = setTimeout(() => this.applyCatalogFilters(), 250);
    }
}

// Initialize marketplace
window.marketplaceManager = null;
if (document.querySelector('.marketplace-container')) {
    window.marketplaceManager = new MarketplaceManager();
}
})();
