/**
 * Circle -> Crew upgrades, the admin side (the member's side is partners.applyUpgrade).
 *
 * What an approval does, in one step (a database transaction), and what it deliberately does NOT do:
 *   DOES      moves the SAME partner row from Circle to Crew: program, a NEW Crew code, area, ID photo, phone; the Crew rank starts at the bottom.
 *   DOES      keeps the old Circle code in previousCodes, so every link, QR or code already shared still finds this person.
 *   KEEPS     the balance, the payout number, withdrawals, history and trust level (it is one person, one wallet).
 *   NEVER     touches an existing referral. Each one carries the program it was signed up under (GrowthReferral.program), so people who
 *             signed up before the approval stay on Circle rules for good, and only sign-ups after it are Crew. Nothing already earned,
 *             clearing or promised is re-priced in either direction.
 * A declined or withdrawn request changes nothing at all.
 */
const R = require('./rules');

const HOUR = 3600000;

function createUpgrades(ctx, partnersApi) {
    const { prisma, apiError, now, notify, audit } = ctx;
    const reasonOf = (v, min = 5) => { const s = String(v || '').trim().slice(0, 300); if (s.length < min) throw apiError('Write a short reason. The member reads it, and it is kept in the audit trail.', 400, 'REASON_REQUIRED'); return s; };

    /** The waiting list (or another status), oldest first, with what an admin needs to decide: who, their Circle record, and the vetting signals. */
    async function list({ status = 'applied' } = {}) {
        if (!['applied', 'approved', 'declined', 'withdrawn'].includes(status)) throw apiError('Unknown status.', 400);
        const rows = await prisma.growthUpgrade.findMany({ where: { status }, orderBy: { appliedAt: status === 'applied' ? 'asc' : 'desc' }, take: 100 });
        const out = [];
        const t = now();
        for (const u of rows) {
            const p = await prisma.growthPartner.findUnique({ where: { id: u.partnerId } });
            if (!p) continue;
            const [user, paidStores, samePhone, openFlags, earned] = await Promise.all([
                prisma.user.findUnique({ where: { id: p.userId }, select: { email: true, emailVerifiedAt: true, accountStatus: true } }),
                prisma.growthReferral.count({ where: { partnerId: p.id, stage: 'paid' } }),
                prisma.growthPartner.count({ where: { phone: u.phone, NOT: { id: p.id } } }),
                prisma.growthFlag.count({ where: { partnerId: p.id, status: 'open' } }),
                prisma.growthCommission.findMany({ where: { partnerId: p.id, status: { not: 'voided' } } })
            ]);
            out.push({
                id: u.id, status: u.status, partnerId: p.id, displayName: p.displayName, circleCode: u.oldCode || p.code, email: user && user.email,
                emailVerified: !!(user && user.emailVerifiedAt), partnerStatus: p.status, phone: u.phone, territories: u.territories, note: u.note,
                hasKyc: !!u.kycFileUrl, hasCardPhoto: !!u.cardPhotoUrl, appliedAt: u.appliedAt, waitingHours: Math.round((t - new Date(u.appliedAt)) / HOUR), reviewedAt: u.reviewedAt, reviewNote: u.reviewNote,
                circle: { joinedAt: p.joinedAt, paidStores, earnedLifetime: earned.reduce((s, c) => s + Math.max(0, Number(c.amount)), 0), qualityScore: p.qualityScore, openFlags },
                signals: { duplicatePhone: samePhone > 0, notInGoodStanding: p.status !== 'active', accountRestricted: !user || user.accountStatus === 'suspended' || user.accountStatus === 'banned', openFlags }
            });
        }
        return out;
    }

    async function approve(adminId, id) {
        const u = await prisma.growthUpgrade.findUnique({ where: { id } });
        if (!u || u.status !== 'applied') throw apiError('This request was already handled.', 409, 'ALREADY_HANDLED');
        const p = await prisma.growthPartner.findUnique({ where: { id: u.partnerId } });
        if (!p || p.program !== 'circle') throw apiError('This member is not in Circle any more.', 409, 'NOT_IN_CIRCLE');
        if (p.status !== 'active') throw apiError('Their Circle account is not active (frozen or closed). Clear that first, then approve.', 409, 'NOT_IN_GOOD_STANDING');
        const user = await prisma.user.findUnique({ where: { id: p.userId } });
        if (!user || !user.emailVerifiedAt || user.accountStatus === 'suspended') throw apiError('Their NextaStore account is not in good standing (email unverified or restricted).', 409, 'ACCOUNT_NOT_CLEAR');
        if (!u.kycFileUrl) throw apiError('No ID photo on file. Do not approve without one.', 409, 'KYC_REQUIRED');
        const dupe = await prisma.growthPartner.count({ where: { phone: u.phone, NOT: { id: p.id } } });
        if (dupe) throw apiError('Another partner account already uses this phone number. Check before approving.', 409, 'DUPLICATE_PHONE');

        const newCode = await partnersApi.uniqueCode('crew');
        const t = now();
        await prisma.$transaction(async (tx) => {
            // Claim the request first: of two admins pressing Approve together, only one gets past this line.
            const claimed = await tx.growthUpgrade.updateMany({ where: { id, status: 'applied' }, data: { status: 'approved', reviewedBy: adminId, reviewedAt: t, oldCode: p.code, newCode } });
            if (!claimed.count) throw apiError('This request was just handled by someone else.', 409, 'ALREADY_HANDLED');
            // ...and move the member only if they are still a Circle member in good standing at this very moment.
            const moved = await tx.growthPartner.updateMany({
                where: { id: p.id, program: 'circle', status: 'active' },
                data: { program: 'crew', code: newCode, previousCodes: { push: p.code }, rankKey: 'trailhead', territories: u.territories, kycFileUrl: u.kycFileUrl, cardPhotoUrl: u.cardPhotoUrl || null, phone: u.phone, applicationNote: u.note, upgradedAt: t, upgradedFrom: 'circle' }
            });
            if (!moved.count) throw apiError('Their account changed while you were approving. Please look again.', 409, 'CHANGED');
        });
        await audit(adminId, 'upgrade_approved', 'partner', p.id, { upgradeId: id, oldCode: p.code, newCode }, p.userId);
        await notify(p.userId, `You are in ${R.PROGRAM_LABELS.crew.name}`, `Your new code is ${newCode}. Your old Circle code and link still work, so nothing you shared has stopped. Sign-ups from today count as Crew; stores that signed up before stay under Circle terms.`, '/crew');
        await partnersApi.refresh(p.id);
        return { ok: true, newCode, oldCode: p.code };
    }

    async function decline(adminId, id, reason) {
        const why = reasonOf(reason);
        const u = await prisma.growthUpgrade.findUnique({ where: { id } });
        if (!u || u.status !== 'applied') throw apiError('This request was already handled.', 409, 'ALREADY_HANDLED');
        const out = await prisma.growthUpgrade.updateMany({ where: { id, status: 'applied' }, data: { status: 'declined', reviewedBy: adminId, reviewedAt: now(), reviewNote: why } });
        if (!out.count) throw apiError('This request was just handled by someone else.', 409, 'ALREADY_HANDLED');
        const p = await prisma.growthPartner.findUnique({ where: { id: u.partnerId } });
        await audit(adminId, 'upgrade_declined', 'partner', u.partnerId, { upgradeId: id, reason: why }, p && p.userId);
        if (p) await notify(p.userId, 'About your Crew application', `${why} ${R.PROGRAM_LABELS.circle.name} carries on exactly as before. You can ask again after ${R.UPGRADE.reapplyAfterDays} days.`, '/circle');
        return { ok: true };
    }

    /** A declined (or withdrawn) request put back on the waiting list, e.g. the decision was a mistake. */
    async function reopen(adminId, id, note) {
        const why = reasonOf(note);
        const u = await prisma.growthUpgrade.findUnique({ where: { id } });
        if (!u || !['declined', 'withdrawn'].includes(u.status)) throw apiError('Only a declined or withdrawn request can be reopened.', 409);
        const p = await prisma.growthPartner.findUnique({ where: { id: u.partnerId } });
        if (!p || p.program !== 'circle') throw apiError('This member is not in Circle any more.', 409, 'NOT_IN_CIRCLE');
        try { await prisma.growthUpgrade.updateMany({ where: { id, status: u.status }, data: { status: 'applied', reviewedAt: null, reviewedBy: null, reviewNote: '' } }); }
        catch (err) { if (err && err.code === 'P2002') throw apiError('They already have another open request.', 409); throw err; }
        await audit(adminId, 'upgrade_reopened', 'partner', p.id, { upgradeId: id, note: why }, p.userId);
        await notify(p.userId, 'Your Crew application is being looked at again', `Our team is reviewing it again, within ${R.REVIEW.applicationWorkingDays} working days.`, '/circle');
        return { ok: true };
    }

    /** The ID photo that came with an upgrade request (same private store as every other ID). */
    async function kycFor(id) {
        const u = await prisma.growthUpgrade.findUnique({ where: { id } });
        if (!u || !u.kycFileUrl) return null;
        const p = await prisma.growthPartner.findUnique({ where: { id: u.partnerId }, select: { userId: true } });
        return { key: u.kycFileUrl, userId: p && p.userId };
    }

    return { list, approve, decline, reopen, kycFor };
}

module.exports = { createUpgrades };
