/**
 * GET /api/media/proxy?u=<image url>
 *
 * Product photos, logos and banners live in the public R2 bucket, on a different origin from the dashboard.
 * A browser will show such an image in an <img>, but it will NOT let a page read its pixels into a canvas
 * unless the bucket sends CORS headers, and the Promote studio needs exactly that to draw posts, cut out
 * backgrounds and export a PNG. Setting CORS on the bucket is the cleanest fix; this route is the fallback
 * that works without touching the bucket: the browser asks us, we fetch the image and hand it back from
 * our own origin (with the API's normal CORS headers).
 *
 * It is deliberately not an open proxy:
 *   - ONLY URLs inside our own R2 public bucket (config.r2.publicUrl) are fetched; anything else is a 400
 *   - no redirects are followed, no cookies or credentials are sent
 *   - only real raster images come back (SVG is refused), up to 12 MB, within 10 seconds
 */
const express = require('express');
const config = require('../config');

const router = express.Router();
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const ALLOWED_TYPES = /^image\/(png|jpe?g|webp|gif|avif)$/i;

function bucketBase() {
    if (!config.r2Enabled || !config.r2.publicUrl) return null;
    try { return new URL(config.r2.publicUrl.replace(/\/+$/, '') + '/'); } catch (e) { return null; }
}

/** The URL if (and only if) it points inside our bucket; otherwise null. */
function allowedTarget(raw) {
    const base = bucketBase();
    if (!base || typeof raw !== 'string' || raw.length > 800) return null;
    let u; try { u = new URL(raw); } catch (e) { return null; }
    if (u.username || u.password || u.hash) return null;
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
    if (/\/\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(u.pathname.slice(base.pathname.length - 1))) return null;
    return u;
}

router.get('/proxy', async (req, res) => {
    const target = allowedTarget(req.query.u);
    if (!target) return res.status(400).json({ message: 'That image cannot be loaded here.' });
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const up = await fetch(target.href, { redirect: 'error', credentials: 'omit', signal: ctl.signal, headers: { Accept: 'image/*' } });
        if (!up.ok) return res.status(up.status === 404 ? 404 : 502).json({ message: 'The image could not be fetched.' });
        const type = String(up.headers.get('content-type') || '').split(';')[0].trim();
        if (!ALLOWED_TYPES.test(type)) return res.status(415).json({ message: 'That file is not a supported image.' });
        const declared = Number(up.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) return res.status(413).json({ message: 'That image is too large.' });
        const buf = Buffer.from(await up.arrayBuffer());
        if (buf.length > MAX_BYTES) return res.status(413).json({ message: 'That image is too large.' });
        res.set({
            'Content-Type': type,
            'Content-Length': String(buf.length),
            // R2 object names are unique per upload, so a long cache is safe and spares the bucket repeat fetches.
            'Cache-Control': 'public, max-age=604800, immutable',
            // helmet defaults this to same-origin, which would block the dashboard when it is served from another host.
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(buf);
    } catch (err) {
        res.status(err && err.name === 'AbortError' ? 504 : 502).json({ message: 'The image could not be fetched.' });
    } finally { clearTimeout(timer); }
});

module.exports = router;
module.exports._allowedTarget = allowedTarget;
