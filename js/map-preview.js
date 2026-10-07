/**
 * NextaStore — shared small map preview
 * ---------------------------------------------------------------------------
 * Item 5: the storefront page and both order views (buyer + the seller
 * pickup box) only ever showed an "Open in Google Maps" text link next to
 * the saved location — no visual preview. This module renders a small,
 * non-interactive preview next to that link, built straight from OpenStreetMap
 * tiles (no API key, no new library — Leaflet isn't loaded on these pages
 * and pulling it in just for a static thumbnail felt heavier than needed).
 *
 * It works by stitching together the handful of 256x256 OSM tiles that
 * cover a small box around the pin, rather than embedding a full slippy
 * map, so it's cheap to drop into places that get built as HTML strings
 * (order modals) as well as normal page markup (the storefront page).
 *
 * Usage:
 *   NextaStoreMapPreview.render(containerEl, {
 *     lat, lng,                 // required
 *     zoom: 15,                 // optional, default 15
 *     width: 300, height: 160,  // optional, defaults shown
 *     mapsUrl: 'https://www.google.com/maps/search/?api=1&query=...', // optional
 *     area: false,              // optional: draw a soft area circle instead of a pin
 *                               // (used when only a city/district is known)
 *     areaLabel: ''             // optional: small chip over the map
 *   });
 * ---------------------------------------------------------------------------
 */
(function (global) {
    const TILE_SIZE = 256;

    function lngToWorldX(lng, n) {
        return n * TILE_SIZE * (lng + 180) / 360;
    }

    function latToWorldY(lat, n) {
        const latRad = lat * Math.PI / 180;
        return n * TILE_SIZE * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    }

    const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin';
    const TILE_TIMEOUT_MS = 8000;
    // Once OpenStreetMap has refused us in this page session, don't keep
    // hammering it from every preview - go straight to the fallback card.
    let tilesBlocked = false;

    function esc(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Only ever build a link to Google Maps from coordinates we parsed as
    // numbers - never from a caller-supplied string dropped into an attribute.
    function safeMapsUrl(mapsUrl) {
        if (!mapsUrl) return '';
        try {
            const u = new URL(mapsUrl);
            return (u.protocol === 'https:' && /(^|\.)google\.com$/.test(u.hostname)) ? u.href : '';
        } catch (_) { return ''; }
    }

    function releaseBlobs(container) {
        (container._mapBlobUrls || []).forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
        container._mapBlobUrls = [];
    }

    /** Fetches one tile. Resolves to a blob URL, or rejects with
     *  { blocked: true } when OSM answered but refused (403/429/not an image),
     *  or { blocked: false } for a network / CORS failure. */
    async function loadTile(url, signal) {
        let res;
        try {
            res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: TILE_REFERRER_POLICY, signal });
        } catch (err) {
            throw { blocked: false, err };
        }
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.startsWith('image/')) throw { blocked: true };
        return URL.createObjectURL(await res.blob());
    }

    function fallbackCard({ width, height, area, areaLabel, mapsUrl }) {
        return `
            <div class="map-preview-frame map-preview-fallback" style="width:${width}px;height:${height}px;">
                <div class="map-preview-fallback-grid" aria-hidden="true"></div>
                ${area ? '<div class="map-preview-area" style="left:50%;top:50%;"></div>'
                       : '<div class="map-preview-marker" style="left:50%;top:56%;"><i class="fas fa-map-marker-alt"></i></div>'}
                <span class="map-preview-fallback-note">${areaLabel ? esc(areaLabel) : 'Map preview unavailable'}</span>
                ${mapsUrl ? `<a class="map-preview-overlay-link" href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps"></a>` : ''}
            </div>`;
    }

    function render(container, { lat, lng, zoom = 15, width, height = 160, mapsUrl, area = false, areaLabel = '' } = {}) {
        if (!container || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;
        if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return;

        // Size to the slot the map really sits in (its content box), so it
        // can never be wider than its card. An explicit `width` still wins for
        // callers that measure themselves.
        if (!width) width = Math.round(container.getBoundingClientRect().width) || 300;
        width = Math.max(120, Math.min(width, 640));
        mapsUrl = safeMapsUrl(mapsUrl);

        releaseBlobs(container);
        const token = (container._mapToken = (container._mapToken || 0) + 1);

        const n = Math.pow(2, zoom);
        const centerX = lngToWorldX(lng, n);
        const centerY = latToWorldY(lat, n);
        const originX = centerX - width / 2;
        const originY = centerY - height / 2;
        const firstTileX = Math.floor(originX / TILE_SIZE);
        const firstTileY = Math.floor(originY / TILE_SIZE);
        const lastTileX = Math.floor((originX + width) / TILE_SIZE);
        const lastTileY = Math.floor((originY + height) / TILE_SIZE);
        const maxTile = n - 1;

        const tiles = [];
        for (let tx = firstTileX; tx <= lastTileX; tx++) {
            for (let ty = firstTileY; ty <= lastTileY; ty++) {
                tiles.push({
                    // Clamp so we never request a tile outside the world.
                    url: `https://tile.openstreetmap.org/${zoom}/${((tx % n) + n) % n}/${Math.max(0, Math.min(maxTile, ty))}.png`,
                    left: tx * TILE_SIZE - originX,
                    top: ty * TILE_SIZE - originY
                });
            }
        }

        if (tilesBlocked) { container.innerHTML = fallbackCard({ width, height, area, areaLabel, mapsUrl }); return; }

        const pinLeft = centerX - originX;
        const pinTop = centerY - originY;
        const overlay = `
            ${area
                ? `<div class="map-preview-area" style="left:${pinLeft}px;top:${pinTop}px;"></div>`
                : `<div class="map-preview-marker" style="left:${pinLeft}px;top:${pinTop}px;"><i class="fas fa-map-marker-alt"></i></div>`}
            ${areaLabel ? `<span class="map-preview-label">${esc(areaLabel)}</span>` : ''}
            <span class="map-preview-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a></span>
            ${mapsUrl ? `<a class="map-preview-overlay-link" href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps"></a>` : ''}`;

        // Skeleton first, so layout does not jump while tiles load.
        container.innerHTML = `<div class="map-preview-frame map-preview-loading" style="width:${width}px;height:${height}px;"></div>`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);

        Promise.all(tiles.map(t => loadTile(t.url, controller.signal))).then(urls => {
            clearTimeout(timer);
            if (container._mapToken !== token) { urls.forEach(u => URL.revokeObjectURL(u)); return; }
            container._mapBlobUrls = urls;
            container.innerHTML = `
                <div class="map-preview-frame" style="width:${width}px;height:${height}px;">
                    ${tiles.map((t, i) => `<img class="map-preview-tile" src="${urls[i]}" alt="" style="left:${t.left}px;top:${t.top}px;" draggable="false">`).join('')}
                    ${overlay}
                </div>`;
        }).catch(failure => {
            clearTimeout(timer);
            // Read this BEFORE aborting the remaining requests ourselves: an abort
            // we did not cause (the timeout above) means "too slow", which is a
            // fallback card; one we did cause must not be mistaken for it.
            const timedOut = controller.signal.aborted;
            controller.abort();
            if (container._mapToken !== token) return;
            if (failure && failure.blocked === false && !timedOut) {
                // A network / CORS-level failure: we cannot tell whether tiles are
                // refused, so let the browser try plain <img> tiles (with the
                // referrer policy set per-image) rather than give up.
                container.innerHTML = `
                    <div class="map-preview-frame" style="width:${width}px;height:${height}px;">
                        ${tiles.map(t => `<img class="map-preview-tile" src="${t.url}" referrerpolicy="${TILE_REFERRER_POLICY}" alt="" style="left:${t.left}px;top:${t.top}px;" loading="lazy" draggable="false">`).join('')}
                        ${overlay}
                    </div>`;
                return;
            }
            if (failure && failure.blocked) tilesBlocked = true;
            container.innerHTML = fallbackCard({ width, height, area, areaLabel, mapsUrl });
        });
    }

    global.NextaStoreMapPreview = { render };
})(window);
