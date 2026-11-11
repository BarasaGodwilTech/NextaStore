/**
 * Private file storage for the growth program (Crew members' ID photos, card photos and visit photos).
 *
 * Everything else on this API goes to the PUBLIC R2 bucket and comes back as a public URL
 * (utils.saveImageIfDataUrl). An ID photo must never be one of those. This module writes to a
 * SEPARATE bucket that has no public access (R2_PRIVATE_BUCKET_NAME), keeps only an opaque key in
 * the database, and gives the file back only through an admin route that checks growth.review.
 *
 * Not configured (no R2_PRIVATE_BUCKET_NAME)? Then `enabled` is false, the growth routes answer
 * "Uploads are not set up for this program yet" (501) and nothing is ever saved publicly.
 */
const crypto = require('crypto');
const config = require('./config');
const { apiError, matchesImageSignature } = require('./utils');

const PRIVATE_BUCKET = process.env.R2_PRIVATE_BUCKET_NAME || '';
const enabled = !!(config.r2Enabled && PRIVATE_BUCKET);

// What may be stored: the raster formats the rest of the site accepts, plus PDF (an ID scan).
const DATA_URL_RE = /^data:((?:image\/[a-zA-Z0-9+.-]+)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
const MAX_BYTES = 8 * 1024 * 1024;
// Only keys this module wrote can be read back (a stored value is never trusted as a bucket path).
const KEY_RE = /^private\/growth-(?:kyc|visits|card)\/[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}\.(?:png|jpg|webp|pdf)$/;

let client = null;
function s3() {
    if (!client) {
        const { S3Client } = require('@aws-sdk/client-s3');
        client = new S3Client({ region: 'auto', endpoint: config.r2.endpoint, credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey } });
    }
    return client;
}

/** growth's savePrivateImage(dataUrl, folder) -> an opaque key (never a URL). */
async function savePrivateImage(dataUrl, folder) {
    if (!enabled) throw apiError('Uploads are not set up for this program yet.', 501, 'UPLOAD_UNAVAILABLE');
    const match = typeof dataUrl === 'string' ? dataUrl.match(DATA_URL_RE) : null;
    if (!match) throw apiError('Please upload a photo (PNG, JPEG or WebP) or a PDF.');
    const mime = match[1].toLowerCase();
    const ext = EXT_BY_MIME[mime];
    if (!ext) throw apiError('Unsupported file type. Use a PNG, JPEG, WebP or PDF.');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_BYTES) throw apiError('Files must be smaller than 8MB.');
    const okSignature = mime === 'application/pdf' ? buffer.slice(0, 5).toString('latin1') === '%PDF-' : matchesImageSignature(mime, buffer);
    if (!okSignature) throw apiError('That file is not a valid photo or PDF.');

    const key = `private/${String(folder || '').replace(/^\/+|\/+$/g, '')}/${crypto.randomUUID()}.${ext}`;
    if (!KEY_RE.test(key)) throw apiError('Invalid upload folder.', 400);
    try {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await s3().send(new PutObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key, Body: buffer, ContentType: mime }));
    } catch (err) {
        if (err.status) throw err;
        throw apiError('Upload failed. Please try again.', 502);
    }
    return key;
}

/** growth's sendKyc(req, res, key): streams the stored file to an admin with a real Content-Type. */
async function sendPrivateFile(req, res, key) {
    if (!enabled) return res.status(501).json({ message: 'ID viewing is not set up yet.' });
    if (!KEY_RE.test(String(key || ''))) return res.status(404).json({ message: 'No ID on file.' });
    try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const out = await s3().send(new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
        const type = MIME_BY_EXT[key.split('.').pop()] || 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
        out.Body.on('error', () => { try { res.destroy(); } catch (_) { /* gone */ } });
        return out.Body.pipe(res);
    } catch (err) {
        return res.status(404).json({ message: 'No ID on file.' });
    }
}

module.exports = { enabled, savePrivateImage, sendPrivateFile, KEY_RE };
