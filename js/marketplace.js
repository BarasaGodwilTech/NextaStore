class MarketplaceManager {
    constructor() {
        this.stores = [];
        this.products = [];
        this.currentFilter = 'all';
        this.searchTerm = '';
        this.isLoading = false;
        this.searchRequestId = 0;
        this.catalogRequestId = 0;
        this.catalogSearchDebounce = null;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        app.renderAccountNavs();
        this.showLoadingStates();
        await this.loadMarketplaceData();
    }

    showLoadingStates() {
        // Show loading states for all dynamic content
        document.getElementById('storesLoadingState')?.classList.add('active');
        document.getElementById('storesContent')?.classList.add('hidden');
        
        document.getElementById('productsLoadingState')?.classList.add('active');
        document.getElementById('productsContent')?.classList.add('hidden');
    }

    hideLoadingStates() {
        // Hide loading states and show actual content
        document.getElementById('storesLoadingState')?.classList.remove('active');
        document.getElementById('storesContent')?.classList.remove('hidden');
        
        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');
    }

    setupEventListeners() {
        // Category cards
        document.querySelectorAll('.category-card').forEach(card => {
            card.addEventListener('click', () => {
                const category = card.dataset.category;
                this.filterByCategory(category);
            });
        });

        // Filter tabs
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.setActiveFilter(tab.dataset.filter);
            });
        });

        // "View all" trending products — the grid only shows the first 8 by
        // default; the full catalog is already loaded client-side (see
        // loadMarketplaceData), so this just expands in place instead of
        // linking somewhere that doesn't exist.
        const viewAllBtn = document.getElementById('viewAllTrendingBtn');
        if (viewAllBtn) {
            viewAllBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const expanded = viewAllBtn.dataset.expanded === '1';
                if (expanded) {
                    this.renderTrendingProducts();
                    viewAllBtn.textContent = 'View all';
                    viewAllBtn.dataset.expanded = '0';
                } else {
                    this.renderProductCards(this.products);
                    viewAllBtn.textContent = 'Show less';
                    viewAllBtn.dataset.expanded = '1';
                }
            });
        }

        // Marketplace search — live preview dropdown (item 7): as the
        // shopper types, show matching products/stores so they can confirm
        // before navigating anywhere, instead of committing on every
        // keystroke. The existing full-grid filter below still runs too,
        // so the page behind the dropdown updates immediately either way.
        const searchInput = document.getElementById('marketplaceSearch');
        if (searchInput) {
            let searchDebounceTimeout;
            searchInput.addEventListener('input', (e) => {
                const value = e.target.value;
                this.searchMarketplace(value);

                clearTimeout(searchDebounceTimeout);
                searchDebounceTimeout = setTimeout(() => this.renderSearchPreview(value), 200);
            });
            // searchMarketplace() itself debounces before hitting the
            // server (see below) — this listener just forwards keystrokes.
            searchInput.addEventListener('focus', () => this.renderSearchPreview(searchInput.value));
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.closeSearchPreview();
                if (e.key === 'Escape') { searchInput.blur(); this.closeSearchPreview(); }
            });
            document.addEventListener('click', (e) => {
                if (!document.getElementById('marketplaceSearchBar')?.contains(e.target)) this.closeSearchPreview();
            });
        }
    }

    closeSearchPreview() {
        document.getElementById('marketplaceSearchBar')?.classList.remove('open');
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
                    <a href="${app.storeLink(s)}" class="search-preview-item">
                        <span class="search-preview-thumb" style="${s.logo ? `background-image:url('${app.escapeHtml(app.resolveImageUrl(s.logo))}')` : ''}">${s.logo ? '' : '<i class="fas fa-store"></i>'}</span>
                        <span class="search-preview-info"><span class="search-preview-name">${app.escapeHtml(s.name)}</span><span class="search-preview-meta">Store</span></span>
                    </a>`).join('');
            }
            if (products.length) {
                html += '<div class="search-preview-group-label">Products</div>';
                html += products.slice(0, 6).map(p => `
                    <a href="product-detail.html?id=${encodeURIComponent(p.id)}${p.storeSlug ? `&store=${encodeURIComponent(p.storeSlug)}` : ''}" class="search-preview-item">
                        <span class="search-preview-thumb" style="${app.productThumb(p) ? `background-image:url('${app.escapeHtml(app.productThumb(p))}')` : ''}">${app.productThumb(p) ? '' : '<i class="fas fa-box"></i>'}</span>
                        <span class="search-preview-info"><span class="search-preview-name">${app.escapeHtml(p.name)}</span><span class="search-preview-meta">${app.escapeHtml(p.storeName || '')}</span></span>
                        <span class="search-preview-price">${app.formatCurrency(p.price)}</span>
                    </a>`).join('');
            }
            html += `<a class="search-preview-submit" href="marketplace.html?search=${encodeURIComponent(q)}">See more results for "${app.escapeHtml(q)}"</a>`;
            dropdown.innerHTML = html;
        } catch (error) {
            if (requestId !== this.searchRequestId) return;
            dropdown.innerHTML = '<div class="search-preview-empty">Search is unavailable right now. Please try again.</div>';
        }
    }

    async loadMarketplaceData() {
        this.isLoading = true;
        this.renderLoadingStates();

        try {
            // Initial, unfiltered page: 12 stores / 60 products, same as
            // the defaults applyCatalogFilters() below uses. Category and
            // search filtering both go through that one method instead of
            // filtering this fixed page in the browser — see its comment
            // for why that distinction matters as the catalog grows.
            const [storesRes, productsRes] = await Promise.all([
                app.apiRequest('/store/public/all'),
                app.apiRequest('/products/public?limit=60')
            ]);

            this.products = productsRes.data || [];
            this.stores = (storesRes.data && Array.isArray(storesRes.data)) ? storesRes.data : [];

            this.renderStores();
            this.renderTrendingProducts();
            const initialSearch = new URLSearchParams(window.location.search).get('search') || '';
            if (initialSearch) {
                const input = document.getElementById('marketplaceSearch');
                if (input) input.value = initialSearch;
                this.searchMarketplace(initialSearch);
            }
        } catch (error) {
            console.error('Error loading marketplace data:', error);
            this.renderEmptyState();
        } finally {
            this.isLoading = false;
        }
    }

    // Re-fetches stores/products from the server for the current category
    // + search term, instead of filtering whatever fixed page happened to
    // load first. The marketplace used to load one page of 12 stores and
    // 60 products up front and then have every category tab and every
    // keystroke in the search box filter *that same small array* in the
    // browser — which looks fine while the catalog is small, but silently
    // breaks as it grows: a store or product that didn't happen to be in
    // that first page could never show up in a category tab or a search,
    // no matter how good the match. Both endpoints already support
    // `category`/`q`/pagination server-side (see store.js / products.js),
    // so this just asks them directly instead of re-implementing a worse,
    // partial version of the same filtering in JS.
    async applyCatalogFilters() {
        const requestId = ++this.catalogRequestId;
        this.renderLoadingStates();
        document.getElementById('storesLoadingState')?.classList.add('active');
        document.getElementById('productsLoadingState')?.classList.add('active');

        const params = new URLSearchParams();
        if (this.searchTerm) params.set('q', this.searchTerm);

        const storeParams = new URLSearchParams(params);
        if (this.currentFilter && this.currentFilter !== 'all') storeParams.set('category', this.currentFilter);

        const productParams = new URLSearchParams(params);
        productParams.set('limit', '60');
        if (this.currentFilter && this.currentFilter !== 'all') productParams.set('category', this.currentFilter);

        try {
            const [storesRes, productsRes] = await Promise.all([
                app.apiRequest(`/store/public/all?${storeParams.toString()}`),
                app.apiRequest(`/products/public?${productParams.toString()}`)
            ]);
            // A newer filter/search request already landed — drop this
            // stale response instead of flickering the grid backwards.
            if (requestId !== this.catalogRequestId) return;

            this.stores = (storesRes.data && Array.isArray(storesRes.data)) ? storesRes.data : [];
            this.products = productsRes.data || [];

            const viewAllBtn = document.getElementById('viewAllTrendingBtn');
            if (viewAllBtn) { viewAllBtn.dataset.expanded = '0'; viewAllBtn.textContent = 'View all'; }

            this.renderStores();
            this.renderTrendingProducts();
        } catch (error) {
            if (requestId !== this.catalogRequestId) return;
            console.error('Error filtering marketplace data:', error);
            this.renderEmptyState();
        }
    }

    renderStores() {
        // Filtering already happened server-side in applyCatalogFilters —
        // this.stores is exactly the set that matches the current
        // category/search.
        this.renderStoreCards(this.stores);
    }

    renderStoreCards(stores) {
        const container = document.getElementById('storesGrid');
        if (!container) return;

        // Hide loading state for stores
        document.getElementById('storesLoadingState')?.classList.remove('active');
        document.getElementById('storesContent')?.classList.remove('hidden');

        if (stores.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; padding: var(--spacing-xl);">
                    <div class="empty-icon"><i class="fas fa-store"></i></div>
                    <h3>No stores found</h3>
                    <p>Try a different category or check back later.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = stores.map(store => {
            const bannerStyle = store.banner
                ? `background-image: url(${app.resolveImageUrl(store.banner)}); background-size: cover; background-position: center;`
                : `background: ${store.bannerColor || window.NextaStoreBanner?.DEFAULT_BANNER_COLOR || '#00B074'};`;

            return `
            <div class="store-card" data-store-id="${store.id}" data-store-slug="${store.slug || ''}" role="button" tabindex="0" aria-label="Visit ${app.escapeHtml(store.name)}">
                <div class="store-banner" style="${bannerStyle}"></div>
                <div class="store-info">
                    <div class="store-logo" style="${store.logo ? `background-image: url(${app.resolveImageUrl(store.logo)}); background-size: cover; background-position: center;` : ''}">
                        ${!store.logo ? app.getInitial(store.name) : ''}
                    </div>
                    <h3 class="store-name">${app.escapeHtml(store.name)} <span class="store-badge-row">${app.renderSellerBadges(store, { limit: 2 })}</span></h3>
                    <p class="store-description">${app.escapeHtml(store.description || 'No description available')}</p>
                    <div class="store-meta">
                        ${store.badges?.length ? `<span class="store-meta-item"><i class="fas fa-award"></i> ${app.escapeHtml(store.badges[0].label)}</span>` : ''}
                        <span class="store-meta-item"><i class="fas fa-users"></i> ${(store.followers || 0).toLocaleString()}</span>
                        <span class="store-meta-item"><i class="fas fa-box"></i> ${store.productCount || 0} products</span>
                    </div>
                    <div class="store-actions">
                        <button type="button" class="btn btn-primary">Visit Store</button>
                    </div>
                </div>
            </div>
        `}).join('');

        container.querySelectorAll('[data-store-id]').forEach(card => {
            const go = () => this.visitStore(card.dataset.storeSlug || card.dataset.storeId);
            card.addEventListener('click', go);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        });
    }

    renderTrendingProducts() {
        const trendingProducts = this.products.slice(0, 8);
        this.renderProductCards(trendingProducts);
    }

    renderProductCards(products) {
        const container = document.getElementById('trendingProducts');
        if (!container) return;

        // Hide loading state for products
        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');

        if (products.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; padding: var(--spacing-xl);">
                    <div class="empty-icon"><i class="fas fa-box-open"></i></div>
                    <h3>No products yet</h3>
                    <p>Check back soon for trending products!</p>
                </div>
            `;
            return;
        }

        container.innerHTML = products.map(product => {
            const thumb = app.productThumb(product);
            return `
            <div class="product-card" data-product-id="${product.id}" data-store-key="${product.storeSlug || product.storeId || ''}" role="button" tabindex="0" aria-label="${app.escapeHtml(product.name)}">
                <div class="product-image" style="${thumb ? `background-image: url(${thumb})` : ''}">
                    ${!thumb ? `<i class="fas ${product.icon || 'fa-box'}"></i>` : ''}
                    ${product.originalPrice && product.originalPrice > product.price ? 
                        `<span class="product-badge">-${Math.round((1 - product.price / product.originalPrice) * 100)}%</span>` : ''}
                </div>
                <div class="product-info">
                    <p class="product-store">${app.escapeHtml(product.storeName || 'Local Store')}</p>
                    <h4 class="product-name">${app.escapeHtml(product.name)}</h4>
                    <div class="product-price">
                        <span class="current-price">${app.formatCurrency(product.price)}</span>
                        ${product.originalPrice && product.originalPrice > product.price ? 
                            `<span class="product-original-price">${app.formatCurrency(product.originalPrice)}</span>` : ''}
                    </div>
                </div>
            </div>
        `}).join('');

        container.querySelectorAll('[data-product-id]').forEach(card => {
            const go = () => this.viewProduct(card.dataset.productId, card.dataset.storeKey);
            card.addEventListener('click', go);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        });
    }

    setActiveFilter(filter) {
        this.currentFilter = filter;
        
        // Update tab styling
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.filter === filter);
        });

        this.applyCatalogFilters();
    }

    filterByCategory(category) {
        this.setActiveFilter(category);
        
        // Scroll to stores section
        document.querySelector('.marketplace-stores')?.scrollIntoView({ behavior: 'smooth' });
    }

    // Debounced so a fast typist doesn't fire one request per keystroke —
    // the live preview dropdown (renderSearchPreview) already gives
    // instant feedback while this settles.
    searchMarketplace(searchTerm) {
        this.searchTerm = searchTerm.trim();
        clearTimeout(this.catalogSearchDebounce);
        this.catalogSearchDebounce = setTimeout(() => this.applyCatalogFilters(), 250);
    }

    renderLoadingStates() {
        // Loading states are now handled by HTML structure
        // This method is kept for compatibility but no longer needed
    }

    renderEmptyState() {
        // Hide loading states
        document.getElementById('storesLoadingState')?.classList.remove('active');
        document.getElementById('storesContent')?.classList.remove('hidden');
        document.getElementById('productsLoadingState')?.classList.remove('active');
        document.getElementById('productsContent')?.classList.remove('hidden');

        const storesContainer = document.getElementById('storesGrid');
        const productsContainer = document.getElementById('trendingProducts');

        if (storesContainer) {
            storesContainer.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; padding: var(--spacing-xl);">
                    <div class="empty-icon"><i class="fas fa-store"></i></div>
                    <h3>Marketplace Coming Soon</h3>
                    <p>We're setting up our marketplace with amazing Ugandan stores.</p>
                </div>
            `;
        }

        if (productsContainer) {
            productsContainer.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; padding: var(--spacing-xl);">
                    <div class="empty-icon"><i class="fas fa-box-open"></i></div>
                    <h3>Products Coming Soon</h3>
                    <p>Check back soon for trending products!</p>
                </div>
            `;
        }
    }

    visitStore(slugOrId) {
        // Navigate to the store's own address (/<slug>; falls back to the
        // id for stores that somehow have no slug) — see app.storeLink().
        window.location.href = app.storeLinkFor(slugOrId);
    }

    viewProduct(productId, storeKey) {
        // storeKey is the store's slug when available (passed straight
        // from the card's dataset), falling back to the id looked up from
        // the already-loaded product list.
        if (!storeKey) {
            const product = this.products.find(p => p.id === productId);
            storeKey = product?.storeSlug || product?.storeId || '';
        }
        window.location.href = `product-detail.html?id=${encodeURIComponent(productId)}${storeKey ? `&store=${encodeURIComponent(storeKey)}` : ''}`;
    }
}

// Initialize marketplace
let marketplaceManager;
if (document.querySelector('.marketplace-container')) {
    marketplaceManager = new MarketplaceManager();
}