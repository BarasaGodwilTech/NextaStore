# NextaStore local test accounts

These accounts are created only by `nextastore-backend/scripts/seed-dev.js` when `NODE_ENV` is not `production`.

| Account | Email | Password | Role |
|---|---|---|---|
| Seller | `amina@example.com` | `password123` | Seller |
| Buyer | `brian@example.com` | `password123` | Buyer |

The seed is restart-safe: running `npm run seed:dev` again keeps these login details instead of creating duplicate accounts.

Do not use these credentials in a production database.


## Staff Console (separate from the shopper accounts above)

Open `/staff/login.html`. Staff accounts are a different system: they cannot shop, and the shopper logins above cannot sign in there.
Password for all of them: `DevStaff!2026-pass`. Two-step verification is required on every sign-in. The demo accounts share ONE
development authenticator secret: add `JBSWY3DPEHPK3PXP` to an authenticator app (manual entry, time-based) once and it works for all of
them. Or use the recovery code `DEVRECOV01` (single use).

| Email | Role |
|---|---|
| `admin@example.com` | Super Admin |
| `platform@example.com` | Platform Admin |
| `finance@example.com` | Finance Manager |
| `growth@example.com` | Growth Manager |
| `trust@example.com` | Trust & Safety Lead |
| `supportlead@example.com` | Support Lead |
| `support@example.com` | Support Agent |
| `moderator@example.com` | Moderator |
| `storemanager@example.com` | Store Manager |
| `auditor@example.com` | Auditor (read-only) |
| `trainee@example.com` | Support Trainee |

Created by `npm run seed:dev` (development only). For local http, set `STAFF_COOKIE_SECURE=false`.
