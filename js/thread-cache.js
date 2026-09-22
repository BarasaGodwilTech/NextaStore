/* ThreadCache — a small in-memory store of recently seen message threads.
 *
 * Why it exists: opening a conversation used to be "show nothing, wait for
 * the network, then draw" — on a mobile connection that is a blank pane for
 * the length of a round trip, every single tap. With this cache a thread the
 * person has already seen (or that was prefetched when a finger touched down
 * on its row) is drawn from memory on the very same frame as the tap, and the
 * network only *revalidates* it (stale-while-revalidate).
 *
 * What it deliberately is NOT:
 *   - Not persisted. Nothing here touches localStorage / IndexedDB / the
 *     service worker. Message text is private; a reload, a closed tab and a
 *     sign-out all drop it. (Unsent/failed messages are a separate, per-user
 *     store in messages.js — they have to survive a reload, this does not.)
 *   - Not a source of truth. Every entry is only ever used to paint *first*;
 *     the caller always revalidates against the server afterwards.
 *   - Not shared between accounts. Every read/write is tied to an owner (the
 *     signed-in user id); if the owner changes, everything is dropped.
 *
 * Entries hold the raw `data` object of GET /messages/conversations/:id
 * ({ id, store, buyer, product, presence, messages, pagination }) plus when it
 * was fetched. Only server-confirmed messages are ever stored — never a
 * pending/failed optimistic bubble.
 */
(function () {
    'use strict';

    const DEFAULTS = {
        maxEntries: 30,                 // LRU cap — a few dozen threads is plenty
        maxAgeMs: 15 * 60 * 1000,       // older than this is treated as a miss (shown as a skeleton instead)
        prefetchFreshMs: 20 * 1000      // a prefetch is skipped if the entry is younger than this
    };

    class ThreadCache {
        constructor({ ownerId = null, maxEntries, maxAgeMs, prefetchFreshMs } = {}) {
            this.ownerId = ownerId;
            this.maxEntries = maxEntries || DEFAULTS.maxEntries;
            this.maxAgeMs = maxAgeMs || DEFAULTS.maxAgeMs;
            this.prefetchFreshMs = prefetchFreshMs || DEFAULTS.prefetchFreshMs;
            this._entries = new Map();   // id -> { data, fetchedAt }   (Map order = LRU order, oldest first)
            this._inflight = new Map();  // id -> Promise               (dedupes prefetch + prefetch/open)
            this.stats = { hits: 0, misses: 0, prefetches: 0 };
        }

        /* Call before every read/write with the CURRENT user id. A different
           id than the one the cache was filled for means somebody else is
           signed in now — drop everything rather than risk showing one
           person's conversations to another. */
        setOwner(ownerId) {
            const next = ownerId || null;
            if (next !== this.ownerId) {
                this.clear();
                this.ownerId = next;
            }
        }

        get size() { return this._entries.size; }
        get inflightCount() { return this._inflight.size; }

        /* Returns { data, fetchedAt } or null. A hit also marks the entry as
           most-recently-used. Entries past maxAgeMs are evicted and reported
           as a miss. */
        get(id, { maxAgeMs = this.maxAgeMs } = {}) {
            const entry = this._entries.get(id);
            if (!entry) { this.stats.misses++; return null; }
            if (Date.now() - entry.fetchedAt > maxAgeMs) {
                this._entries.delete(id);
                this.stats.misses++;
                return null;
            }
            this._entries.delete(id);
            this._entries.set(id, entry);
            this.stats.hits++;
            return entry;
        }

        /* True when the entry is recent enough that prefetching again would
           be pure waste. Does not touch LRU order or hit/miss stats. */
        isFresh(id) {
            const entry = this._entries.get(id);
            return !!entry && (Date.now() - entry.fetchedAt) < this.prefetchFreshMs;
        }

        has(id) { return this._entries.has(id); }

        /* Stores a full server response for a thread (resets its age). */
        set(id, data) {
            if (!id || !data) return;
            this._entries.delete(id);
            this._entries.set(id, { data, fetchedAt: Date.now() });
            while (this._entries.size > this.maxEntries) {
                this._entries.delete(this._entries.keys().next().value);   // evict least-recently-used
            }
        }

        /* Edits an existing entry in place WITHOUT refreshing its age — used
           to keep the cache in step with what was just painted (a poll
           delivered a message, "load older" prepended history, a send was
           confirmed) so leaving a thread and coming back doesn't briefly
           show it as it was a minute ago. `fn` receives the entry's data and
           returns the replacement. Returns false if there is no entry. */
        patch(id, fn) {
            const entry = this._entries.get(id);
            if (!entry) return false;
            const next = fn(entry.data);
            if (next) entry.data = next;
            return true;
        }

        /* Insert-or-replace one server-confirmed message (by id, or by the
           sender's clientId for the rare poll-beat-the-reply case). */
        upsertMessage(id, message) {
            return this.patch(id, data => {
                const messages = (data.messages || []).slice();
                let idx = messages.findIndex(m => m.id === message.id);
                if (idx === -1 && message.clientId) idx = messages.findIndex(m => m.clientId === message.clientId);
                if (idx === -1) messages.push(message); else messages[idx] = message;
                return { ...data, messages };
            });
        }

        delete(id) { this._entries.delete(id); this._inflight.delete(id); }

        clear() {
            this._entries.clear();
            this._inflight.clear();
        }

        /* The pending prefetch for this thread, if any. A tap that lands
           while a hover/touchstart prefetch is still on the wire can then
           paint the moment that response arrives instead of starting over. */
        inflight(id) { return this._inflight.get(id) || null; }

        /* Starts (or joins) a background fetch for a thread and stores the
           result. `fetcher` must be side-effect-free on the server (see
           `?peek=1` in routes/messages.js). Never rejects: a failed prefetch
           is just a cache miss later. Resolves to the stored data, or null.
           The response is discarded if the owner changed while it was in
           flight (sign-out / account switch mid-request). */
        prefetch(id, fetcher) {
            if (!id) return Promise.resolve(null);
            const existing = this._inflight.get(id);
            if (existing) return existing;
            const owner = this.ownerId;
            this.stats.prefetches++;
            const promise = Promise.resolve()
                .then(fetcher)
                .then(data => {
                    if (this.ownerId !== owner || !data) return null;
                    this.set(id, data);
                    return data;
                })
                .catch(() => null)
                .finally(() => { if (this._inflight.get(id) === promise) this._inflight.delete(id); });
            this._inflight.set(id, promise);
            return promise;
        }
    }

    window.ThreadCache = ThreadCache;
})();
