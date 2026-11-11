'use strict';
/*
 * Staff authentication middleware and session handling.
 *
 *  - Sessions are SERVER-SIDE (StaffSession rows). The browser holds an opaque random token in an httpOnly, SameSite=Strict cookie;
 *    only its SHA-256 is stored. There is no JWT a script could read, no localStorage token, nothing shared with the shopper login.
 *  - Every state-changing request must carry the session's CSRF token (X-CSRF-Token) and, when the browser sends an Origin,
 *    that Origin must be one of config.staff.origins.
 *  - Idle timeout (lastSeenAt) and absolute lifetime (expiresAt) are enforced here on every request.
 *  - "Step-up": sensitive routes use requireRecentAuth(); the person must have re-entered a password / MFA code recently.
 */
const prisma = require('../prisma');
const config = require('../config');
const { apiError } = require('../utils');
const ctx = require('./context');
const { sha256, randomToken, safeEqual } = require('./crypto');
const { hasPermission, permissionsOf } = require('./permissions');
const { ipAllowed, normalizeIp } = require('./policy');

const S = config.staff;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOUCH_EVERY_MS = 60 * 1000;

// ---- cookies (no cookie-parser dependency) ---------------------------------------------------------------------------------------------
function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; } }
    }
    return '';
}
function cookieAttrs(maxAgeSeconds) {
    return [`Path=/api/staff`, 'HttpOnly', 'SameSite=Strict', S.cookieSecure ? 'Secure' : '', maxAgeSeconds != null ? `Max-Age=${maxAgeSeconds}` : ''].filter(Boolean).join('; ');
}
const setSessionCookie = (res, token) => res.append('Set-Cookie', `${S.cookieName}=${encodeURIComponent(token)}; ${cookieAttrs(S.absoluteHours * 3600)}`);
const clearSessionCookie = (res) => res.append('Set-Cookie', `${S.cookieName}=; ${cookieAttrs(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);

// Remembered-device cookie: long-lived, same attributes. It is only a pointer to a StaffDevice row; clearing it just means "ask for the code".
const setDeviceCookie = (res, token) => res.append('Set-Cookie', `${S.deviceCookieName}=${encodeURIComponent(token)}; ${cookieAttrs(S.deviceTrustDays * 86400)}`);

// ---- request metadata -------------------------------------------------------------------------------------------------------------------
const clientIp = (req) => normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
const clientAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 300);
const deviceLabel = (ua) => {
    const u = String(ua || '');
    const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
    const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Mac OS X/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : 'unknown OS';
    return `${browser} on ${os}`;
};

// ---- global gates ------------------------------------------------------------------------------------------------------------------------
/** Everything the console serves is private: never cached, never framed, never sniffed. */
function privateHeaders(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Frame-Options', 'DENY');
    res.vary('Cookie');
    next();
}

/** With STAFF_IP_ALLOWLIST set, anyone else gets a plain 404: the console does not even admit to existing. */
function ipGate(req, res, next) {
    if (ipAllowed(clientIp(req), S.ipAllowlist)) return next();
    return res.status(404).json({ message: `No route for ${req.method} ${req.originalUrl.split('?')[0]}` });
}

function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;                 // same-origin navigations and non-browser clients send none; the CSRF token still applies
    return S.origins.includes(origin);
}

// ---- sessions ---------------------------------------------------------------------------------------------------------------------------
/** Creates a session (and trims the oldest ones beyond the per-person cap). Returns { token, csrfToken, session }. */
async function createSession(staff, req, { deviceId = null } = {}) {
    const token = randomToken(32);
    const now = Date.now();
    const session = await prisma.staffSession.create({
        data: {
            staffId: staff.id, tokenHash: sha256(token), csrfToken: randomToken(24), deviceId,
            ip: clientIp(req), userAgent: clientAgent(req),
            expiresAt: new Date(now + S.absoluteHours * 3600 * 1000), reauthAt: new Date(0), lastSeenAt: new Date(now)
        }
    });
    const live = await prisma.staffSession.findMany({
        where: { staffId: staff.id, revokedAt: null, expiresAt: { gt: new Date(now) } }, orderBy: { createdAt: 'desc' }
    });
    const extra = live.slice(S.maxSessions);
    if (extra.length) {
        await prisma.staffSession.updateMany({ where: { id: { in: extra.map((s) => s.id) } }, data: { revokedAt: new Date(), revokedReason: 'session_limit' } });
    }
    return { token, csrfToken: session.csrfToken, session };
}

const revokeSession = (id, reason) => prisma.staffSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
const revokeAllSessions = (staffId, reason, exceptId = null) => prisma.staffSession.updateMany({
    where: { staffId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { revokedAt: new Date(), revokedReason: reason }
});

/**
 * Requires a signed-in staff session. On success: req.staff (with .role), req.staffSession, req.staffPermissions.
 * `allowPasswordChange` lets the "you must change your password" routes through; everything else is blocked until it is done.
 */
function requireStaff({ allowPasswordChange = false } = {}) {
    return async (req, res, next) => {
        try {
            const raw = readCookie(req, S.cookieName);
            if (!raw) return next(apiError('Please sign in.', 401, 'STAFF_NO_SESSION'));
            let session;
            try {
                session = await prisma.staffSession.findUnique({ where: { tokenHash: sha256(raw) } });
            } catch (err) {
                console.error('[staff] session lookup failed:', err.message);
                return next(apiError('We are having trouble right now. Please try again in a moment.', 503, 'SERVICE_UNAVAILABLE'));
            }
            const now = Date.now();
            if (!session || session.revokedAt) { clearSessionCookie(res); return next(apiError('Your session has ended. Please sign in again.', 401, 'STAFF_SESSION_ENDED')); }
            if (new Date(session.expiresAt).getTime() <= now) { clearSessionCookie(res); return next(apiError('Your session has expired. Please sign in again.', 401, 'STAFF_SESSION_EXPIRED')); }
            if (now - new Date(session.lastSeenAt).getTime() > S.idleMinutes * 60 * 1000) {
                await revokeSession(session.id, 'idle_timeout');
                clearSessionCookie(res);
                return next(apiError('You were signed out after a period of inactivity.', 401, 'STAFF_SESSION_IDLE'));
            }
            const staff = await prisma.staffAccount.findUnique({ where: { id: session.staffId }, include: { role: true } });
            if (!staff || staff.status !== 'active') {
                await revokeSession(session.id, 'account_inactive');
                clearSessionCookie(res);
                return next(apiError('This staff account is not active.', 403, 'STAFF_INACTIVE'));
            }
            // CSRF + Origin for anything that changes state.
            if (!SAFE_METHODS.has(req.method)) {
                if (!checkOrigin(req)) return next(apiError('Request origin not allowed.', 403, 'STAFF_BAD_ORIGIN'));
                if (!safeEqual(req.headers['x-csrf-token'], session.csrfToken)) return next(apiError('Security token missing or wrong. Reload the page and try again.', 403, 'STAFF_CSRF'));
            }
            if (staff.mustChangePassword && !allowPasswordChange) return next(apiError('You must set a new password before continuing.', 403, 'STAFF_PASSWORD_CHANGE_REQUIRED'));
            // Everyone sets a sensitive-action PIN right after their first sign-in; nothing but the PIN page (and /me) works until then.
            if (!staff.pinSetAt && !allowPasswordChange) return next(apiError('Set your security PIN to continue.', 403, 'STAFF_PIN_SETUP_REQUIRED'));

            // Keep the idle clock honest without a write on every request.
            if (!isBackgroundPoll(req) && now - new Date(session.lastSeenAt).getTime() > TOUCH_EVERY_MS) {
                prisma.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
                session.lastSeenAt = new Date(now);
            }
            req.staff = staff;
            req.staffSession = session;
            req.staffPermissions = permissionsOf(staff);
            const meta = { ip: clientIp(req), userAgent: clientAgent(req), sessionId: session.id, actorId: staff.id, actorLabel: `${staff.name} <${staff.email}>` };
            return ctx.run(meta, next);
        } catch (err) { return next(err); }
    };
}
// The console's own timers (e.g. refreshing a badge) must not keep a forgotten tab signed in forever.
const isBackgroundPoll = (req) => req.headers['x-background-poll'] === '1';

const need = (check) => (req, res, next) => {
    if (!req.staff) return next(apiError('Please sign in.', 401, 'STAFF_NO_SESSION'));
    if (!check(req.staff)) return next(apiError('You do not have permission to do that.', 403, 'STAFF_FORBIDDEN'));
    return next();
};
const requirePermission = (permission) => need((s) => hasPermission(s, permission));
const requireAnyPermission = (...list) => need((s) => list.some((p) => hasPermission(s, p)));

/** Step-up: the session must have confirmed its PIN (or a fresh authenticator code) within config.staff.reauthMinutes. */
function requireRecentAuth(req, res, next) {
    if (!req.staffSession) return next(apiError('Please sign in.', 401, 'STAFF_NO_SESSION'));
    if (Date.now() - new Date(req.staffSession.reauthAt).getTime() > S.reauthMinutes * 60 * 1000) {
        return next(apiError('Please confirm it is you to continue.', 403, 'REAUTH_REQUIRED'));
    }
    return next();
}

/**
 * Writes an audit row with who/where already filled in from the current request.
 * opts: { targetUserId, metadata, staff (acting person when req.staff is not set yet), actorLabel + anonymous (pre-login events) }
 */
function audit(req, action, targetType, targetId = null, { targetUserId = null, metadata = {}, staff = null, actorLabel = null, anonymous = false } = {}) {
    const { recordAdminAudit } = require('../helpers');
    const actor = anonymous ? null : (staff || req.staff || null);
    return recordAdminAudit({
        actorId: actor ? actor.id : null,
        actorLabel: actorLabel != null ? actorLabel : (actor ? `${actor.name} <${actor.email}>` : ''),
        action, targetType, targetId, targetUserId, metadata, ip: clientIp(req), userAgent: clientAgent(req)
    });
}

/** Audit for events with no signed-in session (login failures, invite acceptance, resets): the actor is named by label only. */
const auditAs = (req, label, action, targetType, targetId = null, opts = {}) => audit(req, action, targetType, targetId, { ...opts, anonymous: true, actorLabel: label });

module.exports = {
    readCookie, setSessionCookie, clearSessionCookie, setDeviceCookie, clientIp, clientAgent, deviceLabel,
    privateHeaders, ipGate, checkOrigin,
    createSession, revokeSession, revokeAllSessions,
    requireStaff, requirePermission, requireAnyPermission, requireRecentAuth, audit, auditAs
};
