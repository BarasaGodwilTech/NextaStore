/**
 * NextaStore — shared Leaflet pin-drop location picker
 * ---------------------------------------------------------------------------
 * Used by onboarding.html and dashboard.js's Settings > Store location for
 * choosing a store's location: a required district/city, plus an optional
 * precise pin for the shop itself.
 *
 * Usage:
 *   NextaStoreMapPicker.open({
 *     initialDistrict: 'kampala',       // any key of districtCoordinates
 *     initialCoordinates: '0.3136,32.5811', // 'lat,lng' string, or ''
 *     onSave: ({ lat, lng, district, placeName, suggestedAddress, suggestedDirections }) => { ... },
 *     onCancel: () => { ... } // optional
 *   });
 * lat/lng are null in the result when only a district/city was chosen and no
 * pin was dropped — that's a valid save, not an error (see the Save button
 * handler in open() below).
 *
 * Mobile rebuild: the modal used to give the map roughly half the screen
 * on a phone, with the other half a scrolling sidebar of region/district
 * filters plus a list of canned per-district "suggested locations" the
 * person had to scroll through to use — a second scroll area nested inside
 * an already-small modal, and a list of guesses (a generic "Town Center" /
 * "Main Market Area" per district) rather than anything genuinely tied to
 * the seller's own shop. Both are gone. The map is now the modal: region
 * and district/city sit in a single compact bar above it, everything else
 * (a short one-time guidance banner, and the selected-location summary
 * once something is chosen) floats over the map itself rather than
 * competing with it for vertical space, and the same layout is used at
 * every width instead of a separate mobile-only arrangement.
 *
 * Reverse-geocodes a dropped/dragged pin via Nominatim (OSM — no new API
 * key needed) so callers get a human-readable place name instead of just
 * raw lat/lng, plus a best-effort suggestedAddress/suggestedDirections to
 * auto-draft those fields (callers should still let the seller edit them
 * freely).
 * ---------------------------------------------------------------------------
 */
(function (global) {
    const districtCoordinates = {
        kampala: [0.3136, 32.5811], jinja: [0.4333, 33.1833], mbale: [1.0667, 34.1667],
        mbarara: [-0.6067, 30.6500], gulu: [2.7667, 32.3000], arua: [3.0167, 30.9167],
        entebbe: [0.0567, 32.4633], soroti: [1.7167, 33.7000], lira: [2.2500, 32.9000],
        fortportal: [0.9667, 30.2667], hoima: [1.4333, 31.3500], masaka: [-0.3333, 31.7333],
        kabale: [-1.2500, 29.9833], kasese: [0.1833, 30.0833],
        wakiso: [0.3833, 32.5833], mukono: [0.3667, 32.7500], kira: [0.3833, 32.6333],
        luwero: [0.8489, 32.5689], mpigi: [0.3667, 32.3333], kalangala: [-0.5000, 32.5000],
        nakasongola: [1.3667, 32.4500], butambala: [0.5500, 32.3500], gomba: [0.2833, 31.8833],
        kyankwanzi: [0.7833, 31.9333], kyotera: [-0.0833, 31.5000], rakai: [-0.8333, 31.4167],
        ssembabule: [-0.3667, 31.4667], lyantonde: [-0.4500, 31.1167],
        tororo: [0.8833, 34.1833], iganga: [0.6167, 33.4667], busia: [0.4667, 34.0833],
        kumi: [1.5000, 33.9667], pallisa: [1.1833, 33.7167], budaka: [0.7833, 33.9500],
        butaleja: [0.8500, 34.0000], namisindwa: [0.9167, 34.2333], manafwa: [0.9500, 34.3167],
        bugiri: [0.5667, 33.7500], buyende: [1.1333, 33.1167], kibuku: [0.9833, 33.9333],
        namutumba: [0.7833, 33.6833],
        kitgum: [3.2833, 32.8833], pader: [2.9000, 33.2333], lamwo: [3.6000, 32.9667],
        agago: [2.9167, 33.6167], omoro: [2.6167, 32.3167], nebbi: [2.4833, 31.0833],
        moyo: [3.6500, 31.7167], adjumani: [3.3000, 31.8000], yumbe: [3.4667, 31.2500],
        koboko: [3.4000, 30.9667],
        bushenyi: [-0.5833, 30.2000], ntungamo: [-0.8833, 30.2667], rukungiri: [-0.7833, 29.9333],
        isingiro: [-0.8500, 30.8167], kiruhura: [-0.2000, 30.7833], ibanda: [-0.1167, 30.4833],
        kamwenge: [0.1833, 30.4000], kyenjojo: [0.6500, 30.6000], kyegegwa: [0.5000, 30.7000],
        mitooma: [-0.2333, 30.3500], rubirizi: [-0.2333, 30.1167], buhweju: [-0.4500, 30.3500],
        sheema: [-0.4500, 30.4167]
    };

    const CITIES = ['kampala', 'jinja', 'mbale', 'mbarara', 'gulu', 'arua', 'entebbe', 'soroti', 'lira', 'fortportal', 'hoima', 'masaka', 'kabale', 'kasese'];

    const REGIONS = {
        central: { cities: ['kampala', 'entebbe', 'masaka'], districts: ['wakiso', 'mukono', 'kira', 'luwero', 'mpigi', 'kalangala', 'nakasongola', 'butambala', 'gomba', 'kyankwanzi', 'kyotera', 'rakai', 'ssembabule', 'lyantonde'] },
        eastern: { cities: ['jinja', 'mbale', 'soroti'], districts: ['tororo', 'iganga', 'busia', 'kumi', 'pallisa', 'budaka', 'butaleja', 'namisindwa', 'manafwa', 'bugiri', 'buyende', 'kibuku', 'namutumba'] },
        northern: { cities: ['gulu', 'arua', 'lira'], districts: ['kitgum', 'pader', 'lamwo', 'agago', 'omoro', 'nebbi', 'moyo', 'adjumani', 'yumbe', 'koboko'] },
        western: { cities: ['mbarara', 'fortportal', 'hoima', 'kabale', 'kasese'], districts: ['bushenyi', 'ntungamo', 'rukungiri', 'isingiro', 'kiruhura', 'ibanda', 'kamwenge', 'kyenjojo', 'kyegegwa', 'mitooma', 'rubirizi', 'buhweju', 'sheema'] }
    };

    function regionForDistrict(district) {
        for (const [region, data] of Object.entries(REGIONS)) {
            if (data.cities.includes(district) || data.districts.includes(district)) return region;
        }
        return 'central';
    }

    function districtsInRegion(region) {
        const data = REGIONS[region] || REGIONS.central;
        return [...data.cities, ...data.districts];
    }

    /** Great-circle distance in km — plenty accurate at Uganda's scale for
     *  picking "which of our ~64 districts is this GPS fix closest to". */
    function haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Closest district/city centre (as the crow flies) to a raw GPS fix —
     *  used to pre-select the region/district dropdowns after "Use my
     *  location", since the browser only gives us coordinates. */
    function nearestDistrict(lat, lng) {
        let best = null, bestDist = Infinity;
        for (const [key, [dlat, dlng]] of Object.entries(districtCoordinates)) {
            const d = haversineKm(lat, lng, dlat, dlng);
            if (d < bestDist) { bestDist = d; best = key; }
        }
        return best || 'kampala';
    }

    // Keys are single lowercase words; a few need a space to read correctly.
    const DISPLAY_NAMES = { fortportal: 'Fort Portal' };

    function label(district) {
        if (!district) return '';
        return DISPLAY_NAMES[district] || district.charAt(0).toUpperCase() + district.slice(1);
    }

    /** 'City' or 'District' — lets callers say which one was chosen. */
    function kind(district) {
        return CITIES.includes(district) ? 'City' : 'District';
    }

    function popupHTML(district, lat, lng, placeName) {
        return `
            <div class="map-popup-content">
                <div class="map-popup-header"><i class="fas fa-map-marker-alt"></i><h4>${placeName ? escapeHtml(placeName) : 'Selected Location'}</h4></div>
                <div class="map-popup-body">
                    <div class="map-popup-row"><span class="map-popup-label">District:</span><span class="map-popup-value">${label(district)}</span></div>
                    <div class="map-popup-row"><span class="map-popup-label">Coordinates:</span><span class="map-popup-value">${lat}, ${lng}</span></div>
                    <div class="map-popup-divider"></div>
                    <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" class="map-popup-link"><i class="fas fa-external-link-alt"></i> View on Google Maps</a>
                </div>
            </div>
        `;
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // A tall pin obscures the exact spot it's marking, which makes it hard
    // to nudge a pin to a precise storefront location. The marker is a
    // compact ring-and-dot instead, draggable so nudging doesn't require
    // re-clicking the map. iconSize is deliberately bigger than the visible
    // ring (see .marker-crosshair's own smaller width in CSS) so the actual
    // drag target meets the ~44px touch-target guideline on phones without
    // the marker itself looking oversized.
    const precisionIcon = () => L.divIcon({
        className: 'custom-map-marker custom-map-marker--precision',
        html: '<div class="marker-crosshair"><span class="marker-crosshair-pulse"></span><span class="marker-crosshair-ring"></span><span class="marker-crosshair-dot"></span></div>',
        iconSize: [44, 44],
        iconAnchor: [22, 22]
    });

    // Inline SVG so the modal's own controls (close / dismiss / remove pin)
    // never depend on the Font Awesome CDN loading — on a weak connection an
    // icon-font failure would otherwise leave these buttons blank.
    const ICON_X = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

    let state = null; // { map, marker, district, onSave, onCancel, overlay, guidanceDismissed }

    // Reverse-geocode via Nominatim (OpenStreetMap) — the app already uses
    // OSM tiles via Leaflet, so this needs no new API key/dependency.
    // Best-effort only: a failed/slow lookup never blocks pin placement,
    // it just leaves the raw coordinates as the headline a little longer.
    async function reverseGeocode(lat, lng) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
                headers: { 'Accept-Language': 'en' }
            });
            if (!res.ok) return null;
            const data = await res.json();
            const a = data.address || {};
            const placeName = [a.road || a.neighbourhood || a.suburb, a.suburb && a.suburb !== (a.road || a.neighbourhood) ? a.suburb : null, a.city || a.town || a.county]
                .filter(Boolean).slice(0, 2).join(', ') || data.display_name || null;
            const suggestedAddress = data.display_name || null;
            const landmarkBits = [a.road, a.neighbourhood || a.suburb, a.city || a.town].filter(Boolean);
            const suggestedDirections = landmarkBits.length ? `Near ${landmarkBits.join(', ')}` : null;
            return { placeName, suggestedAddress, suggestedDirections };
        } catch (err) {
            console.error('Reverse geocode failed:', err);
            return null;
        }
    }

    /** Shows/hides the one-line "tap the map" banner: visible only while
     *  there's no pin yet and the person hasn't already dismissed it this
     *  time the modal is open (switching district clears the pin, so the
     *  banner correctly reappears then — but not after an explicit
     *  dismissal, which would otherwise feel like it "came back"). */
    function updateGuidance() {
        const el = document.getElementById('mpGuidance');
        if (!el) return;
        el.style.display = (!state.marker && !state.guidanceDismissed) ? 'flex' : 'none';
    }

    /** The summary card floats over the bottom of the map, so a pin dropped
     *  (or dragged) into that strip would sit hidden underneath it. Nudge
     *  the map just enough to bring the pin back into the clear area. */
    function keepPinInView() {
        if (!state?.map || !state.marker || typeof state.map.panInside !== 'function') return;
        const card = document.getElementById('mpLocationCard');
        const cardH = card && card.style.display !== 'none' ? card.offsetHeight + 24 : 24;
        try {
            state.map.panInside(state.marker.getLatLng(), { paddingTopLeft: [24, 24], paddingBottomRight: [24, cardH + 22], animate: true });
        } catch (err) { /* cosmetic only */ }
    }

    function placeMarker(latlng, district) {
        if (state.marker) state.map.removeLayer(state.marker);
        state.marker = L.marker(latlng, { icon: precisionIcon(), draggable: true }).addTo(state.map);
        const lat = (latlng.lat ?? latlng[0]).toFixed(6);
        const lng = (latlng.lng ?? latlng[1]).toFixed(6);
        setLocateStatus('');
        updateGuidance();

        const card = document.getElementById('mpLocationCard');
        const placeEl = document.getElementById('mpInfoPlace');
        const metaEl = document.getElementById('mpInfoMeta');
        if (card) card.style.display = 'flex';
        if (placeEl) placeEl.textContent = 'Looking up address\u2026';
        // Raw coordinates stay visible immediately as fine print; the
        // headline upgrades to a human-readable place name once the
        // reverse-geocode call resolves.
        if (metaEl) metaEl.textContent = `${label(district)} · ${lat}, ${lng}`;
        keepPinInView();
        state.marker.bindPopup(popupHTML(district, lat, lng), { className: 'custom-map-popup', maxWidth: 280 });
        state.geocode = null;

        const runGeocode = (currentLat, currentLng) => {
            reverseGeocode(currentLat, currentLng).then(result => {
                if (!state || state.marker?.getLatLng()?.lat?.toFixed(6) !== currentLat) return;
                state.geocode = result;
                const pe = document.getElementById('mpInfoPlace');
                if (pe) pe.textContent = result?.placeName || 'Address unavailable — coordinates still saved';
                if (state.marker) state.marker.setPopupContent(popupHTML(district, currentLat, currentLng, result?.placeName));
            });
        };
        runGeocode(lat, lng);

        state.marker.on('dragstart', () => {
            document.getElementById('mpMapContainer')?.classList.add('is-dragging-pin');
        });
        state.marker.on('dragend', () => {
            document.getElementById('mpMapContainer')?.classList.remove('is-dragging-pin');
            const p = state.marker.getLatLng();
            const nLat = p.lat.toFixed(6);
            const nLng = p.lng.toFixed(6);
            const me = document.getElementById('mpInfoMeta');
            const pe = document.getElementById('mpInfoPlace');
            if (me) me.textContent = `${label(state.district)} · ${nLat}, ${nLng}`;
            if (pe) pe.textContent = 'Looking up address\u2026';
            keepPinInView();
            runGeocode(nLat, nLng);
        });

        return { lat, lng };
    }

    /** Shows/hides the small status line used for "Use my location" feedback
     *  (locating\u2026 / permission denied / etc). Hides the one-time
     *  guidance banner while it's up so the two never compete for the same
     *  corner of the map, and restores the guidance's normal visibility
     *  once the status is cleared. */
    function setLocateStatus(message, isError) {
        const el = document.getElementById('mpLocateStatus');
        if (!el) return;
        if (!message) {
            el.style.display = 'none';
            el.textContent = '';
            updateGuidance();
            return;
        }
        const guidance = document.getElementById('mpGuidance');
        if (guidance) guidance.style.display = 'none';
        el.textContent = message;
        el.classList.toggle('is-error', !!isError);
        el.style.display = 'flex';
    }

    function setLocateButtonBusy(link, busy) {
        if (!link) return;
        link.classList.toggle('is-loading', busy);
        link.setAttribute('aria-busy', busy ? 'true' : 'false');
        link.innerHTML = busy ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>' : '<i class="fas fa-location-crosshairs" aria-hidden="true"></i>';
    }

    /** "Use my location": asks the browser for a GPS/network fix, picks the
     *  nearest district/city so the region + district selects stay in sync,
     *  then drops the precision pin on the seller's *actual* coordinates
     *  (not the district centre) so this is at least as accurate as
     *  tapping the map by hand — usually more so. */
    function useMyLocation(link) {
        if (!state) return;
        if (!navigator.geolocation) {
            setLocateStatus('Your browser doesn\u2019t support finding your location. Tap the map to place a pin instead.', true);
            return;
        }
        setLocateButtonBusy(link, true);
        setLocateStatus('Finding your location\u2026', false);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                if (!state) return; // modal closed while we were waiting
                setLocateButtonBusy(link, false);
                setLocateStatus('');
                const { latitude: lat, longitude: lng } = pos.coords;
                const district = nearestDistrict(lat, lng);
                state.district = district;
                const region = regionForDistrict(district);
                const regionSelect = document.getElementById('mpRegionSelect');
                if (regionSelect) regionSelect.value = region;
                rebuildDistrictOptions(region, district);
                state.map.setView([lat, lng], 16);
                placeMarker({ lat, lng }, district);
            },
            (err) => {
                if (!state) return;
                setLocateButtonBusy(link, false);
                let message = 'Couldn\u2019t get your location. You can still tap the map to place a pin.';
                if (err.code === err.PERMISSION_DENIED) {
                    message = 'Location access was denied. Allow it in your browser settings, or tap the map to place a pin instead.';
                } else if (err.code === err.TIMEOUT) {
                    message = 'Finding your location took too long. Try again, or tap the map to place a pin.';
                }
                setLocateStatus(message, true);
            },
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
    }

    function removePin() {
        if (!state) return;
        if (state.marker) { state.map.removeLayer(state.marker); state.marker = null; }
        state.geocode = null;
        const card = document.getElementById('mpLocationCard');
        if (card) card.style.display = 'none';
        updateGuidance();
    }

    function rebuildDistrictOptions(region, selected) {
        const select = document.getElementById('mpDistrictSelect');
        select.innerHTML = districtsInRegion(region).map(d => `
            <option value="${d}" ${d === selected ? 'selected' : ''}>${label(d)}${CITIES.includes(d) ? ' (City)' : ''}</option>
        `).join('');
    }

    function switchDistrict(district) {
        state.district = district;
        const center = districtCoordinates[district];
        if (!center) return;
        state.map.setView(center, 13);
        removePin();
    }

    function close(cancelled) {
        if (!state) return;
        if (state.map) { state.map.remove(); }
        state.overlay?.remove();
        if (cancelled && typeof state.onCancel === 'function') state.onCancel();
        document.body.classList.remove('map-picker-open');
        state = null;
    }

    function open({ initialDistrict, initialCoordinates, onSave, onCancel } = {}) {
        const district = districtCoordinates[initialDistrict] ? initialDistrict : 'kampala';
        const center = districtCoordinates[district];
        const hasExisting = Boolean(initialCoordinates);
        const region = regionForDistrict(district);

        const overlay = document.createElement('div');
        overlay.className = 'map-modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="map-modal-content" role="dialog" aria-modal="true" aria-labelledby="mapPickerTitle">
                <div class="map-modal-header">
                    <h3 id="mapPickerTitle">Select Your Store Location</h3>
                    <button type="button" class="map-modal-close" id="mpCloseBtn" aria-label="Close map picker">${ICON_X}</button>
                </div>
                <div class="map-modal-filters">
                    <div class="filter-group">
                        <label class="filter-label" for="mpRegionSelect">Region</label>
                        <select class="filter-select" id="mpRegionSelect">
                            <option value="central">Central</option>
                            <option value="eastern">Eastern</option>
                            <option value="northern">Northern</option>
                            <option value="western">Western</option>
                        </select>
                    </div>
                    <div class="filter-group">
                        <label class="filter-label" for="mpDistrictSelect">District / City</label>
                        <select class="filter-select" id="mpDistrictSelect"></select>
                    </div>
                </div>
                <div class="map-modal-map-section">
                    <div id="mpMapContainer" class="custom-map-container"></div>
                    <div class="map-guidance" id="mpGuidance" style="display:none;">
                        <i class="fas fa-hand-pointer" aria-hidden="true"></i>
                        <span>Tap the map to mark your exact shop (optional). Drag the pin to adjust.</span>
                        <button type="button" class="map-guidance-dismiss" id="mpGuidanceDismiss" aria-label="Dismiss tip">${ICON_X}</button>
                    </div>
                    <div class="map-locate-status" id="mpLocateStatus" role="status" style="display:none;"></div>
                    <div class="map-location-card" id="mpLocationCard" style="display:${hasExisting ? 'flex' : 'none'}">
                        <div class="map-location-card-icon"><i class="fas fa-map-marker-alt" aria-hidden="true"></i></div>
                        <div class="map-location-card-text">
                            <div class="map-location-card-place" id="mpInfoPlace">${hasExisting ? 'Looking up address\u2026' : ''}</div>
                            <div class="map-location-card-meta" id="mpInfoMeta">${hasExisting ? `${label(district)} · ${initialCoordinates}` : ''}</div>
                        </div>
                        <button type="button" class="map-location-card-remove" id="mpRemovePinBtn" aria-label="Remove pin">${ICON_TRASH}</button>
                    </div>
                </div>
                <div class="map-action-bar">
                    <button type="button" class="btn btn-secondary" id="mpCancelBtn"><i class="fas fa-times"></i> Cancel</button>
                    <button type="button" class="btn btn-primary" id="mpSaveBtn"><i class="fas fa-check"></i> Save Location</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        state = { map: null, marker: null, district, onSave, onCancel, overlay, guidanceDismissed: false };
        document.body.classList.add('map-picker-open');

        document.getElementById('mpRegionSelect').value = region;
        rebuildDistrictOptions(region, district);

        document.getElementById('mpCloseBtn').addEventListener('click', () => close(true));
        document.getElementById('mpCancelBtn').addEventListener('click', () => close(true));
        document.getElementById('mpRemovePinBtn').addEventListener('click', () => removePin());
        document.getElementById('mpGuidanceDismiss').addEventListener('click', () => {
            state.guidanceDismissed = true;
            updateGuidance();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(true); });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                close(true);
            }
        });
        overlay.tabIndex = -1;
        overlay.focus({ preventScroll: true });

        document.getElementById('mpRegionSelect').addEventListener('change', (e) => {
            rebuildDistrictOptions(e.target.value, null);
            const first = document.getElementById('mpDistrictSelect').value;
            switchDistrict(first);
        });
        document.getElementById('mpDistrictSelect').addEventListener('change', (e) => switchDistrict(e.target.value));

        document.getElementById('mpSaveBtn').addEventListener('click', () => {
            // A dropped pin is optional (it just refines the district-level
            // location for nearby shoppers) — the district/city choice on
            // its own is enough to save. Only a marker adds lat/lng and the
            // reverse-geocoded extras to the result.
            const marker = state.marker;
            const latlng = marker ? marker.getLatLng() : null;
            const result = {
                lat: latlng ? latlng.lat.toFixed(6) : null,
                lng: latlng ? latlng.lng.toFixed(6) : null,
                district: state.district,
                placeName: latlng ? (state.geocode?.placeName || null) : null,
                suggestedAddress: latlng ? (state.geocode?.suggestedAddress || null) : null,
                suggestedDirections: latlng ? (state.geocode?.suggestedDirections || null) : null
            };
            const savedCallback = state.onSave;
            close(false);
            if (typeof savedCallback === 'function') savedCallback(result);
        });

        // Leaflet needs the container to have real layout/size before
        // init — same one-tick delay dashboard.js's copy of this uses,
        // since the modal has only just been inserted into the DOM.
        setTimeout(() => {
            if (!state) return; // closed again before this fired
            state.map = L.map('mpMapContainer', { zoomControl: false }).setView(center, hasExisting ? 15 : 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(state.map);
            L.control.zoom({ position: 'topright' }).addTo(state.map);

            const LocateControl = L.Control.extend({
                options: { position: 'topright' },
                onAdd: function () {
                    const container = L.DomUtil.create('div', 'leaflet-bar mp-locate-control');
                    const link = L.DomUtil.create('a', 'mp-locate-btn', container);
                    link.href = '#';
                    link.title = 'Use my current location';
                    link.setAttribute('role', 'button');
                    link.setAttribute('aria-label', 'Use my current location');
                    link.innerHTML = '<i class="fas fa-location-crosshairs" aria-hidden="true"></i>';
                    L.DomEvent.disableClickPropagation(container);
                    L.DomEvent.on(link, 'click', (e) => { L.DomEvent.stop(e); useMyLocation(link); });
                    return container;
                }
            });
            new LocateControl().addTo(state.map);

            state.map.on('click', (e) => placeMarker(e.latlng, state.district));

            requestAnimationFrame(() => state?.map?.invalidateSize());

            if (hasExisting) {
                const [lat, lng] = initialCoordinates.split(',').map(Number);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    placeMarker({ lat, lng }, district);
                }
            } else {
                updateGuidance();
            }
        }, 100);
    }

    global.NextaStoreMapPicker = { open, close: () => close(true), districtCoordinates, label, kind };
})(window);
