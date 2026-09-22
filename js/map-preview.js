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
 *     mapsUrl: 'https://www.google.com/maps/search/?api=1&query=...' // optional
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

    function render(container, { lat, lng, zoom = 15, width = 300, height = 160, mapsUrl } = {}) {
        if (!container || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;

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
                // Clamp so we never request a tile outside the world (can
                // happen at the poles / antimeridian, not a real case for
                // Uganda but cheap to guard against).
                const wrappedX = ((tx % n) + n) % n;
                const clampedY = Math.max(0, Math.min(maxTile, ty));
                const left = tx * TILE_SIZE - originX;
                const top = ty * TILE_SIZE - originY;
                tiles.push(`<img class="map-preview-tile" src="https://tile.openstreetmap.org/${zoom}/${wrappedX}/${clampedY}.png" alt="" style="left:${left}px;top:${top}px;" loading="lazy">`);
            }
        }

        const pinLeft = centerX - originX;
        const pinTop = centerY - originY;

        container.innerHTML = `
            <div class="map-preview-frame" style="width:${width}px;height:${height}px;">
                ${tiles.join('')}
                <div class="map-preview-marker" style="left:${pinLeft}px;top:${pinTop}px;"><i class="fas fa-map-marker-alt"></i></div>
                <span class="map-preview-attribution">© OpenStreetMap</span>
                ${mapsUrl ? `<a class="map-preview-overlay-link" href="${mapsUrl}" target="_blank" rel="noopener" aria-label="Open in Google Maps"></a>` : ''}
            </div>
        `;
    }

    global.NextaStoreMapPreview = { render };
})(window);
