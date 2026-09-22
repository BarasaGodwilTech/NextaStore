const crypto = require('crypto');
const prisma = require('./prisma');
const { apiError } = require('./utils');

const TTL_MS = {
    password_reset: 60 * 60 * 1000, // 1 hour
    email_verify: 24 * 60 * 60 * 1000 // 24 hours
};

/** Issues a token, storing only its hash (see schema comment on
 *  VerificationToken), and returns the raw token — the only place the raw
 *  value ever exists is this return value and the email it goes into.
 *
 *  Also retires every OTHER not-yet-used token of the same type for this
 *  user. Without this, requesting a second reset link (people do this
 *  routinely — "didn't arrive, let me try again") left the first link live
 *  until it expired on its own an hour later: two valid reset links for the
 *  same account at once, including whichever one a person clicked by
 *  mistake from an old email. */
async function issueToken(userId, type) {
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await prisma.$transaction([
        prisma.verificationToken.updateMany({
            where: { userId, type, usedAt: null },
            data: { usedAt: new Date() }
        }),
        prisma.verificationToken.create({
            data: { userId, type, tokenHash, expiresAt: new Date(Date.now() + TTL_MS[type]) }
        })
    ]);
    return raw;
}

/** Redeems a token: validates it exists, matches the expected type, hasn't
 *  expired, and hasn't already been used, then marks it used. Throws a
 *  generic "invalid or expired" error either way rather than distinguishing
 *  "wrong type" from "expired" from "already used" — those distinctions
 *  aren't useful to an attacker probing token values and aren't useful to a
 *  legitimate user either (the fix is the same: request a new link).
 *
 *  The lookup and the "mark used" write must happen as one atomic step:
 *  find-then-update let two requests racing on the same still-valid token
 *  (a double-tapped submit button, a retried request) both pass the
 *  find-unused check before either write landed, and both would then
 *  succeed — the second password reset silently undoing the first, or an
 *  email verified twice. updateMany's WHERE re-checks usedAt at the moment
 *  of the write itself, so only the request that actually wins the race
 *  can ever flip it, and every other match sees `count: 0`. */
async function redeemToken(raw, type) {
    if (!raw || typeof raw !== 'string') throw apiError('This link is invalid or has expired.', 400);
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

    const result = await prisma.verificationToken.updateMany({
        where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() }
    });
    if (result.count === 0) throw apiError('This link is invalid or has expired.', 400);

    // The row is already claimed at this point; this read is just to get
    // the userId back to the caller, not part of the validity check.
    const token = await prisma.verificationToken.findUnique({ where: { tokenHash } });
    if (!token) throw apiError('This link is invalid or has expired.', 400);
    return token.userId;
}

module.exports = { issueToken, redeemToken };
