/**
 * Admin insight helpers. Pure functions over plain rows (no database, no clock they did not receive), so every rule here
 * is covered by scripts/growth-admin-test.js without a database.
 *
 *   securityFindings(rows)   who looks like more than one person, who is paying themselves, who shares a payout number
 *   observedRates(rows)      what the program actually did: renewal rate, reversal rate, time to first payment
 *   toCsv(rows, columns)     a spreadsheet export that cannot be turned into a formula
 */
'use strict';

const R = require('./rules');

const DAY = 86400000;

/** Uganda numbers arrive as 0772..., +256772..., 256772... : compare on the last nine digits. */
const phoneKey = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

function groupBy(items, keyFn) {
    const m = new Map();
    for (const it of items) { const k = keyFn(it); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m;
}

/**
 * rows = { partners, users, referrals, stores, withdrawals }
 * Returns findings, most serious first: { code, severity, title, detail, partnerIds, check }
 * `check` tells the admin what to look at before acting. Nothing here acts on its own.
 */
function securityFindings({ partners = [], users = [], referrals = [], stores = [], withdrawals = [] } = {}) {
    const out = [];
    const live = partners.filter((p) => p.status !== 'rejected');
    const byId = new Map(partners.map((p) => [p.id, p]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const name = (p) => `${p.displayName} (${p.code})`;
    const push = (f) => out.push({ partnerIds: [], ...f });

    // 1. one payout number paid to several partners: the classic way to cash out several fake accounts
    for (const [num, group] of groupBy(live.filter((p) => p.payoutNumber), (p) => phoneKey(p.payoutNumber))) {
        if (group.length < 2) continue;
        push({ code: 'shared_payout_number', severity: 'high', title: 'One payout number, several partners',
            detail: `${group.map(name).join(', ')} are all paid to the same mobile money number (ends ${num.slice(-4)}).`,
            partnerIds: group.map((p) => p.id), check: 'Are these relatives sharing a phone, or one person running several accounts? Compare their recruits and sign-in places before approving more payouts.' });
    }
    // 2. one phone number on several partner accounts
    for (const [num, group] of groupBy(live.filter((p) => p.phone), (p) => phoneKey(p.phone))) {
        if (group.length < 2) continue;
        push({ code: 'shared_phone', severity: 'high', title: 'One phone number, several partner accounts',
            detail: `${group.map(name).join(', ')} registered with the same phone number (ends ${num.slice(-4)}).`,
            partnerIds: group.map((p) => p.id), check: 'Crew approval already blocks this, so look at how it got through (an old account? a Circle member who later applied?).' });
    }
    // 3. my payout number is someone else's registered phone
    const phoneOwner = groupBy(live.filter((p) => p.phone), (p) => phoneKey(p.phone));
    for (const p of live) {
        const k = phoneKey(p.payoutNumber); if (!k) continue;
        const others = (phoneOwner.get(k) || []).filter((o) => o.id !== p.id);
        if (others.length) push({ code: 'payout_is_other_partners_phone', severity: 'medium', title: 'Paid to another partner\'s phone',
            detail: `${name(p)} is paid to the number ${others.map(name).join(', ')} registered with.`, partnerIds: [p.id, ...others.map((o) => o.id)],
            check: 'Family members sometimes do this on purpose. Ask if unsure.' });
    }
    // 4. partners recruiting their own store
    const selfStores = new Map();
    for (const r of referrals) {
        const p = byId.get(r.partnerId), s = storeById.get(r.storeId);
        if (p && s && s.ownerId && s.ownerId === p.userId) { if (!selfStores.has(p.id)) selfStores.set(p.id, []); selfStores.get(p.id).push(s); }
    }
    for (const [pid, list] of selfStores) {
        const p = byId.get(pid);
        push({ code: 'self_referral', severity: 'high', title: 'A partner is their own recruit',
            detail: `${name(p)} is credited for ${list.length} store${list.length === 1 ? '' : 's'} they own (${list.slice(0, 3).map((s) => s.name).join(', ')}).`, partnerIds: [pid],
            check: 'Void the earning if it is still held. A real store owner can be a partner, but cannot be paid for their own store.' });
    }
    // 5. several partners signing up from the same network
    for (const [ip, group] of groupBy(live.filter((p) => p.signupIpPrefix), (p) => p.signupIpPrefix)) {
        if (group.length < 3) continue;
        push({ code: 'same_network_cluster', severity: 'medium', title: 'Several partners joined from one network',
            detail: `${group.length} partners joined from ${ip}: ${group.slice(0, 4).map(name).join(', ')}${group.length > 4 ? ' and more' : ''}.`, partnerIds: group.map((p) => p.id),
            check: 'A market, a cafe or a shared office can explain this. Look at whether their recruits also share a network.' });
    }
    // 6. throwaway email addresses on partner accounts
    for (const p of live) {
        const u = userById.get(p.userId);
        if (u && R.RISK.disposableEmailDomains.includes(domainOf(u.email))) push({ code: 'disposable_email', severity: 'medium', title: 'Throwaway email address',
            detail: `${name(p)} signed up with a disposable email service (${domainOf(u.email)}).`, partnerIds: [p.id], check: 'Ask them to change to a real address before the first payout.' });
    }
    // 7. payouts being turned down again and again
    for (const [pid, list] of groupBy(withdrawals.filter((w) => w.status === 'rejected'), (w) => w.partnerId)) {
        if (list.length < 3) continue;
        const p = byId.get(pid); if (!p) continue;
        push({ code: 'repeated_rejected_payouts', severity: 'medium', title: 'Payouts rejected several times',
            detail: `${name(p)} has had ${list.length} withdrawal requests rejected.`, partnerIds: [pid], check: 'Read the rejection reasons: a wrong number is a typo, a pattern is a problem.' });
    }
    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.partnerIds.length - a.partnerIds.length);
}

/**
 * What actually happened, from real rows. Used to replace guesses in the economics screen.
 * rows = { referrals, commissions, now }
 */
function observedRates({ referrals = [], commissions = [], now = new Date() } = {}) {
    const t = now.getTime();
    const paid = referrals.filter((r) => r.stage === 'paid' && r.paidAt);
    const matured = paid.filter((r) => t - new Date(r.paidAt).getTime() >= (R.COMMISSION.renewalWithinDays + 30) * DAY);   // old enough that a renewal would have shown up
    const renewedIds = new Set(commissions.filter((c) => c.type === 'renewal' && c.status !== 'voided').map((c) => c.referralId));
    const firstPay = commissions.filter((c) => c.type === 'first_payment');
    const reversed = firstPay.filter((c) => c.status === 'voided' && String(c.voidReason || '').startsWith('reversed'));
    const days = paid.filter((r) => r.createdAt).map((r) => (new Date(r.paidAt) - new Date(r.createdAt)) / DAY).filter((d) => d >= 0).sort((a, b) => a - b);
    const enough = (n, floor) => n >= floor;
    return {
        paidStores: paid.length,
        renewalRate: matured.length ? matured.filter((r) => renewedIds.has(r.id)).length / matured.length : null,
        renewalSample: matured.length,
        reversalRate: firstPay.length ? reversed.length / firstPay.length : null,
        reversalSample: firstPay.length,
        medianDaysToFirstPayment: days.length ? Math.round(days[Math.floor(days.length / 2)] * 10) / 10 : null,
        trustworthy: { renewal: enough(matured.length, 20), reversal: enough(firstPay.length, 20) }   // below this the number is an anecdote
    };
}

/** CSV that opens safely in Excel: cells that start with = + - @ are neutralised, quotes doubled. */
function toCsv(rows, columns) {
    const cell = (v) => {
        if (v === null || v === undefined) return '';
        let s = v instanceof Date ? v.toISOString() : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map((c) => cell(c.label)).join(',');
    return [head, ...rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { securityFindings, observedRates, toCsv, phoneKey };
