'use strict';

const MAX_ENTRIES = 300;
const TTL_MS = 60 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

function normalise(message) {
    return String(message || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function keyOf(message, language = 'en', audience = 'guest') {
    return `${normalise(message)}|${language}|${audience}`;
}

function get(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) { cache.delete(key); return null; }
    cache.delete(key);
    cache.set(key, item);
    return item.value;
}

function set(key, value) {
    if (!key || !value) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function shouldCache({ history = [], result }) {
    if (history.length) return false;
    if (!result || result.flag || result.usedLiveData || result.language?.code === 'lg') return false;
    return result.source === 'model';
}

function getInflight(key) { return inflight.get(key) || null; }
function setInflight(key, promise) { inflight.set(key, promise); return promise; }
function clearInflight(key, promise) {
    if (inflight.get(key) === promise) inflight.delete(key);
}

function clear() { cache.clear(); inflight.clear(); }
function stats() { return { entries: cache.size, inflight: inflight.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS }; }

module.exports = { normalise, keyOf, get, set, shouldCache, getInflight, setInflight, clearInflight, clear, stats };
