/**
 * NextaStore Crew: the application page (crew-apply.html). It used to be a card inside the Crew page; it is its own page now.
 *
 * Flow:  Your details > ID front and back > Passport photo > Select working area > About you > Review.
 * Used for new applicants AND for Circle members asking to move up to Crew (same form, a different endpoint).
 *
 * Behaviour worth knowing:
 *  - Each step is a real history entry, so the phone's Back button goes to the previous step instead of leaving the page.
 *  - Typed answers are kept in sessionStorage while the person fills the form (photos cannot be kept, and are never stored).
 *  - Mistakes are shown next to the field and the first one is focused.
 *  - The map opens by itself when the person arrives at "Select working area".
 *  - The server decides everything again on submit (card photo required, ID photos, areas); this page is guidance, never the lock.
 * "crew" is the internal program key (API, database). People only ever see Crew.
 */
(function () {
    'use strict';
    const root = document.getElementById('caMain');
    const { esc, toast, confirm, busy, titleCase } = window.GrowthUI;
    let H = window.NextaHosts;
    const $ = (id) => document.getElementById(id);

    const DISTRICTS = { kampala: 'Kampala', wakiso: 'Wakiso', mukono: 'Mukono', jinja: 'Jinja', mbale: 'Mbale', gulu: 'Gulu', arua: 'Arua', mbarara: 'Mbarara', entebbe: 'Entebbe', kira: 'Kira' };
    const district = (k) => DISTRICTS[k] || titleCase(k);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
    const api = async (path, opts) => (await app.apiRequest(path, opts)).data;
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    const crewHome = () => (H && H.program ? H.program('crew') : '/crew');
    const DRAFT_KEY = 'nx_crew_apply_draft';
    const MAX_PHOTO = 6 * 1024 * 1024;

    let rules = null, upgrade = false, p = null;
    let steps = [], at = 0, sent = false;
    const areas = [];                 // { district, name, place, lat, lng }
    let cardPick = null;              // the passport-photo picker (js/crew-card-photo.js)
    const urls = {};                  // object URLs of the ID previews, so they can be released

    const bar = { el: $('caBar'), back: $('caBack'), next: $('caNext') };
    const ready = () => { try { window.NextaLoader && window.NextaLoader.ready && window.NextaLoader.ready('page'); } catch (e) { /* loader is optional */ } };

    // ------------------------------------------------------------------ small storage helpers (drafts)
    const draft = {
        read() { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch (e) { return {}; } },
        write(o) { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(o)); } catch (e) { /* private mode: the form still works */ } },
        clear() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing to clear */ } }
    };

    // ------------------------------------------------------------------ the map libraries load only on the working-area step
    const libs = {};
    const loadScript = (src) => libs[src] || (libs[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete libs[src]; rej(new Error('Could not load the map. Check your connection and try again.')); }; document.head.appendChild(s); }));
    const loadCss = (href) => { if (!document.querySelector(`link[href="${href}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); } };
    async function ensureMaps() {
        loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'); loadCss('/css/map-picker.css');
        if (!window.L) await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
        if (!window.NextaStoreMapPicker) await loadScript('/js/map-picker.js');
        if (!window.NextaStoreMapPreview) await loadScript('/js/map-preview.js');
    }

    /** The review team sees ONE private image: the front and the back of the ID, stacked and captioned (the server keeps one ID file per application). */
    async function idSheet(items) {
        const imgs = await Promise.all(items.map(([, f]) => new Promise((res, rej) => { const im = new Image(), u = URL.createObjectURL(f); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('One of the ID photos could not be read. Please choose it again.')); }; im.src = u; })));
        const W = 1000, Hh = 640, c = document.createElement('canvas'); c.width = W; c.height = Hh * imgs.length;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        imgs.forEach((im, k) => {
            const sc = Math.min(W / im.width, Hh / im.height), w = im.width * sc, h = im.height * sc;
            x.drawImage(im, (W - w) / 2, k * Hh + (Hh - h) / 2, w, h);
            x.fillStyle = 'rgba(11,59,43,.85)'; x.fillRect(0, k * Hh, 260, 34); x.fillStyle = '#fff'; x.font = '600 18px sans-serif'; x.fillText(items[k][0], 12, k * Hh + 23);
        });
        return c.toDataURL('image/jpeg', 0.82);
    }

    // ------------------------------------------------------------------ boot
    async function boot() {
        bar.el.hidden = true;
        root.innerHTML = '<div class="gp-skel"></div><div class="gp-skel"></div>';
        $('caStepLabel').textContent = 'Loading…';
        try {
            rules = await api('/growth/rules');
            if (rules.hosts && rules.hosts.mode === 'subdomain' && H.mode !== 'subdomain') H = H.create(rules.hosts, location);
            $('caClose').setAttribute('href', crewHome());
            let me = null;
            try { me = await api('/growth/me'); } catch (err) { if (err.status === 404 && err.code === 'NOT_A_PARTNER') me = null; else throw err; }
            // Already in Crew, applied, or a move-up request is waiting: the Crew page is the right place to be.
            if (me && (me.partner.program !== 'circle' || (me.upgrade && me.upgrade.state === 'pending'))) { location.replace(crewHome()); return; }
            upgrade = !!me && me.partner.program === 'circle';
            p = rules.programs.crew;
            let el = null;
            try { el = await api('/growth/eligibility?program=crew'); } catch (err) { el = null; }   // if this fails the form still shows; the server decides on submit
            if (!p.open || (el && el.blockers && el.blockers.includes('open'))) return renderMessage('Not open right now', `${esc(p.name)} is not taking applications at the moment.${upgrade ? ` ${esc(rules.programs.circle.name)} keeps working as normal.` : ''} Please check back soon.`);
            if (el && !el.canJoin && el.blockers && el.blockers.length) return renderBlocked(el);
            renderForm(el);
        } catch (err) {
            root.innerHTML = `<section class="gp-card ca-card"><h2>${err.isNetwork ? 'No connection' : 'Something went wrong'}</h2><p class="gp-muted">${err.isNetwork ? 'We could not reach NextaStore. Check your signal and try again.' : esc(err.message || 'Please try again in a moment.')}</p><div class="gp-row"><button class="gp-btn is-primary" id="caRetry">Try again</button><a class="gp-btn" href="${esc(crewHome())}" data-local>Back to Crew</a></div></section>`;
            $('caRetry').onclick = () => boot();
            $('caStepLabel').textContent = 'Not loaded';
        }
        ready();
    }

    function renderMessage(title, html) {
        $('caStepLabel').textContent = 'Not available';
        root.innerHTML = `<section class="gp-card ca-card"><h2>${title}</h2><p class="gp-muted">${html}</p><div class="gp-row"><a class="gp-btn is-primary" href="${esc(crewHome())}" data-local>${upgrade ? 'Back to my Circle dashboard' : 'Back to Crew'}</a></div></section>`;
    }

    function renderBlocked(el) {
        const list = `<ul class="gp-reqs" aria-label="What you need to join">${el.checks.map((c) => `<li class="${c.ok ? 'is-ok' : 'is-bad'}"><i class="fas ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i><span><b>${esc(c.label)}</b>${c.ok || !c.fix ? '' : `<small>${esc(c.fix)}</small>`}</span></li>`).join('')}</ul>`;
        $('caStepLabel').textContent = 'A few things first';
        root.innerHTML = `<section class="gp-card ca-card"><h2>${upgrade ? 'Ask to move up to the Crew' : 'Apply to join the Crew'}</h2><p class="gp-muted">A few things need to be in place first. This takes a minute.</p>${list}
            <div class="gp-row">${el.blockers.includes('email') ? '<button class="gp-btn is-primary" id="caVerify"><i class="fas fa-envelope" aria-hidden="true"></i> Send me a verification email</button>' : ''}<button class="gp-btn" id="caRecheck"><i class="fas fa-rotate" aria-hidden="true"></i> I have done this, check again</button></div><div class="ca-err-line" id="caBlockErr" role="alert"></div></section>`;
        const v = $('caVerify'); if (v) v.addEventListener('click', (e) => busy(e.currentTarget, async () => { await post('/auth/send-verification', {}); toast('Check your inbox for the verification link.'); }));
        $('caRecheck').addEventListener('click', (e) => busy(e.currentTarget, () => boot()));
    }

    // ------------------------------------------------------------------ the form
    const upTile = (id, label, hint, icon) => `<label class="ca-up" for="${id}" id="${id}Tile"><input class="gp-sr" id="${id}" type="file" accept="image/*" capture="environment" aria-describedby="caIdErr">
        <span class="ca-up-art"><i class="fas ${icon}" aria-hidden="true"></i></span><span class="ca-up-prev" hidden></span><b>${label}</b><small>${hint}</small><span class="ca-up-pill">Take or upload</span></label>`;
    const fieldErr = (id) => `<p class="ca-ferr" id="${id}Err" role="alert"></p>`;

    function renderForm(el) {
        const review = rules.applicationReviewWorkingDays ? `within ${plural(rules.applicationReviewWorkingDays, 'working day')}` : 'as soon as we can';
        steps = [
            ['about', 'Your details', upgrade ? 'Ask to join the Crew' : 'Your details', 'Use your name exactly as it appears on your ID.'],
            ['id', 'ID front and back', 'Your ID', 'We check it once to confirm who you are and to pay the right person.'],
            ['photo', 'Passport photo', 'Passport photo', 'This goes on your Crew ID card, which you show to shop owners. A clear, plain photo of your face works best.'],
            ['areas', 'Select working area', 'Select working area', `Search a town or tap the map. Add up to ${p.maxTerritories} places you will cover.`],
            ['note', 'About you', 'A little about you', 'Optional, but it helps our team get to know you.'],
            ['review', 'Review', 'Check and send', `Our team reviews every application ${review}. You will be told here and in your notifications.`]
        ];
        const head = (i) => `<div class="ca-lead"><h1 class="ca-title" id="caTitle-${steps[i][0]}" tabindex="-1">${esc(steps[i][2])}</h1><p class="ca-sub">${esc(steps[i][3])}</p></div>`;
        const d = draft.read();
        const idTypes = ['National ID', 'Passport', 'Driving permit'];
        const panel = (i, html) => `<section class="ca-step" data-step="${steps[i][0]}" aria-labelledby="caTitle-${steps[i][0]}" hidden>${head(i)}${html}</section>`;
        const checked = (t) => (d.idType || 'National ID') === t ? ' checked' : '';
        const avail = d.avail || ['Weekdays'];
        const availBox = (t) => `<label><input type="checkbox" value="${t}"${avail.includes(t) ? ' checked' : ''}><span>${t}</span></label>`;
        root.innerHTML = `<form class="ca-form" id="caForm" novalidate>
            ${panel(0, `<div class="gp-field"><label for="caName">Full name</label><input id="caName" type="text" autocomplete="name" placeholder="e.g. Nakato Grace" maxlength="60" value="${esc(d.name || '')}" required aria-describedby="caNameErr">${fieldErr('caName')}</div>
                <div class="gp-field"><label for="caPhone">Phone number</label><input id="caPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0772 123 456" value="${esc(d.phone || '')}" required aria-describedby="caPhoneHint caPhoneErr"><span class="gp-hint" id="caPhoneHint">We use it to reach you about your account and payouts.</span>${fieldErr('caPhone')}</div>`)}
            ${panel(1, `<div class="gp-field"><fieldset><legend>ID type</legend><div class="gp-checks" id="caIdType">${idTypes.map((t) => `<label><input type="radio" name="idType" value="${t}"${checked(t)}><span>${t}</span></label>`).join('')}</div></fieldset></div>
                <div class="gp-field"><label for="caIdNo">ID number</label><input id="caIdNo" type="text" placeholder="CM00000000000000" maxlength="20" autocomplete="off" autocapitalize="characters" value="${esc(d.idNo || '')}" required aria-describedby="caIdNoHint caIdNoErr"><span class="gp-hint" id="caIdNoHint">Exactly as printed on your card.</span>${fieldErr('caIdNo')}</div>
                <div class="ca-uploads">${upTile('caIdFront', 'ID front', 'Clear, no glare', 'fa-id-card')}${upTile('caIdBack', 'ID back', 'Clear, no glare', 'fa-barcode')}</div>${fieldErr('caId')}
                <p class="ca-note"><i class="fas fa-lock" aria-hidden="true"></i><span>Private. Only our review team can see your ID photos.</span></p>`)}
            ${panel(2, `<div class="ca-photo" id="caPhoto"></div>${fieldErr('caPhotoStep')}<p class="ca-note"><i class="fas fa-lock" aria-hidden="true"></i><span>Until your card is released, only you and our review team can see this photo.</span></p>`)}
            ${panel(3, `<div class="ca-map" id="caMap"></div>
                <div class="ca-areas-head"><b>Your areas</b><span class="ca-count" id="caCount">0 of ${p.maxTerritories}</span></div>
                <ul class="ca-arealist" id="caAreaList"></ul>${fieldErr('caAreas')}
                <button type="button" class="gp-btn ca-add" id="caAdd"><i class="fas fa-plus" aria-hidden="true"></i> Add an area on the map</button>`)}
            ${panel(4, `<div class="gp-field"><label for="caNote">Tell us a little about yourself <span class="gp-muted">(optional)</span></label><textarea id="caNote" maxlength="240" placeholder="Where you work, who you already know, why you want to join the Crew.">${esc(d.note || '')}</textarea></div>
                <div class="gp-field"><fieldset><legend>When can you work?</legend><div class="gp-checks" id="caAvail">${['Weekdays', 'Weekends', 'Market days'].map(availBox).join('')}</div></fieldset></div>`)}
            ${panel(5, `<dl class="ca-sum" id="caSum"></dl><label class="ca-terms" id="caTermsBox"><input type="checkbox" id="caTerms"><span>I have read and accept the <a href="${esc(H.main('/terms'))}" target="_blank" rel="noopener">${esc(p.name)} terms</a>, including that earnings are paid only after a store's payment is approved and that fake or self-referred sign-ups are not paid.</span></label>${fieldErr('caTerms')}`)}
            <p class="ca-err-line" id="caErr" role="alert"></p>
        </form>`;
        if (window.NextaCardPhoto) cardPick = window.NextaCardPhoto.mount($('caPhoto'), { onChange: () => { setErr('caPhotoStep', ''); } });
        else $('caPhoto').innerHTML = '<p class="gp-muted">The photo tool did not load. Please refresh the page.</p>';
        wire(); at = 0; history.replaceState({ ca: 0 }, '', location.pathname + location.search);
        show(false);
        ready();
    }

    // ---- errors, shown next to the thing that needs fixing
    const setErr = (id, msg) => { const e = $(id + 'Err'); if (e) e.textContent = msg || ''; };
    const markInvalid = (input, bad) => { if (input) { if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); } };
    function fail(id, msg, focusEl) { setErr(id, msg); const f = typeof focusEl === 'string' ? $(focusEl) : focusEl; if (f) { markInvalid(f, true); try { f.focus({ preventScroll: false }); } catch (e) { /* hidden or detached */ } } return false; }
    const clearErrors = () => { root.querySelectorAll('.ca-ferr').forEach((e) => { e.textContent = ''; }); root.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid')); root.querySelectorAll('.is-bad').forEach((e) => e.classList.remove('is-bad')); $('caErr').textContent = ''; };

    function valid(id) {
        clearErrors();
        if (id === 'about') {
            if ($('caName').value.trim().length < 3) return fail('caName', 'Enter your full name as it appears on your ID.', 'caName');
            if ($('caPhone').value.replace(/\D/g, '').length < 9) return fail('caPhone', 'Enter the phone number we can reach you on.', 'caPhone');
        }
        if (id === 'id') {
            if ($('caIdNo').value.trim().length < 6) return fail('caIdNo', 'Enter your ID number exactly as printed on the card.', 'caIdNo');
            for (const [k, label] of [['caIdFront', 'front'], ['caIdBack', 'back']]) {
                const f = $(k).files[0], tile = $(k + 'Tile');
                const bad = !f ? `Add a clear photo of the ${label} of your ID.` : !/^image\//.test(f.type) ? `The ${label} of your ID must be a photo.` : f.size > MAX_PHOTO ? `The ${label} photo is too large. Take it again at a lower quality.` : '';
                if (bad) { tile.classList.add('is-bad'); setErr('caId', bad); $(k).focus(); tile.scrollIntoView({ block: 'center', behavior: 'smooth' }); return false; }
            }
        }
        if (id === 'photo') {
            if (!window.NextaCardPhoto) return fail('caPhotoStep', 'The photo tool did not load. Please refresh the page.');
            const st = cardPick && cardPick.get();
            if (!st) return fail('caPhotoStep', 'Add a passport-style photo of your face for your ID card.');
            if (st.rating.blocked) return fail('caPhotoStep', 'This photo will not work on a card. Please take a new one using the tips shown.');
        }
        if (id === 'areas' && !areas.length) return fail('caAreas', 'Choose at least one working area on the map.');
        if (id === 'review' && !$('caTerms').checked) { $('caTermsBox').classList.add('is-bad'); return fail('caTerms', 'Please accept the terms to send your application.', 'caTerms'); }
        return true;
    }

    // ---- moving between steps (each one is a history entry, so the phone's Back button walks back through the form)
    function show(opts) {
        const first = opts === false, o = opts || {};
        const [id, label] = steps[at];
        root.querySelectorAll('.ca-step').forEach((x) => { x.hidden = x.dataset.step !== id; });
        $('caSegs').innerHTML = steps.map((_, i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}"></li>`).join('');
        $('caStepLabel').textContent = `Step ${at + 1} of ${steps.length} · ${label}`;
        bar.el.hidden = false; bar.back.hidden = at === 0;
        bar.next.textContent = at === steps.length - 1 ? (upgrade ? 'Send my upgrade request' : 'Send my application') : 'Continue';
        if (id === 'review') summary();
        clearErrors();
        if (!first) { window.scrollTo(0, 0); const h = $('caTitle-' + id); if (h) h.focus({ preventScroll: true }); }
        if (id === 'areas') renderAreas();
        if (id === 'areas' && o && o.forward && !areas.length) openPicker(false);   // arriving at the map: it opens on its own
    }
    function go(to, pushEntry) {
        at = Math.max(0, Math.min(steps.length - 1, to));
        if (pushEntry) history.pushState({ ca: at }, '', location.pathname + location.search);
        show({ forward: !!pushEntry });
    }
    function next() {
        if (sent) return;
        if (!valid(steps[at][0])) return;
        if (at === steps.length - 1) return submit();
        go(at + 1, true);
    }
    window.addEventListener('popstate', (e) => { if (!steps.length || sent) return; const to = e.state && Number.isInteger(e.state.ca) ? e.state.ca : 0; at = Math.max(0, Math.min(steps.length - 1, to)); show({ forward: false }); });

    // ---- remembering typed answers while the form is open
    const snapshot = () => ({
        name: $('caName') ? $('caName').value : '', phone: $('caPhone') ? $('caPhone').value : '', idNo: $('caIdNo') ? $('caIdNo').value : '',
        idType: (document.querySelector('input[name=idType]:checked') || {}).value || 'National ID', note: $('caNote') ? $('caNote').value : '',
        avail: [...document.querySelectorAll('#caAvail input:checked')].map((x) => x.value)
    });
    const isDirty = () => { const s = snapshot(); return !!(s.name || s.phone || s.idNo || s.note || areas.length || ($('caIdFront') && $('caIdFront').files[0]) || ($('caIdBack') && $('caIdBack').files[0]) || (cardPick && cardPick.get())); };

    // Typed answers are kept in the draft, so only what cannot be kept (photos, chosen areas) is worth a "leave this page?" warning.
    const hasUnsaved = () => !!(areas.length || ($('caIdFront') && $('caIdFront').files[0]) || ($('caIdBack') && $('caIdBack').files[0]) || (cardPick && cardPick.get()));

    function wire() {
        bar.next.onclick = next;
        bar.back.onclick = () => { if (at > 0) history.back(); };
        $('caForm').addEventListener('submit', (e) => { e.preventDefault(); next(); });
        $('caForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'file') { e.preventDefault(); next(); } });
        $('caForm').addEventListener('input', (e) => { draft.write(snapshot()); if (e.target.getAttribute && e.target.getAttribute('aria-invalid')) { markInvalid(e.target, false); setErr(e.target.id, ''); } });
        $('caForm').addEventListener('change', () => draft.write(snapshot()));
        $('caIdNo').addEventListener('input', () => { const v = $('caIdNo').value, u = v.toUpperCase(); if (v !== u) $('caIdNo').value = u; });
        // ID photo tiles: a thumbnail once a photo is chosen
        [['caIdFront', 'ID front'], ['caIdBack', 'ID back']].forEach(([k, label]) => $(k).addEventListener('change', () => {
            const f = $(k).files[0], tile = $(k + 'Tile'), prev = tile.querySelector('.ca-up-prev');
            if (urls[k]) { URL.revokeObjectURL(urls[k]); urls[k] = null; }
            tile.classList.remove('is-bad'); setErr('caId', '');
            if (f && /^image\//.test(f.type)) { urls[k] = URL.createObjectURL(f); prev.innerHTML = `<img alt="${label} preview" src="${urls[k]}">`; prev.hidden = false; tile.classList.add('is-set'); tile.querySelector('.ca-up-pill').textContent = 'Change photo'; }
            else { prev.hidden = true; prev.innerHTML = ''; tile.classList.remove('is-set'); tile.querySelector('.ca-up-pill').textContent = 'Take or upload'; }
        }));
        $('caAdd').addEventListener('click', () => openPicker(false));
        $('caClose').addEventListener('click', async (e) => {
            if (sent || !isDirty()) return;
            e.preventDefault();
            if (await confirm({ title: 'Leave the application?', body: 'What you typed is kept on this phone for a while. Photos are not, so you would add them again.', ok: 'Leave', cancel: 'Keep going' })) { sent = true; location.href = crewHome(); }
        });
        window.addEventListener('beforeunload', (e) => { if (!sent && hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
        // a phone keyboard must not hide the buttons: the bar steps out of the way while a field has focus
        root.addEventListener('focusin', (e) => { if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'radio' && e.target.type !== 'file') bar.el.classList.add('is-keyboard'); });
        root.addEventListener('focusout', () => bar.el.classList.remove('is-keyboard'));
    }

    // ---- review
    function summary() {
        const s = snapshot();
        const row = (k, v, goto) => `<div><dt>${k}</dt><dd>${esc(v)}</dd><button type="button" class="ca-edit" data-goto="${goto}" aria-label="Change ${esc(k.toLowerCase())}">Edit</button></div>`;
        const st = cardPick && cardPick.get();
        $('caSum').innerHTML = row('Name', s.name.trim(), 0) + row('Phone', s.phone.trim(), 0) + row('ID', `${s.idType} · ${s.idNo.trim()}`, 1) + row('ID photos', 'Front and back added', 1)
            + row('Passport photo', st ? `Added (${st.rating.score}/100)` : 'Not added', 2) + row('Working areas', areas.map((a) => a.place || a.name).join(', '), 3);
        $('caSum').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.goto), true)));
    }

    // ---- working area: the shared map picker (js/map-picker.js), plus a small preview map
    function renderAreas() {
        const mapEl = $('caMap'); if (!mapEl) return;
        const list = $('caAreaList'), last = areas[areas.length - 1];
        list.innerHTML = areas.map((a, i) => {
            const title = a.place || a.name;
            const sub = a.place && a.place !== a.name ? a.name : (a.place ? '' : (a.lat != null ? 'Pin placed' : 'District only'));
            return `<li><span class="ca-pin"><i class="fas fa-location-dot" aria-hidden="true"></i></span><span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><button type="button" class="ca-rm" data-rm="${i}" aria-label="Remove ${esc(title)}"><i class="fas fa-xmark" aria-hidden="true"></i></button></li>`;
        }).join('');
        list.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { areas.splice(Number(b.dataset.rm), 1); renderAreas(); }));
        $('caCount').textContent = `${areas.length} of ${p.maxTerritories}`;
        $('caAdd').disabled = areas.length >= p.maxTerritories;
        $('caAdd').innerHTML = areas.length ? '<i class="fas fa-plus" aria-hidden="true"></i> Add another area' : '<i class="fas fa-location-dot" aria-hidden="true"></i> Choose on the map';
        if (!last) {
            mapEl.innerHTML = '<button type="button" class="ca-map-empty" id="caPickEmpty"><i class="fas fa-location-dot" aria-hidden="true"></i><b>Choose your working area on the map</b><small>Search a town, tap the map or use your location</small></button>';
            $('caPickEmpty').addEventListener('click', () => openPicker(false));
            return;
        }
        const c = last.lat != null ? [last.lat, last.lng] : (window.NextaStoreMapPicker && window.NextaStoreMapPicker.districtCoordinates[last.district]) || null;
        mapEl.innerHTML = '';
        if (c && window.NextaStoreMapPreview) window.NextaStoreMapPreview.render(mapEl, { lat: c[0], lng: c[1], zoom: last.lat != null ? 15 : 12, height: 280, area: last.lat == null, areaLabel: last.lat == null ? last.name : '', onOpen: () => openPicker(true) });
    }
    function openPicker(replaceLast) {
        if (!replaceLast && areas.length >= p.maxTerritories) { toast(`Choose up to ${p.maxTerritories} areas.`); return; }
        ensureMaps().then(() => {
            const cur = replaceLast ? areas[areas.length - 1] : null;
            window.NextaStoreMapPicker.open({
                title: 'Select your working area', hint: 'Tap the map to mark where you will work. Drag the pin to adjust.', saveLabel: 'Save area',
                initialDistrict: (cur && cur.district) || 'kampala', initialCoordinates: cur && cur.lat != null ? `${cur.lat},${cur.lng}` : '',
                onSave: (r) => {
                    const d = String(r.district || '').toLowerCase(); if (!d) return;
                    const entry = { district: d, name: district(d), place: String(r.placeName || '').trim(), lat: r.lat != null ? Number(r.lat) : null, lng: r.lng != null ? Number(r.lng) : null };
                    if (replaceLast && areas.length) areas[areas.length - 1] = entry;
                    else if (!areas.some((a) => a.district === d)) areas.push(entry);
                    else areas[areas.findIndex((a) => a.district === d)] = entry;
                    setErr('caAreas', ''); renderAreas();
                }
            });
        }).catch((ex) => { setErr('caAreas', ex.message); });
    }

    // ---- send
    function submit() {
        busy(bar.next, async () => {
            const s = snapshot();
            const avail = s.avail.join(', ') || 'not said';
            const headLines = [`Name on ID: ${s.name.trim()}`, `${s.idType}: ${s.idNo.trim()}`,
                `Work areas: ${areas.map((a) => (a.place || a.name) + (a.place && a.place !== a.name ? ` (${a.name})` : '') + (a.lat != null ? ` [${a.lat.toFixed(4)},${a.lng.toFixed(4)}]` : '')).join('; ')}`, `Available: ${avail}`].join('\n');
            const extra = (s.note || '').trim();
            const body = {
                phone: s.phone, agreedTerms: $('caTerms').checked, territories: areas.map((a) => a.district),
                note: (headLines + (extra ? '\n\n' + extra : '')).slice(0, 600)
            };
            const st = cardPick && cardPick.get();
            if (st) body.cardPhoto = await window.NextaCardPhoto.prepare(st.file, st.stats);
            body.kycImage = await idSheet([['ID front', $('caIdFront').files[0]], ['ID back', $('caIdBack').files[0]]]);
            await post(upgrade ? '/growth/crew/upgrade' : '/growth/crew/apply', body);   // an upgrade never touches Circle until it is approved
            sent = true; draft.clear(); done();
        }, (ex) => { $('caErr').textContent = submitMessage(ex); });
    }
    /** The server hides the detail of its own failures ("Something went wrong."); say what we know, and that the answers are safe. */
    function submitMessage(ex) {
        const byCode = { UPLOAD_UNAVAILABLE: 'Photo uploads are not switched on for this program yet, so the application cannot be saved. Please tell the NextaStore team.', CARD_PHOTO_REQUIRED: 'Add a clear passport photo of your face, then send again.', KYC_REQUIRED: 'Add the front and back of your ID, then send again.', EMAIL_UNVERIFIED: 'Verify your email first, then send again.' };
        if (ex && byCode[ex.code]) return byCode[ex.code];
        if (ex && ex.isNetwork) return ex.message;
        if (ex && ex.status >= 500) return 'We could not save your application because of a problem on our side. Your answers are kept on this page. Please try again in a minute, and tell the NextaStore team if it keeps happening.';
        return (ex && ex.message) || 'Something went wrong. Please try again.';
    }
    function done() {
        bar.el.hidden = true;
        $('caSegs').innerHTML = steps.map(() => '<li class="is-done"></li>').join('');
        $('caStepLabel').textContent = 'Application sent';
        const review = rules.applicationReviewWorkingDays ? `within ${plural(rules.applicationReviewWorkingDays, 'working day')}` : 'as soon as we can';
        root.innerHTML = `<section class="ca-done" aria-live="polite"><span class="ca-tick"><i class="fas fa-check" aria-hidden="true"></i></span><h1 class="ca-title" tabindex="-1" id="caDoneTitle">${upgrade ? 'Request sent' : 'Application sent'}</h1><p class="ca-sub">Our team checks every one by hand and aims to finish ${review}. We will tell you on your Crew page and in your notifications.${upgrade ? ' Circle keeps working as normal until then.' : ''}</p><a class="gp-btn is-primary is-big" href="${esc(crewHome())}" data-local id="caHome">Go to my Crew page</a></section>`;
        window.scrollTo(0, 0); const t = $('caDoneTitle'); if (t) t.focus({ preventScroll: true });
    }

    boot();
})();
