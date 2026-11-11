'use strict';
/* /api/staff/me: the signed-in person's own profile, password, sessions and recovery codes. */
const express = require('express');
const prisma = require('../../prisma');
const passwords = require('../../password');
const { apiError } = require('../../utils');
const C = require('../crypto');
const A = require('../auth');
const { passwordProblems } = require('../policy');
const { meOf } = require('../serialize');
const risk = require('../risk');
const { pinProblems, isPinLocked, pinLockMessage } = require('../pin');
const config = require('../../config');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Reachable even while a forced password change is pending (that is how it gets done).
router.use(A.requireStaff({ allowPasswordChange: true }));

router.get('/', wrap(async (req, res) => res.json({ data: meOf(req.staff, req.staffSession) })));

router.put('/', wrap(async (req, res) => {
    const data = {};
    if (typeof req.body.name === 'string') { const n = req.body.name.trim(); if (n.length < 2 || n.length > 80) throw apiError('Name must be 2 to 80 characters.', 400); data.name = n; }
    if (typeof req.body.jobTitle === 'string') data.jobTitle = req.body.jobTitle.trim().slice(0, 80);
    if (!Object.keys(data).length) throw apiError('Nothing to change.', 400);
    const fresh = await prisma.staffAccount.update({ where: { id: req.staff.id }, data, include: { role: true } });
    await A.audit(req, 'staff.profile.updated', 'staff', req.staff.id, { metadata: { fields: Object.keys(data) } });
    res.json({ data: meOf(fresh, req.staffSession) });
}));

router.post('/password', wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') throw apiError('Enter your current and new password.', 400);
    if (!(await passwords.compare(currentPassword, req.staff.passwordHash))) throw apiError('Your current password is not right.', 401, 'STAFF_BAD_LOGIN');
    if (currentPassword === newPassword) throw apiError('Choose a password you have not used just now.', 400, 'STAFF_WEAK_PASSWORD');
    const problems = passwordProblems(newPassword, { email: req.staff.email, name: req.staff.name });
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PASSWORD');
    const fresh = await prisma.staffAccount.update({
        where: { id: req.staff.id },
        data: { passwordHash: await passwords.hash(newPassword, 12), passwordChangedAt: new Date(), mustChangePassword: false, tokenVersion: { increment: 1 } },
        include: { role: true }
    });
    // Every OTHER browser is signed out; this one stays.
    await A.revokeAllSessions(req.staff.id, 'password_changed', req.staffSession.id);
    await A.audit(req, 'staff.password.changed', 'staff', req.staff.id);
    res.json({ data: meOf(fresh, req.staffSession) });
}));

router.get('/sessions', wrap(async (req, res) => {
    const rows = await prisma.staffSession.findMany({ where: { staffId: req.staff.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    res.json({ data: rows.map((s) => ({ id: s.id, device: A.deviceLabel(s.userAgent), ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.staffSession.id })) });
}));

router.delete('/sessions/:id', wrap(async (req, res) => {
    const s = await prisma.staffSession.findUnique({ where: { id: req.params.id } });
    if (!s || s.staffId !== req.staff.id) throw apiError('Session not found.', 404);
    await A.revokeSession(s.id, 'revoked_by_owner');
    await A.audit(req, 'staff.session.revoked', 'staff_session', s.id, { metadata: { own: true } });
    if (s.id === req.staffSession.id) A.clearSessionCookie(res);
    res.json({ data: { ok: true } });
}));

router.post('/sessions/revoke-others', wrap(async (req, res) => {
    const r = await A.revokeAllSessions(req.staff.id, 'revoked_by_owner', req.staffSession.id);
    await A.audit(req, 'staff.session.revoked_others', 'staff', req.staff.id, { metadata: { count: r.count } });
    res.json({ data: { revoked: r.count } });
}));

/** New recovery codes replace ALL old ones. Needs a fresh confirmation (step-up). */
router.post('/recovery-codes', A.requireRecentAuth, wrap(async (req, res) => {
    const codes = C.newRecoveryCodes(10);
    await prisma.staffAccount.update({ where: { id: req.staff.id }, data: { recoveryCodeHashes: codes.map(C.hashRecovery) } });
    await A.audit(req, 'staff.recovery_codes.regenerated', 'staff', req.staff.id);
    res.json({ data: { recoveryCodes: codes } });
}));

// ---- Security PIN ----------------------------------------------------------------------------------------------------------------------
/** First PIN (no PIN yet): allowed from any live session, because the console is locked until it exists. */
router.post('/pin', wrap(async (req, res) => {
    if (req.staff.pinSetAt) throw apiError('You already have a PIN. Use "Change PIN" instead.', 409, 'STAFF_PIN_EXISTS');
    const problems = pinProblems(req.body && req.body.pin);
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PIN');
    const fresh = await prisma.staffAccount.update({ where: { id: req.staff.id }, data: { pinHash: await passwords.hash(String(req.body.pin), 12), pinSetAt: new Date(), pinFailed: 0, pinLockedUntil: null }, include: { role: true } });
    await prisma.staffSession.update({ where: { id: req.staffSession.id }, data: { reauthAt: new Date() } });
    await A.audit(req, 'staff.pin.set', 'staff', req.staff.id);
    res.json({ data: meOf(fresh, { ...req.staffSession, reauthAt: new Date() }) });
}));

router.post('/pin/change', wrap(async (req, res) => {
    const { currentPin, newPin } = req.body || {};
    if (!req.staff.pinHash) throw apiError('Set your PIN first.', 409, 'STAFF_PIN_SETUP_REQUIRED');
    if (isPinLocked(req.staff)) throw apiError(pinLockMessage(req.staff), 429, 'STAFF_PIN_LOCKED');
    if (!(await passwords.compare(String(currentPin || ''), req.staff.pinHash))) {
        const failed = (req.staff.pinFailed || 0) + 1; const lock = failed >= config.staff.pinLockoutAttempts;
        await prisma.staffAccount.update({ where: { id: req.staff.id }, data: { pinFailed: lock ? 0 : failed, ...(lock ? { pinLockedUntil: new Date(Date.now() + config.staff.pinLockoutMinutes * 60000) } : {}) } });
        throw apiError('Your current PIN is not right.', 401, 'STAFF_BAD_PIN');
    }
    const problems = pinProblems(newPin);
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PIN');
    if (String(currentPin) === String(newPin)) throw apiError('Choose a different PIN.', 400, 'STAFF_WEAK_PIN');
    const fresh = await prisma.staffAccount.update({ where: { id: req.staff.id }, data: { pinHash: await passwords.hash(String(newPin), 12), pinSetAt: new Date(), pinFailed: 0, pinLockedUntil: null }, include: { role: true } });
    await A.audit(req, 'staff.pin.changed', 'staff', req.staff.id);
    res.json({ data: meOf(fresh, req.staffSession) });
}));

/** Forgot the PIN: a fresh authenticator code lets the person choose a new one (nobody else can, not even with the password). */
router.post('/pin/reset', wrap(async (req, res) => {
    const { code, newPin } = req.body || {};
    if (!req.staff.mfaSecretEnc) throw apiError('Two-step verification is not set up.', 409);
    const step = C.verifyTotp(C.decryptSecret(req.staff.mfaSecretEnc), code, { lastStep: req.staff.mfaLastStep });
    if (step === null) throw apiError('That code is not right. Check your authenticator app and try again.', 401, 'STAFF_BAD_CODE');
    const problems = pinProblems(newPin);
    if (problems.length) throw apiError(problems.join(' '), 400, 'STAFF_WEAK_PIN');
    const fresh = await prisma.staffAccount.update({ where: { id: req.staff.id }, data: { mfaLastStep: step, pinHash: await passwords.hash(String(newPin), 12), pinSetAt: new Date(), pinFailed: 0, pinLockedUntil: null }, include: { role: true } });
    await A.audit(req, 'staff.pin.reset', 'staff', req.staff.id, { metadata: { by: 'authenticator_code' } });
    res.json({ data: meOf(fresh, req.staffSession) });
}));

// ---- Remembered browsers ---------------------------------------------------------------------------------------------------------------
router.get('/devices', wrap(async (req, res) => {
    const rows = await prisma.staffDevice.findMany({ where: { staffId: req.staff.id, revokedAt: null, trustedUntil: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    res.json({ data: rows.map((d) => ({ id: d.id, label: d.label, lastIp: d.lastIp, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, trustedUntil: d.trustedUntil, current: d.id === req.staffSession.deviceId })) });
}));

router.delete('/devices/:id', A.requireRecentAuth, wrap(async (req, res) => {
    const d = await prisma.staffDevice.findUnique({ where: { id: req.params.id } });
    if (!d || d.staffId !== req.staff.id) throw apiError('Device not found.', 404);
    await prisma.staffDevice.update({ where: { id: d.id }, data: { revokedAt: new Date() } });
    await A.audit(req, 'staff.device.revoked', 'staff', req.staff.id, { metadata: { device: d.label, own: true } });
    res.json({ data: { ok: true } });
}));

module.exports = router;
