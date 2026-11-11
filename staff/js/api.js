/* Staff Console API client. Cookie session (httpOnly, set by the server) + per-session CSRF token held ONLY in memory. */
(function (root) {
    'use strict';
    const Staff = root.Staff = root.Staff || {};
    const base = String((root.STAFF_CONFIG && root.STAFF_CONFIG.api) || '/api/staff').replace(/\/$/, '');
    const SESSION_LOST = new Set(['STAFF_NO_SESSION', 'STAFF_SESSION_ENDED', 'STAFF_SESSION_EXPIRED', 'STAFF_SESSION_IDLE', 'STAFF_INACTIVE']);
    let csrf = '';
    // Stale-while-revalidate memory cache for read-only lookups (lists of roles, templates, overview...). Any successful write clears it,
    // so a page never shows something older than the person's own last change. Never persisted: nothing sensitive touches storage.
    const cache = new Map();
    const keyOf = (path, query) => path + '?' + JSON.stringify(query || {});

    class ApiError extends Error {
        constructor(message, status, code, extra) { super(message); this.name = 'ApiError'; this.status = status; this.code = code || 'ERROR'; this.extra = extra || null; }
    }

    const api = {
        base, ApiError,
        setCsrf(t) { csrf = t || ''; },
        onSessionLost: null,     // (code) => void   set by the console shell
        onReauth: null,          // () => Promise<boolean>   set by the console shell

        async request(method, path, { body, query, poll = false, raw = false, retried = false } = {}) {
            let url = base + path;
            if (query) {
                const qs = new URLSearchParams();
                for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
                const s = qs.toString(); if (s) url += (url.includes('?') ? '&' : '?') + s;
            }
            const headers = { Accept: raw ? 'text/csv,application/json' : 'application/json' };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (method !== 'GET' && method !== 'HEAD' && csrf) headers['X-CSRF-Token'] = csrf;
            if (poll) headers['X-Background-Poll'] = '1';
            let res;
            try { res = await fetch(url, { method, headers, credentials: 'include', cache: 'no-store', body: body !== undefined ? JSON.stringify(body) : undefined }); }
            catch (e) { throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, 'NETWORK'); }

            if (res.ok) {
                if (method !== 'GET' && !path.startsWith('/auth/reauth')) cache.clear();
                if (raw) return res;
                if (res.status === 204) return null;
                const json = await res.json().catch(() => ({}));
                return json && 'data' in json ? json.data : json;
            }
            const err = await res.json().catch(() => ({}));
            const code = err.code || (res.status === 429 ? 'RATE_LIMITED' : 'ERROR');
            const message = err.message || (res.status === 429 ? 'Too many requests. Please wait a moment.' : 'Something went wrong.');

            if (code === 'REAUTH_REQUIRED' && !retried && api.onReauth) {
                const ok = await api.onReauth();
                if (ok) return api.request(method, path, { body, query, poll, raw, retried: true });
                throw new ApiError('Confirmation cancelled.', 403, 'REAUTH_CANCELLED');
            }
            if (SESSION_LOST.has(code) && api.onSessionLost && !path.startsWith('/auth/')) api.onSessionLost(code);
            throw new ApiError(message, res.status, code, err);
        },
        get: (p, o) => api.request('GET', p, o),
        /** Returns cached data at once when there is any (fresh or stale) and refreshes in the background; onFresh(data) fires if it changed. */
        async swr(path, { query, ttl = 30000, onFresh } = {}) {
            const k = keyOf(path, query); const hit = cache.get(k);
            const fetchIt = () => api.get(path, { query }).then((d) => { const prev = cache.get(k); cache.set(k, { at: Date.now(), data: d }); if (onFresh && prev && JSON.stringify(prev.data) !== JSON.stringify(d)) onFresh(d); return d; });
            if (hit) { if (Date.now() - hit.at > ttl) fetchIt().catch(() => {}); return hit.data; }
            return fetchIt();
        },
        prefetch(path, query) { const k = keyOf(path, query); if (!cache.has(k)) api.get(path, { query, poll: true }).then((d) => cache.set(k, { at: Date.now(), data: d })).catch(() => {}); },
        clearCache() { cache.clear(); },
        post: (p, body, o) => api.request('POST', p, { ...o, body: body === undefined ? {} : body }),
        put: (p, body, o) => api.request('PUT', p, { ...o, body: body === undefined ? {} : body }),
        del: (p, o) => api.request('DELETE', p, o),

        /** Fetches a CSV (or any file) as an authenticated download. */
        async download(path, query, filename) {
            const res = await api.request('GET', path, { query, raw: true });
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = filename || 'download.csv';
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
    };
    Staff.api = api;
})(window);
