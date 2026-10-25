/* Fills the public Circle/Crew about pages with the LIVE numbers from GET /api/growth/rules (nothing about money is hard-coded),
   shows whether the program is open, and points the buttons at the right place. If the numbers can't load, the generic wording stays. */
(function () {
    'use strict';
    var PROGRAM = document.body.dataset.program === 'scout' ? 'scout' : 'circle';
    var H = window.NextaHosts;
    var ugx = function (n) { return 'UGX ' + Number(n).toLocaleString('en-UG'); };
    var el = function (sel) { return document.querySelectorAll(sel); };
    function set(key, text) { el('[data-f="' + key + '"]').forEach(function (n) { n.textContent = text; }); }

    // Where "Join" goes: the program's own page (go=1 tells it to continue to sign-in instead of coming back here).
    var signedIn = false;
    try { var t = localStorage.getItem('nextastore_token'); signedIn = !!t && t.split('.').length === 3; } catch (e) { /* storage blocked */ }
    el('[data-join]').forEach(function (a) {
        var which = a.getAttribute('data-join');
        a.href = (H ? H.program(which) : '/' + (which === 'scout' ? 'crew' : 'circle')) + '?go=1';
        if (signedIn && a.hasAttribute('data-join-main')) a.querySelector('span').textContent = a.getAttribute('data-join-signed');
    });
    if (H && H.rewriteLinks) { H.rewriteLinks(document); if (H.watch) H.watch(); }

    fetch('/api/growth/rules', { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
        var p = d.programs || {}, c = p.circle || {}, s = p.scout || {}, pay = d.payouts || {}, mine = PROGRAM === 'scout' ? s : c;
        set('pass', ugx(d.passPricePerMonth)); set('trial', d.trialDays + ' days'); set('kickerMonths', d.kickerMinMonths + ' months');
        set('qualDays', d.qualifyingWindowDays + ' days'); set('capPct', d.maxUpfrontPercent + '%');
        set('minWd', ugx(pay.minWithdrawal)); set('clearDays', pay.clearanceDays + ' days'); set('payDays', pay.payWithinWorkingDays + ' working days'); set('firstWd', pay.firstWithdrawalAfterDays + ' days');
        set('lateClaim', d.lateClaimDays + ' days');
        if (pay.feeOnUs) el('[data-fee]').forEach(function (n) { n.hidden = false; });
        if (c.commissionPercent != null) { set('c.pct', c.commissionPercent + '%'); set('c.first', ugx(c.firstMonth)); set('c.kicker', ugx(c.commitmentKicker)); set('c.stay', ugx(c.stayBonus)); set('c.stayTotal', ugx(c.firstMonth + c.stayBonus)); }
        if (s.ranks) {
            set('s.kicker', ugx(s.commitmentKicker)); set('s.stay', ugx(s.stayBonus)); set('s.stocked', ugx(s.stockedBonus)); set('s.areas', String(s.maxTerritories));
            set('s.rateRange', s.ranks[0].ratePercent + '% to ' + s.ranks[s.ranks.length - 1].ratePercent + '%');
            var tb = document.getElementById('gaRanks');
            if (tb) tb.innerHTML = s.ranks.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td>' + (r.minCleared90d ? r.minCleared90d + ' paid stores' : 'Where everyone starts') + '</td><td>' + r.ratePercent + '% (' + ugx(r.firstMonth) + ')</td></tr>'; }).join('');
        }
        var l = d.lead || {}; if (l.lockDays) { set('lockDays', l.lockDays + ' days'); set('lockExtend', l.extendDays + ' days'); set('lockMax', String(l.maxExtensions)); }
        if (d.offlineLeadMaxAgeHours) set('offlineHrs', d.offlineLeadMaxAgeHours + ' hours');
        var open = mine.open === true;
        el('[data-status]').forEach(function (n) { n.textContent = open ? (PROGRAM === 'scout' ? 'Applications are open' : 'Open to join') : 'Not open yet'; });
        if (!open) el('[data-join]').forEach(function (a) { var sp = a.querySelector('span'); if (sp) sp.textContent = 'Not open yet'; a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); });
    }).catch(function () { /* generic wording stays */ });
    function esc(x) { return String(x).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
})();
