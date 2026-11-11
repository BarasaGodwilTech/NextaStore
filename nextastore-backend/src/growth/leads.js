/**
 * Crew leads: "I met this shop owner in Nakawa Market."
 * Logging a lead claims that phone number for `leadLockDays`. Logging a real follow-up visit
 * extends the claim (twice, a week each). Leads are NOT paid for: only an approved payment is,
 * so there is no reason to invent leads, and the lock only protects honest work.
 */
const R = require('./rules');
const K = require('./risk');

const DAY = 86400000;

function createLeads(ctx, partnersApi, cardApi) {
    const { prisma, apiError, now } = ctx;
    const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

    async function requireActiveCrew(user) {
        const partner = await partnersApi.getPartnerOrThrow(user.id);
        if (partner.program !== 'crew') throw apiError('Leads are for the Crew.', 403);
        if (partner.status === 'applied') throw apiError('Your application is still being reviewed.', 403, 'NOT_APPROVED');
        if (partner.status !== 'active') throw apiError('Your Crew account cannot log leads right now.', 403, 'NOT_ACTIVE');
        return partner;
    }

    async function logLead(user, { business, contactName = '', phone, district = '', note = '', capturedAt = null }) {
        const partner = await requireActiveCrew(user);
        const biz = String(business || '').trim().slice(0, 80);
        if (biz.length < 2) throw apiError('Enter the business name.', 400, 'BUSINESS_REQUIRED');
        const clean = K.normalizePhone(phone);
        if (clean.length !== 12) throw apiError('Enter the owner\'s phone number, like 0772 123 456.', 400, 'BAD_PHONE');
        if (clean === K.normalizePhone(partner.phone) || clean === K.normalizePhone(partner.payoutNumber)) {
            throw apiError('That is your own number. Leads must be other people\'s businesses.', 400, 'OWN_NUMBER');
        }
        const t = now();

        // A lead typed in with no signal is queued on the Crew member's phone and sent later. It keeps the
        // time it was CAPTURED (up to offlineLeadMaxAgeHours back, never in the future) so a Crew member
        // is not punished for a bad network. Anything older or odd just counts from now.
        let startAt = t, offline = false;
        if (capturedAt) {
            const c = new Date(capturedAt);
            const ageHours = (t - c) / 3600000;
            if (!Number.isNaN(c.getTime()) && ageHours >= -0.1 && ageHours <= R.FIELD.offlineLeadMaxAgeHours) {
                startAt = c > t ? t : c;
                offline = ageHours > 0.05;
            }
        }

        // Already on NextaStore? Then there is nothing to recruit (last 9 digits match, whatever the format).
        const tail = clean.slice(-9);
        const onPlatform = await prisma.store.findFirst({ where: { deletedAt: null, phoneNumber: { contains: tail } }, select: { id: true } });
        if (onPlatform) throw apiError('That business is already on NextaStore.', 409, 'ALREADY_ON_PLATFORM');

        const holder = await prisma.growthReferral.findFirst({ where: { stage: 'lead', leadPhone: clean, leadLockExpiresAt: { gt: t } } });
        if (holder) {
            if (holder.partnerId === partner.id) throw apiError('You already logged this lead. Log a visit to keep your claim.', 409, 'YOURS_ALREADY');
            // Captured offline BEFORE the other Crew member's claim was logged? Keep the evidence for an admin.
            if (offline && new Date(holder.createdAt) > startAt) {
                await prisma.growthFlag.create({ data: { partnerId: partner.id, referralId: holder.id, code: 'LEAD_DISPUTE', severity: 'low', detail: { capturedAt: startAt, otherLoggedAt: holder.createdAt, business: biz } } });
                throw apiError('Another Crew member logged this business on our system first. We noted your earlier visit time and our team will review it.', 409, 'LEAD_TAKEN');
            }
            throw apiError('Another Crew member is already working with this business. Try a different one.', 409, 'LEAD_TAKEN'); // never reveals who
        }
        const open = await prisma.growthReferral.count({ where: { partnerId: partner.id, stage: 'lead', leadLockExpiresAt: { gt: t } } });
        if (open >= R.FIELD.maxOpenLeads) throw apiError(`You have ${R.FIELD.maxOpenLeads} open leads. Close some by visiting them again before adding more.`, 400, 'TOO_MANY_LEADS');

        const lead = await prisma.growthReferral.create({
            data: {
                partnerId: partner.id, program: 'crew', stage: 'lead', source: 'lead', leadBusiness: biz, leadContactName: String(contactName).trim().slice(0, 80),
                leadPhone: clean, leadDistrict: String(district).trim().toLowerCase().slice(0, 40), leadNote: String(note).slice(0, 400),
                leadLockExpiresAt: addDays(startAt, R.ATTRIBUTION.leadLockDays), createdAt: startAt, capturedOffline: offline
            }
        });
        if (cardApi) await cardApi.afterLead(partner);   // never throws: it only tells the member their card has unlocked
        return { id: lead.id, lockExpiresAt: lead.leadLockExpiresAt, lockDays: R.ATTRIBUTION.leadLockDays, offline };
    }

    async function logVisit(user, leadId, { note = '', photoUrl = null, lat = null, lng = null } = {}) {
        const partner = await requireActiveCrew(user);
        const lead = await prisma.growthReferral.findFirst({ where: { id: leadId, partnerId: partner.id } });
        if (!lead) throw apiError('Lead not found.', 404);
        const t = now();
        const present = (v) => v !== null && v !== undefined && v !== '';
        const latOk = present(lat) && Number.isFinite(Number(lat)) && Math.abs(Number(lat)) <= 90;
        const lngOk = present(lng) && Number.isFinite(Number(lng)) && Math.abs(Number(lng)) <= 180;
        await prisma.growthVisit.create({
            data: { partnerId: partner.id, referralId: lead.id, note: String(note).slice(0, 400), photoUrl: photoUrl || null, lat: latOk ? Number(lat) : null, lng: lngOk ? Number(lng) : null }
        });
        const usedBefore = lead.leadLockExtensions;
        let extended = false;
        if (lead.stage === 'lead' && lead.leadLockExpiresAt && new Date(lead.leadLockExpiresAt) > t && usedBefore < R.ATTRIBUTION.leadLockMaxExtensions) {
            await prisma.growthReferral.update({
                where: { id: lead.id },
                data: { leadLockExpiresAt: addDays(lead.leadLockExpiresAt, R.ATTRIBUTION.leadLockExtendDays), leadLockExtensions: { increment: 1 } }
            });
            extended = true;
        }
        return { ok: true, extended, extensionsLeft: Math.max(0, R.ATTRIBUTION.leadLockMaxExtensions - usedBefore - (extended ? 1 : 0)) };
    }

    async function dropLead(user, leadId) {
        const partner = await requireActiveCrew(user);
        const lead = await prisma.growthReferral.findFirst({ where: { id: leadId, partnerId: partner.id, stage: 'lead' } });
        if (!lead) throw apiError('Lead not found.', 404);
        await prisma.growthReferral.update({ where: { id: lead.id }, data: { stage: 'lapsed', leadLockExpiresAt: new Date(now().getTime() - 1000) } });
        return { ok: true };
    }

    return { logLead, logVisit, dropLead, requireActiveCrew };
}

module.exports = { createLeads };
