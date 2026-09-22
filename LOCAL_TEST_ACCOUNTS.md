# NextaStore local test accounts

These accounts are created only by `nextastore-backend/scripts/seed-dev.js` when `NODE_ENV` is not `production`.

| Account | Email | Password | Role |
|---|---|---|---|
| Seller | `amina@example.com` | `password123` | Seller |
| Buyer | `brian@example.com` | `password123` | Buyer |
| Admin | `admin@example.com` | `password123` | Super administrator |
| Admin | `support@example.com` | `password123` | Support Agent |
| Admin | `moderator@example.com` | `password123` | Moderator |
| Admin | `storemanager@example.com` | `password123` | Store Manager |

The seed is restart-safe: running `npm run seed:dev` again keeps these login details instead of creating duplicate accounts.

Do not use these credentials in a production database.
