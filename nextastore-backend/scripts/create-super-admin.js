/**
 * Creates (or re-invites) a Super Admin STAFF account and prints a one-time invitation link.
 * Use it once on a fresh database, or to recover when every Super Admin has been lost.
 *
 *   npm run staff:create-super-admin -- you@company.com "Your Name"
 *
 * The person opens the link, chooses a password and enrols an authenticator. Nothing secret is printed except the
 * single-use link (valid for STAFF_INVITE_HOURS, default 48h).
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const config = require('../src/config');
const C = require('../src/staff/crypto');
const P = require('../src/staff/permissions');

(async () => {
    const [email, ...nameParts] = process.argv.slice(2);
    const name = nameParts.join(' ').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length < 2) {
        console.error('Usage: npm run staff:create-super-admin -- you@company.com "Your Name"');
        process.exit(1);
    }
    const prisma = new PrismaClient();
    try {
        const role = await prisma.staffRole.findUnique({ where: { key: P.SUPER_ADMIN_KEY } });
        if (!role) throw new Error('The Super Admin role is missing. Run "npx prisma migrate deploy" first.');
        const lower = email.trim().toLowerCase();
        let staff = await prisma.staffAccount.findUnique({ where: { email: lower } });
        if (staff && staff.status === 'active') throw new Error(`${lower} is already an active staff member. Use "Send password reset" in the console instead.`);
        if (!staff) {
            staff = await prisma.staffAccount.create({ data: {
                name, email: lower, roleId: role.id, status: 'invited', mustChangePassword: true,
                passwordHash: bcrypt.hashSync(C.randomToken(32), 12)   // nobody knows it: the invitation sets the real one
            } });
        } else {
            staff = await prisma.staffAccount.update({ where: { id: staff.id }, data: { roleId: role.id, status: 'invited' } });
        }
        await prisma.staffToken.updateMany({ where: { staffId: staff.id, type: 'invite', usedAt: null }, data: { usedAt: new Date() } });
        const raw = C.randomToken(32);
        await prisma.staffToken.create({ data: { staffId: staff.id, type: 'invite', tokenHash: C.sha256(raw), expiresAt: new Date(Date.now() + config.staff.inviteHours * 3600 * 1000) } });
        console.log(`Super Admin invited: ${staff.email}`);
        console.log(`Invitation link (single use, ${config.staff.inviteHours}h): ${config.staff.consoleUrl}/invite?token=${raw}`);
    } finally {
        await prisma.$disconnect();
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
