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
    const { partners, hooks, leads, withdrawals, admin, ctx } = api;
    const { requireAuth, requireAdminPermission } = mw;
    const limiter = mw.limiter || ((req, res, next) => next());

    // ============================ Partner side ============================
    const partner = express.Router();

    // Public: the numbers the join pages show. Computed from rules.js, never hard-coded in HTML.
    partner.get('/rules', wrap(async (req, res) => {
        if (res && typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'public, max-age=60');
        const settings = await ctx.getSettings();
        const circle = R.COMMISSION.circle, scout = R.COMMISSION.scout;
        const month = R.PASS_PRICE_PER_MONTH_UGX;
        const base = month * R.COMMISSION.baseMonths;
        return {
            programs: {
                circle: { ...R.PROGRAM_LABELS.circle, open: settings.circleOpen, commissionPercent: Math.round(circle.rate * 100), firstMonth: Math.round(base * circle.rate), commitmentKicker: circle.commitmentKicker, stayBonus: circle.renewalBonus },
                scout: { ...R.PROGRAM_LABELS.scout, open: settings.scoutsOpen,
                    ranks: R.SCOUT_RANKS.map((r) => ({ key: r.key, label: r.label, minCleared90d: r.minCleared90d, ratePercent: Math.round(r.rate * 100), firstMonth: Math.round(base * r.rate) })),
                    commitmentKicker: scout.commitmentKicker, stayBonus: scout.renewalBonus, stockedBonus: scout.liveBonus, maxTerritories: R.TERRITORIES.maxPerScout }
            },
            payouts: { clearanceDays: R.CLEARANCE.days, payWithinWorkingDays: R.WITHDRAWAL.payWithinWorkingDays, minWithdrawal: R.WITHDRAWAL.minAmount, firstWithdrawalAfterDays: R.WITHDRAWAL.firstWithdrawalAfterDays, feeOnUs: R.PAYOUT_FEE.paidBy === 'nextastore', trust: R.TRUST_LEVELS },
            passPricePerMonth: month, trialDays: R.TRIAL_DAYS, kickerMinMonths: R.COMMISSION.kickerMinMonths, maxUpfrontPercent: Math.round(R.COMMISSION.maxUpfrontShare * 100), qualifyingWindowDays: R.ATTRIBUTION.qualifyingWindowDays,
            leadLockDays: R.ATTRIBUTION.leadLockDays, offlineLeadMaxAgeHours: R.FIELD.offlineLeadMaxAgeHours,
            lead: { lockDays: R.ATTRIBUTION.leadLockDays, extendDays: R.ATTRIBUTION.leadLockExtendDays, maxExtensions: R.ATTRIBUTION.leadLockMaxExtensions, maxOpen: R.FIELD.maxOpenLeads },
            lateClaimDays: R.ATTRIBUTION.lateClaimDays,
            payoutChangeLockHours: R.WITHDRAWAL.payoutNumberChangeLockHours,
            askUsToCheckAfterHours: R.FOLLOW_UP.askUsToCheckAfterHours,
            hosts: ctx.hosts.publicConfig()
        };
    }));

    // Public: "You were invited by Amina". First name and program only, nothing else.
    partner.get('/resolve/:code', limiter, wrap(async (req) => {
        const code = C.normalizeCode(req.params.code);
        if (!code) return { valid: false };
        const p = await ctx.prisma.growthPartner.findUnique({ where: { code }, select: { displayName: true, program: true, status: true } });
        if (!p || !['active', 'frozen'].includes(p.status)) return { valid: false };
        return { valid: true, program: p.program, firstName: String(p.displayName).split(' ')[0] };
    }));

    partner.get('/me', requireAuth, wrap(async (req) => {
        hooks.recordPartnerIp(req.user.id, req.ip).catch(() => {});
        return partners.dashboard(req.user);
    }));
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
    partner.post('/scouts/apply', requireAuth, limiter, wrap(async (req) => {
        const b = req.body || {};
        const kycFileUrl = await storePrivately(b.kycImage, `growth-kyc/${req.user.id}`);
        const p = await partners.applyScout(req.user, { phone: b.phone, territories: Array.isArray(b.territories) ? b.territories : [], note: b.note, kycFileUrl, ip: req.ip, agreedTerms: b.agreedTerms === true });
        return { status: p.status };
    }));
    partner.put('/payout', requireAuth, limiter, wrap((req) => partners.setPayout(req.user, req.body || {})));
    partner.post('/claim', requireAuth, limiter, wrap((req) => hooks.lateClaim({ user: req.user, code: req.body?.code, ip: req.ip })));
    partner.post('/referrals/:id/ask-check', requireAuth, limiter, wrap((req) => hooks.askUsToCheck({ user: req.user, referralId: req.params.id })));

    partner.post('/withdrawals', requireAuth, limiter, wrap((req) => withdrawals.request(req.user, req.body?.amount)));
    partner.post('/withdrawals/:id/cancel', requireAuth, limiter, wrap((req) => withdrawals.cancel(req.user, req.params.id)));

    // Scouts only
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
    const who = (req) => req.user.id;

    adm.get('/overview', ...need(P.VIEW), wrap(() => admin.overview()));
    adm.get('/economics', ...need(P.VIEW), wrap(() => admin.economics()));
    adm.get('/partners', ...need(P.VIEW), wrap((req) => admin.listPartners(req.query)));
    adm.get('/partners/:id', ...need(P.VIEW), wrap((req) => admin.partnerDetail(req.params.id)));
    adm.get('/payments/:paymentId/preview', ...need(P.VIEW), wrap((req) => hooks.previewForPayment(req.params.paymentId)));

    // Admin-only view of a Scout's ID photo. The host supplies mw.sendKyc(req, res, storedKey).
    adm.get('/partners/:id/kyc', ...need(P.REVIEW), async (req, res, next) => {
        try {
            const p = await ctx.prisma.growthPartner.findUnique({ where: { id: req.params.id }, select: { kycFileUrl: true, userId: true } });
            if (!p || !p.kycFileUrl) return res.status(404).json({ message: 'No ID on file.' });
            if (!mw.sendKyc) return res.status(501).json({ message: 'ID viewing is not set up yet.' });
            await ctx.audit(req.user.id, 'kyc_viewed', 'partner', req.params.id, {}, p.userId);
            return mw.sendKyc(req, res, p.kycFileUrl);
        } catch (err) { return next(err); }
    });
    adm.put('/scouts/:id/approve', ...need(P.REVIEW), wrap((req) => admin.approveScout(who(req), req.params.id)));
    adm.put('/scouts/:id/reject', ...need(P.REVIEW), wrap((req) => admin.rejectScout(who(req), req.params.id, req.body?.reason)));
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

    adm.get('/campaigns', ...need(P.VIEW), wrap(() => admin.listCampaigns()));
    adm.post('/campaigns', ...need(P.SETTINGS), wrap((req) => admin.createCampaign(who(req), req.body || {})));
    adm.put('/campaigns/:id/end', ...need(P.SETTINGS), wrap((req) => admin.endCampaign(who(req), req.params.id)));
    adm.get('/settings', ...need(P.VIEW), wrap(() => admin.getSettings()));
    adm.put('/settings', ...need(P.SETTINGS), wrap((req) => admin.updateSettings(who(req), req.body || {})));

    return { partner, admin: adm };
}

module.exports = { buildRoutes };
