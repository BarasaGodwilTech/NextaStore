# Circle to Crew upgrade

A Circle member can ask to move up to the Crew. This page is the rule book. Money is involved, so the rules are written down in full.

## The shape of it

- **One person, one program, one account.** An upgrade moves the *same* `GrowthPartner` row from Circle to Crew. Balance, payout number, withdrawals, history and trust level carry over. There is never a second partner row.
- **Circle keeps working until an admin approves.** Applying changes nothing about the Circle membership. A declined or withdrawn request changes nothing either.
- **Only an admin can approve** (same permission as approving a Crew applicant), after checking the ID photo and the signals on the queue card.

## Links and codes: nothing breaks

On approval the member gets a **new Crew code** (`CREW-XXXXX`). The old Circle code is kept in `GrowthPartner.previousCodes` and **keeps working forever**:

- every place a code is turned into a person goes through `partners.findByCode(code)`, which checks the current code and then `previousCodes`;
- a code that was ever used is never issued to anyone else (`uniqueCode` checks both);
- the old Circle link, QR code, WhatsApp message or typed code still lands on the same person. Nobody has to be told, and nobody sees a redirect or an error;
- someone who bookmarked the Circle dashboard is taken on to Crew **quietly** (no "wrong program" message) because `partner.upgradedFrom === 'circle'`.

## The money rule

> **A referral is paid under the program its partner was in on the day that person signed up.**

`GrowthReferral.program` is written once, at sign-up (`hooks.onSignup`, and `leads.logLead` for Crew leads), and is never recomputed. Everything that prices a referral reads it through `commission.referralProgram(referral, partner)`:

| Thing | Uses |
|---|---|
| First-payment commission | the referral's program |
| Renewal / stay / stocked bonuses | the referral's program |
| Campaign boosts | the referral's program |
| Crew rank | the partner's rank, applied only to referrals whose program is Crew |
| Crew rank progress (`cleared90d`) | only stores paid under Crew rules |
| Admin economics and segments | the referral's program (so Circle-era stores stay in the Circle column) |

What that means in practice, for a member who is approved on day 0:

- stores that signed up through the Circle link **before** day 0 stay on Circle terms for life, **even if they pay after day 0**;
- stores that sign up **on or after** day 0 through **either** the old or the new link are Crew, from the first payment;
- stores already earned, clearing or promised are never re-priced, in either direction.

The migration backfills `GrowthReferral.program` from the partner's current program. That is exactly right today because nobody has ever changed program. **Run it on a copy of the real database first.**

*Decision to confirm:* the program is fixed at **sign-up time**, not at the time of the link click. Someone who clicked a Circle link before the approval and signed up after it is counted as Crew. The alternative (click time) would need the click's program stored in the visitor's browser; ask if you want it.

## Applying, declining, asking again

- Eligibility: Circle member, `status = active` (not frozen), email verified, Crew applications open, no request already waiting.
- The request needs the same things as a direct Crew application: phone, 1 to 3 areas, ID photo, the Crew terms.
- The database allows **one open request per member** (partial unique index `GrowthUpgrade_one_open_per_partner`), so a double tap or two tabs cannot create two.
- Declined: the member sees the reason and can ask again after `R.UPGRADE.reapplyAfterDays` (14). An admin can **reopen** a declined or withdrawn request sooner.
- The member can **withdraw** a waiting request.

## Approval checks (all must pass, all re-checked inside the transaction)

Request still waiting; member still in Circle and `active`; account not suspended and email verified; an ID photo on file; no other partner uses the same phone. Two admins pressing Approve together: the request is claimed with a conditional update, so exactly one succeeds.

## Where it lives

`src/growth/upgrades.js` (admin side), `partners.applyUpgrade / withdrawUpgrade / upgradeState / findByCode`, `hooks.js`, `routes.js` (`/crew/upgrade`, `/crew/upgrade/withdraw`, admin `/upgrades...`), `js/growth.js` (member screens), `js/admin-growth.js` (queue). Tests: `scripts/growth-upgrade-test.js` (66 checks).
