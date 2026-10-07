class ProductDetailManager {
    constructor() {
        this.product = null;
        this.store = null;
        this.quantity = 1;
        this.isFavorite = false;
        this.galleryImages = [];
        this.activeImageIndex = 0;
        this.referrer = document.referrer;
        this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));
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
        // Quantity controls (capped by the stock that is actually still available)
        document.getElementById('decreaseQty')?.addEventListener('click', () => this.setQuantity(this.quantity - 1));
        document.getElementById('increaseQty')?.addEventListener('click', () => this.setQuantity(this.quantity + 1));
        document.getElementById('quantityInput')?.addEventListener('change', (e) => this.setQuantity(parseInt(e.target.value, 10)));

        // Keep stock / "already in your cart" messaging in step with the cart
        document.addEventListener('nextastore:cart-changed', () => this.renderStock());

        // Main gallery image: click / Enter opens the large viewer; swipe or arrows page through photos
        const main = document.getElementById('mainImage');
        main?.addEventListener('click', () => {
            if (this._swipeHandled) { this._swipeHandled = false; return; }
            if (this.galleryImages.length) this.openLightbox(this.activeImageIndex, main);
        });
        main?.addEventListener('keydown', (e) => {
            if (!this.galleryImages.length) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openLightbox(this.activeImageIndex, main); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); this.setActiveImage(this.activeImageIndex - 1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this.setActiveImage(this.activeImageIndex + 1); }
        });
        this.bindSwipe(main, (dir) => this.setActiveImage(this.activeImageIndex + dir));
        document.getElementById('galleryPrev')?.addEventListener('click', () => this.setActiveImage(this.activeImageIndex - 1));
        document.getElementById('galleryNext')?.addEventListener('click', () => this.setActiveImage(this.activeImageIndex + 1));
        this.setupLightbox();

        // "Read more" on a long description
        document.getElementById('readMoreBtn')?.addEventListener('click', (e) => {
            const desc = document.getElementById('productDescription');
            const clamped = desc.classList.toggle('is-clamped');
            e.currentTarget.textContent = clamped ? 'Read more' : 'Show less';
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

        // Back link: wired by js/back-nav.js (real "back" when the shopper came from
        // another page here; otherwise the fallback set in setupBackNavigation()).
    }

    /** Which product is this page for? At the product's own address
     *  (/<store>/<name>-<key>) the address only holds a short key, so the server
     *  puts the full id and the store in two <meta> tags of the page it serves.
     *  The old /product-detail?id=...&store=... form still works as a fallback
     *  (old bookmarks, a server that could not serve the page itself). */
    readRoute() {
        const meta = name => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
        const params = new URLSearchParams(window.location.search);
        return {
            productId: meta('nx-product-id') || params.get('id'),
            storeParam: meta('nx-store-slug') || params.get('store')
        };
    }

    /** Opened the old way (/product-detail?id=...), the address bar is rewritten
     *  to the product's own address once the product is known, so what people
     *  see, copy and share is the clean link. No reload; purely cosmetic. */
    cleanAddress() {
        try {
            if (document.querySelector('meta[name="nx-product-id"]')) return; // already at its own address
            const clean = app.productLink(this.product, this.store?.slug);
            if (!clean || clean.startsWith('/p/') || clean === '/marketplace') return;
            window.history.replaceState(window.history.state, '', clean + window.location.hash);
        } catch (e) { /* cosmetic */ }
    }

    async loadProductData() {
        try {
            const { productId, storeParam } = this.readRoute();

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
            this.cleanAddress();
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
                <a href="/marketplace">Marketplace</a>
                <span class="separator">/</span>
                <a href="${app.storeLink(this.store)}">${app.escapeHtml(this.store.name)}</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productBreadcrumb">${app.escapeHtml(this.product?.name || 'Product')}</span>
            `;
        } else {
            breadcrumbContainer.innerHTML = `
                <a href="/marketplace">Marketplace</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productBreadcrumb">${app.escapeHtml(this.product?.name || 'Product')}</span>
            `;
        }
    }

    /** Back goes to whatever page the shopper came from (store, favorites, cart,
     *  a notification, the marketplace...) — js/back-nav.js does that. The only
     *  thing this page decides is the FALLBACK, for someone who opened a bare
     *  product link (shared on WhatsApp, say) and has no earlier page here: a
     *  product belongs to a store, so that's where they're sent. */
    setupBackNavigation() {
        const backLink = document.getElementById('backLink');
        if (!backLink) return;
        if (this.store) {
            backLink.dataset.backFallback = app.storeLink(this.store);
            backLink.dataset.backFallbackLabel = 'Back to store';
        } else {
            backLink.dataset.backFallback = '/marketplace';
            backLink.dataset.backFallbackLabel = 'Back to marketplace';
        }
        window.NextaBack?.wire(backLink.parentElement || document);
        window.NextaBack?.refresh();
    }

    renderProductInfo() {
        if (!this.product) return;

        document.title = `${this.product.name} - NextaStore`;

        // Update breadcrumb
        this.updateBreadcrumb();

        // Update product info
        document.getElementById('productName').textContent = this.product.name;
        const descEl = document.getElementById('productDescription');
        descEl.textContent = this.product.description || 'No description available.';
        descEl.classList.add('is-clamped');
        requestAnimationFrame(() => {
            const btn = document.getElementById('readMoreBtn');
            if (btn) { btn.hidden = descEl.scrollHeight <= descEl.clientHeight + 1; btn.textContent = 'Read more'; }
        });
        document.getElementById('fullDescription').innerHTML = `<p>${app.escapeHtml(this.product.description || 'No detailed description available.')}</p>`;

        // Update price
        document.getElementById('currentPrice').textContent = (this.product.listingType === 'service' ? 'From ' : '') + app.formatCurrency(this.product.price);
        if (this.product.originalPrice && this.product.originalPrice > this.product.price) {
            document.getElementById('originalPrice').textContent = app.formatCurrency(this.product.originalPrice);
            const discount = Math.round((1 - this.product.price / this.product.originalPrice) * 100);
            document.getElementById('discountBadge').textContent = `-${discount}%`;
        }

        // Update meta information
        document.getElementById('productCategory').innerHTML = (window.NXCategories ? NXCategories.iconHTML(this.product.category, 18) : '') + '<span>' + app.escapeHtml(this.categoryLabel(this.product.category)) + '</span>';
        this.renderStock();

        // Update product image gallery
        this.galleryImages = Array.isArray(this.product.images) && this.product.images.length
            ? this.product.images
            : (this.product.image ? [this.product.image] : []);
        this.activeImageIndex = 0;
        this.renderGallery();

        // Update store info
        if (this.store) {
            document.getElementById('storeMiniName').textContent = this.store.name;
            document.getElementById('storeMiniBadges').innerHTML = app.renderSellerBadges(this.store, { limit: 2, more: true });
            document.getElementById('visitStoreBtn').href = app.storeLink(this.store);
            
            // Make sure store info card is visible
            const storeInfoCard = document.querySelector('.store-info-card');
            if (storeInfoCard) {
                storeInfoCard.style.display = 'block';
            }
            const pickup = document.getElementById('pickupInfo');
            const where = [this.store.district, this.store.address].filter(Boolean).join(' \u00b7 ');
            if (pickup && where) pickup.textContent = `Choose pickup at checkout to collect from ${this.store.name}: ${where}. No delivery address needed.`;

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

    categoryLabel(category) {
        if (window.NXCategories) return window.NXCategories.label(category);
        const key = String(category || '').toLowerCase();
        return key ? key.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()) : 'General';
    }

    /** Small (~480px) variant for the strips of thumbnails; falls back to the full image. */
    thumbUrl(i) {
        const thumbs = Array.isArray(this.product?.thumbnails) ? this.product.thumbnails : [];
        return app.resolveImageUrl(thumbs[i] || this.galleryImages[i]);
    }

    /** Thumbnail <img>s fall back to the full photo if the small variant fails to load. */
    bindThumbFallbacks(root) {
        root?.querySelectorAll('img[data-full]').forEach(img => {
            img.addEventListener('error', () => {
                if (img.dataset.fellBack) return;
                img.dataset.fellBack = '1';
                img.src = img.dataset.full;
            });
        });
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
            mainImage.classList.remove('is-zoomable');
            mainImage.removeAttribute('role');
            mainImage.removeAttribute('tabindex');
            mainImage.removeAttribute('aria-label');
            ['galleryPrev', 'galleryNext', 'galleryCounter', 'galleryZoomHint'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
            if (thumbGallery) thumbGallery.innerHTML = '';
            return;
        }

        const count = this.galleryImages.length;
        if (thumbGallery) {
            if (count > 1) {
                thumbGallery.innerHTML = this.galleryImages.map((src, i) => `
                    <button type="button" class="thumbnail-item" data-index="${i}" aria-label="View image ${i + 1} of ${count}">
                        <img src="${this.thumbUrl(i)}" data-full="${app.resolveImageUrl(src)}" alt="" loading="lazy" decoding="async">
                    </button>
                `).join('');
                thumbGallery.querySelectorAll('.thumbnail-item').forEach(btn => {
                    btn.addEventListener('click', () => this.setActiveImage(parseInt(btn.dataset.index, 10)));
                });
                this.bindThumbFallbacks(thumbGallery);
            } else {
                thumbGallery.innerHTML = '';
            }
        }
        this.setActiveImage(this.activeImageIndex);
    }

    setActiveImage(index) {
        const count = this.galleryImages.length;
        if (!count) return;
        index = ((index % count) + count) % count; // wrap around at both ends
        this.activeImageIndex = index;

        const mainImage = document.getElementById('mainImage');
        if (mainImage) {
            const name = this.product?.name || 'Product';
            const label = count > 1 ? `${name}, image ${index + 1} of ${count}` : name;
            mainImage.innerHTML = `<img src="${app.resolveImageUrl(this.galleryImages[index])}" alt="${app.escapeHtml(label)}" decoding="async">`;
            mainImage.querySelector('img')?.addEventListener('error', () => {
                mainImage.innerHTML = `<div class="image-placeholder"><i class="fas ${this.product?.icon || 'fa-box'}"></i></div>`;
            }, { once: true });
            mainImage.classList.add('is-zoomable');
            mainImage.setAttribute('role', 'button');
            mainImage.setAttribute('tabindex', '0');
            mainImage.setAttribute('aria-label', `Enlarge image${count > 1 ? ` (${index + 1} of ${count})` : ''}`);
        }

        document.querySelectorAll('#thumbnailGallery .thumbnail-item').forEach((btn, i) => {
            btn.classList.toggle('active', i === index);
            btn.setAttribute('aria-current', i === index ? 'true' : 'false');
        });

        const multi = count > 1;
        const prev = document.getElementById('galleryPrev');
        const next = document.getElementById('galleryNext');
        const counter = document.getElementById('galleryCounter');
        const hint = document.getElementById('galleryZoomHint');
        if (prev) prev.hidden = !multi;
        if (next) next.hidden = !multi;
        if (counter) { counter.hidden = !multi; counter.textContent = `${index + 1} / ${count}`; }
        if (hint) hint.hidden = false;

        // warm the neighbours so paging feels instant
        if (multi) [index - 1, index + 1].forEach(n => this.preloadImage(n));
    }

    preloadImage(index) {
        const count = this.galleryImages.length;
        if (!count) return;
        const src = this.galleryImages[((index % count) + count) % count];
        if (src) new Image().src = app.resolveImageUrl(src);
    }

    /** Horizontal swipe on touch/pen. A swipe must not also count as the click that opens the viewer. */
    bindSwipe(el, onSwipe) {
        if (!el) return;
        let start = null;
        el.addEventListener('pointerdown', (e) => {
            start = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
        });
        el.addEventListener('pointerup', (e) => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            start = null;
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                this._swipeHandled = true;
                setTimeout(() => { this._swipeHandled = false; }, 350);
                onSwipe(dx < 0 ? 1 : -1);
            }
        });
        el.addEventListener('pointercancel', () => { start = null; });
    }

    /* ------------------------------------------------------------------
       Image viewer (lightbox): full-screen photo with paging, zoom and pan.
       Esc / arrows / +/- on a keyboard; swipe, pinch and tap-to-zoom on a
       phone; scroll-wheel zoom and drag-to-pan on a desktop. The browser's
       Back button closes it instead of leaving the product page.
       ------------------------------------------------------------------ */
    setupLightbox() {
        const el = document.getElementById('lightbox');
        if (!el) return;
        const lb = this.lb = {
            el,
            stage: document.getElementById('lightboxStage'),
            img: document.getElementById('lightboxImg'),
            open: false, pushed: false, trigger: null, index: 0,
            scale: 1, tx: 0, ty: 0,
            pointers: new Map(), gesture: null, pinch: null
        };

        document.getElementById('lightboxClose')?.addEventListener('click', () => this.closeLightbox());
        document.getElementById('lightboxZoom')?.addEventListener('click', () => this.zoomAt(lb.scale > 1 ? 1 : 2.5));
        document.getElementById('lightboxPrev')?.addEventListener('click', () => this.stepLightbox(-1));
        document.getElementById('lightboxNext')?.addEventListener('click', () => this.stepLightbox(1));

        document.addEventListener('keydown', (e) => {
            if (!lb.open) return;
            if (e.key === 'Escape') { e.preventDefault(); this.closeLightbox(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); this.stepLightbox(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this.stepLightbox(1); }
            else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomAt(lb.scale * 1.5); }
            else if (e.key === '-') { e.preventDefault(); this.zoomAt(lb.scale / 1.5); }
            else if (e.key === 'Tab') {
                const focusable = [...el.querySelectorAll('button')].filter(b => !b.hidden && b.offsetParent !== null);
                if (!focusable.length) return;
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            }
        });

        // Browser Back closes the viewer rather than leaving the page
        window.addEventListener('popstate', () => {
            if (lb.open) { lb.pushed = false; this.hideLightbox(); }
        });

        lb.stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.zoomAt(lb.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
        }, { passive: false });

        lb.stage.addEventListener('pointerdown', (e) => {
            try { lb.stage.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone: gestures still work without capture */ }
            lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (lb.pointers.size === 1) {
                lb.gesture = { startX: e.clientX, startY: e.clientY, t: Date.now(), moved: false, tx: lb.tx, ty: lb.ty, onImg: e.target === lb.img };
            } else if (lb.pointers.size === 2) {
                const [a, b] = [...lb.pointers.values()];
                lb.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: lb.scale };
                if (lb.gesture) lb.gesture.moved = true;
            }
        });

        lb.stage.addEventListener('pointermove', (e) => {
            const p = lb.pointers.get(e.pointerId);
            if (!p) return;
            p.x = e.clientX; p.y = e.clientY;
            if (lb.pointers.size === 2 && lb.pinch) {
                const [a, b] = [...lb.pointers.values()];
                this.zoomAt(lb.pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / lb.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
                return;
            }
            const g = lb.gesture;
            if (!g) return;
            const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;
            if (lb.scale > 1) {
                lb.tx = g.tx + dx; lb.ty = g.ty + dy;
                this.clampPan();
                this.applyTransform();
            }
        });

        const end = (e) => {
            if (!lb.pointers.has(e.pointerId)) return;
            lb.pointers.delete(e.pointerId);
            if (lb.pinch && lb.pointers.size < 2) {
                lb.pinch = null;
                if (lb.scale < 1.05) this.zoomAt(1);
            }
            if (lb.pointers.size > 0) { // one finger left after a pinch: carry on panning from where it is
                const rest = [...lb.pointers.values()][0];
                lb.gesture = { startX: rest.x, startY: rest.y, t: Date.now(), moved: true, tx: lb.tx, ty: lb.ty, onImg: true };
                return;
            }
            const g = lb.gesture;
            lb.gesture = null;
            if (!g || e.type === 'pointercancel') return;
            const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
            if (!g.moved && Date.now() - g.t < 500) {
                if (g.onImg) this.zoomAt(lb.scale > 1 ? 1 : 2.5, e.clientX, e.clientY); // tap the photo: zoom in/out
                else if (lb.scale === 1) this.closeLightbox();                             // tap the dark area: close
            } else if (lb.scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                this.stepLightbox(dx < 0 ? 1 : -1);                                        // swipe: next / previous
            } else if (lb.scale === 1 && dy > 90 && dy > Math.abs(dx) * 1.5) {
                this.closeLightbox();                                                      // swipe down: close
            }
        };
        lb.stage.addEventListener('pointerup', end);
        lb.stage.addEventListener('pointercancel', end);
    }

    openLightbox(index, trigger) {
        const lb = this.lb;
        if (!lb?.el || !this.galleryImages.length || lb.open) return;
        lb.trigger = trigger || document.activeElement;
        lb.open = true;
        lb.el.hidden = false;
        lb.el.classList.toggle('is-single', this.galleryImages.length < 2);
        document.documentElement.classList.add('lightbox-open');

        const thumbs = document.getElementById('lightboxThumbs');
        if (thumbs) {
            thumbs.innerHTML = this.galleryImages.length > 1 ? this.galleryImages.map((src, i) => `
                <button type="button" class="lightbox-thumb" data-index="${i}" aria-label="View image ${i + 1} of ${this.galleryImages.length}">
                    <img src="${this.thumbUrl(i)}" data-full="${app.resolveImageUrl(src)}" alt="" decoding="async">
                </button>`).join('') : '';
            thumbs.querySelectorAll('.lightbox-thumb').forEach(btn => btn.addEventListener('click', () => this.showLightboxImage(parseInt(btn.dataset.index, 10))));
            this.bindThumbFallbacks(thumbs);
        }
        this.showLightboxImage(index);

        try { history.pushState({ nxLightbox: 1 }, ''); lb.pushed = true; } catch (e) { lb.pushed = false; }
        requestAnimationFrame(() => lb.el.classList.add('is-open'));
        document.getElementById('lightboxClose')?.focus();
    }

    closeLightbox() {
        const lb = this.lb;
        if (!lb?.open) return;
        this.hideLightbox();
        if (lb.pushed) {
            lb.pushed = false;
            if (history.state && history.state.nxLightbox) history.back();
        }
    }

    hideLightbox() {
        const lb = this.lb;
        lb.open = false;
        lb.el.classList.remove('is-open');
        lb.el.hidden = true;
        document.documentElement.classList.remove('lightbox-open');
        lb.pointers.clear(); lb.gesture = null; lb.pinch = null;
        this.resetZoom();
        lb.img.removeAttribute('src');
        if (lb.trigger && document.contains(lb.trigger)) lb.trigger.focus?.();
        lb.trigger = null;
    }

    stepLightbox(delta) {
        if (this.galleryImages.length > 1) this.showLightboxImage(this.lb.index + delta);
    }

    showLightboxImage(index) {
        const lb = this.lb;
        const count = this.galleryImages.length;
        index = ((index % count) + count) % count;
        lb.index = index;
        this.resetZoom();

        lb.stage.classList.add('is-loading');
        lb.img.onload = () => lb.stage.classList.remove('is-loading');
        lb.img.onerror = () => lb.stage.classList.remove('is-loading');
        lb.img.alt = `${this.product?.name || 'Product'}${count > 1 ? `, image ${index + 1} of ${count}` : ''}`;
        lb.img.src = app.resolveImageUrl(this.galleryImages[index]);
        if (lb.img.complete && lb.img.naturalWidth) lb.stage.classList.remove('is-loading');

        const counter = document.getElementById('lightboxCount');
        if (counter) counter.textContent = count > 1 ? `${index + 1} / ${count}` : '';
        document.querySelectorAll('#lightboxThumbs .lightbox-thumb').forEach((btn, i) => {
            btn.classList.toggle('active', i === index);
            btn.setAttribute('aria-current', i === index ? 'true' : 'false');
            if (i === index) btn.scrollIntoView?.({ block: 'nearest', inline: 'center' });
        });

        this.setActiveImage(index); // the page behind the viewer follows along
        if (count > 1) { this.preloadImage(index - 1); this.preloadImage(index + 1); }
    }

    /** Zoom to newScale keeping the point (qx, qy) under the finger/cursor; defaults to the middle of the stage. */
    zoomAt(newScale, qx, qy) {
        const lb = this.lb;
        newScale = Math.max(1, Math.min(4, newScale));
        const r = lb.stage.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (qx === undefined) { qx = cx; qy = cy; }
        const ux = (qx - cx - lb.tx) / lb.scale, uy = (qy - cy - lb.ty) / lb.scale;
        lb.scale = newScale;
        lb.tx = qx - cx - ux * newScale;
        lb.ty = qy - cy - uy * newScale;
        if (newScale === 1) { lb.tx = 0; lb.ty = 0; }
        this.clampPan();
        this.applyTransform();
    }

    clampPan() {
        const lb = this.lb;
        const maxX = Math.max(0, (lb.img.offsetWidth * lb.scale - lb.stage.clientWidth) / 2);
        const maxY = Math.max(0, (lb.img.offsetHeight * lb.scale - lb.stage.clientHeight) / 2);
        lb.tx = Math.max(-maxX, Math.min(maxX, lb.tx));
        lb.ty = Math.max(-maxY, Math.min(maxY, lb.ty));
    }

    applyTransform() {
        const lb = this.lb;
        lb.img.style.transform = lb.scale === 1 ? '' : `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
        lb.stage.classList.toggle('is-zoomed', lb.scale > 1);
        const zoomBtn = document.getElementById('lightboxZoom');
        if (zoomBtn) {
            const zoomed = lb.scale > 1;
            zoomBtn.setAttribute('aria-label', zoomed ? 'Zoom out' : 'Zoom in');
            const icon = zoomBtn.querySelector('i');
            if (icon) { icon.classList.toggle('fa-magnifying-glass-minus', zoomed); icon.classList.toggle('fa-magnifying-glass-plus', !zoomed); }
        }
    }

    resetZoom() {
        const lb = this.lb;
        if (!lb) return;
        lb.scale = 1; lb.tx = 0; lb.ty = 0;
        this.applyTransform();
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
                <a href="/marketplace">Marketplace</a>
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
        ['decreaseQty', 'increaseQty', 'quantityInput', 'favoriteBtn', 'shareBtn', 'messageSellerBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
        });
        const stockMeta = document.getElementById('stockMeta');
        if (stockMeta) stockMeta.style.display = 'none';
        const related = document.getElementById('relatedSection');
        if (related) related.hidden = true;
    }

    inCartQuantity() {
        const item = (window.NextaCart?.items || []).find(i => i.productId === this.product?.id);
        return item ? Number(item.quantity) || 0 : 0;
    }

    /** Most the shopper can still add: what's in stock, minus what's already in their cart, capped at 99. */
    maxQuantity() {
        const stock = Number(this.product?.stock);
        if (!Number.isFinite(stock)) return 99;
        return Math.max(0, Math.min(99, stock - this.inCartQuantity()));
    }

    setQuantity(n) {
        const max = this.maxQuantity();
        if (!Number.isFinite(n)) n = this.quantity;
        this.quantity = Math.max(1, Math.min(n, Math.max(max, 1)));
        this.updateQuantityDisplay();
    }

    updateQuantityDisplay() {
        const input = document.getElementById('quantityInput');
        if (input) {
            input.value = this.quantity;
            input.max = String(Math.max(this.maxQuantity(), 1));
        }
        const max = this.maxQuantity();
        const dec = document.getElementById('decreaseQty');
        const inc = document.getElementById('increaseQty');
        if (dec) dec.disabled = max < 1 || this.quantity <= 1;
        if (inc) inc.disabled = max < 1 || this.quantity >= max;
    }

    /** Stock line, low-stock / sold-out states, "already in your cart" hint, and the Add to Cart button's state. */
    /** Services and digital items have no cart or stock: shoppers enquire through Messages. */
    applyListingType() {
        const t = this.product && this.product.listingType;
        if (!t || t === 'physical') return false;
        const hide = (el) => { if (el) el.style.display = 'none'; };
        hide(document.querySelector('.quantity-section'));
        hide(document.getElementById('addToCartBtn'));
        const text = document.getElementById('productStockText');
        const icon = document.querySelector('#stockMeta i');
        const parts = [];
        if (t === 'service') {
            if (this.product.serviceArea) parts.push('Works in: ' + this.product.serviceArea);
            if (this.product.serviceDuration) parts.push('Usually takes: ' + this.product.serviceDuration);
            if (icon) icon.className = 'fas fa-location-dot';
        } else if (icon) icon.className = 'fas fa-file-arrow-down';
        if (!parts.length) parts.push(t === 'service' ? 'A service: message the seller to agree the details' : 'A digital item: message the seller to arrange it');
        if (text) text.textContent = parts.join(' \u00b7 ');
        const btn = document.getElementById('messageSellerBtn');
        if (btn) { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary', 'btn-block'); btn.innerHTML = '<i class="fas fa-message"></i> ' + (t === 'service' ? 'Request a quote' : 'Message seller'); }
        return true;
    }

    renderStock() {
        if (!this.product) return;
        if (this.applyListingType()) return;
        const stock = Number(this.product.stock);
        const known = Number.isFinite(stock);
        const inCart = this.inCartQuantity();
        const remaining = known ? Math.max(0, stock - inCart) : Infinity;

        const stockText = document.getElementById('productStockText');
        if (stockText) {
            if (known && stock <= 0) stockText.innerHTML = '<strong class="stock-out">Out of stock</strong>';
            else if (known && stock <= 3) stockText.innerHTML = `<strong class="stock-low">Only ${stock} left</strong> &mdash; order soon`;
            else if (known) stockText.innerHTML = `<strong class="stock-in">In stock</strong> &middot; ${stock} available`;
            else stockText.textContent = 'Availability: ask the seller';
        }

        const hint = document.getElementById('qtyHint');
        if (hint) {
            hint.textContent = known && stock > 0 && inCart > 0
                ? (remaining === 0 ? `You have all ${stock} available in your cart.` : `${inCart} already in your cart.`)
                : '';
        }

        const btn = document.getElementById('addToCartBtn');
        if (btn) {
            if (known && stock <= 0) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-ban"></i> Out of stock';
            } else if (remaining === 0) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-check"></i> All available are in your cart';
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-cart-plus"></i> Add to Cart';
            }
        }
        this.setQuantity(this.quantity);
    }

    addToCart() {
        if (!this.product) return;
        const stock = Number(this.product.stock);
        if (Number.isFinite(stock)) {
            const inCart = this.inCartQuantity();
            const remaining = stock - inCart;
            if (stock <= 0) return app.showAlert('This product is out of stock.', 'error');
            if (remaining <= 0) return app.showAlert(`You already have all ${stock} available in your cart.`, 'warning');
            if (this.quantity > remaining) {
                return app.showAlert(inCart
                    ? `Only ${remaining} more available \u2014 you already have ${inCart} in your cart.`
                    : `Only ${remaining} left in stock.`, 'warning');
            }
        }
        const qty = this.quantity;
        try {
            window.NextaCart.add(this.product, qty, this.store);
            app.showAlert(`Added ${qty} ${qty === 1 ? 'item' : 'items'} to cart`, 'success');
        } catch (error) {
            app.showAlert(error.message, 'error');
        }
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

    /** The address to hand out for this product: its own address,
     *  <origin>/<store>/<name>-<key>. It is the address this page is at, and the
     *  server answers it with this product's photo, name and price as link-preview
     *  tags, so it previews properly wherever it is pasted. Computed rather than
     *  read from the address bar so it is right even when the page was opened the
     *  old way. */
    shareUrl() {
        return this.product?.id
            ? `${window.location.origin}${app.productLink(this.product, this.store?.slug)}`
            : window.location.href;
    }

    async openShareModal() {
        // On a phone, hand off to the system share sheet (WhatsApp, Messages, ...);
        // on desktop, or if the sheet fails, use the in-page options.
        if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
            try {
                await navigator.share({
                    title: this.product?.name || 'NextaStore',
                    text: `Check out ${this.product?.name || 'this amazing product'} on NextaStore!`,
                    url: this.shareUrl()
                });
                return;
            } catch (error) {
                if (error && error.name === 'AbortError') return; // shopper dismissed the sheet
            }
        }
        document.getElementById('shareModal').classList.add('open');
    }

    copyToClipboard(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => { // older browsers / non-secure origins
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
            catch (e) { reject(e); }
            finally { ta.remove(); }
        });
    }

    handleShare(platform) {
        const url = this.shareUrl();
        const title = `Check out ${this.product?.name || 'this amazing product'} on NextaStore!`;

        switch (platform) {
            case 'whatsapp':
                window.open(`https://wa.me/?text=${encodeURIComponent(title + ' ' + url)}`, '_blank', 'noopener');
                break;
            case 'facebook':
                window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank', 'noopener');
                break;
            case 'twitter':
                window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
                break;
            case 'copy':
                this.copyToClipboard(url)
                    .then(() => app.showAlert('Link copied to clipboard!', 'success'))
                    .catch(() => app.showAlert('Could not copy the link. Copy it from the address bar instead.', 'error'));
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
        const section = document.getElementById('relatedSection');
        // Without a store there is nothing to relate to: drop the section (its skeleton used to hang around forever)
        if (!this.store) { if (section) section.hidden = true; return; }

        const title = document.getElementById('relatedTitle');
        if (title) title.textContent = `More from ${this.store.name}`;
        const viewAll = document.getElementById('relatedViewAll');
        if (viewAll) viewAll.href = app.storeLink(this.store);

        try {
            // /products resolves "which store" from a ?store= query string
            // for logged-out visitors (see resolveContextStore on the API) —
            // omitting it here meant this always 404'd for an anonymous
            // shopper and silently showed "no related products".
            const response = await app.apiRequest(`/products?store=${encodeURIComponent(this.store.id)}&limit=24`);
            const others = (response.data || []).filter(p => p.id !== this.product?.id);
            // same category first, then the rest of the store's newest products
            const sameCategory = others.filter(p => p.category && p.category === this.product?.category);
            const rest = others.filter(p => !sameCategory.includes(p));
            const related = [...sameCategory, ...rest].slice(0, 4);
            if (!related.length) { if (section) section.hidden = true; return; }
            this.renderRelatedProducts(related);
        } catch (error) {
            console.error('Failed to load related products:', error);
            if (section) section.hidden = true;
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

        const storeKey = this.store ? (this.store.slug || this.store.id) : '';
        container.querySelectorAll('[data-product-id]').forEach(card => {
            const go = () => {
                const related = products.find(p => p.id === card.dataset.productId);
                window.location.href = app.productLink({ id: card.dataset.productId, name: related?.name }, storeKey);
            };
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