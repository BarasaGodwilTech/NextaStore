const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const prisma = require('../prisma');
const { storeSlugFrom, apiError } = require('../utils');
const { publicUser, starterStoreData } = require('../helpers');
const { issueToken, redeemToken } = require('../verification');
const { sendMail } = require('../mailer');
const { requireAuth, signSessionToken } = require('../middleware');
const { validateBody, signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validation');
const cache = require('../cache');
const { removeAllSubscriptionsForUser } = require('../push');
const presence = require('../presence');

const router = express.Router();

// Brute-force / signup-spam protection. Keyed on IP by default, which is
// enough for a single-region deploy; if you go multi-region put this behind
// your edge/CDN's rate limiting instead.
// Shares its counters via Redis when REDIS_URL is set (see cache.js) —
// without this, running more than one backend instance gives an attacker
// `limit` attempts PER INSTANCE instead of in total, since each instance's
// default in-memory counter has no idea about the others.
let authLimiterStore;
if (cache.isRedisEnabled()) {
    try {
        const RedisStore = require('rate-limit-redis');
        authLimiterStore = new RedisStore({ prefix: 'rl:auth-ip:', sendCommand: (...args) => cache.redisClient.call(...args) });
    } catch (err) {
        console.warn('[rate-limit] REDIS_URL is set but "rate-limit-redis" isn\u2019t installed (run `npm install`). Login rate limiting will be per-instance only.');
    }
}
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: authLimiterStore,
    // A successful login used to count against the same bucket as failed
    // ones, which meant every login attempt on a shared connection (a
    // school, an office NAT, a family sharing wifi) chewed through the
    // budget even when nobody was doing anything wrong. Only failures count
    // now, so this stays what it was meant to be: brute-force protection,
    // not a cap on how many people can legitimately sign in from one IP.
    skipSuccessfulRequests: true,
    message: { message: 'Too many attempts. Please try again later.' }
});

// authLimiter above is per-IP, which is right for stopping one attacker
// from hammering many accounts, but it does nothing to stop one attacker
// slowly guessing ONE account's password from many IPs (a botnet, a proxy
// pool) — the per-IP budget resets for every new source address. This adds
// a second, per-EMAIL bucket so repeated guesses against a single account
// are capped regardless of how many IPs they're spread across. Keyed on the
// normalized email from the body, so it only ever limits attempts against
// a real target account, not arbitrary traffic.
let emailLimiterStore;
if (cache.isRedisEnabled()) {
    try {
        const RedisStore = require('rate-limit-redis');
        emailLimiterStore = new RedisStore({ prefix: 'rl:auth-email:', sendCommand: (...args) => cache.redisClient.call(...args) });
    } catch (err) { /* already warned above for authLimiterStore */ }
}
const perEmailLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    store: emailLimiterStore,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => String(req.body?.email || '').trim().toLowerCase() || req.ip,
    message: { message: 'Too many attempts on this account. Please try again later.' }
});

// Lifetime depends on whether the person ticked "Remember me": an unticked
// login gets the short session (config.jwtSessionTtl, 2d by default), a
// ticked one gets the long session (config.jwtRememberTtl, 30d). Both slide
// forward while in use — see attachRenewedToken() in ../middleware.js.
function signToken(user, rememberMe = false) {
    return signSessionToken(user, rememberMe);
}

async function uniqueSlug(base) {
    let slug = storeSlugFrom(base);
    let attempt = 0;
    // Slugs are user-facing and rare to collide, but a launch-day rush of
    // similarly-named stores ("John's Store") is exactly when this would
    // fail silently without a real check.
    while (await prisma.store.findUnique({ where: { slug } })) {
        attempt += 1;
        slug = `${storeSlugFrom(base)}-${attempt + 1}`;
    }
    return slug;
}

// starterStoreData now lives in helpers.js (shared with POST
// /user/become-seller — see the comment there for why).

router.post('/signup', authLimiter, validateBody(signupSchema), async (req, res, next) => {
    try {
        const { name, email, password, accountType } = req.body;

        const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (existing) throw apiError('An account with that email already exists.');

        const passwordHash = bcrypt.hashSync(password, 10);
        const isSeller = accountType === 'seller';

        // A brand-new store starts empty. It used to be auto-seeded with
        // sample products for demo purposes — that doesn't belong in a real
        // production launch, where a seller's storefront should only ever
        // show things they actually added.
        //
        // Buyers get no store at all — the whole point of separating the
        // two roles is that "sign up to shop" shouldn't leave a half-built,
        // never-visited storefront sitting in the database.
        const user = await prisma.user.create({
            data: {
                name: name.trim(),
                email: email.toLowerCase(),
                passwordHash,
                role: isSeller ? 'seller' : 'buyer',
                ...(isSeller
                    ? { store: { create: starterStoreData(name, email.toLowerCase(), await uniqueSlug(`${name}-store`)) } }
                    : {})
            }
        });

        // Signup has no "Remember me" control, so a new account gets the
        // short (sliding) session — same rule as an unticked login.
        res.status(201).json({ token: signToken(user, false), user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

// A hash of an arbitrary, fixed password — never anyone's real one — used
// below purely as bcrypt work to burn when the account doesn't exist. Its
// own value is never compared against anything meaningful.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('nextastore-dummy-password-for-timing-only', 10);

router.post('/login', authLimiter, perEmailLoginLimiter, validateBody(loginSchema), async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

        // bcrypt.compareSync always runs, whether or not `user` exists — the
        // real hash when it does, a fixed dummy hash when it doesn't — so a
        // login attempt for a registered email and one for an unregistered
        // email take the same amount of time. Without this, skipping the
        // (comparatively slow) bcrypt call whenever the email lookup came up
        // empty made the response measurably faster for unregistered
        // emails, letting someone quietly enumerate which addresses have
        // NextaStore accounts just by timing this endpoint.
        const passwordOk = bcrypt.compareSync(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
        if (!user || !passwordOk) {
            throw apiError('That email and password don\u2019t match our records.', 401);
        }
        if (user.accountStatus === 'suspended') {
            throw apiError('This account is suspended. Please contact NextaStore support.', 403, 'ACCOUNT_SUSPENDED');
        }

        res.json({ token: signToken(user, req.body.rememberMe), user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.post('/logout', (req, res) => {
    // Tokens are stateless JWTs; the client just discards its copy. This
    // endpoint exists so the frontend has something to call symmetrically.
    res.json({ data: {} });
});

// "Log out everywhere": bumps tokenVersion, which makes every token issued
// before this moment fail the `tv` check in userFromAuthHeader (including,
// deliberately, the one this very request is authenticated with — the
// person doing this from one device is signing that device out too, same
// as every other one). requireAuth is what actually identifies "this
// person"; there's nothing else to validate in the body.
router.post('/logout-all', requireAuth, async (req, res, next) => {
    try {
        await prisma.user.update({
            where: { id: req.user.id },
            data: { tokenVersion: { increment: 1 } }
        });
        // The logins are gone, but a phone's push subscription is not a
        // login: forget every device too, or it keeps showing message
        // previews on a signed-out lock screen.
        await removeAllSubscriptionsForUser(req.user.id);
        // Their live presence streams hold tokens that are no longer valid.
        presence.disconnectUser(req.user.id, 'session-ended');
        res.json({ data: { message: 'Signed out on every device.' } });
    } catch (err) {
        next(err);
    }
});

router.post('/forgot-password', authLimiter, validateBody(forgotPasswordSchema), async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({ where: { email: req.body.email.toLowerCase() } });

        // Deliberately returns the same message and takes the same amount
        // of work whether or not the account exists, so this endpoint can't
        // be used to enumerate registered emails — only issue/email a token
        // if there's actually a user to issue one for.
        if (user) {
            const token = await issueToken(user.id, 'password_reset');
            const link = `${config.frontendUrl}/forgot-password.html?token=${token}`;
            await sendMail({
                to: user.email,
                subject: 'Reset your NextaStore password',
                text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`
            });
        }

        res.json({ data: { message: 'If that email exists, a reset link is on its way.' } });
    } catch (err) {
        next(err);
    }
});

// Consumes the token from the emailed link and sets a new password.
router.post('/reset-password', authLimiter, validateBody(resetPasswordSchema), async (req, res, next) => {
    try {
        const userId = await redeemToken(req.body.token, 'password_reset');
        const passwordHash = bcrypt.hashSync(req.body.newPassword, 10);
        // Anyone holding a token from before this reset (finding 6) should
        // not still be signed in afterwards — that was the whole point of
        // resetting the password. Bumping tokenVersion here, not just on the
        // logout-all button, is what actually closes that gap.
        await prisma.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
        // Same reason as logout-all: ending the sessions must also end the
        // push devices, which the tokenVersion bump does not touch.
        await removeAllSubscriptionsForUser(userId);
        presence.disconnectUser(userId, 'session-ended');
        res.json({ data: { message: 'Your password has been reset. You can log in now.' } });
    } catch (err) {
        next(err);
    }
});

// Sends (or re-sends) the email-verification link for the logged-in user.
router.post('/send-verification', requireAuth, authLimiter, async (req, res, next) => {
    try {
        if (req.user.emailVerifiedAt) throw apiError('This email is already verified.');
        const token = await issueToken(req.user.id, 'email_verify');
        const link = `${config.frontendUrl}/verify-email.html?token=${token}`;
        await sendMail({
            to: req.user.email,
            subject: 'Verify your NextaStore email',
            text: `Verify your email: ${link}\n\nThis link expires in 24 hours.`
        });
        res.json({ data: { message: 'Verification email sent.' } });
    } catch (err) {
        next(err);
    }
});

router.post('/verify-email', async (req, res, next) => {
    try {
        const userId = await redeemToken(req.body.token, 'email_verify');
        const user = await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
        res.json({ data: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
