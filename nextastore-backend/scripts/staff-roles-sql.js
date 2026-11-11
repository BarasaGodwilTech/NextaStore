#!/usr/bin/env node
'use strict';
// Prints the SQL that seeds the system staff roles AND tops existing ones up with permissions added later, generated from
// src/staff/permissions.js so the SQL can never drift from the code.
//   node scripts/staff-roles-sql.js            -> full seed INSERT (migration 20261106090000)
//   node scripts/staff-roles-sql.js --topup    -> UPDATEs that add any missing permission to existing system roles
//   node scripts/staff-roles-sql.js --templates -> starter message templates
const { SYSTEM_ROLES } = require('../src/staff/permissions');
const { STARTER_TEMPLATES } = require('../src/staff/templates');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
if (process.argv.includes('--topup')) {
    const NEW = ['users.contact', 'broadcasts.send'];
    const out = [];
    for (const r of SYSTEM_ROLES) for (const p of NEW) if (r.permissions.includes(p)) out.push(`UPDATE "StaffRole" SET "permissions" = array_append("permissions", ${q(p)}), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = ${q(r.key)} AND "isSystem" = true AND NOT (${q(p)} = ANY("permissions"));`);
    process.stdout.write(out.join('\n') + '\n');
} else if (process.argv.includes('--templates')) {
    const rows = STARTER_TEMPLATES.map((t) => `  (${q(t.id)}, ${q(t.title)}, ${q(t.body)}, ${q(t.kind)}, ${q(t.subject)}, ${q(t.category)}, CURRENT_TIMESTAMP)`);
    process.stdout.write(`INSERT INTO "CannedReply" ("id","title","body","kind","subject","category","updatedAt") VALUES\n${rows.join(',\n')}\nON CONFLICT ("id") DO NOTHING;\n`);
} else {
    const rows = SYSTEM_ROLES.map((r) =>
        `  (${q('sys_role_' + r.key)}, ${q(r.key)}, ${q(r.name)}, ${q(r.description)}, ARRAY[${r.permissions.map(q).join(',')}]::TEXT[], ${r.rank}, true, CURRENT_TIMESTAMP)`);
    process.stdout.write(`INSERT INTO "StaffRole" ("id","key","name","description","permissions","rank","isSystem","updatedAt") VALUES\n${rows.join(',\n')}\nON CONFLICT ("key") DO NOTHING;\n`);
}
