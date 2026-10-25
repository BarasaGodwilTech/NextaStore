/**
 * The ONE shared NextaStore Circle / Crew (growth program) object.
 *
 * Lives in its own file so app.js and the route files (auth, user, store, subscription, admin) can all
 * require it without a circular import through app.js. Every hook is `growth.hooks.safe.*`: a failure is
 * logged and swallowed, so it can never break a signup, a store launch or a payment approval.
 */
const prisma = require('./prisma');
const helpers = require('./helpers');
const { apiError } = require('./utils');
const privateStorage = require('./privateStorage');
const { createGrowth } = require('./growth');

const growth = createGrowth({
    prisma,
    createNotification: helpers.createNotification,
    recordAdminAudit: helpers.recordAdminAudit,
    apiError,
    // Only when a private bucket is configured; otherwise Crew applications answer "uploads are not set up".
    savePrivateImage: privateStorage.enabled ? privateStorage.savePrivateImage : undefined
});

module.exports = growth;
module.exports.sendKyc = privateStorage.sendPrivateFile;
