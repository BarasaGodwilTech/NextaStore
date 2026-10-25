/**
 * Shared plumbing for the growth services. Everything the folder needs from the host
 * app is injected here, so nothing in growth/ imports from outside growth/ and the whole
 * thing can be wired (or unwired) in one place (see INTEGRATION_GUIDE).
 *
 *   createContext({
 *     prisma,                // the app's Prisma client
 *     createNotification,    // helpers.createNotification({ userId, type, title, body, link })
 *     recordAdminAudit,      // helpers.recordAdminAudit({ actorId, action, targetType, targetId, targetUserId, metadata })
 *     apiError,              // utils.apiError(message, status, code)
 *     savePrivateImage,      // optional async (dataUrl, folder) => storedKey. MUST store privately (not under the public /uploads)
 *     hosts,                 // optional createHosts(...) result: where Circle, Crew and the main site live (default: path mode)
 *     now                    // optional clock, for tests
 *   })
 */
const R = require('./rules');
const { createHosts } = require('./hosts');

function createContext(deps) {
    const { prisma } = deps;
    if (!prisma) throw new Error('growth: prisma is required');
    const apiError = deps.apiError || ((message, status = 400, code) => Object.assign(new Error(message), { status, code }));
    const clock = deps.now || (() => new Date());

    const hosts = deps.hosts || createHosts({ mode: 'path' });

    // A notification's link. Callers pass '/circle' or '/crew' (or the old '/scouts'), or nothing; both are turned into the
    // right page for this deployment (a path on the main site, or the program's own subdomain). With no
    // link at all we look the person up so a Crew member is never sent to the Circle page.
    const programLink = (program, path = '/') => hosts.programUrl(program, path);
    async function linkFor(userId, link) {
        if (link === '/circle') return programLink('circle');
        if (link === '/crew' || link === '/scouts') return programLink('scout');
        if (link) return link;
        try {
            const p = await prisma.growthPartner.findUnique({ where: { userId }, select: { program: true } });
            return programLink(p ? p.program : 'circle');
        } catch (err) { return programLink('circle'); }
    }
    const notify = async (userId, title, body, link) => {
        if (!userId || !deps.createNotification) return;
        try { await deps.createNotification({ userId, type: 'growth', title, body, link: await linkFor(userId, link) }); }
        catch (err) { console.error('[growth] notification failed:', err.message); } // a missed bell never breaks money logic
    };

    const audit = async (actorId, action, targetType, targetId, metadata = {}, targetUserId = null) => {
        if (!deps.recordAdminAudit || !actorId) return;
        try { await deps.recordAdminAudit({ actorId, action: `growth.${action}`, targetType, targetId, targetUserId, metadata }); }
        catch (err) { console.error('[growth] audit failed:', err.message); }
    };

    /** The single settings row, created on first read. */
    async function getSettings() {
        let row = await prisma.growthSettings.findUnique({ where: { id: 'singleton' } });
        if (!row) row = await prisma.growthSettings.create({ data: { id: 'singleton' } });
        return row;
    }

    async function holidays() { return (await getSettings()).extraHolidays || []; }

    /** Boost % from any live campaign that applies to this program + district. Highest wins, they never stack. */
    async function campaignBoost(program, district, at) {
        const rows = await prisma.growthCampaign.findMany({
            where: { isActive: true, startsAt: { lte: at }, endsAt: { gte: at }, boostPercent: { gt: 0 } }
        });
        const applicable = rows.filter((c) => (!c.program || c.program === program) && (!c.district || c.district === district));
        return applicable.reduce((m, c) => Math.max(m, c.boostPercent), 0);
    }

    const fmtUGX = (n) => `UGX ${Number(n).toLocaleString('en-UG')}`;

    return { prisma, apiError, now: clock, savePrivateImage: deps.savePrivateImage || null, hosts, programLink, notify, audit, getSettings, holidays, campaignBoost, fmtUGX, R };
}

module.exports = { createContext };
