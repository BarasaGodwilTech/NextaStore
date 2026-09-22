const jwt = require('jsonwebtoken');
const config = require('./config');
const prisma = require('./prisma');
const { apiError } = require('./utils');

const ADMIN_PERMISSIONS = Object.freeze({
    DASHBOARD_VIEW: 'dashboard.view',
    USERS_VIEW: 'users.view',
    USERS_EDIT: 'users.edit',
    USERS_SUSPEND: 'users.suspend',
    USERS_PASSWORD_RESET: 'users.password_reset',
    ADMINS_MANAGE: 'admins.manage',
    ROLES_MANAGE: 'roles.manage',
    REPORTS_REVIEW: 'reports.review',
    SUBSCRIPTIONS_REVIEW: 'subscriptions.review',
    SETTINGS_MANAGE: 'settings.manage',
    FOLLOWUPS_MANAGE: 'followups.manage',
    AUDIT_VIEW: 'audit.view'
});

// Only HS256 is ever issued (see signSessionToken). Pinning it on verify means a
// token can never be accepted under a different algorithm than the one we sign with.
const JWT_ALGORITHM = 'HS256';

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Which lifetime rules apply to this person. Admins never get "remember me",
// whatever the login form sent: their consoles hold everyone's data, so they
// get the short inactivity window and the short absolute cap.
function policyFor(role, rememberMe) {
    if (role === 'admin') return config.sessionPolicies.admin;
    return rememberMe ? config.sessionPolicies.remember : config.sessionPolicies.session;
}

async function userFromAuthHeader(req) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return { user: null, errorCode: 'NO_TOKEN' };

    let payload;
    try {
        payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] });
    } catch (err) {
        return { user: null, errorCode: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
    }
    if (!payload || typeof payload.userId !== 'string') return { user: null, errorCode: 'TOKEN_INVALID' };

    // A database failure is NOT an auth failure. Reporting it as TOKEN_INVALID
    // made the browser wipe a perfectly good login every time Postgres blipped
    // (a deploy, a pool timeout). Surface it as a 503 instead: the client keeps
    // the session and the person just retries.
    let user;
    try {
        user = await prisma.user.findUnique({
            where: { id: payload.userId },
            include: { adminRole: true }
        });
    } catch (err) {
        console.error('[auth] user lookup failed:', err.message);
        throw apiError('We are having trouble right now. Please try again in a moment.', 503, 'SERVICE_UNAVAILABLE');
    }

    if (!user) return { user: null, errorCode: 'TOKEN_INVALID' };
    if (user.accountStatus === 'suspended') return { user: null, errorCode: 'ACCOUNT_SUSPENDED' };

    // Revocation: a password change, a reset or "log out everywhere" bumps
    // User.tokenVersion, which kills every token issued before it. Tokens
    // minted before this column existed have no `tv`; they count as version 0,
    // which is what every existing row starts at, so nobody is logged out by
    // the deploy itself.
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) return { user: null, errorCode: 'TOKEN_REVOKED' };

    // Absolute cap, measured from the original password login (`at`). Tokens
    // issued before `at` existed fall back to their own issue time.
    const authTime = payload.at || payload.iat || 0;
    if (nowSeconds() - authTime > policyFor(user.role, payload.rm).maxAgeSeconds) {
        return { user: null, errorCode: 'TOKEN_EXPIRED' };
    }

    return { user, errorCode: null, payload };
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------
// The payload carries:
//   userId — who the session belongs to
//   rm     — "remember me", so a renewal re-issues the SAME kind of session
//   at     — when the person actually typed their password. Renewals copy it
//            forward unchanged; it is what the absolute cap is measured from
//   tv     — User.tokenVersion at issue time (revocation, see above)
// `exp` is computed here rather than via jsonwebtoken's `expiresIn`, so a token
// can never be given a lifetime that runs past the absolute cap.
function signSessionToken(user, rememberMe = false, authTime = null) {
    const now = nowSeconds();
    const rm = user.role !== 'admin' && !!rememberMe;
    const policy = policyFor(user.role, rm);
    const at = authTime || now;
    const exp = Math.min(now + policy.ttlSeconds, at + policy.maxAgeSeconds);
    return jwt.sign(
        { userId: user.id, rm, at, tv: user.tokenVersion || 0, iat: now, exp },
        config.jwtSecret,
        { algorithm: JWT_ALGORITHM }
    );
}

// Requests the browser makes on its own timer (unread badges, message polling)
// prove a tab is OPEN, not that a person is there. If they renewed the token,
// a tab left on a desk would keep its session alive forever.
const BACKGROUND_PATH = /^\/api\/(messages|notifications)\/unread-count$/;
// Presence streams (routes/presence.js) are the clearest case of all: a
// stream is open for as long as a tab is, and it reconnects on its own every
// few minutes. If those reconnects renewed the token, a forgotten tab would
// keep its own session alive forever and the inactivity timeout would never
// fire. Any method: the stream is a POST (it carries a body).
const BACKGROUND_ANY_METHOD_PATH = /^\/api\/presence(\/|$)/;

function isBackgroundRequest(req) {
    if (!req) return false;
    if (typeof req.get === 'function' && req.get('X-Background-Poll') === '1') return true;
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (BACKGROUND_ANY_METHOD_PATH.test(path)) return true;
    return req.method === 'GET' && BACKGROUND_PATH.test(path);
}

// Sliding expiry. Once a token is past the halfway point of its inactivity
// window, hand the client a fresh one on the next REAL request. That makes the
// window a limit on inactivity: somebody using the site is never logged out
// mid-session, an abandoned token still dies on schedule, and (see
// signSessionToken) no amount of use carries a session past its absolute cap.
//
// The frontend picks this up in apiRequest() (js/main.js). A client that
// ignores the header simply keeps its existing token until it expires.
const RENEW_AFTER_FRACTION = 0.5;
const MIN_RENEWAL_GAIN_SECONDS = 60;

function attachRenewedToken(res, payload, user, req) {
    if (!payload || !payload.exp || !user) return;
    if (isBackgroundRequest(req)) return;
    try {
        const now = nowSeconds();
        const remaining = payload.exp - now;
        if (remaining <= 0) return;

        const policy = policyFor(user.role, payload.rm);
        if (remaining > policy.ttlSeconds * RENEW_AFTER_FRACTION) return;

        const authTime = payload.at || payload.iat || now;
        const newExp = Math.min(now + policy.ttlSeconds, authTime + policy.maxAgeSeconds);
        // Near the absolute cap a renewal would hand back the same expiry
        // again on every request; skip those instead of being noisy.
        if (newExp - payload.exp < MIN_RENEWAL_GAIN_SECONDS) return;

        res.setHeader('X-Session-Token', signSessionToken(user, payload.rm, authTime));
    } catch (err) {
        // A failure to renew must never break the request the user actually
        // made — they still hold a valid token for the rest of its life.
        console.warn('Could not renew session token:', err.message);
    }
}

// Responses that depend on who is logged in must never be stored by a browser
// or shared cache and replayed for the next person on the device.
function markPrivate(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Authorization');
}

async function optionalAuth(req, res, next) {
    try {
        const result = await userFromAuthHeader(req);
        req.user = result.user;
        req.authErrorCode = result.errorCode;
        req.authPayload = result.payload || null;
        if (result.user) {
            markPrivate(res);
            attachRenewedToken(res, result.payload, result.user, req);
        }
        next();
    } catch (err) { next(err); }
}

async function requireAuth(req, res, next) {
    try {
        const result = await userFromAuthHeader(req);
        if (!result.user) {
            const message = result.errorCode === 'ACCOUNT_SUSPENDED'
                ? 'This account is suspended. Please contact NextaStore support.'
                : (result.errorCode === 'TOKEN_REVOKED'
                    ? 'You were signed out because your password changed or sessions were ended. Please sign in again.'
                    : 'You need to be logged in.');
            return next(apiError(message, result.errorCode === 'ACCOUNT_SUSPENDED' ? 403 : 401, result.errorCode));
        }
        req.user = result.user;
        req.authPayload = result.payload;
        markPrivate(res);
        attachRenewedToken(res, result.payload, result.user, req);
        next();
    } catch (err) { next(err); }
}

function requireSeller(req, res, next) {
    if (!req.user) return next(apiError('You need to be logged in.', 401));
    if (req.user.role !== 'seller') return next(apiError('This action is only available to seller accounts.', 403));
    next();
}

function isSuperAdmin(user) {
    return !!user && user.role === 'admin' && user.adminLevel === 'super_admin';
}

function hasAdminPermission(user, permission) {
    if (!user || user.role !== 'admin') return false;
    if (isSuperAdmin(user)) return true;
    return Array.isArray(user.adminRole?.permissions) && user.adminRole.permissions.includes(permission);
}

function requireAdmin(req, res, next) {
    if (!req.user) return next(apiError('You need to be logged in.', 401));
    if (req.user.role !== 'admin') return next(apiError('Administrator access is required.', 403));
    next();
}

function requireAdminPermission(permission) {
    return (req, res, next) => {
        if (!req.user) return next(apiError('You need to be logged in.', 401));
        if (!hasAdminPermission(req.user, permission)) {
            return next(apiError('You do not have permission to perform this action.', 403));
        }
        next();
    };
}

// For endpoints that more than one kind of admin legitimately needs (e.g. the
// user-update route is shared by "edit accounts" and "suspend accounts"), the
// route guard admits any of the listed permissions and the handler then
// enforces the exact one per field it is asked to change.
function requireAnyAdminPermission(...permissions) {
    return (req, res, next) => {
        if (!req.user) return next(apiError('You need to be logged in.', 401));
        if (!permissions.some((p) => hasAdminPermission(req.user, p))) {
            return next(apiError('You do not have permission to perform this action.', 403));
        }
        next();
    };
}

function notFound(req, res, next) {
    next(apiError(`No route for ${req.method} ${req.path}`, 404));
}

function errorHandler(err, req, res, next) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'That value is already in use.' });
    if (err.code === 'P2025') return res.status(404).json({ message: 'Not found.' });

    const status = err.status || err.statusCode || 500;
    if (status >= 500 && status !== 503) console.error(err);
    const payload = { message: status >= 500 && status !== 503 ? 'Something went wrong.' : (err.message || 'Something went wrong.') };
    if (err.code && (/^TOKEN_|^ACCOUNT_|^SERVICE_UNAVAILABLE$/.test(err.code))) payload.code = err.code;
    if (status === 413) payload.message = 'That upload is too large.';
    res.status(status).json(payload);
}

module.exports = {
    signSessionToken,
    isBackgroundRequest,
    userFromAuthHeader,
    optionalAuth,
    requireAuth,
    requireSeller,
    requireAdmin,
    requireAdminPermission,
    requireAnyAdminPermission,
    hasAdminPermission,
    isSuperAdmin,
    ADMIN_PERMISSIONS,
    notFound,
    errorHandler
};
