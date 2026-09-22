class StoreDetailManager {
    constructor() {
        this.store = null;
        this.products = [];
        this.productsPage = 1;
        this.productsPagination = null;
        this.currentCategory = 'all';
        this.currentSort = 'popular';
        this.priceRange = { min: null, max: null };
        this.searchTerm = '';
        this.isFollowing = false;
        // Labels match the category options sellers pick in product-form.html.
        this.categoryLabels = {
            clothing: 'Clothing',
            accessories: 'Accessories',
            food: 'Food & Drinks',
            home: 'Home & Living',
            electronics: 'Electronics',
            other: 'Other'
        };
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.setupMobileSidebar();
        this.setupProductEventListeners();
        this.showLoadingStates();
        await this.loadStoreData();
        await this.loadFollowState();
        await this.loadProducts();
        this.renderStoreFilters();
        this.renderProducts();
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

        if (!(this.store?.productCount > 0)) {
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
                    <a href="#" data-category="${c.value}">${app.escapeHtml(c.label)}</a>
                </li>
            `).join('');
        } else {
            // Zero or one category → the filter can't exclude anything.
            categorySection.hidden = true;
            this.currentCategory = 'all';
        }

        // Price filter only makes sense when the store's products actually
        // span a price range.
        const priceSection = document.getElementById('priceSection');
        if ((this.store?.productCount || 0) > 1) {
            priceSection.hidden = false;
            const min = document.getElementById('minPrice');
            const max = document.getElementById('maxPrice');
            if (min && max) {
                min.placeholder = 'Minimum price';
                max.placeholder = 'Maximum price';
            }
        } else {
            priceSection.hidden = true;
            this.priceRange = { min: null, max: null };
        }
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

        // Price filter
        document.getElementById('applyPriceFilter')?.addEventListener('click', () => {
            this.priceRange.min = parseFloat(document.getElementById('minPrice').value) || null;
            this.priceRange.max = parseFloat(document.getElementById('maxPrice').value) || null;
            this.loadProducts(1, false);
        });

        // Search functionality
        const searchInput = document.getElementById('storeSearch');
        if (searchInput) {
            searchInput.addEventListener('input', app.debounce((e) => {
                this.searchTerm = e.target.value.trim();
                this.renderSearchPreview(this.searchTerm);
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
        const sidebar = document.querySelector('.store-sidebar');
        const overlay = document.getElementById('sidebarOverlay');

        // Create mobile toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'mobile-sidebar-toggle btn btn-outline btn-sm';
        toggleBtn.innerHTML = '<i class="fas fa-sliders"></i> Filters';
        toggleBtn.setAttribute('aria-label', 'Toggle filters');

        const navRight = document.querySelector('.nav-right');
        if (navRight) {
            navRight.insertBefore(toggleBtn, navRight.firstChild);
        }

        const toggleSidebar = () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        };

        toggleBtn.addEventListener('click', toggleSidebar);
        overlay?.addEventListener('click', toggleSidebar);
    }

    async loadStoreData() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const storeSlug = urlParams.get('store');

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
            this.renderStoreInfo();
            this.loadSellerPresence();
        } catch (error) {
            console.error('Failed to load store data:', error);
            this.renderEmptyStore();
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

    // Single source of truth for the "badges + product count + follower
    // count" pill row under the store name. Called on initial render and
    // again whenever the follower count changes (follow/unfollow, or a
    // fresh /store/follow read) so that number never drifts out of sync
    // with a second, separately-updated copy elsewhere on the page.
    renderTrustSignals() {
        const trust = document.getElementById('storeTrustSignals');
        if (!trust) return;
        const badgePills = this.store.badges?.length
            ? this.store.badges.slice(0, 3).map(b => `<span><i class="fas ${app.escapeHtml(b.icon || 'fa-award')}"></i> ${app.escapeHtml(b.label)}</span>`).join('')
            : '';
        trust.innerHTML = `${badgePills}<span><i class="fas fa-box"></i> ${this.store.productCount || 0} listed products</span><span><i class="fas fa-users"></i> ${(this.store.followers || 0).toLocaleString()} followers</span>`;
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

        // The canonical, search-engine-facing address of this store is the
        // server-rendered /s/<slug> page (see nextastore-backend/src/seo.js).
        // Pointing this JavaScript view at it keeps the two from competing
        // as duplicates in search results.
        if (this.store.publicUrl) {
            let canonical = document.querySelector('link[rel="canonical"]');
            if (!canonical) {
                canonical = document.createElement('link');
                canonical.rel = 'canonical';
                document.head.appendChild(canonical);
            }
            canonical.href = this.store.publicUrl;
        }

        // Update breadcrumb
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = `
                <a href="marketplace.html">Marketplace</a>
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
                logo.style.backgroundImage = `url(${app.resolveImageUrl(this.store.logo)})`;
                logo.style.backgroundSize = 'cover';
                logo.style.backgroundPosition = 'center';
                logo.innerHTML = '';
            } else {
                logo.style.backgroundImage = 'none';
                logo.textContent = app.getInitial(this.store.name);
            }
        }

        // Update store info
        document.getElementById('storeName').textContent = this.store.name;
        document.getElementById('storeDescription').textContent = this.store.description || 'Welcome to our store!';
        const badges = document.getElementById('storeBadges'); if (badges) badges.innerHTML = app.renderSellerBadges(this.store, { limit: 3 });
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
            document.getElementById('storeLocation').textContent = location.join(', ');
            document.getElementById('storeLocation').parentElement.style.display = 'flex';
        } else {
            document.getElementById('storeLocation').parentElement.style.display = 'none';
        }

        // "About this store" card — only claims the backend actually
        // supports (verified flag, completed orders, location). The old
        // static "response time / shipping" rows were placeholders with no
        // data behind them and leaked seller-only marketing into the buyer
        // view.
        const infoCard = document.getElementById('storeInfoCard');
        if (infoCard) {
            const infoRows = [];
            if (this.store.badges?.length) {
                this.store.badges.slice(0, 3).forEach(b => infoRows.push(`<div class="info-row"><i class="fas ${app.escapeHtml(b.icon || 'fa-award')}"></i><span>${app.escapeHtml(b.label)}</span></div>`));
            }
            infoRows.push(`<div class="info-row"><i class="fas fa-box"></i><span>${this.store.productCount || 0} products listed</span></div>`);
            infoRows.push(`<div class="info-row"><i class="fas fa-circle-check"></i><span>${this.store.completedOrderCount || 0} completed orders</span></div>`);
            if (location.length) {
                infoRows.push(`<div class="info-row"><i class="fas fa-location-dot"></i><span>${app.escapeHtml(location.join(', '))}</span></div>`);
            }
            infoCard.innerHTML = infoRows.join('');
        }

        // Small map preview next to the location row, when the seller has
        // dropped an exact pin (not just picked a district).
        const mapPreview = document.getElementById('storeMapPreview');
        if (mapPreview) {
            if (this.store.mapCoordinates) {
                const [lat, lng] = this.store.mapCoordinates.split(',').map(Number);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    mapPreview.style.display = 'block';
                    window.NextaStoreMapPreview?.render(mapPreview, {
                        lat, lng, width: 260, height: 140,
                        mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(this.store.mapCoordinates)}`
                    });
                } else {
                    mapPreview.style.display = 'none';
                }
            } else {
                mapPreview.style.display = 'none';
            }
        }

        // Show store actions
        const storeActions = document.querySelector('.store-actions');
        if (storeActions) {
            storeActions.style.display = 'flex';
        }

        // Hide loading state for store info
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
    }

    renderEmptyStore() {
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

        document.getElementById('storeName').textContent = 'Store Not Found';
        document.getElementById('storeDescription').textContent = 'This store may have been removed or is temporarily unavailable.';
        document.getElementById('storeBadges').innerHTML = '';
        document.getElementById('storeLocation').textContent = 'Unknown';
        const trust = document.getElementById('storeTrustSignals'); if (trust) trust.innerHTML = '';

        // Update breadcrumb for not found state
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = `
                <a href="marketplace.html">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current">Store Not Found</span>
            `;
        }
        
        // Hide the store actions
        const storeActions = document.querySelector('.store-actions');
        if (storeActions) {
            storeActions.style.display = 'none';
        }
        
        document.getElementById('productsGrid').innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-store-slash"></i></div>
                <h3>Store Not Available</h3>
                <p>This store may have been removed or the link is incorrect.</p>
                <a href="marketplace.html" class="btn btn-primary"><i class="fas fa-store"></i> Browse Other Stores</a>
            </div>
        `;
    }

    async loadProducts(page = 1, append = false) {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const storeKey = urlParams.get('store') || this.store?.slug || this.store?.id;
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

    /** Sets each visible product card's heart icon to match the shopper's
     *  saved favorites, so a returning visitor sees which items they'd
     *  already liked instead of every heart starting empty. Runs after
     *  render, one lightweight check per card on this page — optionalAuth
     *  on the backend means logged-out visitors just get `favorited: false`
     *  back instead of failing the whole page. */
    async loadFavoriteStates() {
        const grid = document.getElementById('productsGrid');
        if (!grid || !this.products?.length) return;
        await Promise.all(this.products.map(async (product) => {
            try {
                const response = await app.apiRequest(`/favorites/${encodeURIComponent(product.id)}`);
                if (!response.data?.favorited) return;
                const icon = grid.querySelector(`.product-card[data-product-id="${product.id}"] .favorite-btn i`);
                if (icon) { icon.classList.remove('far'); icon.classList.add('fas'); icon.parentElement.style.color = 'var(--coral)'; }
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
        dropdown.innerHTML = matches.map(p => `<a class="search-preview-item" href="product-detail.html?id=${encodeURIComponent(p.id)}&store=${encodeURIComponent(this.store?.slug || '')}"><span class="search-preview-thumb" style="${app.productThumb(p) ? `background-image:url('${app.escapeHtml(app.productThumb(p))}')` : ''}">${app.productThumb(p) ? '' : '<i class="fas fa-box"></i>'}</span><span><span class="search-preview-name">${app.escapeHtml(p.name)}</span><span class="search-preview-meta">${app.formatCurrency(p.price)}</span></span></a>`).join('');
        bar.classList.add('open');
    }

    closeSearchPreview() { document.getElementById('storeSearchBar')?.classList.remove('open'); }

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

        if (!filtered.length) {
            const hasActiveFilters = this.currentCategory !== 'all' || this.searchTerm || this.priceRange.min !== null || this.priceRange.max !== null;
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
                        <a href="marketplace.html" class="btn btn-primary"><i class="fas fa-store"></i> Browse Other Stores</a>
                    </div>
                </div>
            `;
            document.getElementById('emptyStateMessageBtn')?.addEventListener('click', () => this.openContactModal());
            return;
        }

        grid.innerHTML = filtered.map(product => `
            <div class="product-card" data-product-id="${product.id}">
                <div class="product-image">
                    ${app.productThumb(product)
                        ? `<img src="${app.productThumb(product)}" alt="${app.escapeHtml(product.name)}" loading="lazy">`
                        : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-size:2.5rem;"><i class="fas ${product.icon || 'fa-box'}"></i></div>`}
                    <button class="favorite-btn" aria-label="Save to favorites"><i class="far fa-heart"></i></button>
                    ${product.originalPrice && product.originalPrice > product.price 
                        ? `<span class="discount-badge">-${Math.round((1 - product.price / product.originalPrice) * 100)}%</span>` 
                        : ''}
                </div>
                <div class="product-details">
                    <h3>${app.escapeHtml(product.name)}</h3>
                    <p class="product-price">
                        ${product.originalPrice && product.originalPrice > product.price 
                            ? `<span class="original-price">${app.formatCurrency(product.originalPrice)}</span>` 
                            : ''}
                        <span class="current-price">${app.formatCurrency(product.price)}</span>
                    </p>
                    <button class="btn btn-primary btn-sm add-to-cart"><i class="fas fa-cart-plus"></i> Add to Cart</button>
                </div>
            </div>
        `).join('') + (this.productsPagination?.page < this.productsPagination?.pages
            ? '<button type="button" class="btn btn-outline btn-block" id="storeLoadMoreProducts">Load more products</button>' : '');

        document.getElementById('storeLoadMoreProducts')?.addEventListener('click', () => {
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
    }

    addToCart(productId, quantity = 1) {
        const product = this.products.find(p => p.id === productId);
        if (!product) return;
        try { window.NextaCart.add(product, quantity, this.store); app.showAlert(`Added ${quantity} item(s) to cart`, 'success'); }
        catch (error) { app.showAlert(error.message, 'error'); }
    }

    updateCartUI() {
        const count = window.NextaCart?.count() || 0;
        document.querySelectorAll('.cart-count').forEach(el => el.textContent = count);
        const root = document.querySelector('.cart-items');
        if (root) window.NextaCart.renderMiniCart(root);
    }

    toggleFavorite(productId) {
        if (!app.requireLogin('Log in to save items to your favorites.', { type: 'favorite-product', productId })) return;

        const btn = document.querySelector(`.product-card[data-product-id="${productId}"] .favorite-btn i`);
        if (!btn) return;

        if (btn.classList.contains('far')) {
            btn.classList.remove('far');
            btn.classList.add('fas');
            btn.parentElement.style.color = 'var(--coral)';
            app.showAlert('Added to favorites', 'success');
        } else {
            btn.classList.remove('fas');
            btn.classList.add('far');
            btn.parentElement.style.color = '';
            app.showAlert('Removed from favorites', 'success');
        }
    }

    viewProductDetail(productId) {
        const urlParams = new URLSearchParams(window.location.search);
        const storeId = urlParams.get('store');
        window.location.href = `product-detail.html?id=${productId}${storeId ? `&store=${storeId}` : ''}`;
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
    if (!storeDetailManager) return;
    storeDetailManager.currentCategory = 'all';
    storeDetailManager.searchTerm = '';
    storeDetailManager.priceRange = { min: null, max: null };

    document.getElementById('storeSearch').value = '';
    document.getElementById('minPrice').value = '';
    document.getElementById('maxPrice').value = '';

    // The category list is rendered from the store's inventory — refresh it
    // so the "All Products" option is active again.
    storeDetailManager.renderStoreFilters();

    storeDetailManager.loadProducts(1, false);
}

// Initialize
if (document.querySelector('.store-content')) {
    storeDetailManager = new StoreDetailManager();
}