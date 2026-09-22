const app = require('./src/app');
const config = require('./src/config');
const prisma = require('./src/prisma');
const presence = require('./src/presence');

// Note: there is no db.load()/auto-seed here anymore. Schema changes go
// through `npm run migrate:deploy` (prisma migrate deploy) as an explicit,
// separate step — never triggered from server boot. Running migrations from
// inside app startup is what causes race conditions the moment you run more
// than one instance, since every instance would try to migrate at once.
const server = app.listen(config.port, () => {
    console.log(`NextaStore API listening on http://localhost:${config.port} [${config.env}]`);
    // Printed on every boot because a wrong session lifetime is invisible
    // otherwise — it shows up only as users complaining about being logged
    // out, which is exactly the bug this line makes diagnosable. Compare
    // these against what you expect before hunting anywhere else.
    const describe = (ttl) => (typeof ttl === 'number' ? `${ttl}s` : ttl);
    console.log(`  session lifetimes: remember-me=${describe(config.jwtRememberTtl)}, standard=${describe(config.jwtSessionTtl)} (both slide forward on use)`);
    if (config.jwtSecret === 'dev-only-secret-change-me') {
        console.warn('  WARNING: JWT_SECRET is unset, using the development fallback. Every restart that changes this value invalidates all existing sessions.');
    }
});

async function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    // server.close() stops accepting connections but waits for open ones to
    // finish, and a presence stream is open for as long as its tab is. Without
    // ending them here every deploy's shutdown would hang until the platform
    // force-kills the process. Started BEFORE close() so the streams are
    // already draining when it begins waiting; it also saves who was around.
    const presenceDone = presence.shutdown().catch((err) => console.error('[presence] shutdown error:', err.message));
    server.close(async () => {
        await presenceDone;
        await prisma.$disconnect();
        process.exit(0);
    });
    // Belt and braces: never let a stuck socket hold a deploy hostage.
    setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Under real concurrent traffic, a single unhandled promise rejection
// anywhere in the app — a missed `.catch()`, an async callback Express
// doesn't wrap — would otherwise crash the ENTIRE process by default
// (Node 15+), instantly dropping every other in-flight request from every
// other concurrent user, not just the one that triggered it. That turns a
// single bad request into a full outage precisely when traffic is highest.
//
// unhandledRejection: log with full context and keep serving. This is a
// deliberate trade-off — the alternative (crash-and-let-the-platform-
// restart) is safer against slow memory/state corruption but guarantees an
// outage on every occurrence; logging-and-continuing accepts the small risk
// of a leaked promise for the much larger win of not taking down the whole
// service over one bad request. Route handlers are expected to catch and
// convert their own rejections to HTTP responses (see errorHandler in
// middleware.js) — this is the last-resort net for anything that slips
// past that.
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION — this indicates a missing .catch() somewhere and should be fixed, not just logged:', reason);
});

// uncaughtException means something threw synchronously outside any
// try/catch express could route to errorHandler — the process's internal
// state is no longer trustworthy at that point (mid-mutation, a corrupted
// module-level variable, etc.), so continuing to serve new requests risks
// silent data corruption, not just a crash. The correct response is to stop
// taking NEW requests, let in-flight ones finish, then exit — the hosting
// platform (Railway et al.) restarts the process automatically. This is
// strictly better under load than an unhandled crash: existing connections
// get a clean response instead of a dropped socket.
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION — shutting down for a clean restart:', err);
    // Same reason as shutdown(): open presence streams would otherwise keep
    // server.close() waiting until the 10s force-exit below.
    presence.shutdown().catch(() => {});
    server.close(async () => {
        try { await prisma.$disconnect(); } catch (_) { /* already going down */ }
        process.exit(1);
    });
    // Force-exit if connections don't drain within 10s, so a stuck socket
    // can't block the restart indefinitely.
    setTimeout(() => process.exit(1), 10000).unref();
});
