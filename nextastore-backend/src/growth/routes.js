/**
 * Express routes. Built by a factory so the folder imports nothing from the host app:
 * the host passes its own `requireAuth`, `requireAdminPermission` and (optionally) a rate limiter.
 *
 *   partner router  -> mount at /api/growth
 *   admin router    -> mount at /api/admin/growth
 *
 * Responses follow the app's existing shape: { data: ... }.
 */
const R = require('./rules');
const C = require('./commission');

const P = R.GROWTH_PERMISSIONS;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => { if (data !== undefined) res.json({ data }); }).catch(next);

function buildRoutes(api, mw) {
    const express = require('express'); // required here so the services and tests load without Express installed
    const { partners, hooks, leads, withdrawals, admin, upgrades, card, ctx } = api;
    const { requireAuth, requireAdminPermission } = mw;
    const limiter = mw.limiter || ((req, res, next) => next());

    // ============================ Partner side ============================
    const partner = express.Router();

    // Public: the numbers the join pages show. Computed from rules.js, never hard-coded in HTML.
    partner.get('/rules', wrap(async (req, res) => {
        if (res && typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'public, max-age=60');
        const settings = await ctx.getSettings();
        const circle = R.COMMISSION.circle, crewRates = R.COMMISSION.crew;
        const month = R.PASS_PRICE_PER_MONTH_UGX;
        const base = month * R.COMMISSION.baseMonths;
        return {
            programs: {
                circle: { ...R.PROGRAM_LABELS.circle, open: settings.circleOpen, commissionPercent: Math.round(circle.rate * 100), firstMonth: Math.round(base * circle.rate), commitmentKicker: circle.commitmentKicker, stayBonus: circle.renewalBonus },
                crew: { ...R.PROGRAM_LABELS.crew, open: settings.crewOpen,
                    ranks: R.CREW_RANKS.map((r) => ({ key: r.key, label: r.label, minCleared90d: r.minCleared90d, ratePercent: Math.round(r.rate * 100), firstMonth: Math.round(base * r.rate) })),
                    commitmentKicker: crewRates.commitmentKicker, stayBonus: crewRates.renewalBonus, stockedBonus: crewRates.liveBonus, maxTerritories: R.TERRITORIES.maxPerMember, card: { unlockLeads: R.CREW_CARD.unlockLeads } }
            },
            payouts: { clearanceDays: R.CLEARANCE.days, payWithinWorkingDays: R.WITHDRAWAL.payWithinWorkingDays, minWithdrawal: R.WITHDRAWAL.minAmount, firstWithdrawalAfterDays: R.WITHDRAWAL.firstWithdrawalAfterDays, firstWithdrawalNeedsStore: R.WITHDRAWAL.firstWithdrawalNeedsClearedConversions > 0, feeOnUs: R.PAYOUT_FEE.paidBy === 'nextastore', trust: R.TRUST_LEVELS },
            passPricePerMonth: month, trialDays: R.TRIAL_DAYS, kickerMinMonths: R.COMMISSION.kickerMinMonths, maxUpfrontPercent: Math.round(R.COMMISSION.maxUpfrontShare * 100), qualifyingWindowDays: R.ATTRIBUTION.qualifyingWindowDays,
            leadLockDays: R.ATTRIBUTION.leadLockDays, offlineLeadMaxAgeHours: R.FIELD.offlineLeadMaxAgeHours,
            lead: { lockDays: R.ATTRIBUTION.leadLockDays, extendDays: R.ATTRIBUTION.leadLockExtendDays, maxExtensions: R.ATTRIBUTION.leadLockMaxExtensions, maxOpen: R.FIELD.maxOpenLeads },
            lateClaimDays: R.ATTRIBUTION.lateClaimDays, clickWindowDays: R.ATTRIBUTION.clickWindowDays, renewalWithinDays: R.COMMISSION.renewalWithinDays,
            applicationReviewWorkingDays: R.REVIEW.applicationWorkingDays, rankWindowDays: R.RANK_WINDOW_DAYS, rankMinQuality: R.RANK_MIN_QUALITY_SCORE, stockedMinProducts: R.COMMISSION.liveMinProducts,
            payoutChangeLockHours: R.WITHDRAWAL.payoutNumberChangeLockHours,
            askUsToCheckAfterHours: R.FOLLOW_UP.askUsToCheckAfterHours,
            hosts: ctx.hosts.publicConfig()
        };
    }));

    // Public: "You were invited by Amina". First name and program only, nothing else.
    partner.get('/resolve/:code', limiter, wrap(async (req) => {
        const code = C.normalizeCode(req.params.code);
        if (!code) return { valid: false };
        const p = await partners.findByCode(code);   // a current code, or one used before moving from Circle to Crew
        if (!p || !['active', 'frozen'].includes(p.status)) return { valid: false };
        return { valid: true, program: p.program, firstName: String(p.displayName).split(' ')[0] };
    }));

    partner.get('/me', requireAuth, wrap(async (req) => {
        hooks.recordPartnerIp(req.user.id, req.ip).catch(() => {});
        return partners.dashboard(req.user);
    }));
    partner.get('/eligibility', requireAuth, wrap((req) => partners.eligibility(req.user, req.query.program)));
    partner.get('/me/summary', requireAuth, wrap((req) => partners.summary(req.user)));
    partner.get('/campaigns', requireAuth, wrap((req) => partners.campaigns(req.user)));
    partner.post('/circle/join', requireAuth, limiter, wrap(async (req) => { const p = await partners.joinCircle(req.user, { phone: req.body?.phone, ip: req.ip, agreedTerms: req.body?.agreedTerms === true }); return { code: p.code }; }));
    // ID photos are personal data. They go through savePrivateImage (never the public /uploads folder)
    // and are only viewable by admins with growth.review, through GET /partners/:id/kyc below.
    async function storePrivately(dataUrl, folder) {
        if (!dataUrl) return null;
        if (!ctx.savePrivateImage) throw ctx.apiError('Uploads are not set up for this program yet.', 501, 'UPLOAD_UNAVAILABLE');
        return ctx.savePrivateImage(dataUrl, folder);
    }
    partner.post('/crew/apply', requireAuth, limiter, wrap(async (req) => {
        const b = req.body || {};
        const kycFileUrl = await storePrivately(b.kycImage, `growth-kyc/${req.user.id}`);
        const cardPhotoUrl = await storePrivately(b.cardPhoto, `growth-card/${req.user.id}`);   // required: applyCrew refuses an application without it
        const p = await partners.applyCrew(req.user, { phone: b.phone, territories: Array.isArray(b.territories) ? b.territories : [], note: b.note, kycFileUrl, cardPhotoUrl, ip: req.ip, agreedTerms: b.agreedTerms === true });
        return { status: p.status };
    }));
    // A Circle member asks to move up to Crew. Circle is untouched until an admin approves. Same private ID storage as a direct application.
    partner.post('/crew/upgrade', requireAuth, limiter, wrap(async (req) => {
        const b = req.body || {};
        const kycFileUrl = await storePrivately(b.kycImage, `growth-kyc/${req.user.id}`);
        const cardPhotoUrl = await storePrivately(b.cardPhoto, `growth-card/${req.user.id}`);
        return partners.applyUpgrade(req.user, { phone: b.phone, territories: Array.isArray(b.territories) ? b.territories : [], note: b.note, kycFileUrl, cardPhotoUrl, ip: req.ip, agreedTerms: b.agreedTerms === true });
    }));
    partner.post('/crew/upgrade/withdraw', requireAuth, limiter, wrap((req) => partners.withdrawUpgrade(req.user)));
    // The member's own card photo: shown back to them on their card, replaced while the card is locked. Only ever their own file.
    partner.get('/card/photo', requireAuth, async (req, res, next) => {
        try {
            const key = await card.ownPhotoKey(req.user);
            if (!key) return res.status(404).json({ message: 'No card photo yet.' });
            if (!mw.sendKyc) return res.status(501).json({ message: 'Photos are not set up yet.' });
            return mw.sendKyc(req, res, key);
        } catch (err) { return next(err); }
    });
    partner.put('/card/photo', requireAuth, limiter, wrap(async (req) => card.setPhoto(req.user, await storePrivately((req.body || {}).photo, `growth-card/${req.user.id}`))));
    partner.put('/payout', requireAuth, limiter, wrap((req) => partners.setPayout(req.user, req.body || {})));
    partner.post('/claim', requireAuth, limiter, wrap((req) => hooks.lateClaim({ user: req.user, code: req.body?.code, ip: req.ip })));
    partner.post('/referrals/:id/ask-check', requireAuth, limiter, wrap((req) => hooks.askUsToCheck({ user: req.user, referralId: req.params.id })));

    partner.post('/withdrawals', requireAuth, limiter, wrap((req) => withdrawals.request(req.user, req.body?.amount)));
    partner.post('/withdrawals/:id/cancel', requireAuth, limiter, wrap((req) => withdrawals.cancel(req.user, req.params.id)));

    // Crew members only
    partner.get('/trail-map', requireAuth, wrap((req) => partners.trailMap(req.user)));
    partner.post('/leads', requireAuth, limiter, wrap((req) => leads.logLead(req.user, req.body || {})));
    partner.post('/leads/:id/visit', requireAuth, limiter, wrap(async (req) => {
        const b = req.body || {};
        const photoUrl = await storePrivately(b.photo, `growth-visits/${req.user.id}`);
        return leads.logVisit(req.user, req.params.id, { note: b.note, lat: b.lat, lng: b.lng, photoUrl });
    }));
    partner.delete('/leads/:id', requireAuth, wrap((req) => leads.dropLead(req.user, req.params.id)));

    // ============================ Admin side ============================
    const adm = express.Router();
    const need = (perm) => [requireAuth, requireAdminPermission(perm)];
    const who = (req) => req.staff.id;

    adm.get('/overview', ...need(P.VIEW), wrap(() => admin.overview()));
    adm.get('/economics', ...need(P.VIEW), wrap(() => admin.economics()));
    adm.get('/partners', ...need(P.VIEW), wrap((req) => admin.listPartners(req.query)));
    adm.get('/partners/:id', ...need(P.VIEW), wrap((req) => admin.partnerDetail(req.params.id)));
    adm.get('/payments/:paymentId/preview', ...need(P.VIEW), wrap((req) => hooks.previewForPayment(req.params.paymentId)));

    // Admin-only view of a Crew member's ID photo. The host supplies mw.sendKyc(req, res, storedKey).
    adm.get('/partners/:id/kyc', ...need(P.REVIEW), async (req, res, next) => {
        try {
            const p = await ctx.prisma.growthPartner.findUnique({ where: { id: req.params.id }, select: { kycFileUrl: true, userId: true } });
            if (!p || !p.kycFileUrl) return res.status(404).json({ message: 'No ID on file.' });
            if (!mw.sendKyc) return res.status(501).json({ message: 'ID viewing is not set up yet.' });
            await ctx.audit(req.staff.id, 'kyc_viewed', 'partner', req.params.id, {}, p.userId);
            return mw.sendKyc(req, res, p.kycFileUrl);
        } catch (err) { return next(err); }
    });
    adm.put('/crew/:id/approve', ...need(P.REVIEW), wrap((req) => admin.approveCrew(who(req), req.params.id)));
    adm.put('/crew/:id/reject', ...need(P.REVIEW), wrap((req) => admin.rejectCrew(who(req), req.params.id, req.body?.reason)));
    // Circle -> Crew requests: the waiting list, the member's ID photo, and the three decisions.
    adm.get('/upgrades', ...need(P.VIEW), wrap((req) => upgrades.list(req.query)));
    adm.get('/partners/:id/card-photo', ...need(P.REVIEW), async (req, res, next) => {
        try {
            const p = await ctx.prisma.growthPartner.findUnique({ where: { id: req.params.id }, select: { cardPhotoUrl: true, userId: true } });
            if (!p || !p.cardPhotoUrl) return res.status(404).json({ message: 'No card photo on file.' });
            if (!mw.sendKyc) return res.status(501).json({ message: 'Photo viewing is not set up yet.' });
            await ctx.audit(req.staff.id, 'card_photo_viewed', 'partner', req.params.id, {}, p.userId);
            return mw.sendKyc(req, res, p.cardPhotoUrl);
        } catch (err) { return next(err); }
    });
    adm.put('/partners/:id/card/issue', ...need(P.REVIEW), wrap((req) => card.issue(who(req), req.params.id)));
    adm.get('/upgrades/:id/kyc', ...need(P.REVIEW), async (req, res, next) => {
        try {
            const k = await upgrades.kycFor(req.params.id);
            if (!k) return res.status(404).json({ message: 'No ID on file.' });
            if (!mw.sendKyc) return res.status(501).json({ message: 'ID viewing is not set up yet.' });
            await ctx.audit(req.staff.id, 'kyc_viewed', 'upgrade', req.params.id, {}, k.userId);
            return mw.sendKyc(req, res, k.key);
        } catch (err) { return next(err); }
    });
    adm.put('/upgrades/:id/approve', ...need(P.REVIEW), wrap((req) => upgrades.approve(who(req), req.params.id)));
    adm.put('/upgrades/:id/decline', ...need(P.REVIEW), wrap((req) => upgrades.decline(who(req), req.params.id, req.body?.reason)));
    adm.put('/upgrades/:id/reopen', ...need(P.REVIEW), wrap((req) => upgrades.reopen(who(req), req.params.id, req.body?.note)));
    adm.put('/partners/:id/freeze', ...need(P.REVIEW), wrap((req) => admin.freeze(who(req), req.params.id, req.body?.reason)));
    adm.put('/partners/:id/unfreeze', ...need(P.REVIEW), wrap((req) => admin.unfreeze(who(req), req.params.id)));
    adm.put('/commissions/:id/release', ...need(P.REVIEW), wrap((req) => admin.releaseCommission(who(req), req.params.id)));
    adm.put('/commissions/:id/void', ...need(P.REVIEW), wrap((req) => admin.voidCommission(who(req), req.params.id, req.body?.reason)));
    adm.get('/review-queue', ...need(P.VIEW), wrap(() => admin.reviewQueue()));
    adm.get('/flags', ...need(P.VIEW), wrap((req) => admin.listFlags(req.query)));
    adm.put('/flags/:id', ...need(P.REVIEW), wrap((req) => admin.resolveFlag(who(req), req.params.id, req.body || {})));

    adm.get('/withdrawals', ...need(P.PAYOUTS), wrap((req) => withdrawals.queue(req.query)));
    adm.get('/withdrawals/:id', ...need(P.PAYOUTS), wrap((req) => withdrawals.detail(req.params.id)));
    adm.put('/withdrawals/:id/approve', ...need(P.PAYOUTS), wrap((req) => withdrawals.approve(who(req), req.params.id)));
    adm.put('/withdrawals/:id/paid', ...need(P.PAYOUTS), wrap((req) => withdrawals.markPaid(who(req), req.params.id, req.body || {})));
    adm.put('/withdrawals/:id/reject', ...need(P.PAYOUTS), wrap((req) => withdrawals.reject(who(req), req.params.id, req.body?.reason)));

    // ---- WIP 113: the operating kit (see adminTools.js). Reads need growth.view; anything that changes a person or money needs more.
    adm.get('/segments', ...need(P.VIEW), wrap(() => admin.segments()));
    adm.get('/members', ...need(P.VIEW), wrap((req) => admin.members(req.query)));
    adm.get('/partners/:id/diagnose', ...need(P.VIEW), wrap((req) => admin.diagnose(req.params.id)));
    adm.get('/partners/:id/timeline', ...need(P.VIEW), wrap((req) => admin.timeline(req.params.id)));
    adm.get('/lookup', ...need(P.VIEW), wrap((req) => admin.lookup(req.query.q)));
    adm.get('/security', ...need(P.VIEW), wrap(() => admin.securityScan()));
    adm.get('/audit', ...need(P.VIEW), wrap((req) => admin.auditFeed(req.query)));
    adm.get('/economics/model', ...need(P.VIEW), wrap(() => admin.economicsModel()));
    adm.put('/partners/:id/retire', ...need(P.REVIEW), wrap((req) => admin.retire(who(req), req.params.id, req.body?.reason)));
    adm.put('/crew/:id/reopen', ...need(P.REVIEW), wrap((req) => admin.reopenCrew(who(req), req.params.id, req.body?.note)));
    adm.post('/partners/:id/note', ...need(P.REVIEW), wrap((req) => admin.addNote(who(req), req.params.id, req.body?.note)));
    adm.post('/partners/:id/adjust', ...need(P.PAYOUTS), wrap((req) => admin.adjust(who(req), req.params.id, req.body || {})));
    adm.post('/bulk', ...need(P.REVIEW), wrap((req) => admin.bulk(who(req), req.body?.action, req.body?.ids, req.body?.reason)));
    // CSV exports. Member lists need growth.view; anything with money or payout numbers needs growth.payouts.
    adm.get('/export/:kind', requireAuth, (req, res, next) => {
        const perm = admin.exportKinds()[req.params.kind];
        if (!perm) return res.status(404).json({ message: 'Unknown export.' });
        return requireAdminPermission(perm === 'payouts' ? P.PAYOUTS : P.VIEW)(req, res, async (err) => {
            if (err) return next(err);
            try {
                const out = await admin.exportCsv(req.staff.id, req.params.kind, req.query);
                res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
                return res.send('\ufeff' + out.csv);   // BOM so Excel reads the shillings and names correctly
            } catch (e) { return next(e); }
        });
    });

    adm.get('/campaigns', ...need(P.VIEW), wrap(() => admin.listCampaigns()));
    adm.post('/campaigns', ...need(P.SETTINGS), wrap((req) => admin.createCampaign(who(req), req.body || {})));
    adm.put('/campaigns/:id/end', ...need(P.SETTINGS), wrap((req) => admin.endCampaign(who(req), req.params.id)));
    adm.get('/settings', ...need(P.VIEW), wrap(() => admin.getSettings()));
    adm.put('/settings', ...need(P.SETTINGS), wrap((req) => admin.updateSettings(who(req), req.body || {})));

    return { partner, admin: adm };
}

module.exports = { buildRoutes };
