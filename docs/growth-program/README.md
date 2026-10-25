# growth-program

Everything for **NextaStore Circle** (the affiliate program) and **NextaStore Crew** (the field team), in one folder. The two names are kept; each is shown with its descriptor ("Affiliate Program", "Field Team") in logos, page titles, kickers and link previews.
**Nothing here is wired into NextaStore yet.** Connecting it is a short, ordered job: see `docs/03_INTEGRATION_GUIDE.md`.
**Round 5 (this version):** brand kit v5 applied. The field team is now **NextaStore Crew** (it was Nexta Scouts) and Circle is **NextaStore Circle**: new names, logos, colours, `crew.` subdomain, `CREW-` codes (old `SCOUT-` codes still work). Start with `docs/08_V5_CREW_REBRAND.md`.
**Round 4:** the brand kit v3 was applied, Circle and Crew can live on their own subdomains, and a bug sweep plus UI and UX clean-up was done: `docs/07_V4_CHANGES.md`.

## In one paragraph

**NextaStore Circle**: any verified user gets a code, a link, an invite picture with a QR, and a recruit tracker. When a store they invited pays for the Seller Pass and an admin approves it, they earn **20% of that store's first month** (UGX 4,000), plus a bonus for 6-month commitments and a stay bonus when the store renews.
**NextaStore Crew**: a vetted field team with ranks (Trailhead, Pathfinder, Trailblazer, Summit), **25% to 40%** of the first month, a Lead Lock so two Crew members never chase one shop, leads that work **with no signal**, a QR that works **offline**, a Trail Map, Market Days with a leaderboard, and a pitch kit.
**Money safety**: paid only for approved money, never for sign-ups or leads. Rewards on a first payment can **never exceed 40%** of what the store paid. Earnings clear for 3 days. **NextaStore pays the mobile money fee.** Minimum withdrawal UGX 15,000, paid within 2 working days, spaced 1 to 7 days by trust. First and large payouts need two admins. The admin sees fraud warnings before approving a payment. An **Economics tab** shows whether the program is worth it, in real numbers.

## Naming update (round 3)

Names kept: **NextaStore Circle** and **NextaStore Crew**. Each now carries a plain descriptor so people know what it is at a glance: **Affiliate Program** under Circle, **Field Team** under Crew. Done in the logo files, link previews, page titles and headers, the assistant's answers and the docs. The product copy reads it from one field, `descriptor` in `PROGRAM_LABELS` (`rules.js`). See `BRAND-GUIDE.md` in the brand kit for the wording rules.

## What changed in round 2

| You asked | What was done |
|---|---|
| Add the strategies for reaching clients and confirm they function | 11 strategies built and verified in a **real browser** (see `docs/06_STRATEGY_VERIFICATION.md`): invite page, invite card, offline QR, share studio and pitch kit, earnings estimator, Lead Lock, **offline leads**, Trail Map, **Market Days with leaderboard**, follow-up radar, seller-dashboard widget |
| Make sure the percentages are worth it, not too much, and good for us too | Rates lowered (Circle 30% to 20%; Crew 40-55% to 25-40%), a **40% margin guard**, more reward moved to **after the store renews**, and an admin **Economics tab** (amber at 30%, red at 40%). Worst case fell from **70%** to **40%** of a month-one payment |
| Inviter earns commission for now | Confirmed and kept. Seller Pass credit and a new-store discount are parked |
| Mobile money fees are on us | Done: partners receive the full amount; minimum raised to UGX 15,000 and withdrawals spaced to keep fees down; admin records the **real fee** per payout; fee estimate is clearly marked as an estimate |
| Improve more for better impact | Offline leads and offline QR, Market Day leaderboard, cost guard, margin guard, stay-based rewards, invite page, share studio, earnings estimator; and bugs found by looking at the real screens, now fixed |

## What is in the folder

```
growth-program/
  README.md
  docs/
    01_PROGRAM_DESIGN.md              names, earnings, cost tables, strategies, recruiter tracking, open decisions
    02_FRAUD_AND_PAYOUT_CONTROLS.md   threats vs controls, money states, limits, two-person rules, admin routine
    03_INTEGRATION_GUIDE.md           every change to make later, file by file, plus rollout plan
    04_FIELD_PLAYBOOK.md              the Crew pitch kit, tools, how earnings and payouts work
    05_PARTNER_TERMS_DRAFT.md         draft terms (needs a lawyer)
    06_STRATEGY_VERIFICATION.md       each strategy and rule, and how it was confirmed; bugs found and fixed
    07_V4_CHANGES.md                  round 4: branding, subdomains, bugs fixed, decisions to confirm, what is not verified
    08_V5_CREW_REBRAND.md             round 5: brand kit v5, Scouts becomes Crew, what changed and what stayed
    brand/                            the brand guide and sheet
    screens/                          screenshots from the browser test
  backend/
    prisma/growth.schema.prisma.txt   models to paste into schema.prisma (no existing model is edited)
    prisma/migrations/20261010090000_growth_program/migration.sql
    src/growth/
      rules.js          ALL numbers and rules in one dependency-free file
      workingDays.js    the 2-working-day payout clock (EAT, weekends, Uganda holidays)
      commission.js     codes, ranks, rewards, margin guard, balances, trust, withdrawal checks, fee estimate
      risk.js           fraud signal engine: clear / review / block, with plain-words reasons
      stages.js         what recruiters see per recruit: status, reason, next step, "needs you"
      hosts.js subdomains.js   where Circle, Crew and the main site live; the host router (subdomains)
      context.js partners.js hooks.js leads.js withdrawals.js admin.js   the services
      routes.js index.js   Express routes and the one-call factory: createGrowth({...})
    scripts/
      growth-test.js            100 checks on the pure logic
      growth-flow-test.js       83 checks driving the real services through whole stories
      growth-hosts-test.js      44 checks: subdomain logic, redirect safety, CORS, brand-file guards, server/browser agreement
      growth-qr-test.py         decodes the offline QR codes with OpenCV
      growth-browser-test.js    58 checks in real Chromium (path mode)
      growth-subdomain-browser-test.js   64 checks in real Chromium on three real hosts
      growth-economics.js       prints what the program costs, from rules.js
      lib/                      in-memory database stand-in, fake Express, shared test server, stand-in main site
  frontend/
    circle.html crew.html invite.html admin-growth.html auth-bridge.html
    css/growth.css
    js/  growth.js growth-ui.js growth-hosts.js growth-config.js growth-session.js growth-sw.js growth-qr.js growth-kit.js
         growth-ref.js invite.js growth-invite-widget.js admin-growth.js
    assets/growth-brand/   logos, favicons, share images from brand kit v3
  assistant/
    12-earn-with-nexta.md  growth-faq.json     knowledge for Nexi (no hard-coded amounts)
```

## Try it

```
node backend/scripts/growth-economics.js          # change a rate in rules.js, run this, see the cost
node backend/scripts/growth-test.js
node backend/scripts/growth-flow-test.js
python3 backend/scripts/growth-qr-test.py         # needs: pip install opencv-python numpy
node backend/scripts/growth-hosts-test.js
PROJECT_DIR=/path/to/NextaStore NODE_PATH=$(npm root -g) node backend/scripts/growth-browser-test.js
NODE_PATH=$(npm root -g) node backend/scripts/growth-subdomain-browser-test.js
```

## Verified vs not

**Verified (357 checks across 6 suites, round 5):** the rules, margin guard, working-day clock, limits, trust and fraud signals; the real services end to end; 8 of 8 QR codes decode; the pages in a real browser as a Circle member, a Crew member (offline included) and two admins, with no JavaScript errors.
**Not verified (needs your environment):** the migration on real Postgres and Prisma-specific behaviour; a real MTN/Airtel payout and the real fee tariff; ID-photo upload into private storage; the hooks inside your actual routes; the hourly sweep. Details in `docs/06_STRATEGY_VERIFICATION.md`.

## Decisions still open

1. **Replace the fee estimate** in `rules.js` (`PAYOUT_FEE`) with the real MTN/Airtel tariff. It is my planning estimate.
2. **Watch the Economics tab for two months**, then tune the rates.
3. **Where do ID photos live?** Private storage, not the public `/uploads` folder.
4. **Terms and tax:** the draft needs a Ugandan lawyer and an accountant.
5. **Local-language pitch cards** need a native speaker.
