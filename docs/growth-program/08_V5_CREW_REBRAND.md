# Round 5: brand kit v5, "Scouts" becomes "Crew"

You sent brand kit v5. It is more than new artwork: the kit **renames** the programs. "Nexta Circle" is now **NextaStore Circle** and "Nexta Scouts" is now **NextaStore Crew**, with new marks (Circle gets a "+", Crew gets two rings and two branches), longer lockups, new minimum sizes and new file names. This round applies all of that, everywhere a person sees it.

## What changed
**Names.** Every page, title, link preview, manifest, notification, error message, FAQ answer and document says **NextaStore Circle** / **NextaStore Crew** (short: Circle / Crew). A person in the Crew is a **Crew member**. The descriptors stay: Affiliate Program, Field Team. One place owns the names (`PROGRAM_LABELS` in `rules.js`), so the pages follow it.

**Assets.** The whole `assets/growth-brand/` folder is the v5 kit (about 1.6 MB). Nothing from v3 is left, and `growth-hosts-test.js` fails if any page or script names a brand file that is missing or still points at an old Scouts file.

**Addresses (these are public, so they changed with the name).**
| Was | Now |
|---|---|
| `scouts.yourdomain.com` | `crew.yourdomain.com` (env `CREW_ORIGIN`) |
| `/scouts` page, `scouts.html` | `/crew`, `crew.html` |
| codes `SCOUT-4HTR9` | codes `CREW-4HTR9` |
The old `/scouts` address and `SCOUT-` codes were removed in round 6 (nothing was live, so nothing needed to keep working); the migration converts any stored `SCOUT-` code to `CREW-`. See `10_SCOUT_TO_CREW_INTERNAL_RENAME.md`.

**Brand rules from the guide, now enforced.**
* Header lockup at least **160px wide** (the new full-name lockups are longer): 172px on desktop, 165px on phones.
* Full mark at least **48px**: footers went from 36/40px to 48px. Where a mark has to be small (the little program icon in the admin tables) the simplified favicon mark is used, as the guide says.
* Always the lockup with its descriptor; full names in headings; Circle colourway on the invite page, the Circle home and admin; Crew only on the field-team page.
* The invite card (the picture partners post) carries the v5 white lockups: Circle with the "+", Crew with the two rings and branches.
* Per-program favicons, app icons (192, 512, maskable), apple-touch icon, and 1200x630 previews come from the kit's `favicon/crew/` and `social/crew-og-1200x630.png`.

## What did NOT change, on purpose
**Update (round 6):** the internal word `scout` was later renamed too; see `10_SCOUT_TO_CREW_INTERNAL_RENAME.md`. What this paragraph said was kept internal (database values, API paths, `SCOUT_RANKS`, `scoutsOpen`, `data-program`) is now `crew` everywhere.

## Decisions I made (please check)
1. **The subdomain is `crew.`**, not `scouts.`, and the codes are `CREW-`. Both are visible to the public, and a "NextaStore Crew" card showing `scouts.` or `SCOUT-` would look unfinished. Nothing was live, so it was the right moment.
2. **~~Old codes and old addresses keep working~~ (reversed in round 6):** nothing was live, so the old `SCOUT-` codes and the `/scouts` address were removed instead of carried along.
3. **Nexi (the assistant)** answers about Circle and Crew from its FAQ (`growth_*` entries, added in round 6). They only use the new names.
4. The rank names (Trailhead, Pathfinder, Trailblazer, Summit) and "Trail map" stay: they are not in the brand kit's rename.

## Bug found while doing this
The "Your link:" label on the dashboard broke mid-word on phones ("Your lin / k:") once the link got longer. Fixed.

## Verified, and not
**Verified:** 100 + 83 + 44 logic checks, 8/8 QR codes; 58 checks in real Chromium in path mode and **64 on three real hosts** (`nextastore.localhost`, `circle.`, `crew.`), including: the Crew manifest and its three icons are real PNGs served on the Crew host, sizes meet the 160/48px minimums on a phone and a desktop, the installed Crew app still opens with no signal. I looked at the screenshots (phone and desktop, both programs, invite page, invite card).
**Not verified:** the same list as round 4 (your real `main.js` and login, real DNS/certificates, Safari/Firefox, a real phone, Font Awesome icons in screenshots, the live-environment items). New: the **N in the kit is traced from the PNG app icon**, not the original vector (the guide's open item 1), so if you have the vector, send it and the files can be swapped.
