/**
 * Partner lifecycle and the dashboard payloads.
 * Circle members start active at once. Scouts apply, are vetted, then start.
 */
const R = require('./rules');
const C = require('./commission');
const K = require('./risk');
const S = require('./stages');
const W = require('./workingDays');

const DAY = 86400000;

function createPartners(ctx) {
    const { prisma, apiError, now, notify, audit } = ctx;

    async function uniqueCode(program) {
        for (let i = 0; i < 8; i++) {
            const code = C.generatePartnerCode(program);
            if (!(await prisma.growthPartner.findUnique({ where: { code } }))) return code;
        }
        throw apiError('Could not create a code right now. Please try again.', 503);
    }

    async function assertOpen(program) {
        const s = await ctx.getSettings();
        if (program === 'circle' && !s.circleOpen) throw apiError(`${R.PROGRAM_LABELS.circle.name} is not taking new members right now.`, 403, 'PROGRAM_CLOSED');
        if (program === 'scout' && !s.scoutsOpen) throw apiError(`${R.PROGRAM_LABELS.scout.name} is not taking applications right now.`, 403, 'PROGRAM_CLOSED');
        return s;
    }

    async function assertNotAlreadyPartner(userId) {
        const existing = await prisma.growthPartner.findUnique({ where: { userId } });
        if (existing) throw apiError(`You are already in ${R.PROGRAM_LABELS[existing.program].name}.`, 409, 'ALREADY_PARTNER');
    }

    /** Anyone with a verified email can join the Circle. */
    async function joinCircle(user, { phone = '', ip = '', agreedTerms = false } = {}) {
        if (!agreedTerms) throw apiError(`Please accept the ${R.PROGRAM_LABELS.circle.name} terms to join.`, 400, 'TERMS_REQUIRED');
        if (!user.emailVerifiedAt) throw apiError(`Verify your email first, then join ${R.PROGRAM_LABELS.circle.name}.`, 403, 'EMAIL_UNVERIFIED');
        if (user.accountStatus === 'suspended') throw apiError('This account cannot join right now.', 403);
        if (user.role === 'admin') throw apiError('Admin accounts cannot join the program.', 403);
        const settings = await assertOpen('circle');
        await assertNotAlreadyPartner(user.id);
        const partner = await prisma.growthPartner.create({
            data: {
                userId: user.id, program: 'circle', status: 'active', code: await uniqueCode('circle'),
                displayName: user.name, phone: K.normalizePhone(phone), signupIpPrefix: K.ipPrefix(ip),
                usualIpPrefixes: ip ? [K.ipPrefix(ip)] : [], agreedTermsVersion: settings.termsVersion, agreedTermsAt: now()
            }
        });
        await notify(user.id, `Welcome to ${R.PROGRAM_LABELS.circle.name}`, `Your code is ${partner.code}. Share it with a store owner you know.`, '/circle');
        return partner;
    }

    /** Scouts apply; an admin with growth.review approves. */
    async function applyScout(user, { phone, territories = [], note = '', kycFileUrl = null, ip = '', agreedTerms = false } = {}) {
        if (!agreedTerms) throw apiError(`Please accept the ${R.PROGRAM_LABELS.scout.name} terms to apply.`, 400, 'TERMS_REQUIRED');
        if (!user.emailVerifiedAt) throw apiError('Verify your email first, then apply.', 403, 'EMAIL_UNVERIFIED');
        if (user.role === 'admin') throw apiError('Admin accounts cannot join the program.', 403);
        const cleanPhone = K.normalizePhone(phone);
        if (cleanPhone.length !== 12) throw apiError('Enter a valid Ugandan phone number.', 400, 'BAD_PHONE');
        if (!kycFileUrl) throw apiError('Upload a clear photo of your national ID so we can verify you.', 400, 'KYC_REQUIRED');
        const picks = [...new Set(territories.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, R.TERRITORIES.maxPerScout);
        if (!picks.length) throw apiError('Choose at least one area you will cover.', 400, 'TERRITORY_REQUIRED');
        const settings = await assertOpen('scout');
        await assertNotAlreadyPartner(user.id);
        const partner = await prisma.growthPartner.create({
            data: {
                userId: user.id, program: 'scout', status: 'applied', code: await uniqueCode('scout'), displayName: user.name,
                phone: cleanPhone, territories: picks, kycFileUrl, applicationNote: String(note).slice(0, 600),
                signupIpPrefix: K.ipPrefix(ip), agreedTermsVersion: settings.termsVersion, agreedTermsAt: now()
            }
        });
        await notify(user.id, 'Application received', 'Our team reviews Crew applications within two working days. We will notify you here.', '/crew');
        return partner;
    }

    async function setPayout(user, { network, number, name }) {
        const partner = await getPartnerOrThrow(user.id);
        if (!R.WITHDRAWAL.networks.includes(network)) throw apiError('Choose MTN MoMo or Airtel Money.', 400, 'BAD_NETWORK');
        const clean = K.normalizePhone(number);
        if (clean.length !== 12) throw apiError('Enter a valid Ugandan mobile money number.', 400, 'BAD_PHONE');
        const cleanName = String(name || '').trim().slice(0, 80);
        if (cleanName.length < 3) throw apiError('Enter the name registered on that mobile money account.', 400, 'NAME_REQUIRED');
        const taken = await prisma.growthPartner.count({ where: { payoutNumber: clean, NOT: { id: partner.id } } });
        if (taken) throw apiError('That number is already used by another account. Contact support if this is yours.', 409, 'PAYOUT_NUMBER_IN_USE');
        const changed = partner.payoutNumber && partner.payoutNumber !== clean;
        const first = !partner.payoutNumber;
        await prisma.growthPartner.update({
            where: { id: partner.id },
            data: { payoutNetwork: network, payoutNumber: clean, payoutName: cleanName, payoutNumberChangedAt: (changed || first) ? now() : partner.payoutNumberChangedAt }
        });
        if (changed) {
            await notify(user.id, 'Payout number changed', `Withdrawals are paused for ${R.WITHDRAWAL.payoutNumberChangeLockHours} hours as a safety step. If this was not you, change your password and contact us.`);
        }
        // The pause applies to a first number too (payoutNumberChangedAt is set above), so say so in both cases.
        const lockHours = (changed || first) ? R.WITHDRAWAL.payoutNumberChangeLockHours : 0;
        return { ok: true, lockHours, first: !!first };
    }

    async function getPartnerOrThrow(userId) {
        const partner = await prisma.growthPartner.findUnique({ where: { userId } });
        if (!partner) throw apiError('You have not joined the program yet.', 404, 'NOT_A_PARTNER');
        return partner;
    }

    /** Stats that drive rank, quality and trust. Cheap enough to run after every conversion. */
    async function stats(partner) {
        const since90 = new Date(now().getTime() - R.RANK_WINDOW_DAYS * DAY);
        const [signups, cleared, cleared90d, reversed, flagged, openFlags, renewed, eligible] = await Promise.all([
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: { not: 'lead' } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid' } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid', paidAt: { gte: since90 } } }),
            prisma.growthCommission.count({ where: { partnerId: partner.id, type: 'first_payment', status: 'voided', voidReason: { startsWith: 'reversed' } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, riskDecision: { not: 'clear' } } }),
            prisma.growthFlag.count({ where: { partnerId: partner.id, status: 'open' } }),
            prisma.growthCommission.count({ where: { partnerId: partner.id, type: 'renewal', status: { not: 'voided' } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid', paidAt: { lte: new Date(now().getTime() - 30 * DAY) } } })
        ]);
        const quality = C.qualityScore({ signups, cleared, reversed, flagged, renewed, eligibleForRenewal: eligible });
        return { signups, cleared, cleared90d, reversed, flagged, openFlags, quality };
    }

    /** Recompute rank + quality and save them. Returns the fresh numbers. */
    async function refresh(partnerId) {
        const partner = await prisma.growthPartner.findUnique({ where: { id: partnerId } });
        if (!partner) return null;
        const st = await stats(partner);
        let rankKey = partner.rankKey;
        if (partner.program === 'scout') {
            const next = C.effectiveRank(st.cleared90d, st.quality, partner.rankKey).key;
            if (next !== partner.rankKey) {
                rankKey = next;
                const up = R.SCOUT_RANKS.findIndex((r) => r.key === next) > R.SCOUT_RANKS.findIndex((r) => r.key === partner.rankKey);
                if (up) await notify(partner.userId, `You are now a ${R.SCOUT_RANKS.find((r) => r.key === next).label}`, 'Your commission rate just went up on every new store.', '/crew');
            }
        }
        await prisma.growthPartner.update({ where: { id: partnerId }, data: { qualityScore: st.quality, rankKey } });
        return { ...st, rankKey };
    }

    /** What the dashboard shows. Never exposes emails or phone numbers of sign-ups. */
    async function dashboard(user) {
        const partner = await getPartnerOrThrow(user.id);
        const t = now();
        const [referrals, commissions, withdrawals, st, holidays] = await Promise.all([
            prisma.growthReferral.findMany({ where: { partnerId: partner.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
            prisma.growthCommission.findMany({ where: { partnerId: partner.id }, orderBy: { createdAt: 'desc' }, take: 300 }),
            prisma.growthWithdrawal.findMany({ where: { partnerId: partner.id }, orderBy: { requestedAt: 'desc' }, take: 50 }),
            stats(partner),
            ctx.holidays()
        ]);
        const storeIds = referrals.map((r) => r.storeId).filter(Boolean);
        const stores = storeIds.length ? await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, district: true, trialEndsAt: true } }) : [];
        const storeById = new Map(stores.map((s) => [s.id, s]));

        const trust = C.trustLevel({ joinedAt: partner.approvedAt || partner.joinedAt, clearedConversions: st.cleared, qualityScore: st.quality, openFlags: st.openFlags, frozen: partner.status === 'frozen' }, t);
        const balances = C.computeBalances(commissions, withdrawals, t);
        const limits = R.TRUST_LEVELS[trust];

        const commByRef = new Map();
        for (const c of commissions) {
            if (!c.referralId || c.status === 'voided') continue;
            const cur = commByRef.get(c.referralId) || { amount: 0, status: c.status, clearsAt: c.clearsAt };
            cur.amount += c.amount;
            if (c.status === 'review') cur.status = 'review';
            commByRef.set(c.referralId, cur);
        }

        const recruits = S.sortForRecruiter(referrals.filter((r) => r.stage !== 'void' && !(r.stage === 'lapsed' && !r.recruitUserId)).map((r) => {
            const store = r.storeId ? storeById.get(r.storeId) : null;
            const comm = commByRef.get(r.id);
            const hint = S.describe({
                stage: r.stage, program: partner.program, signedUpAt: r.signedUpAt, storeLiveAt: r.storeLiveAt,
                paymentSubmittedAt: r.paymentSubmittedAt, trialEndsAt: store?.trialEndsAt, lockExpiresAt: r.leadLockExpiresAt,
                lastAskedAt: r.lastAskedAt, commissionStatus: comm?.status || null, commissionAmount: comm?.amount || 0, clearsAt: comm?.clearsAt
            }, t);
            return {
                id: r.id,
                name: store?.name || r.leadBusiness || 'New sign-up',
                contactName: r.stage === 'lead' || r.source === 'lead' ? r.leadContactName : '',
                district: store?.district || r.leadDistrict || '',
                since: r.signedUpAt || r.createdAt,
                earning: comm?.amount || 0,
                ...hint
            };
        }));

        const rank = partner.program === 'scout' ? R.SCOUT_RANKS.find((r) => r.key === partner.rankKey) || R.SCOUT_RANKS[0] : null;
        const openWithdrawal = withdrawals.find((w) => ['requested', 'in_review', 'approved'].includes(w.status));
        return {
            partner: {
                program: partner.program, programName: R.PROGRAM_LABELS[partner.program].name, programDescriptor: R.PROGRAM_LABELS[partner.program].descriptor, status: partner.status, code: partner.code,
                displayName: partner.displayName, territories: partner.territories, joinedAt: partner.joinedAt,
                payout: partner.payoutNumber ? { network: partner.payoutNetwork, number: maskNumber(partner.payoutNumber), name: partner.payoutName, lockedUntil: payoutLockedUntil(partner, t) } : null,
                frozen: partner.status === 'frozen', frozenReason: partner.status === 'frozen' ? 'We are reviewing your account. Our team will reach out.' : ''
            },
            rank: rank && { key: rank.key, label: rank.label, ratePercent: Math.round(rank.rate * 100), next: C.nextRank(rank, st.cleared90d), cleared90d: st.cleared90d },
            ratePercent: rank ? Math.round(rank.rate * 100) : Math.round(R.COMMISSION.circle.rate * 100),
            quality: st.quality,
            trust: { key: trust, label: limits.label, perRequestMax: limits.perRequestMax, dailyMax: limits.dailyMax, monthlyMax: limits.monthlyMax, minGapDays: limits.minGapDays },
            balances,
            clearanceDays: R.CLEARANCE.days,
            withdrawal: {
                min: R.WITHDRAWAL.minAmount,
                payoutChangeLockHours: R.WITHDRAWAL.payoutNumberChangeLockHours,
                feeOnUs: R.PAYOUT_FEE.paidBy === 'nextastore',   // the partner receives the full amount; NextaStore pays the mobile money fee
                nextAllowedAt: nextWithdrawalAt(withdrawals, limits, t),
                open: openWithdrawal ? { id: openWithdrawal.id, amount: openWithdrawal.amount, status: openWithdrawal.status, dueBy: openWithdrawal.dueBy, dueByText: W.formatDueBy(openWithdrawal.dueBy), overdue: W.isOverdue(openWithdrawal.dueBy, t) } : null,
                history: withdrawals.slice(0, 10).map((w) => ({ id: w.id, amount: w.amount, status: w.status, requestedAt: w.requestedAt, paidAt: w.paidAt, rejectReason: w.rejectReason }))
            },
            earnings: commissions.filter((c) => c.status !== 'voided').slice(0, 30).map((c) => ({ id: c.id, type: c.type, amount: c.amount, status: c.status === 'held' && c.clearsAt && new Date(c.clearsAt) <= t ? 'available' : c.status, clearsAt: c.clearsAt, note: c.note, createdAt: c.createdAt })),
            summary: S.summarize(recruits),
            recruits,
            rules: { holidays: holidays.length }
        };
    }

    /** When the spacing rule next lets this partner withdraw (null = now). */
    function nextWithdrawalAt(withdrawals, limits, t) {
        const last = withdrawals.filter((w) => !['rejected', 'cancelled'].includes(w.status)).map((w) => new Date(w.requestedAt).getTime()).sort((a, b) => b - a)[0];
        if (!last) return null;
        const at = last + limits.minGapDays * DAY;
        return at > t.getTime() ? new Date(at) : null;
    }

    function maskNumber(n) { return n ? `${n.slice(0, 5)}•••${n.slice(-3)}` : ''; }
    function payoutLockedUntil(partner, t) {
        if (!partner.payoutNumberChangedAt) return null;
        const until = new Date(new Date(partner.payoutNumberChangedAt).getTime() + R.WITHDRAWAL.payoutNumberChangeLockHours * 3600 * 1000);
        return until > t ? until : null;
    }

    /** Scout Trail Map: where the marketplace is thin and where this Scout already has footprints. */
    async function trailMap(user) {
        const partner = await getPartnerOrThrow(user.id);
        if (partner.program !== 'scout') throw apiError('The Trail Map is for the Crew.', 403);
        const [supply, mine] = await Promise.all([
            prisma.store.groupBy({ by: ['district'], where: { isPublished: true, deletedAt: null, district: { not: '' } }, _count: { _all: true } }),
            prisma.growthReferral.groupBy({ by: ['leadDistrict', 'stage'], where: { partnerId: partner.id }, _count: { _all: true } })
        ]);
        const supplyBy = new Map(supply.map((s) => [s.district, s._count._all]));
        const districts = new Set([...supplyBy.keys(), ...partner.territories]);
        const footprint = new Map();
        for (const row of mine) {
            const d = row.leadDistrict || '';
            if (!d) continue;
            const cur = footprint.get(d) || { leads: 0, paid: 0 };
            cur.leads += row._count._all; if (row.stage === 'paid') cur.paid += row._count._all;
            footprint.set(d, cur);
        }
        const rows = [...districts].map((district) => ({
            district, liveStores: supplyBy.get(district) || 0, yours: footprint.get(district) || { leads: 0, paid: 0 }, inYourTerritory: partner.territories.includes(district)
        }));
        // Thin supply in your own area first: the best place to walk today.
        rows.sort((a, b) => (Number(b.inYourTerritory) - Number(a.inYourTerritory)) || (a.liveStores - b.liveStores));
        return { territories: partner.territories, districts: rows };
    }

    /** Small payload for widgets (seller dashboard card, nav badge). Works for non-partners too. */
    async function summary(user) {
        const partner = await prisma.growthPartner.findUnique({ where: { userId: user.id } });
        if (!partner) {
            const settings = await ctx.getSettings();
            return { joined: false, open: { circle: settings.circleOpen, scout: settings.scoutsOpen } };
        }
        if (!['active', 'frozen'].includes(partner.status)) return { joined: true, program: partner.program, status: partner.status };
        const d = await dashboard(user);
        return { joined: true, program: partner.program, status: partner.status, code: partner.code, ratePercent: d.ratePercent, available: Math.max(0, d.balances.available), pending: d.balances.pending, needsYou: d.summary.needsYou, recruits: d.summary.total };
    }

    /**
     * Market Days: campaigns this partner can take part in (live now, or starting within a week), with
     * their own count and a small leaderboard of the same program. First names and counts only.
     */
    async function campaigns(user) {
        const partner = await getPartnerOrThrow(user.id);
        const t = now();
        const rows = await prisma.growthCampaign.findMany({ where: { isActive: true, endsAt: { gte: t } }, orderBy: { startsAt: 'asc' } });
        const out = [];
        for (const c of rows) {
            if (c.program && c.program !== partner.program) continue;
            const live = new Date(c.startsAt) <= t;
            if (!live && new Date(c.startsAt) - t > 7 * DAY) continue;
            const item = { id: c.id, title: c.title, description: c.description, boostPercent: c.boostPercent, district: c.district, startsAt: c.startsAt, endsAt: c.endsAt, live, mine: 0, rank: null, board: [] };
            if (live) {
                let refs = await prisma.growthReferral.findMany({ where: { stage: 'paid', paidAt: { gte: c.startsAt, lte: c.endsAt } } });
                if (c.district) {
                    const ids = refs.map((r) => r.storeId).filter(Boolean);
                    const stores = ids.length ? await prisma.store.findMany({ where: { id: { in: ids } }, select: { id: true, district: true } }) : [];
                    const inDistrict = new Set(stores.filter((x) => x.district === c.district).map((x) => x.id));
                    refs = refs.filter((r) => inDistrict.has(r.storeId));
                }
                const people = refs.length ? await prisma.growthPartner.findMany({ where: { id: { in: [...new Set(refs.map((r) => r.partnerId))] } } }) : [];
                const byId = new Map(people.filter((p) => p.program === partner.program).map((p) => [p.id, p]));
                const counts = new Map();
                for (const r of refs) if (byId.has(r.partnerId)) counts.set(r.partnerId, (counts.get(r.partnerId) || 0) + 1);
                const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
                item.mine = counts.get(partner.id) || 0;
                const pos = ranked.findIndex(([id]) => id === partner.id);
                item.rank = pos >= 0 ? pos + 1 : null;
                item.board = ranked.slice(0, R.FIELD.leaderboardSize).map(([id, count]) => ({ firstName: String(byId.get(id).displayName).split(' ')[0], count, you: id === partner.id }));
            }
            out.push(item);
        }
        return out;
    }

    return { joinCircle, applyScout, setPayout, getPartnerOrThrow, refresh, stats, dashboard, summary, campaigns, trailMap, uniqueCode };
}

module.exports = { createPartners };
