function slugifyOnboarding(text) { return (text || 'my-store').toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'my-store'; }

/**
 * NextaStore — first-run onboarding wizard
 * ---------------------------------------------------------------------------
 * Walks a brand-new seller through the same fields Dashboard Settings > Store
 * edits later (name, description, district, phone, logo, banner, bannerColor,
 * theme, payments) — see nextastore-backend/src/validation.js
 * (updateStoreSchema) for the source of truth on what the API accepts.
 *
 * Every "Next" saves the fields for that step with the same `PUT /store`
 * call Dashboard Settings > Store uses, so there's exactly one
 * save path and one source of truth: nothing here can drift out of sync
 * with what the dashboard shows, because it's the same record.
 *
 * Reaching this page a second time (e.g. from the dashboard's "Continue
 * setup" nudge) pre-fills every step from the store's current data, so
 * finishing later picks up right where the last save left off instead of
 * starting over.
 *
 * The step 2 and step 4 previews are painted from `this.store` through
 * window.NextaStoreBanner.applyStoreBanner() — the same helper the real
 * storefront, the dashboard and the product pages use. Nothing in either
 * preview is placeholder art: if a field is empty the preview says so
 * rather than inventing a stand-in, so "looks right here" means "looks
 * right once it's live".
 * ---------------------------------------------------------------------------
 */
class OnboardingWizard {
    constructor() {
        this.step = 1;
        this.totalSteps = 4;
        this.stepNames = { 1: 'Store Basics', 2: 'Branding', 3: 'Payments', 4: 'Review & Launch' };
        this.saving = false;
        this.slugAuto = true;
        this.store = {
            name: '', description: '', district: '', phoneNumber: '', mapCoordinates: '',
            logo: null, banner: null, bannerColor: '#00B074', theme: 'default',
            payments: { mtnMomo: true, airtelMoney: true, card: false }
        };
        this.init();
    }

    async init() {
        this.setupEvents();
        this.renderSlugPrefix();

        // While any existing store data loads (e.g. arriving here from the
        // dashboard's "Continue setup" nudge, rather than a brand-new
        // signup with nothing to fetch), disable the wizard's own
        // navigation so a click can't advance to a step whose fields are
        // about to be overwritten by the fetch that's still in flight.
        const nextBtn = document.getElementById('obNextBtn');
        if (nextBtn) nextBtn.disabled = true;

        await this.loadExistingStore();

        if (nextBtn) nextBtn.disabled = false;
        this.renderStep();
    }

    async loadExistingStore() {
        try {
            const res = await app.apiRequest('/store');
            this.store = { ...this.store, ...res.data, payments: { ...this.store.payments, ...(res.data.payments || {}) } };
            const starterBase = slugifyOnboarding((this.store.name || '').replace(/['’]s\s+Store$/i, ''));
            this.slugAuto = !!this.store.slug && this.store.slug === `${starterBase}-store`;
            this.populateFields();
        } catch (error) {
            // No store yet is unexpected (signup always creates one), but
            // don't block the wizard on it — the person can still fill
            // everything in and Step 1's save will create/update as needed.
            console.error('Could not load existing store:', error);
            this.populateFields();
        }
    }

    populateFields() {
        document.getElementById('obStoreName').value = this.store.name || '';
        document.getElementById('obStoreSlug').value = this.store.slug || slugifyOnboarding(this.store.name);
        document.getElementById('obStoreDesc').value = this.store.description || '';
        document.getElementById('obDistrict').value = this.store.district || '';
        document.getElementById('obPhone').value = this.store.phoneNumber || '';
        this.renderMapPin();
        this.renderDescCount();

        const color = this.store.bannerColor || '#00B074';
        document.getElementById('obBannerColor').value = color;
        document.getElementById('obBannerColorValue').textContent = color.toUpperCase();

        this.markActiveScheme();

        if (this.store.logo) {
            document.getElementById('obLogoUpload').innerHTML = `<img src="${app.resolveImageUrl(this.store.logo)}" alt="Store logo">`;
        }
        if (this.store.banner) {
            document.getElementById('obBannerUpload').innerHTML = `<img src="${app.resolveImageUrl(this.store.banner)}" alt="Store banner">`;
        }

        document.getElementById('obPayMtn').checked = !!this.store.payments.mtnMomo;
        document.getElementById('obPayAirtel').checked = !!this.store.payments.airtelMoney;
        document.getElementById('obPayCard').checked = !!this.store.payments.card;
        this.syncPaymentCards();

        this.renderBrandPreview();
    }

    /** The slug input shows the real link prefix rather than a bare word, so
     *  it's obvious the value is the tail of a URL. Built from the page's own
     *  location, which is the same base renderReview() links to. */
    storeUrlBase() {
        const dir = window.location.pathname.replace(/[^/]*$/, '');
        return `${window.location.origin}${dir}store-detail.html?store=`;
    }

    renderSlugPrefix() {
        const el = document.getElementById('obSlugPrefix');
        if (!el) return;
        // Host only — the full query-string base is too long to sit inside a
        // phone-width input, and the host is the part that carries meaning.
        el.textContent = `${window.location.host}/…store=`;
    }

    markActiveScheme() {
        const current = (this.store.bannerColor || '').toLowerCase();
        document.querySelectorAll('#obColorSchemes .color-scheme').forEach(el => {
            // A preset is "active" when its colour is the one in use — the
            // colour is what actually reaches the storefront, so matching on
            // it keeps the highlight truthful even after a custom pick.
            const on = (el.dataset.color || '').toLowerCase() === current;
            el.classList.toggle('active', on);
            el.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    syncPaymentCards() {
        document.querySelectorAll('.ob-pay-option').forEach(option => {
            const input = option.querySelector('.ob-pay-input');
            option.classList.toggle('is-on', !!(input && input.checked));
        });
    }

    renderDescCount() {
        const input = document.getElementById('obStoreDesc');
        const out = document.getElementById('obDescCount');
        if (!input || !out) return;
        const max = Number(input.getAttribute('maxlength')) || 600;
        const used = input.value.length;
        out.textContent = `${used} / ${max}`;
        out.classList.toggle('is-near', used > max - 60);
    }

    setupEvents() {
        document.getElementById('obNextBtn').addEventListener('click', () => this.handleNext());
        document.getElementById('obBackBtn').addEventListener('click', () => this.goToStep(this.step - 1));
        document.getElementById('obSkipStepBtn').addEventListener('click', () => this.handleNext({ skipValidation: true }));

        const logoUpload = document.getElementById('obLogoUpload');
        const bannerUpload = document.getElementById('obBannerUpload');
        logoUpload.addEventListener('click', () => document.getElementById('obLogoInput').click());
        bannerUpload.addEventListener('click', () => document.getElementById('obBannerInput').click());
        // The upload targets are divs with role="button", so they need the
        // keyboard activation a real <button> would give for free.
        [[logoUpload, 'obLogoInput'], [bannerUpload, 'obBannerInput']].forEach(([el, inputId]) => {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById(inputId).click(); }
            });
        });

        document.getElementById('obLogoInput').addEventListener('change', (e) => this.handleImageUpload(e.target.files[0], 'logo'));
        document.getElementById('obBannerInput').addEventListener('change', (e) => this.handleImageUpload(e.target.files[0], 'banner'));

        document.getElementById('obPickOnMapBtn').addEventListener('click', () => this.openMapPicker());
        document.getElementById('obClearMapPinBtn').addEventListener('click', () => this.clearMapPin());

        document.getElementById('obBannerColor').addEventListener('input', (e) => {
            this.store.bannerColor = e.target.value;
            document.getElementById('obBannerColorValue').textContent = e.target.value.toUpperCase();
            this.markActiveScheme();
            this.renderBrandPreview();
        });

        document.querySelectorAll('#obColorSchemes .color-scheme').forEach(scheme => {
            const pick = () => this.applyScheme(scheme);
            scheme.addEventListener('click', pick);
            scheme.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
            });
        });

        ['obPayMtn', 'obPayAirtel', 'obPayCard'].forEach((id, i) => {
            const keys = ['mtnMomo', 'airtelMoney', 'card'];
            document.getElementById(id).addEventListener('change', (e) => {
                this.store.payments[keys[i]] = e.target.checked;
                this.syncPaymentCards();
            });
        });

        document.getElementById('obStoreName').addEventListener('input', (e) => {
            document.getElementById('obStoreNameError').textContent = '';
            e.target.classList.remove('input-error');
            if (this.slugAuto) {
                const slug = slugifyOnboarding(e.target.value);
                document.getElementById('obStoreSlug').value = slug;
                this.store.slug = slug;
            }
            this.store.name = e.target.value.trim();
            this.renderBrandPreview();
        });
        document.getElementById('obStoreSlug').addEventListener('input', (e) => {
            this.slugAuto = false;
            this.store.slug = slugifyOnboarding(e.target.value);
            e.target.value = this.store.slug;
            this.updateReviewLink();
        });
        document.getElementById('obStoreDesc').addEventListener('input', () => this.renderDescCount());

        const copyBtn = document.getElementById('obCopyUrlBtn');
        if (copyBtn) copyBtn.addEventListener('click', () => this.copyStoreUrl());
    }

    /** Presets set the banner colour, not just `theme`. The banner colour is
     *  the value the storefront actually paints with (js/store-banner.js), so
     *  wiring the swatches to it is what makes the preview on the next step
     *  match the live page instead of promising a change nothing renders. */
    applyScheme(scheme) {
        this.store.theme = scheme.dataset.theme;
        const color = scheme.dataset.color;
        if (color) {
            this.store.bannerColor = color;
            document.getElementById('obBannerColor').value = color;
            document.getElementById('obBannerColorValue').textContent = color.toUpperCase();
        }
        this.markActiveScheme();
        this.renderBrandPreview();
    }

    async copyStoreUrl() {
        const btn = document.getElementById('obCopyUrlBtn');
        const link = document.getElementById('obReviewUrl');
        if (!btn || !link || !this.store.slug) return;
        const url = `${this.storeUrlBase()}${encodeURIComponent(this.store.slug)}`;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(url);
            } else {
                // Older mobile browsers and any non-secure origin.
                const scratch = document.createElement('textarea');
                scratch.value = url;
                scratch.setAttribute('readonly', '');
                scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0';
                document.body.appendChild(scratch);
                scratch.select();
                document.execCommand('copy');
                scratch.remove();
            }
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> <span>Copied</span>';
            setTimeout(() => { btn.innerHTML = original; }, 1600);
        } catch (error) {
            app.showAlert('Could not copy the link — select it and copy manually.', 'error');
        }
    }

    async handleImageUpload(file, type) {
        if (!file) return;
        const allowedTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
        if (!allowedTypes.has((file.type || '').toLowerCase())) { app.showAlert('Use PNG, JPEG, GIF, or WebP images only.', 'error'); return; }
        if (file.size > 20 * 1024 * 1024) { app.showAlert('Each image must be 20MB or smaller.', 'error'); return; }
        try {
            const preservePng = type === 'logo' && file.type === 'image/png';
            const cropped = await window.NextaImageCrop.open(file, {
                aspect: type === 'logo' ? 1 : 3,
                title: type === 'logo' ? 'Crop your logo' : 'Crop your banner',
                preservePng
            });
            if (!cropped) return; // cancelled
            const dataUrl = await app.optimizeImage(cropped, {
                maxDim: type === 'logo' ? 1000 : 1600,
                quality: 0.84,
                preservePng
            });
            this.store[type] = dataUrl;
            const input = document.getElementById(type === 'logo' ? 'obLogoInput' : 'obBannerInput');
            if (input) input.value = '';
            const container = document.getElementById(type === 'logo' ? 'obLogoUpload' : 'obBannerUpload');
            container.innerHTML = `<img src="${dataUrl}" alt="${type === 'logo' ? 'Store logo' : 'Store banner'}">`;
            this.renderBrandPreview();
        } catch (error) {
            app.showAlert(error.message || 'Could not process this image.', 'error');
        }
    }

    // ---- Step data collection ----
    collectStep1() {
        this.store.name = document.getElementById('obStoreName').value.trim();
        this.store.description = document.getElementById('obStoreDesc').value.trim();
        this.store.district = document.getElementById('obDistrict').value;
        this.store.phoneNumber = document.getElementById('obPhone').value.trim();
        this.store.mapCoordinates = document.getElementById('obMapCoordinates').value;
        this.store.slug = slugifyOnboarding(document.getElementById('obStoreSlug').value || this.store.name);
    }

    fieldsForStep(step) {
        switch (step) {
            case 1: return { name: this.store.name, slug: this.store.slug, description: this.store.description, district: this.store.district, phoneNumber: this.store.phoneNumber, mapCoordinates: this.store.mapCoordinates || '' };
            case 2: return { logo: this.store.logo, banner: this.store.banner, bannerColor: this.store.bannerColor, theme: this.store.theme };
            case 3: return { payments: this.store.payments };
            default: return {};
        }
    }

    /** Reflects `this.store.mapCoordinates` into the pin preview UI — used
     *  both on initial load (pre-filling from an existing store) and after
     *  a fresh pick from the map picker. */
    renderMapPin() {
        const preview = document.getElementById('obMapPinPreview');
        const text = document.getElementById('obMapPinText');
        const clearBtn = document.getElementById('obClearMapPinBtn');
        const coords = this.store.mapCoordinates;
        document.getElementById('obMapCoordinates').value = coords || '';
        if (coords) {
            const [lat, lng] = coords.split(',');
            // Six decimals is ~0.1m — more than that is noise on a shop pin,
            // and the untrimmed value overflowed the row on small phones.
            const round = (v) => Number.parseFloat(v).toFixed(5);
            text.textContent = `Pin dropped at ${round(lat)}, ${round(lng)}`;
            preview.classList.add('has-location');
            clearBtn.style.display = 'inline-flex';
        } else {
            text.textContent = 'No exact location selected';
            preview.classList.remove('has-location');
            clearBtn.style.display = 'none';
        }
    }

    openMapPicker() {
        NextaStoreMapPicker.open({
            initialDistrict: document.getElementById('obDistrict').value,
            initialCoordinates: document.getElementById('obMapCoordinates').value,
            onSave: ({ lat, lng, district }) => {
                this.store.mapCoordinates = `${lat},${lng}`;
                // A dropped pin is a more precise signal than the district
                // dropdown, so keep the two in sync — same as dashboard.js's
                // Settings picker does.
                document.getElementById('obDistrict').value = district;
                this.store.district = district;
                this.renderMapPin();
            }
        });
    }

    clearMapPin() {
        this.store.mapCoordinates = '';
        this.renderMapPin();
    }

    async handleNext({ skipValidation = false } = {}) {
        if (this.saving) return;

        if (this.step === 1) this.collectStep1();

        if (this.step === 1 && !skipValidation) {
            if (!this.store.name) {
                const field = document.getElementById('obStoreName');
                document.getElementById('obStoreNameError').textContent = 'Give your store a name to continue.';
                field.classList.add('input-error');
                field.focus();
                field.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
        }

        // Nothing to save on the review step — "Next" there launches instead.
        if (this.step === this.totalSteps) {
            await this.launch();
            return;
        }

        const saved = await this.saveStep(this.step);
        if (!saved) return; // error already shown; stay put so nothing is lost

        this.goToStep(this.step + 1);
    }

    async saveStep(step) {
        const payload = this.fieldsForStep(step);
        if (!Object.keys(payload).length) return true;

        this.setSaving(true);
        try {
            const res = await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify(payload) });
            this.store = { ...this.store, ...res.data, payments: { ...this.store.payments, ...(res.data.payments || {}) } };
            return true;
        } catch (error) {
            app.showAlert(error.message || 'Could not save — please try again.', 'error');
            return false;
        } finally {
            this.setSaving(false);
        }
    }

    async launch() {
        this.setSaving(true, 'Launching\u2026');
        try {
            // isPublished flips the store from draft to live. This is the
            // only place in the app that ever sends it — Dashboard Settings
            // saves through this same PUT /store endpoint but never
            // includes this field.
            await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify({ ...this.fieldsForStep(3), isPublished: true }) });
            sessionStorage.setItem('nextastore_just_launched', '1');
            window.location.href = 'dashboard.html';
        } catch (error) {
            app.showAlert(error.message || 'Could not launch your store — please try again.', 'error');
            this.setSaving(false);
        }
    }

    setSaving(isSaving, label) {
        this.saving = isSaving;
        const btn = document.getElementById('obNextBtn');
        const skip = document.getElementById('obSkipStepBtn');
        const back = document.getElementById('obBackBtn');
        btn.disabled = isSaving;
        // Skip and Back run the same save/navigation path, so leaving them
        // live during a save let a second request start on top of the first.
        if (skip) skip.disabled = isSaving;
        if (back) back.disabled = isSaving;
        btn.setAttribute('aria-busy', isSaving ? 'true' : 'false');
        if (isSaving) {
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${label || 'Saving\u2026'}`;
        } else if (btn.dataset.originalText) {
            btn.innerHTML = btn.dataset.originalText;
        }
    }

    goToStep(step) {
        this.step = Math.min(Math.max(step, 1), this.totalSteps);
        this.renderStep();
    }

    renderStep() {
        document.querySelectorAll('.onboarding-step-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === `onboardingStep${this.step}`);
        });

        document.querySelectorAll('.onboarding-step').forEach(el => {
            const n = Number(el.dataset.step);
            el.classList.toggle('active', n === this.step);
            el.classList.toggle('completed', n < this.step);
            if (n === this.step) el.setAttribute('aria-current', 'step');
            else el.removeAttribute('aria-current');
        });

        const summary = document.getElementById('obStepSummary');
        if (summary) {
            summary.innerHTML = `Step ${this.step} of ${this.totalSteps} · <strong></strong>`;
            summary.querySelector('strong').textContent = this.stepNames[this.step] || '';
        }

        document.getElementById('obBackBtn').style.visibility = this.step === 1 ? 'hidden' : 'visible';
        document.getElementById('obSkipStepBtn').style.display = this.step === this.totalSteps ? 'none' : 'inline';

        const nextBtn = document.getElementById('obNextBtn');
        nextBtn.innerHTML = this.step === this.totalSteps
            ? '<i class="fas fa-rocket" aria-hidden="true"></i> Launch store'
            : 'Next <i class="fas fa-arrow-right" aria-hidden="true"></i>';
        delete nextBtn.dataset.originalText;

        if (this.step === 2) this.renderBrandPreview();
        if (this.step === this.totalSteps) this.renderReview();

        // Each step is a fresh screenful; on a phone the previous step's
        // scroll position leaves the new heading off-screen.
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** Human label for a district value, read from the <select> itself so
     *  the two can never drift apart as the list changes. */
    districtLabel(value) {
        if (!value) return '';
        const option = document.querySelector(`#obDistrict option[value="${CSS.escape(value)}"]`);
        return option ? option.textContent.trim() : value;
    }

    /** Step 2's live preview — banner, logo and name only, since those are
     *  the three things that step can change. */
    renderBrandPreview() {
        const banner = document.getElementById('obBrandPreviewBanner');
        const logo = document.getElementById('obBrandPreviewLogo');
        const name = document.getElementById('obBrandPreviewName');
        if (!banner || !logo || !name) return;

        window.NextaStoreBanner?.applyStoreBanner(this.store, { full: banner });
        this.paintLogo(logo);
        name.textContent = this.store.name || 'Your store';
    }

    /** Shared by both previews: real logo image when there is one, the store
     *  initial when there isn't — exactly what store-detail.html falls back to. */
    paintLogo(el) {
        if (this.store.logo) {
            el.style.backgroundImage = `url(${app.resolveImageUrl(this.store.logo)})`;
            el.textContent = '';
        } else {
            el.style.backgroundImage = '';
            el.textContent = app.getInitial(this.store.name);
        }
    }

    updateReviewLink() {
        const link = document.getElementById('obReviewUrl');
        const chip = document.getElementById('obPreviewUrlChip');
        if (!link) return;
        const slug = this.store.slug || '';
        const relative = slug ? `store-detail.html?store=${encodeURIComponent(slug)}` : 'store-detail.html';
        const full = `${this.storeUrlBase()}${encodeURIComponent(slug)}`;
        link.href = relative;
        link.textContent = slug ? full : 'Not set';
        link.classList.toggle('is-empty', !slug);
        const copyBtn = document.getElementById('obCopyUrlBtn');
        if (copyBtn) copyBtn.disabled = !slug;
        if (chip) chip.textContent = slug ? `${window.location.host}/${slug}` : window.location.host;
    }

    renderReview() {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = value || 'Not set';
            el.classList.toggle('is-empty', !value);
        };

        const nameEl = document.getElementById('obReviewName');
        const descEl = document.getElementById('obReviewDesc');
        nameEl.textContent = this.store.name || 'Your store name';
        nameEl.classList.toggle('is-empty', !this.store.name);
        descEl.textContent = this.store.description || 'No description yet — shoppers will just see your store name.';
        descEl.classList.toggle('is-empty', !this.store.description);

        window.NextaStoreBanner?.applyStoreBanner(this.store, {
            full: document.getElementById('obReviewBanner')
        });

        this.paintLogo(document.getElementById('obReviewLogo'));

        // Meta row mirrors the storefront hero's own meta row: location first,
        // then phone. Anything not filled in is simply absent here, the same
        // way it will be absent on the live page.
        const districtName = this.districtLabel(this.store.district);
        const meta = [];
        if (districtName) {
            meta.push({ icon: 'fa-location-dot', text: districtName + (this.store.mapCoordinates ? ' · exact pin set' : '') });
        } else if (this.store.mapCoordinates) {
            meta.push({ icon: 'fa-location-dot', text: 'Exact pin set' });
        }
        if (this.store.phoneNumber) meta.push({ icon: 'fa-phone', text: this.store.phoneNumber });
        const metaEl = document.getElementById('obReviewMeta');
        if (metaEl) {
            metaEl.innerHTML = '';
            meta.forEach(item => {
                const span = document.createElement('span');
                span.className = 'ob-preview-meta-item';
                const icon = document.createElement('i');
                icon.className = `fas ${item.icon}`;
                icon.setAttribute('aria-hidden', 'true');
                span.appendChild(icon);
                span.appendChild(document.createTextNode(item.text));
                metaEl.appendChild(span);
            });
        }

        const activePayments = [
            this.store.payments.mtnMomo && { label: 'MTN MoMo', icon: 'fa-mobile-screen-button' },
            this.store.payments.airtelMoney && { label: 'Airtel Money', icon: 'fa-mobile-screen-button' },
            this.store.payments.card && { label: 'Card', icon: 'fa-credit-card' }
        ].filter(Boolean);

        const chipsEl = document.getElementById('obReviewPayChips');
        if (chipsEl) {
            chipsEl.innerHTML = '';
            const chips = activePayments.length
                ? activePayments
                : [{ label: 'No payment methods selected', icon: 'fa-circle-exclamation', muted: true }];
            chips.forEach(item => {
                const chip = document.createElement('span');
                chip.className = `ob-preview-chip${item.muted ? ' ob-preview-chip--muted' : ''}`;
                const icon = document.createElement('i');
                icon.className = `fas ${item.icon}`;
                icon.setAttribute('aria-hidden', 'true');
                chip.appendChild(icon);
                chip.appendChild(document.createTextNode(item.label));
                chipsEl.appendChild(chip);
            });
        }

        setValue('obReviewLocation', districtName || (this.store.mapCoordinates ? 'Exact pin only' : ''));
        setValue('obReviewPhone', this.store.phoneNumber);
        setValue('obReviewPayments', activePayments.map(p => p.label).join(', '));

        this.updateReviewLink();
    }
}

let onboardingWizard;
if (document.getElementById('onboardingSteps')) {
    onboardingWizard = new OnboardingWizard();
    // `let` at the top level of a classic script doesn't land on `window`,
    // which made the wizard unreachable from the console and from any later
    // script on the page. Expose it explicitly.
    window.onboardingWizard = onboardingWizard;
}
