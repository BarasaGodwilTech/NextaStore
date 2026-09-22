/**
 * NextaStore — shared Leaflet pin-drop location picker
 * ---------------------------------------------------------------------------
 * Item 2: the onboarding wizard's location step only had a plain district
 * `<select>`, while dashboard.js's Settings page already had a full
 * Leaflet map picker (region/district filters, curated per-district
 * suggestions, click-to-drop-a-pin). This module is that same picker,
 * pulled out into a standalone, callback-based API so onboarding.js can use
 * it too, without either page depending on the other's code.
 *
 * dashboard.js's Settings picker is left exactly as it already was — it's
 * working, load-bearing code, and swapping it over to call through this
 * module as well would be a much bigger, riskier refactor for no user-
 * facing benefit. This does mean the region/district/suggestion data below
 * is duplicated rather than shared; that's a conscious, documented
 * trade-off (see item 4's dedup goal) in favor of not touching working code.
 *
 * Usage:
 *   NextaStoreMapPicker.open({
 *     initialDistrict: 'kampala',       // any key of districtCoordinates
 *     initialCoordinates: '0.3136,32.5811', // 'lat,lng' string, or ''
 *     onSave: ({ lat, lng, district, placeName, suggestedAddress, suggestedDirections }) => { ... },
 *     onCancel: () => { ... } // optional
 *   });
 *
 * Map redesign (pre-deploy pass): once a pin is dropped/dragged, this
 * reverse-geocodes it via Nominatim (OSM — no new API key needed) so
 * callers get a human-readable place name instead of just raw lat/lng, and
 * a best-effort suggestedAddress/suggestedDirections to auto-draft those
 * fields with (callers should still let the seller edit them freely). The
 * marker itself switches to a small precision-crosshair style after
 * placement, and is draggable, so it stops obscuring the exact spot and
 * can be nudged without re-clicking the map.
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

    const CITY_SUGGESTIONS = {
        kampala: [{ name: 'Central Business District', landmark: 'City Center' }, { name: 'Nakasero Market Area', landmark: 'Nakasero Market' }, { name: 'Industrial Area', landmark: 'Industrial Area' }],
        jinja: [{ name: 'Jinja Town Center', landmark: 'Main Street' }, { name: 'Source of the Nile', landmark: 'Nile River' }],
        mbale: [{ name: 'Mbale Town Center', landmark: 'Main Street' }, { name: 'Mbale Market', landmark: 'Main Market' }],
        mbarara: [{ name: 'Mbarara Town Center', landmark: 'High Street' }, { name: 'Mbarara Market', landmark: 'Main Market' }],
        gulu: [{ name: 'Gulu Town Center', landmark: 'Main Street' }, { name: 'Gulu Market', landmark: 'Main Market' }],
        arua: [{ name: 'Arua Town Center', landmark: 'Main Street' }, { name: 'Arua Market', landmark: 'Main Market' }],
        entebbe: [{ name: 'Entebbe Town Center', landmark: 'Main Street' }, { name: 'Airport Area', landmark: 'Airport' }],
        soroti: [{ name: 'Soroti Town Center', landmark: 'Main Street' }, { name: 'Soroti Rock Area', landmark: 'Soroti Rock' }],
        lira: [{ name: 'Lira Town Center', landmark: 'Main Street' }, { name: 'Lira Market', landmark: 'Main Market' }],
        fortportal: [{ name: 'Fort Portal Town Center', landmark: 'Main Street' }, { name: 'Tourist Center Area', landmark: 'Tourist Area' }],
        hoima: [{ name: 'Hoima Town Center', landmark: 'Main Street' }, { name: 'Hoima Market', landmark: 'Main Market' }],
        masaka: [{ name: 'Masaka Town Center', landmark: 'Main Street' }, { name: 'Masaka Market', landmark: 'Main Market' }],
        kabale: [{ name: 'Kabale Town Center', landmark: 'Main Street' }, { name: 'Lake Bunyonyi Area', landmark: 'Lake Bunyonyi' }],
        kasese: [{ name: 'Kasese Town Center', landmark: 'Main Street' }, { name: 'Rwenzori View Area', landmark: 'Mountain View' }]
    };

    const DISTRICT_SUGGESTIONS = [
        { name: 'Town Center', landmark: 'Administrative Center' },
        { name: 'Main Market Area', landmark: 'Main Market' },
        { name: 'Trading Center', landmark: 'Business Area' }
    ];

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

    function label(district) {
        return district.charAt(0).toUpperCase() + district.slice(1);
    }

    function suggestionsFor(district) {
        const isCity = CITIES.includes(district);
        const list = isCity ? (CITY_SUGGESTIONS[district] || CITY_SUGGESTIONS.kampala) : DISTRICT_SUGGESTIONS;
        const typeLabel = isCity ? 'City' : 'District';
        return list.map((s, i) => `
            <div class="location-item" data-suggestion-index="${i}">
                <div class="location-item-radio">
                    <input type="radio" name="mapPickerLocationSelect" id="mp_loc_${i}">
                    <label for="mp_loc_${i}"></label>
                </div>
                <div class="location-item-details">
                    <div class="location-item-name">${s.name}</div>
                    <div class="location-item-address">${label(district)} ${typeLabel}</div>
                    <div class="location-item-meta"><span class="location-item-landmark"><i class="fas fa-location-dot"></i> Close to: ${s.landmark}</span></div>
                </div>
            </div>
        `).join('');
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
    // to nudge a pin to a precise storefront location. Once dropped, the
    // marker switches to this small precision-crosshair style so the
    // seller can see and adjust exactly where it sits — and it's
    // draggable, so nudging doesn't require re-clicking the map.
    const precisionIcon = () => L.divIcon({
        className: 'custom-map-marker custom-map-marker--precision',
        html: '<div class="marker-crosshair"><span></span><span></span></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });

    let state = null; // { map, marker, district, onSave, onCancel, overlay }

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

    function placeMarker(latlng, district) {
        if (state.marker) state.map.removeLayer(state.marker);
        state.marker = L.marker(latlng, { icon: precisionIcon(), draggable: true }).addTo(state.map);
        const lat = (latlng.lat ?? latlng[0]).toFixed(6);
        const lng = (latlng.lng ?? latlng[1]).toFixed(6);
        document.getElementById('mpInfoDistrict').textContent = label(district);
        // Raw coordinates stay visible immediately as fine print; the
        // headline upgrades to a human-readable place name once the
        // reverse-geocode call resolves.
        document.getElementById('mpInfoCoords').textContent = `${lat}, ${lng}`;
        document.getElementById('mpInfoPlace').textContent = 'Looking up address\u2026';
        document.getElementById('mpSelectedLocationInfo').style.display = 'block';
        state.marker.bindPopup(popupHTML(district, lat, lng), { className: 'custom-map-popup', maxWidth: 280 });
        state.geocode = null;

        const runGeocode = (currentLat, currentLng) => {
            reverseGeocode(currentLat, currentLng).then(result => {
                if (!state || state.marker?.getLatLng()?.lat?.toFixed(6) !== currentLat) return;
                state.geocode = result;
                const placeEl = document.getElementById('mpInfoPlace');
                if (placeEl) placeEl.textContent = result?.placeName || 'Address unavailable — coordinates still saved';
                if (state.marker) state.marker.setPopupContent(popupHTML(district, currentLat, currentLng, result?.placeName));
            });
        };
        runGeocode(lat, lng);

        state.marker.on('dragend', () => {
            const p = state.marker.getLatLng();
            const nLat = p.lat.toFixed(6);
            const nLng = p.lng.toFixed(6);
            document.getElementById('mpInfoCoords').textContent = `${nLat}, ${nLng}`;
            document.getElementById('mpInfoPlace').textContent = 'Looking up address\u2026';
            runGeocode(nLat, nLng);
        });

        return { lat, lng };
    }

    function rebuildDistrictOptions(region, selected) {
        const select = document.getElementById('mpDistrictSelect');
        select.innerHTML = districtsInRegion(region).map(d => `
            <option value="${d}" ${d === selected ? 'selected' : ''}>${label(d)}${CITIES.includes(d) ? ' (City)' : ' (District)'}</option>
        `).join('');
    }

    function switchDistrict(district) {
        state.district = district;
        const center = districtCoordinates[district];
        if (!center) return;
        state.map.setView(center, 13);
        if (state.marker) { state.map.removeLayer(state.marker); state.marker = null; }
        document.getElementById('mpSelectedLocationInfo').style.display = 'none';
        document.getElementById('locationListMP').innerHTML = suggestionsFor(district);
        wireSuggestionClicks();
    }

    function wireSuggestionClicks() {
        document.querySelectorAll('#locationListMP [data-suggestion-index]').forEach(el => {
            el.addEventListener('click', () => {
                document.querySelectorAll('input[name="mapPickerLocationSelect"]').forEach((r, i) => {
                    r.checked = String(i) === el.dataset.suggestionIndex;
                });
                const center = districtCoordinates[state.district];
                if (center) placeMarker({ lat: center[0], lng: center[1] }, state.district);
            });
        });
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
                    <button type="button" class="map-modal-close" id="mpCloseBtn" aria-label="Close map picker"><i class="fas fa-times"></i></button>
                </div>
                <div class="map-modal-body">
                    <div class="map-modal-sidebar">
                        <div class="location-filters">
                            <div class="filter-group">
                                <label class="filter-label">Region</label>
                                <select class="filter-select" id="mpRegionSelect">
                                    <option value="central">Central Region</option>
                                    <option value="eastern">Eastern Region</option>
                                    <option value="northern">Northern Region</option>
                                    <option value="western">Western Region</option>
                                </select>
                            </div>
                            <div class="filter-group">
                                <label class="filter-label">District/City</label>
                                <select class="filter-select" id="mpDistrictSelect"></select>
                            </div>
                        </div>
                        <div class="location-suggestions">
                            <h4 class="suggestions-title">Suggested Locations</h4>
                            <div class="location-list" id="locationListMP"></div>
                        </div>
                        <div class="selected-location-info" id="mpSelectedLocationInfo" style="display:${hasExisting ? 'block' : 'none'}">
                            <div class="location-info-card">
                                <div class="location-info-header"><i class="fas fa-map-marker-alt"></i><h4>Selected Location</h4></div>
                                <div class="location-info-body">
                                    <div class="info-row info-row--place"><span class="info-value info-value--place" id="mpInfoPlace">${hasExisting ? 'Looking up address\u2026' : ''}</span></div>
                                    <div class="info-row"><span class="info-label">District:</span><span class="info-value" id="mpInfoDistrict">${label(district)}</span></div>
                                    <div class="info-row"><span class="info-label">Coordinates:</span><span class="info-value info-value--muted" id="mpInfoCoords" title="Exact coordinates">${hasExisting ? initialCoordinates : 'Not selected'}</span></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="map-modal-map-section">
                        <div id="mpMapContainer" class="custom-map-container"></div>
                        <div class="map-action-bar">
                            <button type="button" class="btn btn-secondary" id="mpCancelBtn"><i class="fas fa-times"></i> Cancel</button>
                            <button type="button" class="btn btn-primary" id="mpSaveBtn"><i class="fas fa-check"></i> Save Location</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        state = { map: null, marker: null, district, onSave, onCancel, overlay };
        document.body.classList.add('map-picker-open');

        document.getElementById('mpRegionSelect').value = region;
        rebuildDistrictOptions(region, district);
        document.getElementById('locationListMP').innerHTML = suggestionsFor(district);
        wireSuggestionClicks();

        document.getElementById('mpCloseBtn').addEventListener('click', () => close(true));
        document.getElementById('mpCancelBtn').addEventListener('click', () => close(true));
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
            if (!state.marker) {
                global.app?.showAlert('Please click on the map to select a location', 'error');
                return;
            }
            const latlng = state.marker.getLatLng();
            const result = {
                lat: latlng.lat.toFixed(6),
                lng: latlng.lng.toFixed(6),
                district: state.district,
                placeName: state.geocode?.placeName || null,
                suggestedAddress: state.geocode?.suggestedAddress || null,
                suggestedDirections: state.geocode?.suggestedDirections || null
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

            state.map.on('click', (e) => {
                document.querySelectorAll('input[name="mapPickerLocationSelect"]').forEach(r => { r.checked = false; });
                placeMarker(e.latlng, state.district);
            });

            requestAnimationFrame(() => state?.map?.invalidateSize());

            if (hasExisting) {
                const [lat, lng] = initialCoordinates.split(',').map(Number);
                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    placeMarker({ lat, lng }, district);
                }
            }
        }, 100);
    }

    global.NextaStoreMapPicker = { open, close: () => close(true), districtCoordinates };
})(window);
