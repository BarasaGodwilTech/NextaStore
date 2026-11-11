/**
 * NextaStore Circle + NextaStore Crew dashboards. One script, two pages:
 *   <body data-program="circle">  (circle.html)      <body data-program="crew"> (crew.html)
 * ("crew" is the internal program key: the API, the database and permissions still use it. People only ever see Crew.)
 * Talks to /api/growth/* through the site's own app.apiRequest. Every number shown comes from the server
 * (GET /growth/rules and /growth/me); nothing is hard-coded here. Everything that came from the server
 * is escaped before it touches innerHTML. Needs growth-hosts.js and growth-ui.js (load order in circle.html).
 */
(function () {
    'use strict';
    const PROGRAM = document.body.dataset.program === 'crew' ? 'crew' : 'circle';
    const root = document.getElementById('gpRoot');
    const { esc, ugx, day, when, titleCase, toast, dialog, confirm, busy, keepScroll } = window.GrowthUI;
    let H = window.NextaHosts;
    const Shell = window.GrowthShell;
    let activeTab = Shell.tabFromHash(PROGRAM, location.hash);   // the section showing (#home, #earn ...); only a signed-in member has sections
    let menuKey = null;                                          // who the header menu was last drawn for
    const DISTRICTS = { kampala: 'Kampala', wakiso: 'Wakiso', mukono: 'Mukono', jinja: 'Jinja', mbale: 'Mbale', gulu: 'Gulu', arua: 'Arua', mbarara: 'Mbarara', entebbe: 'Entebbe', kira: 'Kira' };
    const district = (k) => DISTRICTS[k] || titleCase(k);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
    const absolute = (u) => (u.startsWith('/') ? location.origin + u : u);

    const api = async (path, opts) => (await app.apiRequest(path, opts)).data;
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) });
    const readImage = (file) => new Promise((res, rej) => { if (!file) return res(null); if (file.size > 6 * 1024 * 1024) return rej(new Error('That photo is too big. Use one under 6 MB.')); const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read that photo.')); r.readAsDataURL(file); });

    let rules = null, me = null, trail = null, campaigns = [];
    const reviewText = () => (rules && Number.isFinite(rules.applicationReviewWorkingDays) ? `within ${plural(rules.applicationReviewWorkingDays, 'working day')}` : 'as soon as we can');
    const QUEUE_KEY = 'nx_lead_queue', LAST_KEY = 'nx_last_partner';
    const mark = PROGRAM === 'crew' ? 'mark-crew' : 'mark-circle';

    // ---------------------------------------------------------------- boot
    async function boot({ soft = false } = {}) {
        if (window.__nxAbout) return;   // heading to the about page, nothing to load
        if (!soft) root.innerHTML = '<div class="gp-skel"></div><div class="gp-skel"></div>';
        const y = window.scrollY;
        try {
            rules = await api('/growth/rules');
            if (rules.hosts && rules.hosts.mode === 'subdomain' && H.mode !== 'subdomain') H = H.create(rules.hosts, location);   // server settings win when the page was served as a plain file
            try { me = await api('/growth/me'); } catch (err) { if (err.status === 404 && err.code === 'NOT_A_PARTNER') me = null; else throw err; }
            // One account is in one program. Someone who followed a Crew link while in Circle (or the other way round) is taken to THEIR dashboard, and told why.
            // The one exception: a Circle member on the Crew page is here to move up (see renderUpgrade), so they stay.
            // Someone who has MOVED UP from this program was simply using their old bookmark or link: they are taken on to Crew
            // quietly, with no "wrong program" message, so nothing they saved ever looks broken.
            if (me && me.partner.program !== PROGRAM && !isUpgrading()) {
                const there = me.partner.program === 'crew' ? 'crew' : 'circle';
                location.replace(H.program(there) + (me.partner.upgradedFrom === PROGRAM ? '' : '?wrong=1'));
                return;
            }
            if (me) { try { localStorage.setItem(LAST_KEY, JSON.stringify({ code: me.partner.code, name: me.partner.displayName, program: me.partner.program, status: me.partner.status, territories: me.partner.territories, lead: rules.lead })); } catch (e) { /* storage unavailable */ } }
            trail = null; campaigns = [];
            const inThis = !!me && me.partner.program === PROGRAM;   // a Circle member looking at the Crew page has no Crew tools yet
            if (inThis && PROGRAM === 'crew' && me.partner.status === 'active') trail = await api('/growth/trail-map').catch(() => null);
            if (inThis && ['active', 'frozen'].includes(me.partner.status)) campaigns = await api('/growth/campaigns').catch(() => []);
            if (inThis && PROGRAM === 'crew') await flushQueue();
            render();
        } catch (err) {
            if (soft && me && err.isNetwork) { toast('Could not refresh. Check your connection.'); return; }   // a flaky moment must not replace a working dashboard
            if (err.isNetwork && renderOffline()) { window.NextaLoader?.ready?.('page'); return; }
            root.innerHTML = `<section class="gp-card"><h2>We could not load this page</h2><p class="gp-muted">${esc(err.message || 'Please check your connection.')}</p><button class="gp-btn is-primary" id="gpRetry">Try again</button></section>`;
            document.getElementById('gpRetry').onclick = () => boot();
        }
        if (soft) window.scrollTo(0, y);
        window.NextaLoader?.ready?.('page');
    }
    const refresh = () => boot({ soft: true });
    /** A Circle member on the Crew page: here to ask to move up. */
    function isUpgrading() { return !!me && PROGRAM === 'crew' && me.partner.program === 'circle'; }

    function syncMenu() {
        // The header menu is drawn by main.js; redraw it only when WHO it is for changes (not on every refresh), so an open bell is never reset.
        const k = me ? `${me.partner.program}:${me.partner.status}:${me.partner.code}` : 'none';
        Shell.setPartner(me ? me.partner : null, PROGRAM);
        if (k !== menuKey) { menuKey = k; try { if (typeof app !== 'undefined') app.renderAccountNavs(); } catch (e) { /* the menu keeps its last drawing */ } }
    }
    function noteWrongProgram() {
        if (!/[?&]wrong=1/.test(location.search)) return;
        history.replaceState(null, '', location.pathname + location.hash);
        if (me && rules) toast(`You are in ${rules.programs[PROGRAM].name}, so this is your dashboard. An account is in one program at a time.`, 7000);
    }
    function render() {
        syncMenu(); noteWrongProgram();
        if (!me) return renderJoin();
        if (isUpgrading()) return renderUpgrade();
        if (me.partner.status === 'applied') return renderPending();
        if (me.partner.status === 'rejected' || me.partner.status === 'retired') return renderClosed();
        return renderDashboard();
    }

    // ---------------------------------------------------------------- shared bits
    const heroKicker = (icon, text) => `<span class="gp-kicker"><i class="fas ${icon}" aria-hidden="true"></i> ${text}</span>`;
    const heroMark = () => `<img class="gp-hero-mark" src="/assets/growth-brand/svg/${mark}.svg" alt="" width="84" height="84">`;
    const programIcon = PROGRAM === 'crew' ? 'fa-compass' : 'fa-circle-nodes';

    // ---------------------------------------------------------------- not a partner yet
    function estimator(p) {
        const first = PROGRAM === 'circle' ? p.firstMonth : p.ranks[0].firstMonth;
        const kicker = p.commitmentKicker, stay = p.stayBonus + (PROGRAM === 'crew' ? p.stockedBonus : 0);
        return { html: `<section class="gp-card"><h2>What could you earn?</h2>
            <div class="gp-calc"><label for="gpN"><b id="gpNLabel">3 stores</b> in a month</label><input id="gpN" type="range" min="1" max="15" value="3" aria-label="Number of stores you bring in a month">
            <div class="gp-calc-out" id="gpCalcOut" aria-live="polite"></div>
            <p class="gp-muted">${PROGRAM === 'crew' ? 'Shown at the Trailhead rank. Your percentage rises as you bring more paid stores.' : 'Shown for stores that pay for one month.'} You are paid only when a store's payment is approved. These are examples, not promises.</p></div></section>`,
        wire() {
            const slider = document.getElementById('gpN'); if (!slider) return;
            const draw = () => {
                const n = Number(slider.value);
                document.getElementById('gpNLabel').textContent = plural(n, 'store');
                document.getElementById('gpCalcOut').innerHTML = [
                    ['If they pay one month', n * first], ['If they also renew', n * (first + stay)], [`If they all pay ${rules.kickerMinMonths} months up front`, n * (first + kicker)]
                ].map(([label, amount]) => `<div><small>${esc(label)}</small><strong>${ugx(amount)}</strong></div>`).join('');
            };
            slider.addEventListener('input', draw); draw();
        } };
    }

    function pitch(est) {
        const p = rules.programs[PROGRAM];
        const fee = (rules.payouts.feeOnUs ? ' NextaStore covers the mobile money fee, so you receive the full amount.' : '')
            + ` Your first withdrawal opens ${plural(rules.payouts.firstWithdrawalAfterDays, 'day')} after you join${rules.payouts.firstWithdrawalNeedsStore ? ', once your first store has paid and cleared' : ''}.`;
        if (PROGRAM === 'circle') {
            return `<section class="gp-hero">${heroMark()}${heroKicker('fa-circle-nodes', `${esc(p.name)} · ${esc(p.descriptor)}`)}
                <h1>${esc(p.tagline)}</h1>
                <p>Know a shop owner who should be on NextaStore? Share your code. When their store pays for the Seller Pass and we approve it, you earn <b>${p.commissionPercent}%</b> of their first month (${ugx(p.firstMonth)}), plus ${ugx(p.commitmentKicker)} more if they pay ${rules.kickerMinMonths} months or more up front, and ${ugx(p.stayBonus)} when they renew.</p>
                ${p.open ? '<div class="gp-code"><a class="gp-btn is-primary is-big" href="#gpJoinCard" id="gpJump">Join and get my code</a></div>' : ''}</section>
                ${est.html}
                <section class="gp-card"><h2>How it works</h2><ol class="gp-steps">
                    <li>Join below and get your personal code, link and a ready-made invite picture.</li>
                    <li>A store owner opens your link, signs up and launches their store.</li>
                    <li>They pay for their Seller Pass and we approve it. You see every step, so you can help them along.</li>
                    <li>Your earning clears after ${rules.payouts.clearanceDays} days. Withdraw ${ugx(rules.payouts.minWithdrawal)} or more to MTN or Airtel, paid within ${rules.payouts.payWithinWorkingDays} working days.${fee}</li></ol></section>`;
        }
        return `<section class="gp-hero">${heroMark()}${heroKicker('fa-compass', `${esc(p.name)} · ${esc(p.descriptor)}`)}
            <h1>${esc(p.tagline)}</h1>
            <p>The Crew walks the markets, meets the owners and helps them set up shop. You earn <b>${p.ranks[0].ratePercent}% to ${p.ranks[p.ranks.length - 1].ratePercent}%</b> of every store's first month depending on your rank, plus bonuses when a store pays ${rules.kickerMinMonths} months up front, renews, and keeps its shelf stocked. You are paid only when their payment is approved.</p>
            ${p.open ? '<div class="gp-code"><a class="gp-btn is-primary is-big" href="#gpJoinCard" id="gpJump">Apply to join the Crew</a></div>' : ''}</section>
            ${est.html}
            <section class="gp-card"><h2>Your trail</h2><div class="gp-row">${p.ranks.map((r) => `<span class="gp-chip">${esc(r.label)} · ${r.ratePercent}% · ${r.minCleared90d}+ paid stores / 90 days</span>`).join('')}</div>
            <ol class="gp-steps" style="margin-top:14px"><li>Verify your email, then apply with your ID. We review ${reviewText()}.</li><li>Log each business you visit. It becomes your lead for ${rules.lead.lockDays} days, so nobody else can claim it. No signal? It is saved on your phone and sent later.</li><li>Help them sign up with your code or QR and add their first products.</li><li>When their payment is approved, you earn. Withdraw after it clears.${fee}</li></ol></section>`;
    }

    // ---------------------------------------------------------------- joining: requirements first, then a few short steps
    // The checklist comes from the server (GET /growth/eligibility) so the person sees what stands in the way BEFORE typing anything.
    // The server enforces the very same rules again on submit, so this screen is guidance, never the lock.
    // Crew applications live on their own page (crew-apply.html, js/crew-apply.js). Circle's two-step join stays here.
    const JOIN_STEPS = {
        circle: [['phone', 'Your number'], ['agree', 'Agree and join']]
    };
    const checklistHtml = (el) => `<ul class="gp-reqs" aria-label="What you need to join">${el.checks.map((c) => `<li class="${c.ok ? 'is-ok' : 'is-bad'}"><i class="fas ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i><span><b>${esc(c.label)}</b>${c.ok || !c.fix ? '' : `<small>${esc(c.fix)}</small>`}</span></li>`).join('')}</ul>`;
    const stepperHtml = (steps, at) => `<ol class="gp-stepper" aria-label="Steps">${steps.map(([k, label], i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}"${i === at ? ' aria-current="step"' : ''}><span>${i < at ? '<i class="fas fa-check" aria-hidden="true"></i>' : i + 1}</span><em>${esc(label)}</em></li>`).join('')}</ol>`;

    /** What an upgrade changes and what it does not, in plain words. Money is involved, so nothing here is left to guesswork. */
    function upgradeExplainer() {
        const c = rules.programs.circle, k = rules.programs.crew, lo = k.ranks[0].ratePercent, hi = k.ranks[k.ranks.length - 1].ratePercent;
        const li = (icon, t) => `<li><i class="fas ${icon}" aria-hidden="true"></i><span>${t}</span></li>`;
        return `<section class="gp-card gp-upgrade-explain"><h2>What changes, and what does not</h2>
            <h3 class="gp-sub">Stays exactly as it is</h3>
            <ul class="gp-ticks">${li('fa-check', 'Your balance, payout number and history carry over. It is the same account.')}${li('fa-check', `Your Circle code <code>${esc(me.partner.code)}</code> and link keep working. Anything you already shared still works, and nobody has to be told.`)}${li('fa-check', `Stores that already signed up through your Circle link stay on Circle terms (${c.commissionPercent}% of the first month, plus the Circle bonuses), even if they pay later.`)}${li('fa-check', `${esc(c.name)} keeps working as normal while we review. If we decline, nothing changes.`)}</ul>
            <h3 class="gp-sub">Changes once we approve you</h3>
            <ul class="gp-ticks">${li('fa-arrow-up', `You get a new Crew code. Sign-ups from that day on, through either code, count as Crew: <b>${lo}% to ${hi}%</b> of the first month depending on rank.`)}${li('fa-arrow-up', 'The field tools open: leads that are yours for a while, offline logging, the Trail Map and Market Days.')}${li('fa-arrow-up', 'Your Crew rank starts at the first step. Only stores paid under Crew terms count toward it.')}</ul></section>`;
    }

    async function renderJoin() {
        Shell.renderLinks({ program: PROGRAM });
        const p = rules.programs[PROGRAM];
        const upgrade = isUpgrading();
        const est = estimator(p);
        const upgradeHero = () => `<section class="gp-hero">${heroMark()}${heroKicker('fa-circle-arrow-up', 'Move up · Circle to Crew')}
            <h1>Ready to do more?</h1>
            <p>You are in ${esc(rules.programs.circle.name)}. The Crew walks the markets and meets the owners. You earn <b>${p.ranks[0].ratePercent}% to ${p.ranks[p.ranks.length - 1].ratePercent}%</b> of every store's first month, plus bonuses. Ask to move up: Circle keeps working exactly as it does today until we approve you.</p>
            ${p.open ? '<div class="gp-code"><a class="gp-btn is-primary is-big" href="#gpJoinCard" id="gpJump">Ask to join the Crew</a></div>' : ''}</section>${upgradeExplainer()}${est.html}`;
        root.innerHTML = (upgrade ? upgradeHero() : pitch(est)) + `<section class="gp-card" id="gpJoinCard" aria-busy="true"><div class="gp-skel"></div></section>`;
        est.wire();
        document.getElementById('gpJump')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('gpJoinCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        let el = null;
        try { el = await api(`/growth/eligibility?program=${PROGRAM}`); } catch (err) { el = null; }   // if this fails the form still shows; the server decides on submit
        const card = document.getElementById('gpJoinCard'); if (!card) return;
        card.removeAttribute('aria-busy');
        const title = PROGRAM === 'circle' ? `Join ${esc(p.name)}` : (upgrade ? 'Ask to move up to the Crew' : 'Apply to join the Crew');
        if (!p.open || (el && el.blockers.includes('open'))) { card.innerHTML = `<h2>Not open right now</h2><p class="gp-muted">${esc(p.name)} is not taking ${PROGRAM === 'crew' ? 'applications' : 'new members'} at the moment. ${upgrade ? `${esc(rules.programs.circle.name)} keeps working as normal. ` : ''}Please check back soon.</p>${upgrade ? `<div class="gp-row"><a class="gp-btn is-primary" href="${esc(H.program('circle'))}">Open my Circle dashboard</a></div>` : ''}`; return; }
        if (el && !el.canJoin && el.blockers.length) {
            const other = !upgrade && el.existing && !el.existing.sameProgram ? (el.existing.program === 'crew' ? 'crew' : 'circle') : null;
            card.innerHTML = `<h2>${title}</h2><p class="gp-muted">A few things need to be in place first. This takes a minute.</p>${checklistHtml(el)}
                <div class="gp-row">${el.blockers.includes('email') ? '<button class="gp-btn is-primary" id="gpSendVerify"><i class="fas fa-envelope" aria-hidden="true"></i> Send me a verification email</button>' : ''}
                ${other ? `<a class="gp-btn is-primary" href="${esc(H.program(other))}">Open my ${esc(rules.programs[other].short)} dashboard</a>` : ''}${upgrade ? `<a class="gp-btn is-primary" href="${esc(H.program('circle'))}">Back to my Circle dashboard</a>` : ''}<button class="gp-btn" id="gpRecheck"><i class="fas fa-rotate" aria-hidden="true"></i> I have done this, check again</button></div><div class="gp-error" id="gpErr" role="alert"></div>`;
            document.getElementById('gpSendVerify')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await post('/auth/send-verification', {}); toast('Check your inbox for the verification link.'); }));
            document.getElementById('gpRecheck').addEventListener('click', (e) => busy(e.currentTarget, () => boot()));
            return;
        }
        if (PROGRAM === 'crew') {
            // The application itself is its own page: a short summary here, then one clear button.
            card.innerHTML = `<h2>${title}</h2>${el ? checklistHtml(el) : ''}
                <ol class="gp-steps"><li>Your details and ID, front and back.</li><li>A passport-style photo for your Crew ID card.</li><li>Select the areas where you will work, on the map.</li><li>We review it ${reviewText()} and tell you here.</li></ol>
                <div class="gp-row"><a class="gp-btn is-primary is-big" id="gpApply" href="${esc(H.apply())}" data-local>${upgrade ? 'Continue to my request' : 'Start my application'}</a></div>`;
            return;
        }
        const steps = JOIN_STEPS.circle; let at = 0;
        const panel = (id, html) => `<div class="gp-step" data-step="${id}" hidden>${html}</div>`;
        const phone = '<div class="gp-field"><label for="gpPhone">Your phone number</label><input id="gpPhone" type="tel" inputmode="tel" placeholder="0772 123 456" autocomplete="tel" required><span class="gp-hint">We use it to reach you about your account and payouts.</span></div>';
        const terms = `<label class="gp-check"><input type="checkbox" id="gpTerms"> <span>I have read and accept the <a href="${esc(H.main('/terms'))}" target="_blank" rel="noopener">${esc(p.name)} terms</a>, including that earnings are paid only after a store's payment is approved and that fake or self-referred sign-ups are not paid.</span></label>`;
        const panels = panel('phone', `${phone}<p class="gp-muted">You will get a personal code and link straight away. You earn when a store you invited pays.</p>`) + panel('agree', `<div class="gp-sum" id="gpSum"></div>${terms}`);
        card.innerHTML = `<h2>${title}</h2>${el ? checklistHtml(el) : ''}<form class="gp-form" id="gpJoin" novalidate><div id="gpStepper"></div>${panels}
            <div class="gp-error" id="gpErr" role="alert"></div><div class="gp-row gp-row-end"><button type="button" class="gp-btn" id="gpBack" hidden>Back</button><button type="button" class="gp-btn is-primary is-big" id="gpNext">Next</button><button type="submit" class="gp-btn is-primary is-big" id="gpGo" hidden>Join and get my code</button></div></form>`;
        const err = document.getElementById('gpErr'), $ = (id) => document.getElementById(id);
        const valid = (id) => {
            if (id === 'phone') { if (($('gpPhone').value.replace(/\D/g, '')).length < 9) return 'Enter the phone number we can reach you on.'; }
            if (id === 'agree' && !$('gpTerms').checked) return 'Please accept the terms to continue.';
            return '';
        };
        const summary = () => {
            const row = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
            $('gpSum').innerHTML = `<dl class="gp-dl">${row('Phone', $('gpPhone').value) + row('Program', p.name)}</dl>`;
        };
        const show = () => {
            const [id] = steps[at];
            document.querySelectorAll('.gp-step').forEach((x) => { x.hidden = x.dataset.step !== id; });
            $('gpStepper').innerHTML = stepperHtml(steps, at);
            $('gpBack').hidden = at === 0; $('gpNext').hidden = at === steps.length - 1; $('gpGo').hidden = at !== steps.length - 1;
            if (id === 'agree') summary();
            err.textContent = '';
            const first = document.querySelector(`.gp-step[data-step="${id}"] input:not([type=checkbox]), .gp-step[data-step="${id}"] textarea`); if (first && at) first.focus({ preventScroll: true });
        };
        $('gpNext').onclick = () => { const m = valid(steps[at][0]); if (m) { err.textContent = m; return; } at += 1; show(); };
        $('gpBack').onclick = () => { at -= 1; show(); };
        $('gpJoin').addEventListener('submit', (e) => {
            e.preventDefault();
            const m = valid(steps[at][0]); if (m) { err.textContent = m; return; }
            busy($('gpGo'), async () => {
                await post('/growth/circle/join', { phone: $('gpPhone').value, agreedTerms: $('gpTerms').checked });
                await boot();
                window.scrollTo(0, 0);
            }, (ex) => { err.textContent = ex.message || 'Something went wrong. Please try again.'; });
        });
        show();
    }

    function renderUpgrade() { return me.upgrade && me.upgrade.state === 'pending' ? renderUpgradePending() : renderJoin(); }
    function renderUpgradePending() {
        Shell.renderLinks({ program: PROGRAM });
        root.innerHTML = `<section class="gp-hero">${heroMark()}${heroKicker('fa-hourglass-half', 'Request received')}<h1>We are reviewing your Crew request</h1><p>Our team checks every one by hand. We aim to finish ${reviewText()}. We will tell you here and in your notifications as soon as it is done.</p></section>
            <section class="gp-card"><h2>Meanwhile, nothing stops</h2><ul class="gp-ticks"><li><i class="fas fa-check" aria-hidden="true"></i><span>${esc(rules.programs.circle.name)} keeps working as normal. Your code <code>${esc(me.partner.code)}</code>, your link and your earnings are untouched.</span></li><li><i class="fas fa-check" aria-hidden="true"></i><span>People who sign up through your link are still counted, and still paid, under Circle.</span></li><li><i class="fas fa-check" aria-hidden="true"></i><span>If we say no, nothing changes for you.</span></li></ul>
            <div class="gp-row" style="margin-top:14px"><a class="gp-btn is-primary" href="${esc(H.program('circle'))}">Open my Circle dashboard</a><button class="gp-btn" id="gpWithdrawUp">Withdraw my request</button></div><div class="gp-error" id="gpErr" role="alert"></div></section>`;
        document.getElementById('gpWithdrawUp').onclick = async (e) => { const b = e.currentTarget; if (await confirm({ title: 'Withdraw your request?', body: 'Circle carries on exactly as before. You can ask again later.', ok: 'Withdraw it' })) busy(b, async () => { await post('/growth/crew/upgrade/withdraw'); toast('Request withdrawn.'); await refresh(); }, (ex) => { document.getElementById('gpErr').textContent = ex.message; }); };
    }

    function renderPending() {
        Shell.renderLinks({ program: PROGRAM });
        root.innerHTML = `<section class="gp-hero">${heroMark()}${heroKicker('fa-hourglass-half', 'Application received')}<h1>We are reviewing your application</h1><p>Our team checks every Crew application by hand. We aim to finish ${reviewText()}. We will tell you here and in your notifications as soon as it is done.</p></section>
            <section class="gp-card"><h2>While you wait</h2><ol class="gp-steps"><li>Make sure your phone number and area are right. If anything needs fixing, contact NextaStore support.</li><li>Think of three shops you already know that are not on NextaStore. Once you are approved you can log them as your first leads.</li></ol></section>`;
    }
    function renderClosed() { Shell.renderLinks({ program: PROGRAM }); root.innerHTML = `<section class="gp-card"><h2>This account is not active</h2><p class="gp-muted">If you think this is a mistake, please contact NextaStore support.</p></section>`; }

    // ---------------------------------------------------------------- offline (the Crew opens the installed app with no signal)
    function lastPartner() {
        try { return JSON.parse(localStorage.getItem(LAST_KEY)); } catch (e) { return null; }
    }
    function renderOffline() {
        const last = lastPartner();
        if (PROGRAM !== 'crew' || !last || last.program !== 'crew' || last.status !== 'active') return false;
        me = null; // not a live dashboard: no money, no recruits
        Shell.renderLinks({ program: PROGRAM });
        root.innerHTML = `<section class="gp-hero">${heroMark()}${heroKicker('fa-wifi', 'Offline')}<h1>No signal, no problem</h1><p>You can still show your QR code and log the businesses you visit. They are saved on your phone and sent when the signal is back.</p>
            <div class="gp-code"><span class="gp-code-chip" id="gpCode">${esc(last.code)}</span><button class="gp-btn is-light" id="gpQr"><i class="fas fa-qrcode" aria-hidden="true"></i> QR for my phone</button></div></section>
            ${queueCard()}${leadsCard(last.territories || [])}
            <section class="gp-card"><button class="gp-btn" id="gpRetry"><i class="fas fa-rotate" aria-hidden="true"></i> Try to reconnect</button></section>`;
        document.getElementById('gpQr').onclick = () => openQr(last.code);
        document.getElementById('gpRetry').onclick = () => boot();
        wireLeadForm();
        return true;
    }

    // ---------------------------------------------------------------- dashboard
    function inviteLink(code) { return H.invite(code || me.partner.code); }
    function shareText() { const link = inviteLink(); return PROGRAM === 'circle'
        ? `I use NextaStore to sell online in Uganda. Open your free store here and get started: ${link}`
        : `I help shops in Uganda sell online with NextaStore. Open your store free for ${rules.trialDays} days with my code ${me.partner.code}: ${link}`; }

    function withdrawBlockReason() {
        const b = me.balances, w = me.withdrawal, p = me.partner;
        if (p.frozen) return 'Withdrawals are paused while we review your account.';
        if (!p.payout) return 'Add the mobile money number you want to be paid on, then you can withdraw.';
        if (p.payout.lockedUntil) return `Withdrawals reopen ${when(p.payout.lockedUntil)}. This is a safety pause after a payout number is added or changed.`;
        if (w.open) return 'You have a withdrawal in progress. It must be paid before you request another.';
        if (b.available < 0) return 'A reversed payment is being taken off your balance, so withdrawals are closed until new earnings cover it.';
        if (b.available < w.min) return `The smallest withdrawal is ${ugx(w.min)}. You have ${ugx(Math.max(0, b.available))} ready${b.pending ? `, and ${ugx(b.pending)} still clearing` : ''}.`;
        if (w.first && w.first.opensAt) return `Your first withdrawal opens ${day(w.first.opensAt)}. This waiting period protects everyone from fake accounts.`;
        if (w.first && w.first.needsStore) return 'Your first withdrawal opens after your first store has paid and cleared.';
        if (w.nextAllowedAt) return `Your next withdrawal opens ${day(w.nextAllowedAt)}.`;
        return '';
    }

    // The dashboard is a handful of sections (see GrowthShell): one is shown at a time, the rest stay in the page so every button keeps working.
    const panel = (id, html) => `<div class="gp-panel" data-panel="${id}" tabindex="-1"${id === activeTab ? '' : ' hidden'}>${html}</div>`;
    const statTile = (tab, icon, label, value) => `<a class="gp-stat" href="#${tab}" data-tab-link="${tab}" data-local><i class="fas ${icon}" aria-hidden="true"></i><small>${label}</small><strong>${value}</strong></a>`;

    function tabBadges() {
        if (!me) return {};
        const out = { recruits: me.summary.needsYou || 0 };
        if (!withdrawBlockReason() && me.balances.available >= me.withdrawal.min) out.earn = true;
        if (PROGRAM === 'crew') out.field = readQueue().length;
        return out;
    }
    function showTab(id, { scroll = true } = {}) {
        if (!me || !['active', 'frozen'].includes(me.partner.status)) return;
        activeTab = Shell.tabs(PROGRAM).some((t) => t.id === id) ? id : 'home';
        root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== activeTab; });
        Shell.renderTabs({ program: PROGRAM, active: activeTab, badges: tabBadges() });
        if (location.hash !== `#${activeTab}`) history.replaceState(null, '', `${location.pathname}${location.search}#${activeTab}`);
        if (scroll) window.scrollTo(0, 0);
        const shown = root.querySelector(`[data-panel="${activeTab}"]`); if (shown && scroll) shown.focus({ preventScroll: true });
    }

    function accountCard() {
        const p = me.partner;
        const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
        return `<section class="gp-card"><h2>Your account</h2><dl class="gp-dl">${row('Name', esc(p.displayName))}${row('Program', `${esc(p.programName)} · ${esc(p.programDescriptor)}`)}${row('Your code', `<code>${esc(p.code)}</code>`)}${(p.previousCodes || []).length ? row('Old Circle code', `${p.previousCodes.map((c) => `<code>${esc(c)}</code>`).join(', ')} <span class="gp-muted">still works</span>`) : ''}${row('Member since', esc(day(p.joinedAt)))}${PROGRAM === 'crew' && p.territories.length ? row('Your areas', esc(p.territories.map(district).join(', '))) : ''}</dl></section>`;
    }
    function backCard() {
        const seller = typeof app !== 'undefined' && !!app.user && app.user.role === 'seller';
        const link = (href, icon, label) => `<a class="gp-btn" href="${esc(href)}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</a>`;
        return `<section class="gp-card"><h2>Back to NextaStore</h2><p class="gp-muted">${esc(me.partner.programName)} is part of NextaStore. Your marketplace account, orders and messages are one tap away.</p>
            <div class="gp-row" style="margin-top:12px">${link(H.main('/marketplace'), 'fa-store', 'Marketplace')}${link(H.main('/messages'), 'fa-message', 'Messages')}${seller ? link(H.main('/dashboard'), 'fa-gauge', 'My store dashboard') : ''}</div>
            <div class="gp-row" style="margin-top:12px"><a class="gp-link" href="${esc(H.about(PROGRAM))}">About ${esc(rules.programs[PROGRAM].short)}</a><a class="gp-link" href="${esc(H.main('/terms'))}">Terms</a></div></section>`;
    }
    /** Circle dashboard: the way up, or where the request stands. Never shown to Crew members or when Crew is closed to new people. */
    function upgradeCard() {
        const u = me.upgrade;
        if (PROGRAM !== 'circle' || !u || u.state === 'none' || u.state === 'upgraded') return '';
        const k = rules.programs.crew, crew = esc(H.program('crew')), lo = k.ranks[0].ratePercent, hi = k.ranks[k.ranks.length - 1].ratePercent;
        if (u.state === 'pending') return `<section class="gp-card gp-upgrade" role="status"><div class="gp-spread"><h2><i class="fas fa-hourglass-half" aria-hidden="true"></i> Your Crew request is with our team</h2></div><p class="gp-muted">Sent ${esc(day(u.appliedAt))}. We aim to finish ${reviewText()}. Circle keeps working as normal until then.</p><div class="gp-row"><a class="gp-btn is-small" href="${crew}">View my request</a></div></section>`;
        if (u.state === 'declined') return `<section class="gp-card gp-upgrade"><h2><i class="fas fa-circle-info" aria-hidden="true"></i> About your Crew request</h2><p class="gp-muted">${u.reason ? esc(u.reason) + ' ' : ''}Circle carries on exactly as before.${u.canReapplyAt ? ` You can ask again from ${esc(day(u.canReapplyAt))}.` : ''}</p>${u.canApply ? `<div class="gp-row"><a class="gp-btn is-small is-primary" href="${crew}">Ask again</a></div>` : ''}</section>`;
        if (!u.canApply) return '';
        return `<section class="gp-card gp-upgrade"><h2><i class="fas fa-circle-arrow-up" aria-hidden="true"></i> Ready for more? Move up to the Crew</h2><p class="gp-muted">Crew members earn <b>${lo}% to ${hi}%</b> of each store's first month (Circle pays ${rules.programs.circle.commissionPercent}%) and get field tools. Your code, link and earnings keep working, and stores already in your circle stay on Circle terms.</p><div class="gp-row"><a class="gp-btn is-small is-primary" href="${crew}">See what changes</a></div></section>`;
    }
    const upgradedKey = () => `gp-upgraded-seen:${me.partner.code}`;
    /** Crew dashboard, first visits after moving up: what happened to the old link, said once. */
    function upgradedBanner() {
        const u = me.upgrade;
        if (PROGRAM !== 'crew' || !u || u.state !== 'upgraded') return '';
        try { if (localStorage.getItem(upgradedKey()) === '1') return ''; } catch (e) { /* private mode: it just shows again */ }
        const old = (u.previousCodes || []).map((c) => `<code>${esc(c)}</code>`).join(', ');
        return `<section class="gp-needs is-info" role="status"><i class="fas fa-circle-arrow-up" aria-hidden="true"></i><div><b>Welcome to the Crew.</b> Your new code is <code>${esc(me.partner.code)}</code>. ${old ? `Your old Circle code ${old} and every link you shared still work, so nothing has stopped. ` : ''}Sign-ups from your approval on count as Crew; stores that signed up before stay on Circle terms.<br><button class="gp-btn is-small" data-gp-dismiss-upgrade style="margin-top:8px">Got it</button></div></section>`;
    }
    const codeCard = () => `<section class="gp-card"><h2>Have a code to add?</h2><p class="gp-muted">If you opened your own store and forgot to use a code, you can add one within ${plural(rules.lateClaimDays, 'day')} of signing up, before any payment.</p><div class="gp-inline" style="margin-top:10px"><input id="gpClaim" placeholder="CIRCLE-XXXXX or CREW-XXXXX" aria-label="Code" autocapitalize="characters" autocomplete="off"><button class="gp-btn" id="gpClaimBtn">Add code</button></div></section>`;

    function renderDashboard() {
        const p = me.partner, b = me.balances, s = me.summary;
        const frozen = p.frozen ? `<section class="gp-needs" role="status"><i class="fas fa-shield-halved" aria-hidden="true"></i> ${esc(p.frozenReason)}</section>` : '';
        const needs = s.needsYou ? `<section class="gp-needs" role="status"><i class="fas fa-bell" aria-hidden="true"></i> ${s.needsYou} recruit${s.needsYou === 1 ? '' : 's'} could use your help today. They are at the top of the list in <a href="#recruits" data-tab-link="recruits" data-local>Stores</a>.</section>` : '';
        const why = withdrawBlockReason();
        const hero = `<section class="gp-hero">${heroMark()}
                ${heroKicker(programIcon, `${esc(p.programName)} · ${esc(p.programDescriptor)}${me.rank ? ' · ' + esc(me.rank.label) : ''}`)}
                <h1>Hello, ${esc(p.displayName.split(' ')[0])}</h1>
                <p>You earn <b>${me.ratePercent}%</b> of each store's first month, plus bonuses. Share your code, then watch each store move toward its first payment.</p>
                <div class="gp-code"><span class="gp-code-chip" id="gpCode">${esc(p.code)}</span>
                    <button class="gp-btn is-light" id="gpCopy"><i class="fas fa-copy" aria-hidden="true"></i> Copy link</button>
                    <a class="gp-btn is-light" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText())}"><i class="fab fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>
                    ${PROGRAM === 'crew' ? '<button class="gp-btn is-light" id="gpQr"><i class="fas fa-qrcode" aria-hidden="true"></i> QR for my phone</button>' : ''}</div>
                <div class="gp-linkbox"><span>Your link:</span><code id="gpLinkText">${esc(inviteLink())}</code></div>
            </section>`;
        const stats = `<div class="gp-stats">${statTile('earn', 'fa-wallet', 'Ready to withdraw', ugx(Math.max(0, b.available)))}${statTile('recruits', 'fa-store', PROGRAM === 'crew' ? 'Leads and stores' : 'Stores in your circle', s.total)}${statTile('recruits', 'fa-circle-check', 'Paid stores', s.paid)}</div>`;
        const money = `<section class="gp-card" id="gpMoney" aria-labelledby="gpMoneyH">
                    <div class="gp-spread"><h2 id="gpMoneyH">Your money</h2><button class="gp-btn is-primary is-small" id="gpWithdraw" ${why ? 'aria-disabled="true" aria-describedby="gpWhy"' : ''}>Withdraw</button></div>
                    <div class="gp-money"><div class="is-main"><small>Ready to withdraw</small><strong>${ugx(Math.max(0, b.available))}</strong></div><div><small>Clearing (${me.clearanceDays} days)</small><strong>${ugx(b.pending)}</strong></div><div><small>Paid out</small><strong>${ugx(b.paid)}</strong></div></div>
                    ${why ? `<p class="gp-why" id="gpWhy">${esc(why)}</p>` : ''}
                    ${withdrawalBlock()}
                    <p class="gp-muted" style="margin-top:12px">${esc(me.trust.label)} account: ${ugx(me.withdrawal.min)} to ${ugx(me.trust.perRequestMax)} per withdrawal, one every ${plural(me.trust.minGapDays, 'day')}, up to ${ugx(me.trust.monthlyMax)} every 30 days. ${me.withdrawal.feeOnUs ? '<b>NextaStore pays the mobile money fee, so you receive the full amount.</b> ' : ''}Your limits grow as your stores pay and stay.${me.withdrawal.nextAllowedAt ? ` Next withdrawal opens ${esc(day(me.withdrawal.nextAllowedAt))}.` : ''}</p>
                    ${payoutBlock()}
                </section>`;
        const recruits = `<section class="gp-card"><div class="gp-spread"><h2>Your recruits</h2><span class="gp-muted">${s.total} total · ${s.awaitingApproval} awaiting approval · ${s.live} live · ${s.paid} paid</span></div>
                <div id="gpRecruits">${me.recruits.length ? me.recruits.map(recruitRow).join('') : `<div class="gp-empty"><i class="fas fa-seedling" aria-hidden="true"></i>No one yet. Share your code, then come back to see each store's progress.</div>`}</div></section>`;
        const earnings = `<section class="gp-card"><h2>Recent earnings</h2>${earningsTable()}</section>`;
        const studio = '<section class="gp-card" id="gpStudio"></section>';

        const panels = PROGRAM === 'crew'
            ? [['home', `${hero}${upgradedBanner()}${frozen}${needs}${startCard()}${queueCard()}${stats}${rankCard()}${idCardSection()}${marketDaysCard()}`],
               ['field', `${leadsCard(p.territories)}${trail ? trailCard() : ''}${studio}`],
               ['recruits', recruits],
               ['earn', money + earnings],
               ['more', accountCard() + codeCard() + backCard() + logoutCard()]]
            : [['home', `${hero}${frozen}${needs}${startCard()}${stats}${upgradeCard()}${circleCard()}${marketDaysCard()}`],
               ['recruits', recruits],
               ['earn', money + earnings],
               ['share', studio],
               ['more', accountCard() + codeCard() + backCard() + logoutCard()]];
        root.innerHTML = panels.map(([id, html]) => panel(id, html)).join('');
        Shell.renderTabs({ program: PROGRAM, active: activeTab, badges: tabBadges() });
        wire();
    }
    const logoutCard = () => `<section class="gp-card"><button class="gp-btn is-danger" id="gpLogout"><i class="fas fa-right-from-bracket" aria-hidden="true"></i> Log out</button></section>`;

    function withdrawalBlock() {
        const w = me.withdrawal.open;
        if (!w) return '';
        const label = { requested: 'Requested', in_review: 'Being checked', approved: 'Approved, being paid' }[w.status] || w.status;
        return `<div class="gp-needs is-info" style="margin-top:12px"><i class="fas fa-clock" aria-hidden="true"></i><div><b>${ugx(w.amount)} · ${esc(label)}</b><br><span class="gp-muted">You will be paid by ${esc(w.dueByText)}.${w.overdue ? ' We are running late on this one and have been alerted.' : ''}</span></div>${w.status !== 'approved' ? `<button class="gp-btn is-small" data-cancel="${esc(w.id)}">Cancel</button>` : ''}</div>`;
    }
    function payoutBlock() {
        const po = me.partner.payout;
        const lock = po && po.lockedUntil ? `<br><span class="gp-muted">Withdrawals reopen ${esc(new Date(po.lockedUntil).toLocaleString('en-UG', { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} (safety step after a change).</span>` : '';
        return `<div style="margin-top:12px" class="gp-spread"><div><b style="font-size:.82rem">Paid to</b><br><span class="gp-muted">${po ? `${po.network === 'mtnMomo' ? 'MTN MoMo' : 'Airtel Money'} · ${esc(po.number)} · ${esc(po.name)}` : 'No payout number yet'}${lock}</span></div><button class="gp-btn is-small" id="gpPayout">${po ? 'Change' : 'Add number'}</button></div>`;
    }
    function circleCard() {
        const c = rules.programs.circle;
        return `<section class="gp-card"><h2>Earn more per store</h2><ol class="gp-steps"><li>${c.commissionPercent}% of the first month (${ugx(c.firstMonth)}) when their payment is approved.</li><li>+ ${ugx(c.commitmentKicker)} if they pay ${rules.kickerMinMonths} months or more up front.</li><li>+ ${ugx(c.stayBonus)} when they renew their Seller Pass on time.</li></ol><p class="gp-muted">Tip: a store with products on its shelf has more reason to stay. Offer to help the owner add their first few products.</p></section>`;
    }
    // The rank's medal (js/growth-art.js). Falls back to the mountain icon if the art file did not load.
    function rankMedal(r) {
        const ranks = (rules.programs.crew && rules.programs.crew.ranks) || [];
        const i = Math.max(0, ranks.findIndex((x) => x.label === r.label || x.key === r.key));
        return window.GrowthArt ? window.GrowthArt.medal(i, { size: 58, label: `${r.label} medal` }) : '<i class="fas fa-mountain" aria-hidden="true"></i>';
    }
    const sharedKey = () => `gp-shared:${me.partner.code}`;
    const markShared = () => { try { localStorage.setItem(sharedKey(), '1'); } catch (e) { /* private mode: the card just stays */ } };
    /** "Get started": the first five things, in order, with a ring. Disappears once all are done. */
    function startCard() {
        const s = me.summary, b = me.balances;
        let shared = false; try { shared = localStorage.getItem(sharedKey()) === '1'; } catch (e) { /* ignore */ }
        const steps = [
            [!!me.partner.payout, 'Add your payout number', 'So your first reward can reach you.', '<button class="gp-btn is-small" data-gp-action="payout">Add it</button>'],
            [shared || s.total > 0, 'Share your link', 'Send it to one person who owns a shop.', `<a class="gp-btn is-small" href="#share" data-tab-link="${PROGRAM === 'crew' ? 'home' : 'share'}" data-local>Open tools</a>`],
            [s.total > 0, PROGRAM === 'crew' ? 'Log your first business' : 'Get your first sign-up', 'A store you brought opens its shop.', PROGRAM === 'crew' ? '<a class="gp-btn is-small" href="#field" data-tab-link="field" data-local>Log one</a>' : ''],
            [s.paid > 0, 'Your first store pays', 'This is when you earn.', ''],
            [b.paid > 0, 'Withdraw your first reward', 'Straight to your mobile money.', '']
        ];
        const done = steps.filter((x) => x[0]).length;
        if (done === steps.length) return '';
        const ring = window.GrowthArt ? window.GrowthArt.ring(Math.round((done / steps.length) * 100), { size: 64, label: `${done} of ${steps.length} done` }) : '';
        return `<section class="gp-card gp-start" aria-labelledby="gpStartH"><div class="gp-spread"><div><h2 id="gpStartH">Get started</h2><p class="gp-muted">${done} of ${steps.length} done</p></div><span class="gp-start-ring">${ring}</span></div>
            <ol class="gp-start-list">${steps.map(([ok, t, d, action], i) => `<li class="${ok ? 'is-done' : (steps.findIndex((x) => !x[0]) === i ? 'is-next' : '')}"><span class="gp-start-n">${ok ? '<i class="fas fa-check" aria-hidden="true"></i>' : i + 1}</span><span><b>${esc(t)}</b><small>${esc(d)}</small></span>${!ok && steps.findIndex((x) => !x[0]) === i ? action : ''}</li>`).join('')}</ol></section>`;
    }
    /** The Crew ID card: locked (blurred photo, progress) until the member has logged the target number of businesses or an admin releases it. */
    function idCardSection() {
        if (PROGRAM !== 'crew' || !me.card || !window.NextaCrewCard) return '';
        const c = me.card;
        const title = c.unlocked ? 'Your Crew ID card' : 'Your Crew ID card, locked';
        return `<section class="gp-card" id="gpIdCardSection" aria-labelledby="gpIdCardH"><h2 id="gpIdCardH">${esc(title)}</h2><div id="gpIdCardMount"></div></section>`;
    }
    /** The card photo is private, so it is fetched with the member's login and shown from memory (an <img src> could not send the header). */
    async function fetchCardPhoto() {
        if (!me.card || !me.card.hasPhoto) return null;
        const res = await fetch(`${app.apiBaseUrl}/growth/card/photo`, { headers: app.token ? { Authorization: `Bearer ${app.token}` } : {} });
        if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return null;
        return res.blob();
    }
    function mountIdCard() {
        const el = document.getElementById('gpIdCardMount'); if (!el || !window.NextaCrewCard) return;
        const p = me.partner, c = me.card, ranks = (rules.programs.crew && rules.programs.crew.ranks) || [];
        const idx = Math.max(0, ranks.findIndex((x) => x.key === (me.rank && me.rank.key)));
        let host = ''; try { host = new URL(inviteLink()).host; } catch (e) { host = ''; }
        window.NextaCrewCard.mount(el, {
            data: { name: p.displayName, rankIndex: idx, rankLabel: me.rank ? me.rank.label : '', areas: (p.territories || []).map(district), code: p.code, link: inviteLink(), host,
                since: new Date(p.joinedAt).toLocaleDateString('en-UG', { month: 'short', year: 'numeric' }), unlocked: c.unlocked, leads: c.leads, needed: c.needed, hasPhoto: c.hasPhoto },
            photoUrl: fetchCardPhoto, canChange: !c.unlocked && !!window.NextaCardPhoto, toast,
            replacePhoto: async (dataUrl) => { await put('/growth/card/photo', { photo: dataUrl }); if (me.card) me.card.hasPhoto = true; }
        });
    }
    function rankCard() {
        const r = me.rank, n = r.next;
        const pct = n ? Math.min(100, Math.round(((r.cleared90d) / (r.cleared90d + n.remaining)) * 100)) : 100;
        return `<section class="gp-card"><h2>Your rank</h2><div class="gp-rank"><div class="gp-rank-badge${window.GrowthArt ? ' is-medal' : ''}">${rankMedal(r)}</div><div><b>${esc(r.label)}</b> · ${r.ratePercent}% per store<br><span class="gp-muted">${plural(r.cleared90d, 'paid store')} in the last 90 days</span></div></div>
            <div class="gp-bar" style="margin:14px 0 6px" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress to the next rank"><i style="width:${pct}%"></i></div>
            <p class="gp-muted">${n ? `${plural(n.remaining, 'more paid store')} to reach <b>${esc(n.label)}</b> (${Math.round(n.rate * 100)}%).` : 'You are at the top of the trail. Keep your stores happy.'} Quality score: <b>${me.quality}/100</b>. ${Number.isFinite(rules.rankMinQuality) ? `Promotions need ${rules.rankMinQuality} or more, and quality` : 'Promotions need a healthy score, and quality'} comes from stores that pay, stay and renew.</p></section>`;
    }

    function recruitRow(r) {
        const wa = `https://wa.me/?text=${encodeURIComponent(nudgeText(r))}`;
        return `<article class="gp-recruit ${r.needsYou ? 'needs-you' : ''}">
            <div class="gp-recruit-head"><strong>${esc(r.name)}</strong><span class="gp-row"><span class="gp-chip tone-${esc(r.tone)}">${esc(r.label)}</span>${r.program && r.program !== me.partner.program ? '<span class="gp-chip tone-muted" title="This store signed up through your Circle link, so it is paid under Circle terms.">Circle terms</span>' : ''}${r.earning ? `<span class="gp-earn">${ugx(r.earning)}</span>` : ''}</span></div>
            <p class="gp-reason">${esc(r.reason)}</p>${r.nextStep ? `<p class="gp-next"><b>Next:</b> ${esc(r.nextStep)}</p>` : ''}
            <div class="gp-row"><span class="gp-muted">${r.district ? esc(district(r.district)) + ' · ' : ''}${esc(day(r.since))}</span>
                ${['signed_up', 'store_live', 'payment_pending'].includes(r.stage) ? `<a class="gp-btn is-small" target="_blank" rel="noopener" href="${wa}"><i class="fab fa-whatsapp" aria-hidden="true"></i> Send a nudge</a>` : ''}
                ${r.canAskUs ? `<button class="gp-btn is-small is-primary" data-ask="${esc(r.id)}"><i class="fas fa-hand" aria-hidden="true"></i> Ask us to check</button>` : ''}
                ${r.stage === 'lead' ? `<button class="gp-btn is-small" data-visit="${esc(r.id)}"><i class="fas fa-location-dot" aria-hidden="true"></i> Log a visit</button><button class="gp-btn is-small is-danger" data-drop="${esc(r.id)}">Drop</button>` : ''}</div></article>`;
    }
    function nudgeText(r) {
        const store = r.name;
        const map = { signed_up: `Hi, it's ${me.partner.displayName.split(' ')[0]}. Shall we add your first products to ${store} on NextaStore today? It takes about 10 minutes.`, store_live: `Hi, your store ${store} is live on NextaStore. Your free trial is running. When you are ready, the Seller Pass keeps it visible: ${absolute(H.main('/subscription'))}`, payment_pending: `Hi, I saw your Seller Pass payment for ${store}. Please double check the transaction ID you entered matches the one in your MTN/Airtel SMS, so we can approve it quickly.` };
        return map[r.stage] || 'Hi from NextaStore.';
    }
    function earningsTable() {
        if (!me.earnings.length) return `<div class="gp-empty"><i class="fas fa-coins" aria-hidden="true"></i>Earnings appear here the moment a store's payment is approved.</div>`;
        const label = { first_payment: 'First month', commitment_kicker: 'Long-commitment bonus', live_bonus: 'Stocked-store bonus', campaign_boost: 'Market Day boost', renewal: 'Stay bonus', adjustment: 'Adjustment', clawback: 'Reversal' };
        const st = { held: 'Clearing', review: 'Being checked', available: 'Ready' };
        return `<table class="gp-table"><thead><tr><th>When</th><th>What</th><th>Status</th><th>Amount</th></tr></thead><tbody>${me.earnings.map((e) => `<tr><td data-label="When">${esc(day(e.createdAt))}</td><td data-label="What">${esc(label[e.type] || titleCase(e.type))}<br><span class="gp-muted">${esc(e.note)}</span></td><td data-label="Status">${esc(st[e.status] || e.status)}${e.status === 'held' && e.clearsAt ? ` · clears ${esc(day(e.clearsAt))}` : ''}</td><td data-label="Amount"><b>${ugx(e.amount)}</b></td></tr>`).join('')}</tbody></table>`;
    }
    function leadsCard(territories) {
        // Offline there are no fresh rules: use the numbers saved on the last good visit, or say it without numbers.
        const L = (rules && rules.lead) || (lastPartner() && lastPartner().lead) || null;
        const intro = L
            ? `Logging it makes it yours for ${plural(L.lockDays, 'day')}. Visit again and log it to extend your claim (up to ${plural(L.maxExtensions, 'time')}, ${plural(L.extendDays, 'day')} each). You only earn when their payment is approved, so only log real conversations.`
            : 'Logging it makes it yours for a while, so nobody else can claim it. You only earn when their payment is approved, so only log real conversations.';
        return `<section class="gp-card"><h2>Log a business you visited</h2><p class="gp-muted">${intro}</p>
            <form class="gp-form" id="gpLead" novalidate style="margin-top:10px"><div class="gp-grid" style="gap:10px">
                <div class="gp-field"><label for="gpLb">Business name</label><input id="gpLb" maxlength="80" required autocomplete="off"></div>
                <div class="gp-field"><label for="gpLp">Owner's phone</label><input id="gpLp" type="tel" inputmode="tel" placeholder="0772 123 456" required></div>
                <div class="gp-field"><label for="gpLc">Owner's name (optional)</label><input id="gpLc" maxlength="80" autocomplete="off"></div>
                <div class="gp-field"><label for="gpLd">Area</label><select id="gpLd">${Object.entries(DISTRICTS).map(([k, v]) => `<option value="${k}" ${(territories || []).includes(k) ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
                <div class="gp-error" id="gpLeadErr" role="alert"></div><button class="gp-btn is-primary" type="submit">Log this lead</button></form></section>`;
    }
    function trailCard() {
        const rows = trail.districts.slice(0, 10).map((d) => `<div class="gp-trail-row ${d.inYourTerritory ? 'mine' : ''} ${d.liveStores < 5 ? 'thin' : ''}"><div><b>${esc(district(d.district))}</b>${d.inYourTerritory ? ' <span class="gp-chip">Your area</span>' : ''}<br><span class="gp-muted">${plural(d.liveStores, 'live store')} on NextaStore · you: ${plural(d.yours.leads, 'lead')}, ${d.yours.paid} paid</span></div><span class="gp-chip ${d.liveStores < 5 ? 'tone-warn' : ''}">${d.liveStores < 5 ? 'Room to grow' : 'Busy'}</span></div>`).join('');
        return `<section class="gp-card"><h2>Trail map</h2><p class="gp-muted">Where the marketplace is thin, shoppers have fewer shops to choose from. Walk there first.</p><div class="gp-trail" style="margin-top:10px">${rows}</div></section>`;
    }

    function marketDaysCard() {
        if (!campaigns.length) return '';
        const rows = campaigns.map((c) => {
            const whenText = c.live ? `ends ${esc(day(c.endsAt))}` : `starts ${esc(day(c.startsAt))}`;
            const board = c.live && c.board.length ? `<div class="gp-board">${c.board.map((b, i) => `<div class="gp-board-row ${b.you ? 'you' : ''}"><span>${i + 1}</span><span>${esc(b.firstName)}${b.you ? ' (you)' : ''}</span><span>${b.count} paid</span></div>`).join('')}</div>` : '';
            const mine = c.live ? `<p class="gp-reason">${c.mine ? `You have <b>${c.mine}</b> paid store${c.mine === 1 ? '' : 's'} in this Market Day${c.rank ? `, ranked #${c.rank}` : ''}.` : 'No paid stores for you yet. Stores that pay while this is live earn the boost.'}</p>` : '<p class="gp-reason">Tell the stores in your pipeline now: the ones that pay once it starts earn you the boost.</p>';
            return `<article class="gp-recruit"><div class="gp-recruit-head"><strong>${c.live ? '<span class="gp-live-dot" aria-hidden="true"></span>' : ''}${esc(c.title)}</strong><span class="gp-chip tone-good">+${c.boostPercent}% boost</span></div>
                <p class="gp-next">${c.district ? esc(district(c.district)) + ' · ' : ''}${whenText}${c.description ? ' · ' + esc(c.description) : ''}</p>${mine}${board}</article>`;
        }).join('');
        return `<section class="gp-card"><h2>Market Days</h2><p class="gp-muted">Special weeks with a bonus on top. Only stores whose payment is approved while it is live count.</p>${rows}</section>`;
    }

    // Offline lead queue: a lead typed with no signal is kept on the phone and sent later, with the time it was captured.
    const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (err) { return []; } };
    const writeQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (err) { /* storage unavailable */ } };
    let flushing = false;
    async function flushQueue() {
        if (flushing) return; flushing = true;
        try {
            const q = readQueue(); const keep = [];
            for (const item of q) {
                try { await post('/growth/leads', item.body); }
                catch (err) {
                    if (err.isNetwork) { keep.push(item); continue; }                      // still offline: try again later
                    keep.push({ ...item, failed: err.message || 'Could not be saved.' });   // rejected (taken, invalid...): keep the reason visible
                }
            }
            writeQueue(keep);
        } finally { flushing = false; }
    }
    function queueCard() {
        const q = readQueue();
        if (!q.length) return '';
        const waiting = q.filter((x) => !x.failed), failed = q.filter((x) => x.failed);
        return `<section class="gp-queue" id="gpQueue" role="status"><b><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i> ${waiting.length ? `${plural(waiting.length, 'lead')} saved on your phone` : 'Some leads need your attention'}</b>
            ${waiting.length ? `<div class="gp-muted">They will be sent as soon as you have signal, and keep the time you captured them. <button class="gp-btn is-small" id="gpQueueSend">Send now</button></div>` : ''}
            ${failed.map((x) => `<div class="gp-reason" style="margin-top:6px"><b>${esc(x.body.business)}</b>: ${esc(x.failed)} <button class="gp-btn is-small" data-qdrop="${esc(x.id)}">Dismiss</button></div>`).join('')}</section>`;
    }
    function wireLeadForm() {
        const $ = (id) => document.getElementById(id);
        $('gpQueueSend')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await flushQueue(); await refresh(); }));
        root.querySelectorAll('[data-qdrop]').forEach((b) => b.onclick = () => { writeQueue(readQueue().filter((x) => x.id !== b.dataset.qdrop)); me ? refresh() : renderOffline(); });
        $('gpLead')?.addEventListener('submit', (e) => {
            e.preventDefault(); const err = $('gpLeadErr'); err.textContent = '';
            busy(e.target.querySelector('button[type=submit]'), async () => {
                const body = { business: $('gpLb').value, phone: $('gpLp').value, contactName: $('gpLc').value, district: $('gpLd').value, capturedAt: new Date().toISOString() };
                try { const r = await post('/growth/leads', body); toast(`Yours until ${day(r.lockExpiresAt)}.`); await refresh(); }
                catch (ex) {
                    if (ex.isNetwork) {
                        // No signal: keep it on the phone and send it later with the time it was captured.
                        writeQueue([...readQueue(), { id: `q${Date.now()}${Math.random().toString(36).slice(2, 6)}`, body }]);
                        toast('No signal. Saved on your phone and will be sent automatically.');
                        e.target.reset(); me ? render() : renderOffline();
                    } else err.textContent = ex.message;
                }
            }, (ex) => { $('gpLeadErr').textContent = ex.message; });
        });
    }

    // ---------------------------------------------------------------- wiring
    function wire() {
        const $ = (id) => document.getElementById(id);
        $('gpLogout').onclick = () => app.logout();
        root.querySelectorAll('[data-gp-dismiss-upgrade]').forEach((b) => b.onclick = () => { try { localStorage.setItem(upgradedKey(), '1'); } catch (e) { /* ignore */ } b.closest('section').remove(); });
        $('gpCopy').addEventListener('click', markShared);
        document.querySelector('.gp-hero a[href^="https://wa.me"]')?.addEventListener('click', markShared);
        $('gpCopy').onclick = async () => { try { await navigator.clipboard.writeText(inviteLink()); toast('Link copied. Paste it anywhere.'); } catch { toast('Press and hold the link to copy it.'); } };
        $('gpWithdraw').onclick = () => { const why = withdrawBlockReason(); if (why) { toast(why, 6000); return; } openWithdraw(); };
        $('gpPayout').onclick = openPayout;
        $('gpQr')?.addEventListener('click', () => openQr());
        mountIdCard();
        const studio = $('gpStudio');
        if (studio && window.GrowthKit) window.GrowthKit.mount(studio, { program: PROGRAM, code: me.partner.code, link: inviteLink(), firstName: me.partner.displayName.split(' ')[0], rules }, toast);
        $('gpClaimBtn').onclick = (e) => busy(e.currentTarget, async () => { await post('/growth/claim', { code: $('gpClaim').value }); toast('Code added.'); await refresh(); });
        root.querySelectorAll('[data-ask]').forEach((b) => b.onclick = () => busy(b, async () => { const r = await post(`/growth/referrals/${b.dataset.ask}/ask-check`); toast(r.message); await refresh(); }));
        root.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => busy(b, async () => { await post(`/growth/withdrawals/${b.dataset.cancel}/cancel`); toast('Withdrawal cancelled.'); await refresh(); }));
        root.querySelectorAll('[data-drop]').forEach((b) => b.onclick = async () => {
            if (await confirm({ title: 'Drop this lead?', body: 'Someone else will be able to claim this business.', ok: 'Drop lead', danger: true })) busy(b, async () => { await api(`/growth/leads/${b.dataset.drop}`, { method: 'DELETE' }); await refresh(); });
        });
        root.querySelectorAll('[data-visit]').forEach((b) => b.onclick = () => openVisit(b.dataset.visit));
        wireLeadForm();
    }

    function openWithdraw() {
        const max = Math.max(0, Math.min(me.balances.available, me.trust.perRequestMax));
        const d = dialog(`<form method="dialog" class="gp-form" id="gpWf"><h2>Withdraw</h2><p class="gp-muted">You can withdraw up to ${ugx(max)} right now. We pay within ${plural(rules.payouts.payWithinWorkingDays, 'working day')}.${me.withdrawal.feeOnUs ? ' NextaStore pays the mobile money fee, so you receive every shilling.' : ''}</p>
            <div class="gp-field"><label for="gpAmt">Amount (UGX)</label><input id="gpAmt" type="number" inputmode="numeric" min="${me.withdrawal.min}" max="${max}" step="500" value="${max >= me.withdrawal.min ? max : ''}" required></div>
            <div class="gp-error" id="gpWErr" role="alert"></div><div class="gp-row gp-row-end"><button class="gp-btn" type="button" id="gpWx">Close</button><button class="gp-btn is-primary" type="submit">Request withdrawal</button></div></form>`, { label: 'Withdraw' });
        d.querySelector('#gpWx').onclick = () => d.close();
        d.querySelector('#gpWf').addEventListener('submit', (e) => { e.preventDefault(); busy(e.target.querySelector('button[type=submit]'), async () => {
            const r = await post('/growth/withdrawals', { amount: Number(d.querySelector('#gpAmt').value) });
            d.close(); toast(`Requested. You will be paid by ${r.dueByText}.`); await refresh();
        }, (ex) => { d.querySelector('#gpWErr').textContent = ex.message; }); });
    }
    function openPayout() {
        const hours = rules.payoutChangeLockHours;
        const d = dialog(`<form class="gp-form" id="gpPf"><h2>Where should we pay you?</h2><p class="gp-muted">Use a number registered in your own name. When a payout number is added or changed, withdrawals pause for ${plural(hours, 'hour')} as a safety step.</p>
            <div class="gp-field"><label for="gpNet">Network</label><select id="gpNet"><option value="mtnMomo">MTN MoMo</option><option value="airtelMoney">Airtel Money</option></select></div>
            <div class="gp-field"><label for="gpNum">Mobile money number</label><input id="gpNum" type="tel" inputmode="tel" placeholder="0772 123 456" autocomplete="tel" required></div>
            <div class="gp-field"><label for="gpNm">Name registered on that number</label><input id="gpNm" maxlength="80" required autocomplete="name"></div>
            <div class="gp-error" id="gpPErr" role="alert"></div><div class="gp-row gp-row-end"><button class="gp-btn" type="button" id="gpPx">Close</button><button class="gp-btn is-primary" type="submit">Save</button></div></form>`, { label: 'Payout number' });
        d.querySelector('#gpPx').onclick = () => d.close();
        d.querySelector('#gpPf').addEventListener('submit', (e) => { e.preventDefault(); busy(e.target.querySelector('button[type=submit]'), async () => {
            await put('/growth/payout', { network: d.querySelector('#gpNet').value, number: d.querySelector('#gpNum').value, name: d.querySelector('#gpNm').value });
            d.close(); toast('Saved.'); await refresh();
        }, (ex) => { d.querySelector('#gpPErr').textContent = ex.message; }); });
    }
    function openVisit(id) {
        const d = dialog(`<form class="gp-form" id="gpVf"><h2>Log a visit</h2><p class="gp-muted">A short note and, if you like, a photo of the shop front. It extends your claim and gives our team proof if two Crew members ever dispute a lead.</p>
            <div class="gp-field"><label for="gpVn">What happened?</label><textarea id="gpVn" maxlength="400" placeholder="Showed the demo. He will sign up on Friday."></textarea></div>
            <div class="gp-field"><label for="gpVp">Photo (optional)</label><input id="gpVp" type="file" accept="image/*" capture="environment"></div>
            <label class="gp-check"><input type="checkbox" id="gpVg" checked> <span>Add my current location</span></label>
            <div class="gp-error" id="gpVErr" role="alert"></div><div class="gp-row gp-row-end"><button class="gp-btn" type="button" id="gpVx">Close</button><button class="gp-btn is-primary" type="submit">Save visit</button></div></form>`, { label: 'Log a visit' });
        d.querySelector('#gpVx').onclick = () => d.close();
        d.querySelector('#gpVf').addEventListener('submit', (e) => { e.preventDefault(); busy(e.target.querySelector('button[type=submit]'), async () => {
            const pos = d.querySelector('#gpVg').checked && navigator.geolocation ? await new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => res(null), { timeout: 6000 })) : null;
            const r = await post(`/growth/leads/${id}/visit`, { note: d.querySelector('#gpVn').value, photo: await readImage(d.querySelector('#gpVp').files[0]), lat: pos?.latitude ?? null, lng: pos?.longitude ?? null });
            d.close(); toast(r.extended ? `Saved. Your claim was extended by ${plural(rules.lead.extendDays, 'day')}.` : 'Saved.'); await refresh();
        }, (ex) => { d.querySelector('#gpVErr').textContent = ex.message; }); });
    }
    function openQr(code) {
        const link = inviteLink(code);
        const d = dialog(`<div style="text-align:center"><h2>Show this to the shop owner</h2><div id="gpQrBox" style="display:grid;place-items:center;min-height:220px"></div><p class="gp-muted">Scanning opens NextaStore with your code already filled in. This QR works even without internet on your phone.</p><button class="gp-btn" id="gpQx" style="margin-top:8px">Close</button></div>`, { label: 'Your QR code' });
        d.querySelector('#gpQx').onclick = () => d.close();
        const box = d.querySelector('#gpQrBox');
        try { window.NextaQR.render(box, link, { scale: 7, margin: 3 }); }
        catch (err) { box.innerHTML = `<b>${esc(link)}</b>`; }
    }

    // A queued lead is sent as soon as the phone is back online, wherever the Crew member is in the app.
    window.addEventListener('online', async () => {
        if (PROGRAM !== 'crew') return;
        if (!me) { boot(); return; }                          // we were showing the offline view: load the real dashboard
        if (!readQueue().length) return;                      // nothing waiting: leave the page exactly as it is
        await flushQueue(); refresh();
    });

    // Sections and header-menu actions (the menu lives in the page header, outside #gpRoot).
    Shell.onSelect((id) => showTab(id));
    Shell.onAction((name) => {
        if (!me || !['active', 'frozen'].includes(me.partner.status)) return;
        if (name === 'payout') openPayout();
        if (name === 'copy') navigator.clipboard.writeText(inviteLink()).then(() => toast('Link copied. Paste it anywhere.'), () => toast('Press and hold the link to copy it.'));
    });
    window.addEventListener('hashchange', () => { const id = location.hash.replace(/^#/, ''); if (me && Shell.tabs(PROGRAM).some((t) => t.id === id) && id !== activeTab) showTab(id); });

    window.GrowthUI.offlineBanner();
    window.GrowthUI.registerWorker();
    boot();
})();
