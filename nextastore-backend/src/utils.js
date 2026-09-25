const crypto = require('crypto');
const config = require('./config');
const { slugify, RESERVED_SLUGS, isReservedSlug, storeSlugFrom } = require('./slugs');

// All image storage goes through R2. Fails fast at first use rather than at
// boot, so routes that never touch images still work even if R2 isn't set up
// yet — but anything that tries to save an image gets a clear error instead
// of a confusing crash deep inside the S3 client.
let s3Client = null;
function getS3Client() {
    if (!config.r2Enabled) {
        throw apiError('Image storage is not configured (missing R2 environment variables).', 500);
    }
    if (!s3Client) {
        const { S3Client } = require('@aws-sdk/client-s3');
        s3Client = new S3Client({
            region: 'auto',
            endpoint: config.r2.endpoint,
            credentials: {
                accessKeyId: config.r2.accessKeyId,
                secretAccessKey: config.r2.secretAccessKey
            }
        });
    }
    return s3Client;
}

/** A thrown error carrying an HTTP status, understood by the error-handling middleware. */
function apiError(message, status = 400, code = null) {
    const err = new Error(message); err.status = status; if (code) err.code = code; return err;
}

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/;
// SVG is deliberately excluded: unlike raster formats, an SVG file can carry
// embedded <script>/event-handler content, so accepting it here would let
// anyone with a logo/banner upload field stash a stored-XSS payload that
// runs in every visitor's browser when the "image" is rendered. If you need
// SVG logos later, sanitize with a library like DOMPurify server-side first
// rather than re-adding the mime type below.
const EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
};

/**
 * Accepts either:
 *  - a base64 data URL (from the browser's FileReader) — decoded and uploaded
 *    to R2, returning a public URL to the stored object
 *  - an existing URL string (e.g. a previously-saved path) — returned unchanged
 *  - null/undefined — returned unchanged
 * Anything else is rejected, since it isn't a shape the frontend ever sends.
 *
 * `folder` scopes where in the bucket the object lands (default: the flat
 * "uploads" prefix everything used before). Callers that know which
 * store/product/user an image belongs to should pass a scoped folder (e.g.
 * `products/${productId}`) instead — this is what keeps the bucket
 * organized instead of every image type landing in one flat prefix.
 */
async function saveImageObjectIfDataUrl(value, folder = 'uploads') {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw apiError('Invalid image value.');

    const match = value.match(DATA_URL_RE);
    if (!match) {
        // Not a data URL — assume it's already a URL/path from a previous save.
        return value;
    }

    const [, mime, base64] = match;
    const normalizedMime = mime.toLowerCase();
    const ext = EXT_BY_MIME[normalizedMime];
    if (!ext) throw apiError('Unsupported image format. Use PNG, JPEG, GIF, or WebP.');
    const buffer = Buffer.from(base64, 'base64');

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB per image
    if (buffer.length > MAX_BYTES) {
        throw apiError('Images must be smaller than 8MB.');
    }

    const filename = `${crypto.randomUUID()}.${ext}`;
    const cleanFolder = String(folder || 'uploads').replace(/^\/+|\/+$/g, '');
    const key = `${cleanFolder}/${filename}`;
    try {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await getS3Client().send(new PutObjectCommand({
            Bucket: config.r2.bucket,
            Key: key,
            Body: buffer,
            ContentType: mime
        }));
    } catch (err) {
        if (err.status) throw err; // already an apiError (e.g. not configured)
        throw apiError('Image upload failed. Please try again.', 502);
    }

    const base = config.r2.publicUrl.replace(/\/$/, '');
    return { url: `${base}/${key}`, key };
}

async function saveImageIfDataUrl(value, folder = 'uploads') {
    const saved = await saveImageObjectIfDataUrl(value, folder);
    return saved ? saved.url : saved;
}

async function saveImageArrayIfDataUrls(values, folder = 'uploads') {
    if (!Array.isArray(values)) return [];
    return Promise.all(values.filter(Boolean).map(v => saveImageIfDataUrl(v, folder)));
}

/** Reverses saveImageObjectIfDataUrl's URL back into an R2 object key, or
 *  null if the value isn't one of our own R2-hosted URLs (an external URL,
 *  a data URL that somehow wasn't uploaded, or nothing at all). Used to
 *  clean up the *old* file the moment it's replaced by a new one, instead
 *  of leaving it behind forever taking up bucket space. */
function r2KeyFromUrl(value) {
    if (!value || typeof value !== 'string' || !config.r2Enabled) return null;
    const base = config.r2.publicUrl.replace(/\/$/, '');
    if (!value.startsWith(base + '/')) return null;
    return value.slice(base.length + 1);
}

/** Deletes one previously-saved image from R2 if (and only if) it's actually
 *  one of our own R2-hosted URLs and it's different from whatever the new
 *  value is — never deletes an object that's still in use. Best-effort: a
 *  delete failure is logged, not thrown, since losing track of one orphaned
 *  file is far cheaper than failing the save that triggered it. */
async function deleteImageIfReplaced(oldValue, newValue) {
    if (!oldValue || oldValue === newValue) return;
    const key = r2KeyFromUrl(oldValue);
    if (!key) return;
    try {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await getS3Client().send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
    } catch (err) {
        console.error('Failed to delete replaced image from R2:', key, err.message || err);
    }
}

/** Same as deleteImageIfReplaced, but for an old array (product images or
 *  thumbnails) against whatever the new array ends up being — deletes only
 *  the entries that dropped out, e.g. a removed or swapped product photo. */
async function deleteImagesNotIn(oldValues, newValues) {
    const olds = Array.isArray(oldValues) ? oldValues : [];
    const keep = new Set((Array.isArray(newValues) ? newValues : []).filter(Boolean));
    const toDelete = olds.filter(v => v && !keep.has(v));
    await Promise.all(toDelete.map(v => deleteImageIfReplaced(v, null)));
}

/**
 * Saves full product images and thumbnails as one logical operation. If any
 * upload fails, already-uploaded objects from this operation are deleted so a
 * rejected product save does not leave orphaned R2 objects behind.
 */
async function saveImagePairsIfDataUrls(images, thumbnails, folder = 'uploads') {
    const imgs = Array.isArray(images) ? images : [];
    const thumbs = Array.isArray(thumbnails) ? thumbnails : [];
    const savedImages = [];
    const savedThumbnails = [];
    const uploadedKeys = [];
    let totalBytes = 0;
    const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

    const decodedBytes = (value) => {
        if (typeof value !== 'string' || !value.startsWith('data:')) return 0;
        const comma = value.indexOf(',');
        if (comma < 0) return 0;
        const body = value.slice(comma + 1);
        const padding = body.endsWith('==') ? 2 : (body.endsWith('=') ? 1 : 0);
        return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
    };

    const rememberUpload = (saved) => {
        if (saved?.key) uploadedKeys.push(saved.key);
        return saved?.url ?? saved;
    };

    try {
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (!img) continue;
            const thumb = thumbs[i] || img;
            totalBytes += decodedBytes(img) + decodedBytes(thumb);
            if (totalBytes > MAX_TOTAL_BYTES) {
                throw apiError('The selected images are too large together. Please use fewer or smaller images.', 413);
            }
            savedImages.push(rememberUpload(await saveImageObjectIfDataUrl(img, folder)));
            savedThumbnails.push(rememberUpload(await saveImageObjectIfDataUrl(thumb, folder)));
        }
        return { images: savedImages, thumbnails: savedThumbnails };
    } catch (err) {
        if (uploadedKeys.length && config.r2Enabled) {
            try {
                const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
                await getS3Client().send(new DeleteObjectsCommand({
                    Bucket: config.r2.bucket,
                    Delete: { Objects: uploadedKeys.map(Key => ({ Key })), Quiet: true }
                }));
            } catch (cleanupErr) {
                // Preserve the original save error. Cleanup is best-effort;
                // logging makes orphan cleanup failures visible to operators.
                console.error('Failed to clean up partial image upload:', cleanupErr);
            }
        }
        throw err;
    }
}

module.exports = {
    slugify,
    RESERVED_SLUGS,
    isReservedSlug,
    storeSlugFrom,
    apiError,
    saveImageIfDataUrl,
    saveImageArrayIfDataUrls,
    saveImagePairsIfDataUrls,
    deleteImageIfReplaced,
    deleteImagesNotIn
};
