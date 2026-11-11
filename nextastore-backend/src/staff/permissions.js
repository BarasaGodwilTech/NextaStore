'use strict';
/*
 * The Staff Console permission model.
 *
 *   PERMISSIONS   every permission that exists (the only strings a role may hold)
 *   GROUPS        the same permissions grouped for the role editor
 *   SYSTEM_ROLES  roles that ship with the product (cannot be edited or deleted in the console)
 *
 * Rank is the hierarchy. Someone can only create, edit, suspend, reset or assign roles that rank BELOW their own
 * (a Super Admin, rank 100, is the exception and can act on anyone but must never remove the last active Super Admin).
 * This is what stops "can manage staff" from being a way to become a Super Admin.
 *
 * migration 20261106090000_staff_console_separation seeds SYSTEM_ROLES; scripts/staff-roles-sql.js regenerates that SQL.
 */

const PERMISSIONS = Object.freeze({
    // Workspace
    DASHBOARD_VIEW: 'dashboard.view',
    ANALYTICS_VIEW: 'analytics.view',
    // People
    USERS_VIEW: 'users.view',
    USERS_EDIT: 'users.edit',
    USERS_SUSPEND: 'users.suspend',
    USERS_PASSWORD_RESET: 'users.password_reset',
    USERS_SESSIONS: 'users.sessions',
    USERS_NOTES: 'users.notes',
    USERS_CONTACT: 'users.contact',
    // Marketplace
    STORES_VIEW: 'stores.view',
    STORES_MANAGE: 'stores.manage',
    PRODUCTS_VIEW: 'products.view',
    PRODUCTS_MODERATE: 'products.moderate',
    ORDERS_VIEW: 'orders.view',
    ORDERS_MANAGE: 'orders.manage',
    // Trust & safety
    REPORTS_REVIEW: 'reports.review',
    // Finance
    FINANCE_VIEW: 'finance.view',
    SUBSCRIPTIONS_REVIEW: 'subscriptions.review',
    // Support
    TICKETS_VIEW: 'tickets.view',
    TICKETS_MANAGE: 'tickets.manage',
    CANNED_MANAGE: 'canned.manage',
    FOLLOWUPS_MANAGE: 'followups.manage',
    NEXI_VIEW: 'nexi.view',
    // Communications
    ANNOUNCEMENTS_MANAGE: 'announcements.manage',
    BROADCASTS_SEND: 'broadcasts.send',
    // Circle / Crew growth programme (review and payouts are deliberately different people)
    GROWTH_VIEW: 'growth.view',
    GROWTH_REVIEW: 'growth.review',
    GROWTH_PAYOUTS: 'growth.payouts',
    GROWTH_SETTINGS: 'growth.settings',
    // Platform
    SETTINGS_MANAGE: 'settings.manage',
    // Staff, roles, security
    STAFF_VIEW: 'staff.view',
    STAFF_MANAGE: 'staff.manage',
    ROLES_MANAGE: 'roles.manage',
    SECURITY_MANAGE: 'security.manage',
    AUDIT_VIEW: 'audit.view',
    AUDIT_EXPORT: 'audit.export'
});
const P = PERMISSIONS;
const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

// label/description are shown in the role editor.
const PERMISSION_INFO = Object.freeze({
    [P.DASHBOARD_VIEW]: ['See the overview', 'Open the console home and its headline numbers.'],
    [P.ANALYTICS_VIEW]: ['See analytics', 'Sign-up, order and revenue trends.'],
    [P.USERS_VIEW]: ['View accounts', 'Search and open shopper and seller accounts.'],
    [P.USERS_EDIT]: ['Edit accounts', 'Change a name, email or account type.'],
    [P.USERS_SUSPEND]: ['Suspend / reactivate accounts', 'Lock an account out or let it back in.'],
    [P.USERS_PASSWORD_RESET]: ['Send password resets', 'Email a reset link to a shopper or seller.'],
    [P.USERS_SESSIONS]: ['Sign accounts out', 'End every login a shopper or seller has.'],
    [P.USERS_CONTACT]: ['Message accounts', 'Send an email or in-app message to one shopper or seller.'],
    [P.USERS_NOTES]: ['Internal notes', 'Read and write staff-only notes on an account.'],
    [P.STORES_VIEW]: ['View stores', 'Open store profiles and subscription state.'],
    [P.STORES_MANAGE]: ['Restrict stores', 'Take a store off the marketplace, or restore it.'],
    [P.PRODUCTS_VIEW]: ['View products', 'Search the product catalogue.'],
    [P.PRODUCTS_MODERATE]: ['Moderate products', 'Hide a listing from shoppers, or restore it.'],
    [P.ORDERS_VIEW]: ['View orders', 'Look up any order and its buyer.'],
    [P.ORDERS_MANAGE]: ['Resolve flagged orders', 'Clear an order flag after review.'],
    [P.REPORTS_REVIEW]: ['Review reports', 'Work through buyer reports about orders.'],
    [P.FINANCE_VIEW]: ['View finance', 'Read the Seller Pass payment ledger.'],
    [P.SUBSCRIPTIONS_REVIEW]: ['Approve seller payments', 'Approve or reject Seller Pass payments.'],
    [P.TICKETS_VIEW]: ['View support tickets', 'Read the support queue and conversations.'],
    [P.TICKETS_MANAGE]: ['Work support tickets', 'Reply, assign, change status and priority.'],
    [P.CANNED_MANAGE]: ['Manage message templates', 'Create and edit the shared templates: ticket replies, emails and notifications.'],
    [P.FOLLOWUPS_MANAGE]: ['Manage follow-ups', 'Create and work internal follow-up tasks.'],
    [P.NEXI_VIEW]: ['See Nexi handoffs', 'Read where the assistant passed a visitor to a person.'],
    [P.ANNOUNCEMENTS_MANAGE]: ['Manage announcements', 'Publish platform-wide banners.'],
    [P.BROADCASTS_SEND]: ['Send broadcasts', 'Email or notify a whole group of shoppers or sellers at once. Always asks for your PIN.'],
    [P.GROWTH_VIEW]: ['Circle & Crew: view', 'Read partners, referrals, flags and exports of member lists.'],
    [P.GROWTH_REVIEW]: ['Circle & Crew: review', 'Approve Crew, freeze partners, release or void earnings.'],
    [P.GROWTH_PAYOUTS]: ['Circle & Crew: payouts', 'Approve and mark withdrawals paid, adjust balances.'],
    [P.GROWTH_SETTINGS]: ['Circle & Crew: settings', 'Programme settings and campaigns.'],
    [P.SETTINGS_MANAGE]: ['Platform settings', 'Payment methods, platform settings and dial instructions.'],
    [P.STAFF_VIEW]: ['View staff', 'See the staff directory and each person\'s role.'],
    [P.STAFF_MANAGE]: ['Manage staff', 'Invite, edit, suspend and reset staff ranked below you.'],
    [P.ROLES_MANAGE]: ['Manage roles', 'Create and edit custom roles (never above your own).'],
    [P.SECURITY_MANAGE]: ['Security controls', 'See and end any staff session; security overview.'],
    [P.AUDIT_VIEW]: ['Read the audit log', 'Every action staff took, and every sign-in.'],
    [P.AUDIT_EXPORT]: ['Export the audit log', 'Download the audit log as CSV.']
});

const GROUPS = Object.freeze([
    { key: 'workspace', label: 'Workspace', permissions: [P.DASHBOARD_VIEW, P.ANALYTICS_VIEW] },
    { key: 'people', label: 'People', permissions: [P.USERS_VIEW, P.USERS_EDIT, P.USERS_SUSPEND, P.USERS_PASSWORD_RESET, P.USERS_SESSIONS, P.USERS_NOTES, P.USERS_CONTACT] },
    { key: 'marketplace', label: 'Marketplace', permissions: [P.STORES_VIEW, P.STORES_MANAGE, P.PRODUCTS_VIEW, P.PRODUCTS_MODERATE, P.ORDERS_VIEW, P.ORDERS_MANAGE] },
    { key: 'trust', label: 'Trust & safety', permissions: [P.REPORTS_REVIEW] },
    { key: 'finance', label: 'Finance', permissions: [P.FINANCE_VIEW, P.SUBSCRIPTIONS_REVIEW] },
    { key: 'support', label: 'Support', permissions: [P.TICKETS_VIEW, P.TICKETS_MANAGE, P.CANNED_MANAGE, P.FOLLOWUPS_MANAGE, P.NEXI_VIEW] },
    { key: 'comms', label: 'Communications', permissions: [P.ANNOUNCEMENTS_MANAGE, P.BROADCASTS_SEND] },
    { key: 'growth', label: 'Circle & Crew', permissions: [P.GROWTH_VIEW, P.GROWTH_REVIEW, P.GROWTH_PAYOUTS, P.GROWTH_SETTINGS] },
    { key: 'platform', label: 'Platform', permissions: [P.SETTINGS_MANAGE] },
    { key: 'security', label: 'Staff & security', permissions: [P.STAFF_VIEW, P.STAFF_MANAGE, P.ROLES_MANAGE, P.SECURITY_MANAGE, P.AUDIT_VIEW, P.AUDIT_EXPORT] }
]);

/**
 * Permissions whose use asks for the person's PIN (see requireRecentAuth on the routes). Shown as a "needs your PIN" badge in the role editor
 * and the invite dialog so nobody is surprised.
 */
const SENSITIVE = Object.freeze([P.SETTINGS_MANAGE, P.SUBSCRIPTIONS_REVIEW, P.GROWTH_PAYOUTS, P.GROWTH_SETTINGS, P.STAFF_MANAGE, P.ROLES_MANAGE, P.SECURITY_MANAGE, P.AUDIT_EXPORT, P.BROADCASTS_SEND]);

const without = (list, drop) => list.filter((p) => !drop.includes(p));

const SUPER_ADMIN_KEY = 'super_admin';
const RANK_SUPER_ADMIN = 100;

const SYSTEM_ROLES = Object.freeze([
    { key: 'super_admin', name: 'Super Admin', rank: 100,
      description: 'Owns the platform. Holds every permission, including staff, roles and security. Keep this to as few people as possible.',
      permissions: ALL_PERMISSIONS },
    { key: 'platform_admin', name: 'Platform Admin', rank: 80,
      description: 'Runs day-to-day operations across the marketplace. Cannot manage staff, roles or security.',
      permissions: without(ALL_PERMISSIONS, [P.STAFF_MANAGE, P.ROLES_MANAGE, P.SECURITY_MANAGE]) },
    { key: 'finance_manager', name: 'Finance Manager', rank: 60,
      description: 'Approves Seller Pass payments and Circle / Crew payouts. Reads the payment ledger.',
      permissions: [P.DASHBOARD_VIEW, P.ANALYTICS_VIEW, P.USERS_VIEW, P.STORES_VIEW, P.FINANCE_VIEW, P.SUBSCRIPTIONS_REVIEW, P.GROWTH_VIEW, P.GROWTH_PAYOUTS, P.FOLLOWUPS_MANAGE, P.AUDIT_VIEW] },
    { key: 'growth_manager', name: 'Growth Manager', rank: 60,
      description: 'Runs the Circle and Crew programmes: approvals, campaigns and settings. Cannot pay withdrawals.',
      permissions: [P.DASHBOARD_VIEW, P.ANALYTICS_VIEW, P.USERS_VIEW, P.STORES_VIEW, P.GROWTH_VIEW, P.GROWTH_REVIEW, P.GROWTH_SETTINGS, P.ANNOUNCEMENTS_MANAGE, P.FOLLOWUPS_MANAGE, P.USERS_CONTACT, P.BROADCASTS_SEND] },
    { key: 'trust_safety_lead', name: 'Trust & Safety Lead', rank: 60,
      description: 'Leads moderation: reports, account suspensions, store restrictions and product removals.',
      permissions: [P.DASHBOARD_VIEW, P.USERS_VIEW, P.USERS_SUSPEND, P.USERS_SESSIONS, P.USERS_NOTES, P.STORES_VIEW, P.STORES_MANAGE, P.PRODUCTS_VIEW, P.PRODUCTS_MODERATE, P.ORDERS_VIEW, P.ORDERS_MANAGE, P.REPORTS_REVIEW, P.TICKETS_VIEW, P.TICKETS_MANAGE, P.FOLLOWUPS_MANAGE, P.AUDIT_VIEW, P.USERS_CONTACT] },
    { key: 'support_lead', name: 'Support Lead', rank: 50,
      description: 'Runs the support desk: all ticket tools, canned replies, password resets and sign-outs.',
      permissions: [P.DASHBOARD_VIEW, P.ANALYTICS_VIEW, P.USERS_VIEW, P.USERS_PASSWORD_RESET, P.USERS_SESSIONS, P.USERS_NOTES, P.STORES_VIEW, P.ORDERS_VIEW, P.TICKETS_VIEW, P.TICKETS_MANAGE, P.CANNED_MANAGE, P.FOLLOWUPS_MANAGE, P.NEXI_VIEW, P.USERS_CONTACT] },
    { key: 'moderator', name: 'Moderator', rank: 40,
      description: 'Handles Trust & Safety: reviews reports, hides listings and suspends or reactivates accounts.',
      permissions: [P.DASHBOARD_VIEW, P.USERS_VIEW, P.USERS_SUSPEND, P.USERS_NOTES, P.STORES_VIEW, P.PRODUCTS_VIEW, P.PRODUCTS_MODERATE, P.ORDERS_VIEW, P.REPORTS_REVIEW, P.FOLLOWUPS_MANAGE] },
    { key: 'store_manager', name: 'Store Manager', rank: 40,
      description: 'Looks after seller accounts, their stores and Seller Pass payments.',
      permissions: [P.DASHBOARD_VIEW, P.USERS_VIEW, P.USERS_EDIT, P.USERS_NOTES, P.STORES_VIEW, P.STORES_MANAGE, P.PRODUCTS_VIEW, P.SUBSCRIPTIONS_REVIEW, P.TICKETS_VIEW, P.TICKETS_MANAGE, P.FOLLOWUPS_MANAGE, P.USERS_CONTACT] },
    { key: 'support_agent', name: 'Support Agent', rank: 30,
      description: 'Helps shoppers and sellers: answers tickets, looks up accounts and orders, sends password resets.',
      permissions: [P.DASHBOARD_VIEW, P.USERS_VIEW, P.USERS_PASSWORD_RESET, P.USERS_NOTES, P.STORES_VIEW, P.ORDERS_VIEW, P.TICKETS_VIEW, P.TICKETS_MANAGE, P.FOLLOWUPS_MANAGE, P.NEXI_VIEW, P.USERS_CONTACT] },
    { key: 'auditor', name: 'Auditor', rank: 20,
      description: 'Read-only oversight: audit log, staff directory and the payment ledger. Cannot change anything.',
      permissions: [P.DASHBOARD_VIEW, P.ANALYTICS_VIEW, P.FINANCE_VIEW, P.STAFF_VIEW, P.AUDIT_VIEW, P.AUDIT_EXPORT] },
    { key: 'support_trainee', name: 'Support Trainee', rank: 10,
      description: 'Read-only support access for people in training: can look things up but cannot change anything.',
      permissions: [P.DASHBOARD_VIEW, P.USERS_VIEW, P.STORES_VIEW, P.ORDERS_VIEW, P.TICKETS_VIEW] },
    { key: 'no_access', name: 'No access', rank: 0,
      description: 'Placeholder for an account whose role was removed. Signs in but can do nothing until a role is assigned.',
      permissions: [] }
]);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);
const isPermission = (p) => PERMISSION_SET.has(p);

const isSuperAdminRole = (role) => !!role && role.key === SUPER_ADMIN_KEY;

/** Permissions a staff member effectively holds. Super Admin always holds every permission that exists, even ones added later. */
function permissionsOf(staff) {
    if (!staff || !staff.role) return [];
    if (isSuperAdminRole(staff.role)) return ALL_PERMISSIONS.slice();
    return (staff.role.permissions || []).filter(isPermission);
}

function hasPermission(staff, permission) {
    if (!staff || staff.status !== 'active' || !staff.role) return false;
    if (isSuperAdminRole(staff.role)) return true;
    return Array.isArray(staff.role.permissions) && staff.role.permissions.includes(permission);
}

const rankOf = (staff) => (staff && staff.role ? Number(staff.role.rank) || 0 : 0);

/**
 * May `actor` manage (edit, suspend, reset, change the role of) `target`?
 * Strictly below their own rank; a Super Admin may also act on another Super Admin (the caller guards the last one).
 */
function canManageStaff(actor, target) {
    if (!actor || !target) return false;
    if (actor.id === target.id) return false;
    if (isSuperAdminRole(actor.role)) return true;
    return rankOf(target) < rankOf(actor);
}

/** Roles `actor` may hand out: strictly below their rank and made only of permissions they hold themselves. */
function canAssignRole(actor, role) {
    if (!actor || !role) return false;
    if (isSuperAdminRole(actor.role)) return true;
    if ((Number(role.rank) || 0) >= rankOf(actor)) return false;
    return (role.permissions || []).every((p) => hasPermission(actor, p));
}

/** Permissions in `wanted` that `actor` does not hold themselves (a Super Admin holds all). */
function ungrantable(actor, wanted) {
    if (actor && isSuperAdminRole(actor.role)) return [];
    return (wanted || []).filter((p) => !hasPermission(actor, p));
}

module.exports = {
    PERMISSIONS, ALL_PERMISSIONS, PERMISSION_INFO, GROUPS, SENSITIVE, SYSTEM_ROLES, SUPER_ADMIN_KEY, RANK_SUPER_ADMIN,
    isPermission, isSuperAdminRole, permissionsOf, hasPermission, rankOf, canManageStaff, canAssignRole, ungrantable
};
