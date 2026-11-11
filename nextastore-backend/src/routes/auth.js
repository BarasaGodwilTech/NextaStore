const express = require('express');
const bcrypt = require('bcryptjs'); // only for the one-time dummy hash at boot
const passwords = require('../password');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const prisma = require('../prisma');
const { storeSlugFrom, apiError } = require('../utils');
const { publicUser, starterStoreData } = require('../helpers');
const { issueToken, redeemToken } = require('../verification');
const { sendMail, status: mailStatus } = require('../mailer');
const { requireAuth, signSessionToken } = require('../middleware');
const { validateBody, signupSchema, googleSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validation');
const crypto = require('crypto');
const { createGoogleVerifier, googleSignIn, GoogleAuthError } = require('../googleAuth');
const emails = require('../emailTemplates');
const cache = require('../cache');
const { removeAllSubscriptionsForUser } = require('../push');
const presence = require('../presence');
const growth = require('../growthInstance');

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

const googleVerifier = createGoogleVerifier({ clientIds: config.googleClientIds });
const RESEND_COOLDOWN_SECONDS = 60;

/** Sends (or re-sends) the "confirm your email" message. Throws if the mail could not be handed over. */
async function sendVerificationEmail(user) {
    const token = await issueToken(user.id, 'email_verify');
    const link = `${config.frontendUrl}/verify-email?token=${token}`;
    const mail = emails.verifyEmail({ name: user.name, link });
    let out;
    try {
        out = await sendMail({ to: user.email, ...mail });
    } catch (err) {
        // The email never left. Forget its link, otherwise the one-minute cooldown would stop the person asking again straight away.
        await prisma.verificationToken.deleteMany({ where: { userId: user.id, type: 'email_verify', usedAt: null } }).catch(() => {});
        throw err;
    }
    return { delivered: out.delivered !== false, link };
}

/** True when this account was created under the "confirm your email first" rule (see config.emailVerificationRequiredFrom). */
const mustVerifyToSignIn = (user) => !user.emailVerifiedAt && new Date(user.createdAt) >= config.emailVerificationRequiredFrom;

/** Has a verification email gone out for this person in the last minute? Used so signup and resend cannot be used to flood an inbox. */
async function recentlyEmailed(userId) {
    const last = await prisma.verificationToken.findFirst({ where: { userId, type: 'email_verify' }, orderBy: { createdAt: 'desc' } });
    if (!last) return 0;
    return Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 1000));
}

// Counts every attempt (unlike authLimiter, which only counts failures): each signup or resend sends an email to an address that is not
// necessarily the sender's, so the per-IP budget must cover successes too.
const emailSendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: authLimiterStore,
    message: { message: 'Too many emails requested from this connection. Please try again in a while.' }
});

/** What happens right after a NEW account exists, whichever way it was created: the Circle / Crew hooks (see signup below). */
function afterNewAccount(user, input, isSeller) {
    if (isSeller) {
        prisma.store.findUnique({ where: { ownerId: user.id } })
            .then((store) => growth.hooks.safe.onSignup({ user, code: input.referralCode, via: input.referralVia, ip: input.ip, deviceHash: input.deviceHash, phone: '' })
                .then(() => store && growth.hooks.safe.onStoreCreated({ user, store })))
            .catch(() => {});
    } else {
        growth.hooks.safe.onSignup({ user, code: input.referralCode, via: input.referralVia, ip: input.ip, deviceHash: input.deviceHash, phone: '' });
    }
}

// starterStoreData now lives in helpers.js (shared with POST
// /user/become-seller — see the comment there for why).

router.post('/signup', authLimiter, emailSendLimiter, validateBody(signupSchema), async (req, res, next) => {
    try {
        const { name, email, password, accountType } = req.body;
        const cleanEmail = email.toLowerCase();

        // Password sign-up has to prove the address is real, so it needs working email. If it is not available right now we say so
        // up front, before creating anything, rather than leaving someone with an account they cannot confirm.
        if (!mailStatus().available) {
            throw apiError('Email sign-up is temporarily unavailable. Please continue with Google, or try again shortly.', 503, 'EMAIL_UNAVAILABLE');
        }

        const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
        // An address is only ever "taken" by an account that proved it owns it, signed up with Google, or was already in use before
        // verification became mandatory. A newer account that never confirmed has never signed in and holds nothing, so it must not lock
        // the real owner of the address out: signing up again simply replaces it (below). Older unverified accounts are real and keep their password.
        const claimable = existing && !existing.emailVerifiedAt && !existing.googleId && new Date(existing.createdAt) >= config.emailVerificationRequiredFrom;
        if (existing && !claimable) throw apiError('An account with that email already exists.');

        const passwordHash = await passwords.hash(password, 10);
        const isSeller = accountType === 'seller';
        let user;
        if (claimable) {
            const hasStore = !!(await prisma.store.findUnique({ where: { ownerId: existing.id } }));
            user = await prisma.user.update({
                where: { id: existing.id },
                data: {
                    name: name.trim(), passwordHash, tokenVersion: { increment: 1 },
                    ...(isSeller && !hasStore ? { role: 'seller', store: { create: starterStoreData(name, cleanEmail, await uniqueSlug(`${name}-store`)) } } : {})
                }
            });
        } else {
            // A brand-new store starts empty (no demo products). Buyers get no store at all.
            user = await prisma.user.create({
                data: {
                    name: name.trim(),
                    email: cleanEmail,
                    passwordHash,
                    role: isSeller ? 'seller' : 'buyer',
                    ...(isSeller ? { store: { create: starterStoreData(name, cleanEmail, await uniqueSlug(`${name}-store`)) } } : {})
                }
            });
        }

        // NextaStore Circle / Crew: remember who invited this person and, for a seller, match the store to a Crew lead. Never awaited and
        // never throws (hooks.safe): a growth-program problem must not delay or break a signup. Safe to repeat for a replaced account.
        afterNewAccount(user, { referralCode: req.body.referralCode, referralVia: req.body.referralVia, ip: req.ip, deviceHash: req.body.deviceHash }, user.role === 'seller');

        // No session is issued: the account stays unusable until the emailed link is opened. If the mail provider fails we still answer
        // 201 with emailSent:false, and the page offers "resend" (which works without being signed in).
        let emailSent = false, devLink;
        const wait = claimable ? await recentlyEmailed(user.id) : 0;
        if (wait > 0) {
            emailSent = true;   // one went out seconds ago for this very address
        } else {
            try {
                const out = await sendVerificationEmail(user);
                emailSent = out.delivered;
                if (!out.delivered && !config.isProd) devLink = out.link;   // development only: no SMTP, so hand the link back instead of making you dig through the log
            } catch (err) {
                console.warn('[auth] could not send the verification email:', err.message);
            }
        }
        res.status(201).json({ verificationRequired: true, email: user.email, emailSent, accountType: user.role === 'seller' ? 'seller' : 'buyer', ...(devLink ? { devLink } : {}) });
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

        // passwords.compare always runs, whether or not `user` exists — the
        // real hash when it does, a fixed dummy hash when it doesn't — so a
        // login attempt for a registered email and one for an unregistered
        // email take the same amount of time. Without this, skipping the
        // (comparatively slow) bcrypt call whenever the email lookup came up
        // empty made the response measurably faster for unregistered
        // emails, letting someone quietly enumerate which addresses have
        // NextaStore accounts just by timing this endpoint.
        const passwordOk = await passwords.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
        if (!user || !passwordOk) {
            throw apiError('That email and password don\u2019t match our records.', 401);
        }
        if (user.accountStatus === 'suspended') {
            throw apiError('This account is suspended. Please contact NextaStore support.', 403, 'ACCOUNT_SUSPENDED');
        }

        // New accounts must confirm their email before the first sign-in. The right password is already proven at this point, so saying why is not a leak.
        if (mustVerifyToSignIn(user)) {
            throw apiError('Please confirm your email address to sign in. We sent you a link when you signed up.', 403, 'EMAIL_NOT_VERIFIED', { email: user.email });
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
            const link = `${config.frontendUrl}/forgot-password?token=${token}`;
            try { await sendMail({ to: user.email, ...emails.resetPassword({ name: user.name, link }) }); }
            catch (err) { console.warn('[auth] could not send the reset email:', err.message); }
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
        const passwordHash = await passwords.hash(req.body.newPassword, 10);
        // Anyone holding a token from before this reset (finding 6) should
        // not still be signed in afterwards — that was the whole point of
        // resetting the password. Bumping tokenVersion here, not just on the
        // logout-all button, is what actually closes that gap.
        // Opening the emailed reset link also proves the inbox is theirs, so an account that never confirmed is confirmed now (otherwise the
        // person would reset their password and then still be told to confirm an email they just used).
        const before = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
        await prisma.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 }, ...(before && !before.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}) } });
        // Same reason as logout-all: ending the sessions must also end the
        // push devices, which the tokenVersion bump does not touch.
        await removeAllSubscriptionsForUser(userId);
        presence.disconnectUser(userId, 'session-ended');
        res.json({ data: { message: 'Your password has been reset. You can log in now.' } });
    } catch (err) {
        next(err);
    }
});

// Sends (or re-sends) the email-verification link for the logged-in user. One every minute, so the button cannot be used to flood an inbox.
router.post('/send-verification', requireAuth, authLimiter, async (req, res, next) => {
    try {
        if (req.user.emailVerifiedAt) throw apiError('This email is already verified.', 400, 'ALREADY_VERIFIED');
        const last = await prisma.verificationToken.findFirst({ where: { userId: req.user.id, type: 'email_verify' }, orderBy: { createdAt: 'desc' } });
        if (last) {
            const wait = RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 1000);
            if (wait > 0) throw apiError(`We just sent one. Please wait ${wait} second${wait === 1 ? '' : 's'} before asking for another.`, 429, 'RESEND_TOO_SOON');
        }
        const out = await sendVerificationEmail(req.user);
        res.json({ data: { message: out.delivered ? `Verification email sent to ${req.user.email}.` : 'Email is not set up on this server yet, so nothing was delivered (the link is in the server log).', delivered: out.delivered } });
    } catch (err) {
        next(err);
    }
});

// The same "send me the link again", for someone who cannot sign in yet because they have not confirmed (so there is no session to ask with).
// It answers the same way whether or not the address has an account waiting, so it cannot be used to find out who is registered.
router.post('/resend-verification', authLimiter, emailSendLimiter, async (req, res, next) => {
    try {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw apiError('Enter a valid email address.', 400);
        if (!mailStatus().available) throw apiError('Email is temporarily unavailable. Please continue with Google, or try again shortly.', 503, 'EMAIL_UNAVAILABLE');
        const user = await prisma.user.findUnique({ where: { email } });
        let devLink;
        if (user && !user.emailVerifiedAt && !user.googleId && (await recentlyEmailed(user.id)) === 0) {
            try {
                const out = await sendVerificationEmail(user);
                if (!out.delivered && !config.isProd) devLink = out.link;
            } catch (err) { console.warn('[auth] could not resend the verification email:', err.message); }
        }
        res.json({ data: { message: 'If that address is waiting to be confirmed, a new link is on its way.', cooldownSeconds: RESEND_COOLDOWN_SECONDS, ...(devLink ? { devLink } : {}) } });
    } catch (err) {
        next(err);
    }
});

// Opening the emailed link confirms the address AND signs the person in (they just proved the inbox is theirs; asking for the password again
// straight after is friction with nothing to gain). The page POSTs this; a mail scanner that only fetches the page cannot use up the link.
router.post('/verify-email', async (req, res, next) => {
    try {
        const userId = await redeemToken(req.body.token, 'email_verify');
        const current = await prisma.user.findUnique({ where: { id: userId } });
        const user = current && current.emailVerifiedAt ? current : await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
        const canSignIn = user.accountStatus !== 'suspended';
        // A seller whose shop is still a draft is taken straight to setting it up (this is the link they open right after choosing "Sell").
        let needsOnboarding = false;
        if (user.role === 'seller') {
            const shop = await prisma.store.findUnique({ where: { ownerId: user.id }, select: { isPublished: true } });
            needsOnboarding = !!shop && !shop.isPublished;
        }
        res.json({ data: publicUser(user), needsOnboarding, ...(canSignIn ? { token: signToken(user, false) } : {}) });
    } catch (err) {
        next(err);
    }
});

// What the sign-in pages need to know before they draw: is "Continue with Google" set up, and which client id to give Google's button.
router.get('/config', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30');   // short: whether email is working can change within minutes
    const mail = mailStatus();
    res.json({ data: { google: googleVerifier.configured ? { clientId: config.googleClientIds[0] } : null, googleSetupHint: !googleVerifier.configured && !config.isProd, email: { available: mail.available, devMode: mail.devMode } } });
});

// "Continue with Google". The page sends the signed token Google gave it; we verify it ourselves (see ../googleAuth.js for the rules).
router.post('/google', authLimiter, validateBody(googleSchema), async (req, res, next) => {
    try {
        const result = await googleSignIn({
            prisma, verifier: googleVerifier, apiError,
            hashRandomPassword: () => passwords.hash(crypto.randomBytes(32).toString('hex'), 10),
            starterStore: async (name, email) => starterStoreData(name, email, await uniqueSlug(`${name}-store`)),
            signToken,
            afterSignup: (user, input, isSeller) => afterNewAccount(user, input, isSeller)
        }, { ...req.body, ip: req.ip });
        if (result.passwordReset) await removeAllSubscriptionsForUser(result.user.id).catch(() => {});
        res.status(result.isNew ? 201 : 200).json({ token: result.token, user: publicUser(result.user), isNew: result.isNew, linked: result.linked });
    } catch (err) {
        if (err instanceof GoogleAuthError) return next(apiError(err.message, err.status, `GOOGLE_${err.code}`));
        next(err);
    }
});

module.exports = router;
