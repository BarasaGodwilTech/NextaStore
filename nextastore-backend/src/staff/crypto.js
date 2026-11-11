'use strict';
/*
 * Staff crypto helpers: TOTP (RFC 6238), encryption of MFA secrets at rest, recovery codes, opaque tokens.
 * Pure Node `crypto`: no extra dependencies.
 */
const crypto = require('crypto');
const config = require('../config');

// ---- hashing / tokens ---------------------------------------------------------------------------------------------------------------
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string equality (false for different lengths without throwing). */
function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a)); const y = Buffer.from(String(b == null ? '' : b));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

// ---- base32 (RFC 4648, no padding) ------------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0; const out = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

// ---- TOTP -------------------------------------------------------------------------------------------------------------------------
const STEP_SECONDS = 30, DIGITS = 6;
const generateSecret = () => base32Encode(crypto.randomBytes(20));   // 160-bit, the size authenticator apps expect

function hotp(secretBase32, counter) {
    const key = base32Decode(secretBase32);
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', key).update(buf).digest();
    const off = h[h.length - 1] & 15;
    const code = ((h[off] & 127) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 10 ** DIGITS;
    return String(code).padStart(DIGITS, '0');
}
const stepNow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);
const totpAt = (secret, nowMs = Date.now()) => hotp(secret, stepNow(nowMs));

/**
 * Checks a 6-digit code against the current step and one step either side (clock drift).
 * Returns the matching step number, or null. Callers store the step and refuse any step <= the last accepted one,
 * so a code (even one shoulder-surfed or phished a second ago) can never be used twice.
 */
function verifyTotp(secret, code, { nowMs = Date.now(), lastStep = null, window = 1 } = {}) {
    const given = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(given) || !secret) return null;
    const now = stepNow(nowMs);
    let matched = null;
    for (let d = -window; d <= window; d++) {
        const step = now + d;
        if (safeEqual(hotp(secret, step), given) && matched === null) matched = step;   // no early exit: constant work
    }
    if (matched === null) return null;
    if (lastStep != null && matched <= lastStep) return null;
    return matched;
}

/** otpauth:// URI that authenticator apps read from the QR code. */
function otpauthUri({ secret, email }) {
    const issuer = config.staff.issuer;
    const label = encodeURIComponent(`${issuer}:${email}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- MFA secret encryption at rest (AES-256-GCM) -----------------------------------------------------------------------------------
const aesKey = () => crypto.createHash('sha256').update(`nextastore-staff-mfa:${config.staff.mfaKey}`).digest();
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
function decryptSecret(blob) {
    const [v, iv, tag, enc] = String(blob || '').split('.');
    if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unreadable MFA secret');
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ---- recovery codes ---------------------------------------------------------------------------------------------------------------
// 10 single-use codes like "k7f3-9xqm-2b4d". Only SHA-256 hashes are stored.
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const raw = Array.from(crypto.randomBytes(12), (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
        codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
    }
    return codes;
}
const normalizeRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (c) => sha256(`recovery:${normalizeRecovery(c)}`);

module.exports = {
    sha256, randomToken, safeEqual, base32Encode, base32Decode,
    generateSecret, totpAt, verifyTotp, stepNow, otpauthUri,
    encryptSecret, decryptSecret, newRecoveryCodes, hashRecovery, normalizeRecovery
};
