/**
 * NextaStore — in-app directions modal
 * ---------------------------------------------------------------------------
 * Tapping a location (a shared pin in Messages, a store's map or address, a
 * pickup location in an order) used to throw the person out to Google Maps in
 * a new tab. This opens a wide modal instead - the same family as the map
 * picker's - that shows the destination, the person's LIVE position, the road
 * between them, and the distance and travel time. Leaving the site is still
 * possible, but only through an explicit "Open in Google Maps" button.
 *
 * Usage:
 *   NextaStoreDirections.open({
 *     lat, lng,                  // destination (required)
 *     label: 'Store name',       // optional, shown in the header
 *     address: 'Plot 4, ...',    // optional, shown under the destination
 *     notes: 'Opposite the...',  // optional seller-written directions
 *     showRoute: true            // false = just a big map of the pin (no
 *                                // location prompt) - e.g. checking a pin
 *                                // you are about to send
 *   });
 *
 * Or declaratively, from any markup (including string-built HTML):
 *   <button data-nsd-open data-lat="0.31" data-lng="32.58"
 *           data-label="..." data-address="..." data-notes="...">
 *
 * How it works
 *   - Live position: navigator.geolocation. A quick coarse fix first so the
 *     numbers appear fast, then watchPosition refines it and the route is
 *     redrawn if the person has moved a real distance (never more than once
 *     every few seconds). Needs https or localhost, like any geolocation use.
 *   - Road route: the public OSRM demo server (router.project-osrm.org) - no
 *     API key. Driving profile; walking time is derived from the road distance.
 *     That server is a shared community service with no uptime promise, so if
 *     it fails the modal falls back to a clearly-labelled straight-line
 *     estimate instead of showing nothing. To switch provider, only
 *     ROUTE_ENDPOINT and fetchRoute() below need to change.
 *   - Map: Leaflet 1.9.4 (the version onboarding / dashboard already load),
 *     injected on demand so pages that never open this modal don't pay for it.
 *     If Leaflet can't load, the numbers still work and the map slot falls
 *     back to the static tile preview.
 * ---------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    const LEAFLET_VERSION = '1.9.4';
    const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
    const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
    const LEAFLET_TIMEOUT_MS = 12000;

    const ROUTE_ENDPOINT = 'https://router.project-osrm.org/route/v1/driving';
    const ROUTE_TIMEOUT_MS = 10000;

    const WALK_METERS_PER_SECOND = 1.35;   // about 4.9 km/h
    const WALK_MAX_METERS = 15000;         // beyond this a walking time isn't useful
    const STRAIGHT_LINE_ROAD_FACTOR = 1.3; // roads wind: rough road distance from a straight line
    const STRAIGHT_LINE_SPEED_MPS = 30000 / 3600; // ~30 km/h average, for the fallback estimate only
    const HERE_METERS = 40;                // closer than this = "you're here"
    const REROUTE_MIN_METERS = 80;         // don't redraw the route for GPS jitter
    const REROUTE_MIN_MS = 12000;          // ...and never more than this often
    const APPROX_ACCURACY_METERS = 500;    // worse than this = say the position is approximate
    const LOCATE_ZOOM = 16;                // zoom used when the person taps the locate button

    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* ---------- pure helpers (also exported, and unit-tested) ---------- */

    function distanceMeters(a, b) {
        const R = 6371000, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function formatDistance(m) {
        if (!Number.isFinite(m)) return '';
        if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
        const km = m / 1000;
        return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
    }

    function formatDuration(sec) {
        if (!Number.isFinite(sec)) return '';
        const mins = Math.max(1, Math.round(sec / 60));
        if (mins < 60) return `${mins} min`;
        const h = Math.floor(mins / 60), m = mins % 60;
        return m ? `${h} h ${m} min` : `${h} h`;
    }

    function googleMapsUrl(dest, origin) {
        const base = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
        return origin ? `${base}&origin=${origin.lat},${origin.lng}` : base;
    }

    /* ---------- Leaflet, loaded on demand ---------- */

    let leafletPromise = null;
    function loadLeaflet() {
        if (global.L && global.L.map) return Promise.resolve(global.L);
        if (leafletPromise) return leafletPromise;
        leafletPromise = new Promise((resolve, reject) => {
            // The stylesheet must be in before the map is built, or the panes and tiles
            // lay out wrong (and stay wrong until the next resize). Don't hang on it.
            let cssReady = Promise.resolve();
            if (!document.querySelector('link[href*="leaflet"][href$=".css"]')) {
                cssReady = new Promise(done => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = LEAFLET_CSS;
                    link.onload = link.onerror = () => done();
                    setTimeout(done, 5000);
                    document.head.appendChild(link);
                });
            }
            const script = document.createElement('script');
            script.src = LEAFLET_JS;
            script.async = true;
            const timer = setTimeout(() => reject(new Error('Leaflet timed out')), LEAFLET_TIMEOUT_MS);
            script.onload = () => {
                clearTimeout(timer);
                if (!(global.L && global.L.map)) { reject(new Error('Leaflet missing')); return; }
                cssReady.then(() => resolve(global.L));
            };
            script.onerror = () => { clearTimeout(timer); reject(new Error('Leaflet failed to load')); };
            document.head.appendChild(script);
        }).catch(err => { leafletPromise = null; throw err; });
        return leafletPromise;
    }

    /* ---------- the road route ---------- */

    async function fetchRoute(from, to, signal) {
        const url = `${ROUTE_ENDPOINT}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
        const res = await fetch(url, { signal, credentials: 'omit' });
        if (!res.ok) throw new Error(`Routing answered ${res.status}`);
        const data = await res.json();
        const route = data && data.routes && data.routes[0];
        if (!data || data.code !== 'Ok' || !route) throw new Error('No road route');
        return {
            source: 'road',
            distance: route.distance,
            duration: route.duration,
            coords: route.geometry.coordinates.map(([x, y]) => [y, x])
        };
    }

    function straightLineRoute(from, to) {
        const line = distanceMeters(from, to);
        const road = line * STRAIGHT_LINE_ROAD_FACTOR;
        return { source: 'line', distance: line, duration: road / STRAIGHT_LINE_SPEED_MPS, coords: [[from.lat, from.lng], [to.lat, to.lng]] };
    }

    /* ---------- the modal ---------- */

    let current = null;

    function close() {
        const st = current;
        if (!st) return;
        current = null;
        st.closed = true;
        if (st.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(st.watchId);
        if (st.routeAbort) st.routeAbort.abort();
        clearTimeout(st.rerouteTimer);
        if (st.resizeObserver) st.resizeObserver.disconnect();
        if (st.permStatus) { try { st.permStatus.onchange = null; } catch (_) {} st.permStatus = null; }
        if (st.map) { try { st.map.remove(); } catch (_) {} }
        document.removeEventListener('keydown', st.onKey, true);
        st.overlay.remove();
        document.body.classList.remove('nsd-open');
        if (st.opener && st.opener.isConnected && typeof st.opener.focus === 'function') { try { st.opener.focus({ preventScroll: true }); } catch (_) {} }
    }

    function open(options = {}) {
        const lat = Number(options.lat), lng = Number(options.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        if (current) close();

        const showRoute = options.showRoute !== false;
        const label = String(options.label || '').trim();
        const address = String(options.address || '').trim();
        const notes = String(options.notes || '').trim();
        const dest = { lat, lng };

        const overlay = document.createElement('div');
        overlay.className = 'nsd-overlay';
        overlay.id = 'nsdOverlay';
        const title = showRoute ? 'Directions' : (label || 'Location');
        const sub = showRoute ? (label ? `to ${label}` : 'to this location') : address;
        overlay.innerHTML = `
            <div class="nsd-panel" role="dialog" aria-modal="true" aria-labelledby="nsdTitle" tabindex="-1">
                <div class="nsd-head">
                    <div class="nsd-head-text">
                        <h3 id="nsdTitle">${esc(title)}</h3>
                        ${sub ? `<p>${esc(sub)}</p>` : ''}
                    </div>
                    <button type="button" class="nsd-close" data-nsd-close aria-label="Close">&times;</button>
                </div>
                <div class="nsd-body">
                    <div class="nsd-side">
                        ${showRoute ? '<div class="nsd-summary" id="nsdSummary" aria-live="polite"></div>' : ''}
                        <ul class="nsd-points">
                            ${showRoute ? `<li><span class="nsd-dot from"><i class="fas fa-circle" aria-hidden="true"></i></span><div><small>From</small><strong>Your live location</strong><span class="nsd-addr" id="nsdFromSub">Waiting for your location&hellip;</span></div></li>` : ''}
                            <li><span class="nsd-dot to"><i class="fas fa-location-dot" aria-hidden="true"></i></span><div><small>${showRoute ? 'To' : 'Location'}</small><strong>${esc(label || 'Selected location')}</strong>${address ? `<span class="nsd-addr">${esc(address)}</span>` : ''}</div></li>
                        </ul>
                        ${notes ? `<div class="nsd-seller-note"><b>Seller's directions</b>${esc(notes)}</div>` : ''}
                        <div class="nsd-actions">
                            ${showRoute ? '<button type="button" class="btn btn-outline" data-nsd-fit hidden><i class="fas fa-expand" aria-hidden="true"></i> Show whole route</button>' : ''}
                            <a class="btn btn-outline" id="nsdGoogle" href="${esc(showRoute ? googleMapsUrl(dest) : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Open in Google Maps</a>
                        </div>
                    </div>
                    <div class="nsd-map" id="nsdMap"></div>
                </div>
            </div>`;

        const st = {
            overlay, dest, showRoute, label,
            opener: document.activeElement,
            mapEl: overlay.querySelector('#nsdMap'),
            summaryEl: overlay.querySelector('#nsdSummary'),
            fromSubEl: overlay.querySelector('#nsdFromSub'),
            googleEl: overlay.querySelector('#nsdGoogle'),
            fitBtn: overlay.querySelector('[data-nsd-fit]'),
            user: null, hasFix: false, watchId: null,
            route: null, routeAbort: null, routeToken: 0, routing: false,
            lastRouteFrom: null, lastRouteAt: 0, rerouteTimer: null,
            map: null, L: null, userMarker: null, routeLines: [], fitted: false,
            locateBtn: null, centreOnFix: false, permStatus: null, locating: false,
            closed: false
        };
        current = st;

        st.onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
            if (e.key !== 'Tab') return;
            const focusables = [...overlay.querySelectorAll('button:not([hidden]):not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
            if (!focusables.length) return;
            const first = focusables[0], last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', st.onKey, true);

        overlay.addEventListener('click', e => {
            if (e.target === overlay || e.target.closest('[data-nsd-close]')) { close(); return; }
            if (e.target.closest('[data-nsd-retry]')) { st.centreOnFix = true; startLocating(st); return; }
            if (e.target.closest('[data-nsd-fit]')) { fitView(st, true); }
        });

        document.body.appendChild(overlay);
        document.body.classList.add('nsd-open');
        overlay.querySelector('.nsd-close').focus({ preventScroll: true });

        // Map first (so it is there while the browser asks for permission), and the
        // person's position in parallel - neither waits for the other.
        initMap(st);
        if (showRoute) startLocating(st);
        return { close };
    }

    /* ---------- map ---------- */

    function initMap(st) {
        loadLeaflet().then(L => {
            if (st.closed) return;
            st.L = L;
            const map = L.map(st.mapEl, { zoomControl: false }).setView([st.dest.lat, st.dest.lng], st.showRoute ? 14 : 16);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
            }).addTo(map);
            L.control.zoom({ position: 'topright' }).addTo(map);
            if (st.showRoute) addLocateControl(st, L, map);
            L.marker([st.dest.lat, st.dest.lng], {
                icon: L.divIcon({ className: '', html: '<div class="nsd-pin"><i class="fas fa-location-dot"></i></div>', iconSize: [32, 38], iconAnchor: [16, 38] }),
                keyboard: false, title: st.label || 'Destination'
            }).addTo(map);
            st.map = map;
            // The panel animates in and the viewport can change (phone rotation), so
            // keep Leaflet's idea of its size honest.
            requestAnimationFrame(() => map.invalidateSize());
            if (typeof ResizeObserver !== 'undefined') {
                st.resizeObserver = new ResizeObserver(() => map.invalidateSize());
                st.resizeObserver.observe(st.mapEl);
            }
            // Position/route may have arrived before the map was ready.
            if (st.user) drawUser(st);
            if (st.route) { drawRoute(st); fitView(st, false); }
        }).catch(() => {
            if (st.closed) return;
            // No Leaflet: the numbers still work; show the static tile map of the pin.
            if (global.NextaStoreMapPreview) {
                const h = Math.max(200, st.mapEl.clientHeight || 320);
                global.NextaStoreMapPreview.render(st.mapEl, { lat: st.dest.lat, lng: st.dest.lng, zoom: 16, height: h });
            }
        });
    }

    /** The round "find me" button on the map itself, stacked under the zoom buttons
     *  (same look as the map picker's). Tap = find / re-find my position and centre on it. */
    function addLocateControl(st, L, map) {
        const LocateControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-bar mp-locate-control nsd-locate-control');
                const link = L.DomUtil.create('a', 'mp-locate-btn nsd-locate-btn', container);
                link.href = '#';
                link.title = 'Show my location';
                link.setAttribute('role', 'button');
                link.setAttribute('aria-label', 'Show my location');
                link.innerHTML = '<i class="fas fa-location-crosshairs" aria-hidden="true"></i>';
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(link, 'click', e => { L.DomEvent.stop(e); onLocateClick(st); });
                st.locateBtn = link;
                return container;
            }
        });
        new LocateControl().addTo(map);
        syncLocateButton(st);
    }

    function syncLocateButton(st) {
        const b = st.locateBtn;
        if (!b) return;
        b.classList.toggle('is-loading', !!st.locating);
        b.classList.toggle('is-active', !!st.hasFix && !st.locating);
        b.innerHTML = st.locating
            ? '<i class="fas fa-circle-notch nsd-spin" aria-hidden="true"></i>'
            : '<i class="fas fa-location-crosshairs" aria-hidden="true"></i>';
    }

    function centreOnUser(st) {
        if (!st.map || !st.user) return;
        st.map.setView([st.user.lat, st.user.lng], Math.max(st.map.getZoom(), LOCATE_ZOOM), { animate: true });
    }

    function onLocateClick(st) {
        if (st.closed) return;
        if (st.user) { centreOnUser(st); return; }   // already have a position: just go to it
        st.centreOnFix = true;                         // otherwise ask, and go there once it arrives
        startLocating(st);
    }

    function drawUser(st) {
        if (!st.map || !st.L || !st.user) return;
        const ll = [st.user.lat, st.user.lng];
        if (!st.userMarker) {
            st.userMarker = st.L.marker(ll, {
                icon: st.L.divIcon({ className: '', html: '<div class="nsd-me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
                keyboard: false, zIndexOffset: 500, title: 'Your location'
            }).addTo(st.map);
        } else {
            st.userMarker.setLatLng(ll);
        }
    }

    function drawRoute(st) {
        if (!st.map || !st.L || !st.route) return;
        st.routeLines.forEach(l => l.remove());
        st.routeLines = [];
        const dashed = st.route.source === 'line';
        // A white casing under the coloured line keeps it readable on any tile colour.
        st.routeLines.push(st.L.polyline(st.route.coords, { color: '#ffffff', weight: 10, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(st.map));
        st.routeLines.push(st.L.polyline(st.route.coords, { color: '#008558', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', dashArray: dashed ? '2 10' : null, interactive: false }).addTo(st.map));
        if (st.userMarker) st.userMarker.setZIndexOffset(500);
    }

    function fitView(st, force) {
        if (!st.map || !st.L) return;
        if (st.fitted && !force) return;
        const points = [[st.dest.lat, st.dest.lng]];
        if (st.user) points.push([st.user.lat, st.user.lng]);
        if (st.route && st.route.coords) points.push(...st.route.coords);
        if (points.length < 2) return;
        const small = global.matchMedia && global.matchMedia('(max-width: 760px)').matches;
        st.map.fitBounds(st.L.latLngBounds(points), { padding: small ? [36, 36] : [56, 56], maxZoom: 17, animate: !!st.fitted });
        st.fitted = true;
    }

    /* ---------- live position ---------- */

    function geoError(err) {
        // 1 denied, 2 position unavailable, 3 timeout
        return err && err.code === 1 ? 'denied' : err && err.code === 2 ? 'unavailable' : 'error';
    }

    /** Watch the browser's own permission state, if it exposes one, so the modal
     *  reacts the moment the person flips "Location" to Allow in the address-bar
     *  lock menu - without them having to find and press "Try again". */
    function watchPermission(st) {
        if (st.permStatus || !navigator.permissions || !navigator.permissions.query) return;
        navigator.permissions.query({ name: 'geolocation' }).then(status => {
            if (st.closed) return;
            st.permStatus = status;
            status.onchange = () => {
                if (st.closed) return;
                if (status.state === 'granted' && !st.hasFix) startLocating(st);
            };
            if (status.state === 'denied' && !st.hasFix) showProblem(st, 'denied');
        }).catch(() => {});
    }

    function startLocating(st) {
        if (st.closed) return;
        if (st.watchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
        if (!('geolocation' in navigator)) { showProblem(st, 'unsupported'); return; }
        // Browsers only share location on https (or localhost). On a plain-http address
        // (e.g. a LAN IP while testing on a phone) the request is refused outright.
        if (global.isSecureContext === false) { showProblem(st, 'insecure'); return; }
        if (!st.hasFix) showLocating(st);
        st.locating = !st.hasFix;
        syncLocateButton(st);
        watchPermission(st);

        const onFix = pos => {
            if (st.closed) return;
            const c = pos.coords;
            st.user = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
            st.hasFix = true;
            st.locating = false;
            syncLocateButton(st);
            if (st.fromSubEl) st.fromSubEl.textContent = Number.isFinite(c.accuracy) ? `Accurate to about ${formatDistance(c.accuracy)}` : 'Location found';
            if (st.googleEl) st.googleEl.href = googleMapsUrl(st.dest, st.user);
            drawUser(st);
            if (st.centreOnFix) { st.centreOnFix = false; centreOnUser(st); }
            considerRouting(st);
        };
        const fail = kind => {
            if (st.closed || st.hasFix) return;     // a hiccup after a good fix is ignored: keep the last one
            st.locating = false;
            st.centreOnFix = false;
            syncLocateButton(st);
            if (kind === 'denied' && st.watchId != null) { navigator.geolocation.clearWatch(st.watchId); st.watchId = null; }
            showProblem(st, kind);
        };
        // The watch only reports "denied"; other failures are reported by the lookups below,
        // so a flaky watch can't flash an error over a position we are still waiting for.
        const onWatchFail = err => {
            if (!st.closed && geoError(err) === 'denied') fail('denied');
        };

        // Coarse-and-fast first (cell/Wi-Fi), so numbers appear quickly. Desktops often have
        // no GPS and the coarse lookup can fail, so on anything but "denied" try once more
        // with high accuracy before giving up. The watch then keeps refining the position.
        navigator.geolocation.getCurrentPosition(onFix, err => {
            if (st.closed) return;
            if (geoError(err) === 'denied') { fail('denied'); return; }
            navigator.geolocation.getCurrentPosition(onFix, e2 => fail(geoError(e2)), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
        }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
        st.watchId = navigator.geolocation.watchPosition(onFix, onWatchFail, { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 });
    }

    /* ---------- routing ---------- */

    function considerRouting(st) {
        if (st.closed || !st.user) return;
        const now = Date.now();
        if (st.lastRouteFrom) {
            const moved = distanceMeters(st.lastRouteFrom, st.user);
            if (moved < REROUTE_MIN_METERS) return;
            const wait = REROUTE_MIN_MS - (now - st.lastRouteAt);
            if (wait > 0) {                         // moved enough, but too soon: do it once the gap has passed
                clearTimeout(st.rerouteTimer);
                st.rerouteTimer = setTimeout(() => considerRouting(st), wait + 50);
                return;
            }
        }
        requestRoute(st);
    }

    async function requestRoute(st) {
        if (st.routeAbort) st.routeAbort.abort();
        const controller = new AbortController();
        st.routeAbort = controller;
        const token = ++st.routeToken;
        const from = { lat: st.user.lat, lng: st.user.lng };
        st.lastRouteFrom = from;
        st.lastRouteAt = Date.now();
        st.routing = true;
        if (!st.route) showRouting(st);

        const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
        let route;
        try {
            route = await fetchRoute(from, st.dest, controller.signal);
        } catch (err) {
            // Superseded by a newer request or the modal closed: say nothing.
            if (st.closed || token !== st.routeToken) { clearTimeout(timer); return; }
            route = straightLineRoute(from, st.dest);
        }
        clearTimeout(timer);
        if (st.closed || token !== st.routeToken) return;
        st.routing = false;
        st.route = route;
        drawRoute(st);
        fitView(st, false);
        if (st.fitBtn) st.fitBtn.hidden = false;
        showResult(st);
    }

    /* ---------- the summary panel ---------- */

    function setSummary(st, html, problem) {
        if (!st.summaryEl) return;
        st.summaryEl.classList.toggle('is-problem', !!problem);
        st.summaryEl.innerHTML = html;
    }

    function showLocating(st) {
        setSummary(st, `<div class="nsd-status"><i class="fas fa-circle-notch nsd-spin" aria-hidden="true"></i><div><strong>Finding your location&hellip;</strong><span>Allow location access when your browser asks, so we can work out the distance and travel time from where you are.</span></div></div>`);
    }

    function showRouting(st) {
        setSummary(st, `<div class="nsd-status"><i class="fas fa-circle-notch nsd-spin" aria-hidden="true"></i><div><strong>Working out the route&hellip;</strong><span>Got your location. Finding the best road to get there.</span></div></div>`);
    }

    function showProblem(st, kind) {
        const text = {
            denied: ['Location access is off', 'This site is blocked from using your location. Click the lock icon next to the address bar, set Location to Allow, and this will try again on its own. You can still see where it is on the map.'],
            unavailable: ['Couldn\u2019t work out where you are', 'Your device couldn\u2019t find its position. On a computer, make sure Location is turned on in your system settings (Windows: Settings \u203a Privacy \u203a Location), then try again.'],
            insecure: ['Location needs a secure connection', 'Browsers only share location on https pages (or localhost). Open the site over https, then try again. You can still see where it is on the map.'],
            unsupported: ['Location isn\u2019t available here', 'This browser can\u2019t share your location. You can still see where it is on the map, or open it in Google Maps.'],
            error: ['Couldn\u2019t get your location', 'That took too long. Check that location services are on and you have a signal, then try again.']
        }[kind] || ['Couldn\u2019t get your location', 'Please try again.'];
        if (st.fromSubEl) st.fromSubEl.textContent = 'Not available';
        const retry = (kind === 'unsupported' || kind === 'insecure') ? '' : '<button type="button" class="btn btn-primary btn-sm" data-nsd-retry><i class="fas fa-rotate-right" aria-hidden="true"></i> Try again</button>';
        setSummary(st, `<div class="nsd-status"><i class="fas fa-location-crosshairs" aria-hidden="true"></i><div><strong>${text[0]}</strong><span>${text[1]}</span>${retry}</div></div>`, true);
    }

    function showResult(st) {
        const r = st.route;
        const straight = distanceMeters(st.user, st.dest);
        if (straight < HERE_METERS) {
            setSummary(st, `<div class="nsd-status"><i class="fas fa-circle-check" aria-hidden="true"></i><div><strong>You\u2019re here</strong><span>You are at ${esc(st.label || 'this location')} right now.</span></div></div>`);
            return;
        }
        const road = r.source === 'road';
        const walk = r.distance <= WALK_MAX_METERS ? r.distance / WALK_METERS_PER_SECOND : null;
        const notes = [];
        if (road) notes.push('Estimate without live traffic \u2014 allow extra time at busy hours.');
        else notes.push('Couldn\u2019t load a road route just now, so this is a rough straight-line estimate.');
        if (st.user.accuracy > APPROX_ACCURACY_METERS) notes.push(`Your position is approximate (about ${esc(formatDistance(st.user.accuracy))}).`);
        setSummary(st, `
            <div class="nsd-stats">
                <div class="nsd-stat"><small>${road ? 'Distance' : 'Straight line'}</small><strong>${esc(formatDistance(r.distance))}</strong></div>
                <div class="nsd-stat"><small>${road ? 'By car or boda' : 'Drive (rough)'}</small><strong>${esc(formatDuration(r.duration))}</strong></div>
            </div>
            ${walk ? `<p class="nsd-alt"><i class="fas fa-person-walking" aria-hidden="true"></i> Walking: about ${esc(formatDuration(walk))}</p>` : ''}
            <p class="nsd-note">${notes.join(' ')}</p>`);
    }

    /* ---------- declarative trigger: <el data-nsd-open data-lat data-lng ...> ---------- */

    document.addEventListener('click', e => {
        const el = e.target.closest && e.target.closest('[data-nsd-open]');
        if (!el) return;
        const lat = parseFloat(el.dataset.lat), lng = parseFloat(el.dataset.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;
        e.preventDefault();
        e.stopPropagation();
        open({
            lat, lng,
            label: el.dataset.label || '',
            address: el.dataset.address || '',
            notes: el.dataset.notes || '',
            showRoute: el.dataset.showRoute !== 'false'
        });
    });

    // Non-<button> triggers (role="button") need Enter / Space to work like a button.
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest && e.target.closest('[data-nsd-open][role="button"]');
        if (!el || el.tagName === 'BUTTON' || el.tagName === 'A') return;
        e.preventDefault();
        el.click();
    });

    global.NextaStoreDirections = { open, close, distanceMeters, formatDistance, formatDuration, googleMapsUrl };
})(window);
