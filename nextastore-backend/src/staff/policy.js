'use strict';
/* Password policy and network allow-list for staff. */
const net = require('net');

const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'nextastore', 'changeme', 'iloveyou', 'abc123', '123456', '12345678', '123456789', '1234567890', 'monkey', 'dragon', 'football', 'uganda', 'kampala']);

/** Returns a list of reasons a password is not acceptable (empty = fine). Staff passwords are held to a higher bar than shopper ones. */
function passwordProblems(password, { email = '', name = '' } = {}) {
    const p = String(password || '');
    const out = [];
    if (p.length < 12) out.push('Use at least 12 characters.');
    if (p.length > 128) out.push('Use at most 128 characters.');
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
    if (classes < 3) out.push('Mix at least three of: lower-case, upper-case, numbers, symbols.');
    const lower = p.toLowerCase();
    const squashed = lower.replace(/[^a-z0-9]/g, '');
    if (COMMON.has(lower) || COMMON.has(squashed)) out.push('That password is too common.');
    if (/(.)\1{5,}/.test(p)) out.push('Avoid long runs of the same character.');
    const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (local.length >= 4 && squashed.includes(local)) out.push('Do not include your email name.');
    for (const part of String(name).toLowerCase().split(/\s+/)) {
        if (part.length >= 4 && squashed.includes(part.replace(/[^a-z0-9]/g, ''))) { out.push('Do not include your name.'); break; }
    }
    return out;
}

// ---- IP allow-list -------------------------------------------------------------------------------------------------------------------
const ipv4ToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
function normalizeIp(ip) {
    let v = String(ip || '').trim();
    if (v.startsWith('::ffff:')) v = v.slice(7);          // IPv4-mapped IPv6
    return v === '::1' ? '127.0.0.1' : v;
}
function ipMatches(ip, rule) {
    const addr = normalizeIp(ip);
    const [base, bitsRaw] = String(rule).split('/');
    if (net.isIPv4(addr) && net.isIPv4(base)) {
        const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
        if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask);
    }
    return addr === normalizeIp(base);
}
const ipAllowed = (ip, rules) => !rules || rules.length === 0 || rules.some((r) => ipMatches(ip, r));

module.exports = { passwordProblems, ipAllowed, ipMatches, normalizeIp };
