/**
 * Partner lifecycle and the dashboard payloads.
 * Circle members start active at once. Crew members apply, are vetted, then start.
 */
const R = require('./rules');
const C = require('./commission');
const K = require('./risk');
const S = require('./stages');
const W = require('./workingDays');

const DAY = 86400000;

function createPartners(ctx) {
    const { prisma, apiError, now, notify, audit } = ctx;

    /**
     * The one way to turn a typed / linked code into a partner. A code is either someone's current code or one they used before an
     * upgrade (previousCodes), so a link shared while they were in Circle still finds them after they move to Crew.
     */
    async function findByCode(code) {
        if (!code) return null;
        return (await prisma.growthPartner.findUnique({ where: { code } }))
            || (await prisma.growthPartner.findFirst({ where: { previousCodes: { has: code } } }));
    }

    async function uniqueCode(program) {
        for (let i = 0; i < 8; i++) {
            const code = C.generatePartnerCode(program);
            // Never reissue a code someone used to have: it still points at them.
            if (!(await findByCode(code))) return code;
        }
        throw apiError('Could not create a code right now. Please try again.', 503);
    }

    async function assertOpen(program) {
        const s = await ctx.getSettings();
        if (program === 'circle' && !s.circleOpen) throw apiError(`${R.PROGRAM_LABELS.circle.name} is not taking new members right now.`, 403, 'PROGRAM_CLOSED');
        if (program === 'crew' && !s.crewOpen) throw apiError(`${R.PROGRAM_LABELS.crew.name} is not taking applications right now.`, 403, 'PROGRAM_CLOSED');
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

    /** Crew members apply; an admin with growth.review approves. */
    async function applyCrew(user, { phone, territories = [], note = '', kycFileUrl = null, cardPhotoUrl = null, ip = '', agreedTerms = false } = {}) {
        if (!agreedTerms) throw apiError(`Please accept the ${R.PROGRAM_LABELS.crew.name} terms to apply.`, 400, 'TERMS_REQUIRED');
        if (!user.emailVerifiedAt) throw apiError('Verify your email first, then apply.', 403, 'EMAIL_UNVERIFIED');
        const cleanPhone = K.normalizePhone(phone);
        if (cleanPhone.length !== 12) throw apiError('Enter a valid Ugandan phone number.', 400, 'BAD_PHONE');
        if (!kycFileUrl) throw apiError('Upload a clear photo of your national ID so we can verify you.', 400, 'KYC_REQUIRED');
        if (!cardPhotoUrl) throw apiError('Add a clear photo of your face for your Crew ID card.', 400, 'CARD_PHOTO_REQUIRED');
        const picks = [...new Set(territories.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, R.TERRITORIES.maxPerMember);
        if (!picks.length) throw apiError('Choose at least one area you will cover.', 400, 'TERRITORY_REQUIRED');
        const settings = await assertOpen('crew');
        await assertNotAlreadyPartner(user.id);
        const partner = await prisma.growthPartner.create({
            data: {
                userId: user.id, program: 'crew', status: 'applied', code: await uniqueCode('crew'), displayName: user.name,
                phone: cleanPhone, territories: picks, kycFileUrl, cardPhotoUrl: cardPhotoUrl || null, applicationNote: String(note).slice(0, 600),
                signupIpPrefix: K.ipPrefix(ip), agreedTermsVersion: settings.termsVersion, agreedTermsAt: now()
            }
        });
        await notify(user.id, 'Application received', `Our team reviews Crew applications within ${R.REVIEW.applicationWorkingDays} working days. We will notify you here.`, '/crew');
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
        // A Crew rank is earned by stores paid under Crew rules. Stores that signed up through the Circle link before an upgrade
        // were paid as Circle and do not count toward it (they still count everywhere else: sign-ups, quality, history).
        const rankScope = partner.program === 'crew' ? { OR: [{ program: 'crew' }, { program: null }] } : {};
        const [signups, cleared, cleared90d, reversed, flagged, openFlags, renewed, eligible] = await Promise.all([
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: { not: 'lead' } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid' } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid', paidAt: { gte: since90 }, ...rankScope } }),
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
        if (partner.program === 'crew') {
            const next = C.effectiveRank(st.cleared90d, st.quality, partner.rankKey).key;
            if (next !== partner.rankKey) {
                rankKey = next;
                const up = R.CREW_RANKS.findIndex((r) => r.key === next) > R.CREW_RANKS.findIndex((r) => r.key === partner.rankKey);
                if (up) await notify(partner.userId, `You are now a ${R.CREW_RANKS.find((r) => r.key === next).label}`, 'Your commission rate just went up on every new store.', '/crew');
            }
        }
        await prisma.growthPartner.update({ where: { id: partnerId }, data: { qualityScore: st.quality, rankKey } });
        return { ...st, rankKey };
    }

    /**
     * The Crew ID card's state for one member.
     *   unlocked  false until the member has logged R.CREW_CARD.unlockLeads businesses, or an admin released it
     *   by        'admin' | 'target' | null: why it is unlocked
     * Computed on every read (no job to run, nothing to drift): releasing early is one timestamp on the member.
     */
    async function cardState(partner) {
        if (partner.program !== 'crew') return null;
        const needed = R.CREW_CARD.unlockLeads;
        const leads = await prisma.growthReferral.count({ where: { partnerId: partner.id, source: 'lead' } });
        const byAdmin = !!partner.cardIssuedAt;
        const byTarget = leads >= needed;
        return { unlocked: byAdmin || byTarget, by: byAdmin ? 'admin' : (byTarget ? 'target' : null), leads: Math.min(leads, needed), needed, hasPhoto: !!partner.cardPhotoUrl, issuedAt: partner.cardIssuedAt || null };
    }

    /** What the dashboard shows. Never exposes emails or phone numbers of sign-ups. */
    async function dashboard(user) {
        const partner = await getPartnerOrThrow(user.id);
        const t = now();
        const [referrals, commissions, withdrawals, st, holidays, upgrades, settings] = await Promise.all([
            prisma.growthReferral.findMany({ where: { partnerId: partner.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
            prisma.growthCommission.findMany({ where: { partnerId: partner.id }, orderBy: { createdAt: 'desc' }, take: 300 }),
            prisma.growthWithdrawal.findMany({ where: { partnerId: partner.id }, orderBy: { requestedAt: 'desc' }, take: 50 }),
            stats(partner),
            ctx.holidays(),
            prisma.growthUpgrade.findMany({ where: { partnerId: partner.id }, orderBy: { appliedAt: 'desc' }, take: 5 }),
            ctx.getSettings()
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
                stage: r.stage, program: C.referralProgram(r, partner), signedUpAt: r.signedUpAt, storeLiveAt: r.storeLiveAt,
                paymentSubmittedAt: r.paymentSubmittedAt, trialEndsAt: store?.trialEndsAt, lockExpiresAt: r.leadLockExpiresAt,
                lastAskedAt: r.lastAskedAt, commissionStatus: comm?.status || null, commissionAmount: comm?.amount || 0, clearsAt: comm?.clearsAt
            }, t);
            return {
                id: r.id,
                program: C.referralProgram(r, partner),   // which program's rules pay this one (it can differ from the partner's own after an upgrade)
                name: store?.name || r.leadBusiness || 'New sign-up',
                contactName: r.stage === 'lead' || r.source === 'lead' ? r.leadContactName : '',
                district: store?.district || r.leadDistrict || '',
                since: r.signedUpAt || r.createdAt,
                earning: comm?.amount || 0,
                ...hint
            };
        }));

        const rank = partner.program === 'crew' ? R.CREW_RANKS.find((r) => r.key === partner.rankKey) || R.CREW_RANKS[0] : null;
        const openWithdrawal = withdrawals.find((w) => ['requested', 'in_review', 'approved'].includes(w.status));
        return {
            partner: {
                program: partner.program, programName: R.PROGRAM_LABELS[partner.program].name, programDescriptor: R.PROGRAM_LABELS[partner.program].descriptor, status: partner.status, code: partner.code,
                displayName: partner.displayName, territories: partner.territories, joinedAt: partner.joinedAt,
                upgradedFrom: partner.upgradedFrom || null, upgradedAt: partner.upgradedAt || null, previousCodes: partner.previousCodes || [],
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
                first: firstWithdrawalState(partner, withdrawals, st, t),
                open: openWithdrawal ? { id: openWithdrawal.id, amount: openWithdrawal.amount, status: openWithdrawal.status, dueBy: openWithdrawal.dueBy, dueByText: W.formatDueBy(openWithdrawal.dueBy), overdue: W.isOverdue(openWithdrawal.dueBy, t) } : null,
                history: withdrawals.slice(0, 10).map((w) => ({ id: w.id, amount: w.amount, status: w.status, requestedAt: w.requestedAt, paidAt: w.paidAt, rejectReason: w.rejectReason }))
            },
            earnings: commissions.filter((c) => c.status !== 'voided').slice(0, 30).map((c) => ({ id: c.id, type: c.type, amount: c.amount, status: c.status === 'held' && c.clearsAt && new Date(c.clearsAt) <= t ? 'available' : c.status, clearsAt: c.clearsAt, note: c.note, createdAt: c.createdAt })),
            summary: S.summarize(recruits),
            recruits,
            rules: { holidays: holidays.length },
            upgrade: upgradeState(partner, upgrades, settings, t),
            card: partner.status === 'active' || partner.status === 'frozen' ? await cardState(partner) : null
        };
    }

    /**
     * Where a Circle member stands on moving up to Crew (and, for someone who already did, what changed).
     *   none        not applicable (Crew from day one, or a Circle member who is not in good standing)
     *   available   can ask now
     *   pending     asked, waiting; Circle works as normal meanwhile
     *   declined    the last request was declined; Circle works as normal; canReapplyAt says when they may ask again
     *   upgraded    now in Crew; the old Circle code keeps working
     */
    function upgradeState(partner, upgrades, settings, t) {
        if (partner.program === 'crew') {
            return partner.upgradedFrom
                ? { state: 'upgraded', from: partner.upgradedFrom, at: partner.upgradedAt, previousCodes: partner.previousCodes || [] }
                : { state: 'none' };
        }
        if (!['active', 'frozen'].includes(partner.status)) return { state: 'none' };
        const open = !!settings.crewOpen;
        const pending = upgrades.find((u) => u.status === 'applied');
        if (pending) return { state: 'pending', open, appliedAt: pending.appliedAt, reviewWorkingDays: R.REVIEW.applicationWorkingDays };
        const declined = upgrades.find((u) => u.status === 'declined');
        const canReapplyAt = declined && declined.reviewedAt ? new Date(new Date(declined.reviewedAt).getTime() + R.UPGRADE.reapplyAfterDays * DAY) : null;
        const waiting = canReapplyAt && canReapplyAt > t;
        const base = { open, canApply: open && partner.status === 'active' && !waiting, frozen: partner.status === 'frozen' };
        if (declined) return { state: 'declined', ...base, reason: declined.reviewNote || '', reviewedAt: declined.reviewedAt, canReapplyAt: waiting ? canReapplyAt : null };
        return { state: 'available', ...base };
    }

    /** The extra conditions on a partner's very first withdrawal (mirrors checkWithdrawal): null once they have been paid or approved before. */
    function firstWithdrawalState(partner, withdrawals, st, t) {
        if (withdrawals.some((w) => w.status === 'paid' || w.status === 'approved')) return null;
        const opensAt = new Date(new Date(partner.joinedAt).getTime() + R.WITHDRAWAL.firstWithdrawalAfterDays * DAY);
        return { opensAt: opensAt > t ? opensAt : null, needsStore: st.cleared < R.WITHDRAWAL.firstWithdrawalNeedsClearedConversions, afterDays: R.WITHDRAWAL.firstWithdrawalAfterDays };
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

    /** Crew Trail Map: where the marketplace is thin and where this Crew member already has footprints. */
    async function trailMap(user) {
        const partner = await getPartnerOrThrow(user.id);
        if (partner.program !== 'crew') throw apiError('The Trail Map is for the Crew.', 403);
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
            return { joined: false, open: { circle: settings.circleOpen, crew: settings.crewOpen } };
        }
        if (!['active', 'frozen'].includes(partner.status)) return { joined: true, program: partner.program, status: partner.status };
        const d = await dashboard(user);
        return { joined: true, program: partner.program, status: partner.status, upgrade: d.upgrade.state, code: partner.code, ratePercent: d.ratePercent, available: Math.max(0, d.balances.available), pending: d.balances.pending, needsYou: d.summary.needsYou, recruits: d.summary.total };
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
                const allById = new Map(people.map((p) => [p.id, p]));
                const byId = new Map(people.filter((p) => p.program === partner.program).map((p) => [p.id, p]));
                const counts = new Map();
                for (const r of refs) if (byId.has(r.partnerId) && C.referralProgram(r, allById.get(r.partnerId)) === partner.program) counts.set(r.partnerId, (counts.get(r.partnerId) || 0) + 1);
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

    /**
     * The layers a person must pass before joining, as a plain checklist the join screen shows BEFORE they fill anything in.
     * It only reports; joinCircle / applyCrew enforce the very same rules again (the server never trusts a screen).
     */
    async function eligibility(user, program) {
        const key = program === 'crew' ? 'crew' : 'circle';
        const label = R.PROGRAM_LABELS[key];
        const [existing, settings] = await Promise.all([prisma.growthPartner.findUnique({ where: { userId: user.id } }), ctx.getSettings()]);
        const open = key === 'crew' ? !!settings.crewOpen : !!settings.circleOpen;
        const same = existing && existing.program === key;
        // A Circle member looking at Crew is not "in the wrong program": this is the upgrade path.
        const upgrading = !!existing && existing.program === 'circle' && key === 'crew';
        const other = existing && existing.program !== key && !upgrading;
        let upgrades = [];
        if (upgrading) upgrades = await prisma.growthUpgrade.findMany({ where: { partnerId: existing.id }, orderBy: { appliedAt: 'desc' }, take: 5 });
        const st = upgrading ? upgradeState(existing, upgrades, settings, now()) : null;
        const checks = [
            { id: 'open', label: key === 'crew' ? `${label.name} is taking applications` : `${label.name} is open to new members`, ok: open, fix: open ? '' : 'It is not open right now. The About page is the place to follow when it opens.' },
            { id: 'account', label: 'Your NextaStore account can join', ok: user.accountStatus !== 'suspended', fix: user.accountStatus === 'suspended' ? 'This account is restricted. Contact support.' : '' },
            { id: 'email', label: 'Your email address is verified', ok: !!user.emailVerifiedAt, fix: user.emailVerifiedAt ? '' : 'Open the verification email we sent you, or ask for a new one from your account.' }
        ];
        if (upgrading) {
            checks.push({ id: 'standing', label: 'Your Circle membership is in good standing', ok: existing.status === 'active', fix: existing.status === 'active' ? '' : 'Your Circle account is under review. Once it is clear you can ask to move up.' });
            if (st.state === 'pending') checks.push({ id: 'pending', label: 'No other Crew request is waiting', ok: false, fix: 'Your request is already with our team. Circle keeps working while you wait.' });
            if (st.state === 'declined' && st.canReapplyAt) checks.push({ id: 'cooldown', label: 'You can ask again', ok: false, fix: `You can ask again from ${new Date(st.canReapplyAt).toISOString().slice(0, 10)}. Circle keeps working as normal.` });
        } else {
            checks.push({ id: 'program', label: other ? `You are already in ${R.PROGRAM_LABELS[existing.program].name}` : 'You are not in another program', ok: !other, fix: other ? 'An account is in one program at a time. Your dashboard is waiting in the other one.' : '' });
        }
        const blockers = checks.filter((c) => !c.ok);
        return {
            program: key, name: label.name, mode: upgrading ? 'upgrade' : 'join', canJoin: (!existing || upgrading) && blockers.length === 0, blockers: blockers.map((c) => c.id), checks,
            existing: existing ? { program: existing.program, status: existing.status, sameProgram: !!same } : null,
            upgrade: upgrading ? { state: st.state } : null,
            steps: key === 'crew' ? ['account', 'email', 'details', 'review'] : ['account', 'email', 'agree'],
            reviewWorkingDays: key === 'crew' ? R.REVIEW.applicationWorkingDays : 0
        };
    }

    // ---- Circle -> Crew -------------------------------------------------------------------------------------------------
    /**
     * A Circle member asks to move up. Nothing about their Circle membership changes here: their code, link, earnings and
     * withdrawals all carry on exactly as before. Only an admin's approval (admin.approveUpgrade) moves them.
     */
    async function applyUpgrade(user, { phone, territories = [], note = '', kycFileUrl = null, cardPhotoUrl = null, ip = '', agreedTerms = false } = {}) {
        if (!agreedTerms) throw apiError(`Please accept the ${R.PROGRAM_LABELS.crew.name} terms to apply.`, 400, 'TERMS_REQUIRED');
        if (!user.emailVerifiedAt) throw apiError('Verify your email first, then apply.', 403, 'EMAIL_UNVERIFIED');
        if (user.accountStatus === 'suspended') throw apiError('This account cannot apply right now.', 403);
        const partner = await prisma.growthPartner.findUnique({ where: { userId: user.id } });
        if (!partner) throw apiError(`Join ${R.PROGRAM_LABELS.circle.name} first, or apply to the Crew directly.`, 404, 'NOT_A_PARTNER');
        if (partner.program !== 'circle') throw apiError(`You are already in ${R.PROGRAM_LABELS.crew.name}.`, 409, 'ALREADY_CREW');
        if (partner.status !== 'active') throw apiError('Your Circle account is under review. You can ask to move up once it is clear.', 403, 'NOT_IN_GOOD_STANDING');
        const cleanPhone = K.normalizePhone(phone);
        if (cleanPhone.length !== 12) throw apiError('Enter a valid Ugandan phone number.', 400, 'BAD_PHONE');
        if (!kycFileUrl) throw apiError('Upload a clear photo of your national ID so we can verify you.', 400, 'KYC_REQUIRED');
        if (!cardPhotoUrl) throw apiError('Add a clear photo of your face for your Crew ID card.', 400, 'CARD_PHOTO_REQUIRED');
        const picks = [...new Set(territories.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, R.TERRITORIES.maxPerMember);
        if (!picks.length) throw apiError('Choose at least one area you will cover.', 400, 'TERRITORY_REQUIRED');
        const settings = await assertOpen('crew');
        const history = await prisma.growthUpgrade.findMany({ where: { partnerId: partner.id }, orderBy: { appliedAt: 'desc' }, take: 5 });
        const st = upgradeState(partner, history, settings, now());
        if (st.state === 'pending') throw apiError('Your request is already with our team.', 409, 'UPGRADE_PENDING');
        if (st.state === 'declined' && st.canReapplyAt) throw apiError(`You can ask again from ${new Date(st.canReapplyAt).toISOString().slice(0, 10)}. Circle keeps working as normal.`, 429, 'UPGRADE_COOLDOWN');
        let row;
        try {
            row = await prisma.growthUpgrade.create({
                data: {
                    partnerId: partner.id, fromProgram: 'circle', toProgram: 'crew', status: 'applied', phone: cleanPhone, territories: picks,
                    note: String(note).slice(0, 600), kycFileUrl, cardPhotoUrl: cardPhotoUrl || null, agreedTermsVersion: settings.termsVersion, signupIpPrefix: K.ipPrefix(ip)
                }
            });
        } catch (err) {
            if (err && err.code === 'P2002') throw apiError('Your request is already with our team.', 409, 'UPGRADE_PENDING');   // the database allows one open request per member
            throw err;
        }
        await notify(user.id, 'Crew application received', `Our team reviews it within ${R.REVIEW.applicationWorkingDays} working days. ${R.PROGRAM_LABELS.circle.name} keeps working exactly as before while you wait.`, '/circle');
        return { status: row.status, appliedAt: row.appliedAt };
    }

    /** The member takes their own open request back. Circle was never touched, so there is nothing to undo. */
    async function withdrawUpgrade(user) {
        const partner = await getPartnerOrThrow(user.id);
        const open = await prisma.growthUpgrade.findFirst({ where: { partnerId: partner.id, status: 'applied' } });
        if (!open) throw apiError('There is no open request to withdraw.', 404, 'NO_OPEN_UPGRADE');
        const out = await prisma.growthUpgrade.updateMany({ where: { id: open.id, status: 'applied' }, data: { status: 'withdrawn', reviewedAt: now(), reviewNote: 'Withdrawn by the member' } });
        if (!out.count) throw apiError('That request was just handled.', 409);
        return { ok: true };
    }

    return { findByCode, applyUpgrade, withdrawUpgrade, upgradeState, joinCircle, applyCrew, eligibility, setPayout, getPartnerOrThrow, refresh, stats, cardState, dashboard, summary, campaigns, trailMap, uniqueCode };
}

module.exports = { createPartners };
