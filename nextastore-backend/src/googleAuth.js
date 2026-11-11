/**
 * "Continue with Google".
 *
 * The browser shows Google's own button (Google Identity Services). When the person approves, Google hands the page a signed
 * ID token (a JWT). The page sends that token here; we check it ourselves and never trust anything else the page says about who
 * the person is. Nothing in this file talks to Google except one public request for Google's signing keys.
 *
 *   createGoogleVerifier({ clientIds })  .verify(credential) -> { sub, email, name, picture }   or throws GoogleAuthError
 *   googleSignIn(deps, input)            find / link / create the NextaStore account for that Google identity
 *
 * Verification uses Node's built-in `crypto` only (no extra package): RS256 signature against Google's published keys, then
 * issuer, audience (must be OUR client id), expiry, and "Google says this email is verified".
 *
 * Account linking rules (the part that matters for security):
 *   1. Same Google account seen before            -> sign in.
 *   2. An account with that email already exists:
 *        - suspended                              -> refused.
 *        - an admin account                       -> refused (admins sign in with their password; no silent takeover path).
 *        - already linked to a DIFFERENT Google   -> refused.
 *        - email already verified by its owner    -> link, sign in.
 *        - email NEVER verified                   -> link, but also throw away the old password and sign out every old session.
 *          Why: someone could have registered "victim@gmail.com" with a password of their own before the real owner ever came.
 *          Google proves the real owner is here now, so whatever password that squatter chose must stop working.
 *   3. No account                                  -> create one (buyer by default, seller if they chose to open a shop), already verified.
 */
'use strict';
const crypto = require('crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const MIN_REFETCH_MS = 60 * 1000;                                  // an attacker sending random key ids must not make us hammer Google

class GoogleAuthError extends Error {
    constructor(code, message, status = 401) { super(message); this.code = code; this.status = status; }
}

const fromB64Url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const parseJson = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } };

/** The default way to get Google's current signing keys: one HTTPS request, 5 second limit. */
async function fetchGoogleKeys() {
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Google keys answered ${res.status}`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]);
    const body = await res.json();
    return { keys: Array.isArray(body.keys) ? body.keys : [], maxAgeSec: Number.isFinite(maxAge) ? maxAge : 3600 };
}

function createGoogleVerifier({ clientIds = [], fetchKeys = fetchGoogleKeys, now = () => Date.now(), skewMs = 60 * 1000 } = {}) {
    const ids = new Set(clientIds.map((x) => String(x).trim()).filter(Boolean));
    let keys = new Map(), keysExpireAt = 0, lastFetchAt = 0, inflight = null;

    async function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const got = await fetchKeys();
                const next = new Map();
                for (const jwk of got.keys || []) if (jwk && jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
                if (!next.size) throw new Error('no usable keys');
                keys = next; lastFetchAt = now(); keysExpireAt = lastFetchAt + Math.max(60, got.maxAgeSec || 3600) * 1000;
            } catch (e) {
                throw new GoogleAuthError('CERTS_UNAVAILABLE', 'We could not reach Google just now. Please try again in a moment, or sign in with your email.', 503);
            } finally { inflight = null; }
        })();
        return inflight;
    }
    async function keyFor(kid) {
        if (!keys.size || now() >= keysExpireAt) await refresh();
        if (!keys.has(kid) && now() - lastFetchAt >= MIN_REFETCH_MS) await refresh();   // Google rotates keys: one fresh look for an unknown id
        return keys.get(kid) || null;
    }

    async function verify(credential) {
        if (!ids.size) throw new GoogleAuthError('NOT_CONFIGURED', 'Google sign-in is not set up on this site.', 501);
        if (typeof credential !== 'string' || credential.length > 8192) throw new GoogleAuthError('MALFORMED', 'That Google sign-in could not be read. Please try again.');
        const parts = credential.split('.');
        if (parts.length !== 3) throw new GoogleAuthError('MALFORMED', 'That Google sign-in could not be read. Please try again.');
        const header = parseJson(fromB64Url(parts[0])), payload = parseJson(fromB64Url(parts[1]));
        if (!header || !payload) throw new GoogleAuthError('MALFORMED', 'That Google sign-in could not be read. Please try again.');
        // Only RS256. A token that says "alg: none" or "HS256" is the classic forgery and is refused before any key is touched.
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleAuthError('BAD_ALG', 'That Google sign-in is not valid.');

        const key = await keyFor(header.kid);
        if (!key) throw new GoogleAuthError('UNKNOWN_KEY', 'That Google sign-in is not valid.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64Url(parts[2]));
        if (!ok) throw new GoogleAuthError('BAD_SIGNATURE', 'That Google sign-in is not valid.');

        const t = now();
        if (!ISSUERS.has(payload.iss)) throw new GoogleAuthError('BAD_ISSUER', 'That Google sign-in is not valid.');
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!aud.some((a) => ids.has(a))) throw new GoogleAuthError('BAD_AUDIENCE', 'That Google sign-in was made for a different site.');
        if (!Number.isFinite(payload.exp) || payload.exp * 1000 < t - skewMs) throw new GoogleAuthError('EXPIRED', 'That Google sign-in has expired. Please try again.');
        if (Number.isFinite(payload.iat) && payload.iat * 1000 > t + skewMs) throw new GoogleAuthError('NOT_YET_VALID', 'Your device clock looks wrong. Please check the time and try again.');
        if (typeof payload.sub !== 'string' || !payload.sub) throw new GoogleAuthError('MALFORMED', 'That Google sign-in is not valid.');
        if (typeof payload.email !== 'string' || !payload.email.includes('@')) throw new GoogleAuthError('NO_EMAIL', 'Google did not share an email address with us.');
        if (!(payload.email_verified === true || payload.email_verified === 'true')) throw new GoogleAuthError('EMAIL_UNVERIFIED', 'Your Google email address is not verified, so we cannot use it.');

        const email = payload.email.trim().toLowerCase();
        const name = String(payload.name || payload.given_name || email.split('@')[0]).trim().slice(0, 80) || 'NextaStore member';
        return { sub: payload.sub, email, name, picture: typeof payload.picture === 'string' ? payload.picture : null };
    }
    return { verify, configured: ids.size > 0, clientIds: [...ids] };
}

/**
 * deps  = { prisma, verifier, apiError, hashRandomPassword(), starterStore(name, email) -> data, signToken(user, remember), afterSignup(user, input, isSeller) }
 * input = { credential, accountType, rememberMe, referralCode, referralVia, deviceHash, ip }
 * Returns { user, token, isNew, linked, passwordReset }
 */
async function googleSignIn(deps, input, attempt = 0) {
    const { prisma, verifier, apiError } = deps;
    const claims = await verifier.verify(input.credential);

    const suspended = (u) => { if (u.accountStatus === 'suspended') throw apiError('This account is suspended. Please contact NextaStore support.', 403, 'ACCOUNT_SUSPENDED'); };
    const finish = (user, extra = {}) => ({ user, token: deps.signToken(user, !!input.rememberMe), isNew: false, linked: false, passwordReset: false, ...extra });

    try {
        let user = await prisma.user.findUnique({ where: { googleId: claims.sub } });
        if (user) { suspended(user); return finish(user); }

        user = await prisma.user.findUnique({ where: { email: claims.email } });
        if (user) {
            suspended(user);
            if (user.googleId && user.googleId !== claims.sub) throw apiError('That email is linked to a different Google account.', 409, 'GOOGLE_MISMATCH');
            const wasVerified = !!user.emailVerifiedAt;
            const data = { googleId: claims.sub };
            if (!wasVerified) {
                data.emailVerifiedAt = new Date();
                data.passwordHash = await deps.hashRandomPassword();           // the squatter's password stops working
                data.tokenVersion = { increment: 1 };                           // and so does every session they opened
            }
            const updated = await prisma.user.update({ where: { id: user.id }, data });
            if (!wasVerified) await prisma.verificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
            return finish(updated, { linked: true, passwordReset: !wasVerified });
        }

        const isSeller = input.accountType === 'seller';
        const created = await prisma.user.create({
            data: {
                name: claims.name, email: claims.email, googleId: claims.sub, passwordHash: await deps.hashRandomPassword(),
                emailVerifiedAt: new Date(), role: isSeller ? 'seller' : 'buyer',
                ...(isSeller ? { store: { create: await deps.starterStore(claims.name, claims.email) } } : {})
            }
        });
        if (deps.afterSignup) deps.afterSignup(created, input, isSeller);
        return finish(created, { isNew: true });
    } catch (err) {
        // Two first sign-ins arriving at the same moment: the second one hits the unique rule. Look again, once.
        if (err && err.code === 'P2002' && attempt === 0) return googleSignIn(deps, input, 1);
        throw err;
    }
}

module.exports = { createGoogleVerifier, googleSignIn, GoogleAuthError, JWKS_URL };
