# NextaStore production update — Seller Pass + verified badge

Date: 2026-09-15

## What changed

- Fixed the false active-plan state caused by the original five-year legacy subscription grant.
- Added an additive Prisma corrective migration: stores without an approved subscription payment no longer receive paid coverage or a Verified Seller badge. Stores with a genuinely approved payment are preserved.
- Made the Verified Seller badge a live paid-subscription signal. When paid coverage expires, the badge no longer renders even if an old database flag remains.
- Redesigned `subscription.html`, `css/subscription.css`, and `js/subscription.js` around a clearer Seller Pass journey:
  - Send → Tell us → Get verified
  - exact amount auto-calculation for 1/3/6/12 months
  - payment-account guidance
  - clearer pending/approved/rejected history
  - mobile-responsive layout
  - stronger trust/disclaimer copy
- Added the compact verified badge to the shared account navigation for sellers on every page that uses the shared account shell, including onboarding.
- Added server-side exact-total validation so a seller cannot submit an amount that does not match the selected coverage period.
- Extended the runtime integration test to cover Seller Pass submission, pending state, admin approval, and persisted verification.
- Added static regression checks for all of the above.

## Production deployment note

The new migration is intentionally additive and comes after the existing subscription/platform-settings migrations. Deploy it with the normal Prisma migration command; do not edit or delete already-applied production migrations.

Keep the existing production `.env` out of source control and preserve the live database connection separately.

## Verification performed on this package

- All JavaScript files pass `node --check`.
- Top-level HTML files parse successfully.
- `npm run qa:static` equivalent: **29/29 checks passed**.
- The integration test was **not run against a live database from this package inspection** because it intentionally resets `TEST_DATABASE_URL`; run it only against a dedicated throwaway PostgreSQL database.


## Commitment badge policy
- Seller star ratings are retired as a seller-trust mechanism.
- A confirmed 6-month commitment earns **Verified Seller**.
- A confirmed 12-month commitment earns **Gold Partner**.
- A confirmed 24-month commitment earns **Platinum Partner**.
- Shorter 1- or 3-month passes can keep a store paid/active but do not earn a seller trust badge.
- Product ratings/reviews remain separate product-feedback features.
