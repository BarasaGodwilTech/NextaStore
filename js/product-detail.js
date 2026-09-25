class ProductDetailManager {
    constructor() {
        this.product = null;
        this.store = null;
        this.quantity = 1;
        this.isFavorite = false;
        this.referrer = document.referrer;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.showLoadingStates();
        await this.loadProductData();
        this.setupBackNavigation();
        await this.loadRelatedProducts();
        this.updateCartUI();
        await this.loadFavoriteState();
        this.resumePendingAction();
    }

    /** Reads back whether the signed-in shopper has already favorited this
     *  product, so the heart icon opens in the right state instead of
     *  always starting unfilled. optionalAuth on the backend means a
     *  logged-out visitor just gets { favorited: false } instead of a 401. */
    async loadFavoriteState() {
        if (!this.product?.id) return;
        try {
            const response = await app.apiRequest(`/favorites/${encodeURIComponent(this.product.id)}`);
            this.isFavorite = !!response.data?.favorited;
            this.renderFavoriteButton();
        } catch (error) {
            console.warn('Could not load favorite state:', error);
        }
    }

    renderFavoriteButton() {
        const btn = document.getElementById('favoriteBtn');
        const icon = btn?.querySelector('i');
        if (!btn || !icon) return;
        icon.classList.toggle('fas', this.isFavorite);
        icon.classList.toggle('far', !this.isFavorite);
        btn.classList.toggle('is-active', this.isFavorite);
    }

    /** Re-fires a favorite toggle or a "message seller" open that got
     *  interrupted by a login redirect (see app.requireLogin), so the
     *  shopper doesn't have to remember to click it again after logging in. */
    resumePendingAction() {
        const favorite = app.consumePendingAction('favorite-product');
        if (favorite && this.product && favorite.productId === this.product.id) {
            this.toggleFavorite();
            return;
        }
        const contact = app.consumePendingAction('message-product-seller');
        if (contact && this.product && contact.productId === this.product.id) {
            this.openMessageSellerDialog();
            return;
        }
    }

    showLoadingStates() {
        // Show loading states for all dynamic content
        document.getElementById('productLoadingState')?.classList.add('active');
        document.getElementById('productContent')?.classList.add('hidden');
        
        document.getElementById('galleryLoadingState')?.classList.add('active');
        document.getElementById('galleryContent')?.classList.add('hidden');
        
        document.getElementById('storeLoadingState')?.classList.add('active');
        document.getElementById('storeContent')?.classList.add('hidden');
        
        document.getElementById('relatedLoadingState')?.classList.add('active');
        document.getElementById('relatedContent')?.classList.add('hidden');
    }

    hideLoadingStates() {
        // Hide loading states and show actual content
        document.getElementById('productLoadingState')?.classList.remove('active');
        document.getElementById('productContent')?.classList.remove('hidden');
        
        document.getElementById('galleryLoadingState')?.classList.remove('active');
        document.getElementById('galleryContent')?.classList.remove('hidden');
        
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
        
        document.getElementById('relatedLoadingState')?.classList.remove('active');
        document.getElementById('relatedContent')?.classList.remove('hidden');
    }

    setupEventListeners() {
        // Quantity controls
        document.getElementById('decreaseQty')?.addEventListener('click', () => {
            if (this.quantity > 1) {
                this.quantity--;
                this.updateQuantityDisplay();
            }
        });

        document.getElementById('increaseQty')?.addEventListener('click', () => {
            if (this.quantity < 99) {
                this.quantity++;
                this.updateQuantityDisplay();
            }
        });

        document.getElementById('quantityInput')?.addEventListener('change', (e) => {
            const value = parseInt(e.target.value);
            if (value >= 1 && value <= 99) {
                this.quantity = value;
            } else {
                e.target.value = this.quantity;
            }
        });

        // Add to cart
        document.getElementById('addToCartBtn')?.addEventListener('click', () => this.addToCart());

        // Favorite button
        document.getElementById('favoriteBtn')?.addEventListener('click', () => this.toggleFavorite());

        // Share button
        document.getElementById('shareBtn')?.addEventListener('click', () => this.openShareModal());
        document.getElementById('messageSellerBtn')?.addEventListener('click', () => this.openMessageSellerDialog());

        // Cart open/close/checkout wiring now lives in js/cart.js, shared by
        // every page with the drawer-style cart markup — see setupCartDrawer().

        // Tab navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                this.switchTab(tabId);
            });
        });

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

        // Back link
        document.getElementById('backLink')?.addEventListener('click', (e) => {
            e.preventDefault();
            const backLink = document.getElementById('backLink');
            if (backLink.href && backLink.href !== '#') {
                window.location.href = backLink.href;
            } else if (this.referrer && this.referrer.includes(window.location.hostname)) {
                window.history.back();
            } else {
                window.location.href = 'marketplace.html';
            }
        });
    }

    async loadProductData() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const productId = urlParams.get('id');
            const storeParam = urlParams.get('store');

            if (!productId) {
                this.renderProductNotFound();
                return;
            }

            // Public product lookup — no login required. (The owner-only
            // GET /products/:id endpoint used to be called here, which
            // rejected every anonymous shopper with a 401.)
            const response = await app.apiRequest(`/products/public/${productId}`);
            this.product = response.data;

            // If a store parameter is provided, use it first (this is the
            // store the customer came from).
            if (storeParam) {
                try {
                    const storeResponse = await app.apiRequest(`/store/public/${storeParam}`);
                    this.store = storeResponse.data;
                } catch (error) {
                    console.error('Failed to load store data from parameter:', error);
                }
            }

            // If no store parameter or it failed, load from the product's storeId.
            if (!this.store && this.product.storeId) {
                try {
                    const storeResponse = await app.apiRequest(`/store/public/${this.product.storeId}`);
                    this.store = storeResponse.data;
                } catch (error) {
                    console.error('Failed to load store data from product storeId:', error);
                }
            }

            this.renderProductInfo();
            this.updateBreadcrumb();
            window.NextaStoreBanner?.applyStoreBanner(this.store, {
                accents: [document.getElementById('storeAccentBar')]
            });
        } catch (error) {
            console.error('Failed to load product data:', error);
            this.renderProductNotFound();
        }
    }

    updateBreadcrumb() {
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (!breadcrumbContainer) return;

        if (this.store) {
            breadcrumbContainer.innerHTML = `
                <a href="marketplace.html">Marketplace</a>
                <span class="separator">/</span>
                <a href="${app.storeLink(this.store)}">${app.escapeHtml(this.store.name)}</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productBreadcrumb">${app.escapeHtml(this.product?.name || 'Product')}</span>
            `;
        } else {
            breadcrumbContainer.innerHTML = `
                <a href="marketplace.html">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productBreadcrumb">${app.escapeHtml(this.product?.name || 'Product')}</span>
            `;
        }
    }

    setupBackNavigation() {
        const backLink = document.getElementById('backLink');
        const backText = document.getElementById('backText');
        
        if (!backLink || !backText) return;

        // Determine where to go back based on referrer
        if (this.referrer) {
            const url = new URL(this.referrer);
            
            // If coming from a store page, go back to that store. A store lives
            // at /<slug> (a single path segment with no file extension); the
            // old store-detail.html?store=<slug> form is still understood.
            if (url.origin === window.location.origin) {
                const pathKey = url.pathname.replace(/^\/|\/$/g, '');
                const storeKey = url.pathname.includes('store-detail.html')
                    ? url.searchParams.get('store')
                    : (/^[A-Za-z0-9-]+$/.test(pathKey) ? pathKey : '');
                if (storeKey) {
                    backLink.href = app.storeLinkFor(storeKey);
                    backText.textContent = 'Back to Store';
                    return;
                }
            }
            
            // If coming from marketplace, go back to marketplace
            if (url.pathname.includes('marketplace.html')) {
                backLink.href = 'marketplace.html';
                backText.textContent = 'Back to Marketplace';
                return;
            }
        }

        // If we have store info but no referrer, go to store
        if (this.store) {
            backLink.href = app.storeLink(this.store);
            backText.textContent = 'Back to Store';
        } else {
            // Default to marketplace
            backLink.href = 'marketplace.html';
            backText.textContent = 'Back to Marketplace';
        }
    }

    renderProductInfo() {
        if (!this.product) return;

        document.title = `${this.product.name} - NextaStore`;

        // Update breadcrumb
        this.updateBreadcrumb();

        // Update product info
        document.getElementById('productName').textContent = this.product.name;
        document.getElementById('productDescription').textContent = this.product.description || 'No description available.';
        document.getElementById('fullDescription').innerHTML = `<p>${app.escapeHtml(this.product.description || 'No detailed description available.')}</p>`;

        // Update price
        document.getElementById('currentPrice').textContent = app.formatCurrency(this.product.price);
        if (this.product.originalPrice && this.product.originalPrice > this.product.price) {
            document.getElementById('originalPrice').textContent = app.formatCurrency(this.product.originalPrice);
            const discount = Math.round((1 - this.product.price / this.product.originalPrice) * 100);
            document.getElementById('discountBadge').textContent = `-${discount}%`;
        }

        // Update meta information
        document.getElementById('productCategory').textContent = this.product.category || 'General';
        document.getElementById('productStock').textContent = this.product.stock || 0;

        // Update product image gallery
        this.galleryImages = Array.isArray(this.product.images) && this.product.images.length
            ? this.product.images
            : (this.product.image ? [this.product.image] : []);
        this.activeImageIndex = 0;
        this.renderGallery();

        // Update store info
        if (this.store) {
            document.getElementById('storeMiniName').textContent = this.store.name;
            document.getElementById('storeMiniBadges').innerHTML = app.renderSellerBadges(this.store, { limit: 2 });
            document.getElementById('visitStoreBtn').href = app.storeLink(this.store);
            
            // Make sure store info card is visible
            const storeInfoCard = document.querySelector('.store-info-card');
            if (storeInfoCard) {
                storeInfoCard.style.display = 'block';
            }

            const storeLogo = document.getElementById('storeMiniLogo');
            if (this.store.logo) {
                storeLogo.style.backgroundImage = `url(${app.resolveImageUrl(this.store.logo)})`;
                storeLogo.style.backgroundSize = 'cover';
                storeLogo.style.backgroundPosition = 'center';
                storeLogo.innerHTML = '';
            } else {
                storeLogo.style.backgroundImage = 'none';
                storeLogo.textContent = app.getInitial(this.store.name);
            }
        } else {
            // Hide store info card if no store data
            const storeInfoCard = document.querySelector('.store-info-card');
            if (storeInfoCard) {
                storeInfoCard.style.display = 'none';
            }
        }

        // Hide loading states for product and gallery
        document.getElementById('productLoadingState')?.classList.remove('active');
        document.getElementById('productContent')?.classList.remove('hidden');
        
        document.getElementById('galleryLoadingState')?.classList.remove('active');
        document.getElementById('galleryContent')?.classList.remove('hidden');
        
        if (this.store) {
            document.getElementById('storeLoadingState')?.classList.remove('active');
            document.getElementById('storeContent')?.classList.remove('hidden');
        }
    }

    renderGallery() {
        const mainImage = document.getElementById('mainImage');
        const thumbGallery = document.getElementById('thumbnailGallery');
        if (!mainImage) return;

        if (!this.galleryImages.length) {
            mainImage.innerHTML = `
                <div class="image-placeholder">
                    <i class="fas ${this.product?.icon || 'fa-box'}"></i>
                </div>
            `;
            if (thumbGallery) thumbGallery.innerHTML = '';
            return;
        }

        this.setActiveImage(this.activeImageIndex);

        if (thumbGallery) {
            if (this.galleryImages.length > 1) {
                thumbGallery.innerHTML = this.galleryImages.map((src, i) => `
                    <button class="thumbnail-item ${i === this.activeImageIndex ? 'active' : ''}" data-index="${i}" aria-label="View image ${i + 1}">
                        <img src="${app.resolveImageUrl(src)}" alt="${app.escapeHtml(this.product.name)} thumbnail ${i + 1}" loading="lazy">
                    </button>
                `).join('');

                thumbGallery.querySelectorAll('.thumbnail-item').forEach(btn => {
                    btn.addEventListener('click', () => {
                        this.setActiveImage(parseInt(btn.dataset.index));
                        thumbGallery.querySelectorAll('.thumbnail-item').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                    });
                });
            } else {
                thumbGallery.innerHTML = '';
            }
        }
    }

    setActiveImage(index) {
        this.activeImageIndex = index;
        const mainImage = document.getElementById('mainImage');
        if (mainImage && this.galleryImages[index]) {
            mainImage.innerHTML = `<img src="${app.resolveImageUrl(this.galleryImages[index])}" alt="${app.escapeHtml(this.product.name)}">`;
        }
    }

    renderProductNotFound() {
        // Hide loading states
        document.getElementById('productLoadingState')?.classList.remove('active');
        document.getElementById('productContent')?.classList.remove('hidden');
        document.getElementById('galleryLoadingState')?.classList.remove('active');
        document.getElementById('galleryContent')?.classList.remove('hidden');
        document.getElementById('storeLoadingState')?.classList.remove('active');
        document.getElementById('storeContent')?.classList.remove('hidden');
        document.getElementById('relatedLoadingState')?.classList.remove('active');
        document.getElementById('relatedContent')?.classList.remove('hidden');

        document.getElementById('productName').textContent = 'Product Not Found';
        document.getElementById('productDescription').textContent = 'This product may have been removed or is temporarily unavailable.';
        document.getElementById('addToCartBtn').disabled = true;
        document.getElementById('addToCartBtn').textContent = 'Product Unavailable';

        // Update breadcrumb for not found state
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = `
                <a href="marketplace.html">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current">Product Not Found</span>
            `;
        }

        const storeInfoCard = document.querySelector('.store-info-card');
        if (storeInfoCard) storeInfoCard.style.display = 'none';

        const mainImage = document.getElementById('mainImage');
        if (mainImage) {
            mainImage.innerHTML = `
                <div class="image-placeholder">
                    <i class="fas fa-box-open"></i>
                </div>
            `;
        }
    }

    updateQuantityDisplay() {
        const input = document.getElementById('quantityInput');
        if (input) {
            input.value = this.quantity;
        }
    }

    addToCart() {
        if (!this.product) return;
        try { window.NextaCart.add(this.product, this.quantity, this.store); app.showAlert(`Added ${this.quantity} item(s) to cart`, 'success'); }
        catch (error) { app.showAlert(error.message, 'error'); }
    }

    updateCartUI() {
        const count = window.NextaCart?.count() || 0;
        document.querySelectorAll('.cart-count').forEach(el => el.textContent = count);
        const root = document.querySelector('.cart-items');
        if (root) window.NextaCart.renderMiniCart(root);
    }


    async toggleFavorite() {
        if (!app.requireLogin('Log in to save items to your favorites.', { type: 'favorite-product', productId: this.product?.id })) return;
        if (!this.product?.id) return;

        const btn = document.getElementById('favoriteBtn');
        if (!btn || btn.disabled) return;
        const wasFavorite = this.isFavorite;
        btn.disabled = true;
        try {
            const response = await app.apiRequest(`/favorites/${encodeURIComponent(this.product.id)}`, {
                method: wasFavorite ? 'DELETE' : 'POST'
            });
            this.isFavorite = !!response.data?.favorited;
            this.renderFavoriteButton();
            app.showAlert(this.isFavorite ? 'Added to favorites' : 'Removed from favorites', 'success');
        } catch (error) {
            console.error('Failed to update favorite:', error);
            app.showAlert(error.message || 'Could not update your favorites. Please try again.', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    openShareModal() {
        document.getElementById('shareModal').classList.add('open');
    }

    handleShare(platform) {
        const url = window.location.href;
        const title = `Check out ${this.product?.name || 'this amazing product'} on NextaStore!`;

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

    switchTab(tabId) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabId}Tab`);
        });
    }

    openMessageSellerDialog() {
        if (!app.requireLogin('Log in to message this seller.', { type:'message-product-seller', productId:this.product?.id })) return;
        app.openMessageSellerModal({ store: this.store, product: this.product });
    }





    async loadRelatedProducts() {
        if (!this.store) return; // nothing to relate to if we don't know which store this product belongs to
        try {
            // /products resolves "which store" from a ?store= query string
            // for logged-out visitors (see resolveContextStore on the API) —
            // omitting it here meant this always 404'd for an anonymous
            // shopper and silently showed "no related products".
            const response = await app.apiRequest(`/products?store=${encodeURIComponent(this.store.id)}`);
            const products = response.data || [];

            // Filter out current product and get random related products
            const related = products
                .filter(p => p.id !== this.product?.id)
                .slice(0, 4);

            this.renderRelatedProducts(related);
        } catch (error) {
            console.error('Failed to load related products:', error);
        }
    }

    renderRelatedProducts(products) {
        const container = document.getElementById('relatedProductsGrid');
        if (!container) return;

        // Hide loading state for related products
        document.getElementById('relatedLoadingState')?.classList.remove('active');
        document.getElementById('relatedContent')?.classList.remove('hidden');

        if (!products.length) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <p>No related products found.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = products.map(product => `
            <div class="related-product-card" data-product-id="${product.id}" role="button" tabindex="0" aria-label="${app.escapeHtml(product.name)}">
                <div class="related-product-image">
                    ${app.productThumb(product)
                        ? `<img src="${app.productThumb(product)}" alt="${app.escapeHtml(product.name)}" loading="lazy">`
                        : `<i class="fas ${product.icon || 'fa-box'}" style="font-size: 2rem; color: var(--gray-400);"></i>`}
                </div>
                <div class="related-product-details">
                    <h4>${app.escapeHtml(product.name)}</h4>
                    <div class="related-product-price">${app.formatCurrency(product.price)}</div>
                </div>
            </div>
        `).join('');

        const storeKey = this.store ? encodeURIComponent(this.store.slug || this.store.id) : '';
        container.querySelectorAll('[data-product-id]').forEach(card => {
            const go = () => { window.location.href = `product-detail.html?id=${encodeURIComponent(card.dataset.productId)}${storeKey ? `&store=${storeKey}` : ''}`; };
            card.addEventListener('click', go);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        });
    }
}

// Global functions for event handlers
let productDetailManager;

function updateCartQuantity(productId, change) {
    productDetailManager?.updateQuantity(productId, change);
}

function removeFromCart(productId) {
    productDetailManager?.removeFromCart(productId);
}

// Initialize
if (document.querySelector('.product-detail-main')) {
    productDetailManager = new ProductDetailManager();
}