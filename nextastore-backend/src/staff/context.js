'use strict';
/*
 * Per-request context for staff actions (ip, user agent, session). The staff auth middleware opens it; helpers.recordAdminAudit
 * reads it, so EVERY audit row written during a staff request (including by the Circle / Crew module, which knows nothing about
 * staff sessions) carries where it came from, without threading `req` through every function.
 */
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
module.exports = {
    run: (ctx, fn) => als.run(ctx, fn),
    get: () => als.getStore() || null
};
