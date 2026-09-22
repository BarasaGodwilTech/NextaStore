# Spec item 6: admin redesign + role-based access

Full run on the final files: qa:static 131, admin-rbac 43, admin-console-browser 82,
mobile-drawer 79, presence 36 + 17 + 11, notifications 21, push 48 + 27 + 32 + 30 + 20,
seo 10, new-product-notify 15. All pass. Stubbed Express/Prisma; migration/seed not run
against Postgres.

## Bugs found
- js/admin.js: `this.permissions = []` shadowed the `permissions()` method, so can() threw for
  every non-super admin (error toast, no tabs hidden, overview never loaded). Method renamed
  ownPermissions().
- css/admin.css used var(--border)/var(--muted), never defined anywhere: borders and muted text
  never rendered.
- API: role-assignment/role-edit privilege escalation; users.suspend unusable without
  users.edit; last super admin could demote/switch itself; password reset allowed on
  admins/super admins; account detail leaked audit trail + follow-ups; dashboard.view unenforced.

## Backend (src/routes/admin.js, src/middleware.js)
- requireAnyAdminPermission; PUT /users/:id now per-field (edit vs suspend vs manage admins).
- You can only grant/assign/edit/delete roles made of permissions you hold (super admin exempt).
- Last active super admin protected (409).
- Password reset on admins needs admins.manage; on super admins needs super admin.
- GET /overview needs dashboard.view (DEPLOY NOTE: older custom roles without it lose the
  overview). GET /roles needs roles.manage or admins.manage. GET /administrators needs
  followups.manage or admins.manage. User detail only returns audit/follow-ups if permitted.
- Migration 20260920120000_default_admin_roles: Store Manager, Support Agent, Moderator
  (idempotent). Dev seed adds support@/moderator@/storemanager@example.com (password123).

## Frontend
- admin.html: sidebar shell with grouped nav. Locked modules are REMOVED from the DOM.
- js/admin.js: permission-aware user table/dialog/roles UI, Escape closes dialogs, single
  overview load.
- css/admin.css rewritten (tokens, 12px+ type, 44px targets, card-stacked table and bottom-sheet
  dialogs under 768px, strip nav under 900px). Conflicting admin rules removed from mobile.css.
- service-worker.js cache bumped to v9.

## Tests added
- npm run test:admin-rbac (stubs Express/Prisma; fails 30 checks on the old code)
- npm run test:admin-console-browser

## Not done
- Admin UI for the payment-methods catalog (API exists).
- No store/product-level permissions exist; "Store Manager" = seller accounts + Seller Pass.
- Migration/seed never run against real Postgres. Icons unchecked (Font Awesome CDN blocked
  in the sandbox). Real iPhone check still needed.

## Addendum: payment-methods admin screen (spec item 5, admin side)
Platform tab (settings.manage only; absent for other roles) now lists the checkout payment
methods with On/Off, currency, countries and live/test mode, and can turn a method on/off,
add, edit (code locked) and delete. Uses the existing /api/admin/payment-methods routes.
Cache bumped to v10. Browser test grew to 82 checks.
