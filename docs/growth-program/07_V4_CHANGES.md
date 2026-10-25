> **Round 5 note:** this document describes round 4, when the field team was still called Scouts. It is now **NextaStore Crew** (see `08_V5_CREW_REBRAND.md`). Where this file says Scouts, read Crew; paths such as `scouts.` / `/scouts` became `crew.` / `/crew`.

# Round 4: branding, subdomains, bug sweep, UI and UX clean-up

You asked for four things: apply the brand kit, put Circle and Scouts on their own subdomains, hunt bugs, and clean up the UI and UX so integration is plug and play. This is what was done, what I decided on your behalf (please check those), and what I could not verify.

## 1. Branding (brand kit v3)
* **Header logo** is the real lockup with its descriptor line: `NextaCircle / Affiliate Program` on circle.html, `NextaScouts / Field Team` on scouts.html (SVG, never below 120 px wide). Footer carries the full mark at 36 px (Circle) and 40 px (Scouts), above the brand minimums.
* **Colourways.** `<body data-program="circle">` is green; `"scout"` is gold on forest. The hero carries the mark and the ring motif from the share images (one ring for Circle, gold rings for Scouts). Colours come from the kit (Ink `#0B3B2B`, Forest `#0F5A41`, Green `#01B075`, Mint, Gold `#FFB038`, Amber `#A96B00`).
* **Favicons, apple-touch icon, theme colour, manifests and link previews** are set per page from the kit. Previews use the kit's 1200x630 images with absolute URLs (the server fills them in, because link-preview crawlers do not run JavaScript).
* **The invite card** (the picture partners post on WhatsApp) now carries the program lockup and colourway, and its headline says "Open your shop on NextaStore" so a stranger knows what it is. Its QR still works offline.
* **Admin** uses the Circle lockup and colourway, as the brand guide says. Each partner row shows its program mark.
* Assets live in `frontend/assets/growth-brand/` (copy to `assets/growth-brand/`). The brand guide is in `docs/brand/`.

## 2. Subdomains
Full setup is in `docs/03_INTEGRATION_GUIDE.md` ("Subdomains"). In short: `GROWTH_MODE=subdomain` plus `GROWTH_ROOT_DOMAIN=yourdomain.com`, DNS + TLS for `circle.` and `scouts.`, and one line in `app.js`: `app.use(growth.hostRouter({ pagesDir }))`. Off by default; with nothing set everything works exactly as before.
* `circle.` and `scouts.` serve their dashboards; anything else on those hosts goes to the same path on the main site; old `/circle`, `/scouts`, `/invite` links on the main site go to the right subdomain.
* Shared links are short: `https://circle.yourdomain.com/i/SCOUT-4HTR9`.
* Each subdomain installs as its **own app** (own name, icon, manifest) and has a small service worker.
* **Signing in across hosts** (the part that would otherwise have broken): the site keeps the token in localStorage, which is private to one address. A safe hand-over from the main site was added (`growth-session.js` + `auth-bridge.html`). It follows sign-out and account switches. It never talks to a host the server did not name. Read section C of the guide.

## 3. Bugs found and fixed
Found by reading every file, then by running the pages in real Chromium on three real host names.

| # | Bug | Fix |
|---|---|---|
| 1 | Notification links were hard-coded `/circle` / `/scouts`; a notification with no link sent a **Scout to the Circle page** | Links are resolved per person and per deployment (subdomain-aware) |
| 2 | The payout-number safety pause error printed a raw timestamp (`...T12:40:00.000Z`) | Reads "Fri 16 Oct, 3:40 pm" in East Africa Time |
| 3 | Adding a **first** payout number paused withdrawals for 48 hours but the API answered "no pause" and said nothing | The response and the page now state the pause in both cases (the pause itself is unchanged: see decisions) |
| 4 | Pages hard-coded numbers the rules own: 48 hours, 14 days, "twice", "a week", "2-working-day", "40%", a UGX 20,000 price fallback | `/rules` returns them all; the pages read them. Change `rules.js` and every page follows |
| 5 | Payment preview could throw if a partner row was missing | Guarded |
| 6 | Every action re-drew the page from a loading skeleton, **jumping to the top** | Soft refresh keeps your place |
| 7 | Coming back online reloaded the whole dashboard, even while typing a lead | Only refreshes when leads were waiting |
| 8 | The whole page was a screen-reader live region, so every action re-read the entire dashboard aloud | One status area for messages only |
| 9 | Native `confirm()` / `prompt()` (ugly, inaccessible, blocked in some in-app browsers) | Proper dialogs: focus moves in and back, Esc closes |
| 10 | Admin "View ID" opened a bare URL in a new tab, which cannot send the sign-in header, so it would have been refused | Fetched with the token and shown in a tab |
| 11 | Relative `css/` and `js/` paths break at `/i/CODE` | Absolute paths |
| 12 | The Scouts page could not open at all with no signal, despite "works offline" | Service worker + an offline view (QR, lead form, queue). The first version of the offline view crashed on missing rules: caught by the new test, fixed |
| 13 | Withdraw looked clickable when it could not work | Disabled with the reason written under it |
| 14 | Admin tab badges stayed visible showing "0" (`hidden` overridden by CSS) | Fixed |
| 15 | Router: a request line such as `//evil.com/x` was parsed as a host | Parsed as a path, always redirected onto your own main host. Caught by the new unit test |
| 16 | Session hand-off: my first loop guard blocked a legitimate second try within 30 seconds | Guard now only trips if the main site hands back something unusable |
| 17 | The offline banner was sticky and could cover the header | Plain banner |
| 18 | Brand green with white text is 2.8:1 contrast (below the 4.5:1 minimum) | Circle buttons are Forest; Scouts buttons are Gold with Ink text (about 7:1); in the green hero the main button is white |
| 19 | Admin: 8 tabs squeezed on a phone; flags showed raw JSON; no red state (alerts used amber); partner areas shown as raw keys | Scrolling tab bar with live counts; readable flag details; red "too high" chip; proper names |
| 20 | Invite page turned gold for Scout codes, against the brand guide ("invite pages use the Circle colourway") | Always Circle colourway; "Dina, a NextaStore Scout, invited you" in words |

## 4. UI and UX clean-up
Shared toolkit (`growth-ui.js`) instead of the same helpers copied into four files; skip link, landmarks, labelled fieldsets, 44 px touch targets, visible focus, reduced-motion support; consistent buttons, chips, cards and empty states; tables become cards on phones; the invite link is shown in words so a Scout can read it aloud; an offline banner; clear loading and error states with a retry; no layout jump after actions; a Withdraw button that explains itself; a partner search in admin; a print stylesheet.

## 5. Decisions I made for you (please confirm or tell me to change)
1. **One invite host.** Every invite link, Circle or Scout, lives on the **Circle** host (`circle.../i/CODE`). It follows the brand guide, and the invitee is joining NextaStore, not the field team. The invite page header shows the **NextaStore** logo (not the Circle lockup) with the Circle colours.
2. **Admin stays on the main site**, not a subdomain.
3. **The first payout number still pauses withdrawals for 48 hours**, now stated openly. If you would rather not pause the first number, it is a one-line change in `partners.js`.
4. **The subdomain pages do not load push or presence scripts** (they are per-origin and would clash with the main site). Members still get push through the main site.
5. **Session hand-over uses a `#fragment` between your own hosts.** Fine for now; the long-term answer is a session cookie on `.yourdomain.com`.
6. **Button colours** changed for contrast (item 18).

## 6. Verified, and not
**Verified:** 99 + 83 + 33 logic checks; 8/8 QR codes decode (and the new short link decodes from both the saved card and the offline QR in the browser test); 58 checks in real Chromium in path mode; **57 checks in real Chromium on three real hosts** (each with its own localStorage): router, redirects, manifests, worker, frame rules, sign-in hand-over, sign-out and account-switch following, invite to signup carrying the code, the parent-domain cookie, the installed Scouts app opening with no signal, QR offline, leads queued and sent, notification links. No JavaScript errors on any page. I looked at the screenshots on phone and desktop sizes.
**Not verified:**
* I did **not have your real `main.js`, `api.js`, `auth.js` or `clean-url.js`**: the browser tests ran against a small bundled stand-in that copies what the pages use (`scripts/lib/stub-site/`). Please run both browser tests with `PROJECT_DIR=.` in your project. The two spots most likely to need a tweak: how your `main.js` redirects when signed out (the host router already catches relative redirects), and the API base the admin ID viewer uses (`/api/admin/growth/...`).
* Real DNS, certificates and proxy headers; Safari and Firefox; a real phone installing the app; whether your login page honours `?next=`.
* Font Awesome icons: the test browser has no internet, so icons did not render in my screenshots (layout is fine; they load from the CDN as before).
* Everything listed as unverified before (real Postgres migration, real MTN/Airtel payout and tariff, ID upload to private storage, your real hooks, the hourly sweep).
