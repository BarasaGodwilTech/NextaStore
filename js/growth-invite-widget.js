/**
 * A drop-in card for the SELLER dashboard (or any signed-in page of the main site): "Know another seller? Invite them."
 * Sellers are the best advocates NextaStore has, and most never see the Circle page. This puts it in front of them.
 *
 *   <div data-growth-invite></div>
 *   <script src="/js/growth-hosts.js"></script><script src="/js/growth-ui.js"></script>
 *   <script src="/js/growth-qr.js"></script><script src="/js/growth-kit.js"></script><script src="/js/growth-invite-widget.js"></script>
 *   (plus css/growth.css)
 *
 * It shows "Join NextaStore Circle" to someone who has not joined, and their code with share buttons plus what
 * needs them today to someone who has. It needs only GET /api/growth/me/summary and GET /api/growth/rules.
 * The links it shows come from the server's host settings (rules.hosts), so it points at circle./crew.
 * when subdomains are on, even though this page itself lives on the main site.
 */
(function () {
    'use strict';
    const host = document.querySelector('[data-growth-invite]');
    // main.js declares `const app`, which is a global binding but NOT a property of window, so test it with typeof.
    if (!host || typeof app === 'undefined') return;
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ugx = (n) => `UGX ${Number(n || 0).toLocaleString('en-UG')}`;
    const api = async (path) => (await app.apiRequest(path)).data;

    async function boot() {
        let s, rules;
        try { [s, rules] = await Promise.all([api('/growth/me/summary'), api('/growth/rules')]); }
        catch (err) { host.hidden = true; return; } // never get in the way of the dashboard
        const H = window.NextaHosts ? window.NextaHosts.create(rules.hosts, window.location) : null;
        const circlePage = H ? H.program('circle') : '/circle';
        const circle = rules.programs.circle;
        if (!s.joined) {
            if (!s.open.circle) { host.hidden = true; return; }
            host.innerHTML = `<section class="gp-card"><span class="gp-kicker"><i class="fas fa-circle-nodes" aria-hidden="true"></i> NextaStore Circle · Affiliate Program</span>
                <h3 style="margin-top:8px">Know another seller? Invite them and earn.</h3>
                <p class="gp-muted">When a store you invite pays for its Seller Pass and we approve it, you earn ${circle.commissionPercent}% of their first month (${ugx(circle.firstMonth)}), plus bonuses.</p>
                <a class="gp-btn is-primary" data-local href="${esc(circlePage)}">Get my invite code</a></section>`;
            return;
        }
        if (s.status !== 'active' && s.status !== 'frozen') { host.hidden = true; return; }
        const page = H ? H.program(s.program === 'crew' ? 'crew' : 'circle') : (s.program === 'crew' ? '/crew' : '/circle');
        const link = H ? H.invite(s.code) : `${location.origin}/invite?ref=${encodeURIComponent(s.code)}`;
        const text = `Open your own online shop on NextaStore, free for ${rules.trialDays} days: ${link}`;
        host.innerHTML = `<section class="gp-card"><div class="gp-spread"><div><span class="gp-kicker"><i class="fas fa-circle-nodes" aria-hidden="true"></i> Your invite code</span>
            <h3 style="margin-top:8px"><span class="gp-code-chip" style="background:var(--gp-accent-soft);border-color:var(--gp-accent-ink);color:var(--gp-accent-ink);font-size:1rem">${esc(s.code)}</span></h3></div>
            <a class="gp-btn is-small" data-local href="${esc(page)}">Open dashboard${s.needsYou ? ` (${s.needsYou} need you)` : ''}</a></div>
            <p class="gp-muted">${s.available ? `You have ${ugx(s.available)} ready to withdraw. ` : ''}${s.recruits ? `${s.recruits} recruit${s.recruits === 1 ? '' : 's'} so far.` : 'Share your link with another seller to get started.'}</p>
            <div class="gp-row"><button class="gp-btn is-small" id="gpWCopy"><i class="fas fa-copy" aria-hidden="true"></i> Copy link</button>
            <a class="gp-btn is-small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}"><i class="fab fa-whatsapp" aria-hidden="true"></i> WhatsApp</a></div></section>`;
        host.querySelector('#gpWCopy').onclick = async (e) => { try { await navigator.clipboard.writeText(link); e.currentTarget.textContent = 'Copied'; } catch (err) { e.currentTarget.textContent = link; } };
    }
    boot();
})();
