/**
 * Admin tools for the Circle / Crew console: the day-to-day operating kit.
 * (admin.js keeps the original queue actions; this file adds the views and the tools around them.)
 *
 * Every action here needs a reason, writes the audit trail, and, where money or a person's access is involved,
 * leaves the final say to a second admin or to the member's own right to withdraw. Nothing acts on a "finding" by itself.
 */
'use strict';
const R = require('./rules');
const C = require('./commission');
const I = require('./insights');

const DAY = 86400000, HOUR = 3600000;
const OPEN_MONEY = ['held', 'available', 'review'];

function createAdminTools(ctx, partnersApi, adminApi) {
    const { prisma, apiError, now, notify, audit } = ctx;
    const reasonOf = (v, min = 5) => { const s = String(v || '').trim().slice(0, 300); if (s.length < min) throw apiError('Write a short reason. It is kept in the audit trail.', 400, 'REASON_REQUIRED'); return s; };
    const name = (p) => `${p.displayName} (${p.code})`;
    const sum = (rows, f = (r) => r.amount) => rows.reduce((s, r) => s + Number(f(r) || 0), 0);

    // ------------------------------------------------------------------ the two programs side by side
    async function segments() {
        const t = now();
        const [partners, flags, commissions, withdrawals, referrals] = await Promise.all([
            prisma.growthPartner.findMany({}),
            prisma.growthFlag.findMany({ where: { status: 'open' } }),
            prisma.growthCommission.findMany({ where: { status: { in: OPEN_MONEY } } }),
            prisma.growthWithdrawal.findMany({}),
            prisma.growthReferral.findMany({ where: { stage: 'paid' } })
        ]);
        const progOf = new Map(partners.map((p) => [p.id, p.program]));
        const blank = () => ({ members: 0, active: 0, frozen: 0, applied: 0, rejected: 0, retired: 0, openFlags: 0, owed: 0, availableNow: 0, inQueue: 0, paidOut: 0, paidStores: 0, oldestApplicationHours: null });
        const out = { circle: blank(), crew: blank() };
        for (const p of partners) {
            const s = out[p.program]; if (!s) continue;
            s.members += p.status === 'applied' || p.status === 'rejected' ? 0 : 1; s[p.status] += 1;
            if (p.status === 'applied') { const h = Math.round((t - new Date(p.createdAt)) / HOUR); s.oldestApplicationHours = Math.max(s.oldestApplicationHours || 0, h); }
        }
        for (const f of flags) { const s = out[progOf.get(f.partnerId)]; if (s) s.openFlags += 1; }
        for (const c of commissions) { const s = out[progOf.get(c.partnerId)]; if (!s) continue; s.owed += Number(c.amount); if (c.status === 'available' || (c.status === 'held' && c.clearsAt && new Date(c.clearsAt) <= t)) s.availableNow += Number(c.amount); }
        for (const w of withdrawals) { const s = out[progOf.get(w.partnerId)]; if (!s) continue; if (w.status === 'paid') s.paidOut += w.amount; else if (['requested', 'in_review', 'approved'].includes(w.status)) { s.inQueue += w.amount; s.availableNow -= w.amount; } }
        for (const r of referrals) { const s = out[C.referralProgram(r, { program: progOf.get(r.partnerId) })]; if (s) s.paidStores += 1; }
        return out;
    }

    // ------------------------------------------------------------------ members: filter, sort, page
    async function members({ program, status, rank, q, flagged, sort = 'newest', page = 1, pageSize = 25 } = {}) {
        const where = {};
        if (program && R.PROGRAMS[program]) where.program = program;
        if (status) where.status = String(status);
        if (rank) where.rankKey = String(rank);
        const term = String(q || '').trim();
        if (term) {
            // Digits only count as a phone search when there are enough of them: "Person 4" or "CIRCLE-ZUH2B" must not match every phone containing a 4 or a 2.
            const digits = term.replace(/\D/g, '');
            where.OR = [{ displayName: { contains: term, mode: 'insensitive' } }, { code: { contains: term.toUpperCase() } }, ...(digits.length >= 5 ? [{ phone: { contains: digits } }, { payoutNumber: { contains: digits } }] : [])];
        }
        if (flagged === 'true' || flagged === true) {
            const open = await prisma.growthFlag.findMany({ where: { status: 'open' } });
            where.id = { in: [...new Set(open.map((f) => f.partnerId))] };
        }
        const size = Math.min(100, Math.max(5, Number(pageSize) || 25)), pg = Math.max(1, Number(page) || 1);
        const orderBy = sort === 'quality' ? { qualityScore: 'asc' } : sort === 'name' ? { displayName: 'asc' } : { createdAt: 'desc' };
        const [total, rows] = await Promise.all([prisma.growthPartner.count({ where }), prisma.growthPartner.findMany({ where, orderBy, skip: (pg - 1) * size, take: size })]);
        const ids = rows.map((p) => p.id);
        const [money, paidRefs, openFlags] = ids.length ? await Promise.all([
            prisma.growthCommission.findMany({ where: { partnerId: { in: ids }, status: { in: OPEN_MONEY } } }),
            prisma.growthReferral.findMany({ where: { partnerId: { in: ids }, stage: 'paid' } }),
            prisma.growthFlag.findMany({ where: { partnerId: { in: ids }, status: 'open' } })
        ]) : [[], [], []];
        const by = (list) => { const m = new Map(); for (const x of list) m.set(x.partnerId, (m.get(x.partnerId) || 0) + 1); return m; };
        const owed = new Map(); for (const c of money) owed.set(c.partnerId, (owed.get(c.partnerId) || 0) + Number(c.amount));
        const stores = by(paidRefs), flags = by(openFlags);
        return {
            total, page: pg, pageSize: size, pages: Math.max(1, Math.ceil(total / size)),
            rows: rows.map((p) => ({ id: p.id, displayName: p.displayName, program: p.program, status: p.status, code: p.code, rankKey: p.rankKey, qualityScore: p.qualityScore,
                territories: p.territories, joinedAt: p.joinedAt, createdAt: p.createdAt, phone: p.phone, frozenReason: p.frozenReason, owed: owed.get(p.id) || 0, paidStores: stores.get(p.id) || 0, openFlags: flags.get(p.id) || 0, hasPayoutNumber: !!p.payoutNumber, hasKyc: !!p.kycFileUrl, hasCardPhoto: !!p.cardPhotoUrl }))
        };
    }

    // ------------------------------------------------------------------ "why can't she...": explain, don't guess
    /** Findings: { level: 'block' | 'warn' | 'info' | 'ok', title, detail, fix } */
    async function diagnose(id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p) throw apiError('Partner not found.', 404);
        const t = now();
        const [commissions, history, st, referrals, flags, user] = await Promise.all([
            prisma.growthCommission.findMany({ where: { partnerId: id } }), prisma.growthWithdrawal.findMany({ where: { partnerId: id } }), partnersApi.stats(p),
            prisma.growthReferral.findMany({ where: { partnerId: id } }), prisma.growthFlag.findMany({ where: { partnerId: id, status: 'open' } }),
            prisma.user.findUnique({ where: { id: p.userId } })
        ]);
        const balances = C.computeBalances(commissions, history, t);
        const f = [];
        const add = (level, title, detail, fix = '') => f.push({ level, title, detail, fix });

        if (p.status === 'applied') add('block', 'Application not decided', 'This person is still waiting for approval, so nothing can be earned or withdrawn yet.', 'Open Applications and approve or decline.');
        if (p.status === 'rejected' || p.status === 'retired') add('block', `Account is ${p.status}`, p.frozenReason || 'No reason was recorded.', p.status === 'rejected' ? 'Use "Reopen application" if the decision was a mistake.' : 'Retired accounts keep their history but cannot earn.');
        if (p.status === 'frozen') add('block', 'Account is frozen', p.frozenReason || 'No reason recorded.', 'Unfreeze it from the partner page once the concern is cleared.');
        if (!user || user.accountStatus === 'suspended' || user.accountStatus === 'banned') add('block', 'The NextaStore account itself is restricted', `Account status: ${user ? user.accountStatus : 'missing'}.`, 'Resolve this in the main admin users page first.');
        if (user && !user.emailVerifiedAt) add('warn', 'Email not verified', 'Signing in works, but new program actions require a verified email.', 'Ask them to verify from the email we sent.');
        if (p.program === 'crew' && !p.kycFileUrl) add('warn', 'No ID photo on file', 'A Crew member without an ID cannot be vetted.', 'Ask them to re-apply or upload the ID.');
        if (!p.agreedTermsAt) add('warn', 'Terms not recorded', 'No agreement time is stored for this account.', 'Ask them to accept the terms again.');

        // Would a withdrawal of everything cleared go through, right now?
        const trust = C.trustLevel({ joinedAt: p.approvedAt || p.joinedAt, clearedConversions: st.cleared, qualityScore: st.quality, openFlags: st.openFlags, frozen: p.status === 'frozen' }, t);
        const tryAmount = Math.max(R.WITHDRAWAL.minAmount, Math.max(0, balances.available));
        const verdict = C.checkWithdrawal({ partner: { joinedAt: p.approvedAt || p.joinedAt, frozen: p.status === 'frozen', payoutNumber: p.payoutNumber, payoutNumberChangedAt: p.payoutNumberChangedAt, trust, clearedConversions: st.cleared }, amount: tryAmount, balances, history, now: t });
        if (['active', 'frozen'].includes(p.status)) {
            if (verdict.ok) add('ok', 'Can withdraw today', `Up to ${ctx.fmtUGX(Math.min(balances.available, verdict.limits.perRequestMax))} would be accepted${verdict.needsSecondApproval ? ' (a second admin must approve it)' : ''}.`);
            else add(['INSUFFICIENT', 'BELOW_MINIMUM'].includes(verdict.code) ? 'info' : 'block', `Withdrawal would be refused: ${verdict.code}`, verdict.message, fixFor(verdict.code));
        }
        if (balances.available < 0) add('block', 'Negative balance', `A reversed payment left them ${ctx.fmtUGX(-balances.available)} below zero.`, 'It clears itself as new earnings arrive. Do not top it up by hand.');

        const review = commissions.filter((c) => c.status === 'review');
        if (review.length) add('warn', `${review.length} earning${review.length === 1 ? '' : 's'} held for review (${ctx.fmtUGX(sum(review))})`, 'The risk engine wanted a human to look. The member cannot withdraw these.', 'Open Risk → Review queue.');
        const clearing = commissions.filter((c) => c.status === 'held' && c.clearsAt && new Date(c.clearsAt) > t);
        if (clearing.length) { const next = new Date(Math.min(...clearing.map((c) => new Date(c.clearsAt)))); add('info', `${ctx.fmtUGX(sum(clearing))} still clearing`, `The first of it clears ${C.formatEat(next)}.`); }
        if (flags.length) add('warn', `${flags.length} open flag${flags.length === 1 ? '' : 's'}`, flags.map((x) => x.code).join(', '), 'Open Risk → Flags. An open flag also sends every payout request to manual review.');
        if (history.some((w) => w.status === 'in_review')) add('info', 'A payout is waiting for review', 'It went to manual review because of an open flag or size.', 'Open Money → Payout queue.');

        // Recruits that have stalled, in the admin's own words
        const stuck = referrals.filter((r) => r.stage === 'payment_pending' && r.paymentSubmittedAt && t - new Date(r.paymentSubmittedAt) > R.FOLLOW_UP.paymentApprovalTargetHours * HOUR);
        if (stuck.length) add('warn', `${stuck.length} recruit payment${stuck.length === 1 ? '' : 's'} waiting on us for over ${R.FOLLOW_UP.paymentApprovalTargetHours} hours`, 'The partner is waiting because a Seller Pass payment has not been approved yet.', 'Approve or reject those payments in the main admin.');
        const cold = referrals.filter((r) => r.stage === 'signed_up' && t - new Date(r.signedUpAt || r.createdAt) > R.FOLLOW_UP.stuckSignedUpAfterDays * DAY);
        if (cold.length) add('info', `${cold.length} recruit${cold.length === 1 ? '' : 's'} signed up but no live store`, 'This is the partner\'s to chase; nothing is wrong on our side.');
        if (!f.length) add('ok', 'Nothing unusual', 'No restriction or stuck item was found.');
        const order = { block: 0, warn: 1, info: 2, ok: 3 };
        f.sort((a, b) => order[a.level] - order[b.level]);
        return { partner: { id: p.id, displayName: p.displayName, program: p.program, status: p.status, code: p.code }, balances, trust, checkedAt: t, findings: f };
    }
    function fixFor(code) {
        return ({
            NO_PAYOUT_NUMBER: 'Ask them to add a payout number in the app (More, or the header menu).', PAYOUT_NUMBER_LOCK: 'It lifts by itself. Do not shorten it: it protects against account takeover.',
            OPEN_REQUEST: 'Pay or reject the request they already have open.', FIRST_WITHDRAWAL_TOO_SOON: 'The waiting period is part of the rules. It lifts by itself.', FIRST_NEEDS_CONVERSION: 'They need one store that has paid and cleared first.',
            TOO_SOON: 'The gap between withdrawals follows their trust level and grows as they earn trust.', DAILY_REQUEST_LIMIT: 'Tomorrow.', PER_REQUEST_LIMIT: 'They can withdraw in smaller steps.',
            DAILY_LIMIT: 'Tomorrow.', MONTHLY_LIMIT: 'It resets on a rolling 30 days.', FROZEN: 'Unfreeze from the partner page after review.', INSUFFICIENT: 'Nothing cleared to withdraw yet.', BELOW_MINIMUM: 'Below the minimum payout.'
        })[code] || '';
    }

    // ------------------------------------------------------------------ find anything
    async function lookup(q) {
        const term = String(q || '').trim();
        if (term.length < 3) throw apiError('Type at least 3 characters.', 400);
        const digits = term.replace(/\D/g, '');
        const [byPartner, users, stores] = await Promise.all([
            prisma.growthPartner.findMany({ where: { OR: [{ displayName: { contains: term, mode: 'insensitive' } }, { code: { contains: term.toUpperCase() } }, ...(digits.length >= 5 ? [{ phone: { contains: digits } }, { payoutNumber: { contains: digits } }] : [])] }, take: 20 }),
            prisma.user.findMany({ where: { OR: [{ email: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] }, take: 20 }),
            prisma.store.findMany({ where: { name: { contains: term, mode: 'insensitive' } }, take: 20 })
        ]);
        const userIds = users.map((u) => u.id);
        const byUser = userIds.length ? await prisma.growthPartner.findMany({ where: { userId: { in: userIds } } }) : [];
        const partners = [...new Map([...byPartner, ...byUser].map((p) => [p.id, p])).values()];
        const storeIds = stores.map((s) => s.id);
        const refs = storeIds.length ? await prisma.growthReferral.findMany({ where: { storeId: { in: storeIds } } }) : [];
        const pmap = new Map((refs.length ? await prisma.growthPartner.findMany({ where: { id: { in: refs.map((r) => r.partnerId) } } }) : []).map((p) => [p.id, p]));
        return {
            partners: partners.map((p) => ({ id: p.id, displayName: p.displayName, program: p.program, status: p.status, code: p.code })),
            stores: stores.map((s) => { const r = refs.find((x) => x.storeId === s.id); const p = r && pmap.get(r.partnerId); return { id: s.id, name: s.name, district: s.district, creditedTo: r ? { partnerId: r.partnerId, displayName: p ? p.displayName : '', code: p ? p.code : '', program: p ? p.program : '', stage: r.stage, via: r.source || '' } : null }; })
        };
    }

    // ------------------------------------------------------------------ security
    async function securityScan() {
        const [partners, referrals, withdrawals] = await Promise.all([prisma.growthPartner.findMany({}), prisma.growthReferral.findMany({ where: { storeId: { not: null } } }), prisma.growthWithdrawal.findMany({ where: { status: 'rejected' } })]);
        const userIds = [...new Set(partners.map((p) => p.userId))], storeIds = [...new Set(referrals.map((r) => r.storeId))];
        const [users, stores] = await Promise.all([userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } } }) : [], storeIds.length ? prisma.store.findMany({ where: { id: { in: storeIds } } }) : []]);
        const findings = I.securityFindings({ partners, users, referrals, stores, withdrawals });
        const nameOf = new Map(partners.map((p) => [p.id, { id: p.id, displayName: p.displayName, code: p.code, program: p.program }]));
        return { scannedAt: now(), partnersScanned: partners.length, findings: findings.map((x) => ({ ...x, partners: x.partnerIds.map((id) => nameOf.get(id)).filter(Boolean) })) };
    }

    // ------------------------------------------------------------------ people actions
    async function retire(adminId, id, reason) {
        const why = reasonOf(reason);
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p) throw apiError('Partner not found.', 404);
        if (!['active', 'frozen'].includes(p.status)) throw apiError('Only an active or frozen member can be retired.', 400);
        const open = await prisma.growthWithdrawal.count({ where: { partnerId: id, status: { in: ['requested', 'in_review', 'approved'] } } });
        if (open) throw apiError('They have a payout in progress. Pay or reject it first.', 409, 'OPEN_REQUEST');
        const commissions = await prisma.growthCommission.findMany({ where: { partnerId: id } });
        const history = await prisma.growthWithdrawal.findMany({ where: { partnerId: id } });
        const balances = C.computeBalances(commissions, history, now());
        await prisma.growthPartner.update({ where: { id }, data: { status: 'retired', frozenReason: why, frozenAt: now() } });
        await audit(adminId, 'partner_retired', 'partner', id, { reason: why, balance: balances.available }, p.userId);
        await notify(p.userId, 'Your membership has ended', 'Your history is kept. Please contact support about any balance.');
        return { ok: true, balanceRemaining: Math.max(0, balances.available), note: balances.available > 0 ? 'They still have earned money. Settle it with them through support: retiring does not delete it.' : '' };
    }
    async function reopenCrew(adminId, id, note) {
        const why = reasonOf(note);
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || p.program !== 'crew' || p.status !== 'rejected') throw apiError('Only a declined Crew application can be reopened.', 400);
        await prisma.growthPartner.update({ where: { id }, data: { status: 'applied', frozenReason: '' } });
        await audit(adminId, 'crew_reopened', 'partner', id, { note: why }, p.userId);
        await notify(p.userId, 'Your Crew application is being looked at again', `Our team is reviewing it again, within ${R.REVIEW.applicationWorkingDays} working days.`, '/crew');
        return { ok: true };
    }
    async function addNote(adminId, id, note) {
        const text = reasonOf(note, 3);
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p) throw apiError('Partner not found.', 404);
        await audit(adminId, 'partner_note', 'partner', id, { note: text }, p.userId);
        return { ok: true };
    }
    /**
     * A manual money correction. Debits apply at once (they only ever reduce what the member can take). Credits are never instant:
     * they land in the review queue stamped with the admin who made them, and the separation-of-duties rule means a DIFFERENT admin
     * has to release them. So no single admin can create withdrawable money.
     */
    async function adjust(adminId, id, { amount, reason } = {}) {
        const why = reasonOf(reason, 10);
        const amt = Math.round(Number(amount));
        if (!Number.isFinite(amt) || amt === 0) throw apiError('Enter an amount, positive to credit or negative to deduct.', 400);
        if (Math.abs(amt) > 200000) throw apiError('A single correction can be at most UGX 200,000. For more, split it or involve the owner.', 400, 'TOO_LARGE');
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || !['active', 'frozen'].includes(p.status)) throw apiError('Only an active or frozen member can be adjusted.', 400);
        const row = await prisma.growthCommission.create({ data: amt < 0
            ? { partnerId: id, type: 'adjustment', amount: amt, status: 'available', note: `admin: ${why}` }
            : { partnerId: id, type: 'adjustment', amount: amt, status: 'review', paymentReviewedBy: adminId, note: `admin: ${why}` } });
        await audit(adminId, amt < 0 ? 'adjustment_debit' : 'adjustment_credit_pending', 'commission', row.id, { amount: amt, reason: why }, p.userId);
        return { ok: true, id: row.id, applied: amt < 0, message: amt < 0 ? 'Deducted now.' : 'Credit created. A different admin must release it from Risk → Review queue before it can be withdrawn.' };
    }
    /** Run the same safe action over several members, one by one; one failure never stops the rest. */
    async function bulk(adminId, action, ids, reason) {
        if (!['freeze', 'unfreeze', 'approve'].includes(action)) throw apiError('That bulk action is not available.', 400);
        const list = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].slice(0, 50);
        if (!list.length) throw apiError('Choose at least one member.', 400);
        const results = [];
        for (const id of list) {
            try {
                if (action === 'freeze') await adminApi.freeze(adminId, id, reason);
                else if (action === 'unfreeze') await adminApi.unfreeze(adminId, id);
                else await adminApi.approveCrew(adminId, id);
                results.push({ id, ok: true });
            } catch (e) { results.push({ id, ok: false, message: e.message }); }
        }
        await audit(adminId, `bulk_${action}`, 'partner', 'many', { count: list.length, ok: results.filter((r) => r.ok).length });
        return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    }

    // ------------------------------------------------------------------ history and exports
    async function timeline(id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p) throw apiError('Partner not found.', 404);
        if (!prisma.adminAuditLog) return [];
        const rows = await prisma.adminAuditLog.findMany({ where: { OR: [{ targetType: 'partner', targetId: id }, { targetUserId: p.userId, action: { startsWith: 'growth.' } }] }, orderBy: { createdAt: 'desc' }, take: 100 });
        return rows.map((r) => ({ id: r.id, action: String(r.action).replace(/^growth\./, ''), at: r.createdAt, actorId: r.actorId, metadata: r.metadata || {} }));
    }
    async function auditFeed({ action, page = 1 } = {}) {
        if (!prisma.adminAuditLog) return { rows: [], page: 1 };
        const where = { action: action ? `growth.${String(action).replace(/[^a-z_]/g, '')}` : { startsWith: 'growth.' } };
        const rows = await prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (Math.max(1, Number(page)) - 1) * 50, take: 50 });
        return { page: Math.max(1, Number(page)), rows: rows.map((r) => ({ id: r.id, action: String(r.action).replace(/^growth\./, ''), at: r.createdAt, actorId: r.actorId, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata || {} })) };
    }
    const EXPORTS = {
        partners: { cols: [['Code', 'code'], ['Name', 'displayName'], ['Program', (r) => (r.program === 'crew' ? 'Crew' : 'Circle')], ['Status', 'status'], ['Rank', 'rankKey'], ['Quality', 'qualityScore'], ['Areas', (r) => (r.territories || []).join('; ')], ['Joined', 'joinedAt']], perm: 'view' },
        commissions: { cols: [['Created', 'createdAt'], ['Partner', 'partnerId'], ['Type', 'type'], ['Amount UGX', 'amount'], ['Status', 'status'], ['Clears', 'clearsAt'], ['Note', 'note']], perm: 'payouts' },
        withdrawals: { cols: [['Requested', 'requestedAt'], ['Partner', 'partnerId'], ['Amount UGX', 'amount'], ['Network', 'network'], ['Pay to', 'payoutNumber'], ['Name', 'payoutName'], ['Status', 'status'], ['Fee estimate', 'feeEstimate'], ['Fee actual', 'feeActual'], ['Reference', 'payoutReference'], ['Paid', 'paidAt']], perm: 'payouts' }
    };
    function exportKinds() { return Object.fromEntries(Object.entries(EXPORTS).map(([k, v]) => [k, v.perm])); }
    async function exportCsv(adminId, kind, { program } = {}) {
        const def = EXPORTS[kind]; if (!def) throw apiError('Unknown export.', 400);
        const model = { partners: prisma.growthPartner, commissions: prisma.growthCommission, withdrawals: prisma.growthWithdrawal }[kind];
        let rows = await model.findMany({});
        if (program && kind === 'partners') rows = rows.filter((r) => r.program === program);
        const csv = I.toCsv(rows, def.cols.map(([label, v]) => ({ label, value: typeof v === 'function' ? v : (r) => r[v] })));
        await audit(adminId, 'export', 'export', kind, { rows: rows.length });
        return { filename: `nextastore-growth-${kind}-${now().toISOString().slice(0, 10)}.csv`, csv, rows: rows.length };
    }

    // ------------------------------------------------------------------ the money picture, with real numbers where there are enough
    async function observed() {
        const [referrals, commissions] = await Promise.all([prisma.growthReferral.findMany({}), prisma.growthCommission.findMany({})]);
        return I.observedRates({ referrals, commissions, now: now() });
    }
    async function economicsModel() {
        return { observed: await observed(), feeTiers: R.PAYOUT_FEE.tiers.map((t) => ({ upTo: Number.isFinite(t.upTo) ? t.upTo : 1e12, fee: t.fee })), feeIsEstimate: R.PAYOUT_FEE.isEstimate, costGuard: R.COST_GUARD };
    }

    return { segments, members, diagnose, lookup, securityScan, retire, reopenCrew, addNote, adjust, bulk, timeline, auditFeed, exportKinds, exportCsv, observed, economicsModel };
}

module.exports = { createAdminTools };
