'use strict';
/* The sensitive-action PIN: six digits, easy to type, hard to guess. Stored as a bcrypt hash; wrong tries lock it for a while. */
const S = require('../config').staff;

/** Reasons a PIN is not acceptable (empty = fine). Rejects 111111, 123456, 654321, 121212 and the like. */
function pinProblems(pin) {
    const p = String(pin == null ? '' : pin);
    if (!/^\d{6}$/.test(p)) return ['Use exactly 6 digits.'];
    const d = p.split('').map(Number);
    if (d.every((x) => x === d[0])) return ['Do not repeat one digit.'];
    const step = d[1] - d[0];
    if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return ['Do not use a straight run like 123456.'];
    if (p.slice(0, 2).repeat(3) === p || p.slice(0, 3).repeat(2) === p) return ['Do not use a repeating pattern like 121212.'];
    return [];
}
const isPinLocked = (staff) => !!(staff.pinLockedUntil && new Date(staff.pinLockedUntil).getTime() > Date.now());
const pinLockMessage = (staff) => `Too many wrong PIN attempts. Try again in ${Math.max(1, Math.ceil((new Date(staff.pinLockedUntil).getTime() - Date.now()) / 60000))} minute(s), or reset your PIN with your authenticator code.`;

module.exports = { pinProblems, isPinLocked, pinLockMessage, PIN_LOCK_MINUTES: S.pinLockoutMinutes };
