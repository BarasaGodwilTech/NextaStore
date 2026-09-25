# Python/Playwright browser flows (WIP 16 batch 8-9)

Needs `pip install playwright` + a Chromium, and the repo root served statically on :8123
(`cd <repo root> && python3 -m http.server 8123`). The API on :4000 is stubbed inside the scripts,
so no backend or database is needed — which also means none of this proves the real routes.

- `launch-flow-e2e.py` — index "Get Started" -> seller signup (terms not bypassable) -> onboarding
  step 4 -> product form (`?from=onboarding`) -> back -> Launch -> dashboard "you're live" banner ->
  Settings link. Run from this folder (uses `p.png`). Expects 18 PASS.
- `stale-launch-guard.py` — an old tab launching after the last product was removed: the stubbed
  server refuses, onboarding stays put and re-shows "Add your first product". Run from this folder
  after copying `launch-flow-e2e.py` to `e2e.py` (it reuses that file's stub).
- `map-modal-layout.py` — the shared map picker modal at 8 viewports (320px phones to 1440px), using
  `leaflet-stub.js` (a layout-only stand-in; real Leaflet needs the network). Copy `map-harness.html`
  and `leaflet-stub.js` to the repo root as `harness.html` / `leaflet-stub.js` first, and delete them
  afterwards. Checks fit, no sideways scroll, button sizes, and that a dropped pin is never hidden.
