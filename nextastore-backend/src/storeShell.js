/**
 * Reads the real page files - store-detail.html (the storefront) and
 * product-detail.html (a product) - so routes/seo.js can serve them at
 * nextastores.com/<slug> and nextastores.com/<slug>/<product> with their own
 * <head> tags.
 *
 * Where each file comes from, in order:
 *   1. config.frontendDir/<file>  (this project's own layout, and any deploy
 *      that ships the API next to the site)
 *   2. FRONTEND_URL/<file>        (the site is hosted separately; that host
 *      serves a real file at this path, so asking it can never loop back here)
 * The result is kept for a short time so a burst of visits reads it once, yet an
 * edit to the page still shows up within seconds.
 */
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

const TTL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 4000;

function createShellLoader(fileName) {
    let cached = null; // { html, at }

    return async function load() {
        if (cached && Date.now() - cached.at < TTL_MS) return cached.html;

        let html = null;
        try {
            html = await fs.readFile(path.join(config.frontendDir, fileName), 'utf8');
        } catch (err) { /* not next to the API - try the frontend host */ }

        if (!html && config.frontendUrl && typeof fetch === 'function') {
            try {
                const res = await fetch(`${config.frontendUrl.replace(/\/$/, '')}/${fileName}`, {
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                    headers: { Accept: 'text/html' }
                });
                if (res.ok) html = await res.text();
            } catch (err) { /* handled below */ }
        }

        if (html && /<\/head>/i.test(html)) {
            cached = { html, at: Date.now() };
            return html;
        }
        // Serve a recent copy rather than nothing if a refresh just failed.
        return cached ? cached.html : null;
    };
}

const loadStoreShell = createShellLoader('store-detail.html');
const loadProductShell = createShellLoader('product-detail.html');

module.exports = { loadStoreShell, loadProductShell };
