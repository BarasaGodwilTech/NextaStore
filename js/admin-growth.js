/**
 * Admin growth console. Each tab calls its own endpoint, so a Support Agent who only has
 * growth.view sees data but every action button fails with the server's own 403 message
 * (the server is the authority; the buttons are not the security).
 * Runs on the MAIN site (admin accounts and permissions live there). Needs growth-ui.js.
 */
(function () {
    'use strict';
    const root = document.getElementById('agRoot');
    const { esc, ugx, when, titleCase, toast, dialog, confirm, prompt, busy, keepScroll } = window.GrowthUI;
    const api = async (path, opts) => (await app.apiRequest(`/admin/growth${path}`, opts)).data;
    const send = (method, path, body) => api(path, { method, body: JSON.stringify(body || {}) });
    const act = (btn, fn) => busy(btn, fn);
    const programName = (p) => (p === 'scout' ? 'Crew' : 'Circle');
    const programMark = (p) => `<img src="/assets/growth-brand/svg/favicon-${p === 'scout' ? 'crew' : 'circle'}.svg" alt="" width="20" height="20" style="vertical-align:-5px;margin-right:4px">   `;
    let rules = null;
    const loadRules = async () => { if (!rules) rules = (await app.apiRequest('/growth/rules')).data; return rules; };

    const tabs = {
        async overview() {
            const [o, r] = await Promise.all([api('/overview'), loadRules()]);
            const count = (prog, st) => (o.partners.find((p) => p.program === prog && p.status === st)?._count._all) || 0;
            const stage = (s) => (o.referralsByStage.find((x) => x.stage === s)?._count._all) || 0;
            return `<div class="gp-grid">
                <section class="gp-card"><h2>${programMark('circle')}Partners</h2><p>Circle members: <b>${count('circle', 'active')}</b> active · Crew: <b>${count('scout', 'active')}</b> active, <b>${count('scout', 'frozen') + count('circle', 'frozen')}</b> frozen</p><p class="gp-muted">${o.pendingScoutApplications} Scout application${o.pendingScoutApplications === 1 ? '' : 's'} waiting. ${o.pendingScoutApplications ? '<a href="#scouts">Review them</a>' : ''}</p></section>
                <section class="gp-card"><h2>Payout queue</h2><p><b>${o.payoutQueue.count}</b> request${o.payoutQueue.count === 1 ? '' : 's'} · ${ugx(o.payoutQueue.amount)}</p><p class="${o.payoutQueue.overdue ? 'gp-error' : 'gp-muted'}">${o.payoutQueue.overdue ? `${o.payoutQueue.overdue} overdue past the ${r.payouts.payWithinWorkingDays}-working-day promise` : 'None overdue'} ${o.payoutQueue.count ? '<a href="#payouts">Open the queue</a>' : ''}</p></section>
                <section class="gp-card"><h2>Needs a human</h2><p><b>${o.commissionsInReview.count}</b> earning${o.commissionsInReview.count === 1 ? '' : 's'} in review (${ugx(o.commissionsInReview.amount)}) · <b>${o.openFlags}</b> open flag${o.openFlags === 1 ? '' : 's'}</p><p class="gp-muted"><a href="#review">Review queue</a> · <a href="#flags">Flags</a></p></section>
                <section class="gp-card"><h2>Funnel</h2><p class="gp-muted">Leads ${stage('lead')} → signed up ${stage('signed_up')} → live ${stage('store_live')} → payment pending ${stage('payment_pending')} → paid ${stage('paid')}<br>Lapsed ${stage('lapsed')} · blocked ${stage('blocked')}</p><p>We owe partners <b>${ugx(o.totalOwedToPartners)}</b> across held, cleared and in-review earnings.</p></section></div>`;
        },

        async economics() {
            const [e, r] = await Promise.all([api('/economics'), loadRules()]);
            const tone = { good: 'tone-good', warn: 'tone-warn', alert: 'tone-bad', none: 'tone-muted' };
            const words = { good: 'Healthy', warn: 'Watch this', alert: 'Too high: act now', none: 'No data yet' };
            const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
            const block = (title, v) => `<section class="gp-card"><div class="gp-spread"><h2>${esc(title)}</h2><span class="gp-chip ${tone[v.all.status]}">${esc(v.all.ratio === null && v.all.cost > 0 ? 'Check: rewards but no revenue counted' : words[v.all.status])}</span></div>
                <div class="gp-money"><div class="is-main"><small>Cost of the program</small><strong>${pct(v.all.ratio)}</strong></div><div><small>Seller Pass revenue from referred stores</small><strong>${ugx(v.all.revenue)}</strong></div><div><small>We keep (before other costs)</small><strong>${ugx(v.all.kept)}</strong></div></div>
                <div class="gp-scroll"><table class="gp-table" style="margin-top:12px"><thead><tr><th></th><th>Rewards</th><th>Mobile money fees</th><th>Revenue</th><th>Cost %</th><th>Paid stores</th><th>Cost per paid store</th></tr></thead><tbody>${['all', 'circle', 'scout'].map((k) => { const x = v[k]; return `<tr><td data-label="">${k === 'all' ? '<b>All</b>' : esc(programName(k))}</td><td data-label="Rewards">${ugx(x.rewards)}</td><td data-label="Fees">${ugx(x.fees)}</td><td data-label="Revenue">${ugx(x.revenue)}</td><td data-label="Cost %">${pct(x.ratio)}</td><td data-label="Paid stores">${x.storesPaid}</td><td data-label="Per store">${x.costPerPaidStore === null ? 'n/a' : ugx(x.costPerPaidStore)}</td></tr>`; }).join('')}</tbody></table></div></section>`;
            return `<section class="gp-card"><h2>Is the program worth it?</h2><p class="gp-muted">Cost = rewards earned plus the mobile money fees NextaStore pays on payouts, as a share of the Seller Pass revenue the referred stores brought in. Amber from ${Math.round(e.warnAt * 100)}%, red from ${Math.round(e.alertAt * 100)}%. This counts Seller Pass revenue only, so it is revenue kept, not profit. Rewards on a first payment can never exceed ${r.maxUpfrontPercent}% of what the store paid, and stay bonuses are only paid once a store comes back.</p>
                ${e.fees.note ? `<p class="gp-error">${esc(e.fees.note)} Enter the real fee when you mark a payout paid.</p>` : ''}</section>
                ${block(`Last ${e.windowDays} days`, e.window)}${block('Since the program began', e.lifetime)}`;
        },

        async payouts() {
            const rows = await api('/withdrawals');
            if (!rows.length) return '<section class="gp-card"><h2>Payouts</h2><div class="gp-empty"><i class="fas fa-circle-check" aria-hidden="true"></i>Nothing waiting.</div></section>';
            return `<section class="gp-card"><h2>Payout queue (oldest deadline first)</h2><div class="gp-scroll"><table class="gp-table"><thead><tr><th>Partner</th><th>Amount</th><th>Pay to</th><th>Due by</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((w) => `<tr>
                <td data-label="Partner"><b>${programMark(w.partner.program)}${esc(w.partner.displayName)}</b><br><span class="gp-muted">${esc(w.partner.code)}</span></td>
                <td data-label="Amount"><b>${ugx(w.amount)}</b>${w.needsSecondApproval ? '<br><span class="gp-chip tone-warn">two admins</span>' : ''}</td>
                <td data-label="Pay to">${w.network === 'mtnMomo' ? 'MTN' : 'Airtel'} ${esc(w.payoutNumber)}<br><span class="gp-muted">${esc(w.payoutName)}</span></td>
                <td data-label="Due by" class="${w.overdue ? 'gp-error' : ''}">${esc(w.dueByText)}${w.overdue ? ' (overdue)' : ''}</td>
                <td data-label="Status"><span class="gp-chip ${w.overdue ? 'tone-bad' : ''}">${esc(titleCase(w.status))}</span></td>
                <td><button class="gp-btn is-small is-primary" data-open="${esc(w.id)}">Open</button></td></tr>`).join('')}</tbody></table></div></section>`;
        },

        async review() {
            const rows = await api('/review-queue');
            if (!rows.length) return '<section class="gp-card"><h2>Earnings in review</h2><div class="gp-empty"><i class="fas fa-circle-check" aria-hidden="true"></i>Nothing held. Anything the fraud checks are unsure about lands here.</div></section>';
            return `<section class="gp-card"><h2>Earnings held for review</h2>${rows.map((c) => `<article class="gp-recruit"><div class="gp-recruit-head"><strong>${esc(c.partner?.displayName)} · ${esc(c.partner?.code)}</strong><span class="gp-earn">${ugx(c.amount)} (${esc(titleCase(c.type))})</span></div>
                <p class="gp-reason">Risk score ${c.riskScore}. ${(c.riskReasons || []).map(esc).join(' ') || 'Held because the partner account is frozen.'}</p>
                <div class="gp-row"><button class="gp-btn is-small is-primary" data-release="${esc(c.id)}">Release</button><button class="gp-btn is-small is-danger" data-void="${esc(c.id)}">Void</button><span class="gp-muted">Payment approved by ${esc(c.paymentReviewedBy || 'unknown')} (cannot be the releaser)</span></div></article>`).join('')}</section>`;
        },

        async crew() {
            const rows = await api('/partners?program=scout&status=applied');
            if (!rows.length) return '<section class="gp-card"><h2>Crew applications</h2><div class="gp-empty"><i class="fas fa-circle-check" aria-hidden="true"></i>No one waiting.</div></section>';
            return `<section class="gp-card"><h2>Crew applications</h2>${rows.map((p) => `<article class="gp-recruit"><div class="gp-recruit-head"><strong>${esc(p.displayName)}</strong><span class="gp-muted">${esc(p.phone)} · ${p.territories.map((t) => esc(titleCase(t))).join(', ')}</span></div>
                <div class="gp-row"><button class="gp-btn is-small" data-kyc="${esc(p.id)}"><i class="fas fa-id-card" aria-hidden="true"></i> View ID</button><button class="gp-btn is-small" data-detail="${esc(p.id)}">Details</button><button class="gp-btn is-small is-primary" data-approve="${esc(p.id)}">Approve</button><button class="gp-btn is-small is-danger" data-reject="${esc(p.id)}">Decline</button></div></article>`).join('')}</section>`;
        },

        async partners() {
            const rows = await api('/partners');
            return `<section class="gp-card"><div class="gp-spread"><h2>All partners</h2><div class="gp-field" style="min-width:220px"><label class="gp-sr" for="agFind">Find a partner</label><input id="agFind" type="search" placeholder="Find by name or code" autocomplete="off"></div></div>
                <div class="gp-scroll"><table class="gp-table" id="agPartnerTable"><thead><tr><th>Name</th><th>Program</th><th>Status</th><th>Quality</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr data-find="${esc((p.displayName + ' ' + p.code).toLowerCase())}">
                <td data-label="Name"><b>${esc(p.displayName)}</b><br><span class="gp-muted">${esc(p.code)}</span></td><td data-label="Program">${programMark(p.program)}${esc(programName(p.program))}${p.program === 'scout' ? ' · ' + esc(titleCase(p.rankKey)) : ''}</td>
                <td data-label="Status"><span class="gp-chip ${p.status === 'frozen' ? 'tone-warn' : p.status === 'active' ? 'tone-good' : ''}">${esc(titleCase(p.status))}</span></td><td data-label="Quality">${p.qualityScore}</td>
                <td><button class="gp-btn is-small" data-detail="${esc(p.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="gp-empty">No partners yet.</div>'}</section>`;
        },

        async flags() {
            const rows = await api('/flags');
            if (!rows.length) return '<section class="gp-card"><h2>Flags</h2><div class="gp-empty"><i class="fas fa-circle-check" aria-hidden="true"></i>No open flags.</div></section>';
            const detail = (d) => (d && typeof d === 'object' ? Object.entries(d).map(([k, v]) => `<b>${esc(titleCase(k))}:</b> ${esc(Array.isArray(v) ? v.join('; ') : typeof v === 'object' && v ? JSON.stringify(v) : v)}`).join(' · ') : esc(d));
            return `<section class="gp-card"><h2>Open flags</h2>${rows.map((f) => `<article class="gp-recruit"><div class="gp-recruit-head"><strong>${esc(titleCase(f.code))}</strong><span class="gp-chip tone-${f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'muted'}">${esc(f.severity)}</span></div>
                <p class="gp-reason">${esc(f.partner.displayName)} (${esc(f.partner.code)}) · ${esc(when(f.createdAt))}</p><p class="gp-next">${detail(f.detail)}</p>
                <div class="gp-row"><button class="gp-btn is-small" data-flag="${esc(f.id)}" data-outcome="dismissed">Dismiss</button><button class="gp-btn is-small is-danger" data-flag="${esc(f.id)}" data-outcome="confirmed">Confirm</button><button class="gp-btn is-small" data-detail="${esc(f.partner.id)}">Partner</button></div></article>`).join('')}</section>`;
        },

        async campaigns() {
            const [rows, settings] = await Promise.all([api('/campaigns'), api('/settings')]);
            const now = Date.now();
            return `<div class="gp-grid"><section class="gp-card"><h2>Campaigns</h2>${rows.length ? rows.map((c) => { const live = c.isActive && new Date(c.startsAt) <= now && new Date(c.endsAt) >= now; return `<div class="gp-recruit"><div class="gp-recruit-head"><strong>${esc(c.title)}</strong><span class="gp-chip ${live ? 'tone-good' : ''}">${live ? 'Live' : c.isActive ? 'Scheduled/ended' : 'Stopped'}</span></div><p class="gp-reason">+${c.boostPercent}% on the main commission · ${esc(c.district ? titleCase(c.district) : 'everywhere')} · ${esc(c.program ? programName(c.program) : 'both programs')}<br>${esc(when(c.startsAt))} to ${esc(when(c.endsAt))}</p>${c.isActive ? `<button class="gp-btn is-small" data-endcamp="${esc(c.id)}">Stop</button>` : ''}</div>`; }).join('') : '<div class="gp-empty">None yet.</div>'}</section>
                <section class="gp-card"><h2>New campaign</h2><form class="gp-form" id="agCamp"><div class="gp-field"><label for="cTitle">Name</label><input id="cTitle" maxlength="80" placeholder="Kampala Market Week" required></div><div class="gp-field"><label for="cBoost">Boost % (0 to 50)</label><input id="cBoost" type="number" min="0" max="50" value="20"></div>
                <div class="gp-field"><label for="cStart">Starts</label><input id="cStart" type="datetime-local" required></div><div class="gp-field"><label for="cEnd">Ends</label><input id="cEnd" type="datetime-local" required></div>
                <div class="gp-field"><label for="cProg">Program</label><select id="cProg"><option value="">Both</option><option value="circle">Circle</option><option value="scout">Crew</option></select></div><div class="gp-field"><label for="cDist">District (blank = everywhere)</label><input id="cDist" placeholder="kampala"></div><div class="gp-error" id="cErr" role="alert"></div><button class="gp-btn is-primary" type="submit">Create</button></form>
                <p class="gp-muted" style="margin-top:8px">A boost applies to stores whose first payment is approved while it is live. Boosts never stack: the highest one wins.</p></section>
                <section class="gp-card"><h2>Program settings</h2><label class="gp-check"><input type="checkbox" id="sCircle" ${settings.circleOpen ? 'checked' : ''}> <span>NextaStore Circle accepts new members</span></label><label class="gp-check" style="margin-top:8px"><input type="checkbox" id="sCrew" ${settings.scoutsOpen ? 'checked' : ''}> <span>NextaStore Crew accepts applications</span></label>
                <div class="gp-field" style="margin-top:12px"><label for="sHol">Extra public holidays (YYYY-MM-DD, comma separated). Add Eid dates when announced.</label><input id="sHol" value="${esc((settings.extraHolidays || []).join(', '))}"></div><button class="gp-btn is-primary" id="sSave" style="margin-top:8px">Save settings</button></section></div>`;
        }
    };

    // View a Crew member's ID photo. A new browser tab cannot send the sign-in header, so fetch it here and show the picture.
    async function viewKyc(id) {
        const win = window.open('', '_blank');                      // opened first so the browser does not block it as a popup
        try {
            const token = localStorage.getItem('nextastore_token');
            const res = await fetch(`/api/admin/growth/partners/${encodeURIComponent(id)}/kyc`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
            const type = res.headers.get('content-type') || '';
            if (!res.ok) { let m = 'Could not open the ID.'; try { m = (await res.json()).message || m; } catch (e) { /* not JSON */ } throw new Error(m); }
            if (!type.startsWith('image/') && !type.includes('pdf')) throw new Error('The ID is on file, but this server did not send it as a picture. Check sendKyc in the integration guide.');
            const url = URL.createObjectURL(await res.blob());
            if (win) { win.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); } else toast('Allow pop-ups to see the ID.');
        } catch (err) { if (win) win.close(); throw err; }
    }

    function wire() {
        const q = (sel, fn) => root.querySelectorAll(sel).forEach(fn);
        q('[data-open]', (b) => b.onclick = () => openPayout(b.dataset.open));
        q('[data-release]', (b) => b.onclick = () => act(b, async () => { await send('PUT', `/commissions/${b.dataset.release}/release`); toast('Released. The normal clearing window starts now.'); await reload(); }));
        q('[data-void]', (b) => b.onclick = async () => { const r = await prompt({ title: 'Void this earning', body: 'The partner will not be paid for it.', label: 'Why is this earning being voided?', ok: 'Void it', danger: true, minLength: 5 }); if (r) act(b, async () => { await send('PUT', `/commissions/${b.dataset.void}/void`, { reason: r }); await reload(); }); });
        q('[data-approve]', (b) => b.onclick = () => act(b, async () => { await send('PUT', `/scouts/${b.dataset.approve}/approve`); toast('Crew member approved.'); await reload(); }));
        q('[data-reject]', (b) => b.onclick = async () => { const r = await prompt({ title: 'Decline this application', body: 'The applicant will read your reason, so keep it short and kind.', label: 'Reason', ok: 'Decline', danger: true, multiline: true, minLength: 5 }); if (r) act(b, async () => { await send('PUT', `/scouts/${b.dataset.reject}/reject`, { reason: r }); await reload(); }); });
        q('[data-kyc]', (b) => b.onclick = () => act(b, () => viewKyc(b.dataset.kyc)));
        q('[data-flag]', (b) => b.onclick = async () => { const n = await prompt({ title: b.dataset.outcome === 'confirmed' ? 'Confirm this flag' : 'Dismiss this flag', label: 'Note (optional)', ok: 'Save', required: false }); if (n !== null) act(b, async () => { await send('PUT', `/flags/${b.dataset.flag}`, { outcome: b.dataset.outcome, note: n }); await reload(); }); });
        q('[data-detail]', (b) => b.onclick = () => openPartner(b.dataset.detail));
        q('[data-endcamp]', (b) => b.onclick = () => act(b, async () => { await send('PUT', `/campaigns/${b.dataset.endcamp}/end`); await reload(); }));
        const find = document.getElementById('agFind');
        find?.addEventListener('input', () => { const t = find.value.trim().toLowerCase(); document.querySelectorAll('#agPartnerTable tbody tr').forEach((tr) => { tr.hidden = !!t && !tr.dataset.find.includes(t); }); });
        document.getElementById('agCamp')?.addEventListener('submit', (e) => { e.preventDefault(); const err = document.getElementById('cErr'); err.textContent = '';
            const starts = new Date(document.getElementById('cStart').value), ends = new Date(document.getElementById('cEnd').value);
            if (!(ends > starts)) { err.textContent = 'The end must be after the start.'; return; }
            act(e.target.querySelector('button'), async () => {
                await send('POST', '/campaigns', { title: document.getElementById('cTitle').value, boostPercent: Number(document.getElementById('cBoost').value), startsAt: starts.toISOString(), endsAt: ends.toISOString(), program: document.getElementById('cProg').value || null, district: document.getElementById('cDist').value });
                toast('Campaign created.'); await reload();
            }); });
        document.getElementById('sSave')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
            await send('PUT', '/settings', { circleOpen: document.getElementById('sCircle').checked, scoutsOpen: document.getElementById("sCrew").checked, extraHolidays: document.getElementById('sHol').value.split(',').map((s) => s.trim()).filter(Boolean) }); toast('Saved.'); }));
    }

    async function openPayout(id) {
        const r = await api(`/withdrawals/${id}`).catch((e) => { toast(e.message); return null; }); if (!r) return;
        const w = r.withdrawal, p = w.partner;
        const d = dialog(`<h2>${ugx(w.amount)} to ${w.network === 'mtnMomo' ? 'MTN' : 'Airtel'} ${esc(w.payoutNumber)}</h2>
            <p class="gp-muted">${esc(p.displayName)} (${esc(p.code)}) · registered name <b>${esc(w.payoutName)}</b>. Check the name matches before paying.</p>
            ${r.openFlags.length ? `<p class="gp-error">${r.openFlags.length} open flag(s): ${r.openFlags.map((f) => esc(titleCase(f.code))).join(', ')}. Look at the partner before paying.</p>` : ''}
            <p class="gp-muted">NextaStore pays the mobile money fee on this payout (planning estimate ${ugx(w.feeEstimate)}). Enter the real fee when you mark it paid so the Economics tab shows true cost.</p>
            <p class="gp-muted">Cleared balance after this request: ${ugx(r.balances.available)} · lifetime paid ${ugx(r.balances.paid)} · ${w.needsSecondApproval ? 'First or large payout: a different admin must approve and pay it.' : 'One admin can approve and pay.'}</p>
            <h3>Recent earnings</h3>${r.recentEarnings.map((c) => `<div class="gp-muted">${esc(when(c.createdAt))} · ${esc(titleCase(c.type))} · ${ugx(c.amount)} · ${esc(c.status)}</div>`).join('') || '<div class="gp-muted">None</div>'}
            <div class="gp-form" style="margin-top:14px">${w.status === 'approved' ? '<div class="gp-field"><label for="pRef">MoMo transaction ID you paid with</label><input id="pRef" autocomplete="off"></div><div class="gp-field"><label for="pFee">Fee you paid (UGX, optional)</label><input id="pFee" type="number" min="0" max="50000" step="1" inputmode="numeric"></div>' : ''}
            <div class="gp-row gp-row-end">${['requested', 'in_review'].includes(w.status) ? '<button class="gp-btn is-primary" id="pApprove">Approve</button>' : ''}
            ${w.status === 'approved' ? '<button class="gp-btn is-primary" id="pPaid">Mark paid</button>' : ''}
            <button class="gp-btn is-danger" id="pReject">Reject</button><button class="gp-btn" id="pClose">Close</button></div></div>`, { label: 'Payout', wide: true });
        d.querySelector('#pClose').onclick = () => d.close();
        d.querySelector('#pApprove')?.addEventListener('click', (e) => act(e.currentTarget, async () => { await send('PUT', `/withdrawals/${id}/approve`); d.close(); toast('Approved. Send the money, then mark it paid.'); await reload(); }));
        d.querySelector('#pPaid')?.addEventListener('click', (e) => act(e.currentTarget, async () => { await send('PUT', `/withdrawals/${id}/paid`, { reference: d.querySelector('#pRef').value, fee: d.querySelector('#pFee').value === '' ? undefined : Number(d.querySelector('#pFee').value) }); d.close(); toast('Marked paid. The partner was told.'); await reload(); }));
        d.querySelector('#pReject').onclick = async (e) => { const btn = e.currentTarget; const why = await prompt({ title: 'Reject this withdrawal', body: 'The money goes back to their balance and they will read your reason.', label: 'Reason the partner will see', ok: 'Reject', danger: true, multiline: true, minLength: 5 }); if (why) act(btn, async () => { await send('PUT', `/withdrawals/${id}/reject`, { reason: why }); d.close(); await reload(); }); };
    }

    async function openPartner(id) {
        const r = await api(`/partners/${id}`).catch((e) => { toast(e.message); return null; }); if (!r) return;
        const p = r.partner;
        const d = dialog(`<h2>${programMark(p.program)}${esc(p.displayName)} · ${esc(programName(p.program))}</h2><p class="gp-muted">${esc(p.code)} · ${esc(r.user?.email)} · ${esc(p.phone)} · joined ${esc(when(p.joinedAt))} · status <b>${esc(p.status)}</b>${p.frozenReason ? ' (' + esc(p.frozenReason) + ')' : ''}</p>
            <p>Available ${ugx(r.balances.available)} · clearing ${ugx(r.balances.pending)} · paid ${ugx(r.balances.paid)} · quality ${p.qualityScore} · cleared stores ${r.stats.cleared} · reversed ${r.stats.reversed} · flagged ${r.stats.flagged}</p>
            <h3>Recruits</h3>${r.referrals.slice(0, 15).map((x) => `<div class="gp-muted">${esc(titleCase(x.stage))} · risk ${x.riskScore} ${esc((x.riskReasons || []).join(' '))}</div>`).join('') || '<div class="gp-muted">None</div>'}
            <div class="gp-row gp-row-end" style="margin-top:14px">${p.status === 'frozen' ? '<button class="gp-btn is-primary" id="dUnfreeze">Unfreeze</button>' : (p.status === 'active' ? '<button class="gp-btn is-danger" id="dFreeze">Freeze</button>' : '')}<button class="gp-btn" id="dClose">Close</button></div>`, { label: 'Partner', wide: true });
        d.querySelector('#dClose').onclick = () => d.close();
        d.querySelector('#dFreeze')?.addEventListener('click', async (e) => { const btn = e.currentTarget; const why = await prompt({ title: 'Freeze this account', body: 'Withdrawals stop and new earnings are held for review.', label: 'Why are you freezing this account?', ok: 'Freeze', danger: true, minLength: 5 }); if (why) act(btn, async () => { await send('PUT', `/partners/${id}/freeze`, { reason: why }); d.close(); await reload(); }); });
        d.querySelector('#dUnfreeze')?.addEventListener('click', (e) => act(e.currentTarget, async () => { await send('PUT', `/partners/${id}/unfreeze`); d.close(); await reload(); }));
    }

    // ---- tab badges: how many things are waiting, so the admin sees it before opening anything
    async function badges() {
        try {
            const o = await api('/overview');
            const set = (k, n) => { const el = document.querySelector(`[data-count="${k}"]`); if (el) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n; } };
            set('payouts', o.payoutQueue.count); set('review', o.commissionsInReview.count); set('crew', o.pendingScoutApplications); set('flags', o.openFlags);
        } catch (e) { /* the tabs work without the badges */ }
    }

    let current = 'overview';
    async function load({ soft = false } = {}) {
        const name = (location.hash || '#overview').slice(1);
        const tab = tabs[name] ? name : 'overview';
        document.querySelectorAll('#agTabs a').forEach((a) => { const on = a.dataset.tab === tab; a.classList.toggle('is-active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
        const y = window.scrollY;
        if (!soft || tab !== current) root.innerHTML = '<div class="gp-skel"></div>';
        current = tab;
        try { root.innerHTML = await tabs[tab](); wire(); }
        catch (e) { root.innerHTML = `<section class="gp-card"><h2>Cannot show this</h2><p class="gp-muted">${esc(e.message)}</p><button class="gp-btn" id="agRetry">Try again</button></section>`; document.getElementById('agRetry').onclick = () => load(); }
        if (soft) window.scrollTo(0, y); else if (!soft) window.scrollTo(0, 0);
        badges();
        window.NextaLoader?.ready?.('page');
    }
    const reload = () => load({ soft: true });
    window.addEventListener('hashchange', () => load());
    load();
})();
