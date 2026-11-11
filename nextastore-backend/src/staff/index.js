'use strict';
/*
 * The Staff Console API: everything under /api/staff.
 *
 * Nothing here shares code paths with the shopper API's login: no shopper token is accepted, no staff cookie is read by the shopper
 * routes. Order of the stack below matters:
 *   1. private headers + IP allow-list + an overall rate limit
 *   2. /auth   (public, each route rate-limited, a few require a session)
 *   3. /me     (a session; reachable while a forced password change is pending)
 *   4. everything else: a full session, CSRF + Origin checked, password-change gate, then per-route permission checks
 */
const express = require('express');
const A = require('./auth');
const { staffApiLimiter } = require('./limiters');

function buildStaffRouter({ growthAdminRouter } = {}) {
    const router = express.Router();
    router.use(A.privateHeaders, A.ipGate, staffApiLimiter);
    router.use('/auth', require('./routes/auth'));
    router.use('/me', require('./routes/me'));

    const authed = express.Router();
    authed.use(A.requireStaff());
    authed.use(require('./routes/overview'));
    authed.use(require('./routes/people'));
    authed.use(require('./routes/finance'));
    authed.use(require('./routes/support'));
    authed.use(require('./routes/comms'));
    authed.use(require('./routes/team'));
    if (growthAdminRouter) authed.use('/growth', growthAdminRouter);
    router.use(authed);

    router.use((req, res, next) => next(Object.assign(new Error(`No route for ${req.method} ${req.path}`), { status: 404, code: 'NOT_FOUND' })));
    // The console always gets { message, code }: its pages branch on the code (REAUTH_REQUIRED, STAFF_SESSION_IDLE, ...).
    router.use((err, req, res, next) => {
        if (err && err.code === 'P2002') return res.status(409).json({ message: 'That value is already in use.', code: 'CONFLICT' });
        if (err && err.code === 'P2025') return res.status(404).json({ message: 'Not found.', code: 'NOT_FOUND' });
        const status = (err && (err.status || err.statusCode)) || 500;
        if (status >= 500 && status !== 503) console.error('[staff]', err);
        const message = status >= 500 && status !== 503 ? 'Something went wrong.' : (err && err.message) || 'Something went wrong.';
        res.status(status).json({ message, code: (err && err.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) ? err.code : (status >= 500 ? 'SERVER_ERROR' : 'ERROR') });
    });
    return router;
}

module.exports = { buildStaffRouter };
