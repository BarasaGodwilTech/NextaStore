'use strict';
/*
 * Staff directory, roles, security overview and the audit log.
 * The hierarchy rules live in permissions.js (rank). The two ideas that matter here:
 *   1. nobody can touch, or hand out access to, anyone at or above their own rank (a Super Admin excepted);
 *   2. the platform can never be left without an active Super Admin.
 */
const express = require('express');
const prisma = require('../../prisma');
const config = require('../../config');
const passwords = require('../../password');
const { sendMail, status: mailStatus } = require('../../mailer');
const { apiError } = require('../../utils');
const risk = require('../risk');
const C = require('../crypto');
const A = require('../auth');
const P = require('../permissions');
const { staffRow } = require('../serialize');
const { staffInviteEmail, staffResetEmail } = require('../emails');

const S = config.staff;
const PM = P.PERMISSIONS;
const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const roleInclude = { role: true };
async function loadStaff(id) {
    const s = await prisma.staffAccount.findUnique({ where: { id }, include: roleInclude });
    if (!s) throw apiError('Staff member not found.', 404, 'NOT_FOUND');
    return s;
}
async function otherActiveSuperAdmins(exceptId) {
    const role = await prisma.staffRole.findUnique({ where: { key: P.SUPER_ADMIN_KEY } });
    if (!role) return 0;
    return prisma.staffAccount.count({ where: { roleId: role.id, status: 'active', id: { not: exceptId } } });
}
const mustManage = (actor, target) => {
    if (actor.id === target.id) throw apiError('Use your own profile to change your own account.', 403, 'STAFF_FORBIDDEN');
    if (!P.canManageStaff(actor, target)) throw apiError('You can only manage staff ranked below you.', 403, 'STAFF_FORBIDDEN');
};

async function sendInvite(req, staff, { reason = 'invite' } = {}) {
    const raw = C.randomToken(32);
    await prisma.staffToken.updateMany({ where: { staffId: staff.id, type: 'invite', usedAt: null }, data: { usedAt: new Date() } });
    await prisma.staffToken.create({ data: { staffId: staff.id, type: 'invite', tokenHash: C.sha256(raw), expiresAt: new Date(Date.now() + S.inviteHours * 3600 * 1000) } });
    const link = `${S.consoleUrl}/invite?token=${raw}`;
    let delivered = false;
    try {
        const out = await sendMail({ to: staff.email, ...staffInviteEmail({ name: staff.name, inviterName: req.staff.name, roleName: staff.role ? staff.role.name : 'staff', link, hours: S.inviteHours }) });
        delivered = out.delivered !== false;
    } catch (err) { console.warn('[staff] invite email failed:', err.message); }
    // Development only: with no SMTP the link would otherwise be lost. In production it is NEVER returned to the browser.
    return { delivered, ...(!delivered && !config.isProd ? { devLink: link } : {}) };
}

// ---- Staff directory -----------------------------------------------------------------------------------------------------------------
router.get('/staff', A.requireAnyPermission(PM.STAFF_VIEW, PM.STAFF_MANAGE), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = ['invited', 'active', 'suspended'].includes(req.query.status) ? req.query.status : undefined;
    const where = { ...(status ? { status } : {}), ...(req.query.roleId ? { roleId: String(req.query.roleId) } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {}) };
    const rows = await prisma.staffAccount.findMany({ where, include: roleInclude, orderBy: [{ createdAt: 'asc' }], take: 500 });
    res.json({ data: rows.map(staffRow) });
}));

router.get('/staff/directory', A.requireAnyPermission(PM.TICKETS_MANAGE, PM.FOLLOWUPS_MANAGE, PM.STAFF_VIEW), wrap(async (req, res) => {
    // Minimal list for assignment pickers (anyone who can assign work), without security details.
    const rows = await prisma.staffAccount.findMany({ where: { status: 'active' }, include: roleInclude, orderBy: { name: 'asc' }, take: 500 });
    res.json({ data: rows.map((s) => ({ id: s.id, name: s.name, role: s.role ? s.role.name : '' })) });
}));

router.post('/staff', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 80) throw apiError('Enter the person\'s name.', 400);
    if (!emailRe.test(email) || email.length > 254) throw apiError('Enter a valid work email address.', 400);
    const role = req.body.roleId ? await prisma.staffRole.findUnique({ where: { id: String(req.body.roleId) } }) : null;
    if (!role) throw apiError('Choose a role.', 400);
    if (role.key === 'no_access') throw apiError('Choose a role that grants access.', 400);
    if (!P.canAssignRole(req.staff, role)) throw apiError('You can only assign roles ranked below yours that hold nothing you lack.', 403, 'STAFF_FORBIDDEN');
    if (await prisma.staffAccount.findUnique({ where: { email } })) throw apiError('A staff account with that email already exists.', 409);
    // The invitee has no usable password until they accept: the stored hash is of random bytes nobody knows.
    const created = await prisma.staffAccount.create({
        data: { name, email, jobTitle: String(req.body.jobTitle || '').trim().slice(0, 80), roleId: role.id, status: 'invited',
            passwordHash: await passwords.hash(C.randomToken(32), 12), createdById: req.staff.id },
        include: roleInclude
    });
    const invite = await sendInvite(req, created);
    await A.audit(req, 'staff.invited', 'staff', created.id, { metadata: { email, role: role.key } });
    res.status(201).json({ data: { ...staffRow(created), invite } });
}));

router.put('/staff/:id', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    const data = {}; const meta = {};
    if (typeof req.body.name === 'string' && req.body.name.trim() !== target.name) { const n = req.body.name.trim(); if (n.length < 2 || n.length > 80) throw apiError('Enter the person\'s name.', 400); data.name = n; }
    if (typeof req.body.jobTitle === 'string') data.jobTitle = req.body.jobTitle.trim().slice(0, 80);
    const wasSuper = P.isSuperAdminRole(target.role);
    let newRole = null;
    if (req.body.roleId && req.body.roleId !== target.roleId) {
        newRole = await prisma.staffRole.findUnique({ where: { id: String(req.body.roleId) } });
        if (!newRole) throw apiError('Role not found.', 404);
        if (!P.canAssignRole(req.staff, newRole)) throw apiError('You can only assign roles ranked below yours that hold nothing you lack.', 403, 'STAFF_FORBIDDEN');
        data.roleId = newRole.id; meta.role = { from: target.role.key, to: newRole.key };
    }
    const suspending = req.body.status === 'suspended' && target.status !== 'suspended';
    const reactivating = req.body.status === 'active' && target.status === 'suspended';
    if (req.body.status && !['active', 'suspended'].includes(req.body.status)) throw apiError('Status must be active or suspended.', 400);
    if (suspending) { data.status = 'suspended'; meta.status = 'suspended'; }
    if (reactivating) { data.status = 'active'; data.failedLogins = 0; data.lockedUntil = null; meta.status = 'active'; }
    if (wasSuper && ((newRole && !P.isSuperAdminRole(newRole)) || suspending) && (await otherActiveSuperAdmins(target.id)) === 0) {
        throw apiError('There must always be at least one active Super Admin.', 409, 'LAST_SUPER_ADMIN');
    }
    if (!Object.keys(data).length) throw apiError('Nothing to change.', 400);
    const updated = await prisma.staffAccount.update({ where: { id: target.id }, data, include: roleInclude });
    if (suspending) await A.revokeAllSessions(target.id, 'suspended');
    await A.audit(req, suspending ? 'staff.suspended' : reactivating ? 'staff.reactivated' : 'staff.updated', 'staff', target.id, { metadata: { ...meta, fields: Object.keys(data) } });
    res.json({ data: staffRow(updated) });
}));

router.post('/staff/:id/resend-invite', A.requirePermission(PM.STAFF_MANAGE), wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    if (target.status !== 'invited') throw apiError('Only pending invitations can be re-sent.', 409);
    const invite = await sendInvite(req, target);
    await A.audit(req, 'staff.invite.resent', 'staff', target.id);
    res.json({ data: { invite } });
}));

router.post('/staff/:id/send-reset', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    if (target.status !== 'active') throw apiError('Only active staff can be sent a password reset.', 409);
    const raw = C.randomToken(32);
    await prisma.staffToken.updateMany({ where: { staffId: target.id, type: 'password_reset', usedAt: null }, data: { usedAt: new Date() } });
    await prisma.staffToken.create({ data: { staffId: target.id, type: 'password_reset', tokenHash: C.sha256(raw), expiresAt: new Date(Date.now() + S.resetMinutes * 60000) } });
    const link = `${S.consoleUrl}/reset?token=${raw}`;
    let delivered = false;
    try { delivered = (await sendMail({ to: target.email, ...staffResetEmail({ name: target.name, link, minutes: S.resetMinutes }) })).delivered !== false; } catch (e) { console.warn('[staff] reset email failed:', e.message); }
    await A.audit(req, 'staff.password_reset.sent', 'staff', target.id);
    res.json({ data: { delivered, ...(!delivered && !config.isProd ? { devLink: link } : {}) } });
}));

/**
 * Lost phone / lost authenticator. Wipes the second factor AND returns the account to "invited": the person must come back through an
 * e-mailed link (proving they control the mailbox), choose a new password and enrol a new authenticator. Someone who merely knows the
 * old password therefore cannot enrol their own device after an MFA reset.
 */
router.post('/staff/:id/reset-mfa', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    if (P.isSuperAdminRole(target.role) && target.status === 'active' && (await otherActiveSuperAdmins(target.id)) === 0) {
        throw apiError('There must always be at least one active Super Admin.', 409, 'LAST_SUPER_ADMIN');
    }
    const updated = await prisma.staffAccount.update({
        where: { id: target.id },
        data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, recoveryCodeHashes: [], pinHash: null, pinSetAt: null, pinFailed: 0, pinLockedUntil: null, status: 'invited', tokenVersion: { increment: 1 },
            passwordHash: await passwords.hash(C.randomToken(32), 12), failedLogins: 0, lockedUntil: null },
        include: roleInclude
    });
    await A.revokeAllSessions(target.id, 'mfa_reset');
    await risk.revokeDevices(target.id);
    const invite = await sendInvite(req, updated);
    await A.audit(req, 'staff.mfa.reset', 'staff', target.id);
    res.json({ data: { ...staffRow(updated), invite } });
}));

router.post('/staff/:id/revoke-sessions', A.requirePermission(PM.STAFF_MANAGE), wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    const r = await A.revokeAllSessions(target.id, 'revoked_by_admin');
    await risk.revokeDevices(target.id);   // remembered browsers go too: the authenticator code is needed again everywhere
    await A.audit(req, 'staff.sessions.revoked', 'staff', target.id, { metadata: { count: r.count } });
    res.json({ data: { revoked: r.count } });
}));

/** Forgotten PIN that the person cannot reset themselves: clears it. They must choose a new one at next sign-in, which needs the authenticator code. */
router.post('/staff/:id/reset-pin', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    const updated = await prisma.staffAccount.update({ where: { id: target.id }, data: { pinHash: null, pinSetAt: null, pinFailed: 0, pinLockedUntil: null }, include: roleInclude });
    await risk.revokeDevices(target.id);
    await A.revokeAllSessions(target.id, 'pin_reset');
    await A.audit(req, 'staff.pin.reset_by_admin', 'staff', target.id);
    res.json({ data: staffRow(updated) });
}));

router.post('/staff/:id/unlock', A.requirePermission(PM.STAFF_MANAGE), wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    const updated = await prisma.staffAccount.update({ where: { id: target.id }, data: { failedLogins: 0, lockedUntil: null }, include: roleInclude });
    await A.audit(req, 'staff.unlocked', 'staff', target.id);
    res.json({ data: staffRow(updated) });
}));

router.delete('/staff/:id', A.requirePermission(PM.STAFF_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const target = await loadStaff(req.params.id);
    mustManage(req.staff, target);
    // Only an invitation that was never accepted can be deleted; everyone else is suspended so the audit trail keeps its subject.
    if (target.status !== 'invited' || target.lastLoginAt) throw apiError('Only pending invitations can be deleted. Suspend the account instead.', 409);
    await prisma.staffAccount.delete({ where: { id: target.id } });
    await A.audit(req, 'staff.invite.deleted', 'staff', target.id, { metadata: { email: target.email } });
    res.json({ data: { ok: true } });
}));

// ---- Roles -----------------------------------------------------------------------------------------------------------------------------
const roleOut = (r, members = 0) => ({ id: r.id, key: r.key, name: r.name, description: r.description, permissions: r.key === P.SUPER_ADMIN_KEY ? P.ALL_PERMISSIONS : (r.permissions || []), rank: r.rank, isSystem: r.isSystem, members });

router.get('/roles', A.requireAnyPermission(PM.STAFF_VIEW, PM.STAFF_MANAGE, PM.ROLES_MANAGE), wrap(async (req, res) => {
    const roles = await prisma.staffRole.findMany({ orderBy: [{ rank: 'desc' }, { name: 'asc' }] });
    const counts = await Promise.all(roles.map((r) => prisma.staffAccount.count({ where: { roleId: r.id } })));
    res.json({ data: {
        roles: roles.map((r, i) => roleOut(r, counts[i])),
        catalog: { groups: P.GROUPS.map((g) => ({ key: g.key, label: g.label, permissions: g.permissions.map((p) => ({ key: p, label: P.PERMISSION_INFO[p][0], description: P.PERMISSION_INFO[p][1], sensitive: P.SENSITIVE.includes(p) })) })) },
        you: { rank: P.rankOf(req.staff), permissions: req.staffPermissions }
    } });
}));

function readRoleBody(req) {
    const name = String(req.body.name || '').trim();
    if (name.length < 3 || name.length > 60) throw apiError('Role names are 3 to 60 characters.', 400);
    const description = String(req.body.description || '').trim().slice(0, 300);
    const permissions = Array.from(new Set((Array.isArray(req.body.permissions) ? req.body.permissions : []).filter(P.isPermission)));
    if (!permissions.length) throw apiError('Select at least one permission.', 400);
    const rank = Number.isInteger(req.body.rank) ? req.body.rank : 10;
    if (rank < 1 || rank > 99) throw apiError('Rank must be between 1 and 99.', 400);
    // The acting person's own rank is the ceiling (Super Admin: 99, since only the Super Admin role itself is 100).
    const ceiling = P.isSuperAdminRole(req.staff.role) ? 99 : P.rankOf(req.staff) - 1;
    if (rank > ceiling) throw apiError(`You can only create roles ranked ${ceiling} or lower.`, 403, 'STAFF_FORBIDDEN');
    const lacking = P.ungrantable(req.staff, permissions);
    if (lacking.length) throw apiError('You can only grant permissions you hold yourself.', 403, 'STAFF_FORBIDDEN');
    return { name, description, permissions, rank };
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role';

router.post('/roles', A.requirePermission(PM.ROLES_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const d = readRoleBody(req);
    if (await prisma.staffRole.findUnique({ where: { name: d.name } })) throw apiError('A role with that name already exists.', 409);
    const role = await prisma.staffRole.create({ data: { ...d, key: `custom_${slug(d.name)}_${C.randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, isSystem: false, createdById: req.staff.id } });
    await A.audit(req, 'role.created', 'staff_role', role.id, { metadata: { name: role.name, rank: role.rank, permissions: role.permissions } });
    res.status(201).json({ data: roleOut(role, 0) });
}));

router.put('/roles/:id', A.requirePermission(PM.ROLES_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const existing = await prisma.staffRole.findUnique({ where: { id: req.params.id } });
    if (!existing) throw apiError('Role not found.', 404);
    if (existing.isSystem) throw apiError('System roles cannot be edited. Create a custom role instead.', 403, 'STAFF_FORBIDDEN');
    // The role being replaced must also be within the editor's reach, or editing is a way around the hierarchy.
    if (!P.isSuperAdminRole(req.staff.role) && (existing.rank >= P.rankOf(req.staff) || P.ungrantable(req.staff, existing.permissions).length)) {
        throw apiError('You can only edit roles ranked below yours that hold nothing you lack.', 403, 'STAFF_FORBIDDEN');
    }
    const d = readRoleBody(req);
    const clash = await prisma.staffRole.findUnique({ where: { name: d.name } });
    if (clash && clash.id !== existing.id) throw apiError('A role with that name already exists.', 409);
    const role = await prisma.staffRole.update({ where: { id: existing.id }, data: d });
    await A.audit(req, 'role.updated', 'staff_role', role.id, { metadata: { name: role.name, rank: role.rank, permissions: role.permissions } });
    res.json({ data: roleOut(role, await prisma.staffAccount.count({ where: { roleId: role.id } })) });
}));

router.delete('/roles/:id', A.requirePermission(PM.ROLES_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const role = await prisma.staffRole.findUnique({ where: { id: req.params.id } });
    if (!role) throw apiError('Role not found.', 404);
    if (role.isSystem) throw apiError('System roles cannot be deleted.', 403, 'STAFF_FORBIDDEN');
    if (!P.isSuperAdminRole(req.staff.role) && (role.rank >= P.rankOf(req.staff) || P.ungrantable(req.staff, role.permissions).length)) throw apiError('You can only delete roles ranked below yours that hold nothing you lack.', 403, 'STAFF_FORBIDDEN');
    if ((await prisma.staffAccount.count({ where: { roleId: role.id } })) > 0) throw apiError('This role is still assigned to staff. Move them to another role first.', 409);
    await prisma.staffRole.delete({ where: { id: role.id } });
    await A.audit(req, 'role.deleted', 'staff_role', role.id, { metadata: { name: role.name } });
    res.json({ data: { ok: true } });
}));

// ---- Security centre -------------------------------------------------------------------------------------------------------------------
router.get('/security/overview', A.requirePermission(PM.SECURITY_MANAGE), wrap(async (req, res) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [active, noMfa, locked, sessions, failed, successes] = await Promise.all([
        prisma.staffAccount.count({ where: { status: 'active' } }),
        prisma.staffAccount.count({ where: { status: 'active', mfaEnabledAt: null } }),
        prisma.staffAccount.count({ where: { lockedUntil: { gt: new Date() } } }),
        prisma.staffSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
        prisma.adminAuditLog.count({ where: { action: { in: ['staff.login.failed', 'staff.mfa.failed', 'staff.account.locked', 'staff.recovery.failed'] }, createdAt: { gte: since } } }),
        prisma.adminAuditLog.count({ where: { action: 'staff.login.success', createdAt: { gte: since } } })
    ]);
    res.json({ data: {
        activeStaff: active, withoutMfa: noMfa, lockedAccounts: locked, liveSessions: sessions, failedSignIns24h: failed, signIns24h: successes,
        policy: { idleMinutes: S.idleMinutes, absoluteHours: S.absoluteHours, maxSessions: S.maxSessions, lockoutAttempts: S.lockoutAttempts, lockoutMinutes: S.lockoutMinutes, reauthMinutes: S.reauthMinutes, ipAllowlistEnabled: S.ipAllowlist.length > 0, mfaRequired: true, minPasswordLength: 12 }
    } });
}));

router.get('/security/sessions', A.requirePermission(PM.SECURITY_MANAGE), wrap(async (req, res) => {
    const rows = await prisma.staffSession.findMany({ where: { revokedAt: null, expiresAt: { gt: new Date() } }, include: { staff: { include: roleInclude } }, orderBy: { lastSeenAt: 'desc' }, take: 300 });
    res.json({ data: rows.map((s) => ({ id: s.id, staff: { id: s.staff.id, name: s.staff.name, email: s.staff.email, role: s.staff.role ? s.staff.role.name : '' }, device: A.deviceLabel(s.userAgent), ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.staffSession.id })) });
}));

router.delete('/security/sessions/:id', A.requirePermission(PM.SECURITY_MANAGE), wrap(async (req, res) => {
    const s = await prisma.staffSession.findUnique({ where: { id: req.params.id }, include: { staff: { include: roleInclude } } });
    if (!s) throw apiError('Session not found.', 404);
    if (s.staffId !== req.staff.id) mustManage(req.staff, s.staff);
    await A.revokeSession(s.id, 'revoked_by_admin');
    await A.audit(req, 'staff.session.revoked', 'staff_session', s.id, { metadata: { owner: s.staff.email } });
    res.json({ data: { ok: true } });
}));

// ---- Audit log ---------------------------------------------------------------------------------------------------------------------------
function auditWhere(q) {
    const where = {};
    if (q.q) { const t = String(q.q).trim().slice(0, 80); if (t) where.OR = [{ action: { contains: t, mode: 'insensitive' } }, { actorLabel: { contains: t, mode: 'insensitive' } }, { targetId: { equals: t } }]; }
    if (q.actorId) where.actorId = String(q.actorId);
    if (q.targetType) where.targetType = String(q.targetType);
    if (q.group === 'security') where.action = { startsWith: 'staff.' };
    else if (q.group === 'growth') where.action = { startsWith: 'growth.' };
    const from = q.from ? new Date(q.from) : null, to = q.to ? new Date(q.to) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
        where.createdAt = { ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}) };
    }
    return where;
}
const auditOut = (r) => ({ id: r.id, at: r.createdAt, action: r.action, actor: r.actor ? { id: r.actor.id, name: r.actor.name, email: r.actor.email } : null, actorLabel: r.actorLabel || (r.actor ? `${r.actor.name} <${r.actor.email}>` : ''), targetType: r.targetType, targetId: r.targetId, targetUser: r.targetUser ? { id: r.targetUser.id, name: r.targetUser.name, email: r.targetUser.email } : null, ip: r.ip || '', userAgent: r.userAgent || '', metadata: r.metadata || {} });
const auditInclude = { actor: { select: { id: true, name: true, email: true } }, targetUser: { select: { id: true, name: true, email: true } } };

router.get('/audit', A.requirePermission(PM.AUDIT_VIEW), wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 50));
    const where = auditWhere(req.query);
    const [rows, total] = await Promise.all([
        prisma.adminAuditLog.findMany({ where, include: auditInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.adminAuditLog.count({ where })
    ]);
    res.json({ data: { rows: rows.map(auditOut), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };   // also neutralises spreadsheet formula injection
router.get('/audit/export', A.requirePermission(PM.AUDIT_EXPORT), A.requireRecentAuth, wrap(async (req, res) => {
    const rows = await prisma.adminAuditLog.findMany({ where: auditWhere(req.query), include: auditInclude, orderBy: { createdAt: 'desc' }, take: 5000 });
    await A.audit(req, 'audit.exported', 'audit', null, { metadata: { rows: rows.length } });
    const head = ['time', 'actor', 'action', 'target_type', 'target_id', 'target_user', 'ip', 'details'];
    const lines = rows.map((r) => { const o = auditOut(r); return [new Date(o.at).toISOString(), o.actorLabel, o.action, o.targetType, o.targetId, o.targetUser ? o.targetUser.email : '', o.ip, JSON.stringify(o.metadata)].map(csvCell).join(','); });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="staff-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + [head.join(','), ...lines].join('\r\n'));
}));

module.exports = router;
module.exports.auditOut = auditOut;
