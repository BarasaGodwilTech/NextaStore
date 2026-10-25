# CLEANUP_MANIFEST (WIP 97)

Every candidate with evidence (`grep -rIn` over the whole tree, excluding node_modules and the two history logs) and the decision.

| candidate | evidence | decision |
|---|---|---|
| WIP92_REPORT.md, WIP92C_CHECKPOINT.md, WIP92D_CHECKPOINT.md, WIP93_REPORT.md ... WIP96_REPORT.md | referenced by no code or test; only by each other and by history text in WIP_LOG.md; facts folded into "WIP 92-96 summary" first | REMOVE |
| WIP94_screenshots/ | referenced only by WIP94_REPORT.md | REMOVE |
| ai-assistant/starter-row-*.png | test output written by `scripts/starter-row-test.py`; the script now writes to a temp dir (`STARTER_ROW_SHOTS` to override) | REMOVE |
| ai-assistant/data/lg-misses.jsonl | runtime log with test junk; `src/lang/lgMisses.js` does `mkdirSync(..., {recursive:true})` + `appendFileSync`, so it is created on demand; `data/` already in ai-assistant/.gitignore, root .gitignore now also ignores `ai-assistant/data/*.jsonl` | REMOVE |
| ai-assistant/widget/ (assistant-widget.js/css, demo.html) | no `require`, `<script>` or `<link>` anywhere; the site uses js/assistant.js + css/assistant.css; only README documented it (README updated) | REMOVE |
| ai-assistant/WIP_NEXI_PLAN_v2.md | referenced by one code comment (factsSync.js, edited), the README (edited) and WIP_LOG history | REMOVE |
| scripts/chat-eval.js, loadtest.js, bench.js | documented tools; now `npm run eval:chat`, `loadtest`, `bench`; qa-static guard checks they exist | KEEP |
| scripts/golden/* | tests | KEEP |
| lg-review/NEXI_LUGANDA_REVIEW.csv | until the speaker finishes; checked by wip93-lg-review-test | KEEP |
| nextastore-backend/scripts/browser-flows-py/p.png | e2e fixture | KEEP |
| auth-browser-tests/shims | needed by admin-rbac-test without node_modules | KEEP |
| LOCAL_TEST_ACCOUNTS.md | kept; owner must make sure these accounts do not exist in production | KEEP |
| `LG_PARTIAL_NOTE`, `LG_NO_TRANSLATOR_NOTE` (pipeline.js), `smallTalkTemperature` (config.js) | one occurrence in the whole repo (the definition) | REMOVE (done) |
| `LUGANDA_INTERLEAVE` remnants | only comments/docs saying it is retired, plus the selftest that guards the retirement | KEEP |

Static check used: every top-level identifier and exported name in `ai-assistant/src/**/*.js` counted across the repo; only the four names above had no other reference.

Repo size: 10876 KB before, 10516 KB after (this unpacked tree; the zip is smaller).

Removed files:
- `WIP92_REPORT.md` (4940 bytes)
- `WIP92C_CHECKPOINT.md` (2691 bytes)
- `WIP92D_CHECKPOINT.md` (3051 bytes)
- `WIP93_REPORT.md` (934 bytes)
- `WIP94_REPORT.md` (947 bytes)
- `WIP95_REPORT.md` (2785 bytes)
- `WIP96_REPORT.md` (2830 bytes)
- `ai-assistant/WIP_NEXI_PLAN_v2.md` (12721 bytes)
- `ai-assistant/data/lg-misses.jsonl` (1986 bytes)
- `WIP94_screenshots/hero-header-1280-english-idle.png` (17353 bytes)
- `WIP94_screenshots/hero-header-375-luganda-idle.png` (16002 bytes)
- `WIP94_screenshots/hero-header-320-english-idle.png` (12870 bytes)
- `WIP94_screenshots/hero-header-375-english-idle.png` (15625 bytes)
- `WIP94_screenshots/hero-header-1280-luganda-idle.png` (17903 bytes)
- `WIP94_screenshots/hero-header-320-luganda-idle.png` (13205 bytes)
- `ai-assistant/widget/demo.html` (1261 bytes)
- `ai-assistant/widget/assistant-widget.js` (7104 bytes)
- `ai-assistant/widget/assistant-widget.css` (3855 bytes)
- `ai-assistant/starter-row-hero-desktop.png` (45910 bytes)
- `ai-assistant/starter-row-hero-phone.png` (35439 bytes)
- `ai-assistant/starter-row-panel-desktop.png` (109254 bytes)
- `ai-assistant/starter-row-panel-phone.png` (48852 bytes)
