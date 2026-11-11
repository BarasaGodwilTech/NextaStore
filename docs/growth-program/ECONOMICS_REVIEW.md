# Circle and Crew: is the money worth it? (WIP 113 review)

**Short answer.** On the rules as built, yes, with a wide safety margin, *provided what it costs you to serve a store is below about UGX 11,000 a month.* Rewards are paid out of money the store has already paid, are capped, and are one-time. They cannot run away from revenue. What this review cannot know is your own costs, so those are inputs in the admin screen (Money, then Economics) and the verdict says so until you fill them in.

All figures come from `src/growth/rules.js` and the shared model `js/growth-economics.js`, which `scripts/growth-economics-test.js` checks against the server's real commission code for 100 scenarios. Seller Pass is UGX 20,000 a month.

## What each store costs, and what NextaStore keeps

| One store | Circle | Crew Trailhead | Crew Pathfinder | Crew Trailblazer | Crew Summit |
|---|---|---|---|---|---|
| Pays 1 month, never returns: reward | 4,000 (20%) | 5,000 (25%) | 6,000 (30%) | 7,000 (35%) | 8,000 (40%) |
| Pays 1 month, renews on time, stays 3 more: reward | 7,000 of 100,000 (7%) | 11,000 (11%) | 12,000 (12%) | 13,000 (13%) | 14,000 (14%) |
| Pays 6 months up front: reward | 7,000 of 120,000 (5.8%) | 10,000 (8.3%) | 11,000 (9.2%) | 12,000 (10%) | 13,000 (10.8%) |
| Pays 12 months up front: reward | 7,000 of 240,000 (2.9%) | 10,000 (4.2%) | 11,000 (4.6%) | 12,000 (5%) | 13,000 (5.4%) |

The reward is one-time. The store's payments are not. So the longer a store stays, the better NextaStore's side of the deal gets, and the only expensive case is a store that pays once and never returns.

## Why it cannot run away

1. Nothing is paid before the store's payment is approved.
2. Total upfront reward is capped at 40% of the first payment, whatever the rank or bonuses.
3. Rewards clear for 3 days before they can be withdrawn; a payment reversed within 30 days claws the reward back (it can leave a negative balance that later earnings absorb).
4. A new account has small limits that grow with proven stores; payouts above a size need a second admin; a flagged account sends every payout to review.
5. Nothing is paid on a recruit's recruits (no pyramid), and a store cannot be credited to its own owner.
6. The cost guard in the admin screen turns amber at 30% and red at 40% of referred revenue.

## The model, on assumptions you should replace

Default month: 40 new paying stores, half through Crew (60% Trailhead, 40% spread above), 10% prepaying 6 months, 60% renewing and staying 3 more months, 3% of first payments reversed (half of that reward unrecoverable), payout fees from the planning estimate.

| | UGX a month |
|---|---|
| Seller Pass revenue | 3,026,000 |
| Rewards | 306,000 |
| Payout fees | 8,000 |
| Lost to reversals | 3,000 |
| **Rewards + fees ÷ revenue** | **10.5%** |
| Reward + fee per paid store | 7,800 |
| Left per store before serving and running costs | 67,700 |
| Most one store-month can cost to serve before the program loses money | 17,900 |

Sensitivity of what is left per store (after serving cost), in UGX:

| Renew on time → | 20% | 40% | 60% | 80% |
|---|---|---|---|---|
| Serving cost 0 | 38,400 | 53,100 | 67,700 | 82,400 |
| 5,000 a month | 27,300 | 38,000 | 48,800 | 59,600 |
| 10,000 a month | 16,100 | 23,000 | 29,900 | 36,800 |
| 15,000 a month | 4,900 | 8,000 | 11,000 | 14,000 |

A deliberately bad month (20% renew, 10% reversed, UGX 10,000 serving cost, UGX 600,000 a month to run the program) loses about UGX 10,000 and needs 41 paying stores a month to cover the running cost. That is the shape of the risk: **fixed running costs and serving costs, not rewards.**

## How it compares

Public SaaS affiliate benchmarks put typical commissions at 20-30% *recurring* for up to 12 months, and advise keeping total partner payout at roughly 30-40% of customer lifetime value (sources: Icodrip's SaaS guide, Track360's 2026 benchmark, PromoteKit, Rewardful). NextaStore pays a one-time 20-40% of the first month plus small flat bonuses, which lands at about 3-14% of lifetime revenue in the table above. That is the conservative end. It also means there is room, if retention proves strong, to add a small recurring share later to keep partners engaged. Do not do that before you have real renewal data.

## What I could not verify, and what to do about it

- **Serving cost per store and running cost of the program.** Unknown. Enter them in Economics. If a store costs more than about UGX 11,000 a month to serve, a one-month Crew Summit store loses money.
- **Free-trial stores** cost to serve and bring in nothing. Rewards are never paid for them, so reward cost is safe, but the model does not charge their serving cost. Include it in the serving-cost estimate.
- **Mobile money fees** are a planning estimate. Record the real fee on every payout you mark paid; Economics then uses reality.
- **Renewal and reversal rates** are assumptions until about 20 stores have had time to renew. The screen shows "from your data" once it has enough, and "assumption" before.
- **Fraud behaviour** is untested against real people. The new Duplicate scan (Risk) and the audit trail exist to find it; run the scan weekly at first.

## Recommended way to open it

1. Open **Circle first**, Crew by approval in small batches (the settings switch exists; approve a few a week).
2. Record real payout fees from the first payout.
3. After 30 days read Economics: cost %, reversal rate, time to first payment.
4. After about 20 stores have had time to renew, replace every assumption with your own data and decide whether the rewards should go up, down or stay.
