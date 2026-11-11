/**
 * The page a shop owner lands on from a shared link or a scanned QR:
 *   /invite?ref=CREW-4HTR9   or the short   /i/CREW-4HTR9
 * It says who invited them, what NextaStore is, and sends them to sign up on the MAIN site with the code
 * carried in the link. If the code is missing or wrong the page still works as a friendly "open your shop" page.
 * Always the Circle colourway (the invitee is joining NextaStore, not the field team).
 */
(function () {
    'use strict';
    const root = document.getElementById('gpInvite');
    const { esc, ugx } = window.GrowthUI;
    const H = window.NextaHosts;
    const api = async (path) => (await app.apiRequest(path)).data;

    async function boot() {
        const stored = window.NextaRef && window.NextaRef.get();
        const code = stored && stored.code;
        let rules = null, who = null, unknown = false;
        try { rules = await api('/growth/rules'); } catch (err) { /* the page still works without numbers */ }
        if (code) {
            try { const r = await api(`/growth/resolve/${encodeURIComponent(code)}`); if (r.valid) who = r; else unknown = true; } catch (err) { /* offline or unknown: carry on as a plain invite */ }
        }

        const trial = rules && rules.trialDays;
        const price = rules && rules.passPricePerMonth;
        // Everyone who lands here came to open a shop, so the sign-up page opens with "Sell" already chosen: after confirming their email they go
        // straight to setting up the store. The code rides along when there is one.
        const target = H.main('/signup') + '?type=seller' + (who ? `&ref=${encodeURIComponent(code)}` : '');
        const kind = who && who.program === 'crew' ? 'a NextaStore Crew member' : 'a NextaStore member';
        const freeLine = trial ? `Free for ${trial} days.` : 'Free to start.';
        const priceLine = trial && price ? `The first ${trial} days are free; after that a Seller Pass is ${ugx(price)} a month, paid by MTN or Airtel.` : 'Choose a Seller Pass when you are ready, paid by MTN or Airtel.';
        document.title = who ? `${who.firstName} invited you to open your shop · NextaStore` : document.title;
        root.innerHTML = `
            <section class="gp-hero"><img class="gp-hero-mark" src="/assets/growth-brand/svg/mark-circle.svg" alt="" width="84" height="84">
                <span class="gp-kicker"><i class="fas fa-envelope-open-text" aria-hidden="true"></i> ${who ? `${esc(who.firstName)} invited you` : 'You are invited'}</span>
                <h1>Open your shop online.<br>${esc(freeLine)}</h1>
                <p>${who ? `${esc(who.firstName)}, ${kind}, thinks your business belongs on NextaStore. ` : ''}Put your products and prices in one link, share it with every customer, and let them message you and order.</p>
                <div class="gp-code"><a class="gp-btn is-primary is-big" id="gpGo" href="${esc(target)}"><i class="fas fa-store" aria-hidden="true"></i> Open my free shop</a>
                ${who ? `<span class="gp-code-chip" title="Your invite code">${esc(code)}</span>` : ''}</div>
            </section>
            ${unknown ? '<section class="gp-needs is-info" role="status"><i class="fas fa-circle-info" aria-hidden="true"></i> We could not match that invite code, but you can still open your shop below.</section>' : ''}
            <section class="gp-perks">
                <div class="gp-card gp-perk"><i class="fas fa-link" aria-hidden="true"></i><div><h3>One link for your shop</h3><p class="gp-muted">Stop re-sending photos and prices. Customers open your link and see everything.</p></div></div>
                <div class="gp-card gp-perk"><i class="fas fa-comments" aria-hidden="true"></i><div><h3>Customers can message you</h3><p class="gp-muted">Questions and orders reach you inside NextaStore, so nothing gets lost in a busy chat.</p></div></div>
                <div class="gp-card gp-perk"><i class="fas fa-mobile-screen" aria-hidden="true"></i><div><h3>Made for your phone</h3><p class="gp-muted">Set it up in about ten minutes, and keep it up to date from your phone.</p></div></div>
            </section>
            <section class="gp-card"><h2>How it works</h2><ol class="gp-steps">
                <li>Create your account and give your shop a name.</li>
                <li>Add your first three products with photos and prices.</li>
                <li>Launch, then share your shop link in your WhatsApp status. ${esc(priceLine)}</li></ol>
                ${who ? '<p class="gp-muted" style="margin-top:12px">Your invite code is added automatically, so the person who invited you can help you set up.</p>' : ''}</section>`;
        window.NextaLoader?.ready?.('page');
    }
    boot();
})();
