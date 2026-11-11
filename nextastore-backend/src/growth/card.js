/**
 * The Crew ID card: the photo, and the admin's early release.
 *
 * Whether a card is unlocked is worked out on every read (partners.cardState): a member who has logged R.CREW_CARD.unlockLeads
 * businesses has it, and so does anyone an admin released it for. Nothing here moves money or changes standing.
 */
const R = require('./rules');

function createCard(ctx, partnersApi) {
    const { prisma, apiError, now, notify, audit } = ctx;

    /** A member sets or replaces their card photo. Allowed while applying and while the card is still locked; once it is released the photo is fixed. */
    async function setPhoto(user, cardPhotoUrl) {
        if (!cardPhotoUrl) throw apiError('Add a clear photo of your face.', 400, 'CARD_PHOTO_REQUIRED');
        const p = await partnersApi.getPartnerOrThrow(user.id);
        if (p.program !== 'crew' || !['applied', 'active'].includes(p.status)) throw apiError('A card photo is for Crew members.', 403, 'NOT_CREW');
        if (p.status === 'active') {
            const st = await partnersApi.cardState(p);
            if (st.unlocked) throw apiError('Your card has been released, so the photo is fixed. Contact support if it needs changing.', 403, 'CARD_RELEASED');
        }
        await prisma.growthPartner.update({ where: { id: p.id }, data: { cardPhotoUrl } });
        return { ok: true };
    }

    /** The stored key of the caller's own card photo (the route streams it). */
    async function ownPhotoKey(user) {
        const p = await prisma.growthPartner.findUnique({ where: { userId: user.id }, select: { cardPhotoUrl: true, program: true, status: true } });
        if (!p || p.program !== 'crew' || !p.cardPhotoUrl) return null;
        return p.cardPhotoUrl;
    }

    /** An admin releases a card before the target is reached. */
    async function issue(adminId, id) {
        const p = await prisma.growthPartner.findUnique({ where: { id } });
        if (!p || p.program !== 'crew') throw apiError('Crew member not found.', 404);
        if (!['active', 'frozen'].includes(p.status)) throw apiError('Only an approved Crew member can have a card.', 400, 'NOT_APPROVED');
        if (!p.cardPhotoUrl) throw apiError('They have not added a card photo yet, so there is nothing to print on the card.', 400, 'CARD_PHOTO_REQUIRED');
        const st = await partnersApi.cardState(p);
        if (st.unlocked) return { ok: true, already: true, by: st.by };
        await prisma.growthPartner.update({ where: { id }, data: { cardIssuedAt: now(), cardIssuedBy: adminId } });
        await audit(adminId, 'card_released', 'partner', id, { leads: st.leads, needed: st.needed }, p.userId);
        await notify(p.userId, 'Your Crew ID card is ready', 'Our team has released your card. Open your dashboard to see it and save it to your phone.', '/crew');
        return { ok: true, already: false };
    }

    /** Called after a lead is logged: the member who has just reached the target is told once. Never throws into the lead flow. */
    async function afterLead(partner) {
        try {
            const st = await partnersApi.cardState(partner);
            if (st && st.by === 'target' && st.leads === st.needed && !partner.cardIssuedAt && partner.cardPhotoUrl) {
                const exact = await prisma.growthReferral.count({ where: { partnerId: partner.id, source: 'lead' } });
                if (exact === st.needed) await notify(partner.userId, 'Your Crew ID card is ready', `You have logged ${st.needed} businesses, so your card is unlocked. Open your dashboard to see it.`, '/crew');
            }
        } catch (err) { console.error('[growth] card notice failed:', err.message); }
    }

    return { setPhoto, ownPhotoKey, issue, afterLead, target: R.CREW_CARD.unlockLeads };
}

module.exports = { createCard };
