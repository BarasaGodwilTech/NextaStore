// Small cache abstraction shared by cacheMiddleware.js (public catalog
// caching) and app.js (rate limiting). Uses Redis when REDIS_URL is set —
// which you need the moment you run more than one backend instance, so a
// cached product page or a rate-limit counter is shared across every
// instance instead of siloed per-process — and falls back to an in-process
// Map with TTL for local dev / a single instance, where that's harmless.
const REDIS_URL = process.env.REDIS_URL;

let redisClient = null;

if (REDIS_URL) {
    try {
        // Required as an optional dependency: only actually imported when
        // REDIS_URL is set, so nothing here breaks a local dev setup that
        // has never installed or configured Redis.
        const Redis = require('ioredis');
        redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
        redisClient.on('error', (err) => {
            console.error('[cache] Redis error — falling back to treating cache as empty for this call:', err.message);
        });
        console.log('[cache] REDIS_URL set — using Redis for response caching and rate limiting.');
    } catch (err) {
        console.warn('[cache] REDIS_URL is set but the "ioredis" package isn\u2019t installed (run `npm install`). Falling back to an in-memory, per-instance cache until then.');
    }
} else {
    console.warn('[cache] REDIS_URL not set — using an in-memory, per-instance cache and rate limiter. Fine for local dev or a single instance; set REDIS_URL before running more than one backend instance, or caching and rate limits silently stop being shared across them.');
}

// --- in-memory fallback ---------------------------------------------------
const memoryStore = new Map(); // key -> { value, expiresAt }

// Periodic sweep so an unbounded set of cache keys (e.g. every distinct
// product-search query string) doesn't grow forever between reads.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore) {
        if (entry.expiresAt <= now) memoryStore.delete(key);
    }
}, 60 * 1000).unref();

async function get(key) {
    if (redisClient) {
        try {
            return await redisClient.get(key);
        } catch (err) {
            return null; // treat a Redis hiccup as a cache miss, never as a request failure
        }
    }
    const entry = memoryStore.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return null;
    }
    return entry.value;
}

async function set(key, value, ttlSeconds) {
    if (redisClient) {
        try {
            await redisClient.set(key, value, 'EX', ttlSeconds);
        } catch (err) {
            // Best-effort — a failed cache write should never fail the request it's caching.
        }
        return;
    }
    memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function del(key) {
    if (redisClient) {
        try { await redisClient.del(key); } catch (err) { /* best-effort */ }
        return;
    }
    memoryStore.delete(key);
}

module.exports = { get, set, del, redisClient, isRedisEnabled: () => !!redisClient };
