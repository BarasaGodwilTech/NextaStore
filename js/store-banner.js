/**
 * NextaStore — unified store banner rendering
 * ---------------------------------------------------------------------------
 * A store's banner (color and/or image) lives at the store level — one pair
 * of fields (`banner`, `bannerColor`) on the Store record. Every page that
 * shows branding (the public storefront, the dashboard overview, dashboard
 * sub-pages, product pages, the store builder preview) should render from
 * that same pair through this one function, instead of each page
 * re-implementing its own image-vs-color fallback and its own hardcoded
 * default color. That's what keeps them all in sync: change the banner once,
 * and everywhere that called applyStoreBanner() reflects it immediately.
 * ---------------------------------------------------------------------------
 */
(function (global) {
    // The platform-wide default for a brand-new, uncustomized store.
    const DEFAULT_BANNER_COLOR = '#00B074';

    /**
     * @param {{banner?: string|null, bannerColor?: string|null}} store
     * @param {Object} targets
     * @param {HTMLElement} [targets.full]   The large banner element (hero image or solid color).
     * @param {HTMLElement[]} [targets.accents] Thin brand-color strips/badges shown on pages
     *        that don't have room for the full banner (product pages, dashboard sub-pages,
     *        sidebar/top-bar chrome) — any number of them, all painted the same color.
     */
    function applyStoreBanner(store, { full, accents } = {}) {
        const color = (store && store.bannerColor) || DEFAULT_BANNER_COLOR;
        // Resolve through app.resolveImageUrl so a saved (root-relative)
        // banner URL loads correctly even when the frontend and API are on
        // different origins — see the note in js/main.js. A locally-staged
        // preview (data: URL, not yet saved) passes through unchanged.
        const image = store && store.banner ? (global.app?.resolveImageUrl(store.banner) || store.banner) : null;

        if (full) {
            if (image) {
                full.style.background = '';
                full.style.backgroundColor = color; // shows briefly while the image loads
                full.style.backgroundImage = `url(${image})`;
                full.style.backgroundSize = 'cover';
                full.style.backgroundPosition = 'center';
            } else {
                full.style.backgroundImage = 'none';
                full.style.background = color;
            }
        }

        (accents || []).forEach(el => { if (el) el.style.background = color; });

        // Exposed as a CSS variable too, so stylesheets can pick it up for
        // small accents without every page needing its own JS for it.
        document.documentElement.style.setProperty('--store-accent', color);
    }

    global.NextaStoreBanner = { applyStoreBanner, DEFAULT_BANNER_COLOR };
})(window);
