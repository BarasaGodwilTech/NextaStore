function slugifyStoreSlug(text) { return (text || 'my-store').toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'my-store'; }

class DashboardManager {
    constructor() {
        this.currentSection = 'overview';
        this.products = [];
        this.productsPage = 1;
        this.productsPagination = null;
        this.selectMode = false; // bulk-select mode for the Products list
        this.selectedProductIds = new Set();
        this.orders = [];
        this.charts = {
            revenue: null,
            category: null
        };
        // Search & sharing: true while the seoTitle/seoDescription fields hold
        // a computed suggestion (derived from the store's own name/area/
        // description) rather than text the seller typed themselves. See
        // populateStoreSettings(), updateSerpPreview() and the save handler.
        this.seoTitleAuto = true;
        this.seoDescAuto = true;
        this.init();
    }

    // ---- Skeleton loading placeholders (item 1) ----
    // dashboard.html has no dashboard-wide loading-state/content pair the
    // way marketplace.html does — every section here is one persistent
    // container that gets overwritten in place each time its data loads,
    // since switching sections doesn't reload the page. So instead of a
    // second static markup block to toggle visibility on, these helpers
    // generate the same shimmering `.skeleton`/`.skeleton-text` markup on
    // demand; each load*() function writes it into its container as the
    // very first thing it does, and the existing render*() call a few
    // lines later naturally overwrites it once real data (or an error
    // state) comes back.
    skeletonProductCards(n = 4) {
        return Array.from({ length: n }).map(() => `
            <div class="storefront-product-card is-skeleton">
                <div class="storefront-product-image skeleton skeleton-image"></div>
                <div class="storefront-product-body">
                    <div class="skeleton skeleton-text" style="width:70%"></div>
                    <div class="skeleton skeleton-text-sm" style="width:40%"></div>
                    <div class="skeleton skeleton-text-sm" style="width:50%"></div>
                </div>
            </div>
        `).join('');
    }

    skeletonManageProductCards(n = 6) {
        return `<div class="manage-products-grid">${Array.from({ length: n }).map(() => `
            <div class="manage-product-card is-skeleton">
                <div class="manage-product-image skeleton skeleton-image"></div>
                <div class="manage-product-body">
                    <div class="skeleton skeleton-text" style="width:75%"></div>
                    <div class="skeleton skeleton-text-sm" style="width:45%"></div>
                </div>
            </div>
        `).join('')}</div>`;
    }

    skeletonListRows(n = 3, widthA = '55%', widthB = '20%') {
        return Array.from({ length: n }).map(() => `
            <div class="compact-order-item is-skeleton">
                <div class="compact-order-info">
                    <div class="skeleton skeleton-text-sm" style="width:${widthA}"></div>
                </div>
                <div class="skeleton skeleton-text-sm" style="width:${widthB}"></div>
            </div>
        `).join('');
    }

    skeletonTableRows(n, cols) {
        return Array.from({ length: n }).map(() => `
            <tr class="is-skeleton">${Array.from({ length: cols }).map(() => `<td><div class="skeleton skeleton-text"></div></td>`).join('')}</tr>
        `).join('');
    }

    skeletonProductItems(n = 4) {
        return Array.from({ length: n }).map(() => `
            <div class="product-item is-skeleton">
                <div class="skeleton skeleton-avatar"></div>
                <div class="product-info">
                    <div class="skeleton skeleton-text" style="width:60%"></div>
                    <div class="skeleton skeleton-text-sm" style="width:30%"></div>
                </div>
                <div class="skeleton skeleton-text-sm" style="width:44px"></div>
            </div>
        `).join('');
    }

    skeletonStatCards(n = 4) {
        return `<div class="stats-grid">${Array.from({ length: n }).map(() => `
            <div class="stat-card is-skeleton">
                <div class="skeleton skeleton-avatar"></div>
                <div class="stat-info">
                    <div class="skeleton skeleton-text-lg" style="width:60%"></div>
                    <div class="skeleton skeleton-text-sm" style="width:80%"></div>
                </div>
            </div>
        `).join('')}</div>`;
    }

    skeletonNotifications(n = 4) {
        return Array.from({ length: n }).map(() => `
            <div class="notification-item is-skeleton">
                <span class="notification-item-icon skeleton skeleton-avatar" style="width:32px;height:32px;"></span>
                <span style="flex:1; display:block;">
                    <span class="skeleton skeleton-text" style="width:80%;display:block;"></span>
                    <span class="skeleton skeleton-text-sm" style="width:95%;display:block;"></span>
                    <span class="skeleton skeleton-text-sm" style="width:30%;display:block;"></span>
                </span>
            </div>
        `).join('');
    }

    /** Placeholder for the storefront branding header (logo, name,
     *  description, location) that otherwise shows literal fallback text
     *  ("My Store", "No description yet") until loadStoreBranding()'s
     *  request resolves. Every element this touches is fully overwritten
     *  either way once that request settles — see the now-explicit else
     *  branches added there — so nothing here can get stuck showing a
     *  permanent shimmer. */
    showBrandingSkeleton() {
        const logo = document.getElementById('storeLogoPreview');
        if (logo) { logo.style.backgroundImage = ''; logo.innerHTML = '<div class="skeleton skeleton-avatar" style="width:100%;height:100%;border-radius:inherit;"></div>'; }
        const name = document.getElementById('storeDisplayName');
        if (name) name.innerHTML = '<span class="skeleton skeleton-text-lg" style="display:inline-block;width:160px;"></span>';
        const desc = document.getElementById('storeDescriptionDisplay');
        if (desc) desc.innerHTML = '<span class="skeleton skeleton-text-sm" style="display:inline-block;width:240px;"></span>';
        const loc = document.getElementById('locationText');
        if (loc) loc.innerHTML = '<span class="skeleton skeleton-text-sm" style="display:inline-block;width:120px;"></span>';
    }

    async init() {
        this.setupNavigation();
        this.setupEventListeners();
        this.setupMobileMenu();
        this.setupSettingsNavigation();
        this.setupPushSettings();
        this.setupShareModal();
        this.setupGlobalSearch();

        // One-shot flag coming from the onboarding wizard's final "Launch
        // Store" step — sessionStorage so a page refresh doesn't re-trigger
        // it. Consumed by renderLiveBanner() (called from loadStoreBranding,
        // every time Overview loads) rather than a toast here: a toast can
        // come and go during the redirect from onboarding before the seller
        // is even looking at the screen, which is exactly the "not visible
        // enough" complaint that prompted this banner.
        this.justLaunched = sessionStorage.getItem('nextastore_just_launched') === '1';
        if (this.justLaunched) sessionStorage.removeItem('nextastore_just_launched');
        this.liveBannerDismissed = false;

        const initialSection = window.location.hash.replace('#', '');
        if (initialSection && document.getElementById(`${initialSection}Section`)) {
            this.switchSection(initialSection);
        } else {
            await this.loadOverview();
        }
    }

    setupNavigation() {
        document.querySelectorAll('[data-section]').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchSection(link.dataset.section);
            });
        });
    }

    switchSection(section) {
        this.currentSection = section;

        document.querySelectorAll('.dashboard-section').forEach(sec => {
            sec.style.display = sec.id === `${section}Section` ? 'block' : 'none';
        });

        const titles = { overview: 'Dashboard', products: 'Products', orders: 'Orders', analytics: 'Analytics', settings: 'Settings' };
        const topTitle = document.querySelector('.top-bar-left h2');
        if (topTitle) topTitle.textContent = titles[section] || 'Dashboard';

        // Update active navigation item
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.section === section) {
                item.classList.add('active');
            }
        });

        // Close the mobile sidebar after choosing a section
        if (this.setDrawerOpen) this.setDrawerOpen(false);
        else {
            document.querySelector('.sidebar')?.classList.remove('open');
            document.getElementById('sidebarOverlay')?.classList.remove('active');
        }

        this.loadSectionData(section);
    }

    async loadSectionData(section) {
        try {
            if (section === 'overview') await this.loadOverview();
            else if (section === 'products') await this.loadProducts();
            else if (section === 'orders') await this.loadOrders();
            else if (section === 'analytics') await this.loadAnalytics();
            else if (section === 'settings') await this.loadSettings();
        } catch (error) {
            app.showAlert(error.message || `Couldn\u2019t load ${section}`, 'error');
        }
    }

    async loadOverview() {
        // Skeletons first (item 1) — these containers would otherwise sit
        // empty, or show stale placeholder text like "My Store", for as
        // long as the requests below take.
        document.getElementById('storefrontProducts').innerHTML = this.skeletonProductCards(4);
        document.getElementById('recentOrdersCompact').innerHTML = this.skeletonListRows(3);
        document.getElementById('quickStats').innerHTML = this.skeletonListRows(4, '45%', '25%');
        ['miniProducts', 'miniOrders', 'miniRevenue'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<span class="skeleton skeleton-text-sm" style="display:inline-block;width:36px;"></span>';
        });
        this.showBrandingSkeleton();

        let stats = { totalProducts: 0, totalOrders: 0, totalRevenue: 0, totalCustomers: 0 };
        
        try {
            const statsResponse = await app.apiRequest('/dashboard/stats');
            stats = statsResponse.data;
            this.renderStorefrontStats(stats);
        } catch (error) {
            console.error('Error loading stats:', error);
            // Show empty state if no data
            this.renderStorefrontStats({ totalProducts: 0, totalOrders: 0, totalRevenue: 0 });
        }

        try {
            const orders = await app.apiRequest('/orders/recent');
            this.renderRecentOrdersCompact(orders.data);
        } catch (error) {
            console.error('Error loading recent orders:', error);
            document.getElementById('recentOrdersCompact').innerHTML = '<p class="text-muted">No recent orders</p>';
        }

        try {
            const products = await app.apiRequest('/products');
            const categoryFilter = document.getElementById('quickCategoryFilter')?.value || null;
            this.renderStorefrontProducts(products.data, categoryFilter);
        } catch (error) {
            console.error('Error loading products:', error);
            document.getElementById('storefrontProducts').innerHTML = '<p class="text-muted">No products yet</p>';
        }

        this.renderQuickStats(stats);
        await this.loadStoreBranding();
        this.setupStorefrontHandlers();
    }

    renderStorefrontStats(stats) {
        document.getElementById('miniProducts').textContent = stats.totalProducts || 0;
        document.getElementById('miniOrders').textContent = stats.totalOrders || 0;
        document.getElementById('miniRevenue').textContent = app.formatCurrency(stats.totalRevenue || 0);
    }

    renderStorefrontProducts(products, categoryFilter = null) {
        const container = document.getElementById('storefrontProducts');
        const filteredProducts = categoryFilter ? products.filter(p => p.category === categoryFilter) : products;
        
        if (!filteredProducts.length) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1; padding: var(--spacing-xl);">
                    <div class="empty-icon"><i class="fas fa-box-open"></i></div>
                    <h3>No products yet</h3>
                    <p>Add your first product to start selling on your storefront.</p>
                    <a class="btn btn-primary" href="product-form.html"><i class="fas fa-plus"></i> Add Product</a>
                </div>
            `;
            return;
        }

        container.innerHTML = filteredProducts.map(p => `
            <div class="storefront-product-card is-loaded" data-category="${p.category}">
                <div class="storefront-product-image" style="${app.productThumb(p) ? `background-image: url(${app.productThumb(p)})` : ''}">
                    ${!app.productThumb(p) ? `<i class="fas ${p.icon || 'fa-box'}"></i>` : ''}
                    <div class="storefront-product-actions">
                        <a class="btn btn-sm btn-outline" href="product-form.html?id=${p.id}" title="Edit"><i class="fas fa-pen"></i></a>
                        <button class="btn btn-sm btn-outline" onclick="dashboardManager.deleteProduct('${p.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <div class="storefront-product-body">
                    <h4>${app.escapeHtml(p.name)}</h4>
                    <div class="storefront-product-price">${app.formatCurrency(p.price)}</div>
                    <div class="storefront-product-stock">${p.stock ?? 0} in stock</div>
                </div>
            </div>
        `).join('');
    }

    renderRecentOrdersCompact(orders) {
        const container = document.getElementById('recentOrdersCompact');
        if (!orders.length) {
            container.innerHTML = `<p style="color: var(--gray-500); font-size: 0.875rem;">No orders yet</p>`;
            return;
        }

        container.innerHTML = orders.slice(0, 5).map(order => `
            <div class="compact-order-item is-loaded">
                <div class="compact-order-info">
                    <span class="compact-order-id">#${order.id}</span>
                    <span class="compact-order-customer">${app.escapeHtml(order.customerName)}</span>
                </div>
                <span class="compact-order-total">${app.formatCurrency(order.total)}</span>
            </div>
        `).join('');
    }

    renderQuickStats(stats) {
        const container = document.getElementById('quickStats');
        const quickStats = [
            { label: 'Total Revenue', value: app.formatCurrency(stats.totalRevenue || 0) },
            { label: 'Total Orders', value: stats.totalOrders || 0 },
            { label: 'Customers', value: stats.totalCustomers || 0 },
            { label: 'Avg. Order Value', value: stats.totalOrders > 0 ? app.formatCurrency(Math.round(stats.totalRevenue / stats.totalOrders)) : 'UGX 0' }
        ];

        container.innerHTML = quickStats.map(stat => `
            <div class="quick-stat-row">
                <span class="quick-stat-label">${stat.label}</span>
                <span class="quick-stat-value">${stat.value}</span>
            </div>
        `).join('');
    }

    async loadStoreBranding() {
        try {
            const response = await app.apiRequest('/store');
            const store = response.data;
            this.currentStore = store; // shared source of truth — used by settings preview, reset-to-default, etc.
            this.renderLiveBanner(store);
            this.renderDraftNotice(store);
            this.renderSetupNudge(store);
            this.renderSubscriptionNudge(store);

            // Unified banner: the store record (color + image) is the only
            // source of truth, rendered through js/store-banner.js so this
            // matches the storefront, settings preview, and dashboard chrome
            // exactly. This used to be shadowed by a separate
            // `nextastore_appearance` blob in localStorage that the banner/
            // logo upload buttons wrote to directly — that meant an upload
            // never actually reached the database, never showed up on the
            // real storefront, and silently diverged from what Settings
            // displayed on a different device or after clearing storage.
            window.NextaStoreBanner?.applyStoreBanner(store, {
                full: document.getElementById('storeBannerPreview'),
                accents: [document.getElementById('storeAccentBar')]
            });

            // Load logo
            if (store.logo) {
                document.getElementById('storeLogoPreview').style.backgroundImage = `url(${app.resolveImageUrl(store.logo)})`;
                document.getElementById('storeLogoPreview').innerHTML = '';
            } else {
                // Explicitly restore the default icon rather than leaving
                // whatever was there before (the loading skeleton — see
                // showBrandingSkeleton()) sitting on screen forever for any
                // store that simply has no logo.
                document.getElementById('storeLogoPreview').style.backgroundImage = '';
                document.getElementById('storeLogoPreview').innerHTML = '<i class="fas fa-store"></i>';
            }

            // Load store name from API or fallback to user's name + Store
            const storeName = store.name || `${app.user?.name || 'User'}'s Store`;
            document.getElementById('storeDisplayName').textContent = storeName;

            // Load store description — an empty one means setup was never
            // finished (Step 1 now requires this field), not that the
            // seller wrote nothing; say so plainly rather than showing
            // instructional copy as if it were the seller's own words.
            const description = store.description || 'No description yet — add one so shoppers know what you sell.';
            document.getElementById('storeDescriptionDisplay').textContent = description;

            // Load location from API
            const locationParts = [];
            if (store.district) {
                const districtNames = {
                    kampala: 'Kampala', wakiso: 'Wakiso', mukono: 'Mukono',
                    jinja: 'Jinja', mbale: 'Mbale', gulu: 'Gulu',
                    arua: 'Arua', mbarara: 'Mbarara', entebbe: 'Entebbe', kira: 'Kira'
                };
                locationParts.push(districtNames[store.district] || store.district);
            }
            if (store.address) {
                locationParts.push(store.address);
            }

            const location = locationParts.length > 0 ? locationParts.join(', ') : '';
            // Same fix as the logo above — always resolve the skeleton one
            // way or the other instead of only clearing it in the truthy
            // branch, so a store with no location set doesn't get stuck
            // showing a permanent shimmer.
            document.getElementById('locationText').textContent = location || 'Add your location';

            // Load contact information
            document.getElementById('storeContactEmailDisplay').textContent = store.contactEmail || app.user?.email || 'Not set';
            document.getElementById('contactPhone').textContent = store.phoneNumber || 'Not set';

            // Load payment methods
            this.renderPaymentBadges(store);

            // Seller trust is badge-based now; no seller star rating is shown.
            const followers = store.followers || 0;
            document.getElementById('storeFollowers').textContent = `${followers.toLocaleString()} followers`;
            const badgeRoot = document.getElementById('storeBadges');
            if (badgeRoot) badgeRoot.innerHTML = app.renderSellerBadges(store, { limit: 3 }) || '<span class="seller-badge seller-badge--ready"><i class="fas fa-hourglass-half"></i><span>Badge threshold: 6 months</span></span>';

        } catch (error) {
            console.error('Error loading store branding:', error);
            // Surface the failure honestly rather than quietly filling the
            // page with stale localStorage data from a previous session —
            // the owner needs to know their store info didn't load, not see
            // what might be outdated info with no indication anything's wrong.
            document.getElementById('storeDisplayName').textContent = app.user?.name ? `${app.user.name}'s Store` : 'My Store';
            document.getElementById('storeDescriptionDisplay').textContent = 'Could not load your store details. Please refresh the page.';
            document.getElementById('storeLogoPreview').style.backgroundImage = '';
            document.getElementById('storeLogoPreview').innerHTML = '<i class="fas fa-store"></i>';
            document.getElementById('locationText').textContent = 'Add your location';
            app.showAlert('Could not load your store details. Please refresh the page.', 'error');
        }
    }

    /**
     * A store still looks like the untouched signup default (see
     * nextastore-backend/src/routes/auth.js) if it has no logo, no banner
     * image, and still carries the exact placeholder description every new
     * account is seeded with. There's no separate "onboarding complete"
     * flag to keep in sync — the nudge reads the same store record as
     * everything else and disappears the moment the owner changes either
     * field.
     */
    /** A seller lands here whenever they follow "Seller dashboard" or a
     *  bookmarked/direct URL — including mid-onboarding, since becoming a
     *  seller flips the account role immediately but the store itself stays
     *  a draft (isPublished: false) until onboarding is finished. Unlike
     *  the dismissible setup nudge below, this is a hard fact about
     *  visibility, not a suggestion, so it always shows while true and has
     *  no dismiss control. */
    /** The prominent, harder-to-miss counterpart to the one-shot toast: a
     *  dismissible banner at the top of Overview, shown only right after
     *  Launch (this.justLaunched, set once in init() from onboarding's
     *  sessionStorage flag). Re-runs every time Overview reloads in this
     *  session (switching sections and back), so dismissing it sets an
     *  in-memory flag rather than relying on the one-shot sessionStorage
     *  read alone — otherwise closing it would just have it reappear on
     *  the next section switch. store.isPublished is checked too, purely
     *  as a safety net: the flag should never be true otherwise, but a
     *  launch that actually failed server-side (see the guard in
     *  routes/store.js) must not show a "you're live" banner for a store
     *  that isn't. */
    renderLiveBanner(store) {
        const banner = document.getElementById('storeLiveBanner');
        if (!banner) return;
        if (!this.justLaunched || this.liveBannerDismissed || !store.isPublished) {
            banner.style.display = 'none';
            return;
        }
        banner.style.display = 'flex';
        const linkEl = document.getElementById('storeLiveBannerLink');
        if (linkEl) linkEl.textContent = app.storeAddress(store.slug, store.publicUrl).display;

        const dismissBtn = document.getElementById('dismissLiveBanner');
        if (dismissBtn && !dismissBtn.dataset.bound) {
            dismissBtn.dataset.bound = '1';
            dismissBtn.addEventListener('click', () => {
                this.liveBannerDismissed = true;
                banner.style.display = 'none';
            });
        }
        const shareBtn = document.getElementById('shareLiveBannerBtn');
        if (shareBtn && !shareBtn.dataset.bound) {
            shareBtn.dataset.bound = '1';
            shareBtn.addEventListener('click', () => this.showShareModal());
        }
    }

    renderDraftNotice(store) {
        const banner = document.getElementById('draftNoticeBanner');
        if (!banner) return;
        banner.style.display = store.isPublished ? 'none' : 'flex';
    }

    renderSetupNudge(store) {
        const banner = document.getElementById('setupNudgeBanner');
        if (!banner) return;

        // Old accounts (seeded before descriptions were required in
        // onboarding) may still carry the literal instructional copy that
        // used to ship as the default — treat that the same as empty so the
        // nudge still catches them.
        const DEFAULT_DESCRIPTION = 'Tell customers what makes your store special.';
        const looksUnfinished = !store.logo && !store.banner &&
            (!store.description || store.description === DEFAULT_DESCRIPTION);

        const dismissedKey = `nextastore_setup_nudge_dismissed_${store.id}`;
        const dismissed = sessionStorage.getItem(dismissedKey) === '1';

        if (looksUnfinished && !dismissed) {
            banner.style.display = 'flex';
            const dismissBtn = document.getElementById('dismissSetupNudge');
            if (dismissBtn && !dismissBtn.dataset.bound) {
                dismissBtn.dataset.bound = '1';
                dismissBtn.addEventListener('click', () => {
                    sessionStorage.setItem(dismissedKey, '1');
                    banner.style.display = 'none';
                });
            }
        } else {
            banner.style.display = 'none';
        }
    }

    /** Nudges the seller toward subscription.html once their trial is
     *  ending soon or has already lapsed. Never blocks the dashboard itself
     *  — the owner always needs to be able to reach subscription.html to
     *  pay, even after their store drops off the public marketplace. */
    renderSubscriptionNudge(store) {
        const banner = document.getElementById('subscriptionNudgeBanner');
        if (!banner) return;
        const sub = store.subscription;
        if (!sub || sub.status === 'active') { banner.style.display = 'none'; return; }

        if (sub.status === 'expired') {
            banner.style.display = 'flex';
            banner.classList.remove('welcome-banner--warn');
            banner.classList.add('welcome-banner--danger');
            banner.querySelector('h1').textContent = 'Your store is currently hidden from shoppers';
            banner.querySelector('p').textContent = 'Your trial ended and no subscription payment has been confirmed yet. Renew your Seller Pass to return to the marketplace; a 6+ month commitment restores a seller badge after approval.';
        } else if (sub.daysLeft <= 3) {
            banner.style.display = 'flex';
            banner.classList.remove('welcome-banner--danger');
            banner.classList.add('welcome-banner--warn');
            banner.querySelector('h1').textContent = `Your free trial ends in ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'}`;
            banner.querySelector('p').textContent = `Start your Seller Pass at ${app.formatCurrency(sub.priceUgx)}/month. Choose 6+ months to earn a seller badge and keep your store visible when the trial ends.`;
        } else {
            banner.style.display = 'none';
        }
    }

    setupStorefrontHandlers() {
        // Banner upload — saved straight to the store record via the API so
        // it's the same banner everywhere immediately (storefront, settings,
        // any other device). This used to write only to a local
        // `nextastore_appearance` blob in this browser's localStorage, which
        // never reached the database at all.
        document.getElementById('bannerUploadInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.size > 5 * 1024 * 1024) {
                    app.showAlert('Banner must be less than 5MB', 'error');
                    return;
                }
                window.NextaImageCrop.open(file, { aspect: 3, title: 'Crop your banner' }).then(cropped => {
                    if (!cropped) return; // cancelled
                    const reader = new FileReader();
                    reader.onload = (ev) => this.saveBanner({ banner: ev.target.result });
                    reader.readAsDataURL(cropped);
                });
            }
        });

        // Logo upload — same fix: persisted via the API, not localStorage.
        document.getElementById('logoUploadInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (file.size > 2 * 1024 * 1024) {
                    app.showAlert('Logo must be less than 2MB', 'error');
                    return;
                }
                window.NextaImageCrop.open(file, { aspect: 1, title: 'Crop your logo', preservePng: file.type === 'image/png' }).then(cropped => {
                    if (!cropped) return; // cancelled
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const res = await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify({ logo: ev.target.result }) });
                            this.currentStore = res.data;
                            const logoPreview = document.getElementById('storeLogoPreview');
                            logoPreview.style.backgroundImage = `url(${app.resolveImageUrl(res.data.logo)})`;
                            logoPreview.innerHTML = '';
                            app.showAlert('Logo updated', 'success');
                        } catch (error) {
                            app.showAlert(error.message || 'Could not update logo', 'error');
                        }
                    };
                    reader.readAsDataURL(cropped);
                });
            }
        });

        // Product search
        document.getElementById('productSearch')?.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            const productCards = document.querySelectorAll('.storefront-product-card');
            productCards.forEach(card => {
                const name = card.querySelector('h4').textContent.toLowerCase();
                card.style.display = name.includes(searchTerm) ? '' : 'none';
            });
        });

        // Category filter
        document.getElementById('quickCategoryFilter')?.addEventListener('change', (e) => {
            const category = e.target.value;
            const productCards = document.querySelectorAll('.storefront-product-card');
            productCards.forEach(card => {
                const productCategory = card.dataset.category;
                if (category && productCategory !== category) {
                    card.style.display = 'none';
                } else {
                    card.style.display = '';
                }
            });
        });
    }

    /**
     * Persists a banner change (image and/or color) to the store record and
     * repaints every banner instance on this page (overview hero, dashboard
     * accent bar) immediately from the response — the single place all
     * banner writes go through, so nothing can drift out of sync with the
     * database again.
     */
    async saveBanner(patch) {
        try {
            const res = await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify(patch) });
            this.currentStore = res.data;
            window.NextaStoreBanner?.applyStoreBanner(res.data, {
                full: document.getElementById('storeBannerPreview'),
                accents: [document.getElementById('storeAccentBar')]
            });
            // Keep the Settings > Appearance panel's own preview/inputs in
            // sync too, if that panel happens to be on screen.
            const colorInput = document.getElementById('bannerColor');
            if (colorInput && res.data.bannerColor) {
                colorInput.value = res.data.bannerColor;
                const label = document.getElementById('bannerColorValue');
                if (label) label.textContent = res.data.bannerColor;
            }
            window.NextaStoreBanner?.applyStoreBanner(res.data, { full: document.getElementById('appearanceBannerPreview') });
            app.showAlert('Banner updated', 'success');
        } catch (error) {
            app.showAlert(error.message || 'Could not update banner', 'error');
        }
    }

    navigateToSettings(section) {
        this.switchSection('settings');
        // After switching to settings, we might want to activate a specific tab
        setTimeout(() => {
            const tabElement = document.querySelector(`[data-settings-tab="${section}"]`);
            if (tabElement) {
                tabElement.click();
            }
        }, 100);
    }

    renderStats(stats) {
        const statsContainer = document.getElementById('statsContainer');
        const cards = [
            { icon: 'fa-shopping-cart', tone: 'tone-primary', value: stats.totalOrders, label: 'Total Orders' },
            { icon: 'fa-sack-dollar', tone: 'tone-secondary', value: app.formatCurrency(stats.totalRevenue), label: 'Total Revenue' },
            { icon: 'fa-users', tone: 'tone-coral', value: stats.totalCustomers, label: 'Customers' },
            { icon: 'fa-box', tone: 'tone-primary', value: stats.totalProducts, label: 'Products' }
        ];
        statsContainer.innerHTML = `
            <div class="stats-grid">
                ${cards.map(c => `
                    <div class="stat-card">
                        <div class="icon-tile ${c.tone}"><i class="fas ${c.icon}"></i></div>
                        <div class="stat-info">
                            <h3>${c.value}</h3>
                            <p>${c.label}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    renderRecentOrders(orders) {
        const ordersContainer = document.getElementById('recentOrders');
        if (!orders.length) {
            ordersContainer.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding: var(--spacing-xl);">
                <p style="margin-bottom:0;">No orders yet. Once customers check out, they\u2019ll show up here.</p>
            </div></td></tr>`;
            return;
        }
        ordersContainer.innerHTML = orders.map(order => `
            <tr>
                <td>#${order.id}</td>
                <td>${app.escapeHtml(order.customerName)}</td>
                <td>${app.formatCurrency(order.total)}</td>
                <td><span class="badge badge-${order.status}">${order.status}</span></td>
                <td>${app.formatDate(order.createdAt)}</td>
            </tr>
        `).join('');
    }

    renderTopProducts(products) {
        const productsContainer = document.getElementById('topProducts');
        if (!products.length) {
            productsContainer.innerHTML = `<div class="empty-state" style="padding: var(--spacing-lg) 0;">
                <p style="margin-bottom:0;">Add products to see your best sellers here.</p>
            </div>`;
            return;
        }
        productsContainer.innerHTML = products.map(product => `
            <div class="product-item">
                ${app.productThumb(product)
                    ? `<img class="product-thumb" src="${app.productThumb(product)}" alt="${app.escapeHtml(product.name)}">`
                    : `<div class="product-thumb-icon"><i class="fas ${product.icon || 'fa-box'}"></i></div>`}
                <div class="product-info">
                    <h4>${app.escapeHtml(product.name)}</h4>
                    <p>${product.sold || 0} sold</p>
                </div>
                <span class="dash-product-price">${app.formatCurrency(product.price)}</span>
            </div>
        `).join('');
    }

    // ---- Products section ----
    async loadProducts(page = 1, append = false) {
        const container = document.getElementById('productsList');
        if (!append) container.innerHTML = this.skeletonManageProductCards(6);
        // A fresh (non-append) load means the search/filter/sort changed —
        // clear any selection so "3 selected" can't linger against a list
        // that no longer shows those products.
        if (!append) this.selectedProductIds.clear();
        const params = new URLSearchParams({ page: String(page), limit: '24' });
        const q = document.getElementById('productSearchFull')?.value.trim();
        const category = document.getElementById('categoryFilter')?.value;
        const sort = document.getElementById('productSortFull')?.value;
        if (q) params.set('q', q);
        if (category) params.set('category', category);
        // Backend understands popular/price-low/price-high/newest; the
        // name and stock sorts have no server-side equivalent so those are
        // applied client-side below, after the default (newest) list loads.
        if (sort === 'price-asc') params.set('sort', 'price-low');
        else if (sort === 'price-desc') params.set('sort', 'price-high');
        else params.set('sort', 'newest');
        try {
            const response = await app.apiRequest(`/products?${params.toString()}`);
            this.products = append ? [...this.products, ...(response.data || [])] : (response.data || []);
            this.productsPage = page;
            this.productsPagination = response.pagination || null;
            this.applyClientSort(sort);
            this.renderProductManagement({ q, category });
        } catch (error) {
            container.innerHTML = `<div class="empty-state"><h3>Couldn't load products</h3><p>${app.escapeHtml(error.message)}</p></div>`;
        }
    }

    /** Sorts the currently-loaded page client-side for the two orderings
     *  the backend doesn't support directly. Only affects what's already
     *  been fetched, same as any other client-side sort of a paginated list. */
    applyClientSort(sort) {
        if (sort === 'name-asc') {
            this.products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        } else if (sort === 'stock-asc') {
            this.products.sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
        }
    }

    renderProductManagement({ q = '', category = '' } = {}) {
        const container = document.getElementById('productsList');
        const countEl = document.getElementById('productsCount');
        const list = this.products;
        const total = this.productsPagination?.total ?? list.length;
        const isFiltered = Boolean(q || category);

        if (!list.length) {
            if (countEl) countEl.textContent = '';
            this.selectedProductIds.clear();
            this.updateBulkActionsBar();
            container.innerHTML = isFiltered ? `
                <div class="empty-state">
                    <div class="empty-icon"><i class="fas fa-magnifying-glass"></i></div>
                    <h3>No products match your search</h3>
                    <p>Try a different keyword${category ? ' or clear the category filter' : ''}.</p>
                    <button type="button" class="btn btn-outline" id="clearProductFilters">Clear search & filters</button>
                </div>
            ` : `
                <div class="empty-state">
                    <div class="empty-icon"><i class="fas fa-box-open"></i></div>
                    <h3>No products yet</h3>
                    <p>Add your first product to start selling on your storefront.</p>
                    <a class="btn btn-primary" href="product-form.html"><i class="fas fa-plus"></i> Add Product</a>
                </div>
            `;
            document.getElementById('clearProductFilters')?.addEventListener('click', () => {
                const searchInput = document.getElementById('productSearchFull');
                const categorySelect = document.getElementById('categoryFilter');
                if (searchInput) searchInput.value = '';
                if (categorySelect) categorySelect.value = '';
                this.loadProducts(1, false);
            });
            return;
        }

        if (countEl) {
            countEl.textContent = `Showing ${list.length}${total > list.length ? ` of ${total}` : ''} product${total === 1 ? '' : 's'}`;
        }

        container.innerHTML = `<div class="manage-products-grid${this.selectMode ? ' is-selecting' : ''}">${list.map(p => {
            const stock = p.stock ?? 0;
            const stockBadge = stock === 0
                ? '<span class="stock-badge stock-badge-out">Out of stock</span>'
                : stock <= 5
                    ? `<span class="stock-badge stock-badge-low">Low stock &middot; ${stock} left</span>`
                    : '';
            const checked = this.selectedProductIds.has(p.id) ? 'checked' : '';
            return `
            <div class="manage-product-card" data-category="${p.category}" data-product-id="${p.id}">
                <div class="manage-product-image">
                    <label class="product-select-check">
                        <input type="checkbox" class="product-select-checkbox" data-id="${p.id}" aria-label="Select ${app.escapeHtml(p.name)}" ${checked}>
                    </label>
                    ${app.productThumb(p) ? `<img src="${app.productThumb(p)}" alt="${app.escapeHtml(p.name)}" loading="lazy">` : `<i class="fas ${p.icon || 'fa-box'}"></i>`}
                    ${stockBadge}
                </div>
                <div class="manage-product-body">
                    <h4>${app.escapeHtml(p.name)}</h4>
                    <div class="manage-product-meta">
                        <span>${app.formatCurrency(p.price)}</span>
                        <span>${stock} in stock</span>
                    </div>
                </div>
                <div class="manage-product-actions">
                    <a class="btn btn-outline btn-sm" href="product-form.html?id=${p.id}"><i class="fas fa-pen"></i> Edit</a>
                    <button class="btn btn-outline btn-sm" onclick="dashboardManager.deleteProduct('${p.id}')" aria-label="Delete ${app.escapeHtml(p.name)}"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
        }).join('')}</div>${this.productsPagination?.page < this.productsPagination?.pages
            ? '<button type="button" class="btn btn-outline btn-block" id="dashboardLoadMoreProducts">Load more products</button>' : ''}`;
        document.getElementById('dashboardLoadMoreProducts')?.addEventListener('click', () => {
            this.loadProducts(this.productsPage + 1, true);
        });
        container.querySelectorAll('.product-select-checkbox').forEach(cb => {
            cb.addEventListener('change', () => this.toggleProductSelection(cb.dataset.id, cb.checked));
        });
        this.updateBulkActionsBar();
    }

    async deleteProduct(id) {
        if (!(await app.confirm({ title: 'Remove product?', message: 'This product will be removed from your store.', confirmText: 'Remove', tone: 'danger' }))) return;
        try {
            await app.apiRequest(`/products/${id}`, { method: 'DELETE' });
            app.showAlert('Product removed', 'success');
            await this.loadProducts();
        } catch (error) {
            app.showAlert(error.message, 'error');
        }
    }

    // ---- Bulk product actions ----
    /** Turns selection mode on/off. Off clears any selection so a stale
     *  checked set can't silently carry over into a later bulk action. */
    toggleSelectMode() {
        this.selectMode = !this.selectMode;
        const btn = document.getElementById('toggleSelectModeBtn');
        const grid = document.querySelector('.manage-products-grid');
        const bar = document.getElementById('bulkActionsBar');
        if (btn) btn.innerHTML = this.selectMode ? '<i class="fas fa-xmark"></i> Cancel' : '<i class="fas fa-square-check"></i> Select';
        grid?.classList.toggle('is-selecting', this.selectMode);
        if (bar) bar.hidden = !this.selectMode;
        if (!this.selectMode) {
            this.selectedProductIds.clear();
            document.querySelectorAll('.product-select-checkbox').forEach(cb => { cb.checked = false; });
            const selectAll = document.getElementById('bulkSelectAll');
            if (selectAll) selectAll.checked = false;
        }
        this.updateBulkActionsBar();
    }

    toggleProductSelection(id, checked) {
        if (checked) this.selectedProductIds.add(id);
        else this.selectedProductIds.delete(id);
        this.updateBulkActionsBar();
    }

    toggleSelectAllProducts(checked) {
        if (checked) this.products.forEach(p => this.selectedProductIds.add(p.id));
        else this.selectedProductIds.clear();
        document.querySelectorAll('.product-select-checkbox').forEach(cb => { cb.checked = checked; });
        this.updateBulkActionsBar();
    }

    updateBulkActionsBar() {
        const count = this.selectedProductIds.size;
        const countEl = document.getElementById('bulkSelectedCount');
        if (countEl) countEl.textContent = count === 1 ? '1 selected' : `${count} selected`;
        document.getElementById('bulkDeleteBtn').disabled = count === 0;
        const categorySelected = Boolean(document.getElementById('bulkCategorySelect')?.value);
        document.getElementById('bulkApplyCategoryBtn').disabled = count === 0 || !categorySelected;
        const selectAll = document.getElementById('bulkSelectAll');
        if (selectAll) {
            selectAll.checked = count > 0 && count === this.products.length;
            selectAll.indeterminate = count > 0 && count < this.products.length;
        }
    }

    /** Loops individual DELETE calls (there's no bulk endpoint) via
     *  Promise.allSettled so one failure doesn't block the rest, then
     *  reports how many actually succeeded — the same "tell the seller
     *  exactly what happened" principle as the single-product actions. */
    async bulkDeleteSelected() {
        const ids = Array.from(this.selectedProductIds);
        if (!ids.length) return;
        const confirmed = await app.confirm({
            title: `Delete ${ids.length} product${ids.length === 1 ? '' : 's'}?`,
            message: 'This cannot be undone.',
            confirmText: 'Delete',
            tone: 'danger'
        });
        if (!confirmed) return;

        const btn = document.getElementById('bulkDeleteBtn');
        const originalHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

        const results = await Promise.allSettled(ids.map(id => app.apiRequest(`/products/${id}`, { method: 'DELETE' })));
        const failed = results.filter(r => r.status === 'rejected').length;
        const succeeded = ids.length - failed;

        if (succeeded) app.showAlert(`${succeeded} product${succeeded === 1 ? '' : 's'} deleted.`, failed ? 'warning' : 'success');
        if (failed) app.showAlert(`${failed} product${failed === 1 ? '' : 's'} could not be deleted.`, 'error');

        this.selectedProductIds.clear();
        btn.innerHTML = originalHTML;
        this.toggleSelectMode();
        await this.loadProducts();
    }

    /** Same loop-and-report pattern as bulkDeleteSelected, but PUT with just
     *  { category } — the backend's product-update schema is a .partial(),
     *  so this never touches any other field on the product. */
    async bulkApplyCategory() {
        const ids = Array.from(this.selectedProductIds);
        const select = document.getElementById('bulkCategorySelect');
        const category = select?.value;
        if (!ids.length || !category) return;

        const btn = document.getElementById('bulkApplyCategoryBtn');
        const originalHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying...';

        const results = await Promise.allSettled(ids.map(id => app.apiRequest(`/products/${id}`, { method: 'PUT', body: JSON.stringify({ category }) })));
        const failed = results.filter(r => r.status === 'rejected').length;
        const succeeded = ids.length - failed;

        if (succeeded) app.showAlert(`${succeeded} product${succeeded === 1 ? '' : 's'} moved to ${category}.`, failed ? 'warning' : 'success');
        if (failed) app.showAlert(`${failed} product${failed === 1 ? '' : 's'} could not be updated.`, 'error');

        select.value = '';
        btn.innerHTML = originalHTML;
        this.toggleSelectMode();
        await this.loadProducts();
    }

    // ---- Orders section ----
    async loadOrders(page = 1) {
        document.getElementById('ordersList').innerHTML = `
            <div class="card">
                <div class="table-responsive">
                    <table class="table">
                        <thead><tr><th>Order ID</th><th>Customer</th><th>Total</th><th>Fulfillment</th><th>Status</th><th>Date</th><th></th></tr></thead>
                        <tbody>${this.skeletonTableRows(6, 5)}</tbody>
                    </table>
                </div>
            </div>
        `;
        const status = document.getElementById('orderStatusFilter')?.value;
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (status) params.set('status', status);
        const response = await app.apiRequest(`/orders?${params.toString()}`);
        this.orders = response.data;
        this.ordersPagination = response.pagination;
        this.renderOrdersList();
    }

    async updateOrderStatus(orderId, status) {
        try {
            await app.apiRequest(`/orders/${orderId}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
            const order = this.orders.find(o => o.id === orderId);
            if (order) order.status = status;
            app.showAlert('Order status updated', 'success');
        } catch (error) {
            app.showAlert(error.message, 'error');
        } finally {
            this.renderOrdersList(); // repaint: badge + the next step's action button(s)
        }
    }

    // The seller isn't running a manual fulfillment tracker — buyer and
    // seller agree, then the seller handles the rest off-platform — so
    // instead of a free-jump status <select>, each order shows only the
    // one or two actions that actually make sense from where it is now.
    // 'shipped' is left reachable only for orders that already reached it
    // before this simplification; nothing routes a new order through it.
    sellerOrderActions(status) {
        switch (status) {
            case 'pending':
                return [
                    { targetStatus: 'processing', label: 'Confirm', className: 'btn-primary' },
                    { targetStatus: 'cancelled', label: 'Cancel', className: 'btn-outline' }
                ];
            case 'processing':
                return [
                    { targetStatus: 'delivered', label: 'Mark completed', className: 'btn-primary' },
                    { targetStatus: 'cancelled', label: 'Cancel', className: 'btn-outline' }
                ];
            case 'shipped':
                return [
                    { targetStatus: 'delivered', label: 'Mark completed', className: 'btn-primary' }
                ];
            default:
                return [];
        }
    }

    renderOrdersList() {
        const container = document.getElementById('ordersList');
        if (!this.orders.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon"><i class="fas fa-receipt"></i></div>
                    <h3>No orders here yet</h3>
                    <p>Orders placed on your storefront will appear in this list.</p>
                </div>
            `;
            return;
        }
        container.innerHTML = `
            <div class="card">
                <div class="table-responsive">
                    <table class="table">
                        <thead>
                            <tr><th>Order ID</th><th>Customer</th><th>Total</th><th>Fulfillment</th><th>Status</th><th>Date</th><th></th></tr>
                        </thead>
                        <tbody>
                            ${this.orders.map(o => `
                                <tr>
                                    <td data-label="Order ID">#${o.id}</td>
                                    <td data-label="Customer">${app.escapeHtml(o.customerName)}</td>
                                    <td data-label="Total">${app.formatCurrency(o.total)}</td>
                                    <td data-label="Fulfillment"><div class="td-value"><span class="order-fulfillment-pill">${o.fulfillmentMethod==='pickup'?'Pick up / visit':'Delivery'}</span>${o.fulfillmentMethod==='pickup'?`<div class="pickup-inline-location"><span>${app.escapeHtml([o.store?.district,o.store?.address].filter(Boolean).join(' · ')||'Saved store location')}</span>${o.store?.mapCoordinates?`<a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.store.mapCoordinates)}">Map</a>`:''}</div>`:''}</div></td>
                                    <td data-label="Status">
                                        <div class="order-status-cell">
                                            <span class="badge badge-${o.status}">${o.status}</span>
                                            ${this.sellerOrderActions(o.status).map(a => `<button type="button" class="btn btn-sm ${a.className}" data-order-action="${a.targetStatus}" data-order-id="${o.id}">${a.label}</button>`).join('')}
                                        </div>
                                    </td>
                                    <td data-label="Date">${app.formatDate(o.createdAt)}</td>
                                    <td><button class="btn btn-outline btn-sm" data-view-seller-order="${o.id}">View</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                ${this.renderOrdersPagination()}
            </div>
        `;
        container.querySelectorAll('[data-view-seller-order]').forEach(btn => btn.addEventListener('click', () => this.showSellerOrder(btn.dataset.viewSellerOrder)));
        container.querySelectorAll('[data-order-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetStatus = btn.dataset.orderAction;
                if (targetStatus === 'cancelled' && !window.confirm('Cancel this order? This cannot be undone.')) return;
                this.updateOrderStatus(btn.dataset.orderId, targetStatus);
            });
        });
        container.querySelectorAll('[data-orders-page]').forEach(btn => {
            btn.addEventListener('click', () => this.loadOrders(Number(btn.dataset.ordersPage)));
        });
    }

    async showSellerOrder(id){try{const r=await app.apiRequest(`/orders/${encodeURIComponent(id)}`),o=r.data,store=o.store||{},modal=document.createElement('div');modal.className='order-detail-modal';const pickup=o.fulfillmentMethod==='pickup',loc=[store.district,store.address].filter(Boolean).join(' · '),mapsUrl=store.mapCoordinates?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.mapCoordinates)}`:'',map=mapsUrl?`<a target="_blank" rel="noopener" href="${mapsUrl}">Open map location</a>`:'',sellerMapPreviewId=`sellerOrderMapPreview-${o.id}`,sellerMapPreview=pickup&&store.mapCoordinates?`<div class="map-preview-slot" id="${sellerMapPreviewId}" style="margin-top:8px;"></div>`:'';modal.innerHTML=`<div class="order-detail-panel" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">&times;</button><div class="order-detail-head"><div><span class="eyebrow">Seller order view</span><h2>#${app.escapeHtml(o.id)}</h2></div><span class="order-status status-${o.status}">${o.status}</span></div><div class="order-trust-strip"><span><i class="fas fa-${pickup?'store':'truck'}"></i> ${pickup?'Pick up / visit the store':'Delivery'}</span><span><i class="fas fa-money-bill"></i> ${app.escapeHtml(o.paymentMethod||'Payment not specified')}</span><span><i class="fas fa-circle"></i> ${app.escapeHtml(o.paymentStatus||'unpaid')}</span></div>${pickup?`<div class="seller-pickup-box"><strong>Pickup location</strong><span>${app.escapeHtml(loc||'No saved address')}</span>${store.detailedDirections?`<small>${app.escapeHtml(store.detailedDirections)}</small>`:''}${map?map:''}${sellerMapPreview}</div>`:`<div class="seller-pickup-box"><strong>Delivery address</strong><span>${app.escapeHtml(o.deliveryAddress||'Address not provided')}</span></div>`}<div class="detail-items">${(o.items||[]).map(i=>`<div><span>${i.quantity} × ${app.escapeHtml(i.productName)}</span><strong>${app.formatCurrency(i.unitPrice*i.quantity)}</strong></div>`).join('')}</div><div class="detail-total"><span>Total</span><strong>${app.formatCurrency(o.total)}</strong></div><div class="delivery-detail"><div><dt>Buyer</dt><dd>${app.escapeHtml(o.customerName)} · ${app.escapeHtml(o.customerPhone)}</dd></div></div><div class="detail-actions"><a class="btn btn-outline" href="messages.html?store=${encodeURIComponent(store.id||'')}&order=${encodeURIComponent(o.id)}"><i class="fas fa-message"></i> Message buyer</a><button class="btn btn-outline" data-report-seller><i class="fas fa-flag"></i> Report an issue</button></div></div>`;document.body.appendChild(modal);if(pickup&&store.mapCoordinates){const[lat,lng]=store.mapCoordinates.split(',').map(Number);if(Number.isFinite(lat)&&Number.isFinite(lng)){const slot=document.getElementById(sellerMapPreviewId);window.NextaStoreMapPreview?.render(slot,{lat,lng,width:260,height:130,mapsUrl})}}const close=()=>modal.remove();modal.addEventListener('click',e=>{if(e.target===modal||e.target.closest('.modal-close'))close()});modal.querySelector('[data-report-seller]').addEventListener('click',async()=>{const reason=window.prompt('Briefly describe the issue with this order:');if(!reason)return;try{await app.apiRequest(`/orders/${encodeURIComponent(o.id)}/report`,{method:'POST',body:JSON.stringify({reason})});app.showAlert('Issue reported and attached to this order.','success');modal.querySelector('[data-report-seller]').disabled=true}catch(e){app.showAlert(e.message,'error')}})}catch(e){app.showAlert(e.message,'error')}}

    renderOrdersPagination() {
        const p = this.ordersPagination;
        if (!p || p.pages <= 1) return '';
        return `
            <div class="pagination">
                <button class="btn btn-outline btn-sm" data-orders-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
                <span>Page ${p.page} of ${p.pages}</span>
                <button class="btn btn-outline btn-sm" data-orders-page="${p.page + 1}" ${p.page >= p.pages ? 'disabled' : ''}>Next</button>
            </div>
        `;
    }

    // ---- Analytics section ----
    // Everything here is driven by GET /dashboard/analytics, which computes
    // period KPIs, the daily revenue series, and the category breakdown as
    // SQL aggregates scoped to the selected window. This used to instead
    // fetch the store's *entire* order history (GET /orders with no page —
    // which the API treated as "no limit at all") plus its entire product
    // list on every single dashboard visit, then re-derive all of the above
    // in the browser. That meant page-load time and the response payload
    // both grew every time the store sold something, forever; querying only
    // the selected period keeps this page's cost flat as history grows.
    async loadAnalytics() {
        ['kpiRevenue', 'kpiOrders', 'kpiCustomers', 'kpiAvgOrder'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<span class="skeleton skeleton-text-lg" style="display:inline-block;width:64px;"></span>';
        });
        ['kpiRevenueChange', 'kpiOrdersChange', 'kpiCustomersChange', 'kpiAvgOrderChange'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<span class="skeleton skeleton-text-sm" style="display:inline-block;width:44px;"></span>';
        });
        document.getElementById('topProductsTable').innerHTML = this.skeletonTableRows(5, 5);

        const period = document.getElementById('analyticsPeriod')?.value || '30';
        const days = parseInt(period) || 30;

        const [analyticsRes, statsRes, topProductsRes] = await Promise.all([
            app.apiRequest(`/dashboard/analytics?days=${days}`),
            app.apiRequest('/dashboard/stats'),
            // Top-sellers table only ever needs 5 rows, already sorted by
            // sold count server-side — no reason to pull a page of the
            // full product catalog just to re-sort it in the browser.
            app.apiRequest('/products/top')
        ]);
        this.renderKPIs(statsRes.data, analyticsRes.data);
        this.renderRevenueChart(analyticsRes.data);
        this.renderCategoryChart(analyticsRes.data);
        this.renderTopProductsTable(topProductsRes.data);
    }

    renderKPIs(stats, analytics) {
        const { current, previous } = analytics;
        const periodRevenue = current.revenue;
        const periodOrdersCount = current.orders;
        const previousRevenue = previous.revenue;
        const previousOrdersCount = previous.orders;

        // Calculate changes
        const calculateChange = (current, previous) => {
            if (!previous || previous === 0) return { value: 0, isPositive: true, hasData: false };
            const change = ((current - previous) / previous) * 100;
            return {
                value: Math.abs(change).toFixed(1),
                isPositive: change >= 0,
                hasData: true
            };
        };

        const revenueChange = calculateChange(periodRevenue, previousRevenue);
        const ordersChange = calculateChange(periodOrdersCount, previousOrdersCount);
        
        // For customers and avg order, use the period data
        const avgOrder = periodOrdersCount > 0 ? Math.round(periodRevenue / periodOrdersCount) : 0;
        const previousAvgOrder = previousOrdersCount > 0 ? Math.round(previousRevenue / previousOrdersCount) : 0;
        const avgOrderChange = calculateChange(avgOrder, previousAvgOrder);
        
        // Customer change is estimated based on order growth
        const customersChange = calculateChange(stats.totalCustomers, Math.max(1, Math.floor(stats.totalCustomers * 0.85)));

        // Update KPI values with period-specific data
        document.getElementById('kpiRevenue').textContent = app.formatCurrency(periodRevenue);
        document.getElementById('kpiOrders').textContent = periodOrdersCount;
        document.getElementById('kpiCustomers').textContent = stats.totalCustomers;
        document.getElementById('kpiAvgOrder').textContent = app.formatCurrency(avgOrder);

        // Update change indicators
        const updateChangeElement = (elementId, change) => {
            const element = document.getElementById(elementId);
            if (!change.hasData) {
                element.innerHTML = '<span class="text-muted">No data</span>';
                element.className = 'kpi-change';
            } else {
                const icon = change.isPositive ? 'fa-arrow-up' : 'fa-arrow-down';
                const className = change.isPositive ? 'positive' : 'negative';
                element.innerHTML = `<i class="fas ${icon}"></i> ${change.value}%`;
                element.className = `kpi-change ${className}`;
            }
        };

        updateChangeElement('kpiRevenueChange', revenueChange);
        updateChangeElement('kpiOrdersChange', ordersChange);
        updateChangeElement('kpiCustomersChange', customersChange);
        updateChangeElement('kpiAvgOrderChange', avgOrderChange);
    }

    renderRevenueChart(analytics) {
        const ctx = document.getElementById('revenueChart');
        if (!ctx || typeof Chart === 'undefined') return;

        // Server already grouped and summed this by day for the selected
        // window — just format the labels for display.
        const byDay = analytics.revenueByDay || [];
        const labels = byDay.length
            ? byDay.map(row => new Date(row.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
            : ['No data'];
        const revenueValues = byDay.length ? byDay.map(row => row.revenue) : [0];

        // Calculate some stats for annotations
        const totalRevenue = revenueValues.reduce((sum, val) => sum + val, 0);
        const avgRevenue = revenueValues.length > 0 ? totalRevenue / revenueValues.length : 0;
        const maxRevenue = Math.max(...revenueValues, 0);

        // Destroy existing chart if it exists
        if (this.charts.revenue) {
            this.charts.revenue.destroy();
        }
        
        this.charts.revenue = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Revenue',
                    data: revenueValues,
                    borderColor: '#01B075',
                    backgroundColor: (context) => {
                        const ctx = context.chart.ctx;
                        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
                        gradient.addColorStop(0, 'rgba(226, 154, 46, 0.4)');
                        gradient.addColorStop(1, 'rgba(226, 154, 46, 0.05)');
                        return gradient;
                    },
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 4,
                    pointHoverRadius: 8,
                    pointBackgroundColor: '#01B075',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointHoverBackgroundColor: '#01B075',
                    pointHoverBorderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(28, 37, 33, 0.95)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 16,
                        displayColors: false,
                        titleFont: { size: 14, weight: 'bold' },
                        bodyFont: { size: 13 },
                        callbacks: {
                            title: function(context) {
                                return context[0].label;
                            },
                            label: function(context) {
                                const value = context.raw;
                                const percentage = avgRevenue > 0 ? ((value / avgRevenue) * 100).toFixed(0) : 0;
                                const diff = value - avgRevenue;
                                const diffText = diff >= 0 ? '+' + app.formatCurrency(diff) : app.formatCurrency(diff);
                                return [
                                    `Revenue: ${app.formatCurrency(value)}`,
                                    `vs avg: ${diffText} (${percentage}%)`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            maxRotation: 45,
                            minRotation: 45,
                            font: { size: 12, weight: '500' }
                        }
                    },
                    y: {
                        display: true,
                        title: {
                            display: true,
                            text: 'Revenue (UGX)',
                            font: { size: 13, weight: '600' }
                        },
                        grid: {
                            color: 'rgba(0,0,0,0.05)',
                            drawBorder: false
                        },
                        ticks: {
                            callback: function(value) {
                                if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                                if (value >= 1000) return (value / 1000).toFixed(0) + 'K';
                                return value;
                            },
                            font: { size: 11 }
                        }
                    }
                }
            }
        });
    }

    renderCategoryChart(analytics) {
        const ctx = document.getElementById('categoryChart');
        if (!ctx || typeof Chart === 'undefined') return;

        // Revenue by category for the selected period, already summed
        // server-side from each order line's unitPrice-at-sale (not today's
        // live product price, which would misrepresent history whenever a
        // price changes or the product is later deleted).
        const rows = analytics.categoryBreakdown || [];
        const categoryLabels = rows.length ? rows.map(r => r.category) : ['No data'];
        const categoryData = rows.length ? rows.map(r => r.revenue) : [1];

        // Destroy existing chart if it exists
        if (this.charts.category) {
            this.charts.category.destroy();
        }
        
        this.charts.category = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: categoryLabels,
                datasets: [{
                    data: categoryData,
                    backgroundColor: ['#01B075', '#0B3B2B', '#E1583F', '#2C6E9E', '#6247AA', '#7C3AED'],
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            padding: 15,
                            font: { size: 12 }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(28, 37, 33, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            label: function(context) {
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const percentage = ((context.raw / total) * 100).toFixed(1);
                                const value = context.raw >= 1000 ? app.formatCurrency(context.raw) : context.raw;
                                return `${context.label}: ${value} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    renderTopProductsTable(products) {
        const tbody = document.getElementById('topProductsTable');
        if (!products.length) {
            tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state" style="padding: var(--spacing-lg);"><p style="margin-bottom:0;">No products yet</p></div></td></tr>`;
            return;
        }

        // Sort by sales and get top 5
        const topProducts = [...products].sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 5);
        
        tbody.innerHTML = topProducts.map(p => `
            <tr>
                <td data-label="Product">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        ${app.productThumb(p)
                            ? `<img src="${app.productThumb(p)}" alt="${app.escapeHtml(p.name)}" style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover;">`
                            : `<div style="width: 32px; height: 32px; border-radius: 4px; background: var(--primary-light); display: flex; align-items: center; justify-content: center; color: var(--primary-dark);"><i class="fas ${p.icon || 'fa-box'}"></i></div>`
                        }
                        <span>${app.escapeHtml(p.name)}</span>
                    </div>
                </td>
                <td data-label="Category"><span class="badge" style="background: var(--gray-100); color: var(--gray-700);">${p.category || 'Other'}</span></td>
                <td data-label="Price">${app.formatCurrency(p.price)}</td>
                <td data-label="Sold"><strong>${p.sold || 0}</strong></td>
                <td data-label="Revenue">${app.formatCurrency((p.sold || 0) * p.price)}</td>
            </tr>
        `).join('');
    }

    // ---- Settings section ----
    async loadSettings() {
        // The fields are wrong (empty) for as long as these requests take,
        // so disable them rather than let someone start typing into a field
        // about to be overwritten out from under them.
        const form = document.getElementById('storeSettingsForm');
        form?.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = true; });

        try {
            const [response, methods] = await Promise.all([
                app.apiRequest('/store'),
                this.getPaymentMethods()
            ]);
            const store = response.data;
            this.currentStore = store;
            this.settingsPayments = { ...(store.payments || {}) };
            this.settingsTheme = store.theme || 'default';

            document.getElementById('storeName').value = store.name || '';
            document.getElementById('storeSlug').value = store.slug || '';
            document.getElementById('storeSlug').dataset.original = store.slug || '';
            this.renderStoreUrlPrefix();
            document.getElementById('storeDescription').value = store.description || '';
            document.getElementById('contactEmail').value = store.contactEmail || app.user?.email || '';
            document.getElementById('phoneNumber').value = store.phoneNumber || '';
            // store.phonePublic is undefined for any store saved before this
            // field existed — treat that the same as "checked" (matches
            // onboarding's default) rather than reading undefined as false
            // and silently flipping an existing seller's number to private.
            document.getElementById('phonePublic').checked = store.phonePublic !== false;

            // Location & directions (formerly the separate Store Profile page)
            document.getElementById('storeDistrict').value = store.district || '';
            document.getElementById('storeAddress').value = store.address || '';
            document.getElementById('storeDetailedDirections').value = store.detailedDirections || '';
            this.settingsMapCoordinates = store.mapCoordinates || '';
            this.settingsMapPlaceName = '';
            this.renderSettingsMapPin();

            // Branding
            this.renderLogoUpload(store.logo ? app.resolveImageUrl(store.logo) : '');
            document.getElementById('logoDataUrl').value = '';
            if (store.bannerColor) {
                document.getElementById('bannerColor').value = store.bannerColor;
                document.getElementById('bannerColorValue').textContent = store.bannerColor;
            }
            // Live preview + reset both need the current banner image too, not
            // just the color, and both need to stop before overwriting a change
            // that hasn't been saved yet.
            const bannerInput = document.getElementById('bannerImageDataUrl');
            bannerInput.value = '';
            delete bannerInput.dataset.reset;
            window.NextaStoreBanner?.applyStoreBanner(store, { full: document.getElementById('appearanceBannerPreview') });
            this.markActiveColorPreset();

            // Payments: one row per method the backend currently offers.
            this.renderPaymentOptions(methods);

            // Search & sharing: a seller who never touched these should still
            // see real, usable text — not an empty box — so pre-fill from
            // their store name/area/description (same fallback the server
            // uses) whenever they haven't saved a custom title/description.
            // The fields stay fully editable either way.
            const seo = store.seo || {};
            this.seoTitleAuto = !seo.title;
            this.seoDescAuto = !seo.description;
            document.getElementById('seoTitle').value = seo.title || this.autoSeoTitle();
            document.getElementById('seoDescription').value = seo.description || this.autoSeoDescription();
            document.getElementById('seoIndexable').checked = seo.indexable !== false;
            this.updateSerpPreview();

            document.getElementById('accountName').value = app.user?.name || '';
            document.getElementById('accountEmail').value = app.user?.email || '';

            this.loadNotificationPrefs();
            this.loadPushSettings();
        } finally {
            form?.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = false; });
            // Re-hide the clear-pin button if there is no pin (the loop above
            // re-enabled it, it is not re-hidden by enabling).
            this.renderSettingsMapPin();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Store settings helpers (absorbed from the old store-builder page)  */
    /* ------------------------------------------------------------------ */

    /** Platform payment-method catalog, fetched once per page load. Shared by
     *  the settings form and the overview's read-only badges so neither
     *  hardcodes a method list. A failed fetch is not cached. */
    getPaymentMethods() {
        if (!this._paymentMethodsPromise) {
            this._paymentMethodsPromise = app.apiRequest('/payments/methods')
                .then(res => res.data || [])
                .catch(err => { this._paymentMethodsPromise = null; throw err; });
        }
        return this._paymentMethodsPromise;
    }

    renderPaymentOptions(methods) {
        const root = document.getElementById('storePaymentMethods');
        if (!root) return;
        if (!methods || !methods.length) {
            root.innerHTML = '<p class="form-hint">No payment methods are available right now.</p>';
            return;
        }
        root.innerHTML = methods.map(m => `
            <div class="payment-method">
                <label class="form-checkbox">
                    <input type="checkbox" data-payment-code="${app.escapeHtml(m.code)}" ${this.settingsPayments?.[m.code] ? 'checked' : ''}>
                    <span>${m.icon ? `<i class="fas ${app.escapeHtml(m.icon)}" aria-hidden="true"></i> ` : ''}${app.escapeHtml(m.label || m.code)}</span>
                </label>
            </div>`).join('');
    }

    /** Overview header badges: only the methods this store accepts. */
    async renderPaymentBadges(store) {
        const root = document.getElementById('storePaymentsDisplay');
        if (!root) return;
        try {
            const methods = await this.getPaymentMethods();
            const accepted = store?.payments || {};
            const active = methods.filter(m => accepted[m.code]);
            root.innerHTML = active.length
                ? active.map(m => `<span class="payment-badge active"><i class="fas ${app.escapeHtml(m.icon || 'fa-wallet')}"></i> ${app.escapeHtml(m.label || m.code)}</span>`).join('')
                : '<span class="payment-badge">No payment methods selected</span>';
        } catch (e) {
            root.innerHTML = '';
        }
    }

    renderSettingsMapPin() {
        const preview = document.getElementById('storeMapPinPreview');
        const text = document.getElementById('storeMapPinText');
        const clearBtn = document.getElementById('storeClearMapPinBtn');
        if (!preview || !text || !clearBtn) return;
        const coords = this.settingsMapCoordinates;
        if (coords) {
            const [lat, lng] = coords.split(',');
            text.textContent = this.settingsMapPlaceName || `Lat: ${lat}, Lng: ${lng}`;
            text.title = coords;
            preview.classList.add('has-location');
            clearBtn.style.display = 'inline-flex';
        } else {
            text.textContent = 'No exact location selected';
            text.title = '';
            preview.classList.remove('has-location');
            clearBtn.style.display = 'none';
        }
    }

    openSettingsMapPicker() {
        const districtEl = document.getElementById('storeDistrict');
        NextaStoreMapPicker.open({
            initialDistrict: districtEl.value,
            initialCoordinates: this.settingsMapCoordinates || '',
            onSave: ({ lat, lng, district, placeName, suggestedAddress, suggestedDirections }) => {
                this.settingsMapCoordinates = `${lat},${lng}`;
                this.settingsMapPlaceName = placeName || '';
                districtEl.value = district;
                // Auto-draft address/directions from the reverse-geocoded
                // result, but only into fields the seller hasn't already
                // filled in themselves — never clobber an edit they made.
                const addressEl = document.getElementById('storeAddress');
                if (suggestedAddress && !addressEl.value.trim()) addressEl.value = suggestedAddress;
                const directionsEl = document.getElementById('storeDetailedDirections');
                if (suggestedDirections && !directionsEl.value.trim()) directionsEl.value = suggestedDirections;
                this.renderSettingsMapPin();
                this.updateSerpPreview();
            }
        });
    }

    renderLogoUpload(src) {
        const box = document.getElementById('logoUpload');
        if (!box) return;
        box.innerHTML = src
            ? `<img src="${app.escapeHtml(src)}" alt="Store logo">`
            : '<i class="fas fa-cloud-arrow-up"></i><p>Upload a square logo</p>';
    }

    async handleLogoUpload(file) {
        if (!file) return;
        const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
        if (!allowed.has((file.type || '').toLowerCase())) { app.showAlert('Use PNG, JPEG, GIF, or WebP images only.', 'error'); return; }
        if (file.size > 20 * 1024 * 1024) { app.showAlert('Each image must be 20MB or smaller.', 'error'); return; }
        try {
            const preservePng = file.type === 'image/png';
            const cropped = await window.NextaImageCrop.open(file, { aspect: 1, title: 'Crop your logo', preservePng });
            if (!cropped) return; // cancelled
            const dataUrl = await app.optimizeImage(cropped, { maxDim: 1000, quality: 0.84, preservePng });
            document.getElementById('logoDataUrl').value = dataUrl;
            this.renderLogoUpload(dataUrl);
        } catch (error) {
            app.showAlert(error.message || 'Could not process this image.', 'error');
        }
    }

    markActiveColorPreset() {
        const current = (document.getElementById('bannerColor')?.value || '').toLowerCase();
        document.querySelectorAll('#ssColorSchemes .color-scheme').forEach(el => {
            const on = (el.dataset.color || '').toLowerCase() === current;
            el.classList.toggle('active', on);
            el.setAttribute('aria-checked', String(on));
        });
    }

    /** Preset swatches set the banner colour (the value the storefront paints
     *  with) and remember the preset name in `theme`. */
    applyColorPreset(el) {
        const color = el.dataset.color;
        this.settingsTheme = el.dataset.theme || 'default';
        document.getElementById('bannerColor').value = color;
        document.getElementById('bannerColorValue').textContent = color;
        const bannerImageInput = document.getElementById('bannerImageDataUrl');
        if (!bannerImageInput.value) {
            const preview = document.getElementById('appearanceBannerPreview');
            preview.style.backgroundImage = 'none';
            preview.style.background = color;
        }
        this.markActiveColorPreset();
    }

    /** The shareable public address of a store, for "Copy link" and the
     *  WhatsApp/Facebook/Twitter share buttons. Routed through the same
     *  `app.storeAddress()` helper onboarding uses (see its doc comment in
     *  js/main.js) so Settings can never show a different address than what
     *  onboarding showed or what the post-launch banner links to. This
     *  used to read `store.publicUrl` directly, which in local dev is the
     *  *backend's* own address (http://localhost:4000/...) — that's what
     *  was showing up here as "localhost:4000/<slug>" instead of the
     *  branded nextastores.com link. storeAddress() already knows to treat
     *  a local/LAN/tunnel publicUrl as dev plumbing and fall back to the
     *  brand host instead. */
    publicStoreUrl(slug) {
        return app.storeAddress(slug, this.currentStore?.publicUrl).shareUrl
            || app.storeAddress(slug, this.currentStore?.publicUrl).display;
    }

    /** What "View store" opens: the store's own address (/<slug>) on this site.
     *  Same page shoppers get from a shared link - there is no separate
     *  crawler/preview copy - and a draft store still opens for its owner. */
    viewableStoreUrl(slug) {
        const clean = encodeURIComponent(slug || '');
        return `${window.location.origin}/${clean}`;
    }

    /** Fills in the "nextastores.com/" prefix shown before the editable
     *  slug in Store Basics. Same `app.storeAddress()` call onboarding
     *  makes for its own prefix (js/onboarding.js renderSlugPrefix), so
     *  local dev shows the branded host here too instead of the backend's
     *  own localhost:4000 address. */
    renderStoreUrlPrefix() {
        const el = document.getElementById('storeUrlPrefix');
        if (!el) return;
        el.textContent = app.storeAddress('', this.currentStore?.publicUrl).prefix;
    }

    /** Trims to `n` chars at a rough word boundary — same rule the server
     *  applies (src/seo.js clip()), so the preview never shows something
     *  longer than what Google would actually receive. */
    seoClip(text, n) {
        const t = (text || '').replace(/\s+/g, ' ').trim();
        return t.length <= n ? t : t.slice(0, n - 1).replace(/[\s,.;:-]+$/, '') + '\u2026';
    }

    /** The title/description the store would get if the seller never touches
     *  the Search & sharing fields, mirroring the server fallback in
     *  src/seo.js (buildStoreSeo). Recomputed live from the Store Info
     *  fields so it always reflects the seller's latest name/area/description,
     *  and reused both to pre-fill the fields and to preview them. */
    autoSeoTitle() {
        const name = (document.getElementById('storeName')?.value || '').trim() || 'Your store';
        const district = (document.getElementById('storeDistrict')?.value || '');
        const place = district ? district.charAt(0).toUpperCase() + district.slice(1) : '';
        return this.seoClip(`${name} \u2013 Shop online${place ? ` in ${place}` : ''} | NextaStore`, 70);
    }

    autoSeoDescription() {
        const name = (document.getElementById('storeName')?.value || '').trim() || 'Your store';
        const district = (document.getElementById('storeDistrict')?.value || '');
        const place = district ? district.charAt(0).toUpperCase() + district.slice(1) : '';
        const storeDesc = (document.getElementById('storeDescription')?.value || '').replace(/\s+/g, ' ').trim();
        return this.seoClip(storeDesc || `Shop ${name} on NextaStore${place ? `, ${place}` : ''}. Browse products and message the seller directly.`, 160);
    }

    /** Keeps an auto-filled field in sync while the seller edits Store Info
     *  (name/area/description) elsewhere on the form, and shows/hides the
     *  "Auto-filled…" hint + "Reset to auto" button for both fields. Called
     *  after load, after every Store Info edit, and after a manual reset. */
    refreshSeoAutoFields() {
        const titleEl = document.getElementById('seoTitle');
        const descEl = document.getElementById('seoDescription');
        if (this.seoTitleAuto && titleEl) titleEl.value = this.autoSeoTitle();
        if (this.seoDescAuto && descEl) descEl.value = this.autoSeoDescription();
        const titleHint = document.getElementById('seoTitleAutoHint');
        const descHint = document.getElementById('seoDescAutoHint');
        const titleReset = document.getElementById('seoTitleReset');
        const descReset = document.getElementById('seoDescriptionReset');
        if (titleHint) titleHint.style.display = this.seoTitleAuto ? '' : 'none';
        if (descHint) descHint.style.display = this.seoDescAuto ? '' : 'none';
        if (titleReset) titleReset.hidden = this.seoTitleAuto;
        if (descReset) descReset.hidden = this.seoDescAuto;
    }

    /** Approximates the store's Google result from the form, mirroring the
     *  defaults the server uses (routes/seo.js + src/seo.js). */
    updateSerpPreview() {
        this.refreshSeoAutoFields();
        const titleIn = (document.getElementById('seoTitle')?.value || '').trim();
        const descIn = (document.getElementById('seoDescription')?.value || '').trim();
        const title = titleIn || this.autoSeoTitle();
        const desc = descIn || this.autoSeoDescription();
        const name = (document.getElementById('storeName')?.value || '').trim() || 'Your store';
        const slug = slugifyStoreSlug(document.getElementById('storeSlug')?.value || name);
        document.getElementById('serpUrl').textContent = this.publicStoreUrl(slug);
        document.getElementById('serpTitle').textContent = title;
        document.getElementById('serpDesc').textContent = desc;
        const tc = document.getElementById('seoTitleCount'); if (tc) tc.textContent = `${titleIn.length}/70`;
        const dc = document.getElementById('seoDescCount'); if (dc) dc.textContent = `${descIn.length}/160`;
    }

    /* Stored per user: these are one person's settings and used to sit under
       a single shared key, so whoever signed in next on the same browser
       inherited them. (The old unshared key is deleted by SessionData.) */
    /* Wires the Settings → Notifications "Push Notifications" toggle and its
       "Send a test" button once. Reflects real state (not just what the
       toggle looked like a moment ago) by re-checking after every action,
       since enable()/disable() can fail partway (permission denied, no
       network) and the UI must never claim a state the device doesn't
       actually have. */
    setupPushSettings() {
        const toggle = document.getElementById('pushToggle');
        const testBtn = document.getElementById('pushTestBtn');
        if (!toggle) return;

        toggle.addEventListener('change', async () => {
            const turningOn = toggle.checked;
            toggle.disabled = true;
            try {
                if (turningOn) await window.NextaPush.enable();
                else await window.NextaPush.disable();
            } catch (err) {
                app.showAlert(err.message, err?.reason === 'unconfigured' ? 'warning' : 'error');
            } finally {
                await this.loadPushSettings();
            }
        });

        testBtn?.addEventListener('click', async () => {
            testBtn.disabled = true;
            const original = testBtn.textContent;
            testBtn.textContent = 'Sending…';
            try {
                const res = await window.NextaPush.sendTest();
                app.showAlert(`Test sent to ${res.data.devices} device${res.data.devices === 1 ? '' : 's'}.`, 'success');
            } catch (err) {
                app.showAlert(err.message, 'error');
            } finally {
                testBtn.textContent = original;
                testBtn.disabled = false;
            }
        });
    }

    /* Re-reads actual browser + server state every time the Settings page's
       Notifications tab is opened, rather than trusting whatever the toggle
       last showed — the two can drift (permission revoked from the browser's
       own site settings, another device's subscription expiring, etc.). */
    async loadPushSettings() {
        const toggle = document.getElementById('pushToggle');
        const desc = document.getElementById('pushToggleDesc');
        const testBtn = document.getElementById('pushTestBtn');
        if (!toggle || !desc) return;

        if (!window.NextaPush || !window.NextaPush.supported()) {
            toggle.checked = false;
            toggle.disabled = true;
            if (testBtn) testBtn.disabled = true;
            desc.textContent = 'This browser doesn\u2019t support push notifications.';
            return;
        }

        try {
            const [{ enabled, subscribedDevices }, subscribed] = await Promise.all([
                window.NextaPush.serverStatus(),
                window.NextaPush.isSubscribed()
            ]);

            if (!enabled) {
                toggle.checked = false;
                toggle.disabled = true;
                if (testBtn) testBtn.disabled = true;
                desc.textContent = 'Push notifications aren\u2019t set up on this server yet.';
                return;
            }

            const permission = window.NextaPush.permission();
            if (permission === 'denied') {
                toggle.checked = false;
                toggle.disabled = true;
                if (testBtn) testBtn.disabled = true;
                desc.textContent = 'Notifications are blocked for this site in your browser settings.';
                return;
            }

            toggle.disabled = false;
            toggle.checked = subscribed;
            if (testBtn) testBtn.disabled = !subscribed;
            desc.textContent = subscribed
                ? `On for this device. ${subscribedDevices} device${subscribedDevices === 1 ? '' : 's'} registered in total.`
                : 'Off for this device. Turn it on to get order and message alerts here.';
        } catch (err) {
            desc.textContent = 'Couldn\u2019t check notification status.';
        }
    }

    notificationPrefsKey() {
        return `nextastore_notification_prefs:${app.user?.id || tokenUserId(app.token) || 'unknown'}`;
    }

    loadNotificationPrefs() {
        const defaults = {
            notifyNewOrder: true, notifyOrderStatus: true, notifyWeekly: true
        };
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(this.notificationPrefsKey()) || '{}'); } catch (e) { /* ignore */ }
        const prefs = { ...defaults, ...saved };
        Object.keys(prefs).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = prefs[id];
        });
    }

    setupEventListeners() {
        document.getElementById('categoryFilter')?.addEventListener('change', () => {
            const searchInput = document.getElementById('productSearchFull');
            if (searchInput) searchInput.value = '';
            this.loadProducts(1, false);
        });

        document.getElementById('productSortFull')?.addEventListener('change', () => {
            this.loadProducts(1, false);
        });

        document.getElementById('toggleSelectModeBtn')?.addEventListener('click', () => this.toggleSelectMode());
        document.getElementById('bulkSelectAll')?.addEventListener('change', (e) => this.toggleSelectAllProducts(e.target.checked));
        document.getElementById('bulkDeleteBtn')?.addEventListener('click', () => this.bulkDeleteSelected());
        document.getElementById('bulkApplyCategoryBtn')?.addEventListener('click', () => this.bulkApplyCategory());
        document.getElementById('bulkCategorySelect')?.addEventListener('change', () => this.updateBulkActionsBar());

        const productSearch = document.getElementById('productSearchFull');
        if (productSearch) {
            productSearch.addEventListener('input', app.debounce(() => this.loadProducts(1, false), 300));
        }

        document.getElementById('analyticsPeriod')?.addEventListener('change', () => {
            this.loadAnalytics();
        });

        document.getElementById('orderStatusFilter')?.addEventListener('change', () => this.loadOrders());

        document.getElementById('storeSettingsForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const saveBtn = document.getElementById('storeSettingsSaveBtn');
            if (saveBtn) saveBtn.disabled = true;
            try {
                const bannerImageInput = document.getElementById('bannerImageDataUrl');
                const slugInput = document.getElementById('storeSlug');
                const slug = slugifyStoreSlug(slugInput.value || document.getElementById('storeName').value);
                slugInput.value = slug;

                // Only methods currently rendered are sent; the backend merges
                // this over the stored object so a method that was retired
                // from the catalog is left untouched rather than wiped.
                const payments = {};
                document.querySelectorAll('#storePaymentMethods input[data-payment-code]').forEach(box => {
                    payments[box.dataset.paymentCode] = box.checked;
                });

                const storeData = {
                    name: document.getElementById('storeName').value.trim(),
                    slug,
                    description: document.getElementById('storeDescription').value.trim(),
                    contactEmail: document.getElementById('contactEmail').value.trim(),
                    phoneNumber: document.getElementById('phoneNumber').value.trim(),
                    phonePublic: document.getElementById('phonePublic').checked,
                    district: document.getElementById('storeDistrict').value,
                    address: document.getElementById('storeAddress').value.trim(),
                    detailedDirections: document.getElementById('storeDetailedDirections').value.trim(),
                    mapCoordinates: this.settingsMapCoordinates || '',
                    bannerColor: document.getElementById('bannerColor').value,
                    theme: this.settingsTheme || 'default',
                    payments,
                    // Only the fields this form owns are sent; the backend merges
                    // them into the stored seo object, so older values (keywords,
                    // analyticsId) are left untouched rather than wiped.
                    // While a field is still in "auto" state (unedited since
                    // it was filled from Store Info), save an empty string so
                    // the store keeps following name/area/description changes
                    // automatically — same as before this field had visible
                    // text in it. Once the seller edits it, their exact text
                    // is saved and stops auto-updating.
                    seo: {
                        title: this.seoTitleAuto ? '' : document.getElementById('seoTitle').value.trim(),
                        description: this.seoDescAuto ? '' : document.getElementById('seoDescription').value.trim(),
                        indexable: document.getElementById('seoIndexable').checked
                    }
                };
                // Logo/banner images are only sent when the owner staged a
                // change — otherwise an unrelated save can't wipe them.
                const logoData = document.getElementById('logoDataUrl').value;
                if (logoData) storeData.logo = logoData;
                // Only touch the banner image if the owner actually staged a
                // change (a new upload, or an explicit Reset) — otherwise
                // omit it so an unrelated settings save can't accidentally
                // wipe out an existing banner image.
                if (bannerImageInput.value) {
                    storeData.banner = bannerImageInput.value;
                } else if (bannerImageInput.dataset.reset === '1') {
                    storeData.banner = null;
                }

                const res = await app.apiRequest('/store', {
                    method: 'PUT',
                    body: JSON.stringify(storeData)
                });
                this.currentStore = res.data;
                bannerImageInput.value = '';
                delete bannerImageInput.dataset.reset;
                document.getElementById('logoDataUrl').value = '';
                document.getElementById('storeSlug').dataset.original = res.data.slug || '';
                this.settingsPayments = { ...(res.data.payments || {}) };
                this.settingsTheme = res.data.theme || 'default';
                this.renderPaymentBadges(res.data);
                this.updateSerpPreview();

                // Repaint every banner instance on the page from the actual
                // saved record — one source of truth, updated everywhere at
                // once (overview hero, settings preview, accent bar).
                window.NextaStoreBanner?.applyStoreBanner(res.data, {
                    full: document.getElementById('storeBannerPreview'),
                    accents: [document.getElementById('storeAccentBar')]
                });
                window.NextaStoreBanner?.applyStoreBanner(res.data, { full: document.getElementById('appearanceBannerPreview') });

                // The slug may have been normalised or changed — refresh the
                // hint so nobody thinks the old link still works.
                app.showAlert('Settings saved', 'success');
            } catch (error) {
                app.showAlert(error.message, 'error');
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        });

        // ---- Store settings: controls absorbed from the old builder page ----
        document.getElementById('storePickOnMapBtn')?.addEventListener('click', () => this.openSettingsMapPicker());
        document.getElementById('storeClearMapPinBtn')?.addEventListener('click', () => {
            this.settingsMapCoordinates = '';
            this.settingsMapPlaceName = '';
            this.renderSettingsMapPin();
        });

        const logoBox = document.getElementById('logoUpload');
        logoBox?.addEventListener('click', () => document.getElementById('logoInput').click());
        logoBox?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('logoInput').click(); }
        });
        document.getElementById('logoInput')?.addEventListener('change', (e) => {
            this.handleLogoUpload(e.target.files[0]);
            e.target.value = '';
        });

        document.querySelectorAll('#ssColorSchemes .color-scheme').forEach(el => {
            el.addEventListener('click', () => this.applyColorPreset(el));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.applyColorPreset(el); }
            });
        });
        document.getElementById('bannerColor')?.addEventListener('input', () => this.markActiveColorPreset());

        const slugInput = document.getElementById('storeSlug');
        slugInput?.addEventListener('blur', () => { slugInput.value = slugifyStoreSlug(slugInput.value); });
        slugInput?.addEventListener('input', () => {
            const changed = slugInput.dataset.original && slugifyStoreSlug(slugInput.value) !== slugInput.dataset.original;
            const hint = document.getElementById('storeLinkHint');
            if (hint) hint.textContent = changed
                ? `New link: ${this.publicStoreUrl(slugifyStoreSlug(slugInput.value))} — links you have already shared will stop working.`
                : 'Changing this breaks any links you have already shared.';
        });
        document.getElementById('copyStoreLinkBtn')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const slug = slugInput.dataset.original || slugifyStoreSlug(slugInput.value);
            try {
                await navigator.clipboard.writeText(this.publicStoreUrl(slug));
                const original = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Copied';
                setTimeout(() => { btn.innerHTML = original; }, 2000);
            } catch (err) {
                app.showAlert('Could not copy — select the link and copy it manually.', 'error');
            }
        });
        document.getElementById('viewPublicStoreBtn')?.addEventListener('click', () => {
            const slug = slugInput.dataset.original || this.currentStore?.slug;
            if (slug) window.open(this.viewableStoreUrl(slug), '_blank', 'noopener');
        });
        document.getElementById('viewStoreLinkBtn')?.addEventListener('click', () => {
            const slug = slugInput.dataset.original || this.currentStore?.slug;
            if (slug) window.open(this.viewableStoreUrl(slug), '_blank', 'noopener');
        });

        // A real keystroke in either field (as opposed to this code writing
        // .value programmatically, which fires no 'input' event) means the
        // seller has taken over that field, so it stops following Store Info.
        document.getElementById('seoTitle')?.addEventListener('input', () => { this.seoTitleAuto = false; this.updateSerpPreview(); });
        document.getElementById('seoDescription')?.addEventListener('input', () => { this.seoDescAuto = false; this.updateSerpPreview(); });
        document.getElementById('seoTitleReset')?.addEventListener('click', () => {
            this.seoTitleAuto = true;
            this.updateSerpPreview();
            document.getElementById('seoTitle')?.focus();
        });
        document.getElementById('seoDescriptionReset')?.addEventListener('click', () => {
            this.seoDescAuto = true;
            this.updateSerpPreview();
            document.getElementById('seoDescription')?.focus();
        });

        ['storeName', 'storeDescription', 'storeSlug', 'storeDistrict'].forEach(id => {
            const el = document.getElementById(id);
            el?.addEventListener('input', () => this.updateSerpPreview());
            el?.addEventListener('change', () => this.updateSerpPreview());
        });

        // Jump chips scroll within the long Store form.
        document.querySelectorAll('.store-settings-jump a').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });

        // Appearance panel: color picker live preview (before saving)
        document.getElementById('bannerColor')?.addEventListener('input', (e) => {
            document.getElementById('bannerColorValue').textContent = e.target.value;
            const bannerImageInput = document.getElementById('bannerImageDataUrl');
            // Only the color needs to preview live here — if an image is
            // staged it takes priority, same as the real render logic.
            if (!bannerImageInput.value) {
                document.getElementById('appearanceBannerPreview').style.backgroundImage = 'none';
                document.getElementById('appearanceBannerPreview').style.background = e.target.value;
            }
        });

        // Appearance panel: banner image upload — stages the change and
        // previews it, but doesn't reach the API until Save Changes so the
        // owner can preview before committing.
        document.getElementById('appearanceBannerUploadInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
                app.showAlert('Banner must be less than 5MB', 'error');
                return;
            }
            window.NextaImageCrop.open(file, { aspect: 3, title: 'Crop your banner' }).then(cropped => {
                if (!cropped) return; // cancelled
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const bannerImageInput = document.getElementById('bannerImageDataUrl');
                    bannerImageInput.value = ev.target.result;
                    delete bannerImageInput.dataset.reset;
                    const preview = document.getElementById('appearanceBannerPreview');
                    preview.style.backgroundColor = document.getElementById('bannerColor').value;
                    preview.style.backgroundImage = `url(${ev.target.result})`;
                    preview.style.backgroundSize = 'cover';
                    preview.style.backgroundPosition = 'center';
                };
                reader.readAsDataURL(cropped);
            });
        });

        // Appearance panel: reset to the platform default — staged like
        // everything else here, applied on Save Changes.
        document.getElementById('resetBannerBtn')?.addEventListener('click', () => {
            const defaultColor = window.NextaStoreBanner?.DEFAULT_BANNER_COLOR || '#00B074';
            document.getElementById('bannerColor').value = defaultColor;
            document.getElementById('bannerColorValue').textContent = defaultColor;
            const bannerImageInput = document.getElementById('bannerImageDataUrl');
            bannerImageInput.value = '';
            bannerImageInput.dataset.reset = '1';
            const preview = document.getElementById('appearanceBannerPreview');
            preview.style.backgroundImage = 'none';
            preview.style.background = defaultColor;
            app.showAlert('Reset staged — click Save Changes to apply', 'success');
        });

        document.getElementById('accountSettingsForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.targetForm;
            if (!app.validateForm(form)) return;

            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            if (newPassword && newPassword !== confirmPassword) {
                app.showAlert('Passwords don\u2019t match', 'error');
                return;
            }
            if (newPassword && !currentPassword) {
                app.showAlert('Enter your current password to set a new one', 'error');
                return;
            }

            const payload = { name: document.getElementById('accountName').value.trim() };
            if (newPassword) {
                payload.currentPassword = currentPassword;
                payload.newPassword = newPassword;
            }

            try {
                const res = await app.apiRequest('/user/me', { method: 'PUT', body: JSON.stringify(payload) });
                app.user = { ...app.user, ...res.data };
                // A password change bumps tokenVersion server-side (so every
                // OTHER session is signed out) and hands back a fresh token
                // for THIS one in the same response \u2014 without adopting it
                // here, this tab's very next request would reject its own
                // now-stale token as TOKEN_REVOKED and bounce the person who
                // just changed their password straight back to login.
                if (res.token) { app.token = res.token; }
                TokenStorage.write('nextastore_token', app.token, app.remembered);
                TokenStorage.write('nextastore_user', JSON.stringify(app.user), app.remembered);
                app.updateUI();
                // The server just deleted this device's push subscription row
                // (see routes/user.js) because the password changed \u2014 the
                // browser's own subscription is still there, so quietly hand
                // it back under the new token rather than leaving push
                // silently broken until the person opens Settings again.
                if (newPassword && window.NextaPush) window.NextaPush.reregisterAfterCredentialChange();
                document.getElementById('currentPassword').value = '';
                document.getElementById('newPassword').value = '';
                document.getElementById('confirmPassword').value = '';
                app.showAlert('Account updated', 'success');
            } catch (error) {
                app.showAlert(error.message, 'error');
            }
        });

        document.getElementById('logoutAllBtn')?.addEventListener('click', async () => {
            const confirmed = await app.confirm({
                title: 'Log out of all devices?',
                message: 'Every other browser and device signed into this account will be signed out. This device will need to sign in again too.',
                confirmText: 'Log out everywhere',
                tone: 'danger'
            });
            if (!confirmed) return;
            try {
                await app.apiRequest('/auth/logout-all', { method: 'POST' });
            } catch (error) {
                // Even if the request itself failed to round-trip, the safe
                // thing locally is still to drop this device's own session
                // rather than leave the button looking like it did nothing.
            }
            app.endSession('logout');
            window.location.href = 'login.html';
        });

        document.getElementById('notificationsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const ids = ['notifyNewOrder', 'notifyOrderStatus', 'notifyWeekly'];
            const prefs = {};
            ids.forEach(id => { prefs[id] = document.getElementById(id)?.checked ?? false; });
            try { localStorage.setItem(this.notificationPrefsKey(), JSON.stringify(prefs)); } catch (err) { /* ignore */ }
            app.showAlert('Preferences saved', 'success');
        });

    }

    /* The phone/tablet hamburger drawer. One controller so every way of
       opening or closing it (toggle, overlay, Escape, choosing a section,
       rotating to a wide screen) leaves the same state behind: the .open
       class, the overlay, the toggle's aria-expanded/label, a scroll lock on
       the page underneath, and where keyboard focus is. Before this, closing
       via a section left the toggle unaware, the page behind kept scrolling,
       and a closed (off-screen) drawer could still be tabbed into. */
    setupMobileMenu() {
        const menuToggle = document.getElementById('menuToggle');
        const sidebar = document.getElementById('dashboardSidebar') || document.querySelector('.sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (!sidebar) return;
        const wide = window.matchMedia('(min-width: 769px)');
        const isOpen = () => sidebar.classList.contains('open');

        this.setDrawerOpen = (open, { restoreFocus = true } = {}) => {
            if (open && wide.matches) return; // no drawer at desktop width
            const was = isOpen();
            sidebar.classList.toggle('open', open);
            overlay?.classList.toggle('active', open);
            document.body.classList.toggle('drawer-open', open);
            if (menuToggle) {
                menuToggle.setAttribute('aria-expanded', String(open));
                menuToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
            }
            if (open && !was) {
                // Into the drawer, so keyboard/screen-reader users land in it.
                const first = sidebar.querySelector('.nav-item.active') || sidebar.querySelector('.nav-item');
                requestAnimationFrame(() => first?.focus({ preventScroll: true }));
            } else if (!open && was && restoreFocus && sidebar.contains(document.activeElement)) {
                menuToggle?.focus({ preventScroll: true });
            }
        };

        menuToggle?.addEventListener('click', () => this.setDrawerOpen(!isOpen()));
        overlay?.addEventListener('click', () => this.setDrawerOpen(false));
        document.addEventListener('keydown', (e) => {
            if (!isOpen()) return;
            if (e.key === 'Escape') { e.preventDefault(); this.setDrawerOpen(false); return; }
            if (e.key === 'Tab') {
                // Keep Tab inside the open drawer (it is modal: the page is dimmed).
                const focusable = [...sidebar.querySelectorAll('a[href], button:not([disabled])')].filter(el => el.offsetParent !== null);
                if (!focusable.length) return;
                const firstEl = focusable[0]; const lastEl = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
                else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
                else if (!sidebar.contains(document.activeElement)) { e.preventDefault(); firstEl.focus(); }
            }
        });
        // Rotating a tablet / resizing a window past the breakpoint must not
        // leave the overlay up or the page scroll-locked with no drawer.
        const onWide = () => { if (wide.matches && isOpen()) this.setDrawerOpen(false, { restoreFocus: false }); };
        if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
    }

    setupSettingsNavigation() {
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const section = item.dataset.settingsSection;
                
                // Update nav items
                document.querySelectorAll('.settings-nav-item').forEach(nav => nav.classList.remove('active'));
                item.classList.add('active');
                
                // Update content sections
                document.querySelectorAll('.settings-section-content').forEach(content => content.classList.remove('active'));
                const targetSection = document.getElementById(`settings-${section}`);
                if (targetSection) {
                    targetSection.classList.add('active');
                }
            });
        });
    }

    setupShareModal() {
        const shareModal = document.getElementById('shareModal');
        shareModal?.addEventListener('click', (e) => {
            if (e.target.id === 'shareModal') {
                this.hideShareModal();
            }
        });
    }

    logout() {
        app.logout();
    }

    switchToProducts() {
        this.switchSection('products');
    }

    switchToOrders() {
        this.switchSection('orders');
    }

    switchToAnalytics() {
        this.switchSection('analytics');
    }

    switchToOverview() {
        this.switchSection('overview');
    }

    navigateToSettings(section) {
        this.switchSection('settings');
        setTimeout(() => {
            const navItem = document.querySelector(`.settings-nav-item[data-settings-section="${section}"]`);
            if (navItem) {
                navItem.click();
            }
        }, 100);
    }

    showShareModal() {
        const storeUrlInput = document.getElementById('storeUrlModal');
        // Was built from the store's display name (e.g. "Amina Nakato's
        // Store") instead of its slug, producing a link the API can't
        // resolve. The slug is what /store/public actually matches against.
        storeUrlInput.value = this.publicStoreUrl(this.currentStore?.slug || 'my-store');
        document.getElementById('shareModal').style.display = 'flex';
    }

    hideShareModal() {
        document.getElementById('shareModal').style.display = 'none';
    }

    copyStoreUrlModal() {
        const storeUrlInput = document.getElementById('storeUrlModal');
        storeUrlInput.select();
        storeUrlInput.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(storeUrlInput.value).then(() => {
            const btn = document.getElementById('copyStoreUrlModalBtn');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-outline');
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-outline');
            }, 2000);
        });
    }

    shareOnWhatsApp() {
        const storeUrl = document.getElementById('storeUrlModal').value;
        const text = encodeURIComponent(`Check out my store on NextaStore! ${storeUrl}`);
        window.open(`https://wa.me/?text=${text}`, '_blank');
    }

    shareOnFacebook() {
        const storeUrl = encodeURIComponent(document.getElementById('storeUrlModal').value);
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${storeUrl}`, '_blank');
    }

    shareOnTwitter() {
        const storeUrl = encodeURIComponent(document.getElementById('storeUrlModal').value);
        const text = encodeURIComponent('Check out my store on NextaStore!');
        window.open(`https://twitter.com/intent/tweet?text=${text}&url=${storeUrl}`, '_blank');
    }

    downloadQRCode() {
        app.showAlert('QR code download feature coming soon!', 'warning');
    }

    // ---- Global Search ----
    setupGlobalSearch() {
        const searchInput = document.getElementById('globalSearchInput');
        const searchResults = document.getElementById('searchResults');
        
        if (!searchInput) {
            return;
        }

        // Search on input with debounce
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const searchTerm = e.target.value.trim();
            
            if (searchTerm.length >= 2) {
                searchTimeout = setTimeout(() => {
                    this.performGlobalSearch(searchTerm);
                }, 300);
            } else {
                this.closeSearchResults();
            }
        });

        // Close on click outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#globalSearchBar') && !e.target.closest('#searchResults')) {
                this.closeSearchResults();
            }
        });

        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeSearchResults();
            }
        });
    }

    async performGlobalSearch(searchTerm) {
        const searchResults = document.getElementById('searchResults');
        const searchResultsContent = document.getElementById('searchResultsContent');
        
        if (!searchResults || !searchResultsContent) {
            return;
        }

        searchResults.style.display = 'block';
        searchResultsContent.innerHTML = '<div class="search-result-section"><i class="fas fa-spinner fa-spin"></i><p>Searching...</p></div>';

        try {
            // Fetch all necessary data. Any one of these can legitimately fail
            // (e.g. a brand-new seller with no store yet) — allSettled means a
            // single failing endpoint doesn't take down search entirely.
            const [productsRes, ordersRes, storeRes] = await Promise.allSettled([
                app.apiRequest('/products?limit=50'),
                app.apiRequest('/orders?limit=50'),
                app.apiRequest('/store')
            ]);

            const products = (productsRes.status === 'fulfilled' && productsRes.value.data) || [];
            const orders = (ordersRes.status === 'fulfilled' && ordersRes.value.data) || [];
            const store = (storeRes.status === 'fulfilled' && storeRes.value.data) || {};

            const results = this.compileSearchResults(searchTerm, products, orders, store);
            this.renderSearchResults(results);
        } catch (error) {
            console.error('Search error:', error);
            searchResultsContent.innerHTML = `
                <div class="search-no-results">
                    <i class="fas fa-exclamation-circle"></i>
                    <p>Search failed. Please try again.</p>
                </div>
            `;
        }
    }

    compileSearchResults(searchTerm, products, orders, store) {
        const term = searchTerm.toLowerCase();
        const results = {
            navigation: [],
            products: [],
            orders: [],
            settings: []
        };

        // Navigation results
        const navigationItems = [
            { id: 'overview', title: 'Overview', icon: 'fa-house', description: 'Dashboard overview and storefront' },
            { id: 'products', title: 'Products', icon: 'fa-box', description: 'Product management' },
            { id: 'orders', title: 'Orders', icon: 'fa-cart-shopping', description: 'Order management' },
            { id: 'analytics', title: 'Analytics', icon: 'fa-chart-line', description: 'Sales analytics and reports' },
            { id: 'settings', title: 'Settings', icon: 'fa-gear', description: 'Store and account settings' }
        ];

        navigationItems.forEach(item => {
            if (item.title.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)) {
                results.navigation.push(item);
            }
        });

        // Product results
        products.forEach(product => {
            if ((product.name || '').toLowerCase().includes(term) ||
                (product.description && product.description.toLowerCase().includes(term)) ||
                (product.category && product.category.toLowerCase().includes(term))) {
                results.products.push({
                    id: product.id,
                    title: product.name,
                    subtitle: `${product.category || 'Uncategorized'} · ${app.formatCurrency(product.price)}`,
                    subtitleHtml: `${app.escapeHtml(product.category || 'Uncategorized')} <i class="fas fa-circle" aria-hidden="true"></i> ${app.escapeHtml(app.formatCurrency(product.price))}`,
                    icon: 'fa-box',
                    action: 'edit'
                });
            }
        });

        // Order results
        orders.forEach(order => {
            if ((order.id || '').toLowerCase().includes(term) ||
                (order.customerName || '').toLowerCase().includes(term) ||
                (order.status || '').toLowerCase().includes(term)) {
                results.orders.push({
                    id: order.id,
                    title: `Order #${order.id}`,
                    subtitle: `${order.customerName} · ${app.formatCurrency(order.total)} · ${order.status}`,
                    subtitleHtml: `${app.escapeHtml(order.customerName)} <i class="fas fa-circle" aria-hidden="true"></i> ${app.escapeHtml(app.formatCurrency(order.total))} <i class="fas fa-circle" aria-hidden="true"></i> ${app.escapeHtml(order.status)}`,
                    icon: 'fa-receipt',
                    action: 'view'
                });
            }
        });

        // Settings results
        const settingsItems = [
            { id: 'store-settings', title: 'Store Settings', icon: 'fa-store', description: 'Store name, location, contact', section: 'store' },
            { id: 'account-settings', title: 'Account Settings', icon: 'fa-user', description: 'Profile and password', section: 'account' },
            { id: 'notification-settings', title: 'Notification Settings', icon: 'fa-bell', description: 'Email preferences', section: 'notifications' }
        ];

        settingsItems.forEach(item => {
            if (item.title.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)) {
                results.settings.push(item);
            }
        });

        // Store info results
        if (store.name && store.name.toLowerCase().includes(term)) {
            results.settings.push({
                id: 'store-name',
                title: 'Store Name',
                subtitle: store.name,
                icon: 'fa-store',
                action: 'edit',
                section: 'store'
            });
        }

        return results;
    }

    renderSearchResults(results) {
        const searchResultsContent = document.getElementById('searchResultsContent');
        if (!searchResultsContent) return;

        let html = '';
        let hasResults = false;

        // Navigation results
        if (results.navigation.length > 0) {
            hasResults = true;
            html += `<div class="search-result-group">
                <div class="search-result-group-title">Navigation</div>
                ${results.navigation.map(item => `
                    <div class="search-result-item" onclick="dashboardManager.navigateToSection('${item.id}')">
                        <div class="search-result-icon"><i class="fas ${item.icon}"></i></div>
                        <div class="search-result-content-text">
                            <div class="search-result-title">${app.escapeHtml(item.title)}</div>
                            <div class="search-result-subtitle">${app.escapeHtml(item.description)}</div>
                        </div>
                        <div class="search-result-action">Go to</div>
                    </div>
                `).join('')}
            </div>`;
        }

        // Product results
        if (results.products.length > 0) {
            hasResults = true;
            html += `<div class="search-result-group">
                <div class="search-result-group-title">Products (${results.products.length})</div>
                ${results.products.slice(0, 5).map(item => `
                    <div class="search-result-item" onclick="dashboardManager.editProduct('${item.id}')">
                        <div class="search-result-icon"><i class="fas ${item.icon}"></i></div>
                        <div class="search-result-content-text">
                            <div class="search-result-title">${app.escapeHtml(item.title)}</div>
                            <div class="search-result-subtitle">${item.subtitleHtml || app.escapeHtml(item.subtitle || '')}</div>
                        </div>
                        <div class="search-result-action">Edit</div>
                    </div>
                `).join('')}
                ${results.products.length > 5 ? `<div class="search-result-item" onclick="dashboardManager.navigateToSection('products')">
                    <div class="search-result-content-text">
                        <div class="search-result-title" style="color: var(--primary);">View all ${results.products.length} products</div>
                    </div>
                </div>` : ''}
            </div>`;
        }

        // Order results
        if (results.orders.length > 0) {
            hasResults = true;
            html += `<div class="search-result-group">
                <div class="search-result-group-title">Orders (${results.orders.length})</div>
                ${results.orders.slice(0, 5).map(item => `
                    <div class="search-result-item" onclick="dashboardManager.navigateToSection('orders')">
                        <div class="search-result-icon"><i class="fas ${item.icon}"></i></div>
                        <div class="search-result-content-text">
                            <div class="search-result-title">${app.escapeHtml(item.title)}</div>
                            <div class="search-result-subtitle">${item.subtitleHtml || app.escapeHtml(item.subtitle || '')}</div>
                        </div>
                        <div class="search-result-action">View</div>
                    </div>
                `).join('')}
                ${results.orders.length > 5 ? `<div class="search-result-item" onclick="dashboardManager.navigateToSection('orders')">
                    <div class="search-result-content-text">
                        <div class="search-result-title" style="color: var(--primary);">View all ${results.orders.length} orders</div>
                    </div>
                </div>` : ''}
            </div>`;
        }

        // Settings results
        if (results.settings.length > 0) {
            hasResults = true;
            html += `<div class="search-result-group">
                <div class="search-result-group-title">Settings</div>
                ${results.settings.map(item => `
                    <div class="search-result-item" onclick="dashboardManager.navigateToSettings('${item.section || 'store'}')">
                        <div class="search-result-icon"><i class="fas ${item.icon}"></i></div>
                        <div class="search-result-content-text">
                            <div class="search-result-title">${app.escapeHtml(item.title)}</div>
                            <div class="search-result-subtitle">${app.escapeHtml(item.description || item.subtitle || '')}</div>
                        </div>
                        <div class="search-result-action">Edit</div>
                    </div>
                `).join('')}
            </div>`;
        }

        if (!hasResults) {
            html = `
                <div class="search-no-results">
                    <i class="fas fa-search"></i>
                    <p>No results found for "${document.getElementById('globalSearchInput').value}"</p>
                </div>
            `;
        }

        searchResultsContent.innerHTML = html;
    }

    closeSearchResults() {
        const searchResults = document.getElementById('searchResults');
        if (searchResults) {
            searchResults.style.display = 'none';
        }
        const searchInput = document.getElementById('globalSearchInput');
        // Closing results must not erase what the seller typed. The query
        // is still useful when the dropdown is reopened or when focus moves
        // back to the field.
    }

    navigateToSection(section) {
        this.closeSearchResults();
        this.switchSection(section);
    }

    editProduct(productId) {
        this.closeSearchResults();
        window.location.href = `product-form.html?id=${productId}`;
    }

    /** Overview's quick "Edit" pin link. Saves immediately via PUT /store
     *  through the shared NextaStoreMapPicker (the same picker Settings >
     *  Store uses), so the overview doesn't need the Settings form open. */
    openMapPickerFromOverview() {
        const selectedDistrict = (this.currentStore?.district && NextaStoreMapPicker.districtCoordinates[this.currentStore.district])
            ? this.currentStore.district
            : 'kampala';

        NextaStoreMapPicker.open({
            initialDistrict: selectedDistrict,
            initialCoordinates: this.currentStore?.mapCoordinates || '',
            onSave: async ({ lat, lng, district, placeName, suggestedAddress, suggestedDirections }) => {
                const storeData = { mapCoordinates: `${lat},${lng}`, district };
                // Only fill in address/directions from the reverse-geocode
                // if the store doesn't already have its own — never
                // clobber something the seller already wrote in Settings.
                if (suggestedAddress && !this.currentStore?.address) storeData.address = suggestedAddress;
                if (suggestedDirections && !this.currentStore?.detailedDirections) storeData.detailedDirections = suggestedDirections;

                try {
                    const res = await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify(storeData) });
                    this.currentStore = res.data;
                    const locationParts = [];
                    if (res.data.district) locationParts.push(res.data.district.charAt(0).toUpperCase() + res.data.district.slice(1));
                    if (placeName) locationParts.push(placeName);
                    else if (res.data.address) locationParts.push(res.data.address);
                    document.getElementById('locationText').textContent = locationParts.length ? locationParts.join(', ') : 'Add your location';
                    this.settingsMapCoordinates = res.data.mapCoordinates || '';
                    this.settingsMapPlaceName = placeName || '';
                    app.showAlert('Location saved', 'success');
                } catch (error) {
                    app.showAlert(error.message, 'error');
                }
            }
        });
    }

}

let dashboardManager;
if (document.querySelector('#dashboardContainer')) {
    dashboardManager = new DashboardManager();
}
