/**
 * Admin-side operations. Permission checks live in routes (requireAdminPermission);
 * this file does the work and writes the audit trail.
 */
const R = require('./rules');
const C = require('./commission');
const { createAdminTools } = require('./adminTools');

const DAY = 86400000;

function createAdmin(ctx, partnersApi) {
    const { prisma, apiError, now, notify, audit } = ctx;

    async function overview() {
        const t = now();
        const pendingUpgrades = await prisma.growthUpgrade.count({ where: { status: 'applied' } });
        const [partners, byStage, pendingCrew, openFlags, review, queue, overdue, campaigns] = await Promise.all([
            prisma.growthPartner.groupBy({ by: ['program', 'status'], _count: { _all: true } }),
            prisma.growthReferral.groupBy({ by: ['stage'], _count: { _all: true } }),
            prisma.growthPartner.count({ where: { program: 'crew', status: 'applied' } }),
            prisma.growthFlag.count({ where: { status: 'open' } }),
            prisma.growthCommission.aggregate({ where: { status: 'review' }, _count: { _all: true }, _sum: { amount: true } }),
            prisma.growthWithdrawal.aggregate({ where: { status: { in: ['requested', 'in_review', 'approved'] } }, _count: { _all: true }, _sum: { amount: true } }),
            prisma.growthWithdrawal.count({ where: { status: { in: ['requested', 'in_review', 'approved'] }, dueBy: { lt: t } } }),
            prisma.growthCampaign.count({ where: { isActive: true, startsAt: { lte: t }, endsAt: { gte: t } } })
        ]);
        const owed = await prisma.growthCommission.aggregate({ where: { status: { in: ['held', 'available', 'review'] } }, _sum: { amount: true } });
        return {
            partners, referralsByStage: byStage, pendingCrewApplications: pendingCrew, pendingUpgrades, openFlags,
            commissionsInReview: { count: review._count._all, amount: review._sum.amount || 0 },
            payoutQueue: { count: queue._count._all, amount: queue._sum.amount || 0, overdue },
            totalOwedToPartners: owed._sum.amount || 0, liveCampaigns: campaigns
        };
    }

    /**
     * Is the program worth it? Rewards plus mobile money fees against the Seller Pass revenue of the
     * stores partners brought. Window = last COST_GUARD.windowDays days; lifetime shown alongside.
     */
    async function economics() {
        const t = now();
        const since = new Date(t.getTime() - R.COST_GUARD.windowDays * DAY);
        const [referrals, commissions, withdrawals, partners] = await Promise.all([
            prisma.growthReferral.findMany({ where: { storeId: { not: null } } }),
            prisma.growthCommission.findMany({ where: { status: { not: 'voided' } } }),
            prisma.growthWithdrawal.findMany({ where: { status: 'paid' } }),
            prisma.growthPartner.findMany({})
        ]);
        const programOf = new Map(partners.map((p) => [p.id, p.program]));
        // Revenue, rewards and paid stores are counted under the program each REFERRAL was signed up under, so a Circle member who
        // moved up to Crew does not drag their Circle-era stores into the Crew column (or the reverse). A balance adjustment with
        // no referral falls back to the member's program today.
        const refProgram = new Map(referrals.map((r) => [r.id, C.referralProgram(r, { program: programOf.get(r.partnerId) })]));
        const storeIds = referrals.map((r) => r.storeId);
        const payments = storeIds.length ? await prisma.subscriptionPayment.findMany({ where: { storeId: { in: storeIds }, status: 'approved' } }) : [];
        const storeProgram = new Map(referrals.map((r) => [r.storeId, refProgram.get(r.id)]));

        const inWindow = (d) => d && new Date(d) >= since;
        const blank = () => ({ revenue: 0, rewards: 0, fees: 0, storesPaid: 0 });
        const win = { all: blank(), circle: blank(), crew: blank() };
        const life = { all: blank(), circle: blank(), crew: blank() };
        const add = (bucketSet, prog, key, n) => { bucketSet.all[key] += n; if (bucketSet[prog]) bucketSet[prog][key] += n; };

        for (const p of payments) {
            const prog = storeProgram.get(p.storeId); const amt = Number(p.amount) || 0;
            add(life, prog, 'revenue', amt);
            if (inWindow(p.reviewedAt)) add(win, prog, 'revenue', amt);
        }
        for (const c of commissions) {
            if (c.amount <= 0) continue; const prog = (c.referralId && refProgram.get(c.referralId)) || programOf.get(c.partnerId);
            add(life, prog, 'rewards', c.amount);
            if (inWindow(c.createdAt)) add(win, prog, 'rewards', c.amount);
        }
        let feesEstimated = 0, feesActual = 0;
        for (const w of withdrawals) {
            const prog = programOf.get(w.partnerId); const known = w.feeActual !== null && w.feeActual !== undefined;
            const fee = known ? w.feeActual : w.feeEstimate;
            add(life, prog, 'fees', fee);
            if (inWindow(w.paidAt)) { add(win, prog, 'fees', fee); if (known) feesActual++; else feesEstimated++; }
        }
        for (const r of referrals) if (r.stage === 'paid') { const prog = refProgram.get(r.id); add(life, prog, 'storesPaid', 1); if (inWindow(r.paidAt)) add(win, prog, 'storesPaid', 1); }

        const view = (b) => {
            const cost = b.rewards + b.fees;
            const ratio = b.revenue > 0 ? cost / b.revenue : null;
            const status = ratio === null ? (cost > 0 ? 'alert' : 'none') : ratio >= R.COST_GUARD.alertAt ? 'alert' : ratio >= R.COST_GUARD.warnAt ? 'warn' : 'good';
            return { ...b, cost, ratio, kept: b.revenue - cost, status, costPerPaidStore: b.storesPaid ? Math.round(cost / b.storesPaid) : null };
        };
        return {
            windowDays: R.COST_GUARD.windowDays, warnAt: R.COST_GUARD.warnAt, alertAt: R.COST_GUARD.alertAt,
            window: { all: view(win.all), circle: view(win.circle), crew: view(win.crew) },
            lifetime: { all: view(life.all), circle: view(life.circle), crew: view(life.crew) },
            fees: { paidBy: R.PAYOUT_FEE.paidBy, actualCount: feesActual, estimatedCount: feesEstimated, note: feesEstimated ? `${feesEstimated} payout(s) in this window have an estimated fee because the real fee was not entered.` : '' }
        };
    }

    async function listPartners({ program, status, q } = {}) {
        const where = {};
        if (program) where.program = program;
        if (status) where.status = status;
        if (q) where.OR = [{ displayName: { contains: String(q), mode: 'insensitive' } }, { code: { contains: String(q).toUpperCase() } }, ...(String(q).replace(/\D/g, '').length >= 5 ? [{ phone: { contains: String(q).replace(/\D/g, '') } }] : [])];
        const rows = await prisma.growthPartner.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
        return rows.map((p) => ({ id: p.id, displayName: p.displayName, program: p.program, status: p.status, code: p.code, rankKey: p.rankKey, qualityScore: p.qualityScore, territories: p.territories, joinedAt: p.joinedAt, phone: p.phone, frozenReason: p.frozenReason }));
    }

    async function partnerDetail(id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p) throw apiError('Partner not found.', 404);
        const [stats, referrals, commissions, withdrawals, flags, user, upgrades] = await Promise.all([
            partnersApi.stats(p),
            prisma.growthReferral.findMany({ where: { partnerId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
            prisma.growthCommission.findMany({ where: { partnerId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
            prisma.growthWithdrawal.findMany({ where: { partnerId: id }, orderBy: { requestedAt: 'desc' }, take: 20 }),
            prisma.growthFlag.findMany({ where: { partnerId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
            prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, email: true, createdAt: true, accountStatus: true } }),
            prisma.growthUpgrade.findMany({ where: { partnerId: id }, orderBy: { appliedAt: 'desc' }, take: 10 })
        ]);
        const { kycFileUrl, cardPhotoUrl, ...safe } = p;   // the stored keys of the private photos never leave the server
        return { partner: { ...safe, hasKyc: !!kycFileUrl, hasCardPhoto: !!cardPhotoUrl }, user, stats, balances: C.computeBalances(commissions, withdrawals, now()), referrals, commissions, withdrawals, flags, upgrades, card: await partnersApi.cardState(p) };
    }

    async function approveCrew(adminId, id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || p.program !== 'crew') throw apiError('Crew application not found.', 404);
        if (p.status !== 'applied') throw apiError('This application was already handled.', 400);
        // Vetting must be real: one KYC photo, one phone not already on another partner.
        const dupe = await prisma.growthPartner.count({ where: { phone: p.phone, NOT: { id } } });
        if (dupe) throw apiError('Another partner account already uses this phone number. Check before approving.', 409, 'DUPLICATE_PHONE');
        await prisma.growthPartner.update({ where: { id }, data: { status: 'active', approvedBy: adminId, approvedAt: now() } });
        await audit(adminId, 'crew_approved', 'partner', id, {}, p.userId);
        await notify(p.userId, `You are in ${R.PROGRAM_LABELS.crew.name}`, `Your code is ${p.code}. Start by logging the first business you visit.`, '/crew');
        return { ok: true };
    }

    async function rejectCrew(adminId, id, reason) {
        const why = String(reason || '').trim().slice(0, 300);
        if (why.length < 5) throw apiError('Give the applicant a short, kind reason.', 400, 'REASON_REQUIRED');
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || p.status !== 'applied') throw apiError('Application not found or already handled.', 404);
        await prisma.growthPartner.update({ where: { id }, data: { status: 'rejected', frozenReason: why } });
        await audit(adminId, 'crew_rejected', 'partner', id, { reason: why }, p.userId);
        await notify(p.userId, 'About your Crew application', why, '/crew');
        return { ok: true };
    }

    async function freeze(adminId, id, reason) {
        const why = String(reason || '').trim().slice(0, 300);
        if (why.length < 5) throw apiError('Note why you are freezing this account.', 400, 'REASON_REQUIRED');
        const p = await prisma.growthPartner.update({ where: { id }, data: { status: 'frozen', frozenReason: why, frozenAt: now() } });
        await audit(adminId, 'partner_frozen', 'partner', id, { reason: why }, p.userId);
        await notify(p.userId, 'Your account is under review', 'Withdrawals are paused while our team looks at recent activity.');
        return { ok: true };
    }

    async function unfreeze(adminId, id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || p.status !== 'frozen') throw apiError('This account is not frozen.', 400);
        await prisma.growthPartner.update({ where: { id }, data: { status: 'active', frozenReason: '', frozenAt: null } });
        await audit(adminId, 'partner_unfrozen', 'partner', id, {}, p.userId);
        await notify(p.userId, 'Your account is active again', 'Withdrawals are open again.');
        return { ok: true };
    }

    /** Release a conversion the risk engine held for review (adds the normal clearance window from now). */
    async function releaseCommission(adminId, id) {
        const c = await prisma.growthCommission.findUnique({ where: { id } });
        if (!c || c.status !== 'review') throw apiError('Nothing to release here.', 404);
        if (c.paymentReviewedBy === adminId) throw apiError('You approved the payment behind this earning, so someone else must release it.', 403, 'SEPARATION_OF_DUTIES');
        await prisma.growthCommission.update({ where: { id }, data: { status: 'held', releasedBy: adminId, releasedAt: now(), clearsAt: C.clearsAtFor(now()) } });
        await audit(adminId, 'commission_released', 'commission', id, { amount: c.amount });
        return { ok: true };
    }

    async function voidCommission(adminId, id, reason) {
        const why = String(reason || '').trim().slice(0, 300);
        if (why.length < 5) throw apiError('Note why this earning is being voided.', 400, 'REASON_REQUIRED');
        const c = await prisma.growthCommission.findUnique({ where: { id } });
        if (!c || !['review', 'held'].includes(c.status)) throw apiError('Only earnings that have not cleared can be voided here. Use a reversal for cleared ones.', 400);
        await prisma.growthCommission.update({ where: { id }, data: { status: 'voided', voidReason: `admin: ${why}` } });
        await audit(adminId, 'commission_voided', 'commission', id, { amount: c.amount, reason: why });
        return { ok: true };
    }

    /** Earnings the risk engine held for a human, with the reasons it gave. */
    async function reviewQueue() {
        const rows = await prisma.growthCommission.findMany({ where: { status: 'review' }, orderBy: { createdAt: 'asc' }, take: 200 });
        const partnerIds = [...new Set(rows.map((r) => r.partnerId))];
        const refIds = [...new Set(rows.map((r) => r.referralId).filter(Boolean))];
        const [partners, refs] = await Promise.all([
            partnerIds.length ? prisma.growthPartner.findMany({ where: { id: { in: partnerIds } } }) : [],
            refIds.length ? prisma.growthReferral.findMany({ where: { id: { in: refIds } } }) : []
        ]);
        const pBy = new Map(partners.map((p) => [p.id, p])); const rBy = new Map(refs.map((r) => [r.id, r]));
        return rows.map((c) => ({
            id: c.id, amount: c.amount, type: c.type, createdAt: c.createdAt, paymentReviewedBy: c.paymentReviewedBy,
            partner: pBy.get(c.partnerId) ? { id: c.partnerId, displayName: pBy.get(c.partnerId).displayName, program: pBy.get(c.partnerId).program, code: pBy.get(c.partnerId).code } : null,
            riskScore: rBy.get(c.referralId)?.riskScore ?? 0, riskReasons: rBy.get(c.referralId)?.riskReasons ?? []
        }));
    }

    async function listFlags({ status = 'open' } = {}) {
        return prisma.growthFlag.findMany({
            where: { status }, orderBy: { createdAt: 'desc' }, take: 200,
            include: { partner: { select: { id: true, displayName: true, program: true, code: true, status: true } } }
        });
    }

    async function resolveFlag(adminId, id, { outcome, note = '' }) {
        if (!['dismissed', 'confirmed'].includes(outcome)) throw apiError('Choose dismissed or confirmed.', 400);
        const f = await prisma.growthFlag.findUnique({ where: { id } });
        if (!f || f.status !== 'open') throw apiError('Flag not found or already resolved.', 404);
        await prisma.growthFlag.update({ where: { id }, data: { status: outcome, resolvedBy: adminId, resolvedAt: now(), detail: { ...(f.detail || {}), resolutionNote: String(note).slice(0, 300) } } });
        await audit(adminId, `flag_${outcome}`, 'flag', id, { code: f.code });
        return { ok: true };
    }

    async function listCampaigns() { return prisma.growthCampaign.findMany({ orderBy: { startsAt: 'desc' }, take: 50 }); }

    async function createCampaign(adminId, body) {
        const title = String(body.title || '').trim().slice(0, 80);
        const starts = new Date(body.startsAt), ends = new Date(body.endsAt);
        const boost = Math.round(Number(body.boostPercent) || 0);
        if (title.length < 3) throw apiError('Give the campaign a name.', 400);
        if (!(starts < ends)) throw apiError('The end must be after the start.', 400);
        if (boost < 0 || boost > 50) throw apiError('A boost can be 0 to 50 percent.', 400);
        if (body.program && !R.PROGRAMS[body.program]) throw apiError('Unknown program.', 400);
        const c = await prisma.growthCampaign.create({
            data: { title, description: String(body.description || '').slice(0, 300), program: body.program || null, district: String(body.district || '').trim().toLowerCase(), boostPercent: boost, startsAt: starts, endsAt: ends, createdBy: adminId }
        });
        await audit(adminId, 'campaign_created', 'campaign', c.id, { title, boost });
        return c;
    }

    async function endCampaign(adminId, id) {
        await prisma.growthCampaign.update({ where: { id }, data: { isActive: false } });
        await audit(adminId, 'campaign_ended', 'campaign', id, {});
        return { ok: true };
    }

    async function getSettings() { return ctx.getSettings(); }

    async function updateSettings(adminId, body) {
        const data = {};
        if (typeof body.circleOpen === 'boolean') data.circleOpen = body.circleOpen;
        if (typeof body.crewOpen === 'boolean') data.crewOpen = body.crewOpen;
        if (Array.isArray(body.extraHolidays)) {
            const ok = body.extraHolidays.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
            data.extraHolidays = [...new Set(ok)].sort();
        }
        await ctx.getSettings();
        const row = await prisma.growthSettings.update({ where: { id: 'singleton' }, data });
        await audit(adminId, 'settings_updated', 'settings', 'singleton', data);
        return row;
    }

    const base = { overview, economics, listPartners, partnerDetail, approveCrew, rejectCrew, freeze, unfreeze, releaseCommission, voidCommission, reviewQueue, listFlags, resolveFlag, listCampaigns, createCampaign, endCampaign, getSettings, updateSettings };
    return { ...base, ...createAdminTools(ctx, partnersApi, base), };
}

module.exports = { createAdmin };
