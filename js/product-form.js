/* ==========================================================================
   Product Form Page
   ========================================================================== */

class ProductFormPage {
    constructor() {
        this.params = new URLSearchParams(window.location.search);
        this.productId = this.params.get('id');
        // Arriving here from onboarding's "Add your first product" gate
        // (step 4, zero products) means Products/Dashboard don't exist as
        // a destination yet — the store isn't live. Send the seller back
        // to the review step instead, where the launch gate re-checks the
        // product count itself.
        this.fromOnboarding = this.params.get('from') === 'onboarding';
        this.returnTo = this.fromOnboarding ? 'onboarding.html?step=4' : 'dashboard.html#products';
        this.images = []; // [{ full, thumb }], [0] is the cover image
        this.isEditing = Boolean(this.productId);
        this.saving = false;
        this.dirty = false; // set true on any real edit, so we can warn before it's lost

        // Draft mode (new products only — see loadDraftIfAny): autosaves
        // form state to localStorage so a refresh or crash mid-listing
        // doesn't mean starting over from a blank form.
        this.draftSaveTimer = null;
        this.draftStatusTimer = null;

        this.init();
    }

    /** Scoped per seller so a shared/public browser can't leak one
     *  account's in-progress listing into another's draft prompt. */
    get draftKey() {
        return `nextastore_product_draft_${app.user?.id || 'anon'}`;
    }

    async init() {
        document.getElementById('backLink').href = this.returnTo;

        // Update breadcrumb
        const breadcrumbContainer = document.querySelector('.breadcrumb');
        if (breadcrumbContainer) {
            breadcrumbContainer.innerHTML = this.fromOnboarding ? `
                <a href="onboarding.html?step=4">Store setup</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productFormBreadcrumb">Add Product</span>
            ` : `
                <a href="dashboard.html">Dashboard</a>
                <span class="separator">/</span>
                <a href="dashboard.html" onclick="document.querySelector('[data-section=products]').click(); return false;">Products</a>
                <span class="separator">/</span>
                <span class="breadcrumb-current" id="productFormBreadcrumb">${this.isEditing ? 'Edit Product' : 'Add Product'}</span>
            `;
        }

        // The back button's own label ("Back to Products") is wrong here —
        // there's no Products list to go back to until the store is live.
        if (this.fromOnboarding) {
            const full = document.querySelector('#backLink .back-btn-text-full');
            if (full) full.textContent = 'Back to store setup';
        }

        if (this.isEditing) {
            document.getElementById('pageTitle').textContent = 'Edit Product - NextaStore';
            document.getElementById('formHeading').textContent = 'Edit product';
            document.getElementById('formSubheading').textContent = 'Update the details shoppers see on your store.';
            document.getElementById('saveBtn').innerHTML = '<i class="fas fa-check"></i> Save Changes';
            document.getElementById('deleteBtn').style.display = '';
            await this.loadProduct();
        } else {
            if (this.fromOnboarding) {
                document.getElementById('formHeading').textContent = 'Add your first product';
                document.getElementById('formSubheading').textContent = 'One product is enough to launch — you can add the rest anytime from your dashboard. You\u2019ll return to Review & Launch after saving.';
            }
            await this.loadDraftIfAny();
        }

        this.renderGallery();
        this.setupEvents();
        this.updateCounters();
        this.updatePricePreview();
    }

    async loadProduct() {
        // Disable the form while the existing product's data loads so
        // nothing can be typed into a field that's about to be overwritten
        // — same reasoning as dashboard.js's Settings > Store form.
        const form = document.getElementById('productForm');
        const fields = form?.querySelectorAll('input, textarea, select, button');
        fields?.forEach(el => { el.disabled = true; });

        try {
            const res = await app.apiRequest(`/products/${this.productId}`);
            const p = res.data;
            document.getElementById('productName').value = p.name || '';
            document.getElementById('productDescription').value = p.description || '';
            document.getElementById('productCategory').value = p.category || '';
            document.getElementById('productPrice').value = p.price ?? '';
            document.getElementById('productOriginalPrice').value = p.originalPrice ?? '';
            document.getElementById('productStock').value = p.stock ?? 0;
            // Pair each full image with its existing thumbnail by index
            // (item 5) — falling back to the full image itself for any
            // product saved before thumbnails existed, or if the arrays
            // are somehow out of sync. Newly-added images get a real
            // client-generated thumbnail in handleImageSelect below;
            // these carried-over pairs just aren't re-encoded on save.
            const fulls = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : []);
            const thumbs = Array.isArray(p.thumbnails) ? p.thumbnails : [];
            this.images = fulls.map((full, i) => ({ full, thumb: thumbs[i] || full }));
        } catch (err) {
            app.showAlert(err.message || 'Could not load this product.', 'error');
            setTimeout(() => { window.location.href = this.returnTo; }, 1200);
        } finally {
            fields?.forEach(el => { el.disabled = false; });
        }
    }

    renderGallery() {
        const gallery = document.getElementById('imageGallery');
        // Tiles show the small thumbnail (not the full-size upload) — this
        // editor grid renders the exact same size crop as a marketplace
        // card, so there's no reason to decode a multi-megabyte image just
        // to paint a ~90px square.
        const tiles = this.images.map((item, i) => `
            <div class="gallery-tile" data-index="${i}">
                <img src="${app.resolveImageUrl(item.thumb || item.full)}" alt="Product photo ${i + 1}">
                ${i === 0 ? '<span class="cover-badge">Cover</span>' : ''}
                <button type="button" class="remove-image" data-remove="${i}" aria-label="Remove photo"><i class="fas fa-times"></i></button>
            </div>
        `).join('');

        const addTile = this.images.length < 6 ? `
            <div class="gallery-add-tile" id="addImageTile">
                <i class="fas fa-cloud-arrow-up"></i>
                <span>Add photo</span>
            </div>
        ` : '';

        gallery.innerHTML = tiles + addTile;

        gallery.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = Number(btn.dataset.remove);
                this.images.splice(idx, 1);
                this.dirty = true;
                this.scheduleDraftSave();
                this.renderGallery();
            });
        });

        const addTileEl = document.getElementById('addImageTile');
        addTileEl?.addEventListener('click', () => document.getElementById('imageInput').click());

        // Adding/removing a photo clears the "add at least one photo" error
        // right away instead of leaving a stale error visible until the
        // next full-form submit.
        if (this.images.length) this.clearImageGalleryError();
    }

    setupEvents() {
        document.getElementById('imageInput').addEventListener('change', (e) => this.handleImageSelect(e));

        document.getElementById('productForm').addEventListener('submit', (e) => this.handleSubmit(e));

        document.getElementById('deleteBtn')?.addEventListener('click', () => this.handleDelete());

        // Header quick-save mirrors the bottom Save button so a seller
        // filling a long form doesn't have to scroll down to submit.
        document.getElementById('saveBtnTop')?.addEventListener('click', () => {
            document.getElementById('productForm').requestSubmit();
        });

        // Live validation: check a field as soon as the person leaves it,
        // and clear the error the moment they start fixing it, rather than
        // making them resubmit the whole form to find out it's ok now.
        const name = document.getElementById('productName');
        const price = document.getElementById('productPrice');
        const originalPrice = document.getElementById('productOriginalPrice');
        const stock = document.getElementById('productStock');
        const description = document.getElementById('productDescription');

        name?.addEventListener('blur', () => this.validateField('name'));
        name?.addEventListener('input', () => { this.clearFieldErrorById('productName', 'productNameError'); this.updateCounters(); });

        price?.addEventListener('blur', () => this.validateField('price'));
        price?.addEventListener('input', () => { this.clearFieldErrorById('productPrice', 'productPriceError'); this.updatePricePreview(); });

        originalPrice?.addEventListener('blur', () => this.validateField('originalPrice'));
        originalPrice?.addEventListener('input', () => this.clearFieldErrorById('productOriginalPrice', 'productOriginalPriceError'));

        stock?.addEventListener('blur', () => this.validateField('stock'));
        stock?.addEventListener('input', () => this.clearFieldErrorById('productStock', 'productStockError'));

        const category = document.getElementById('productCategory');
        category?.addEventListener('change', () => this.validateField('category'));

        description?.addEventListener('input', () => this.updateCounters());

        // Track unsaved changes so navigating away (browser back/refresh, or
        // the in-app "Back to Products" link) can warn before work is lost.
        document.getElementById('productForm').addEventListener('input', () => { this.dirty = true; this.scheduleDraftSave(); });
        document.getElementById('productForm').addEventListener('change', () => { this.dirty = true; this.scheduleDraftSave(); });

        window.addEventListener('beforeunload', (e) => {
            if (!this.dirty || this.saving) return;
            e.preventDefault();
            e.returnValue = '';
        });

        document.getElementById('backLink')?.addEventListener('click', async (e) => {
            if (!this.dirty) return;
            e.preventDefault();
            const leave = await app.confirm({
                title: 'Discard unsaved changes?',
                message: 'You have edits to this product that haven\'t been saved yet.',
                confirmText: 'Discard changes',
                cancelText: 'Keep editing',
                tone: 'danger'
            });
            if (leave) { this.dirty = false; this.clearDraft(); window.location.href = this.returnTo; }
        });
    }

    /** Debounces autosaves so a draft write happens once typing pauses
     *  (~700ms) rather than on every keystroke. */
    scheduleDraftSave() {
        if (this.isEditing) return; // drafts only apply to new listings
        clearTimeout(this.draftSaveTimer);
        this.draftSaveTimer = setTimeout(() => this.saveDraft(), 700);
    }

    /** Persists the current form state to localStorage. Photo data URLs
     *  are by far the biggest thing in a draft and can blow past the
     *  browser's localStorage quota on their own, so this degrades in
     *  steps rather than losing the whole draft (including the seller's
     *  typed text) to one QuotaExceededError: full-size photos first,
     *  then thumbnail-only photos, then text with no photos at all. */
    saveDraft() {
        if (this.isEditing) return;

        const fields = {
            name: document.getElementById('productName').value,
            description: document.getElementById('productDescription').value,
            category: document.getElementById('productCategory').value,
            price: document.getElementById('productPrice').value,
            originalPrice: document.getElementById('productOriginalPrice').value,
            stock: document.getElementById('productStock').value
        };
        const hasText = Object.values(fields).some(v => String(v || '').trim());
        if (!hasText && !this.images.length) { this.clearDraft(); return; }

        const write = (images, degraded) => {
            localStorage.setItem(this.draftKey, JSON.stringify({ savedAt: Date.now(), fields, images, degraded }));
        };
        try {
            write(this.images, false);
        } catch (err) {
            try {
                // Drop down to the small (~480px) thumbnails already
                // generated for the gallery grid, in place of full photos.
                write(this.images.map(item => ({ full: item.thumb || item.full, thumb: item.thumb || item.full })), true);
            } catch (err2) {
                try {
                    write([], true);
                } catch (err3) {
                    return; // storage unavailable or full — draft is a convenience, not a requirement
                }
            }
        }
        this.showDraftStatus();
    }

    showDraftStatus() {
        const el = document.getElementById('draftStatus');
        if (!el) return;
        el.textContent = 'Draft saved';
        el.classList.add('is-visible');
        clearTimeout(this.draftStatusTimer);
        this.draftStatusTimer = setTimeout(() => el.classList.remove('is-visible'), 2000);
    }

    /** Checks for a leftover draft from an earlier, never-submitted "Add
     *  Product" session (closed tab, refresh, crash) and offers to resume
     *  it, rather than silently overwriting or silently discarding it. */
    async loadDraftIfAny() {
        let raw;
        try { raw = localStorage.getItem(this.draftKey); } catch (err) { return; }
        if (!raw) return;

        let draft;
        try { draft = JSON.parse(raw); } catch (err) { this.clearDraft(); return; }
        if (!draft || typeof draft !== 'object') { this.clearDraft(); return; }

        const restore = await app.confirm({
            title: 'Resume your draft?',
            message: `You have an unfinished product from ${this.formatDraftAge(draft.savedAt)}. Pick up where you left off, or start a new listing?`,
            confirmText: 'Resume draft',
            cancelText: 'Start fresh'
        });

        if (!restore) { this.clearDraft(); return; }
        this.applyDraft(draft);
    }

    applyDraft(draft) {
        const f = draft.fields || {};
        if (f.name != null) document.getElementById('productName').value = f.name;
        if (f.description != null) document.getElementById('productDescription').value = f.description;
        if (f.category != null) document.getElementById('productCategory').value = f.category;
        if (f.price != null) document.getElementById('productPrice').value = f.price;
        if (f.originalPrice != null) document.getElementById('productOriginalPrice').value = f.originalPrice;
        if (f.stock != null) document.getElementById('productStock').value = f.stock;
        this.images = Array.isArray(draft.images) ? draft.images : [];
        this.dirty = true;

        if (draft.degraded && this.images.length) {
            app.showAlert('Draft restored — photos were kept at reduced quality to fit local storage. Consider re-adding them for full quality.', 'warning');
        } else {
            app.showAlert('Draft restored.', 'success');
        }
    }

    clearDraft() {
        try { localStorage.removeItem(this.draftKey); } catch (err) { /* ignore */ }
    }

    formatDraftAge(savedAt) {
        const diffMs = Date.now() - (savedAt || 0);
        const mins = Math.round(diffMs / 60000);
        if (mins < 1) return 'moments ago';
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        return app.formatDate(savedAt);
    }

    /** Live per-field validation used on blur/input, and reused by the
     *  full-form check on submit so the rules only live in one place. */
    validateField(key) {
        if (key === 'name') {
            const field = document.getElementById('productName');
            const value = field.value.trim();
            if (!value) return this.setFieldError('productName', 'productNameError', 'Give your product a name so shoppers can find it.');
            if (value.length < 3) return this.setFieldError('productName', 'productNameError', 'Product name should be at least 3 characters.');
            this.clearFieldErrorById('productName', 'productNameError');
            return true;
        }
        if (key === 'price') {
            const field = document.getElementById('productPrice');
            const value = field.value.trim();
            if (!value) return this.setFieldError('productPrice', 'productPriceError', 'Enter a price so customers know what to pay.');
            if (Number(value) <= 0) return this.setFieldError('productPrice', 'productPriceError', 'Price must be greater than 0.');
            this.clearFieldErrorById('productPrice', 'productPriceError');
            return true;
        }
        if (key === 'originalPrice') {
            const field = document.getElementById('productOriginalPrice');
            const price = Number(document.getElementById('productPrice').value || 0);
            const value = field.value.trim();
            if (value && price && Number(value) <= price) {
                return this.setFieldError('productOriginalPrice', 'productOriginalPriceError', 'Original price should be higher than your price, or shoppers won\'t see a discount.');
            }
            this.clearFieldErrorById('productOriginalPrice', 'productOriginalPriceError');
            return true;
        }
        if (key === 'stock') {
            const field = document.getElementById('productStock');
            const value = field.value.trim();
            if (value !== '' && Number(value) < 0) return this.setFieldError('productStock', 'productStockError', 'Stock can\'t be negative.');
            this.clearFieldErrorById('productStock', 'productStockError');
            return true;
        }
        if (key === 'category') {
            const field = document.getElementById('productCategory');
            if (!field.value) return this.setFieldError('productCategory', 'productCategoryError', 'Choose a category so shoppers can find this listing while browsing.');
            this.clearFieldErrorById('productCategory', 'productCategoryError');
            return true;
        }
        if (key === 'images') {
            if (!this.images.length) return this.setImageGalleryError('Add at least one photo — listings without a photo get far fewer views.');
            this.clearImageGalleryError();
            return true;
        }
        return true;
    }

    setFieldError(fieldId, errorId, message) {
        const field = document.getElementById(fieldId);
        const errorEl = document.getElementById(errorId);
        field?.classList.add('input-error');
        if (errorEl) errorEl.textContent = message;
        return false;
    }

    clearFieldErrorById(fieldId, errorId) {
        const field = document.getElementById(fieldId);
        const errorEl = document.getElementById(errorId);
        field?.classList.remove('input-error');
        if (errorEl) errorEl.textContent = '';
    }

    setImageGalleryError(message) {
        document.getElementById('photosCard')?.classList.add('has-error');
        const errorEl = document.getElementById('imageGalleryError');
        if (errorEl) errorEl.textContent = message;
        return false;
    }

    clearImageGalleryError() {
        document.getElementById('photosCard')?.classList.remove('has-error');
        const errorEl = document.getElementById('imageGalleryError');
        if (errorEl) errorEl.textContent = '';
    }

    updateCounters() {
        const name = document.getElementById('productName');
        const nameCounter = document.getElementById('productNameCounter');
        if (name && nameCounter) {
            const len = name.value.length;
            const max = Number(name.getAttribute('maxlength')) || 80;
            nameCounter.textContent = `${len}/${max}`;
            nameCounter.classList.toggle('is-near-limit', len >= max * 0.9 && len < max);
            nameCounter.classList.toggle('is-at-limit', len >= max);
        }
        const description = document.getElementById('productDescription');
        const descCounter = document.getElementById('productDescriptionCounter');
        if (description && descCounter) {
            const len = description.value.length;
            const max = Number(description.getAttribute('maxlength')) || 1000;
            descCounter.textContent = `${len}/${max}`;
            descCounter.classList.toggle('is-near-limit', len >= max * 0.9 && len < max);
            descCounter.classList.toggle('is-at-limit', len >= max);
        }
    }

    updatePricePreview() {
        const price = document.getElementById('productPrice');
        const preview = document.getElementById('productPricePreview');
        if (!price || !preview) return;
        const value = Number(price.value);
        preview.textContent = value > 0 ? `Shoppers see ${app.formatCurrency(value)}` : '';
    }

    handleImageSelect(e) {
        const selected = Array.from(e.target.files || []);
        const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
        if (selected.some(file => !allowed.has((file.type || '').toLowerCase()))) app.showAlert('Use PNG, JPEG, GIF, or WebP images only.', 'error');
        if (selected.some(file => file.size > 20 * 1024 * 1024)) app.showAlert('Each image must be 20MB or smaller before processing.', 'error');
        const files = selected.filter(file => allowed.has((file.type || '').toLowerCase()) && file.size <= 20 * 1024 * 1024).slice(0, 6 - this.images.length);
        if (!files.length) return;

        // Photos are cropped one at a time (sequentially, not in parallel)
        // so the confirm modal never stacks two on top of each other when
        // several files are picked at once.
        this.queueImageCrops(files);
        e.target.value = '';
    }

    async queueImageCrops(files) {
        for (const file of files) {
            const cropped = await window.NextaImageCrop.open(file, { aspect: 1, title: 'Crop your product photo' });
            if (!cropped) continue; // skipped/cancelled — move on to the next file, if any

            let full = cropped;
            try {
                full = await app.optimizeImage(cropped, { maxDim: 1800, quality: 0.84 });
            } catch (err) {
                console.error('Full image optimization failed; using cropped original:', err);
            }
            // Generate the small grid/list thumbnail right at selection
            // time (item 5) — a canvas resize is effectively free
            // compared to the network cost of shipping the full photo
            // to every marketplace/store grid that will ever show it.
            // If it fails for any reason (unsupported image type,
            // canvas tainted, etc.) fall back to the full image so
            // upload still works, just without the size win.
            let thumb = full;
            try {
                thumb = await this.generateThumbnail(full);
            } catch (err) {
                console.error('Thumbnail generation failed, using full image instead:', err);
            }
            this.images.push({ full, thumb });
            this.dirty = true;
            this.scheduleDraftSave();
            this.renderGallery();
        }
    }

    /**
     * Resizes a data URL down to at most `maxDim` on its longest edge and
     * re-encodes it as JPEG, via an off-screen canvas — no server round
     * trip and no new backend dependency (there's no image library
     * installed there, e.g. sharp). Product photos are practically always
     * opaque, so flattening any transparency to white on the JPEG
     * re-encode is an acceptable trade for a much smaller thumbnail.
     */
    generateThumbnail(dataUrl, maxDim = 480, quality = 0.82) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                try {
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    /** Runs every field-level check, shows the error summary banner listing
     *  what's wrong (with jump links), highlights each bad field, and moves
     *  focus to the first one — rather than leaving the seller to hunt for
     *  a lone red asterisk somewhere on the page. */
    runFullValidation() {
        const checks = [
            { key: 'name', label: 'Product name', anchor: 'productName' },
            { key: 'price', label: 'Price', anchor: 'productPrice' },
            { key: 'originalPrice', label: 'Original price', anchor: 'productOriginalPrice' },
            { key: 'stock', label: 'Stock quantity', anchor: 'productStock' },
            { key: 'category', label: 'Category', anchor: 'productCategory' },
            { key: 'images', label: 'Photos', anchor: 'photosCard' }
        ];
        const errors = [];
        checks.forEach(check => {
            if (!this.validateField(check.key)) errors.push(check);
        });

        const summary = document.getElementById('formErrorSummary');
        const list = document.getElementById('formErrorSummaryList');
        if (!errors.length) {
            summary.hidden = true;
            return true;
        }

        list.innerHTML = errors.map(err => `<li><a href="#${err.anchor}" data-jump="${err.anchor}">${err.label}</a></li>`).join('');
        document.getElementById('formErrorSummaryTitle').textContent =
            errors.length === 1 ? 'Please fix the following before saving:' : `Please fix these ${errors.length} things before saving:`;
        summary.hidden = false;

        list.querySelectorAll('[data-jump]').forEach(link => {
            link.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.jumpToField(link.dataset.jump);
            });
        });

        summary.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.jumpToField(errors[0].anchor, { focus: true });
        return false;
    }

    jumpToField(anchorId, { focus = false } = {}) {
        const el = document.getElementById(anchorId);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('pf-shake');
        setTimeout(() => el.classList.remove('pf-shake'), 450);
        if (focus && typeof el.focus === 'function') {
            setTimeout(() => el.focus({ preventScroll: true }), 200);
        }
    }

    async handleSubmit(e) {
        e.preventDefault();
        if (this.saving) return;
        const form = e.target;
        if (!this.runFullValidation()) return;

        const payload = {
            name: document.getElementById('productName').value.trim(),
            description: document.getElementById('productDescription').value.trim(),
            category: document.getElementById('productCategory').value,
            price: document.getElementById('productPrice').value,
            originalPrice: document.getElementById('productOriginalPrice').value || null,
            stock: document.getElementById('productStock').value || 0,
            // The backend expects `images`/`thumbnails` as parallel arrays of
            // strings (URLs or data URLs) — this.images is an array of
            // { full, thumb } objects for the editor's own bookkeeping, so it
            // must be split into two plain-string arrays before sending.
            images: this.images.map(item => item.full),
            thumbnails: this.images.map(item => item.thumb || item.full)
        };

        const estimatedBytes = [...payload.images, ...payload.thumbnails].reduce((sum, value) => {
            if (typeof value !== 'string' || !value.startsWith('data:')) return sum;
            const comma = value.indexOf(',');
            if (comma < 0) return sum;
            return sum + Math.floor(value.slice(comma + 1).length * 3 / 4);
        }, 0);
        if (estimatedBytes > 32 * 1024 * 1024) {
            app.showAlert('Your selected images are too large together. Remove a photo or use smaller images.', 'error');
            return;
        }

        this.saving = true;
        const saveBtn = document.getElementById('saveBtn');
        const saveBtnTop = document.getElementById('saveBtnTop');
        const originalHTML = saveBtn.innerHTML;
        const originalTopHTML = saveBtnTop?.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        if (saveBtnTop) { saveBtnTop.disabled = true; saveBtnTop.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

        try {
            if (this.isEditing) {
                await app.apiRequest(`/products/${this.productId}`, { method: 'PUT', body: JSON.stringify(payload) });
                app.showAlert('Product updated.', 'success');
            } else {
                await app.apiRequest('/products', { method: 'POST', body: JSON.stringify(payload) });
                app.showAlert('Product added.', 'success');
            }
            this.dirty = false;
            this.clearDraft();
            setTimeout(() => { window.location.href = this.returnTo; }, 700);
        } catch (err) {
            app.showAlert(err.message || 'Could not save this product.', 'error');
            saveBtn.disabled = false;
            saveBtn.innerHTML = originalHTML;
            if (saveBtnTop) { saveBtnTop.disabled = false; saveBtnTop.innerHTML = originalTopHTML; }
        } finally {
            this.saving = false;
        }
    }

    async handleDelete() {
        if (!(await app.confirm({ title: 'Delete product?', message: 'This cannot be undone.', confirmText: 'Delete', tone: 'danger' }))) return;
        try {
            await app.apiRequest(`/products/${this.productId}`, { method: 'DELETE' });
            app.showAlert('Product deleted.', 'success');
            this.dirty = false;
            setTimeout(() => { window.location.href = this.returnTo; }, 700);
        } catch (err) {
            app.showAlert(err.message || 'Could not delete this product.', 'error');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.productFormPage = new ProductFormPage();
});
