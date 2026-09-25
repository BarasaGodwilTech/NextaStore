const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../prisma');
const { apiError, saveImageIfDataUrl, storeSlugFrom, deleteImageIfReplaced } = require('../utils');
const { publicUser, starterStoreData } = require('../helpers');
const { removeAllSubscriptionsForUser } = require('../push');
const presence = require('../presence');
const { requireAuth, signSessionToken } = require('../middleware');
const { validateBody, updateUserSchema } = require('../validation');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
    res.json({ data: publicUser(req.user) });
});

// Lets an existing buyer start selling without creating a second account.
// Mirrors the exact starter-store shape signup gives a new seller, so a
// buyer who upgrades lands on the same onboarding wizard with the same
// blank-slate store a brand-new seller signup would get.
router.post('/become-seller', requireAuth, async (req, res, next) => {
    try {
        if (req.user.role === 'seller') {
            throw apiError('This account is already a seller account.');
        }

        let slug = storeSlugFrom(`${req.user.name}-store`);
        let attempt = 0;
        while (await prisma.store.findUnique({ where: { slug } })) {
            attempt += 1;
            slug = `${storeSlugFrom(`${req.user.name}-store`)}-${attempt + 1}`;
        }

        const [user] = await prisma.$transaction([
            prisma.user.update({ where: { id: req.user.id }, data: { role: 'seller' } }),
            prisma.store.create({
                data: {
                    ownerId: req.user.id,
                    ...starterStoreData(req.user.name, req.user.email, slug)
                }
            })
        ]);

        res.json({ data: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.put('/me', requireAuth, validateBody(updateUserSchema), async (req, res, next) => {
    try {
        const payload = req.body;
        const data = {};

        if (payload.name !== undefined) data.name = payload.name.trim();
        if (payload.avatar !== undefined) {
            const oldAvatar = req.user.avatar;
            data.avatar = await saveImageIfDataUrl(payload.avatar, `users/${req.user.id}`);
            await deleteImageIfReplaced(oldAvatar, data.avatar);
        }
        if (payload.cover !== undefined) {
            const oldCover = req.user.cover;
            data.cover = await saveImageIfDataUrl(payload.cover, `users/${req.user.id}`);
            await deleteImageIfReplaced(oldCover, data.cover);
        }

        let passwordChanged = false;
        if (payload.newPassword) {
            if (!payload.currentPassword || !bcrypt.compareSync(payload.currentPassword, req.user.passwordHash)) {
                throw apiError('Current password is incorrect.', 401);
            }
            data.passwordHash = bcrypt.hashSync(payload.newPassword, 10);
            // Same reasoning as the reset-password route: changing your
            // password should end every OTHER session that's currently
            // logged in with the old one, not just leave them running
            // until they happen to expire on their own.
            data.tokenVersion = { increment: 1 };
            passwordChanged = true;
        }

        const user = await prisma.user.update({ where: { id: req.user.id }, data });
        // Every other session just ended, so every registered push device
        // goes with them (this device signs itself back up from the page —
        // see js/push.js — once it holds the replacement token below).
        if (passwordChanged) await removeAllSubscriptionsForUser(req.user.id);
        // Presence streams opened with the old token end now; this device's
        // page reconnects by itself with the replacement token below.
        if (passwordChanged) presence.disconnectUser(req.user.id, 'session-ended');
        const response = { data: publicUser(user) };
        // tokenVersion just moved past the token THIS request was
        // authenticated with too, so without a replacement the person who
        // just changed their password would be logged out by their own
        // next request. Re-sign one now, same "remember me"-ness as
        // whatever they're currently using, so this device stays signed in
        // while every other one is the thing that actually gets ended.
        if (passwordChanged) response.token = signSessionToken(user, req.authPayload?.rm, null);
        res.json(response);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
