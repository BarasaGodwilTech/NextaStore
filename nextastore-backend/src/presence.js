'use strict';
/**
 * Real-time presence (item 1 of the spec): who is connected right now, and
 * when somebody was last around.
 *
 * WHAT COUNTS AS "ONLINE"
 *   A person is online while at least one of their presence streams
 *   (routes/presence.js — one per open, visible tab) is connected. The
 *   connection itself is the source of truth; nothing is polled.
 *
 * FLICKER-FREE OFFLINE
 *   Navigating between pages closes one stream and opens another a moment
 *   later, and mobile networks drop and reconnect constantly. Announcing
 *   "offline" the instant the last stream closes would make the green dot
 *   blink on every page change, so offline is only announced once nobody
 *   has been connected for GRACE_MS. Reconnecting inside that window cancels
 *   it and nobody ever sees a change.
 *
 * LAST ACTIVE
 *   User.lastActiveAt (a nullable column) is written once when a person goes
 *   offline, plus a slow checkpoint while they are online so a crash or a
 *   restart never loses more than a few minutes of accuracy. It is written
 *   with raw SQL rather than prisma.user.update() on purpose: @updatedAt
 *   would otherwise bump User.updatedAt every few minutes, and the admin
 *   console shows that field as "last edited".
 *
 * MORE THAN ONE INSTANCE
 *   Without REDIS_URL, presence lives in this process's memory: fine for one
 *   instance and for local development, wrong the moment a second instance
 *   runs (a person connected to instance A looks offline to a viewer on
 *   instance B). With REDIS_URL each instance publishes its local users in a
 *   per-user hash with a short TTL and announces changes over pub/sub, the
 *   same opt-in pattern cache.js already uses. Boot logs which mode is active.
 *
 * NOTHING HERE KNOWS ABOUT HTTP. The route hands in a connection object
 * ({ send, ping, close }); everything is testable without Express.
 */
const crypto = require('crypto');

const DEFAULTS = Object.freeze({
    graceMs: 15 * 1000,
    heartbeatMs: 20 * 1000,        // keep-alive to every stream + Redis refresh
    checkpointMs: 3 * 60 * 1000,   // slow lastActiveAt write while online
    maxStreamAgeMs: 4 * 60 * 1000, // streams end themselves; the client re-authenticates on reconnect
    maxStreamsPerUser: 5,          // tabs; the oldest is replaced by the newest
    maxWatchPerStream: 100,
    remoteFreshMs: 60 * 1000,      // a Redis heartbeat older than this is treated as gone
    lastSeenCacheSize: 5000
});

const REDIS_KEY = (userId) => `ns:presence:u:${userId}`;
const REDIS_CHANNEL = 'ns:presence:events';
const REDIS_KEY_TTL_SECONDS = 90;

function createPresence({ redis = null, persist = async () => {}, now = () => Date.now(), options = {}, log = console } = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const instanceId = crypto.randomBytes(6).toString('hex');

    const conns = new Set();
    const byUser = new Map();        // userId -> Set(conn)
    const watchers = new Map();      // targetUserId -> Set(conn)
    const localOnline = new Set();   // userIds this instance has announced as online
    const graceTimers = new Map();   // userId -> { timer, seenAt }
    const lastSeen = new Map();      // userId -> ms, only for people who went offline on this instance
    let tickTimer = null;
    let lastCheckpointAt = now();
    let subscriber = null;
    let closed = false;

    // ------------------------------------------------------------ helpers
    const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

    function rememberLastSeen(userId, ms) {
        lastSeen.delete(userId);
        lastSeen.set(userId, ms);
        // Bounded: a long-running instance sees a lot of distinct people.
        while (lastSeen.size > cfg.lastSeenCacheSize) lastSeen.delete(lastSeen.keys().next().value);
    }

    function safeSend(conn, event, data) {
        try { return conn.send(event, data) !== false; } catch (err) { return false; }
    }

    /** Tells every stream watching `userId` (by any key) about the new state. */
    function announce(userId, state) {
        const set = watchers.get(userId);
        if (!set) return;
        for (const conn of [...set]) {
            for (const [key, target] of conn.watches) {
                // `at` lets the browser drop an event that is older than the
                // state it already holds (a snapshot and a live event can
                // cross on the wire).
                if (target === userId) safeSend(conn, 'presence', { key, online: state.online, lastActiveAt: state.lastActiveAt, at: now() });
            }
        }
    }

    function publish(userId, state) {
        if (!redis) return;
        try {
            Promise.resolve(redis.publish(REDIS_CHANNEL, JSON.stringify({ userId, online: state.online, lastActiveAt: state.lastActiveAt, origin: instanceId })))
                .catch(() => {});
        } catch (err) { /* best effort */ }
    }

    async function refreshRedisPresence(userIds) {
        if (!redis || !userIds.length) return;
        try {
            const pipeline = redis.pipeline();
            const stamp = String(now());
            for (const id of userIds) {
                pipeline.hset(REDIS_KEY(id), instanceId, stamp);
                pipeline.expire(REDIS_KEY(id), REDIS_KEY_TTL_SECONDS);
            }
            await pipeline.exec();
        } catch (err) { /* a Redis hiccup must never take a stream down */ }
    }

    /** Which of these people have a fresh heartbeat from ANY instance. */
    async function remoteOnlineSet(userIds) {
        const out = new Set();
        if (!redis || !userIds.length) return out;
        try {
            const pipeline = redis.pipeline();
            for (const id of userIds) pipeline.hgetall(REDIS_KEY(id));
            const results = await pipeline.exec();
            const cutoff = now() - cfg.remoteFreshMs;
            results.forEach((entry, i) => {
                const hash = entry && !entry[0] ? entry[1] : null;
                if (hash && Object.values(hash).some((ts) => Number(ts) > cutoff)) out.add(userIds[i]);
            });
        } catch (err) { /* treated as "nobody else online" */ }
        return out;
    }

    // ------------------------------------------------------- lifecycle ticks
    function startTicking() {
        if (tickTimer || closed) return;
        tickTimer = setInterval(tick, cfg.heartbeatMs);
        if (tickTimer.unref) tickTimer.unref();
        ensureSubscriber();
    }

    function stopTickingIfIdle() {
        if (tickTimer && conns.size === 0 && graceTimers.size === 0) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    async function tick() {
        const t = now();
        for (const conn of [...conns]) {
            if (t - conn.openedAt >= cfg.maxStreamAgeMs) { closeConn(conn, 'reconnect'); continue; }
            try { if (conn.ping) conn.ping(); } catch (err) { disconnect(conn); }
        }
        const online = [...localOnline];
        await refreshRedisPresence(online);
        if (t - lastCheckpointAt >= cfg.checkpointMs && online.length) {
            lastCheckpointAt = t;
            try { await persist(online, new Date(t)); } catch (err) { log.error('[presence] checkpoint failed:', err.message); }
        }
        stopTickingIfIdle();
    }

    function ensureSubscriber() {
        if (!redis || subscriber || typeof redis.duplicate !== 'function') return;
        try {
            subscriber = redis.duplicate();
            if (subscriber.on) subscriber.on('error', () => {});
            subscriber.on('message', (channel, message) => {
                if (channel !== REDIS_CHANNEL) return;
                let event;
                try { event = JSON.parse(message); } catch (err) { return; }
                if (!event || event.origin === instanceId || typeof event.userId !== 'string') return;
                // Somebody on another instance changed state. If this
                // instance still holds a live stream for them, it stays online.
                if (!event.online && localOnline.has(event.userId)) return;
                if (!event.online && event.lastActiveAt) {
                    const ms = Date.parse(event.lastActiveAt);
                    if (Number.isFinite(ms)) rememberLastSeen(event.userId, ms);
                }
                announce(event.userId, { online: !!event.online, lastActiveAt: event.online ? null : (event.lastActiveAt || null) });
            });
            Promise.resolve(subscriber.subscribe(REDIS_CHANNEL)).catch(() => {});
        } catch (err) {
            subscriber = null;
        }
    }

    // ------------------------------------------------------------ core API
    function markOnline(userId) {
        localOnline.add(userId);
        lastSeen.delete(userId);
        refreshRedisPresence([userId]);
        const state = { online: true, lastActiveAt: null };
        announce(userId, state);
        publish(userId, state);
    }

    async function goOffline(userId, seenAt) {
        graceTimers.delete(userId);
        // Reconnected while this was queued: nothing to announce.
        if (byUser.has(userId)) { stopTickingIfIdle(); return; }
        localOnline.delete(userId);
        if (redis) {
            try { await redis.hdel(REDIS_KEY(userId), instanceId); } catch (err) { /* ignore */ }
            // Another instance may still hold a live stream for this person.
            if ((await remoteOnlineSet([userId])).has(userId)) { stopTickingIfIdle(); return; }
            // A reconnect may also have landed on THIS instance while we awaited.
            if (byUser.has(userId)) { stopTickingIfIdle(); return; }
        }
        rememberLastSeen(userId, seenAt);
        try { await persist([userId], new Date(seenAt)); } catch (err) { log.error('[presence] could not save last-active time:', err.message); }
        const state = { online: false, lastActiveAt: iso(seenAt) };
        announce(userId, state);
        publish(userId, state);
        stopTickingIfIdle();
    }

    function removeFromWatchers(conn) {
        for (const target of new Set(conn.watches.values())) {
            const set = watchers.get(target);
            if (!set) continue;
            set.delete(conn);
            if (!set.size) watchers.delete(target);
        }
        conn.watches.clear();
    }

    function disconnect(conn) {
        if (!conns.has(conn)) return;
        conns.delete(conn);
        removeFromWatchers(conn);
        const set = byUser.get(conn.userId);
        if (set) {
            set.delete(conn);
            if (!set.size) byUser.delete(conn.userId);
        }
        if (!byUser.has(conn.userId) && localOnline.has(conn.userId) && !closed) {
            const seenAt = now();
            const timer = setTimeout(() => { goOffline(conn.userId, seenAt); }, cfg.graceMs);
            if (timer.unref) timer.unref();
            graceTimers.set(conn.userId, { timer, seenAt });
        }
    }

    function closeConn(conn, reason) {
        try { if (conn.close) conn.close(reason); } catch (err) { /* already gone */ }
        disconnect(conn);
    }

    /** Registers a stream. `handle` is { send(event, data), ping(), close(reason) }. */
    function connect(userId, handle) {
        if (closed) return null;
        const existing = byUser.get(userId);
        if (existing && existing.size >= cfg.maxStreamsPerUser) {
            const oldest = [...existing].sort((a, b) => a.openedAt - b.openedAt)[0];
            closeConn(oldest, 'replaced');
        }
        const conn = { id: crypto.randomBytes(6).toString('hex'), userId, openedAt: now(), watches: new Map(), send: handle.send, ping: handle.ping, close: handle.close };
        conns.add(conn);
        if (!byUser.has(userId)) byUser.set(userId, new Set());
        byUser.get(userId).add(conn);

        const pending = graceTimers.get(userId);
        if (pending) { clearTimeout(pending.timer); graceTimers.delete(userId); }
        if (!localOnline.has(userId)) markOnline(userId);
        startTicking();
        return conn;
    }

    /** Points a stream at a set of [key, targetUserId] pairs (the route has
     *  already checked the caller may see each one) and returns the current
     *  state of every distinct target. */
    async function watch(conn, entries) {
        if (!conns.has(conn)) return {};
        removeFromWatchers(conn);
        const limited = entries.slice(0, cfg.maxWatchPerStream);
        for (const [key, target] of limited) {
            if (target === conn.userId) continue;
            conn.watches.set(key, target);
            if (!watchers.has(target)) watchers.set(target, new Set());
            watchers.get(target).add(conn);
        }
        // Stamped BEFORE the lookup: any change that happens while it runs
        // carries a later `at`, so the browser applies it on top.
        const at = now();
        const states = await describe([...new Set(limited.map(([, target]) => target))].map((id) => ({ id })));
        const snapshot = {};
        for (const [key, target] of conn.watches) snapshot[key] = { ...(states.get(target) || { online: false, lastActiveAt: null }), at };
        return snapshot;
    }

    /** users: [{ id, lastActiveAt?: Date|string|null }] (the stored value
     *  from the database, used only when this instance has nothing fresher).
     *  Returns Map(id -> { online, lastActiveAt: ISO string | null }). */
    async function describe(users) {
        const ids = [...new Set(users.map((u) => u.id))];
        const notLocal = ids.filter((id) => !localOnline.has(id));
        const remote = await remoteOnlineSet(notLocal);
        const out = new Map();
        for (const u of users) {
            if (out.has(u.id)) continue;
            const online = localOnline.has(u.id) || remote.has(u.id);
            if (online) { out.set(u.id, { online: true, lastActiveAt: null }); continue; }
            const stored = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : null;
            const memory = lastSeen.get(u.id) || null;
            const best = Math.max(Number.isFinite(stored) ? stored : 0, memory || 0);
            out.set(u.id, { online: false, lastActiveAt: best ? iso(best) : null });
        }
        return out;
    }

    /** Ends every stream a person has (session revoked, account suspended). */
    function disconnectUser(userId, reason = 'session-ended') {
        const set = byUser.get(userId);
        if (!set) return 0;
        const list = [...set];
        for (const conn of list) closeConn(conn, reason);
        return list.length;
    }

    /** Shutdown: end every stream (server.close() would otherwise wait on
     *  them forever), stop timers, and save who was around. */
    async function shutdown() {
        if (closed) return;
        closed = true;
        const online = [...localOnline];
        for (const conn of [...conns]) closeConn(conn, 'shutdown');
        for (const { timer } of graceTimers.values()) clearTimeout(timer);
        graceTimers.clear();
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        if (online.length) {
            try { await persist(online, new Date(now())); } catch (err) { /* shutting down anyway */ }
        }
        if (redis && online.length) {
            try {
                const pipeline = redis.pipeline();
                for (const id of online) pipeline.hdel(REDIS_KEY(id), instanceId);
                await pipeline.exec();
            } catch (err) { /* ignore */ }
        }
        if (subscriber) { try { subscriber.disconnect(); } catch (err) { /* ignore */ } subscriber = null; }
        localOnline.clear();
    }

    if (!redis) {
        log.warn('[presence] REDIS_URL not set \u2014 online status is tracked in this process only. Fine for local dev or a single instance; set REDIS_URL before running more than one backend instance, or people connected to another instance will look offline.');
    }

    return {
        connect,
        disconnect,
        watch,
        describe,
        disconnectUser,
        shutdown,
        config: cfg,
        instanceId,
        stats: () => ({ connections: conns.size, onlineUsers: localOnline.size, graceTimers: graceTimers.size, watchedUsers: watchers.size, mode: redis ? 'redis' : 'memory' })
    };
}

// ---------------------------------------------------------------------------
// The shared instance the app uses.
// ---------------------------------------------------------------------------
function buildDefault() {
    const cache = require('./cache');
    const prisma = require('./prisma');
    const { Prisma } = require('@prisma/client');

    // Raw SQL, chunked: see the LAST ACTIVE note above for why this is not
    // prisma.user.updateMany().
    async function persist(userIds, date) {
        for (let i = 0; i < userIds.length; i += 500) {
            const chunk = userIds.slice(i, i + 500);
            await prisma.$executeRaw`UPDATE "User" SET "lastActiveAt" = ${date} WHERE "id" IN (${Prisma.join(chunk)})`;
        }
    }
    return createPresence({ redis: cache.redisClient, persist });
}

const shared = buildDefault();
module.exports = shared;
module.exports.createPresence = createPresence;
