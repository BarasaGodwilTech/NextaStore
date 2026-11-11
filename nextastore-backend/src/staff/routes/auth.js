'use strict';
/*
 * /api/staff/auth: everything about getting into (and out of) the Staff Console.
 *
 *   POST /login              email + password           -> risk check (src/staff/risk.js):
 *                                                           step 'mfa' | 'mfa_setup'  a 5-minute challenge, NO session yet (first login, new device, suspicious)
 *                                                           step 'done'               remembered browser, nothing suspicious: session opened
 *   POST /mfa/verify         challenge + 6-digit code   -> session cookie   (or a single-use recovery code)
 *   POST /mfa/setup/begin    challenge                  -> secret + otpauth URI (first sign-in only)
 *   POST /mfa/setup/confirm  challenge + code           -> enables MFA, returns recovery codes ONCE, opens the session
 *   POST /accept-invite      token + new password       -> challenge (mfa_setup)
 *   POST /forgot, /reset     e-mailed one-hour link
 *   POST /logout, /reauth    (signed in)
 *
 * A password alone opens a session ONLY from a browser that already passed the authenticator code (remembered device) and only when the
 * sign-in does not look suspicious. Everything else, including every first login, requires the code. A fresh session can do ordinary work
 * but every sensitive action asks for the person's PIN (/reauth).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../../prisma');
const config = require('../../config');
const passwords = require('../../password');
const { sendMail } = require('../../mailer');
const { apiError } = require('../../utils');
const C = require('../crypto');
const { passwordProblems } = require('../policy');
const A = require('../auth');
const risk = require('../risk');
const { pinProblems, pinLockMessage, isPinLocked } = require('../pin');
const { meOf } = require('../serialize');
const { authIpLimiter, authEmailLimiter, mailLimiter } = require('../limiters');
const { staffInviteEmail, staffResetEmail } = require('../emails');

const S = config.staff;
const router = express.Router();
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('nextastore-staff-dummy-for-timing-only', BCRYPT_ROUNDS);
const GENERIC_LOGIN_ERROR = 'That email and password do not match our records.';

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const emailOf = (v) => str(v, 254).trim().toLowerCase();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- challenge (password proven, second factor pending) ---------------------------------------------------------------------------------
const pwFingerprint = (staff) => C.sha256(staff.passwordHash).slice(0, 16);
function signChallenge(staff, purpose) {
    return jwt.sign({ purpose, tv: staff.tokenVersion || 0, pw: pwFingerprint(staff) }, S.secret,
        { algorithm: 'HS256', audience: 'nextastore-staff-challenge', subject: staff.id, expiresIn: S.challengeMinutes * 60 });
}
/** Verifies the challenge AND that nothing it vouches for has changed since (password, MFA reset, suspension). */
async function loadChallenge(token, purposes) {
    let payload;
    try { payload = jwt.verify(String(token || ''), S.secret, { algorithms: ['HS256'], audience: 'nextastore-staff-challenge' }); }
    catch (e) { throw apiError('Your sign-in expired. Please start again.', 401, 'STAFF_CHALLENGE_EXPIRED'); }
    if (!purposes.includes(payload.purpose)) throw apiError('Your sign-in expired. Please start again.', 401, 'STAFF_CHALLENGE_EXPIRED');
    const staff = await prisma.staffAccount.findUnique({ where: { id: payload.sub }, include: { role: true } });
    if (!staff || staff.status !== 'active' || (staff.tokenVersion || 0) !== payload.tv || pwFingerprint(staff) !== payload.pw) {
        throw apiError('Your sign-in expired. Please start again.', 401, 'STAFF_CHALLENGE_EXPIRED');
    }
    return staff;
}

const isLocked = (staff) => staff.lockedUntil && new Date(staff.lockedUntil).getTime() > Date.now();
const lockMessage = (staff) => `Too many failed attempts. This account is locked for ${Math.max(1, Math.ceil((new Date(staff.lockedUntil).getTime() - Date.now()) / 60000))} more minute(s).`;

/** Counts a failed password/code. Locks the account for a while after too many in a row. Returns the updated row. */
async function registerFailure(req, staff, what) {
    const failed = (staff.failedLogins || 0) + 1;
    const lock = failed >= S.lockoutAttempts;
    const updated = await prisma.staffAccount.update({
        where: { id: staff.id },
        data: { failedLogins: lock ? 0 : failed, ...(lock ? { lockedUntil: new Date(Date.now() + S.lockoutMinutes * 60000) } : {}) },
        include: { role: true }
    });
    await A.auditAs(req, `${staff.name} <${staff.email}>`, lock ? 'staff.account.locked' : `staff.${what}.failed`, 'staff', staff.id, { metadata: { failed, locked: lock } });
    return updated;
}

async function openSession(req, res, staff, { method, deviceId = null, reason = null }) {
    const { token, csrfToken, session } = await A.createSession(staff, req, { deviceId });
    const fresh = await prisma.staffAccount.update({
        where: { id: staff.id },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: A.clientIp(req) },
        include: { role: true }
    });
    A.setSessionCookie(res, token);
    await A.audit(req, 'staff.login.success', 'staff', fresh.id, { staff: fresh, metadata: { method, reason, device: A.deviceLabel(A.clientAgent(req)) } });
    return meOf(fresh, { ...session, csrfToken });
}

// ---- login ------------------------------------------------------------------------------------------------------------------------------
router.post('/login', authIpLimiter, authEmailLimiter, wrap(async (req, res) => {
    const email = emailOf(req.body && req.body.email);
    const password = str(req.body && req.body.password, 200);
    if (!email || !password) throw apiError('Enter your email and password.', 400, 'STAFF_BAD_INPUT');
    const staff = await prisma.staffAccount.findUnique({ where: { email }, include: { role: true } });
    // Always spend the same hashing time, whether or not the address exists.
    const ok = await passwords.compare(password, staff ? staff.passwordHash : DUMMY_HASH);
    if (!staff) {
        await A.audit(req, 'staff.login.failed', 'staff', null, { anonymous: true, actorLabel: email, metadata: { reason: 'unknown_email' } });
        throw apiError(GENERIC_LOGIN_ERROR, 401, 'STAFF_BAD_LOGIN');
    }
    if (isLocked(staff)) throw apiError(lockMessage(staff), 429, 'STAFF_LOCKED');
    if (!ok) {
        const updated = await registerFailure(req, staff, 'login');
        throw apiError(isLocked(updated) ? lockMessage(updated) : GENERIC_LOGIN_ERROR, isLocked(updated) ? 429 : 401, isLocked(updated) ? 'STAFF_LOCKED' : 'STAFF_BAD_LOGIN');
    }
    if (staff.status === 'invited') throw apiError('Open the invitation link we emailed you to set up this account.', 403, 'STAFF_INVITE_PENDING');
    if (staff.status !== 'active') {
        await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.login.blocked', 'staff', staff.id, { metadata: { reason: staff.status } });
        throw apiError('This staff account is not active. Contact a Super Admin.', 403, 'STAFF_INACTIVE');
    }
    const verdict = await risk.assess(req, staff);
    if (!verdict.needMfa) {
        // Remembered browser, nothing unusual: the password is enough. The PIN still guards every sensitive action.
        await risk.touchDevice(verdict.device, req);
        const me = await openSession(req, res, staff, { method: 'trusted_device', deviceId: verdict.device.id, reason: verdict.reason });
        return res.json({ data: { step: 'done', me } });
    }
    if (verdict.reason === 'suspicious') await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.login.suspicious', 'staff', staff.id, { metadata: { signals: verdict.signals, device: A.deviceLabel(A.clientAgent(req)) } });
    const step = staff.mfaEnabledAt ? 'mfa' : 'mfa_setup';
    res.json({ data: { step, reason: verdict.reason, trustDays: S.deviceTrustDays, challenge: signChallenge(staff, step), name: staff.name, expiresInSeconds: S.challengeMinutes * 60 } });
}));

/** After a verified code the person may ask us to remember this browser (checkbox on the code page). */
async function maybeTrust(req, res, staff) {
    if (!(req.body && req.body.trustDevice === true)) return null;
    const old = await risk.findDevice(req, staff.id);
    if (old) await prisma.staffDevice.update({ where: { id: old.id }, data: { revokedAt: new Date() } });   // replace, never pile up
    const device = await risk.trustDevice(req, res, staff);
    await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.device.trusted', 'staff', staff.id, { metadata: { device: device.label } });
    return device;
}

// ---- second factor ----------------------------------------------------------------------------------------------------------------------
router.post('/mfa/verify', authIpLimiter, wrap(async (req, res) => {
    const staff = await loadChallenge(req.body && req.body.challenge, ['mfa']);
    if (isLocked(staff)) throw apiError(lockMessage(staff), 429, 'STAFF_LOCKED');
    const recovery = str(req.body && req.body.recoveryCode, 40);
    let method = 'totp';

    if (recovery) {
        const hash = C.hashRecovery(recovery);
        const idx = (staff.recoveryCodeHashes || []).indexOf(hash);
        if (idx < 0) {
            const updated = await registerFailure(req, staff, 'recovery');
            throw apiError(isLocked(updated) ? lockMessage(updated) : 'That recovery code is not valid.', isLocked(updated) ? 429 : 401, isLocked(updated) ? 'STAFF_LOCKED' : 'STAFF_BAD_CODE');
        }
        // Single use: remove it atomically-ish (the row's list is rewritten without it).
        const left = staff.recoveryCodeHashes.filter((h, i) => i !== idx);
        const claimed = await prisma.staffAccount.updateMany({ where: { id: staff.id, recoveryCodeHashes: { equals: staff.recoveryCodeHashes } }, data: { recoveryCodeHashes: left } });
        if (claimed.count === 0) throw apiError('That recovery code is not valid.', 401, 'STAFF_BAD_CODE');
        staff.recoveryCodeHashes = left;
        method = 'recovery_code';
    } else {
        const secret = C.decryptSecret(staff.mfaSecretEnc);
        const step = C.verifyTotp(secret, req.body && req.body.code, { lastStep: staff.mfaLastStep });
        if (step === null) {
            const updated = await registerFailure(req, staff, 'mfa');
            throw apiError(isLocked(updated) ? lockMessage(updated) : 'That code is not right. Check your authenticator app and try again.', isLocked(updated) ? 429 : 401, isLocked(updated) ? 'STAFF_LOCKED' : 'STAFF_BAD_CODE');
        }
        await prisma.staffAccount.update({ where: { id: staff.id }, data: { mfaLastStep: step } });
    }
    const device = await maybeTrust(req, res, staff);
    const me = await openSession(req, res, staff, { method, deviceId: device ? device.id : null });
    res.json({ data: me });
}));

router.post('/mfa/setup/begin', authIpLimiter, wrap(async (req, res) => {
    const staff = await loadChallenge(req.body && req.body.challenge, ['mfa_setup']);
    if (staff.mfaEnabledAt) throw apiError('Two-step verification is already set up.', 409, 'STAFF_MFA_EXISTS');
    const secret = C.generateSecret();
    await prisma.staffAccount.update({ where: { id: staff.id }, data: { mfaSecretEnc: C.encryptSecret(secret) } });
    res.json({ data: { secret, otpauthUri: C.otpauthUri({ secret, email: staff.email }), issuer: S.issuer, account: staff.email } });
}));

router.post('/mfa/setup/confirm', authIpLimiter, wrap(async (req, res) => {
    const staff = await loadChallenge(req.body && req.body.challenge, ['mfa_setup']);
    if (staff.mfaEnabledAt) throw apiError('Two-step verification is already set up.', 409, 'STAFF_MFA_EXISTS');
    if (!staff.mfaSecretEnc) throw apiError('Start the setup again to get a new secret.', 400, 'STAFF_MFA_NOT_STARTED');
    if (isLocked(staff)) throw apiError(lockMessage(staff), 429, 'STAFF_LOCKED');
    const step = C.verifyTotp(C.decryptSecret(staff.mfaSecretEnc), req.body && req.body.code);
    if (step === null) {
        const updated = await registerFailure(req, staff, 'mfa_setup');
        throw apiError(isLocked(updated) ? lockMessage(updated) : 'That code is not right. Check your authenticator app and try again.', isLocked(updated) ? 429 : 401, isLocked(updated) ? 'STAFF_LOCKED' : 'STAFF_BAD_CODE');
    }
    const codes = C.newRecoveryCodes(10);
    const enabled = await prisma.staffAccount.update({
        where: { id: staff.id },
        data: { mfaEnabledAt: new Date(), mfaLastStep: step, recoveryCodeHashes: codes.map(C.hashRecovery) },
        include: { role: true }
    });
    await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.mfa.enabled', 'staff', staff.id);
    const device = await maybeTrust(req, res, enabled);
    const me = await openSession(req, res, enabled, { method: 'mfa_setup', deviceId: device ? device.id : null });
    res.json({ data: { ...me, recoveryCodes: codes } });   // the ONLY time they are ever shown
}));

// ---- invitation + password reset -------------------------------------------------------------------------------------------------------
async function redeem(rawToken, type) {
    const hash = C.sha256(String(rawToken || ''));
    const claimed = await prisma.staffToken.updateMany({ where: { tokenHash: hash, type, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (claimed.count === 0) throw apiError('This link is invalid or has expired. Ask for a new one.', 400, 'STAFF_LINK_INVALID');
    const row = await prisma.staffToken.findUnique({ where: { tokenHash: hash } });
    if (!row) throw apiError('This link is invalid or has expired. Ask for a new one.', 400, 'STAFF_LINK_INVALID');
    return row.staffId;
}

/** Looks at a link without using it, so the page can say "Welcome, Amina" before asking for a password. */
router.post('/link-info', authIpLimiter, wrap(async (req, res) => {
    const type = req.body && req.body.type === 'password_reset' ? 'password_reset' : 'invite';
    const row = await prisma.staffToken.findUnique({ where: { tokenHash: C.sha256(str(req.body && req.body.token, 200)) } });
    if (!row || row.type !== type || row.usedAt || new Date(row.expiresAt).getTime() <= Date.now()) throw apiError('This link is invalid or has expired. Ask for a new one.', 400, 'STAFF_LINK_INVALID');
    const staff = await prisma.staffAccount.findUnique({ where: { id: row.staffId }, include: { role: true } });
    res.json({ data: { name: staff.name, email: staff.email, role: staff.role ? staff.role.name : '' } });
}));

router.post('/accept-invite', authIpLimiter, wrap(async (req, res) => {
    const password = str(req.body && req.body.password, 200);
    const info = await prisma.staffToken.findUnique({ where: { tokenHash: C.sha256(str(req.body && req.body.token, 200)) } });
    const who = info ? await prisma.staffAccount.findUnique({ where: { id: info.staffId } }) : null;
    const problems = passwordProblems(password, { email: who ? who.email : '', name: who ? who.name : '' });
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PASSWORD');
    const staffId = await redeem(req.body && req.body.token, 'invite');
    const staff = await prisma.staffAccount.update({
        where: { id: staffId },
        data: { passwordHash: await passwords.hash(password, BCRYPT_ROUNDS), status: 'active', mustChangePassword: false, passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
        include: { role: true }
    });
    await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.invite.accepted', 'staff', staff.id);
    res.json({ data: { step: 'mfa_setup', challenge: signChallenge(staff, 'mfa_setup'), name: staff.name } });
}));

router.post('/forgot', authIpLimiter, mailLimiter, wrap(async (req, res) => {
    const email = emailOf(req.body && req.body.email);
    const staff = email ? await prisma.staffAccount.findUnique({ where: { email } }) : null;
    // Same answer and (roughly) the same work whether or not the address belongs to staff.
    if (staff && staff.status === 'active') {
        const raw = C.randomToken(32);
        await prisma.staffToken.updateMany({ where: { staffId: staff.id, type: 'password_reset', usedAt: null }, data: { usedAt: new Date() } });
        await prisma.staffToken.create({ data: { staffId: staff.id, type: 'password_reset', tokenHash: C.sha256(raw), expiresAt: new Date(Date.now() + S.resetMinutes * 60000) } });
        try { await sendMail({ to: staff.email, ...staffResetEmail({ name: staff.name, link: `${S.consoleUrl}/reset?token=${raw}`, minutes: S.resetMinutes }) }); }
        catch (err) { console.warn('[staff] could not send reset email:', err.message); }
        await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.password_reset.requested', 'staff', staff.id);
    }
    res.json({ data: { message: 'If that address belongs to a staff account, a reset link is on its way.' } });
}));

router.post('/reset', authIpLimiter, wrap(async (req, res) => {
    const password = str(req.body && req.body.password, 200);
    const info = await prisma.staffToken.findUnique({ where: { tokenHash: C.sha256(str(req.body && req.body.token, 200)) } });
    const who = info ? await prisma.staffAccount.findUnique({ where: { id: info.staffId } }) : null;
    const problems = passwordProblems(password, { email: who ? who.email : '', name: who ? who.name : '' });
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PASSWORD');
    const staffId = await redeem(req.body && req.body.token, 'password_reset');
    const staff = await prisma.staffAccount.update({
        where: { id: staffId },
        data: { passwordHash: await passwords.hash(password, BCRYPT_ROUNDS), passwordChangedAt: new Date(), mustChangePassword: false, failedLogins: 0, lockedUntil: null, tokenVersion: { increment: 1 } }
    });
    await A.revokeAllSessions(staff.id, 'password_reset');
    await A.auditAs(req, `${staff.name} <${staff.email}>`, 'staff.password_reset.completed', 'staff', staff.id);
    res.json({ data: { message: 'Your password has been changed. Sign in with your new password and your authenticator code.' } });
}));

// ---- signed-in actions -----------------------------------------------------------------------------------------------------------------
router.post('/logout', A.requireStaff({ allowPasswordChange: true }), wrap(async (req, res) => {
    await A.revokeSession(req.staffSession.id, 'logout');
    await A.audit(req, 'staff.logout', 'staff', req.staff.id);
    A.clearSessionCookie(res);
    res.json({ data: { ok: true } });
}));

/**
 * Step-up: unlocks sensitive actions for a few minutes. The normal way is the person's PIN. A fresh authenticator code also works
 * (that is also how a forgotten PIN is reset, see /me/pin/reset). A password alone does NOT: stealing a password is the attack this stops.
 * PIN failures have their own counter and lock; they never lock the account itself.
 */
router.post('/reauth', A.requireStaff({ allowPasswordChange: true }), authIpLimiter, wrap(async (req, res) => {
    const staff = req.staff;
    if (isLocked(staff)) throw apiError(lockMessage(staff), 429, 'STAFF_LOCKED');
    const body = req.body || {};
    let ok = false;
    if (body.pin !== undefined) {
        if (!staff.pinHash) throw apiError('Set your security PIN first.', 403, 'STAFF_PIN_SETUP_REQUIRED');
        if (isPinLocked(staff)) throw apiError(pinLockMessage(staff), 429, 'STAFF_PIN_LOCKED');
        ok = await passwords.compare(str(body.pin, 12), staff.pinHash);
        if (!ok) {
            const failed = (staff.pinFailed || 0) + 1; const lock = failed >= S.pinLockoutAttempts;
            const updated = await prisma.staffAccount.update({ where: { id: staff.id }, data: { pinFailed: lock ? 0 : failed, ...(lock ? { pinLockedUntil: new Date(Date.now() + S.pinLockoutMinutes * 60000) } : {}) } });
            await A.audit(req, lock ? 'staff.pin.locked' : 'staff.pin.failed', 'staff', staff.id, { metadata: { failed } });
            throw apiError(lock ? pinLockMessage(updated) : `That PIN is not right. ${S.pinLockoutAttempts - failed} attempt(s) left.`, lock ? 429 : 401, lock ? 'STAFF_PIN_LOCKED' : 'STAFF_BAD_PIN');
        }
        await prisma.staffAccount.update({ where: { id: staff.id }, data: { pinFailed: 0, pinLockedUntil: null } });
    } else if (body.code) {
        const step = C.verifyTotp(C.decryptSecret(staff.mfaSecretEnc), body.code, { lastStep: staff.mfaLastStep });
        if (step !== null) { ok = true; await prisma.staffAccount.update({ where: { id: staff.id }, data: { mfaLastStep: step } }); }
        if (!ok) {
            const updated = await registerFailure(req, staff, 'reauth');
            throw apiError(isLocked(updated) ? lockMessage(updated) : 'That code is not right. Try again.', isLocked(updated) ? 429 : 401, isLocked(updated) ? 'STAFF_LOCKED' : 'STAFF_BAD_CODE');
        }
        await prisma.staffAccount.update({ where: { id: staff.id }, data: { failedLogins: 0 } });
    } else {
        throw apiError('Enter your PIN.', 400, 'STAFF_BAD_INPUT');
    }
    const session = await prisma.staffSession.update({ where: { id: req.staffSession.id }, data: { reauthAt: new Date() } });
    await A.audit(req, 'staff.reauth', 'staff', staff.id, { metadata: { by: body.pin !== undefined ? 'pin' : 'code' } });
    res.json({ data: { reauthAt: session.reauthAt, reauthMinutes: S.reauthMinutes } });
}));

module.exports = router;
module.exports.signChallenge = signChallenge;
