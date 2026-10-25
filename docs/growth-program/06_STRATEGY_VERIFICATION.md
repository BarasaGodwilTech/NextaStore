# Do the strategies actually work? Verification report

Every strategy for reaching clients, what it does, and **how it was confirmed**. "Browser" means a real headless Chromium running **your real site files** (`js/main.js` and the rest) against the real growth backend; "Flow" means the real service code on an in-memory database; "Unit" means the pure logic.

Totals at the time of writing: **97 unit + 83 flow + 8 QR + 55 browser = 243 checks, all passing.** Re-run them any time (commands at the bottom).

| # | Strategy | What was confirmed | Where |
|---|---|---|---|
| 1 | **Invite page** | Shows who invited you by **first name only** (no surname, no phone); the sign-up button carries the code; the code is remembered in the browser for 30 days; price and trial length come from the server; a wrong code still gives a friendly plain page | Browser |
| 2 | **Invite card (picture)** | Renders; its layout has **no overlaps and stays inside the picture** (found and fixed a real overlap by looking at it); "Save as picture" downloads a **real PNG**; the **QR inside the downloaded PNG scans to the invite link** | Browser (+ OpenCV decode) |
| 3 | **Offline QR** | Generated on the phone with no internet and no external library. **8 of 8 QR codes decode exactly** with OpenCV across versions 1 to 10 and plain/accented text; the on-screen Crew member QR was screenshotted and decoded in the browser; refuses text over 213 bytes | QR test, Browser |
| 4 | **Share studio messages + pitch kit** | Messages carry the partner's code and link; pitch, demo and six objection answers render for Crew members; copy and WhatsApp buttons present | Browser |
| 5 | **Earnings estimator** | Moving the slider to 5 stores shows UGX 20,000 (one month) and UGX 35,000 (with renewals); numbers come from the server rules, not the page | Browser |
| 6 | **Lead Lock** | A second Crew member cannot take a locked lead and is not told who has it; the same Crew member cannot log it twice; own number refused; a follow-up visit extends the claim; if the owner signs up **without a code** the lead holder gets the credit and the lead row is upgraded, not duplicated | Flow |
| 7 | **Offline leads** | In a real browser with the network switched off: the lead is **saved on the phone**, the Crew member is told, **nothing reaches the server**; when the network returns it is **sent automatically** and the queue empties. Server side: keeps its capture time (up to 48 hours), the 14-day claim counts from capture, **older than 48h or future times are ignored** (no backdating), and an earlier capture that lost a race leaves a **dispute flag** for an admin | Browser, Flow |
| 8 | **Trail Map** | Crew member's own areas first, thinnest marketplace first (mukono 1 store, wakiso 2, kampala many), with the Crew member's own leads and paid stores per district; Circle members are refused | Flow, Browser |
| 9 | **Market Days** | Admin creates campaigns (a boost over 50% is refused); the boost is added to a store that **pays while it is live**; a Crew member sees the live campaign and next week's but **not** a Circle-only one or one 12 days away; the board counts paid stores, ranks by first name only, and **never mixes Circle members into a Crew member board**; shown in the browser with its "+20% boost" badge | Flow, Browser |
| 10 | **Follow-up Radar** | A recruit whose payment waited 30 hours floats to the top and is marked as needing help, with the right reason; the banner counts them; **Ask us to check** lands in the existing admin follow-ups and cannot be spammed; the daily digest is sent **once**, not on every run | Flow, Browser |
| 11 | **Seller-dashboard widget** | Non-member sees "Get my invite code"; a member sees her code, what she can withdraw and share buttons. (Found and fixed a real bug: it looked for `window.app`, but your `main.js` declares `app` with `const`, so it would have silently stayed hidden.) | Browser |
| 12 | **Ranks and quality** | Five paid stores in 90 days promotes a Crew member to Pathfinder, a notification is sent, and the **next** store pays the new 30% rate; a promotion is blocked while quality is under 60 | Flow, Unit |

## The money rules, confirmed

| Rule | Confirmed |
|---|---|
| Circle 20% of month one (UGX 4,000); 6-month first payment adds the 3,000 kicker | Flow, Unit |
| Crew member Trailhead 25% (5,000); with a 20% boost +1,000; Pathfinder 30% (6,000) | Flow, Browser |
| **Margin guard: rewards on a first payment never exceed 40% of what the store paid**, for **every** rank, payment length (1 to 12 months) and boost (0 to 50%) combination | Unit |
| Stay bonus on the first on-time renewal (Circle 3,000; Crew member 4,000) **once only**; Crew members get +2,000 stocked-store bonus when 3+ products remain, not when the shelf is empty | Flow, Unit |
| Same approval twice never pays twice | Flow |
| Clearing 3 days; withdrawals need a payout number, respect the 48-hour lock after a change, the UGX 15,000 minimum, one open request, and the spacing by trust (7 / 3 / 1 days) | Flow, Unit, Browser |
| First payout needs two different admins; the admin who approved the payments cannot release the payout | Flow, Browser |
| **NextaStore pays the mobile money fee**: the partner sees she receives the full amount; the admin enters the real fee; negative or fractional fees refused; the Economics tab uses the **real** fee over the estimate | Flow, Browser |
| Economics: revenue, rewards, fees, cost ratio and green/amber/red status, split Circle vs Crew members | Flow, Browser |
| Fraud: own code refused; Gmail-style alias of yourself blocked; the same MoMo transaction on two stores blocked; reversal voids the earning | Flow |

## Bugs the testing found (and fixed)

| Found by | Bug |
|---|---|
| Looking at the card | The code box overlapped the web address at the bottom of the invite card |
| Looking at the dashboard | Heading and text in the green header were **dark on dark** (your global heading style overrides inheritance); now light, with an automatic contrast check on four pages |
| Real browser | Widget checked `window.app`, which does not exist (`const app`); would have hidden itself in production |
| Looking at the phone layout | The top menu stacked into a tall column; now a tidy row, and no longer sticky on phones |
| Looking at the design numbers | At the first rates the 40% cap silently removed the live bonus from every Crew member above Trailhead, making ranks look identical; the bonus now pays at renewal, when it also costs us less risk |
| Economics screen | "Too high: act now" with "n/a" was confusing when rewards exist but no revenue is counted; now says "Check: rewards but no revenue counted" |

## What is NOT confirmed (needs your environment)

* The migration on **real Postgres**, and Prisma-specific behaviour (the partial unique indexes, real transactions, JSON columns). The tests use an in-memory stand-in.
* A **real MTN/Airtel payout**, and the real fee tariff (the fee table is my planning estimate).
* The **ID-photo upload** into private storage (the test uses a stub that returns a private key).
* **WhatsApp sharing**: the wa.me links and the picture download work, but `navigator.share` with files depends on the phone, so it falls back to download.
* The hourly sweep running on your server, and the hooks inside your actual routes.
* Icons: the test blocks the internet, so Font Awesome icons are missing from the screenshots; on your site they load as usual.

## Re-run everything

```
node   backend/scripts/growth-test.js            # 97 unit checks
node   backend/scripts/growth-flow-test.js       # 83 flow checks
python3 backend/scripts/growth-qr-test.py        # 8 QR codes decoded with OpenCV
node   backend/scripts/growth-economics.js       # what the program costs, from rules.js
PROJECT_DIR=/path/to/NextaStore NODE_PATH=$(npm root -g) node backend/scripts/growth-browser-test.js   # 55 browser checks
```

## Screens

Taken by the browser test on a phone-sized screen (icons missing because the test has no internet).

| | |
|---|---|
| `screens/invite-card.png` | The shareable invite card (QR scans to the short invite link) |
| `screens/invite-desktop.png` | What a shop owner sees from a shared link |
| `screens/circle-dashboard-desktop.png` | A Circle member's dashboard and the Share studio |
| `screens/crew-dashboard-desktop.png` | A Crew member's dashboard: money, rank, Market Days, leads, Trail Map |
| `screens/crew-offline.png` | A lead saved on the phone with no signal |
| `screens/admin-economics-mobile.png` | The admin Economics tab |
