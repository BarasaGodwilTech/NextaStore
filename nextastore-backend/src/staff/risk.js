'use strict';
/*
 * Risk-based second factor. Decides, after a correct password, whether the authenticator code is needed.
 *
 * The code is ALWAYS needed when:
 *   - the person has not enrolled yet (first sign-in)                       -> reason 'first_login'
 *   - this browser is not a remembered device (or its trust expired)       -> reason 'new_device'
 *   - the role is at or above config.staff.mfaAlwaysRank (Super Admin)     -> reason 'privileged_role'
 *   - the sign-in looks suspicious                                          -> reason 'suspicious'
 *
 * "Suspicious" (any one is enough): recent wrong passwords/codes on the account, a different browser family or operating system than
 * the remembered one, or an IPv4 address in a different /16 network (mobile carriers change the last two bytes constantly, so only the
 * first two are compared). A remembered device that passes all of these signs in with the password alone.
 */
const prisma = require('../prisma');
const config = require('../config');
const C = require('./crypto');
const A = require('./auth');

const S = config.staff;

const ipPrefix = (ip) => { const m = String(ip || '').match(/^(\d+)\.(\d+)\./); return m ? `${m[1]}.${m[2]}` : String(ip || ''); };
const family = (label) => String(label || '');

/** Returns the remembered-device row for this request's cookie, or null. */
async function findDevice(req, staffId) {
    const raw = A.readCookie(req, S.deviceCookieName);
    if (!raw) return null;
    const row = await prisma.staffDevice.findUnique({ where: { tokenHash: C.sha256(raw) } });
    if (!row || row.staffId !== staffId || row.revokedAt || new Date(row.trustedUntil).getTime() <= Date.now()) return null;
    return row;
}

/** { needMfa: boolean, reason, device } */
async function assess(req, staff) {
    if (!staff.mfaEnabledAt) return { needMfa: true, reason: 'first_login', device: null };
    if (S.mfaAlwaysRank > 0 && staff.role && staff.role.rank >= S.mfaAlwaysRank) return { needMfa: true, reason: 'privileged_role', device: null };
    const device = await findDevice(req, staff.id);
    if (!device) return { needMfa: true, reason: 'new_device', device: null };
    const signals = [];
    if ((staff.failedLogins || 0) >= 2) signals.push('recent_failures');
    if (family(A.deviceLabel(A.clientAgent(req))) !== family(device.label)) signals.push('browser_changed');
    if (ipPrefix(A.clientIp(req)) !== ipPrefix(device.lastIp)) signals.push('network_changed');
    if (signals.length) return { needMfa: true, reason: 'suspicious', signals, device };
    return { needMfa: false, reason: 'trusted_device', device };
}

/** Remember this browser after a verified code. Sets the long-lived cookie; returns the device row. */
async function trustDevice(req, res, staff) {
    const raw = C.randomToken(32);
    const now = Date.now();
    const device = await prisma.staffDevice.create({ data: {
        staffId: staff.id, tokenHash: C.sha256(raw), label: A.deviceLabel(A.clientAgent(req)), userAgent: A.clientAgent(req),
        firstIp: A.clientIp(req), lastIp: A.clientIp(req), lastSeenAt: new Date(now), trustedUntil: new Date(now + S.deviceTrustDays * 86400000)
    } });
    A.setDeviceCookie(res, raw);
    return device;
}

/** A remembered device that just signed in fine: slide its trust window and remember where it is now. */
const touchDevice = (device, req) => prisma.staffDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), lastIp: A.clientIp(req), trustedUntil: new Date(Date.now() + S.deviceTrustDays * 86400000) } });

const revokeDevices = (staffId, exceptId = null) => prisma.staffDevice.updateMany({ where: { staffId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { revokedAt: new Date() } });

module.exports = { assess, trustDevice, touchDevice, revokeDevices, findDevice, ipPrefix };
