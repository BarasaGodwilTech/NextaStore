/**
 * The hooks. The existing app calls these at a handful of moments (signup, store created,
 * store live, payment submitted / approved / rejected / reversed). Every hook:
 *   - is safe to call for a user or store with no referral (it just returns null),
 *   - never throws into the caller's flow when wired with `safe()` (see index.js), so a bug
 *     here can never block a signup or a payment approval,
 *   - is idempotent: running it twice for the same event never pays twice.
 */
const R = require('./rules');
const C = require('./commission');
const K = require('./risk');

const DAY = 86400000;
const HOUR = 3600000;

function createHooks(ctx, partnersApi) {
    const { prisma, now, notify, audit } = ctx;
    const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

    async function openFlag(partnerId, referralId, code, severity, detail) {
        return prisma.growthFlag.create({ data: { partnerId, referralId: referralId || null, code, severity, detail } });
    }

    async function freeze(partner, reason) {
        if (partner.status === 'frozen') return;
        await prisma.growthPartner.update({ where: { id: partner.id }, data: { status: 'frozen', frozenReason: reason, frozenAt: now() } });
        await notify(partner.userId, 'Your account is under review', 'Withdrawals are paused while our team looks at recent activity. We will reach out.');
    }

    // ---- 1. Signup: remember who sent them ---------------------------------------------
    /**
     * Call right after a user is created. `code` is whatever the signup form sent (may be empty);
     * `via` is 'link' when it came from ?ref= and 'code' when typed in.
     */
    async function onSignup({ user, code, via = 'link', ip = '', deviceHash = '', phone = '' }) {
        const existing = await prisma.growthReferral.findUnique({ where: { recruitUserId: user.id } });
        if (existing) return existing;
        const clean = C.normalizeCode(code);
        const cleanPhone = K.normalizePhone(phone);
        const t = now();

        const activeLead = cleanPhone ? await prisma.growthReferral.findFirst({ where: { stage: 'lead', leadPhone: cleanPhone, leadLockExpiresAt: { gt: t } } }) : null;
        let partner = null;
        if (clean) {
            // Current code OR a code they used before moving from Circle to Crew: both find the same person.
            partner = await partnersApi.findByCode(clean);
            if (partner && !['active', 'frozen'].includes(partner.status)) partner = null;
        }
        if (partner && partner.userId === user.id) {
            await openFlag(partner.id, null, 'SELF_REFERRAL_ATTEMPT', 'high', { at: 'signup' });
            return null;
        }

        // A live lead lock beats a later code from someone else, but never silently: an admin sees the clash.
        if (activeLead && (!partner || partner.id !== activeLead.partnerId)) {
            if (partner) await openFlag(activeLead.partnerId, activeLead.id, 'LEAD_CONFLICT', 'medium', { otherCode: clean, note: 'Sign-up used another partner\'s code while a lead lock was live. Code owner got the sign-up.' });
            else partner = await prisma.growthPartner.findUnique({ where: { id: activeLead.partnerId } });
        }
        if (!partner) return null;

        const evidence = { signupIpPrefix: K.ipPrefix(ip), deviceHash: String(deviceHash || '').slice(0, 64) };
        const mergeLead = activeLead && activeLead.partnerId === partner.id;
        const data = {
            // Fixed here, once: the program this partner is in RIGHT NOW. Every payment for this person is later worked out under this
            // program, whatever the partner does afterwards (such as moving from Circle to Crew).
            program: partner.program,
            stage: 'signed_up', recruitUserId: user.id, signedUpAt: t, qualifyBy: addDays(t, R.ATTRIBUTION.qualifyingWindowDays),
            source: mergeLead ? 'lead' : via, leadLockExpiresAt: null, ...evidence,
            ...(partner.status === 'frozen' ? { riskDecision: 'review' } : {})
        };
        const referral = mergeLead
            ? await prisma.growthReferral.update({ where: { id: activeLead.id }, data })
            : await prisma.growthReferral.create({ data: { partnerId: partner.id, ...data } });
        await notify(partner.userId, 'Someone signed up with your code', 'We will show you how they get on, so you can help them along.', partner.program === 'crew' ? '/crew' : '/circle');
        return referral;
    }

    /** A seller who skipped the code can type it in within a week, as long as nothing has been paid. */
    async function lateClaim({ user, code, ip = '' }) {
        const { apiError } = ctx;
        const clean = C.normalizeCode(code);
        if (!clean) throw apiError('That code does not look right. Codes look like CIRCLE-K7M3Q or CREW-4HTR9.', 400, 'BAD_CODE');
        if (await prisma.growthReferral.findUnique({ where: { recruitUserId: user.id } })) throw apiError('Your account is already linked to a code.', 409, 'ALREADY_LINKED');
        const ageDays = (now() - new Date(user.createdAt)) / DAY;
        if (ageDays > R.ATTRIBUTION.lateClaimDays) throw apiError(`Codes can be added within ${R.ATTRIBUTION.lateClaimDays} days of signing up.`, 400, 'TOO_LATE');
        const store = await prisma.store.findFirst({ where: { ownerId: user.id }, select: { id: true } });
        if (store) {
            const paid = await prisma.subscriptionPayment.count({ where: { storeId: store.id } });
            if (paid && R.ATTRIBUTION.lateClaimRequiresNoPayment) throw apiError('A code cannot be added after a payment has been sent.', 400, 'ALREADY_PAID');
        }
        const referral = await onSignup({ user, code: clean, via: 'late_claim', ip });
        if (!referral) throw apiError('That code is not active.', 404, 'CODE_NOT_FOUND');
        if (store) await prisma.growthReferral.update({ where: { id: referral.id }, data: { storeId: store.id } }).catch(() => {});
        return { ok: true };
    }

    // ---- 2. Store created / live ----------------------------------------------------------
    async function onStoreCreated({ user, store }) {
        let referral = await prisma.growthReferral.findUnique({ where: { recruitUserId: user.id } });
        if (!referral && store.phoneNumber) {
            // No code was used, but a Crew member may already hold a lead on this phone number.
            referral = await onSignup({ user, code: '', phone: store.phoneNumber });
        }
        if (!referral) return null;
        if (referral.storeId && referral.storeId !== store.id) return referral;
        return prisma.growthReferral.update({ where: { id: referral.id }, data: { storeId: store.id } });
    }

    async function onStoreLive({ storeId }) {
        const referral = await prisma.growthReferral.findUnique({ where: { storeId } });
        if (!referral || referral.stage !== 'signed_up') return null;
        const updated = await prisma.growthReferral.update({ where: { id: referral.id }, data: { stage: 'store_live', storeLiveAt: now() } });
        const partner = await prisma.growthPartner.findUnique({ where: { id: referral.partnerId } });
        const store = await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } });
        if (partner) await notify(partner.userId, `${store?.name || 'A store'} is live`, 'Their store just launched. A friendly nudge about the Seller Pass now can make the difference.', partner.program === 'crew' ? '/crew' : '/circle');
        return updated;
    }

    // ---- 3. Payments --------------------------------------------------------------------------
    async function onPaymentSubmitted({ payment, store }) {
        const referral = await prisma.growthReferral.findUnique({ where: { storeId: store.id } });
        if (!referral || referral.firstPaymentId || !['signed_up', 'store_live'].includes(referral.stage)) return null;
        const updated = await prisma.growthReferral.update({
            where: { id: referral.id }, data: { stage: 'payment_pending', paymentSubmittedAt: payment.submittedAt || now(), firstPaymentId: payment.id }
        });
        const partner = await prisma.growthPartner.findUnique({ where: { id: referral.partnerId } });
        if (partner) await notify(partner.userId, `${store.name} sent their payment`, 'It is waiting for approval. We aim to approve within 24 hours and will tell you the moment it is done.', partner.program === 'crew' ? '/crew' : '/circle');
        return updated;
    }

    async function onPaymentRejected({ payment, store }) {
        const referral = await prisma.growthReferral.findUnique({ where: { storeId: store.id } });
        if (!referral || referral.firstPaymentId !== payment.id || referral.stage !== 'payment_pending') return null;
        const updated = await prisma.growthReferral.update({
            where: { id: referral.id },
            data: { stage: referral.storeLiveAt ? 'store_live' : 'signed_up', firstPaymentId: null, paymentSubmittedAt: null }
        });
        const partner = await prisma.growthPartner.findUnique({ where: { id: referral.partnerId } });
        if (partner) await notify(partner.userId, `${store.name}'s payment did not go through`, 'The transaction could not be confirmed. Ask them to check the ID from their SMS and send it again.', partner.program === 'crew' ? '/crew' : '/circle');
        return updated;
    }

    /** Gather the facts the risk engine needs. Kept in one place so previews and approvals agree. */
    async function gatherFacts(referral, partner, payment, store) {
        const t = now();
        const [partnerUser, recruitUser, storeRow] = await Promise.all([
            prisma.user.findUnique({ where: { id: partner.userId }, select: { id: true, email: true } }),
            referral.recruitUserId ? prisma.user.findUnique({ where: { id: referral.recruitUserId }, select: { id: true, email: true } }) : null,
            prisma.store.findUnique({ where: { id: store.id }, select: { id: true, phoneNumber: true } })
        ]);
        const [lastHour, last24h, sameIp, sameDevice, sharingPayout, totalSignups, clearedCount, reversedCount, products, refUsed] = await Promise.all([
            prisma.growthReferral.count({ where: { partnerId: partner.id, createdAt: { gte: new Date(t - HOUR) } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, createdAt: { gte: new Date(t - DAY) } } }),
            referral.signupIpPrefix ? prisma.growthReferral.count({ where: { partnerId: partner.id, signupIpPrefix: referral.signupIpPrefix, createdAt: { gte: new Date(t - 7 * DAY) } } }) : 0,
            referral.deviceHash ? prisma.growthReferral.count({ where: { partnerId: partner.id, deviceHash: referral.deviceHash } }) : 0,
            partner.payoutNumber ? prisma.growthPartner.count({ where: { payoutNumber: partner.payoutNumber } }) : 0,
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: { not: 'lead' } } }),
            prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'paid' } }),
            prisma.growthCommission.count({ where: { partnerId: partner.id, type: 'first_payment', status: 'voided', voidReason: { startsWith: 'reversed' } } }),
            prisma.product.count({ where: { storeId: store.id } }),
            payment.reference ? prisma.subscriptionPayment.count({ where: { reference: payment.reference, NOT: { storeId: store.id }, status: { not: 'rejected' } } }) : 0
        ]);
        return {
            partner: { userId: partner.userId, email: partnerUser?.email, phones: [partner.phone], payoutNumber: partner.payoutNumber, signupIpPrefix: partner.signupIpPrefix, usualIpPrefixes: partner.usualIpPrefixes },
            recruit: { userId: referral.recruitUserId, email: recruitUser?.email, storePhone: storeRow?.phoneNumber, signupIpPrefix: referral.signupIpPrefix, deviceHash: referral.deviceHash },
            payment: { reference: payment.reference, payerPhone: payment.payerPhone || '', referenceUsedByOtherStore: refUsed > 0 },
            history: {
                signupsLastHour: lastHour, signupsLast24h: last24h, recruitsSameIpPrefix7d: sameIp, recruitsSameDevice: sameDevice,
                partnersSharingPayoutNumber: sharingPayout, totalSignups, clearedCount, reversedCount
            },
            recruitHasProducts: products
        };
    }

    /** For the admin payment-review screen: "this store was referred, and here is what looks odd". */
    async function previewForPayment(paymentId) {
        const payment = await prisma.subscriptionPayment.findUnique({ where: { id: paymentId }, include: { store: true } });
        if (!payment) return null;
        const referral = await prisma.growthReferral.findUnique({ where: { storeId: payment.storeId } });
        if (!referral) return { referred: false };
        const partner = await prisma.growthPartner.findUnique({ where: { id: referral.partnerId } });
        if (!partner) return { referred: false };
        const verdict = K.evaluate(await gatherFacts(referral, partner, payment, payment.store));
        return {
            referred: true, program: C.referralProgram(referral, partner), partnerName: partner.displayName, code: partner.code, stage: referral.stage,
            decision: verdict.decision, score: verdict.score, reasons: verdict.reasons,
            visits: await prisma.growthVisit.count({ where: { referralId: referral.id } })
        };
    }

    /**
     * An admin approved a Seller Pass payment. Decide whether (and what) a partner earns.
     * `previousPaidUntil` is the store's coverage end BEFORE this approval (the approve route
     * already has it as `existingPaidUntil`).
     */
    async function onPaymentApproved({ payment, store, adminId, previousPaidUntil = null }) {
        const referral = await prisma.growthReferral.findUnique({ where: { storeId: store.id } });
        if (!referral) return null;
        const partner = await prisma.growthPartner.findUnique({ where: { id: referral.partnerId } });
        if (!partner) return null;
        const approvedAt = now();

        // ---- Later payment from a store that already converted: maybe a renewal bonus
        if (referral.stage === 'paid') {
            if (referral.firstPaymentId === payment.id) return null;
            const already = await prisma.growthCommission.count({ where: { referralId: referral.id, type: 'renewal', status: { not: 'voided' } } });
            const liveProducts = await prisma.product.count({ where: { storeId: store.id } });
            const lines = C.renewalRewardsFor(C.referralProgram(referral, partner), { previousCoverageEnd: previousPaidUntil, approvedAt, alreadyPaidRenewal: already > 0, liveProducts });
            if (!lines.length) return null;
            await prisma.growthCommission.createMany({
                data: lines.map((l) => ({ partnerId: partner.id, referralId: referral.id, paymentId: payment.id, paymentReviewedBy: adminId, type: l.type, amount: l.amount,
                    status: partner.status === 'frozen' ? 'review' : 'held', clearsAt: C.clearsAtFor(approvedAt), note: l.note })),
                skipDuplicates: true
            });
            const total = lines.reduce((s, l) => s + l.amount, 0);
            await notify(partner.userId, `${store.name} renewed`, `They stayed. You earned ${ctx.fmtUGX(total)} in stay bonuses.`, partner.program === 'crew' ? '/crew' : '/circle');
            await partnersApi.refresh(partner.id);
            return { renewal: true, earned: total, lines };
        }

        if (!['signed_up', 'store_live', 'payment_pending'].includes(referral.stage)) return null;

        // ---- First approved payment
        if (referral.qualifyBy && approvedAt > new Date(referral.qualifyBy)) {
            await prisma.growthReferral.update({ where: { id: referral.id }, data: { stage: 'lapsed' } });
            await notify(partner.userId, `${store.name} paid after the window`, `They paid more than ${R.ATTRIBUTION.qualifyingWindowDays} days after signing up, so it no longer counts. Their payment still went through.`, partner.program === 'crew' ? '/crew' : '/circle');
            return { lapsed: true };
        }
        if (!['active', 'frozen'].includes(partner.status)) return null;

        const verdict = K.evaluate(await gatherFacts(referral, partner, payment, store));
        const riskFields = { riskDecision: verdict.decision, riskScore: verdict.score, riskReasons: verdict.reasons, firstPaymentId: payment.id, paidAt: approvedAt };

        if (verdict.decision === 'block') {
            await prisma.growthReferral.update({ where: { id: referral.id }, data: { stage: 'blocked', ...riskFields, paidAt: null } });
            await openFlag(partner.id, referral.id, 'CONVERSION_BLOCKED', 'high', { reasons: verdict.reasons, score: verdict.score, signals: verdict.signals.map((s) => s.code) });
            if (verdict.signals.some((s) => s.hard)) await freeze(partner, 'A conversion matched a hard fraud rule.');
            else await notify(partner.userId, 'A recent sign-up is under review', 'We are checking it. No action needed from you.');
            return { blocked: true, reasons: verdict.reasons };
        }

        // The rules that apply are the ones for the program the partner was in when THIS person signed up, not the one they are in today.
        const prog = C.referralProgram(referral, partner);
        const boost = await ctx.campaignBoost(prog, store.district || '', approvedAt);
        const rank = prog === 'crew' ? (R.CREW_RANKS.find((r) => r.key === partner.rankKey) || R.CREW_RANKS[0]) : null;
        const lines = C.commissionForFirstPayment(prog, payment, { rank, campaignBoostPercent: boost });
        const needsHuman = verdict.decision === 'review' || partner.status === 'frozen';
        await prisma.$transaction(async (tx) => {
            await tx.growthReferral.update({ where: { id: referral.id }, data: { stage: 'paid', ...riskFields } });
            if (lines.length) {
                await tx.growthCommission.createMany({
                    data: lines.map((l) => ({
                        partnerId: partner.id, referralId: referral.id, paymentId: payment.id, paymentReviewedBy: adminId, type: l.type, amount: l.amount,
                        status: needsHuman ? 'review' : 'held', clearsAt: C.clearsAtFor(approvedAt), note: l.note
                    })),
                    skipDuplicates: true
                });
            }
            if (needsHuman) {
                await tx.growthFlag.create({ data: { partnerId: partner.id, referralId: referral.id, code: 'CONVERSION_REVIEW', severity: 'medium', detail: { reasons: verdict.reasons, score: verdict.score } } });
            }
        });
        const total = lines.reduce((s, l) => s + l.amount, 0);
        await notify(partner.userId, `${store.name} is confirmed`,
            needsHuman ? `Their payment is approved. Your ${ctx.fmtUGX(total)} is being double-checked before release.`
                : `Their payment is approved. You earned ${ctx.fmtUGX(total)}, which clears in ${R.CLEARANCE.days} days.`,
            partner.program === 'crew' ? '/crew' : '/circle');
        await partnersApi.refresh(partner.id);
        return { earned: total, lines, review: needsHuman };
    }

    /**
     * An approved payment was later found to be bad (reversed mobile money, wrong amount, fraud).
     * Voiding the commission rows is enough: if the partner was already paid, their available
     * balance simply goes negative and withdrawals stay closed until new earnings cover it.
     */
    async function onPaymentReversed({ paymentId, adminId, reason = '' }) {
        const rows = await prisma.growthCommission.findMany({ where: { paymentId, status: { not: 'voided' } } });
        if (!rows.length) return { voided: 0 };
        const t = now();
        const inWindow = rows.filter((r) => (t - new Date(r.createdAt)) / DAY <= R.CLEARANCE.clawbackWindowDays);
        if (!inWindow.length) { await audit(adminId, 'reversal_outside_window', 'payment', paymentId, { reason }); return { voided: 0, outsideWindow: true }; }
        await prisma.growthCommission.updateMany({ where: { id: { in: inWindow.map((r) => r.id) } }, data: { status: 'voided', voidReason: `reversed: ${String(reason).slice(0, 200)}` } });
        const partnerIds = [...new Set(inWindow.map((r) => r.partnerId))];
        for (const partnerId of partnerIds) {
            const partner = await prisma.growthPartner.findUnique({ where: { id: partnerId } });
            const refs = [...new Set(inWindow.filter((r) => r.partnerId === partnerId).map((r) => r.referralId).filter(Boolean))];
            if (refs.length) await prisma.growthReferral.updateMany({ where: { id: { in: refs }, stage: 'paid' }, data: { stage: 'void' } });
            await notify(partner.userId, 'A payment was reversed', 'A store payment was reversed, so the earning linked to it was removed from your balance.');
            await openFlag(partnerId, refs[0] || null, 'PAYMENT_REVERSED', 'medium', { paymentId, reason });
            await partnersApi.refresh(partnerId);
        }
        await audit(adminId, 'commission_voided_by_reversal', 'payment', paymentId, { rows: inWindow.length, reason });
        return { voided: inWindow.length };
    }

    // ---- 4. Recruiter taps "Ask us to check" ------------------------------------------------------
    async function askUsToCheck({ user, referralId }) {
        const { apiError } = ctx;
        const partner = await partnersApi.getPartnerOrThrow(user.id);
        const referral = await prisma.growthReferral.findFirst({ where: { id: referralId, partnerId: partner.id } });
        if (!referral) throw apiError('Recruit not found.', 404);
        if (referral.stage !== 'payment_pending' || !referral.paymentSubmittedAt) throw apiError('There is nothing waiting for approval on this one.', 400, 'NOT_PENDING');
        const t = now();
        const hrs = (t - new Date(referral.paymentSubmittedAt)) / HOUR;
        if (hrs < R.FOLLOW_UP.askUsToCheckAfterHours) throw apiError(`You can ask us to check after ${R.FOLLOW_UP.askUsToCheckAfterHours} hours. Their payment is still inside our normal time.`, 400, 'TOO_EARLY');
        if (referral.lastAskedAt && (t - new Date(referral.lastAskedAt)) / HOUR < R.FOLLOW_UP.askUsToCheckCooldownHours) throw apiError('You asked recently. Our team is already on it.', 429, 'COOLDOWN');
        const store = referral.storeId ? await prisma.store.findUnique({ where: { id: referral.storeId }, select: { name: true, ownerId: true } }) : null;
        // Reuses the existing admin follow-up list, so it shows up where the team already looks.
        await prisma.adminFollowUp.create({
            data: {
                title: `Delayed payment approval: ${store?.name || 'a referred store'}`,
                note: `${partner.displayName} (${partner.code}) asked us to check. Payment submitted ${Math.floor(hrs)} hours ago.`,
                relatedUserId: store?.ownerId || null, dueAt: new Date(t.getTime() + 4 * HOUR)
            }
        });
        await prisma.growthReferral.update({ where: { id: referral.id }, data: { lastAskedAt: t } });
        return { ok: true, message: 'Thank you. Our team will look at it today.' };
    }

    /** Remember networks a partner uses so "same network as the recruit" can be spotted later. */
    async function recordPartnerIp(userId, ip) {
        const prefix = K.ipPrefix(ip);
        if (!prefix) return;
        const partner = await prisma.growthPartner.findUnique({ where: { userId }, select: { id: true, usualIpPrefixes: true } });
        if (!partner || partner.usualIpPrefixes.includes(prefix)) return;
        await prisma.growthPartner.update({ where: { id: partner.id }, data: { usualIpPrefixes: [...partner.usualIpPrefixes, prefix].slice(-6) } });
    }

    // ---- 5. Nightly sweep (run from a scheduler; see INTEGRATION_GUIDE) -----------------------------
    async function sweep() {
        const t = now();
        const summary = { released: 0, lapsed: 0, leadsExpired: 0, nudged: 0, frozen: 0 };

        // 5a. Clearance: held -> available
        const due = await prisma.growthCommission.findMany({ where: { status: 'held', clearsAt: { lte: t } } });
        if (due.length) {
            await prisma.growthCommission.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { status: 'available' } });
            summary.released = due.length;
            const byPartner = new Map();
            for (const d of due) byPartner.set(d.partnerId, (byPartner.get(d.partnerId) || 0) + d.amount);
            for (const [partnerId, amount] of byPartner) {
                const p = await prisma.growthPartner.findUnique({ where: { id: partnerId }, select: { userId: true, program: true } });
                if (p) await notify(p.userId, `${ctx.fmtUGX(amount)} is ready to withdraw`, 'It has cleared. You can request a withdrawal now.', p.program === 'crew' ? '/crew' : '/circle');
            }
        }

        // 5b. Expire what never converted
        const lapsed = await prisma.growthReferral.updateMany({ where: { stage: { in: ['signed_up', 'store_live'] }, qualifyBy: { lt: t } }, data: { stage: 'lapsed' } });
        summary.lapsed = lapsed.count;
        const leads = await prisma.growthReferral.updateMany({ where: { stage: 'lead', leadLockExpiresAt: { lt: t } }, data: { stage: 'lapsed' } });
        summary.leadsExpired = leads.count;

        // 5c. One calm digest per partner per day for the things that need them
        const needs = new Map();
        const bump = (partnerId, key) => { const cur = needs.get(partnerId) || { delayed: 0, trial: 0, leads: 0 }; cur[key]++; needs.set(partnerId, cur); };
        (await prisma.growthReferral.findMany({ where: { stage: 'payment_pending', paymentSubmittedAt: { lt: new Date(t - R.FOLLOW_UP.paymentApprovalTargetHours * HOUR) } }, select: { partnerId: true } })).forEach((r) => bump(r.partnerId, 'delayed'));
        (await prisma.growthReferral.findMany({ where: { stage: 'lead', leadLockExpiresAt: { gt: t, lt: new Date(t.getTime() + 3 * DAY) } }, select: { partnerId: true } })).forEach((r) => bump(r.partnerId, 'leads'));
        const ending = await prisma.store.findMany({ where: { trialEndsAt: { gt: t, lt: new Date(t.getTime() + R.FOLLOW_UP.trialEndingNudgeDays * DAY) }, subscriptionPaidUntil: null }, select: { id: true } });
        if (ending.length) (await prisma.growthReferral.findMany({ where: { stage: 'store_live', storeId: { in: ending.map((s) => s.id) } }, select: { partnerId: true } })).forEach((r) => bump(r.partnerId, 'trial'));
        for (const [partnerId, n] of needs) {
            const p = await prisma.growthPartner.findUnique({ where: { id: partnerId }, select: { userId: true, program: true, status: true } });
            if (!p || p.status !== 'active') continue;
            const recent = await prisma.notification.findFirst({ where: { userId: p.userId, type: 'growth', title: 'Recruits need you today', createdAt: { gte: new Date(t - 20 * HOUR) } } });
            if (recent) continue;
            const parts = [];
            if (n.delayed) parts.push(`${n.delayed} waiting longer than usual for approval`);
            if (n.trial) parts.push(`${n.trial} with a trial about to end`);
            if (n.leads) parts.push(`${n.leads} lead${n.leads === 1 ? '' : 's'} about to lose your claim`);
            await notify(p.userId, 'Recruits need you today', parts.join(', ') + '.', p.program === 'crew' ? '/crew' : '/circle');
            summary.nudged++;
        }

        // 5d. Auto-freeze obviously unhealthy partners, then refresh ranks
        const active = await prisma.growthPartner.findMany({ where: { status: 'active' } });
        for (const p of active) {
            const [openFlags, blocked, cleared, reversed] = await Promise.all([
                prisma.growthFlag.count({ where: { partnerId: p.id, status: 'open' } }),
                prisma.growthReferral.count({ where: { partnerId: p.id, stage: 'blocked' } }),
                prisma.growthReferral.count({ where: { partnerId: p.id, stage: 'paid' } }),
                prisma.growthCommission.count({ where: { partnerId: p.id, type: 'first_payment', status: 'voided', voidReason: { startsWith: 'reversed' } } })
            ]);
            const health = K.partnerHealth({ openFlags, blockedConversions: blocked, clearedCount: cleared, reversedCount: reversed });
            if (health.freeze) { await freeze(p, health.reason); summary.frozen++; }
            else if (p.program === 'crew') await partnersApi.refresh(p.id);
        }
        return summary;
    }

    return { onSignup, lateClaim, onStoreCreated, onStoreLive, onPaymentSubmitted, onPaymentRejected, onPaymentApproved, onPaymentReversed, previewForPayment, gatherFacts, askUsToCheck, recordPartnerIp, sweep };
}

module.exports = { createHooks };
