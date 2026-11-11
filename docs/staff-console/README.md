# Staff Console

The admin side of NextaStore is a **separate system** from the marketplace. Staff do not have shopper accounts, shoppers cannot sign in to it, and
the staff console has no cart, orders-as-buyer, messages or any other shopper tool. It is management only.

## What changed

| Before | Now |
|---|---|
| Admins were `User` rows with `role = admin`, signing in on the shopper `/login` | Staff are `StaffAccount` rows with their own sign-in at `/staff/login.html` |
| Admin pages lived in the shopper site and used the shopper JWT | Console lives in `/staff`, API in `/api/staff`, with an opaque server-side session in an httpOnly cookie |
| Password only | Password **and** authenticator code on every sign-in (TOTP + recovery codes) |
| 3 starter roles | 12 system roles + custom roles, with rank so nobody can manage someone above them |
| `/api/admin/*` | Gone: returns `410` |

## Sign-in
1. `POST /api/staff/auth/login` (password) returns a 5-minute challenge, never a session.
2. `POST /api/staff/auth/mfa/verify` (authenticator code or a recovery code), or on first use `mfa/setup/begin` + `mfa/setup/confirm`, which also returns 10 recovery codes once.
3. Only then is a session created: random token in an httpOnly, SameSite=Strict, Secure cookie (`nxs_staff`, scoped to `/api/staff`). Only its SHA-256 is stored.
4. Mutating requests need the per-session `X-CSRF-Token`, and an allowed `Origin`.

Protections: 12+ character passwords, lock-out (5 failures / 15 min), per-IP and per-email rate limits, idle timeout (30 min), absolute lifetime (12 h),
max 5 sessions each, TOTP replay protection, authenticator secrets encrypted at rest (AES-256-GCM), step-up re-confirmation for sensitive actions
(roles, staff changes, settings, audit export), optional IP allow-list, invite and reset links that are single-use and expire, and an audit log
of every action (with IP and device). The last Super Admin cannot be demoted, removed or locked out by anyone.

## Roles
`Super Admin`, `Platform Admin`, `Finance Manager`, `Growth Manager`, `Trust & Safety Lead`, `Support Lead`, `Support Agent`, `Moderator`,
`Store Manager`, `Auditor` (read-only), `Support Trainee`, `No access`. Custom roles can be made from the permission catalog under
**Roles & access**; you can only grant permissions you hold, and only manage staff ranked below you.

## Tools
Overview and analytics, users (360 view, notes, suspend, password-reset email, sign-out), stores and products moderation (hidden from shoppers,
owner told), orders (flag review), buyer reports, a support desk (tickets, SLA by priority, assignment, internal notes, saved replies, customer
context), follow-ups, Nexi handoffs, announcements, seller payment approvals, platform settings and payment methods, Circle & Crew programme
admin, staff directory and invitations, roles, security overview and live sessions, and the audit log with CSV export.

## Deploying
* Serve the `staff/` folder as static files. Same origin as the API is simplest. For a separate host (e.g. `staff.example.com`), put the API URL in
  `staff/config.js`, add that origin to the `connect-src` of each page's CSP meta tag, and set `STAFF_ORIGINS` and `STAFF_CONSOLE_URL`. The cookie is
  SameSite=Strict, so both hosts must share the same registrable domain.
* Set `STAFF_SECRET` and `STAFF_MFA_KEY` (see `.env.example`). Production refuses to start without them.
* Ideally restrict the console with `STAFF_IP_ALLOWLIST` or a VPN, and send the headers `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`
  for `/staff/*` at your proxy (a meta CSP cannot set `frame-ancestors`). The API already sends `Cache-Control: no-store`.
* Run `npx prisma migrate deploy`. **Existing admins are moved to staff accounts automatically**, but they must set a new password and enrol an
  authenticator at first sign-in. Their old shopper logins no longer exist.

## Creating the first Super Admin on a new database
The migration carries over existing admins. On a fresh database there is none, so create one once from a trusted machine:
`npm run staff:create-super-admin -- you@company.com "Your Name"`. It prints a one-time invitation link.

---

## Phase 3: risk-based sign-in, security PIN, communication, role-aware UI

### Signing in: when is the authenticator code asked?
Password first, then `src/staff/risk.js` decides:

| Situation | Result |
| --- | --- |
| First ever sign-in (no authenticator yet) | Code setup (QR), recovery codes, then PIN setup |
| Browser not remembered / remembered browser expired (`STAFF_DEVICE_TRUST_DAYS`, default 30) | Authenticator code |
| Suspicious: 2+ recent wrong passwords, different browser/OS than the remembered one, or a different /16 network | Authenticator code (and a `staff.login.suspicious` audit entry) |
| Role rank >= `STAFF_MFA_ALWAYS_RANK` (default 100 = Super Admin) | Authenticator code every time |
| Remembered browser, nothing unusual | Password alone opens an ordinary session |

"Remember this browser" is a checkbox on the code page (on by default; untick on shared computers). The browser holds a random token in an httpOnly cookie; only its SHA-256 is stored (`StaffDevice`). Staff can forget browsers on **Account**; a manager's *Revoke sessions*, *Reset two-step* or *Reset PIN* also forgets every remembered browser of that person.

### The security PIN
Everyone sets a 6-digit PIN right after their first sign-in (weak ones like 123456 are refused; stored bcrypt-hashed). Nothing but `/me` works until it exists (`STAFF_PIN_SETUP_REQUIRED`). A fresh session is **not** step-up: the first sensitive action (money, access, security, audit export, broadcasts) opens the PIN pad, then stays unlocked for `STAFF_REAUTH_MINUTES`. A password alone is never accepted as step-up. Wrong PINs are counted separately and lock only the PIN (`STAFF_PIN_LOCKOUT_ATTEMPTS`/`_MINUTES`), never the account. Forgot it: *Forgot PIN?* asks for an authenticator code; a staff manager can also clear it (*Reset PIN*), after which the person must choose a new one.

### Seeing what a role can do
Inviting or editing staff shows a live panel of the chosen role: grouped, plain-language permissions, a PIN tag on sensitive ones, and which areas have no access. The same panel is on each staff member's drawer. Permissions flagged sensitive come from `SENSITIVE` in `src/staff/permissions.js`.

### Contacting people
* **Message** button on a person's profile (`users.contact`): email and/or in-app notice, template-assisted, variables, live preview. Saved as a note and in the audit log. Unverified emails are skipped. Rate limited (`STAFF_CONTACT_LIMIT`, 30 / 10 min / person).
* **Broadcasts** (`broadcasts.send`): pick a group (everyone, sellers, shoppers, new in 7 days), compose, see the exact count and a preview, confirm, enter PIN. Count must match the preview, one at a time, emails capped at 5,000, delivery runs in pages after the response; receipts are kept.
* **Templates**: the old canned replies are now typed templates (ticket reply / email / in-app notice) with `{{first_name}}`, `{{name}}`, `{{staff_name}}`. Ten starter templates are seeded by the migration (fixed ids, so deleting one never brings it back).
* **Search** (Ctrl/Cmd + K): people, stores, orders, tickets and staff, limited to what the role may see; also jumps to any page.

### Role-aware UI
The shell tints itself by role family (support = blue, money = amber, growth = purple, safety = red, operations = teal, audit = slate, owner = green); the Home page leads with that role's own numbers and quick actions. Plain-language `?` help sits on fields and metrics (e.g. campaign *Extra reward %* with a live worked example). Lists sort, stick headers and turn into cards on phones; pages show skeletons while loading, and lookups use a stale-while-revalidate cache that any write clears.

### Upgrading an existing database
Run `npx prisma migrate deploy`. Migration `20261110090000_staff_pin_devices_templates` is additive. It adds PIN and device tables/columns, template columns, the `Broadcast` table, the `staff_message` notification type, tops up the built-in roles with `users.contact` / `broadcasts.send`, and seeds starter templates. **Existing staff will be asked to create a PIN at their next sign-in.** Nothing was run against a real Postgres in this environment; read the SQL and take a backup first.
