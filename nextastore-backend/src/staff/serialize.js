'use strict';
const { permissionsOf } = require('./permissions');
const config = require('../config');

const roleBrief = (r) => (r ? { id: r.id, key: r.key, name: r.name, rank: r.rank, isSystem: !!r.isSystem } : null);

/** What the console is told about the signed-in person. Never includes hashes, secrets or recovery codes. */
function meOf(staff, session) {
    return {
        id: staff.id, name: staff.name, email: staff.email, jobTitle: staff.jobTitle || '',
        role: roleBrief(staff.role), permissions: permissionsOf(staff),
        mfaEnabled: !!staff.mfaEnabledAt, mustChangePassword: !!staff.mustChangePassword,
        pinSet: !!staff.pinSetAt, pinLockedUntil: staff.pinLockedUntil || null,
        recoveryCodesLeft: Array.isArray(staff.recoveryCodeHashes) ? staff.recoveryCodeHashes.length : 0,
        lastLoginAt: staff.lastLoginAt || null,
        session: session ? {
            id: session.id, csrfToken: session.csrfToken, expiresAt: session.expiresAt, reauthAt: session.reauthAt,
            idleMinutes: config.staff.idleMinutes, reauthMinutes: config.staff.reauthMinutes, deviceId: session.deviceId || null
        } : null
    };
}

/** A staff member as other staff see them in the directory. */
function staffRow(s) {
    return {
        id: s.id, name: s.name, email: s.email, jobTitle: s.jobTitle || '', status: s.status,
        role: roleBrief(s.role), mfaEnabled: !!s.mfaEnabledAt, pinSet: !!s.pinSetAt, mustChangePassword: !!s.mustChangePassword,
        lockedUntil: s.lockedUntil || null, lastLoginAt: s.lastLoginAt || null, lastLoginIp: s.lastLoginIp || null,
        createdAt: s.createdAt
    };
}

module.exports = { meOf, staffRow, roleBrief };
