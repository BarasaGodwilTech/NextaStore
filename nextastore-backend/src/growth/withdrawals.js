/**
 * Withdrawals. The partner asks; the rules in commission.checkWithdrawal say yes or no (and
 * say WHY in plain words); admins approve and pay by hand with MTN / Airtel, like Seller Pass
 * payments are handled today. Promise to the partner: paid within 2 working days of asking.
 */
const R = require('./rules');
const C = require('./commission');
const W = require('./workingDays');

const DAY = 86400000;

function createWithdrawals(ctx, partnersApi) {
    const { prisma, apiError, now, notify, audit, fmtUGX } = ctx;

    async function recentPaymentApprovers(partnerId) {
        const since = new Date(now().getTime() - 30 * DAY);
        const rows = await prisma.growthCommission.findMany({
            where: { partnerId, createdAt: { gte: since }, paymentReviewedBy: { not: null } }, select: { paymentReviewedBy: true }
        });
        return [...new Set(rows.map((r) => r.paymentReviewedBy))];
    }

    // ---- Partner side ---------------------------------------------------------------------
    async function request(user, amount) {
        const partner = await partnersApi.getPartnerOrThrow(user.id);
        if (partner.status === 'applied') throw apiError('Your application is still being reviewed.', 403, 'NOT_APPROVED');
        if (!['active', 'frozen'].includes(partner.status)) throw apiError('This account cannot withdraw.', 403);
        const t = now();
        const [commissions, history, st] = await Promise.all([
            prisma.growthCommission.findMany({ where: { partnerId: partner.id } }),
            prisma.growthWithdrawal.findMany({ where: { partnerId: partner.id } }),
            partnersApi.stats(partner)
        ]);
        const balances = C.computeBalances(commissions, history, t);
        const trust = C.trustLevel({ joinedAt: partner.approvedAt || partner.joinedAt, clearedConversions: st.cleared, qualityScore: st.quality, openFlags: st.openFlags, frozen: partner.status === 'frozen' }, t);
        const verdict = C.checkWithdrawal({
            partner: { joinedAt: partner.approvedAt || partner.joinedAt, frozen: partner.status === 'frozen', payoutNumber: partner.payoutNumber, payoutNumberChangedAt: partner.payoutNumberChangedAt, trust, clearedConversions: st.cleared },
            amount, balances, history, now: t
        });
        if (!verdict.ok) throw apiError(verdict.message, 400, verdict.code);

        const dueBy = W.payoutDueBy(t, await ctx.holidays());
        const held = st.openFlags > 0; // an open flag always gets a human look first
        let created;
        try {
            created = await prisma.growthWithdrawal.create({
                data: {
                    partnerId: partner.id, amount: verdict.amount, network: partner.payoutNetwork, payoutNumber: partner.payoutNumber, payoutName: partner.payoutName || '',
                    status: held ? 'in_review' : 'requested', requestedAt: t, dueBy, needsSecondApproval: verdict.needsSecondApproval,
                    feeEstimate: C.estimatePayoutFee(verdict.amount)
                }
            });
        } catch (err) {
            // The partial unique index (one open withdrawal per partner) catches two taps racing each other.
            if (err && err.code === 'P2002') throw apiError('You already have a withdrawal in progress. It must be paid before you request another.', 400, 'OPEN_REQUEST');
            throw err;
        }
        await notify(user.id, 'Withdrawal requested', `${fmtUGX(created.amount)} to ${partner.payoutNetwork === 'mtnMomo' ? 'MTN MoMo' : 'Airtel Money'}. You will be paid by ${W.formatDueBy(dueBy)}.`);
        return { id: created.id, amount: created.amount, status: created.status, dueBy, dueByText: W.formatDueBy(dueBy) };
    }

    async function cancel(user, id) {
        const partner = await partnersApi.getPartnerOrThrow(user.id);
        const w = await prisma.growthWithdrawal.findFirst({ where: { id, partnerId: partner.id } });
        if (!w) throw apiError('Withdrawal not found.', 404);
        if (!['requested', 'in_review'].includes(w.status)) throw apiError('This withdrawal is already being paid and can no longer be cancelled.', 400, 'TOO_LATE');
        await prisma.growthWithdrawal.update({ where: { id }, data: { status: 'cancelled' } });
        return { ok: true };
    }

    // ---- Admin side (growth.payouts) ----------------------------------------------------------
    async function queue({ status } = {}) {
        const t = now();
        const rows = await prisma.growthWithdrawal.findMany({
            where: status ? { status } : { status: { in: ['requested', 'in_review', 'approved'] } },
            include: { partner: { select: { id: true, displayName: true, program: true, code: true, status: true, phone: true, userId: true, qualityScore: true } } },
            orderBy: { dueBy: 'asc' }, take: 200
        });
        return rows.map((w) => ({
            id: w.id, amount: w.amount, status: w.status, network: w.network, payoutNumber: w.payoutNumber, payoutName: w.payoutName,
            requestedAt: w.requestedAt, dueBy: w.dueBy, dueByText: W.formatDueBy(w.dueBy), overdue: ['requested', 'in_review', 'approved'].includes(w.status) && W.isOverdue(w.dueBy, t),
            needsSecondApproval: w.needsSecondApproval, approvedBy: w.approvedBy, feeEstimate: w.feeEstimate, partner: w.partner
        }));
    }

    /** Everything the payer should look at before sending money. */
    async function detail(id) {
        const w = await prisma.growthWithdrawal.findUnique({ where: { id }, include: { partner: true } });
        if (!w) throw apiError('Withdrawal not found.', 404);
        const [commissions, history, flags, recentApprovers, recent] = await Promise.all([
            prisma.growthCommission.findMany({ where: { partnerId: w.partnerId } }),
            prisma.growthWithdrawal.findMany({ where: { partnerId: w.partnerId }, orderBy: { requestedAt: 'desc' }, take: 10 }),
            prisma.growthFlag.findMany({ where: { partnerId: w.partnerId, status: 'open' } }),
            recentPaymentApprovers(w.partnerId),
            prisma.growthCommission.findMany({ where: { partnerId: w.partnerId, status: { not: 'voided' } }, orderBy: { createdAt: 'desc' }, take: 15 })
        ]);
        return { withdrawal: w, balances: C.computeBalances(commissions, history, now()), history, openFlags: flags, paymentApprovers: recentApprovers, recentEarnings: recent };
    }

    async function approve(adminId, id) {
        const w = await prisma.growthWithdrawal.findUnique({ where: { id } });
        if (!w) throw apiError('Withdrawal not found.', 404);
        if (!['requested', 'in_review'].includes(w.status)) throw apiError('This withdrawal was already handled.', 400);
        const approvers = await recentPaymentApprovers(w.partnerId);
        if (!C.separationOfDutiesOk({ payoutAdminId: adminId, recentPaymentApproverIds: approvers })) {
            throw apiError('You approved Seller Pass payments behind this partner\'s earnings, so someone else needs to release their payout.', 403, 'SEPARATION_OF_DUTIES');
        }
        const updated = await prisma.growthWithdrawal.updateMany({ where: { id, status: { in: ['requested', 'in_review'] } }, data: { status: 'approved', approvedBy: adminId, approvedAt: now() } });
        if (!updated.count) throw apiError('This withdrawal was just handled by someone else.', 409);
        await audit(adminId, 'withdrawal_approved', 'withdrawal', id, { amount: w.amount });
        return { ok: true };
    }

    async function markPaid(adminId, id, { reference, fee } = {}) {
        const ref = String(reference || '').trim().slice(0, 120);
        if (ref.length < 3) throw apiError('Enter the mobile money transaction ID you paid with.', 400, 'REFERENCE_REQUIRED');
        // The real mobile money fee NextaStore paid on this payout (optional, but it is how the Economics tab shows true cost).
        let feeActual = null;
        if (fee !== undefined && fee !== null && fee !== '') {
            feeActual = Number(fee);
            if (!Number.isInteger(feeActual) || feeActual < 0 || feeActual > 50000) throw apiError('Enter the fee as a whole number of shillings, from 0 to 50,000.', 400, 'BAD_FEE');
        }
        const w = await prisma.growthWithdrawal.findUnique({ where: { id }, include: { partner: { select: { userId: true } } } });
        if (!w) throw apiError('Withdrawal not found.', 404);
        if (w.status !== 'approved') throw apiError('Approve this withdrawal before marking it paid.', 400, 'NOT_APPROVED');
        if (!C.twoPersonRuleOk({ approvedBy: w.approvedBy, paidBy: adminId, needsSecondApproval: w.needsSecondApproval })) {
            throw apiError('This payout is a first or large one, so a different admin from the approver must pay it.', 403, 'TWO_PERSON_RULE');
        }
        const reused = await prisma.growthWithdrawal.count({ where: { payoutReference: ref, NOT: { id } } });
        if (reused) throw apiError('That transaction ID was already used for another payout.', 409, 'REFERENCE_REUSED');
        const updated = await prisma.growthWithdrawal.updateMany({ where: { id, status: 'approved' }, data: { status: 'paid', paidBy: adminId, paidAt: now(), payoutReference: ref, feeActual } });
        if (!updated.count) throw apiError('This withdrawal was just handled by someone else.', 409);
        await audit(adminId, 'withdrawal_paid', 'withdrawal', id, { amount: w.amount, reference: ref, fee: feeActual }, w.partner.userId);
        await notify(w.partner.userId, 'You have been paid', `${fmtUGX(w.amount)} was sent to your mobile money. Transaction ID ${ref}.`);
        return { ok: true };
    }

    async function reject(adminId, id, reason) {
        const why = String(reason || '').trim().slice(0, 300);
        if (why.length < 5) throw apiError('Give the partner a short reason.', 400, 'REASON_REQUIRED');
        const w = await prisma.growthWithdrawal.findUnique({ where: { id }, include: { partner: { select: { userId: true } } } });
        if (!w) throw apiError('Withdrawal not found.', 404);
        if (!['requested', 'in_review', 'approved'].includes(w.status)) throw apiError('This withdrawal was already handled.', 400);
        await prisma.growthWithdrawal.update({ where: { id }, data: { status: 'rejected', rejectReason: why } });
        await audit(adminId, 'withdrawal_rejected', 'withdrawal', id, { amount: w.amount, reason: why }, w.partner.userId);
        await notify(w.partner.userId, 'Withdrawal not sent', `${fmtUGX(w.amount)} was returned to your balance. Reason: ${why}`);
        return { ok: true };
    }

    return { request, cancel, queue, detail, approve, markPaid, reject };
}

module.exports = { createWithdrawals };
