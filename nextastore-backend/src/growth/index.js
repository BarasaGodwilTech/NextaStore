/**
 * Growth program entry point. One call builds everything from the host app's pieces:
 *
 *   const growth = createGrowth({ prisma, createNotification, recordAdminAudit, apiError });
 *   growth.hooks.safe.onPaymentApproved({ ... })   // call from existing routes, never throws
 *   app.use('/api/growth', growth.routes({ requireAuth, requireAdminPermission, limiter }).partner);
 *   app.use('/api/admin/growth', growth.routes({ ... }).admin);
 *   app.use(growth.hostRouter({ pagesDir: __dirname + '/..' }));   // FIRST, before static: serves the circle. and crew. hosts (see docs/03)
 */
const { createContext } = require('./context');
const { createPartners } = require('./partners');
const { createHooks } = require('./hooks');
const { createLeads } = require('./leads');
const { createWithdrawals } = require('./withdrawals');
const { createAdmin } = require('./admin');
const { buildRoutes } = require('./routes');
const { createHosts } = require('./hosts');
const { createHostRouter } = require('./subdomains');
const R = require('./rules');

function createGrowth(deps) {
    const hosts = deps.hosts || createHosts();   // reads GROWTH_MODE / GROWTH_ROOT_DOMAIN... from the environment; default is path mode
    const ctx = createContext({ ...deps, hosts });
    const partners = createPartners(ctx);
    const hooks = createHooks(ctx, partners);
    const leads = createLeads(ctx, partners);
    const withdrawals = createWithdrawals(ctx, partners);
    const admin = createAdmin(ctx, partners);

    // Wrap every hook so a bug or a database blip in the growth code can NEVER break a signup,
    // a payment submission or an admin's payment approval. Failures are logged, not thrown.
    const safe = {};
    for (const name of ['onSignup', 'onStoreCreated', 'onStoreLive', 'onPaymentSubmitted', 'onPaymentApproved', 'onPaymentRejected', 'onPaymentReversed', 'recordPartnerIp']) {
        safe[name] = async (...args) => {
            try { return await hooks[name](...args); }
            catch (err) { console.error(`[growth] hook ${name} failed:`, err && err.message); return null; }
        };
    }

    return {
        ctx, partners, leads, withdrawals, admin, rules: R, hosts,
        hostRouter: (opts) => createHostRouter({ hosts, ...opts }),
        hooks: { ...hooks, safe },
        sweep: hooks.sweep,
        routes: (mw) => buildRoutes({ partners, hooks, leads, withdrawals, admin, ctx }, mw)
    };
}

module.exports = { createGrowth };
