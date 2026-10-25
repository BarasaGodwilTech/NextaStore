# Fraud and payout controls

Design principle: **nobody is paid for activity, only for approved money.** Sign-ups, leads and visits earn nothing. A commission exists only after a real store's real Seller Pass payment has been approved by an admin. Everything else here is layered on top of that.

---

## 1. How an earning becomes withdrawable

```
store pays  ->  admin approves the payment  ->  fraud checks run
                                                   |
              clear ------------------------------+---> HELD  (clearing window: 3 days)  -> AVAILABLE -> withdraw
              review (something odd) ---------------+---> REVIEW (a human releases or voids it)
              block  (hard rule, or score >= 60) ----+---> nothing is paid; referral BLOCKED; flag opened
```

| State | Meaning | Partner sees |
|---|---|---|
| Held | Payment approved, clearing | "Clears in 2 days" |
| Review | Risk engine wants a human | "Being double-checked" (no accusation) |
| Available | Cleared, withdrawable | "Ready to withdraw" |
| Voided | Payment reversed or fraud confirmed | removed from balance |

If a payment is reversed **after** the partner was already paid, the earning is voided and the partner's available balance goes negative. Withdrawals stay closed until new earnings cover it. No special clawback table is needed. Reversals are honoured for 30 days after approval.

---

## 2. Withdrawals

**Promise to partners: paid within 2 working days of the request.** Working days are Monday to Friday in Kampala time, skipping Uganda's public holidays (fixed dates plus Good Friday and Easter Monday are built in; Eid is added by an admin the week it is announced, in Campaigns > Program settings).

| Request made | Counted from | Due by |
|---|---|---|
| Mon 10:00 | Mon | Wed 5:00 pm |
| Mon 16:00 (after the 3:00 pm cut-off) | Tue | Thu 5:00 pm |
| Fri 11:00 | Fri | Tue 5:00 pm |
| Sat any time | Mon | Wed 5:00 pm |
| Thu 8 Oct (Independence Day is Fri 9 Oct) | Thu | Tue 13 Oct 5:00 pm |

The partner sees the exact deadline the moment they ask. Admins see the queue ordered by deadline, with overdue ones in red, and the overview counts overdue payouts.

### Limits

Limits follow **trust**, which is earned by behaviour (not by rank), so a flashy new account cannot cash out big.

| | New | Standard | Trusted |
|---|---|---|---|
| Becomes this when | joining | 14 days and 2 cleared stores | 60 days, 10 cleared stores, quality 75+, no open flags |
| Per withdrawal | UGX 15,000 to 50,000 | 15,000 to 150,000 | 15,000 to 400,000 |
| Per day | 50,000 | 200,000 | 500,000 |
| Per 30 days | 150,000 | 800,000 | 2,500,000 |
| Time between withdrawals | **7 days** | **3 days** | **1 day** |

Always on, for everyone:

* **Minimum withdrawal UGX 15,000.** NextaStore pays the mobile money fee on every payout, so tiny payouts are not worth a fee.
* **One open withdrawal at a time**, enforced by a database index, so two fast taps cannot both pass. The spacing above also saves fees and slows anyone testing the system.
* **NextaStore pays the mobile money fee**: the partner receives every shilling they asked for. The admin records the actual fee on each payout, and the Economics tab shows true cost.
* **First withdrawal** only 7 days after joining **and** after the first store has paid and cleared.
* **Changing the payout number pauses withdrawals for 48 hours** and sends a notification. Stops account-takeover cash-outs.
* A payout number can belong to **one partner account only**.
* A **negative balance** (reversal being worked off) blocks withdrawals.
* **Frozen** accounts cannot withdraw.
* An **open fraud flag** sends the request to "in review" so a person looks first.

### Who can do what (admin permissions)

| Permission | Can |
|---|---|
| `growth.view` | See dashboards, partners, flags, the risk preview on payment review |
| `growth.review` | Approve/decline Crew members, view ID photos, freeze/unfreeze, release/void held earnings, resolve flags |
| `growth.payouts` | Approve, pay and reject withdrawals |
| `growth.settings` | Campaigns, holidays, open/close programs |

Give `growth.payouts` and `growth.review` to different people where you can.

### Separation of duties (the two-person rules)

1. **The admin who approved the Seller Pass payments behind a partner's earnings cannot release that partner's payout**, nor release their held earnings. This blocks an insider approving fake payments for an accomplice and then paying them out.
2. **First withdrawals and any withdrawal of UGX 100,000 or more need two different admins**: one approves, a different one pays.
3. The payer must enter the **mobile money transaction ID**; the same ID cannot be used on two payouts.
4. Every approval, payment, rejection, release, void, freeze and ID-photo view is written to the existing admin audit log.

---

## 3. Threats and what stops them

| Attack | What stops it | Where |
|---|---|---|
| Referring yourself | Own code refused at sign-up and flagged; same account, same email (even Gmail dots and `+tag`), same phone, or paying with your own mobile money blocks the earning and freezes the account | `risk.js`, `hooks.js` |
| Fake store paid for with the partner's own money to farm commission | Commission is 30 to 55% of what was paid, so it only works at a loss; plus the payer-phone check, clearing window and review queue | rules + `risk.js` |
| Reusing one MoMo transaction ID for two stores | Existing app already rejects duplicate references; growth adds a second check across non-rejected payments | `hooks.js` |
| Mass fake sign-ups to look busy | Sign-ups earn nothing; bursts per hour/day, one-network and one-device clusters, disposable emails push conversions into review; low-conversion partners lose quality score | `risk.js` |
| Two Crew members claiming one shop | Lead Lock by phone number with a database-level unique rule; conflicts are flagged with visit evidence | `leads.js`, migration |
| Inventing leads | Leads pay nothing; cap of 40 open leads; leads expire in 14 days | `leads.js` |
| Logging a business that is already a seller | Refused ("already on NextaStore") | `leads.js` |
| Taking over a partner account and cashing out | 48-hour pause after payout number change; limits; admin sees payout name to match | `partners.js`, `commission.js` |
| One person running many partner accounts | One payout number per account; one phone per Crew member approval; shared-number is a hard block | `partners.js`, `admin.js`, `risk.js` |
| Rapid cash-out then disappear | Clearing window, trust-based ceilings, first-withdrawal rules, 30-day cap | `rules.js` |
| Pushing a payment through and keeping it unreversed | Reversal within 30 days voids earnings; high reversal rate lowers quality and auto-freezes at 40% | `hooks.js`, `risk.js` |
| An insider approving payments for a friend | Approval risk preview shows the referral and warnings; approver cannot release that partner's payout or held earnings; two-person rule on big payouts | `withdrawals.js`, `admin.js` |
| Rewards quietly eating NextaStore's margin | Everything paid on a first payment is capped at 40% of what the store paid; extra rewards (bonuses, stay, stocked-store) are paid only when the store comes back; the Economics tab turns amber at 30% and red at 40% | `commission.js`, `admin.js` |
| Backdating an offline lead to beat another Crew member | A lead captured offline keeps its capture time only up to 48 hours back and never in the future; if another Crew member logged the shop first, the loser's capture time is kept as a flag for an admin | `leads.js` |
| Paying a fee on many tiny payouts | Minimum UGX 15,000, spacing of 1 to 7 days by trust, one open withdrawal at a time | `rules.js`, `commission.js` |
| Paying the wrong person | Payout name is stored with the number and shown to the payer; number is masked in the partner's own view | `withdrawals.js` |
| Leaked ID photos | Stored privately (not under public `/uploads`), viewable only with `growth.review`, each view audited | `routes.js`, guide step 6 |
| Double payment from a repeated event | Unique key on (payment, partner, type): approving the same payment twice pays once | schema |
| Bugs here breaking signups or payments | Every hook is wrapped: a failure is logged and the caller carries on | `index.js` |

### Risk score

| Signal | Effect |
|---|---|
| Same account / email / phone as the partner, partner paid from own number, reused transaction ID, payout number shared by accounts | **Block** (hard) |
| Signed up from the partner's own network | +35 |
| Signed up from a network the partner regularly uses | +25 |
| 3+ recruits from one network in a week | +30 |
| Several recruits on one device | +35 |
| 5+ sign-ups in an hour | +30 (or +20 for 12+ a day) |
| Throw-away email | +25 |
| Store paid but has no products | +10 |
| Many sign-ups, almost none pay | +15 |
| High reversal rate | +30 |

**30 or more** holds the earning for review. **60 or more** blocks it. The reasons are saved in plain words and shown to the admin, on the payment-review screen **before** they approve, and again in the Review tab.

### What this does not stop

Honesty about limits: two genuinely different people who collude, with the "recruit" really paying real money from their own mobile account, will pass the checks. The defence there is economic (they lose money on every month-one fake), plus clearing, caps and quality scoring. Watch the Flags tab and the overview numbers for patterns in the first two months, and tighten `rules.js` from real data.

---

## 4. Admin routine

**Daily (10 minutes):**
1. **Payouts tab.** Work oldest deadline first. Open each: check the registered name matches, glance at flags, approve, send the money, then paste the transaction ID **and the mobile money fee you were charged**, and mark paid. Anything red is overdue.
2. **Review tab.** Release or void earnings the engine held. Read the reasons; ask for evidence if a Crew member is involved (visit photos and location are on the lead).
3. **Applications tab.** View the ID, check the phone, approve or decline kindly.
4. **Flags tab.** Dismiss noise, confirm real problems (confirming does not freeze by itself; use Freeze on the partner).

**Weekly (5 minutes): the Economics tab.** Read the cost percentage for the last 30 days. Green is fine; amber (30%) means watch it; red (40%) means act: lower a rate or the upfront cap in `rules.js`. If it says some payouts have estimated fees, enter the real ones.

**When a payment you approved turns out bad:** reverse it (see integration guide), the partner's earning is voided automatically and a flag appears. Decide whether to freeze.

**When the engine blocks an honest partner:** open the partner, read the reasons, unfreeze, and release the earning from Review. Tell us which signal fired so we can tune it.

**Eid and moved holidays:** add the dates under Campaigns > Program settings the week they are announced, so payout deadlines stay honest.

---

## 5. Personal data

* Crew members upload a national ID photo. Store it privately, show it only to `growth.review`, never to other partners, and delete it when a Crew member leaves (keep the approval record).
* Recruiters never see a recruit's email or phone. Crew members see phones only for leads they typed in.
* Visit photos and GPS points are optional, private and used only for disputes and review.
* Uganda's Data Protection and Privacy Act, 2019 applies. The terms draft includes consent wording; have it checked, and decide how long to keep IDs.
