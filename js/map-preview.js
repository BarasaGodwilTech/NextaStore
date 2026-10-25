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
 *     areaLabel: '',            // optional: small chip over the map
 *     directions: { label, address, notes }, // optional: tapping the map opens the in-app
 *                               // directions modal (js/map-directions.js) instead of
 *                               // leaving the site. Falls back to mapsUrl if that
 *                               // module isn't on the page.
 *     onOpen: () => {}          // optional: tapping the map calls this instead
 *   });
 *
 * Sizing: the map is drawn at the real width of the slot it sits in and is
 * redrawn when that slot's width changes (window resize, sidebar -> full
 * width, a step becoming visible). It used to be drawn once, capped at 640px,
 * so on a wide screen the part of the slot beyond the frame showed through as
 * a blank strip while a phone (always narrower than the cap) looked fine.
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

    // A map this wide is plenty for any slot on a real screen (7 tiles across)
    // and keeps the number of tile requests bounded on very large monitors.
    const MAX_WIDTH = 1792;
    const MIN_WIDTH = 120;

    /** Width of the slot's content box: its outer width minus padding and border,
     *  so the frame never ends up wider than the room that is really there. */
    function slotWidth(container) {
        const rect = container.getBoundingClientRect();
        let w = rect && rect.width ? rect.width : 0;
        if (w && typeof getComputedStyle === 'function') {
            const cs = getComputedStyle(container);
            const n = v => parseFloat(v) || 0;
            w -= n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth);
        }
        return Math.round(w);
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

    /** What a tap on the map does. In-app directions when the module is on the
     *  page (and the caller asked for it), a caller callback, or - last - the old
     *  Google Maps link. Nothing at all when none of those apply. */
    function tapTarget({ lat, lng, mapsUrl, directions, onOpen }) {
        if (directions && global.NextaStoreDirections) {
            const d = typeof directions === 'object' ? directions : {};
            return `<button type="button" class="map-preview-overlay-link map-preview-tap" data-nsd-open data-lat="${esc(lat)}" data-lng="${esc(lng)}" data-label="${esc(d.label || '')}" data-address="${esc(d.address || '')}" data-notes="${esc(d.notes || '')}" aria-label="Get directions to this location"></button>
                <span class="map-preview-hint" aria-hidden="true"><i class="fas fa-route"></i> Get directions</span>`;
        }
        if (typeof onOpen === 'function') {
            return `<button type="button" class="map-preview-overlay-link map-preview-tap" data-map-open aria-label="Open map"></button>`;
        }
        return mapsUrl ? `<a class="map-preview-overlay-link" href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps"></a>` : '';
    }

    function bindTap(container, onOpen) {
        if (typeof onOpen !== 'function') return;
        const btn = container.querySelector('[data-map-open]');
        if (btn) btn.addEventListener('click', e => { e.preventDefault(); onOpen(); });
    }

    /** Redraw the map when its slot changes width. One observer per slot, and
     *  only when the slot was measured (not when it was drawn from a hint). */
    function watchSlot(container, opts, drawnWidth) {
        container._mapOpts = opts;
        container._mapDrawnWidth = drawnWidth;
        if (container._mapObserver || typeof ResizeObserver === 'undefined') return;
        let frame = 0;
        container._mapObserver = new ResizeObserver(() => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (!container.isConnected) { container._mapObserver.disconnect(); container._mapObserver = null; return; }
                const w = Math.min(MAX_WIDTH, slotWidth(container));
                // Ignore sub-pixel noise, and a collapsed (hidden) slot.
                if (w < MIN_WIDTH || Math.abs(w - (container._mapDrawnWidth || 0)) < 4) return;
                render(container, container._mapOpts);
            });
        });
        container._mapObserver.observe(container);
    }

    function fallbackCard({ width, height, area, areaLabel, mapsUrl, lat, lng, directions, onOpen }) {
        return `
            <div class="map-preview-frame map-preview-fallback" style="width:${width}px;height:${height}px;">
                <div class="map-preview-fallback-grid" aria-hidden="true"></div>
                ${area ? '<div class="map-preview-area" style="left:50%;top:50%;"></div>'
                       : '<div class="map-preview-marker" style="left:50%;top:56%;"><i class="fas fa-map-marker-alt"></i></div>'}
                <span class="map-preview-fallback-note">${areaLabel ? esc(areaLabel) : 'Map preview unavailable'}</span>
                ${tapTarget({ lat, lng, mapsUrl, directions, onOpen })}
            </div>`;
    }

    function render(container, { lat, lng, zoom = 15, width, height = 160, mapsUrl, area = false, areaLabel = '', directions, onOpen } = {}) {
        if (!container || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;
        if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return;

        // Size to the slot the map really sits in (its content box), so it
        // can never be wider than its card. An explicit `width` still wins for
        // callers that measure themselves.
        // The slot's own width always wins when it has one; an explicit `width`
        // is only what to draw while the slot has no layout yet (hidden panel,
        // not attached) - otherwise a hint taken at one screen size would
        // leave blank space at another.
        const measured = slotWidth(container);
        const fitsSlot = measured > 0;
        width = fitsSlot ? measured : (width || 300);
        width = Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH));
        mapsUrl = safeMapsUrl(mapsUrl);
        const opts = { lat, lng, zoom, height, mapsUrl, area, areaLabel, directions, onOpen };
        watchSlot(container, opts, fitsSlot ? width : 0);

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

        if (tilesBlocked) { container.innerHTML = fallbackCard({ width, height, area, areaLabel, mapsUrl, lat, lng, directions, onOpen }); bindTap(container, onOpen); return; }

        const pinLeft = centerX - originX;
        const pinTop = centerY - originY;
        const overlay = `
            ${area
                ? `<div class="map-preview-area" style="left:${pinLeft}px;top:${pinTop}px;"></div>`
                : `<div class="map-preview-marker" style="left:${pinLeft}px;top:${pinTop}px;"><i class="fas fa-map-marker-alt"></i></div>`}
            ${areaLabel ? `<span class="map-preview-label">${esc(areaLabel)}</span>` : ''}
            <span class="map-preview-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a></span>
            ${tapTarget({ lat, lng, mapsUrl, directions, onOpen })}`;

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
            bindTap(container, onOpen);
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
                bindTap(container, onOpen);
                return;
            }
            if (failure && failure.blocked) tilesBlocked = true;
            container.innerHTML = fallbackCard({ width, height, area, areaLabel, mapsUrl, lat, lng, directions, onOpen });
            bindTap(container, onOpen);
        });
    }

    global.NextaStoreMapPreview = { render };
})(window);
