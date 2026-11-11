/**
 * The public "About Circle" / "About Crew" pages.
 *
 * Two jobs, and nothing about money or rules is hard-coded in the HTML:
 *   1. Fill every figure from the LIVE program rules (GET /api/growth/rules). If they cannot load, the page keeps its plain
 *      wording ("a percentage") and never shows a stale number.
 *   2. Point every Join / Apply button at the right place for THIS visitor, so nobody is sent somewhere that contradicts the page:
 *        signed out or signed in but not a member  -> the program page, with ?go=1 (carry on to sign-in / the join form)
 *        already in THIS program                   -> "Open my dashboard" (with ?go=1, so the program page never bounces them back), or their application status
 *        already in the OTHER program              -> no join button; a note that an account is in one program, and a link to theirs
 *        program closed and not a member           -> a disabled "Not open yet"
 *
 * The pure parts (facts, rankRows, cta, tokenOk) are exported for scripts/growth-about-test.js; the page wiring runs only in a browser.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (root.document) api.boot(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    var NAMES = { circle: { name: 'NextaStore Circle', short: 'Circle' }, crew: { name: 'NextaStore Crew', short: 'Crew' } };
    var isNum = function (v) { return typeof v === 'number' && isFinite(v); };
    var ugx = function (n) { return 'UGX ' + Number(n).toLocaleString('en-UG'); };
    var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
    var esc = function (x) { return String(x).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };

    /** key -> text for every data-f="key" on the page. A figure that is missing from the rules is simply left out, so the plain wording stays. */
    function facts(d) {
        var out = {};
        var set = function (k, v) { if (v !== null && v !== undefined && v !== '' && String(v).indexOf('NaN') < 0 && String(v).indexOf('undefined') < 0) out[k] = String(v); };
        var money = function (k, n) { if (isNum(n)) set(k, ugx(n)); };
        var count = function (k, n, one, many) { if (isNum(n)) set(k, plural(n, one, many)); };
        d = d || {};
        var p = d.programs || {}, c = p.circle || {}, s = p.crew || {}, pay = d.payouts || {}, l = d.lead || {};

        money('pass', d.passPricePerMonth);
        count('trial', d.trialDays, 'day'); count('kickerMonths', d.kickerMinMonths, 'month');
        count('qualDays', d.qualifyingWindowDays, 'day'); count('lateClaim', d.lateClaimDays, 'day'); count('clickDays', d.clickWindowDays, 'day');
        count('renewalDays', d.renewalWithinDays, 'day'); count('rankWindow', d.rankWindowDays, 'day'); count('reviewDays', d.applicationReviewWorkingDays, 'working day');
        if (isNum(d.maxUpfrontPercent)) set('capPct', d.maxUpfrontPercent + '%');
        count('stockedMin', d.stockedMinProducts, 'product');
        money('minWd', pay.minWithdrawal); count('clearDays', pay.clearanceDays, 'day'); count('payDays', pay.payWithinWorkingDays, 'working day'); count('firstWd', pay.firstWithdrawalAfterDays, 'day');

        if (isNum(c.commissionPercent)) set('c.pct', c.commissionPercent + '%');
        money('c.first', c.firstMonth); money('c.kicker', c.commitmentKicker); money('c.stay', c.stayBonus);
        if (isNum(c.firstMonth) && isNum(c.stayBonus)) money('c.stayTotal', c.firstMonth + c.stayBonus);

        money('s.kicker', s.commitmentKicker); money('s.stay', s.stayBonus); money('s.stocked', s.stockedBonus);
        if (isNum(s.maxTerritories)) set('s.areas', plural(s.maxTerritories, 'area'));
        if (s.card && isNum(s.card.unlockLeads)) set('s.cardLeads', s.card.unlockLeads);
        if (Array.isArray(s.ranks) && s.ranks.length) {
            var first = s.ranks[0], last = s.ranks[s.ranks.length - 1];
            set('s.rankCount', s.ranks.length); set('s.rankFirst', first.label); set('s.rankLast', last.label);
            if (isNum(first.ratePercent) && isNum(last.ratePercent)) set('s.rateRange', first.ratePercent + '% to ' + last.ratePercent + '%');
        }
        count('lockDays', l.lockDays, 'day'); count('lockExtend', l.extendDays, 'day'); if (isNum(l.maxExtensions)) set('lockMax', l.maxExtensions);
        count('offlineHrs', d.offlineLeadMaxAgeHours, 'hour');
        return out;
    }

    /** The Crew rank table body. Every cell is escaped; a rank with no threshold is the starting rank. */
    function rankRows(ranks, windowDays) {
        var span = isNum(windowDays) ? ' in the last ' + plural(windowDays, 'day') : ' recently';
        return (ranks || []).map(function (r) {
            var reach = r.minCleared90d ? plural(r.minCleared90d, 'paid store') + span : 'Where everyone starts';
            var reward = isNum(r.ratePercent) ? r.ratePercent + '%' + (isNum(r.firstMonth) ? ' (' + ugx(r.firstMonth) + ')' : '') : 'Rises with rank';
            return '<tr><td>' + esc(r.label) + '</td><td>' + esc(reach) + '</td><td>' + esc(reward) + '</td></tr>';
        }).join('');
    }

    /**
     * What the Join / Apply button and the line under it should say and do.
     *   input  { program: 'circle'|'crew', open: true|false|undefined (undefined = rules unavailable), signedIn: bool,
     *            member: null | { program, status } }
     *   output { state, label, target: 'join'|'self'|'other'|'none', disabled, note, status }
     */
    function cta(i) {
        var mine = i.program === 'crew' ? 'crew' : 'circle', other = mine === 'crew' ? 'circle' : 'crew';
        var joinLabel = mine === 'crew' ? 'Apply to join ' + NAMES.crew.name : 'Join ' + NAMES.circle.name;
        var m = i.member;
        if (m && m.program === mine) {
            if (m.status === 'applied') return { state: 'applied', label: 'Check my application', target: 'self', disabled: false, note: '', status: 'Your application is being reviewed' };
            if (m.status === 'rejected' || m.status === 'retired') return { state: 'closed', label: 'View my account', target: 'self', disabled: false, note: '', status: 'Your account is not active' };
            return { state: 'member', label: 'Open my dashboard', target: 'self', disabled: false, note: '', status: 'You are in ' + NAMES[mine].short };
        }
        // A Circle member looking at Crew is not turned away: they can ask to move up. Circle keeps working until an admin approves.
        if (m && mine === 'crew' && m.program === 'circle' && m.status === 'active') {
            if (m.upgrade === 'pending') return { state: 'upgrade-pending', label: 'Check my Crew request', target: 'join', disabled: false, note: 'Your request is with our team. ' + NAMES.circle.name + ' keeps working as normal while you wait.', status: 'Request received' };
            if (i.open === false) return { state: 'closed', label: 'Not open yet', target: 'none', disabled: true, note: 'You are in ' + NAMES.circle.name + ', which keeps working as normal.', status: 'Not open yet' };
            return { state: 'upgrade', label: 'Upgrade to ' + NAMES.crew.name, target: 'join', disabled: false, note: 'You are in ' + NAMES.circle.name + '. Ask to move up: Circle keeps working as normal, with your code, link and earnings, while we review.', status: 'You are in Circle' };
        }
        if (m && (m.program === 'circle' || m.program === 'crew')) {
            return { state: 'other', label: 'Open my ' + NAMES[other].short + ' dashboard', target: 'other', disabled: false,
                note: 'You are already in ' + NAMES[other].name + '. Each account can be in one program at a time, so you cannot join ' + NAMES[mine].name + ' with this account.',
                status: 'You are in ' + NAMES[other].short };
        }
        if (i.open === false) return { state: 'closed', label: 'Not open yet', target: 'none', disabled: true, note: '', status: 'Not open yet' };
        return { state: 'join', label: joinLabel, target: 'join', disabled: false, note: '', status: i.open === true ? (mine === 'crew' ? 'Applications are open' : 'Open to join') : '' };
    }

    const money = ugx;
    const model = () => (typeof globalThis !== 'undefined' && globalThis.GrowthEconomics) || (typeof require === 'function' ? require('./growth-economics.js') : null);

    /** An illustration of one month, from today's live rewards: a number of stores, a share of them renewing on time. Never a promise. */
    function estimate(rules, program, rankKey, stores, renewShare) {
        const E = model();
        const n = Math.max(0, Math.min(200, Math.round(Number(stores) || 0))), share = Math.max(0, Math.min(1, Number(renewShare) || 0));
        const one = E.perStore(rules, program, rankKey, { months: 1, renews: false });
        const stay = E.perStore(rules, program, rankKey, { months: 1, renews: true, stocked: true });
        const renewals = Math.round(n * share);
        const first = one.upfront * n, renewal = stay.renewal * renewals;
        return { stores: n, renewals, perStore: one.upfront, first, renewal, total: first + renewal };
    }

    /** The short "at a glance" chips under the headline. Only facts that are actually known are shown. */
    function glance(f, program, member) {
        const out = [];
        if (member) return out;   // someone already in the program is not sold the program again
        if (program === 'crew') { if (f['s.rateRange']) out.push(`${f['s.rateRange']} of month one`); } else if (f['c.pct']) out.push(`${f['c.pct']} of month one`);
        if (f.payDays) out.push(`Paid within ${f.payDays}`);
        if (f.trial) out.push(`${f.trial} free trial for the store`);
        out.push(program === 'crew' ? 'By application' : 'Free to join');
        return out;
    }

    /** Circle and Crew side by side, from the live rules. Static words only; every figure is a fact from the rules. */
    function compareRows(d) {
        const f = facts(d), s = ((d || {}).programs || {}).crew || {};
        const w = (v, fallback) => v || fallback;
        return [
            ['Who can join', 'Anyone with a verified account', 'People approved by our team, with ID'],
            ['First-month reward', w(f['c.pct'], 'A percentage of one month'), w(f['s.rateRange'], 'Grows with rank')],
            ['Long-commitment bonus', w(f['c.kicker'], 'A bonus'), w(f['s.kicker'], 'A bonus')],
            ['Stay bonus', w(f['c.stay'], 'A bonus'), w(f['s.stay'], 'A bonus') + (f['s.stocked'] ? ` + ${f['s.stocked']} if the store is stocked` : '')],
            ['Ranks', 'None', Array.isArray(s.ranks) && s.ranks.length ? `${s.ranks.length} ranks: ${s.ranks.map((r) => r.label).join(', ')}` : 'Yes'],
            ['Your tools', 'Code, link, invite card and QR', 'All of Circle, plus lead logging, field QR, pitch kit, trail map'],
            ['Cost to join', 'Free', 'Free']
        ];
    }

    /** A session token that is present and not expired. The server still decides what it is allowed to do. */
    function tokenOk(t, nowMs) {
        if (!t || typeof t !== 'string') return false;
        var parts = t.split('.'); if (parts.length !== 3) return false;
        try {
            var b = parts[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
            var json = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary');
            var exp = JSON.parse(json).exp;
            return !exp || exp * 1000 > (nowMs || Date.now()) + 10000;
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------------ the page (browser only)
    function boot(win) {
        var doc = win.document, body = doc.body;
        var PROGRAM = body.getAttribute('data-program') === 'crew' ? 'crew' : 'circle';
        var OTHER = PROGRAM === 'crew' ? 'circle' : 'crew';
        var H = win.NextaHosts;
        var all = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };
        var meta = doc.querySelector('meta[name="nextastore-api-base"]');
        var host = win.location.hostname;
        var API = (meta && meta.content) || ((host === 'localhost' || host === '127.0.0.1') ? 'http://localhost:4000/api' : win.location.origin + '/api');
        var programHref = function (which) { return H ? H.program(which) : '/' + (which === 'crew' ? 'crew' : 'circle'); };

        // The session may live in localStorage (kept) or sessionStorage ("don't keep me signed in"). Both count.
        var token = null;
        try { token = win.localStorage.getItem('nextastore_token') || win.sessionStorage.getItem('nextastore_token'); } catch (e) { /* storage blocked: treated as signed out */ }
        var signedIn = tokenOk(token);

        // What we last learned about THIS session's membership, so a returning member sees the right button on the very first
        // paint. It is only a head start: the live answer from /growth/me always replaces it. Keyed by the end of the token, so
        // another person signing in on the same phone never sees the previous person's state.
        var CACHE_KEY = 'nx_about_member';
        var sig = signedIn ? String(token).slice(-24) : '';
        function readCache() {
            try { var c = JSON.parse(win.localStorage.getItem(CACHE_KEY) || 'null'); return c && c.sig === sig && c.member ? c.member : null; } catch (e) { return null; }
        }
        function writeCache(member) {
            try { if (member) win.localStorage.setItem(CACHE_KEY, JSON.stringify({ sig: sig, member: member })); else win.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
        }

        // pending: signed in, and we do not yet know whether they are a member. The button waits instead of saying "Join".
        var state = { open: undefined, member: signedIn ? readCache() : null, pending: signedIn };
        if (state.member) state.pending = false;
        var original = {};
        function paint() {
            var c = cta({ program: PROGRAM, open: state.open, signedIn: signedIn, member: state.member });
            var waiting = state.pending && !state.member;
            var inProgram = !waiting && (c.target === 'self' || c.target === 'other' || c.state === 'upgrade' || c.state === 'upgrade-pending');
            body.setAttribute('data-member', inProgram ? 'in' : (waiting ? 'wait' : 'out'));
            all('[data-join]').forEach(function (a) {
                var sp = a.querySelector('span');
                if (waiting) {
                    // Placeholder, but still a real link: the program page itself shows a member their dashboard, so even a tap now lands right.
                    if (sp) sp.textContent = '\u00a0';   // no words at all while we do not know
                    a.setAttribute('data-state', 'pending'); a.removeAttribute('aria-disabled'); a.removeAttribute('tabindex');
                    a.setAttribute('href', programHref(PROGRAM) + '?go=1'); a.setAttribute('aria-busy', 'true');
                    return;
                }
                a.removeAttribute('aria-busy');
                if (sp) sp.textContent = c.label;
                a.setAttribute('data-state', c.state);
                if (c.target === 'none') { a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); a.setAttribute('tabindex', '-1'); return; }
                a.removeAttribute('aria-disabled'); a.removeAttribute('tabindex');
                // ?go=1 on every target: it tells the program page "this person came on purpose", so it never bounces them back here.
                a.setAttribute('href', c.target === 'join' ? programHref(PROGRAM) + '?go=1' : programHref(c.target === 'other' ? OTHER : PROGRAM) + '?go=1');
            });
            // The bottom call-to-action speaks to where this person actually is.
            all('[data-cta-title]').forEach(function (n) { if (!('t' in original)) original.t = n.textContent; n.textContent = inProgram && c.target === 'self' ? (c.state === 'applied' ? 'Your application is in' : 'Welcome back') : original.t; });
            all('[data-cta-text]').forEach(function (n) { if (!('x' in original)) original.x = n.textContent; n.textContent = inProgram && c.target === 'self' ? (c.state === 'applied' ? 'Our team is reviewing it. You can check where it stands.' : 'Your code, link and earnings are on your dashboard.') : original.x; });
            all('[data-status]').forEach(function (n) { n.textContent = waiting ? '' : c.status; n.hidden = waiting || !c.status; });
            all('[data-status-dot]').forEach(function (n) { n.hidden = waiting || !c.status; });
            all('[data-signedout-note]').forEach(function (n) { n.hidden = signedIn; });
            // The one-program notice goes under each button.
            all('[data-member-note]').forEach(function (n) { n.remove(); });
            if (c.note && !waiting) all('[data-join]').forEach(function (a) {
                var p = doc.createElement('p'); p.className = 'ga-member-note'; p.setAttribute('data-member-note', ''); p.setAttribute('role', 'status'); p.textContent = c.note;
                a.insertAdjacentElement('afterend', p);
            });
            if (state.glanceData) renderGlance();
        }
        function renderGlance() {
            var g = doc.getElementById('gaGlance'); if (!g || !state.glanceData) return;
            var c = cta({ program: PROGRAM, open: state.open, signedIn: signedIn, member: state.member });
            var items = glance(state.glanceData, PROGRAM, !!state.member && (c.target === 'self' || c.target === 'other'));
            g.innerHTML = items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join(''); g.hidden = !items.length;
        }
        // A click must always go somewhere. A link that is being repainted at the very moment of the tap can lose its address,
        // so the click itself reads the CURRENT state and navigates, instead of trusting whatever the anchor holds.
        doc.addEventListener('click', function (ev) {
            var a = ev.target && ev.target.closest ? ev.target.closest('[data-join]') : null; if (!a) return;
            if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || a.getAttribute('target') === '_blank') return;
            if (a.getAttribute('aria-disabled') === 'true') { ev.preventDefault(); return; }
            var href = a.getAttribute('href');
            if (!href) { var c = cta({ program: PROGRAM, open: state.open, signedIn: signedIn, member: state.member }); href = programHref(c.target === 'other' ? OTHER : PROGRAM) + '?go=1'; }
            ev.preventDefault(); win.location.assign(href);
        });
        var Art = win.GrowthArt;
        if (Art) all('[data-art="hero"]').forEach(function (n) { n.innerHTML = Art.hero(PROGRAM); });
        paint();   // before anything loads: a plain, working link to the program page

        if (H && H.rewriteLinks) { H.rewriteLinks(doc); if (H.watch) H.watch(); }

        function getJson(path, auth) {
            var headers = { Accept: 'application/json' };
            if (auth) headers.Authorization = 'Bearer ' + token;
            return win.fetch(API + path, { headers: headers }).then(function (r) {
                return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, ok: r.ok, data: j && j.data !== undefined ? j.data : j }; });
            });
        }

        // The parts that need live numbers: glance chips, the earnings picture, the rank medals, the side-by-side table. All hidden until the rules arrive.
        function enhance(d, f) {
            var Art = win.GrowthArt;
            state.glanceData = f; renderGlance();
            var cmp = doc.getElementById('gaCompare');
            if (cmp) { cmp.innerHTML = '<thead><tr><th></th><th>Circle</th><th>Crew</th></tr></thead><tbody>' + compareRows(d).map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td data-label="Circle">' + esc(r[1]) + '</td><td data-label="Crew">' + esc(r[2]) + '</td></tr>'; }).join('') + '</tbody>'; var cs = doc.getElementById('gaCompareSec'); if (cs) cs.hidden = false; }
            var lad = doc.getElementById('gaLadder'), sc = (d.programs || {}).crew;
            if (lad && Art && sc && sc.ranks && sc.ranks.length) {
                lad.innerHTML = sc.ranks.map(function (r, i) { return '<li class="ga-rank"><div class="ga-medal">' + Art.medal(i, { size: 84 }) + '</div><b>' + esc(r.label) + '</b><span>' + esc(r.minCleared90d ? plural(r.minCleared90d, 'paid store') + ' in the last ' + plural(d.rankWindowDays || 0, 'day') : 'Where everyone starts') + '</span><em>' + esc(isNum(r.ratePercent) ? r.ratePercent + '% of month one' : '') + '</em></li>'; }).join('');
                var ls = doc.getElementById('gaLadderSec'); if (ls) ls.hidden = false;
            }
            buildCalc(d);
        }
        function buildCalc(d) {
            var box = doc.getElementById('gaCalc'); if (!box || !win.GrowthEconomics) return;
            var ranks = (((d.programs || {}).crew || {}).ranks) || [], Art = win.GrowthArt;
            var rank = ranks.length ? ranks[0].key : null;
            box.innerHTML = '<div class="ga-calc-in">' +
                (PROGRAM === 'crew' && ranks.length ? '<div class="ga-field"><span class="ga-label">Your rank</span><div class="ga-ranks" role="radiogroup" aria-label="Your rank">' + ranks.map(function (r, i) { return '<button type="button" role="radio" aria-checked="' + (i === 0) + '" data-rank="' + esc(r.key) + '" class="' + (i === 0 ? 'is-on' : '') + '">' + (Art ? Art.medal(i, { size: 30 }) : '') + '<span>' + esc(r.label) + '</span></button>'; }).join('') + '</div></div>' : '') +
                '<div class="ga-field"><label for="gaN">Stores you bring in each month: <b id="gaNv">5</b></label><input id="gaN" type="range" min="1" max="30" value="5"></div>' +
                '<div class="ga-field"><label for="gaR">Of those, renewing on time: <b id="gaRv">50%</b></label><input id="gaR" type="range" min="0" max="100" step="10" value="50"></div></div>' +
                '<div class="ga-calc-out" aria-live="polite" id="gaCalcOut"></div>';
            function draw() {
                var n = Number(doc.getElementById('gaN').value), r = Number(doc.getElementById('gaR').value) / 100;
                doc.getElementById('gaNv').textContent = n; doc.getElementById('gaRv').textContent = Math.round(r * 100) + '%';
                var e = estimate(d, PROGRAM === 'crew' ? 'crew' : 'circle', PROGRAM === 'crew' ? rank : null, n, r);
                doc.getElementById('gaCalcOut').innerHTML = '<div class="ga-total"><small>A month like this could bring</small><strong>' + esc(money(e.total)) + '</strong></div>' +
                    '<dl><div><dt>' + esc(plural(e.stores, 'store')) + ' paying, ' + esc(money(e.perStore)) + ' each</dt><dd>' + esc(money(e.first)) + '</dd></div><div><dt>' + esc(plural(e.renewals, 'on-time renewal')) + '</dt><dd>' + esc(money(e.renewal)) + '</dd></div></dl>' +
                    '<p>An illustration from today\'s rewards, not a promise. You are paid only when a store actually pays, and rewards clear first.</p>';
            }
            box.addEventListener('input', draw);
            box.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('[data-rank]'); if (!b) return;
                rank = b.getAttribute('data-rank');
                box.querySelectorAll('[data-rank]').forEach(function (x) { var on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on)); });
                draw();
            });
            draw();
            var cs = doc.getElementById('gaCalcSec'); if (cs) cs.hidden = false;
        }

        var rulesDone = getJson('/growth/rules').then(function (r) {
            if (!r.ok || !r.data) throw new Error('rules');
            var d = r.data, f = facts(d);
            Object.keys(f).forEach(function (k) { all('[data-f="' + k + '"]').forEach(function (n) { n.textContent = f[k]; }); });
            var pay = d.payouts || {}, mine = ((d.programs || {})[PROGRAM]) || {};
            if (pay.feeOnUs) {
                all('[data-fee]').forEach(function (n) { n.hidden = false; });
                all('[data-fee-title]').forEach(function (n) { n.textContent = 'We cover the fee'; });
            }
            if (pay.firstWithdrawalNeedsStore === false) all('[data-needs-store]').forEach(function (n) { n.hidden = true; });
            var s = (d.programs || {}).crew;
            var tb = doc.getElementById('gaRanks'); if (tb && s && s.ranks && s.ranks.length) tb.innerHTML = rankRows(s.ranks, d.rankWindowDays);
            enhance(d, f);
            state.open = mine.open === true ? true : (mine.open === false ? false : undefined);
        }).catch(function () { /* the plain wording stays, and the button stays a working link */ });

        var meDone = signedIn ? getJson('/growth/me', true).then(function (r) {
            if (r.ok && r.data && r.data.partner) {
                state.member = { program: r.data.partner.program, status: r.data.partner.status, upgrade: r.data.upgrade ? r.data.upgrade.state : undefined };
                writeCache(state.member);
            } else if (r.status === 401) { signedIn = false; state.member = null; writeCache(null); body.removeAttribute('data-member'); doc.documentElement.removeAttribute('data-session'); }   // the session is over: signed out
            else if (r.status === 404) { state.member = null; writeCache(null); }                  // signed in, not in any program: the Join button is right
            // anything else (server hiccup): keep the cached answer if we had one, otherwise fall through to the working Join link
        }).catch(function () { /* could not tell: a cached answer stays, otherwise the program page decides */ }) : Promise.resolve();
        // Never leave the button waiting: after 6 s it becomes the working link (the program page itself sends a member to their dashboard).
        var giveUp = win.setTimeout(function () { if (state.pending) { state.pending = false; paint(); } }, 6000);
        meDone.then(function () { state.pending = false; win.clearTimeout(giveUp); paint(); });

        Promise.all([rulesDone, meDone]).then(function () { state.pending = false; paint(); });
    }

    return { facts: facts, rankRows: rankRows, cta: cta, tokenOk: tokenOk, estimate: estimate, glance: glance, compareRows: compareRows, boot: boot };
});
