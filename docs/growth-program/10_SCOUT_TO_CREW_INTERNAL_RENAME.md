# Round 6: the internal word `scout` becomes `crew`

Round 5 renamed what people see. This round renames what is underneath, so the code, database and admin say the same thing as the product.

## What was renamed

| Before | After |
|---|---|
| enum `GrowthProgram`: `circle`, `scout` | `circle`, `crew` (all six columns that use it follow automatically) |
| `GrowthSettings.scoutsOpen` | `GrowthSettings.crewOpen` |
| audit actions `growth.scout_approved / _rejected / _reopened` | `growth.crew_approved / _rejected / _reopened` (existing rows are rewritten) |
| API `/api/growth/scouts/apply`, `/scouts/upgrade`, `/scouts/upgrade/withdraw` | `/api/growth/crew/...` |
| admin API `/api/admin/growth/scouts/:id/approve` (and reject, reopen) | `/api/admin/growth/crew/:id/...` |
| `SCOUT_RANKS`, `maxPerScout`, `applyScout`, `approveScout`, `rejectScout`, `reopenScout`, `requireActiveScout` | `CREW_RANKS`, `maxPerMember`, `applyCrew`, `approveCrew`, `rejectCrew`, `reopenCrew`, `requireActiveCrew` |
| `pendingScoutApplications` (admin overview field) | `pendingCrewApplications` |
| `rules.programs.scout`, `COMMISSION.scout`, `PROGRAM_LABELS.scout` | `.crew` |
| `data-program="scout"`, `data-join="scout"`, CSS `[data-program="scout"]`, `?program=scout` | `crew` |

## Migration `20261104090000_rename_scout_to_crew`

Four statements: `ALTER TYPE "GrowthProgram" RENAME VALUE 'scout' TO 'crew'`, `ALTER TABLE "GrowthSettings" RENAME COLUMN "scoutsOpen" TO "crewOpen"`, an `UPDATE` of `AdminAuditLog.action`, and an `UPDATE` of `GrowthPartner.code` (`SCOUT-` becomes `CREW-`). It was run on PostgreSQL 16 after the whole earlier migration chain, with old-style rows in every affected table; all rows came across and nothing still read `scout`. The original `growth_program` migration is untouched (Prisma checksums applied migrations).

**Deploy the code and the migration together.** Old code cannot read the renamed enum and new code cannot read the old one. Take a backup first. `npx prisma generate` is needed after pulling (it could not be run where this was built).

## Removed (nothing of the old name is kept)

Nothing was live, so no compatibility layer was kept. These all went:

* `SCOUT-XXXXX` codes are no longer recognised anywhere (typing, scanning, links). The migration converts any stored `SCOUT-` partner code to `CREW-`, so existing development data keeps working. Printed QR codes or shared links that carry a `SCOUT-` code would stop matching.
* `/scouts` and `/scouts.html` no longer redirect, and `scouts` is no longer a reserved store name.
* `SCOUTS_ORIGIN` and a `scouts` host setting are no longer read: set `CREW_ORIGIN`, or nothing (it defaults to `crew.<root domain>`).
* `scout` / `scouts` are no longer accepted as spellings of the Crew program key, and the code that converted a `scout` value saved in a browser is gone. A browser still holding one simply starts fresh.
* The API paths have no `/scouts/` aliases. A browser still running pre-rename scripts gets 404s on apply and upgrade until it reloads; the service-worker cache is bumped for that reason (v111).

`growth-hosts-test.js` fails if the word `scout` appears anywhere in shipped code (html, js, css, schema). Only the two migrations, this document and the older history documents still mention it, because they describe the rename.

## Test changes

Tests that existed only to prove old names still worked were removed (`/scouts` redirects, `SCOUTS_ORIGIN`, `SCOUT-` codes); the invite and QR tests now use `CREW-` codes. Several tests had already fallen behind the standalone `crew-apply` page and the restructured admin console (they drove the old in-page form, old tab names, and a few old expectations). They were brought up to date; the application form itself is covered by `crew-apply-browser-test.py`.

## Nexi (the assistant): the Circle and Crew FAQ

Nexi had no Circle or Crew knowledge at all (the files earlier docs told you to copy in were never part of the project). Round 6 adds it as **27 `growth_*` entries in `ai-assistant/src/knowledge/faq-instant.json`**, written from what the program really does (the About pages, `rules.js`, the upgrade design). They cover what Circle and Crew are and how they differ, joining and applying, how rewards are earned and paid, why a reward may be missing, invite codes and who gets credit, fake referrals, Lead Lock, offline use, ranks, the Crew ID card, ID privacy, moving up from Circle, payout details and frozen accounts.

* **No amounts, rates, percentages, holding times or limits** appear in any answer (the FAQ check enforces "no digits"). They point to `/about-circle` and `/about-crew`, which use the live program rules.
* All entries are `direct: false`: the answer is given to the model as the authoritative text and the model words the reply, instead of being sent verbatim.
* **Why FAQ and not a knowledge `.md` file.** A knowledge file was tried first. Adding many new sections to the retrieval index nudged corpus-wide statistics enough to flip 2 of the 36 borderline "answerable" questions into deflections, which fails the project's own gates (`wip100`, `wip101`: false deflection at most 5%). The FAQ index is separate and leaves those gates exactly at baseline.
* **Two project checks were adjusted on purpose:** the self-test's FAQ size bound went from 40-60 to 40-90 (it is a sanity check, not a design limit), and three out-of-scope golden questions that are now answerable (affiliate, referral program for sellers, bonus for bringing a friend) were removed from `oos-25.json` and `oos-25b.json`.
* **Snapshot reviewed and regenerated:** adding FAQ entries raises every FAQ match score slightly, which moved 4 borderline English answers (reviewed in `en-change-reviews.json`: 3 are equal or better; "why has my Seller Pass payment not been approved" is a known content gap, see `OPEN_ITEMS.md`).
* `lg-review/NEXI_LUGANDA_REVIEW.csv` was regenerated: the 27 new rows are marked `missing` until a Luganda speaker reviews them, like every existing FAQ row.
