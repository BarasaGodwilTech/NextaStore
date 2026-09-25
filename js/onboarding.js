/** Strict clean-up of a store name into a link: what actually gets saved.
 *  Empty when the name has nothing usable in it (the old version invented
 *  "my-store", which then silently became the seller's real link). */
function slugFromName(text) {
    return (text || '').toString().toLowerCase().trim()
        .replace(/['\u2019]/g, '')            // Amina's -> aminas, not amina-s
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60);
}

/** Forgiving version used while someone is typing in the link field: allows
 *  a trailing hyphen (you can't type "amina-crafts" if every keystroke
 *  deletes the "-" you just typed) and fixes it up on blur instead. */
function slugWhileTyping(text) {
    return (text || '').toString().toLowerCase()
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+/, '')
        .slice(0, 60);
}

function slugifyOnboarding(text) { return (text || 'my-store').toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'my-store'; }

/** Cosmetic-only: a few known catalog codes get the brand-colored icon
 *  chip (css/onboarding.css .ob-pay-icon--*) instead of the neutral
 *  default. Any code not listed here — including one an admin adds later
 *  — just gets the neutral .ob-pay-icon styling; nothing breaks either way. */
/** The value every store used to be created with (MTN MoMo and Airtel Money on,
 *  card off) before new stores started with nothing selected. */
function isLegacyDefaultPayments(p) {
    if (!p || typeof p !== 'object') return false;
    const keys = Object.keys(p);
    return keys.length === 3 && p.mtnMomo === true && p.airtelMoney === true && p.card === false;
}

const OB_PAY_BRAND_ICON_CLASS = { mtnMomo: 'ob-pay-icon--mtn', airtelMoney: 'ob-pay-icon--airtel', card: 'ob-pay-icon--card' };

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
        // The link the store had when this page loaded (if it was already
        // live, changing it breaks links people may have shared).
        this.originalSlug = '';
        // undefined = still checking, null = the check failed, number = real
        // count. A store needs at least one product before it can launch.
        this.productCount = undefined;
        this.store = {
            name: '', description: '', district: '', phoneNumber: '', phonePublic: true, mapCoordinates: '',
            logo: null, banner: null, bannerColor: '#00B074', theme: 'default',
            // Mirrors the Prisma Store.payments column default: nothing is
            // switched on until the seller chooses. (It used to start with MTN
            // MoMo and Airtel Money already on, which showed "Payment methods"
            // as done before anyone had picked anything.) Not related to the
            // checkbox *rendering*, which is built from the live catalog below.
            payments: {}
        };
        // Platform payment-method catalog (GET /payments/methods), fetched
        // once so the step-3 checkboxes and the review-step chips are both
        // built from it instead of a fixed MTN/Airtel/card list.
        this.paymentMethods = [];
        this.init();
    }

    async init() {
        this.mountPreviews();
        this.setupEvents();
        this.renderSlugPrefix();

        // While any existing store data loads (e.g. arriving here from the
        // dashboard's "Continue setup" nudge, rather than a brand-new
        // signup with nothing to fetch), disable the wizard's own
        // navigation so a click can't advance to a step whose fields are
        // about to be overwritten by the fetch that's still in flight.
        const nextBtn = document.getElementById('obNextBtn');
        if (nextBtn) nextBtn.disabled = true;

        // Independent fetches — the store, the platform's payment-method
        // catalog and the seller's product count don't depend on each
        // other — so run them together. Each re-renders what it feeds when
        // it resolves, so it doesn't matter which finishes first.
        await Promise.all([this.loadExistingStore(), this.loadPaymentMethods(), this.loadProductCount()]);

        if (nextBtn) nextBtn.disabled = false;

        // Coming back from "Add your first product" lands on the review step
        // (?step=4). Only honoured when the basics are actually saved, so a
        // hand-edited URL can't skip past required fields.
        const wanted = Number(new URLSearchParams(window.location.search).get('step'));
        if (wanted >= 2 && wanted <= this.totalSteps && this.basicsComplete()) this.step = wanted;
        if (window.location.search) window.history.replaceState(null, '', window.location.pathname);

        // Reveal the wizard now that `this.step` is its real, final value —
        // until this point it's been hidden behind the spinner markup
        // (css/onboarding.css, .ob-main--loading) instead of the static
        // "Step 1 active" HTML, so a return trip from "Add your first
        // product" (?step=4) never flashes Step 1 before landing on
        // Step 4; it goes straight there.
        document.getElementById('obMain')?.classList.remove('ob-main--loading');

        this.renderStep();
    }

    /** Whether a step has really been filled in (used for the progress ticks). */
    stepDone(n) {
        const st = this.store;
        switch (n) {
            case 1: return this.basicsComplete();
            case 2: return !!(st.logo || st.banner || (st.bannerColor && st.bannerColor.toUpperCase() !== '#00B074'));
            case 3: return this.paymentMethods.some(m => !!st.payments?.[m.code]);
            default: return false;
        }
    }

    basicsComplete() {
        const st = this.store;
        // Same bar as the actual step-1 "Next" validation below (slug must
        // be 3+ characters) — this used to only check st.slug was
        // non-empty, so a 1-2 character link could count as "complete" here
        // (a false completed tick on the step dots, and — via the ?step=
        // deep-link guard in init() — a way to land on step 4 with a link
        // too short to ever have actually been saved).
        return !!(st.name && st.slug && st.slug.length >= 3 && st.description && st.phoneNumber && st.district);
    }

    async loadPaymentMethods() {
        try {
            const res = await app.apiRequest('/payments/methods');
            this.paymentMethods = res.data || [];
        } catch (error) {
            console.error('Could not load payment methods:', error);
            this.paymentMethods = [];
        }
        this.renderPaymentOptions();
    }

    async loadExistingStore() {
        try {
            const res = await app.apiRequest('/store');
            this.store = { ...this.store, ...res.data, payments: { ...this.store.payments, ...(res.data.payments || {}) } };
            // Draft stores created before new stores started empty still carry
            // the old automatic MTN + Airtel defaults. Those were never a choice,
            // so show them unticked; whatever the seller ticks in step 3 is saved
            // explicitly (see fieldsForStep). A live store's payments are real.
            if (!this.store.isPublished && isLegacyDefaultPayments(res.data.payments)) this.store.payments = {};
            const starterBase = slugifyOnboarding((this.store.name || '').replace(/['’]s\s+Store$/i, ''));
            this.slugAuto = !!this.store.slug && this.store.slug === `${starterBase}-store`;
            this.originalSlug = this.store.isPublished ? (this.store.slug || '') : '';
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
        document.getElementById('obStoreSlug').value = this.store.slug || slugFromName(this.store.name);
        document.getElementById('obStoreDesc').value = this.store.description || '';
        document.getElementById('obPhone').value = this.store.phoneNumber || '';
        // this.store.phonePublic is undefined for a store created before this
        // field existed — default the checkbox to checked (matches the
        // onboarding default for a first-time setup) rather than reading
        // `undefined` as false and silently opting an existing seller out.
        document.getElementById('obPhonePublic').checked = this.store.phonePublic !== false;
        this.renderMapPin(); // also syncs the obDistrict hidden field
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

        this.renderPaymentOptions();

        this.renderLive();
    }

    /** The address as shown to people and the URLs each action should use —
     *  see app.storeAddress() in js/main.js. */
    address() {
        return app.storeAddress(this.store.slug, this.store.publicUrl);
    }

    renderSlugPrefix() {
        const el = document.getElementById('obSlugPrefix');
        if (!el) return;
        el.textContent = app.storeAddress('', this.store.publicUrl).prefix;
    }

    /** Called when the store-name field loses focus. If the URL is still on
     *  auto-suggest (this.slugAuto), there's nothing to protect — it just
     *  updated already. If it's been customized (this.slugAuto === false)
     *  and the new name would now suggest a *different* URL, the person may
     *  have simply forgotten they'd already changed the link — surface a
     *  quiet, dismissible nudge instead of either silently overwriting
     *  their edit or silently leaving a link that no longer matches. */
    checkSlugNudge() {
        if (this.slugAuto) { this.hideSlugNudge(); return; }
        const name = (this.store.name || '').trim();
        const currentSlug = (this.store.slug || '').trim();
        if (!name || !currentSlug) { this.hideSlugNudge(); return; }
        const suggested = slugFromName(name);
        if (!suggested || suggested === currentSlug) { this.hideSlugNudge(); return; }
        const banner = document.getElementById('obSlugNudge');
        const text = document.getElementById('obSlugNudgeText');
        const updateBtn = document.getElementById('obSlugNudgeUpdate');
        if (!banner || !text) return;
        // Same host app.storeAddress() uses everywhere else (obSlugPrefix,
        // the review step, Settings) — never a literal "nextastores.com".
        // That hardcoded string used to show here regardless of what
        // this.store.publicUrl actually resolves to, so this nudge could
        // name the wrong domain the moment SITE_URL differs from the brand
        // default (a staging env, or the planned nextastore.ug move).
        const currentDisplay = app.storeAddress(currentSlug, this.store.publicUrl).display;
        text.textContent = `You changed your store name, but your link is still ${currentDisplay}. Do you want to keep that link or update it to match?`;
        if (updateBtn) updateBtn.textContent = `Use /${suggested}`;
        banner.hidden = false;
    }

    hideSlugNudge() {
        const banner = document.getElementById('obSlugNudge');
        if (banner) banner.hidden = true;
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

    /** Step 3's payment checkboxes, built from the platform's payment-method
     *  catalog (this.paymentMethods) instead of a fixed MTN/Airtel/card
     *  list, so a method an admin adds or removes from Settings > Payment
     *  methods shows up here without a frontend redeploy. Safe to call
     *  before the catalog has loaded (shows a loading hint) and again once
     *  it has, and again whenever loadExistingStore() updates
     *  this.store.payments. */
    renderPaymentOptions() {
        const root = document.getElementById('obPayList');
        if (!root) return;
        if (!this.paymentMethods.length) {
            root.innerHTML = '<p class="form-hint">Loading payment methods…</p>';
            return;
        }
        const esc = app.escapeHtml;
        root.innerHTML = this.paymentMethods.map(m => {
            const brandClass = OB_PAY_BRAND_ICON_CLASS[m.code] || '';
            const checked = !!this.store.payments?.[m.code];
            return `
                <label class="ob-pay-option" for="obPay-${esc(m.code)}">
                    <span class="ob-pay-icon${brandClass ? ` ${brandClass}` : ''}"><i class="fas ${esc(m.icon || 'fa-money-bill')}" aria-hidden="true"></i></span>
                    <span class="ob-pay-text">
                        <span class="ob-pay-name">${esc(m.label || m.code)}</span>
                        <span class="ob-pay-desc">Shoppers can send payment via ${esc(m.label || m.code)}.</span>
                    </span>
                    <input type="checkbox" id="obPay-${esc(m.code)}" class="ob-pay-input" data-payment-code="${esc(m.code)}" ${checked ? 'checked' : ''}>
                    <span class="ob-pay-check" aria-hidden="true"><i class="fas fa-check"></i></span>
                </label>`;
        }).join('');
        root.querySelectorAll('.ob-pay-input').forEach(input => {
            input.addEventListener('change', (e) => {
                this.store.payments[e.target.dataset.paymentCode] = e.target.checked;
                this.syncPaymentCards();
                this.renderLive();
            });
        });
        this.syncPaymentCards();
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
            this.renderLive();
        });

        document.querySelectorAll('#obColorSchemes .color-scheme').forEach(scheme => {
            const pick = () => this.applyScheme(scheme);
            scheme.addEventListener('click', pick);
            scheme.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
            });
        });

        // Payment checkboxes are rendered from the live catalog
        // (renderPaymentOptions), which binds its own change listeners
        // each time it rebuilds the list.

        const slugInput = document.getElementById('obStoreSlug');
        const clearSlugError = () => {
            document.getElementById('obStoreSlugError').textContent = '';
            slugInput.classList.remove('input-error');
        };

        document.getElementById('obStoreName').addEventListener('input', (e) => {
            document.getElementById('obStoreNameError').textContent = '';
            e.target.classList.remove('input-error');
            this.store.name = e.target.value.trim();
            if (this.slugAuto) {
                // Still on suggestions: keep the link in step with the name.
                const slug = slugFromName(e.target.value);
                slugInput.value = slug;
                this.store.slug = slug;
                clearSlugError();
            } else {
                // They've edited the link themselves — never overwrite it
                // while they're still typing a new name. checkSlugNudge()
                // asks about it once they leave the name field.
                this.hideSlugNudge();
            }
            this.renderLive();
        });
        document.getElementById('obStoreName').addEventListener('blur', () => this.checkSlugNudge());

        slugInput.addEventListener('input', (e) => {
            // Editing the link ends suggestions for good (until it's emptied
            // and left, below): from here the name never rewrites it.
            const typed = slugWhileTyping(e.target.value);
            if (e.target.value !== typed) e.target.value = typed;
            this.slugAuto = false;
            this.store.slug = typed.replace(/-+$/, '');
            clearSlugError();
            this.hideSlugNudge();
            this.renderLive();
        });
        slugInput.addEventListener('blur', (e) => {
            const cleaned = e.target.value.replace(/-+$/, '');
            if (!cleaned) {
                // Left empty: go back to suggesting one from the name.
                this.slugAuto = true;
                const suggestion = slugFromName(this.store.name);
                e.target.value = suggestion;
                this.store.slug = suggestion;
            } else {
                e.target.value = cleaned;
                this.store.slug = cleaned;
            }
            this.renderLive();
        });
        document.getElementById('obSlugNudgeUpdate')?.addEventListener('click', () => {
            const freshSlug = slugFromName(this.store.name);
            this.store.slug = freshSlug;
            slugInput.value = freshSlug;
            this.slugAuto = true;
            clearSlugError();
            this.hideSlugNudge();
            this.renderLive();
        });
        document.getElementById('obSlugNudgeKeep')?.addEventListener('click', () => this.hideSlugNudge());

        document.getElementById('obStoreDesc').addEventListener('input', (e) => {
            this.renderDescCount();
            document.getElementById('obStoreDescError').textContent = '';
            e.target.classList.remove('input-error');
            this.store.description = e.target.value.trim();
            this.renderLive();
        });
        document.getElementById('obPhone').addEventListener('input', (e) => {
            document.getElementById('obPhoneError').textContent = '';
            e.target.classList.remove('input-error');
            this.store.phoneNumber = e.target.value.trim();
            this.renderLive();
        });
        document.getElementById('obPhonePublic').addEventListener('change', (e) => {
            this.store.phonePublic = e.target.checked;
            this.renderLive();
        });

        // The location map is drawn at the card's pixel width, so redraw it
        // when that width changes (rotation, window resize, step switch).
        const locMap = document.getElementById('obLocMap');
        if (locMap && 'ResizeObserver' in window) {
            let last = 0;
            new ResizeObserver(() => {
                const w = Math.round(locMap.clientWidth);
                if (w && w !== last) { last = w; this.renderLocMap(); }
            }).observe(locMap);
        }

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
        this.renderLive();
    }

    async copyStoreUrl() {
        const btn = document.getElementById('obCopyUrlBtn');
        const link = document.getElementById('obReviewUrl');
        if (!btn || !link || !this.store.slug) return;
        const url = this.address().shareUrl;
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
            this.renderLive();
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
        this.store.phonePublic = document.getElementById('obPhonePublic').checked;
        this.store.mapCoordinates = document.getElementById('obMapCoordinates').value;
        this.store.slug = slugFromName(document.getElementById('obStoreSlug').value) || slugFromName(this.store.name);
    }

    fieldsForStep(step) {
        switch (step) {
            case 1: return { name: this.store.name, slug: this.store.slug, description: this.store.description, district: this.store.district, phoneNumber: this.store.phoneNumber, phonePublic: this.store.phonePublic, mapCoordinates: this.store.mapCoordinates || '' };
            case 2: return { logo: this.store.logo, banner: this.store.banner, bannerColor: this.store.bannerColor, theme: this.store.theme };
            // Every method in the catalog is sent as an explicit true/false: the
            // API merges this into what is already stored, so leaving an
            // unticked method out would let an old value silently survive.
            case 3: return { payments: Object.fromEntries(this.paymentMethods.map(m => [m.code, !!this.store.payments?.[m.code]])) };
            default: return {};
        }
    }

    renderMapPin() {
        const preview = document.getElementById('obMapPinPreview');
        const text = document.getElementById('obMapPinText');
        const sub = document.getElementById('obMapPinSub');
        const clearBtn = document.getElementById('obClearMapPinBtn');
        const pickBtnLabel = document.getElementById('obPickOnMapBtnLabel');
        const coords = this.store.mapCoordinates;
        const district = this.store.district;
        document.getElementById('obMapCoordinates').value = coords || '';
        document.getElementById('obDistrict').value = district || '';

        if (!district) {
            text.textContent = 'No location set yet';
            sub.textContent = '';
            preview.classList.remove('has-location');
            clearBtn.style.display = 'none';
            if (pickBtnLabel) pickBtnLabel.textContent = 'Choose location';
            this.renderLocMap();
            return;
        }

        // Say which kind of place it is — "Kampala" is a city, "Wakiso" a
        // district — so the seller sees exactly what shoppers will.
        const kind = window.NextaStoreMapPicker?.kind ? NextaStoreMapPicker.kind(district) : 'District';
        text.textContent = this.districtLabel(district);
        preview.classList.add('has-location');
        if (pickBtnLabel) pickBtnLabel.textContent = 'Change location';

        if (coords) {
            sub.textContent = `${kind} \u00b7 Exact shop pin set`;
            clearBtn.style.display = 'inline-flex';
        } else {
            sub.textContent = `${kind} \u00b7 No exact pin yet (optional)`;
            clearBtn.style.display = 'none';
        }
        this.renderLocMap();
    }

    /** The small map under the location card. An exact pin shows a pin; a
     *  city/district alone shows the general area softly shaded (no pin, so it
     *  never implies a precise shop location that hasn't been set). Drawn at
     *  the card's real pixel width, so it is only rendered while step 1 is on
     *  screen — a hidden panel has no width to draw at. */
    renderLocMap() {
        const box = document.getElementById('obLocMap');
        if (!box) return;
        const district = this.store.district;
        const coords = this.store.mapCoordinates;
        if (!district || !window.NextaStoreMapPreview || !window.NextaStoreMapPicker) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        const width = Math.round(box.clientWidth);
        if (!width) return;
        const height = width < 420 ? 132 : 168;
        const picker = window.NextaStoreMapPicker;
        const kind = picker.kind(district);
        const label = `${picker.label(district)} \u00b7 ${kind}`;

        if (coords) {
            const [lat, lng] = coords.split(',').map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                NextaStoreMapPreview.render(box, {
                    lat, lng, zoom: 16, width, height, areaLabel: label,
                    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}`
                });
                return;
            }
        }
        const center = picker.districtCoordinates[district];
        if (!center) { box.hidden = true; return; }
        NextaStoreMapPreview.render(box, {
            lat: center[0], lng: center[1], zoom: kind === 'City' ? 12 : 11,
            width, height, area: true, areaLabel: label
        });
    }

    openMapPicker() {
        NextaStoreMapPicker.open({
            initialDistrict: document.getElementById('obDistrict').value,
            initialCoordinates: document.getElementById('obMapCoordinates').value,
            onSave: ({ lat, lng, district }) => {
                // lat/lng are only present if a pin was actually dropped —
                // saving with just a district/city chosen is valid too.
                this.store.mapCoordinates = (lat && lng) ? `${lat},${lng}` : '';
                this.store.district = district;
                document.getElementById('obLocationError').textContent = '';
                document.getElementById('obMapPinPreview')?.classList.remove('input-error');
                this.renderMapPin();
                this.renderLive();
            }
        });
    }

    /** Removes just the precise pin, keeping the required district/city —
     *  "Remove exact pin" is deliberately not "Clear" (that read as if it
     *  would blank out the location entirely, which isn't allowed once a
     *  district has been chosen). */
    clearMapPin() {
        this.store.mapCoordinates = '';
        this.renderMapPin();
        this.renderLive();
    }

    async handleNext({ skipValidation = false } = {}) {
        if (this.saving) return;

        if (this.step === 1) this.collectStep1();

        if (this.step === 1 && !skipValidation) {
            // Checked together (not return-on-first-error) so someone who
            // left several fields blank sees every problem at once instead
            // of fixing one, clicking Next, hitting the next one, and so on.
            let firstInvalid = null;
            const flag = (fieldId, errorId, message) => {
                const field = document.getElementById(fieldId);
                const error = document.getElementById(errorId);
                if (error) error.textContent = message;
                field?.classList.add('input-error');
                if (!firstInvalid) firstInvalid = field;
            };

            if (!this.store.name) {
                flag('obStoreName', 'obStoreNameError', 'Give your store a name to continue.');
            }
            if (!this.store.slug || this.store.slug.length < 3) {
                flag('obStoreSlug', 'obStoreSlugError', 'Your store link needs at least 3 letters or numbers.');
            }
            if (!this.store.description) {
                flag('obStoreDesc', 'obStoreDescError', 'Add a short description so shoppers know what you sell.');
            }
            if (!this.store.phoneNumber) {
                flag('obPhone', 'obPhoneError', 'A phone number is required so we can reach you about your account.');
            } else if (this.store.phoneNumber.replace(/\D/g, '').length < 9) {
                flag('obPhone', 'obPhoneError', 'That number looks too short. Try something like 0772 123 456.');
            }
            if (!this.store.district) {
                document.getElementById('obLocationError').textContent = 'Choose at least your city or district.';
                document.getElementById('obMapPinPreview')?.classList.add('input-error');
                if (!firstInvalid) firstInvalid = document.getElementById('obPickOnMapBtn');
            }

            if (firstInvalid) {
                firstInvalid.focus();
                firstInvalid.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }

            // A store that is already live has a link people may have shared.
            // Changing it here would quietly break every one of those, so ask.
            if (this.originalSlug && this.store.slug !== this.originalSlug) {
                const oldLink = app.storeAddress(this.originalSlug, this.store.publicUrl).display;
                const newLink = app.storeAddress(this.store.slug, this.store.publicUrl).display;
                const ok = await app.confirm({
                    title: 'Change your store link?',
                    message: `Your store is live at ${oldLink}. Anyone you've already shared it with will need the new link, ${newLink}.`,
                    confirmText: 'Change link',
                    cancelText: 'Keep old link'
                });
                if (!ok) {
                    this.store.slug = this.originalSlug;
                    document.getElementById('obStoreSlug').value = this.originalSlug;
                    this.slugAuto = false;
                    this.renderLive();
                    return;
                }
            }
        }

        if (this.step === this.totalSteps) {
            // Nothing to save on the review step. With no products yet, the
            // primary action is to add one; otherwise it launches.
            if (this.productCount === 0) {
                window.location.href = 'product-form.html?from=onboarding';
                return;
            }
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
            // A draft still holding the old automatic MTN + Airtel defaults keeps
            // showing what the seller has (or hasn't) ticked, not those defaults.
            const keepLocalPayments = step !== 3 && !res.data.isPublished && isLegacyDefaultPayments(res.data.payments);
            this.store = { ...this.store, ...res.data, payments: keepLocalPayments ? this.store.payments : { ...this.store.payments, ...(res.data.payments || {}) } };
            if (step === 1 && this.originalSlug) this.originalSlug = this.store.slug || this.originalSlug;
            this.renderSlugPrefix();
            return true;
        } catch (error) {
            const message = error.message || 'Could not save \u2014 please try again.';
            if (step === 1 && /url|link|slug|taken/i.test(message) && /reserved/i.test(message)) {
                const errorEl = document.getElementById('obStoreSlugError');
                const input = document.getElementById('obStoreSlug');
                if (errorEl) errorEl.textContent = 'That link is used by NextaStore itself (like login or cart). Try adding your area or a number, like amina-crafts-kampala.';
                input?.classList.add('input-error');
                input?.focus();
                input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } else if (step === 1 && /url|link|slug|taken/i.test(message) && /taken|already|exist/i.test(message)) {
                // The link is the one field the server can reject for reasons
                // the person can fix right here — say so next to the field.
                const errorEl = document.getElementById('obStoreSlugError');
                const input = document.getElementById('obStoreSlug');
                if (errorEl) errorEl.textContent = 'Someone already has that link. Try adding your area or a number, like amina-crafts-kampala.';
                input?.classList.add('input-error');
                input?.focus();
                input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } else {
                app.showAlert(message, 'error');
            }
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
            // includes this field. The server refuses it for a store with
            // no products, which is why the product count is re-read below
            // if it fails.
            await app.apiRequest('/store', { method: 'PUT', body: JSON.stringify({ ...this.fieldsForStep(3), isPublished: true }) });
            sessionStorage.setItem('nextastore_just_launched', '1');
            window.location.href = 'dashboard.html';
        } catch (error) {
            app.showAlert(error.message || 'Could not launch your store — please try again.', 'error');
            this.setSaving(false);
            await this.loadProductCount();
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
        } else {
            if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
            // Still checking the product count on the last step: stay disabled.
            btn.disabled = this.step === this.totalSteps && this.productCount === undefined;
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
            // A step behind you is only ticked if it was actually done. A skipped
            // one keeps its number (dashed), so the row never claims payments or
            // branding are set up when they were skipped.
            const behind = n < this.step;
            el.classList.toggle('completed', behind && this.stepDone(n));
            el.classList.toggle('skipped', behind && !this.stepDone(n));
            if (n === this.step) el.setAttribute('aria-current', 'step');
            else el.removeAttribute('aria-current');
        });

        const summary = document.getElementById('obStepSummary');
        if (summary) {
            summary.innerHTML = `Step ${this.step} of ${this.totalSteps} · <strong></strong>`;
            summary.querySelector('strong').textContent = this.stepNames[this.step] || '';
        }

        document.getElementById('obBackBtn').style.visibility = this.step === 1 ? 'hidden' : 'visible';
        // Step 1 collects the store's required basics (name, description,
        // phone, location) — nothing on it is actually skippable anymore,
        // so the skip link would just be a dead end that still bounces the
        // person right back with validation errors. Branding (2) and
        // payments (3) remain genuinely optional to skip.
        document.getElementById('obSkipStepBtn').style.display =
            (this.step === this.totalSteps || this.step === 1) ? 'none' : 'inline';

        this.updateNextButton();

        if (this.step === this.totalSteps) this.renderReview();
        this.renderLive();
        // The location map can only be drawn once step 1 has a width.
        if (this.step === 1) this.renderLocMap();

        // Each step is a fresh screenful; on a phone the previous step's
        // scroll position leaves the new heading off-screen.
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** The primary button: "Next" through the steps; on the last one either
     *  "Launch store", or — while there are no products yet — the action that
     *  actually unblocks launching. */
    updateNextButton() {
        const btn = document.getElementById('obNextBtn');
        if (!btn || this.saving) return;
        delete btn.dataset.originalText;
        if (this.step !== this.totalSteps) {
            btn.innerHTML = 'Next <i class="fas fa-arrow-right" aria-hidden="true"></i>';
            btn.disabled = false;
        } else if (this.productCount === undefined) {
            btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Checking products\u2026';
            btn.disabled = true;
        } else if (this.productCount === 0) {
            btn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Add your first product';
            btn.disabled = false;
        } else {
            btn.innerHTML = '<i class="fas fa-rocket" aria-hidden="true"></i> Launch store';
            btn.disabled = false;
        }
    }

    /** How many products the seller has (only "none" vs "some" matters). A
     *  failed check leaves this null and the page carries on — the server
     *  makes the final call when launching. */
    async loadProductCount() {
        try {
            const res = await app.apiRequest('/products?limit=1');
            const total = res.pagination?.total;
            this.productCount = Number.isFinite(Number(total)) ? Number(total) : (res.data || []).length;
        } catch (error) {
            console.error('Could not check products:', error);
            this.productCount = null;
        }
        this.renderProductGate();
        this.renderChecklist();
        this.updateNextButton();
    }

    renderProductGate() {
        const el = document.getElementById('obFirstProduct');
        if (!el) return;
        const n = this.productCount;
        el.dataset.state = n === undefined ? 'checking' : n === null ? 'unknown' : n > 0 ? 'ready' : 'empty';
        if (n === undefined || n === null) { el.innerHTML = ''; return; }
        if (n > 0) {
            el.innerHTML = `
                <span class="ob-fp-icon" aria-hidden="true"><i class="fas fa-check"></i></span>
                <div class="ob-fp-body">
                    <h4>${n === 1 ? 'Your first product is ready' : `${n} products are ready`}</h4>
                    <p>Shoppers will find ${n === 1 ? 'it' : 'them'} on your store the moment you launch. You can add more any time from your dashboard.</p>
                </div>`;
            return;
        }
        el.innerHTML = `
            <span class="ob-fp-icon" aria-hidden="true"><i class="fas fa-box-open"></i></span>
            <div class="ob-fp-body">
                <h4>Add your first product</h4>
                <p>An empty shelf gives shoppers nothing to buy, so your store needs at least one product before it opens. Add the rest from your dashboard whenever you like.</p>
                <a class="btn btn-primary btn-sm" href="product-form.html?from=onboarding"><i class="fas fa-plus" aria-hidden="true"></i> Add your first product</a>
            </div>`;
    }

    /** Both the wide-screen rail and the review step show the same storefront
     *  card, so its markup lives in one place and is painted by one function. */
    storefrontPreviewHTML() {
        return `
            <div class="ob-storefront-preview" aria-label="Storefront preview">
                <div class="ob-preview-chrome" aria-hidden="true">
                    <span class="ob-preview-dot"></span><span class="ob-preview-dot"></span><span class="ob-preview-dot"></span>
                    <span class="ob-preview-urlchip"><i class="fas fa-lock" aria-hidden="true"></i><span data-sf="url"></span></span>
                </div>
                <div class="preview-banner-strip" data-sf="banner">
                    <span class="ob-preview-draft-chip"><i class="fas fa-eye-slash" aria-hidden="true"></i> Draft</span>
                </div>
                <div class="onboarding-review-preview-body">
                    <div class="onboarding-review-logo" data-sf="logo">S</div>
                    <div class="ob-preview-identity">
                        <h3 data-sf="name"></h3>
                        <p class="text-muted" data-sf="desc"></p>
                        <div class="ob-preview-meta" data-sf="meta"></div>
                        <div class="ob-preview-pay" data-sf="pay"></div>
                    </div>
                </div>
                <div class="ob-preview-actions" aria-hidden="true">
                    <span class="ob-preview-fakebtn ob-preview-fakebtn--primary"><i class="fas fa-comment"></i> Message seller</span>
                    <span class="ob-preview-fakebtn"><i class="fas fa-heart"></i> Follow</span>
                </div>
            </div>`;
    }

    mountPreviews() {
        document.querySelectorAll('[data-sf-mount]').forEach(mount => { mount.innerHTML = this.storefrontPreviewHTML(); });
    }

    paintStorefronts() {
        const addr = this.address();
        const names = this.paymentMethods
            .filter(m => !!this.store.payments?.[m.code])
            .map(m => ({ label: m.label || m.code, icon: m.icon || 'fa-money-bill' }));
        const districtName = this.districtLabel(this.store.district);

        document.querySelectorAll('.ob-storefront-preview').forEach(root => {
            const q = (key) => root.querySelector(`[data-sf="${key}"]`);
            q('url').textContent = addr.display || `${addr.host}/your-store`;

            const nameEl = q('name');
            nameEl.textContent = this.store.name || 'Your store name';
            nameEl.classList.toggle('is-empty', !this.store.name);

            const descEl = q('desc');
            descEl.textContent = this.store.description || 'Your description will show here once you write it.';
            descEl.classList.toggle('is-empty', !this.store.description);

            window.NextaStoreBanner?.applyStoreBanner(this.store, { full: q('banner') });
            this.paintLogo(q('logo'));

            // Same rule as the live page: only what's filled in appears, and
            // a phone number marked private is not shown to shoppers.
            const meta = [];
            if (districtName) meta.push({ icon: 'fa-location-dot', text: districtName });
            if (this.store.phoneNumber && this.store.phonePublic) meta.push({ icon: 'fa-phone', text: this.store.phoneNumber });
            const metaEl = q('meta');
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

            const payEl = q('pay');
            payEl.innerHTML = '';
            const chips = names.length ? names : [{ label: 'No payment methods selected', icon: 'fa-circle-exclamation', muted: true }];
            chips.forEach(item => {
                const chip = document.createElement('span');
                chip.className = `ob-preview-chip${item.muted ? ' ob-preview-chip--muted' : ''}`;
                const icon = document.createElement('i');
                icon.className = `fas ${item.icon}`;
                icon.setAttribute('aria-hidden', 'true');
                chip.appendChild(icon);
                chip.appendChild(document.createTextNode(item.label));
                payEl.appendChild(chip);
            });
        });
    }

    /** The wide-screen rail's "before you launch" list. */
    renderChecklist() {
        const root = document.getElementById('obChecklist');
        if (!root) return;
        const st = this.store;
        const activePayments = this.paymentMethods.filter(m => !!st.payments?.[m.code]).length;
        const n = this.productCount;
        const items = [
            { label: 'Store basics', done: !!(st.name && st.slug && st.description && st.phoneNumber && st.district), note: 'Required' },
            { label: 'Logo and banner', done: !!(st.logo || st.banner), note: 'Optional' },
            { label: 'Payment methods', done: activePayments > 0, note: 'None selected' },
            { label: 'First product', done: typeof n === 'number' && n > 0, note: n === undefined ? 'Checking\u2026' : 'Needed to launch', doneNote: n === 1 ? '1 added' : `${n} added` }
        ];
        root.innerHTML = '';
        items.forEach(item => {
            const row = document.createElement('div');
            row.className = `ob-check${item.done ? ' is-done' : ''}`;
            const mark = document.createElement('span');
            mark.className = 'ob-check-mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.innerHTML = item.done ? '<i class="fas fa-check"></i>' : '';
            const label = document.createElement('span');
            label.className = 'ob-check-label';
            label.textContent = item.label;
            const note = document.createElement('span');
            note.className = 'ob-check-note';
            note.textContent = item.done ? (item.doneNote || 'Done') : item.note;
            row.append(mark, label, note);
            row.setAttribute('aria-label', `${item.label}: ${item.done ? (item.doneNote || 'done') : item.note}`);
            root.appendChild(row);
        });
    }

    /** Everything that mirrors the store record on screen: called after any
     *  edit so the rail, the step previews, the link and the checklist can
     *  never disagree with each other. */
    renderLive() {
        this.renderSlugPrefix();
        this.renderBrandPreview();
        this.paintStorefronts();
        this.renderChecklist();
        this.updateReviewLink();
    }

    /** Human label for a district value. Onboarding no longer has its own
     *  district <select> (location is chosen entirely through the map
     *  modal — see openMapPicker()), so this reads from the same
     *  NextaStoreMapPicker.label() the modal itself uses, keeping one
     *  source of truth for the full district list instead of a second,
     *  shorter one drifting out of sync here. */
    districtLabel(value) {
        if (!value) return '';
        if (window.NextaStoreMapPicker?.label) return window.NextaStoreMapPicker.label(value);
        return value.charAt(0).toUpperCase() + value.slice(1);
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
        if (!link) return;
        const addr = this.address();
        link.href = addr.openUrl || '#';
        link.textContent = addr.display || 'Not set';
        link.classList.toggle('is-empty', !addr.display);
        const copyBtn = document.getElementById('obCopyUrlBtn');
        if (copyBtn) copyBtn.disabled = !addr.display;
    }

    renderReview() {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = value || 'Not set';
            el.classList.toggle('is-empty', !value);
        };

        const districtName = this.districtLabel(this.store.district);
        const kind = this.store.district && window.NextaStoreMapPicker?.kind ? ` (${NextaStoreMapPicker.kind(this.store.district).toLowerCase()})` : '';
        const activePayments = this.paymentMethods
            .filter(m => !!this.store.payments?.[m.code])
            .map(m => ({ label: m.label || m.code, icon: m.icon || 'fa-money-bill' }));

        this.renderProductGate();
        this.paintStorefronts();

        setValue('obReviewLocation', districtName ? `${districtName}${kind}${this.store.mapCoordinates ? ' \u00b7 exact pin set' : ''}` : (this.store.mapCoordinates ? 'Exact pin only' : ''));
        setValue('obReviewPhone', this.store.phoneNumber ? `${this.store.phoneNumber} \u00b7 ${this.store.phonePublic ? 'shown on your store' : 'hidden from shoppers'}` : '');
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
