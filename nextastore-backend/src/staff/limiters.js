'use strict';
/* Rate limiters for the staff sign-in surface. Same Redis-sharing approach as routes/auth.js. */
const rateLimit = require('express-rate-limit');
const cache = require('../cache');

function store(prefix) {
    if (!cache.isRedisEnabled()) return undefined;
    try {
        const RedisStore = require('rate-limit-redis');
        return new RedisStore({ prefix, sendCommand: (...args) => cache.redisClient.call(...args) });
    } catch (err) { return undefined; }
}
const limitEnv = (name, fallback) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
const make = (prefix, opts) => rateLimit({ standardHeaders: true, legacyHeaders: false, store: store(prefix), ...opts });

// Failed attempts only: a successful sign-in from a shared office connection must not eat the budget.
const authIpLimiter = make('rl:staff-ip:', { windowMs: 15 * 60 * 1000, limit: limitEnv('STAFF_AUTH_IP_LIMIT', 15), skipSuccessfulRequests: true, message: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' } });
// One target address, many source IPs (botnet): capped per e-mail as well.
const authEmailLimiter = make('rl:staff-email:', {
    windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
    keyGenerator: (req) => String((req.body && req.body.email) || '').trim().toLowerCase() || req.ip,
    message: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' }
});
// Everything that sends an e-mail (forgot password) counts every call.
const mailLimiter = make('rl:staff-mail:', { windowMs: 60 * 60 * 1000, limit: 10, message: { message: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' } });
// Whole-console ceiling per IP.
const staffApiLimiter = make('rl:staff-api:', { windowMs: 60 * 1000, limit: 400, message: { message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' } });

module.exports = { authIpLimiter, authEmailLimiter, mailLimiter, staffApiLimiter };
