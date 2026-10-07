# Nexi WIP 62 checkpoint log

## WIP 62 / T1 — load-safe visitor experience
- Changed: `js/assistant.js`, `ai-assistant/src/routes/assistant.js`, `ai-assistant/src/chat/limiter.js`, `ai-assistant/src/app.js`.
- Removed visitor-facing queue positions and load/busy wording. Load-capacity outcomes now use local fallback answers; only real browser/network failure keeps a retry action.
- Open: real browser test requires Playwright installation.

## WIP 62 / T2 — instant small talk
- Changed: `ai-assistant/src/chat/smalltalkReplies.js`, `ai-assistant/src/chat/pipeline.js`, `ai-assistant/scripts/selftest.js`.
- Small talk is local, randomized, avoids the previous assistant reply, and uses the same meta/token/done stream shape.
- Open: native Luganda wording should still receive human review before treating it as editorially final.

## WIP 62 / T3 — instant FAQ
- Changed: `ai-assistant/src/knowledge/faq-instant.json`, `ai-assistant/src/chat/faqMatch.js`, `ai-assistant/src/knowledge/factsValues.js`, selftests.
- Added 44 FAQ entries with six phrasings each, generated-facts placeholders, BM25 matching, threshold 6.0 and margin 0.65.
- Test calibration: 30 target phrasings matched; 20 off-target phrasings rejected.
- Checkpoint requested: `Nextastore_WIP_62_step3.zip`.

## WIP 62 / T4 — natural instant-answer timing
- Changed: `ai-assistant/src/chat/typewriter.js` and pipeline usage.
- Instant replies wait about 500 ms, then stream at about 38 words/second.

## WIP 62 / T5 — local fallback
- Changed: `ai-assistant/src/chat/fallback.js`, pipeline/routes.
- Fallback uses the best one or two BM25 sections, first few sentences, and an allowed local link where relevant. It is used for capacity waits, model failures, and the 20-second model-start timeout.

## WIP 62 / T6 — cache, merge, fairness
- Changed: `ai-assistant/src/chat/answerCache.js`, limiter, proxy, widget, selftests.
- Added one-hour/300-entry model-answer cache, identical in-flight merge, one model request per visitor, and a hashed signed-in-user/IP visitor key.
- Cache excludes history, flags, live-data answers, and Luganda-translated results.
- Checkpoint requested: `Nextastore_WIP_62_step6.zip`.

## WIP 62 / T7 — fast model path
- Changed: `ai-assistant/src/ollama/client.js`, `ai-assistant/src/chat/systemPrompt.js`, pipeline/config.
- Explicit `num_ctx=2048`, prompt metrics in debug mode, fixed prompt prefix with per-request context at the end, adaptive RAG/history/token settings, and retrieval-first prompt fitting.

## WIP 62 / T8 — VPS profiles
- Changed: `.env.vps-4gb.example`, `.env.vps.example`, Ollama override, setup script, systemd service, docs.
- Added 4 GB profile, RAM-based profile selection, 2 GB/4 GB swap targets, one loaded model, flash attention, two parallel slots, and 400 MB Nexi Node cap on the 4 GB profile.

## WIP 62 / T9 — proof
- Changed: `ai-assistant/scripts/loadtest.js`.
- Mock 20-user load test exercises the real assistant routes with a local Ollama stub and reports source, first-word/total latency, forbidden load text, and errors.

## WIP 62 / T10 — documentation
- Changed: `README.md`, `DEPLOY_VPS.md`, `WIP_NEXI_PLAN_v2.md`.
- Marked Phase 3 complete, documented 4 GB/8 GB profiles, removed queue-position wording, and kept Nexi local with no web-search/SearXNG integration.

## Checks
- Isolated Nexi selftest harness: **170 passed, 0 failed**.
- Proxy test: **15 passed, 0 failed**.
- Mock loadtest: **20 users, 0 errors, 0 forbidden load texts; p50 first word 547 ms, p95 579 ms**.
- Browser test could not run because Playwright is not installed in this sandbox.
- The sandbox could not complete a real `npm ci`; the installed package manager dependency download timed out. Therefore the mandated npm selftest was also not runnable with the project's real dependencies.
- VPS RAM/model memory was not measured on a real server.

# Nexi WIP 63 checkpoint log (PARTIAL - packaged mid-way at the user's request)

## Diagnosis (nothing fixed yet except where listed under "Added")
- **Luganda falls back to English:** with the Ganda model on, `pipeline.js` waits for the WHOLE English answer (non-streamed) before sending anything, so the 20 s `MODEL_FIRST_TOKEN_TIMEOUT_MS` fires and the visitor gets the flattened local fallback snippet in English.
- **Luganda starters never hit curated answers:** `luganda-phrasebook.json` has no patterns matching the six Luganda starter questions, so they all go to the slow model path.
- **Fallback flattens lists:** `chat/fallback.js` `firstSentences()` joins bullet lines into one paragraph ("... - Add the profit ...").
- **500 errors on /api/products/public and /api/store/public/all** (screenshot 3): not a code bug found in the routes; schema columns all have migrations. Most likely the database is not reachable or migrations were not applied on that machine. The backend terminal prints the real error (look for P1001 / P2021 / P2022).
- Facts sync failed once at start only because the backend was not up yet; it retries every 5 minutes.

## Added (not yet used by anything)
- `ai-assistant/src/chat/bubbles.js`: `splitReply()` and `createBubbleGate()` - turns an answer into short chat bubbles (lists stay together, max 4).
- `ai-assistant/src/chat/pacer.js`: per-answer queue that adds natural typing pauses between bubbles for instant answers.
- Smoke-tested bubble splitting in Node only.

## Still to do (planned)
1. Wire bubbles + pacer into `pipeline.js` / `routes/assistant.js` (new stream events: `break`, `cards`); client `js/assistant.js` multi-bubble rendering.
2. Luganda: stream English by sentence and translate as it goes; progress-based timeout; `askEn` for starter clicks (also in backend `assistantProxy.js` + `sanitize.js`); warm the Ganda model; optional Luganda-to-English input step.
3. Starters: one scrollable row docked above the composer (hero and panel).
4. Product/store cards (`src/tools/catalog.js`, uses backend `/products/public` and `/store/public/all`) with Open and Share buttons.
5. Chat modal redesign (css/assistant.css), fallback list fix, clearer backend error hint for database problems.

## Checks
- No browser available in this sandbox, no `npm ci` (no network). Only `node` smoke test of bubbles.js. Nothing user-visible has changed yet.

# Nexi WIP 64 checkpoint log (PARTIAL - packaged at the user's request, NO CODE CHANGED)

Step 1 (bubbles in server + widget) was analysed in full but not started. The only change in this zip is this log entry.
Nothing user-visible has changed since WIP 63.

## Verified this session
- `npm ci` DOES work in this sandbox now (WIP 63 said it could not). `ai-assistant` baseline: `node scripts/selftest.js` = **170 passed, 0 failed** before any change.
- Dependencies are not in the zip (node_modules excluded); run `npm ci` in `ai-assistant/`.

## Problems found in the unused WIP 63 files (fix before wiring them in)
- `bubbles.js` `createBubbleGate`:
  - A blank line that arrives as two separate "\n" chunks (the Luganda translator does this) is never seen as a break.
  - The long-paragraph soft break never fires for real model output: tokens carry their space at the START (" Next"), so the text never ends in whitespace when the check runs.
  - Fix plan: hold trailing whitespace until the next visible text arrives, then decide break / space / newline; break after 2 sentences or ~110 chars; when max bubbles is reached emit "\n\n" not "\n"; coalesce output per push() call.
  - `splitReply`: SOFT_LIMIT 240 leaves 41 of 44 FAQ answers as one bubble; use ~180. When over the max, merge the shortest adjacent pair instead of dumping the tail into the last bubble. Merge a link-only paragraph (e.g. "[Open Marketplace](/marketplace)") into the previous bubble.
- `pacer.js`: logic reads correct but is untested. `typingPause` cap of 1500 ms is long; use about 400-1100 ms. Add a test-only option to skip delays.
- `fallback.js` `firstSentences()` is worse than "flattened bullets": it also cuts mid-list ("Ask yourself: 1. Do people near me... 2."). Fix: parse line by line, keep list items as whole units, never cut inside one.

## Design decided for step 1
- Pipeline owns pacing (selftest line ~448 requires `run()` with only `onToken` to delay >= 400 ms and stream > 1 chunk; line ~192 requires streamed chunks to join to exactly the final reply when there are no blank lines).
- New `chat/deliver.js`: `createDelivery(hooks)` wraps gate + pacer + collector. `instant(replyOrBubbles, source)` for FAQ / small talk / phrasebook / flag / cache / fallback; `live()` for model text; collects the bubbles actually sent. New hooks: `onBreak`, `onTyping`, `onCards`, `onReset`. Replace all 5 `typewriter.stream` calls in `pipeline.js` (3 in runCore, 2 in run()) and the one in `routes/assistant.js sendFallback`.
- Stream events added: `break`, `typing`, `cards` (step 4), `reset` (clear partial bubbles before a fallback follows a mid-stream failure). `done` gains `bubbles: string[]`; `done.reply` stays the full text with blank lines between bubbles, so old clients still end up correct. `assistantProxy.js` forwards bytes unchanged, so it needs no change for these events.
- Route: one `makeStreamOut(res)` helper replaces the two duplicated hook objects in `handleChatStream`; non-stream `/chat` and `sendFallback` return `bubbles` too.
- Client (`js/assistant.js` + `css/assistant.css`): bot message gets `parts[]` (text = parts joined by blank line, so history/save/retry keep working; persist `parts`). Events: token appends to last part, break pushes an empty part (shown as typing dots), done replaces parts with `bubbles`, reset clears them. Strip empty parts in `finish()`.
- EXISTING BUG to fix at the same time: `syncThread` replaces the whole message node on every token, which replays the `.nexi-msg` `nexi-in` fade-in each time (flicker), and once more when streaming ends. Update bubbles in place instead; only newly added bubbles animate (`.nexi-bubble.is-new`). Stack bubbles with `.nexi-msg.is-bot.is-stack {flex-direction:column;align-items:flex-start;gap:5px}`; retry / new-chat / suggestion chips attach to the last bubble.
- Testing: no browser is available (Playwright/Chromium downloads are not on the allowed list). Test client logic with jsdom (npm) driving a fake streaming fetch; add new selftest cases for gate, pacer, delivery, route events, fallback lists.

## Noted for step 2 (Luganda)
- `modelTimeout` in `pipeline.js` is only cleared when the first token is EMITTED, and the Luganda branch uses non-streamed `ollama.chat`, so the 20 s limit covers the whole English answer. Switch the English answer to `chatStream`, translate each sentence as it completes, and clear the timer on first model token.
- The timeout callback also never checks `gotFirstToken`; only the clearTimeout protects it.

## Still to do
Steps 1-5 as listed under WIP 63 (unchanged). Backend 500 errors: still waiting for the backend terminal error text (P1001 / P2021 / P2022).

# Nexi WIP 65 checkpoint log (PARTIAL - packaged at the user's request)

Step 1 is about one third done: the server-side building blocks are finished and smoke-tested, but NOTHING IS WIRED IN YET.
`pipeline.js`, `routes/assistant.js`, `fallback.js`, `js/assistant.js` and `css/assistant.css` are untouched, so nothing user-visible has changed.

## Done
- `ai-assistant/src/chat/bubbles.js` rewritten (fixes the three bugs listed under WIP 64):
  - gate holds whitespace until the next visible text, so a blank line split over two "\n" chunks, tokens with a leading space, and a trailing blank line all behave;
  - live breaks after two sentences or one sentence of about 110+ characters; never inside a list; never on "Step 1.";
  - `splitReply`: SOFT_LIMIT 180, a link-only paragraph stays with the bubble before it, extra bubbles are merged shortest-neighbours-first (max 4).
- `ai-assistant/src/chat/pacer.js`: typing pause now 0.4 to 1.1 s, new `pauseScale` option (0 = no pauses, for tests), new `reset()`.
- NEW `ai-assistant/src/chat/deliver.js`: `createDelivery(hooks)` with `instant()`, `live()`, `bubbles()`, `delivered()`, `reset()`, `drain()`. Hooks: `onToken`, `onBreak`, `onTyping`, `onCards`, `onReset`, `signal`, `pace`. With no `onToken` nothing is paced.
- Node smoke tests of all three (instant order, live + reset, silent mode): pass.
- Existing selftest still **170 passed, 0 failed** (the new modules are not used by anything yet).

## Next, in this order (plan unchanged from the WIP 64 entry)
1. `fallback.js`: line-aware `condense()` so lists are never cut or flattened.
2. `pipeline.js`: replace the 5 `typewriter.stream` calls with a delivery; `live()` for model text; `bubbles` on every result; `delivery.reset()` in the model-failure catch; cache replay via `instant(result.bubbles)`.
3. `routes/assistant.js`: `makeStreamOut(res)` helper (events `token`, `break`, `typing`, `cards`, `reset`, `done.bubbles`), `sendFallback` through a delivery, `bubbles` on non-stream replies. (`chat/typewriter.js` becomes unused.)
4. `js/assistant.js` + `css/assistant.css`: `parts[]`, in-place bubble updates (no per-token re-animation), `.is-stack`, `.is-new`, typing dots for an empty last part, persist `parts`. Check `service-worker.js` cache version so the new JS is picked up.
5. Tests: new cases in `scripts/selftest.js` (gate, splitter, pacer, delivery, pipeline bubbles, route events, fallback lists) and a jsdom test for the widget (`npm run test:widget`, jsdom as a devDependency).

## Checks
- `npm ci` works in this sandbox. No browser here, so nothing has been looked at visually.

# Nexi WIP 66 checkpoint log (PARTIAL - packaged at the user's request, NO CODE CHANGED)

This session only read the code and checked what can be tested here. The only change in this zip is this log entry.
Nothing user-visible has changed since WIP 63. Steps 1-5 from the WIP 65 entry are all still to do, in the same order.

## Verified this session
- `npm ci` FAILED here this time (403 Forbidden from the registry, network is off). So express / cors / dotenv / jsdom were not installable.
- Workaround for testing only: tiny stand-ins for `express`, `cors` and `dotenv`, kept OUTSIDE the project and used through `NODE_PATH`. With them the existing `node scripts/selftest.js` = **170 passed, 0 failed**, same as the baseline. The stand-ins are not in this zip. Please still run `npm ci` and `npm run selftest` on your machine, because the stand-in express is not the real one.
- A real browser IS available in this sandbox: Chromium at `/opt/pw-browsers/chromium-1194` with a global Playwright 1.56.0. WIP 63-65 said no browser was available; that is no longer true. So the widget (step 4) can be tested in a real browser, not only jsdom.

## Read and confirmed (no changes)
- `fallback.js` `firstSentences()` squashes all whitespace, so bullet lists from the knowledge files (e.g. "How to price your products") are flattened into one run-on paragraph and can be cut mid-item. Chunks are whole `## sections`, so a line-aware `condense()` (keep list items whole, stop at an item boundary, keep the intro line ending in ":") is straightforward.
- `pipeline.js` has the five `typewriter.stream` calls to replace (smalltalk line 119, faq 128, fallback in the catch 244, cache replay 282 and 290 in `run()`), plus two paths that call `onToken` with no pacing at all (flag line 84, phrasebook line 93). All of them should go through `createDelivery().instant()`.
- Model path: `markerGate(guardedToken)` feeds the live gate, so the order is model text -> marker gate -> bubble gate -> pacer. The Luganda note strings start with a blank line, so they become their own bubble automatically.

## Decisions for the wiring (not yet implemented)
- `result.bubbles` on every result. For live model text, `reply` = bubbles joined by a blank line (the gate drops the whitespace at a break, so raw text would not match what was shown). For instant answers `reply` stays the original text, so existing comparisons keep working.
- `hooks` in `run()` / `runCore()` gain `onBreak`, `onTyping`, `onCards`, `onReset`, `pace` and are passed to `createDelivery`.
- In the model-failure catch: `delivery.reset()` first, then `instant(local.reply, 'fallback')`.
- Pacing differs from `typewriter` on cancel: `typewriter` threw `cancelled`, the pacer just stops and `run()` returns normally. Routes already check `ac.signal.aborted` before sending `done`, so this should be fine, but it needs a selftest case.

## Suspected existing bug (NOT verified yet, check first next session)
- In `run()`, `promise.then(...).finally(...)` creates a second promise that nothing catches. If `runCore` rejects (client closes the tab mid-answer, which rethrows the abort error), that second promise would be an unhandled rejection. Node 22 treats that as fatal by default and `server.js` has no `unhandledRejection` handler. If it reproduces, the fix is one line (`.catch(() => {})` on the chain). I did not run a test for this, so treat it as a suspicion.

## Possible small issue in pacer.js (not verified)
- `pacer.reset()` clears the queue but a paced instant answer that is in the middle of a sleep could still send a few more words afterwards. Only matters if reset is called during an instant answer, which the pipeline does not do (reset is only for failed live text), so low priority. A generation counter would close it.

## Next, in this order (unchanged)
1. `fallback.js` line-aware `condense()`.
2. `pipeline.js` wiring as described above.
3. `routes/assistant.js`: `makeStreamOut(res)`, `sendFallback` via a delivery, `bubbles` on non-stream replies.
4. `js/assistant.js` + `css/assistant.css`: `parts[]`, in-place updates, `.is-stack`, `.is-new`, typing dots; bump the cache version in `service-worker.js`.
5. Tests: new selftest cases and a widget test (jsdom, or Playwright with the Chromium above).

## Checks
- Baseline selftest 170 / 0 with the test-only stand-ins (see above). Nothing else was run.

# Nexi WIP 67 checkpoint log

## What changed
- `ai-assistant/src/chat/pipeline.js`: verified and fixed the in-flight cache rejection chain with `.catch(() => {})`; wired `createDelivery` into instant and live paths; added break/typing/cards/reset/pace hooks; model text now passes through the live bubble gate and pacer; every result carries `bubbles`; live `reply` is rebuilt from bubbles; model-failure fallback resets delivery before sending the local fallback; cache replay uses cached bubbles; aborts stop pacing quietly.
- `ai-assistant/src/chat/fallback.js`: added line-aware `condense()`; headings are stripped, paragraph breaks stay blank, list items remain whole, and list intros ending in `:` stay with their lists. `build()` now condenses each retrieved section separately and joins sections with a blank line. `firstSentences()` remains unchanged.
- `ai-assistant/src/routes/assistant.js`: added `makeStreamOut(res)` and the `token`, `break`, `typing`, `cards`, `reset`, and `done.bubbles` stream events; `sendFallback` now uses delivery and returns bubbles for non-stream replies too.
- `js/assistant.js`: bot messages now use `parts[]`; persistence/loading supports parts with old-message fallback to `text`; stream events update parts; `done` replaces parts with bubbles; reset clears them; empty parts are stripped on finish; bot bubbles are updated in place instead of replacing the message node; only newly created bubbles get `is-new`; retry/new-chat/suggestions attach to the last bubble.
- `css/assistant.css`: added stacked bot-message layout and `.nexi-bubble.is-new` animation.
- `service-worker.js`: cache version bumped from `v48` to `v49`.
- `ai-assistant/scripts/selftest.js`: added Step 0 rejection/unhandled-rejection coverage plus fallback-list, gate, splitter, pacer, delivery, pipeline-bubble, abort, and route-event tests.
- `ai-assistant/package.json`: added `npm run test:widget`.
- `ai-assistant/scripts/widget-test.py`: browser widget test using Playwright with a fake NDJSON stream; verifies multi-bubble rendering, in-place updates, and parts persistence.

## Test counts
- Baseline before WIP 67 code work: **170 passed, 0 failed**.
- Step 0: **172 passed, 0 failed**. The suspected unhandled rejection reproduced before the fix; after the one-line catch it no longer emits `unhandledRejection` while the original `run()` promise still rejects to its caller.
- Step 1: **177 passed, 0 failed**.
- Step 2: **181 passed, 0 failed**.
- Step 3: **183 passed, 0 failed**.
- Step 4: **183 passed, 0 failed**.
- Step 5/final: **187 passed, 0 failed**.

## Browser / environment checks
- `npm ci` did not complete in this sandbox (timed out); the resulting `node_modules` was incomplete (`dotenv` was missing), so tiny `express`, `cors`, and `dotenv` stand-ins were used only through `NODE_PATH` outside the project. They are not packaged.
- Final `node scripts/selftest.js` was run with those outside stand-ins: **187/0**.
- Root `qa:static` was not available because the project root has no `package.json`/`qa:static` script, so it could not be run.
- A real system Chromium was available at `/usr/bin/chromium`; the browser widget test used Python Playwright and passed. A multi-bubble screenshot was inspected visually. No jsdom was added or used.
- `npm run test:widget` passed in this sandbox.

## Step 0 result
The suspected `promise.then(...).finally(...)` rejection was reproduced with an in-flight cache entry and an abort-style `runCore` rejection. The fix was only `.catch(() => {})` on that internal chain; the returned `promise` remains the caller-facing rejection.

## Still open / not changed
- Low-priority `pacer.reset()` generation-counter improvement was not changed.
- Out-of-scope items remain untouched: Luganda streaming, starter row redesign, product/store cards, chat modal redesign, and backend 500 errors awaiting P1001/P2021/P2022 terminal text.
- `ai-assistant/src/chat/typewriter.js` is now unused by the pipeline but was intentionally not deleted until the wiring/tests were complete; it remains in the project.

## Exact next step
Run `cd ai-assistant && npm ci`, then `npm run selftest` on the target machine using the real dependencies. If those pass, stop here and wait for the next WIP instruction; do not start any out-of-scope work.

# Nexi WIP 68 checkpoint log

## What changed
- `ai-assistant/src/chat/pipeline.js`: removed the unused `typewriter` import. Made the model timeout progress-based: the timer does nothing once progress has occurred. The Luganda model path now uses `ollama.chatStream`, strips the model marker through the existing `markerGate`, collects English as it arrives, translates completed sentence/layout pieces through the translator streaming helper, emits Luganda before the English stream ends, preserves `model+<provider>`, `thinking`/`translating` status, partial/no-translator notes, fallback reset behaviour, and bubble-joined final replies. Luganda results remain uncached.
- `ai-assistant/src/lang/translator.js`: added a small queued streaming helper that reuses the existing local translator and its sentence/layout splitter; completed pieces translate in order and failed pieces remain English.
- `ai-assistant/src/lang/luganda-phrasebook.json`: added six curated guest-starter entries with multiple natural pattern variants and answers sourced only from the existing starting-store, selling, shopping/safety knowledge and FAQ content. The Luganda wording is explicitly marked `needs_review` and is not native-reviewed/editorially final.
- `ai-assistant/scripts/selftest.js`: added timeout-progress tests, streamed Luganda tests (early emission, complete reply, partial note, abort), six starter phrasebook checks, and 20 unrelated Luganda non-match checks. Existing tests were preserved.

## Test counts
- Baseline before WIP 68 changes: **187 passed, 0 failed**.
- Step 0: **187 passed, 0 failed**.
- Step 1: **189 passed, 0 failed**.
- Step 2: **193 passed, 0 failed**.
- Step 3/final: **200 passed, 0 failed**.

## Environment / checks
- `npm ci` was attempted in `ai-assistant/` but the package-install operation timed out in this sandbox. Temporary tiny `dotenv`, `cors`, and `express` stand-ins were used outside the project through `NODE_PATH`; they are not packaged.
- Final command run: `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js` -> **200 passed, 0 failed**.
- Final JavaScript syntax checks passed for `pipeline.js`, `translator.js`, and `scripts/selftest.js`; `luganda-phrasebook.json` passed `python3 -m json.tool`.
- Read-only review completed for WIP 63-67 log entries and the requested Nexi files. No changes were made to `bubbles.js`, `deliver.js`, `pacer.js`, `localTranslate.js`, `ollama/client.js`, `config.js`, or the server/frontend files.
- Not tested: real Ganda Gemma translation quality, a real Ollama/Ganda server, or real browser Luganda behaviour. The streamed logic was tested only with fakes. Optional server-start Ganda warm-up was not implemented.

## Next step
- Optional WIP 68 Step 4 remains: when the Luganda provider is `local` and the Ganda model is confirmed pulled, warm the Ganda model at server start in the same manner as the chat-model warm-up. Otherwise stop here and test the real Ganda model in the browser.

# Nexi WIP 69 checkpoint log

## Why this WIP exists (read from the code, NOT measured on a real Ollama)
- Both deploy profiles set `OLLAMA_MAX_LOADED_MODELS=1`. WIP 68 starts translating sentences while the English answer is still streaming. With one model slot, Ollama is **expected** to make the Ganda request wait until the chat request has finished (and then swap models), so the early-bubble gain should not appear. **This is expected from how Ollama schedules models. It was not measured; there is no real Ollama in this sandbox.**
- `localTranslate.js` `modelTranslate`: the 45 s `translateChunkTimeoutMs` timer starts when the request is sent, so time spent waiting in Ollama's queue (or for a model swap/load) counts against it. A waiting sentence can time out and stay in English. **Not changed in this WIP** (the prompt said not to touch `translateChunkTimeoutMs`, and `localTranslate.js` was read only). With the new default the Ganda request is no longer sent while the chat request is still running, which should remove the queue wait, but a Ganda model load/swap after the English finishes still counts against the 45 s. Measure it.
- `pipeline.js`: when the translator ran but every sentence stayed English, the visitor saw "translation is not enabled on this server". That was wrong. Fixed in Step 2.

## What changed (file by file)
- `ai-assistant/src/config.js`: NEW config value `lugandaInterleave`, read from NEW env var `LUGANDA_INTERLEAVE` (true only for 1/true/yes, case-insensitive, same style as `logLugandaMisses`). Default **false**. Both names are new.
- `ai-assistant/src/lang/translator.js`: `createStreaming` takes a NEW option `hold` (default false). With `hold: true`, completed pieces are collected as before but nothing is translated, and `onProgress` is not called, until `end()`. `end()` then translates the queued pieces in order and emits each Luganda piece through `onChunk` as it finishes (so the first Luganda bubble can appear before the last piece is translated). With `hold` false the behaviour is exactly WIP 68.
- `ai-assistant/src/chat/pipeline.js`: passes `hold: !config.lugandaInterleave` to `createStreaming`. `status('thinking')` first, then `status('translating')` when translation really starts (now after the English stream ends by default). The model first-token timeout is still cleared on the first English token (unchanged). Step 2: if `streamTranslator.end()` returns a result but `translated` is 0, the reply gets the existing `LG_PARTIAL_NOTE` instead of `LG_NO_TRANSLATOR_NOTE`; the English was already streamed piece by piece, so only the note is added (no duplicate English). `LG_NO_TRANSLATOR_NOTE` is kept for "no translator available at all" (and for the odd case of no text). No new visitor copy.
- `ai-assistant/scripts/selftest.js`: 26 new tests (see below), and two edits to existing tests, listed under "Existing tests touched".
- `ai-assistant/.env.example`, `.env.vps.example`, `.env.vps-4gb.example`: added `LUGANDA_INTERLEAVE=false` with a comment saying to set it to true only after `OLLAMA_MAX_LOADED_MODELS=2` is set AND the machine has enough RAM for both models, and to measure first.
- `ai-assistant/DEPLOY_VPS.md`: new bullet in "How Luganda works here" about swapping with one loaded model, the new default, and what to measure (`free -m`, `ollama ps`, `npm run bench`). It does not claim the 4 GB profile can hold both models.
- `ai-assistant/scripts/bench.js`: small, reporting only. The header now prints `LUGANDA_INTERLEAVE`, and the Luganda run (item 3) labels its first-output time as "first Luganda text after ...". (The bench already measured time to the first emitted text; item 3 only emits Luganda or the English-with-note text, so this is the time to the first Luganda text.) Syntax-checked only; it needs a real Ollama and was not run.
- `ai-assistant/deploy/ollama-override.conf`: NOT changed (still `OLLAMA_MAX_LOADED_MODELS=1`).

## Existing tests touched (nothing deleted)
1. WIP 68 test block "Luganda streamed translation (WIP 68 Step 2)": it models the interleave behaviour, so I now set `config.lugandaInterleave = true` at the start of the block and restore it in its `finally`. Its checks are unchanged. (Its fake translator ignores `hold`, so it would also have passed with the flag off; the flag makes the intent honest.)
2. `model echoing English -> English + short note, source model` (Echo case, ~line 231): this check asserted `/translation is not enabled/` for the exact case Step 2 corrects (translator ran, every sentence echoed English). The expectation now is: `source === 'model'`, the partial note is present, "not enabled" is NOT present, no `LGA:`. This is the one existing assertion whose expected text changed; its other conditions are kept and one is added. The next check (English streamed once, not twice) is unchanged and passes. The two "no translator" checks (`Luganda with no local Luganda model ...` and `LUGANDA_PROVIDER=off ...`) are unchanged.

## Selftest counts
- Baseline before any change: **200 passed, 0 failed**.
- After Step 1: **220 passed, 0 failed** (+20).
- After Step 2: **226 passed, 0 failed** (+6).
- After Step 3 (docs, env examples, bench label): **226 passed, 0 failed**.

## New tests
- Step 1 (20): config parsing (default/false/0/no/off -> false; 1/true/yes/TRUE -> true, checked in child processes); (a) interleave off, real `createStreaming` + mock Ganda: no Luganda text before English ends, no Ganda request before English ends, `thinking` then `translating` after English ends, final reply complete and equal to bubbles joined with a blank line, text streamed; (b) interleave on: first Luganda text before English ends, Ganda request started early, `translating` before English ends, final reply complete; the pipeline passes `hold: true` / `hold: false` correctly; (c) abort stops quietly in both modes; `createStreaming` direct tests (hold: nothing starts before `end()`, pieces in order, first chunk before last piece done; no hold: starts early; abort before `end()`; abort during `end()`).
- Step 2 (6): all pieces fail -> partial note, not "not enabled", English sent once, reply equals bubbles joined (interleave off and on); same with no stream consumer; no translator at all -> "not enabled" note, English once.
- Mutation check: with `hold` forced to false in the pipeline, 5 of the new tests failed (215 passed, 5 failed); code restored afterwards.

## Environment
- `npm ci` in `ai-assistant/` FAILED in this sandbox (403 Forbidden from the registry). Tiny test-only stand-ins for `express`, `cors` and `dotenv` were written in `/tmp/nexi-standins` and used through `NODE_PATH`. The express stand-in handles `app.use`, `app.get`, `express.Router`, `express.json` and the access-token test. They are NOT in this zip. All counts above come from `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js`.
- No `node_modules` in the zip.

## Tested and passed (fakes only)
- Everything listed under "New tests", using a mock Ollama, the mock Ganda model (`ganda-test`), fake `ollama.chatStream`, and a patched `localTranslate.translate` for ordering tests.
- `node --check` on `pipeline.js`, `translator.js`, `config.js`, `selftest.js`, `bench.js`.

## Read only
- Reviewed, not changed: `localTranslate.js`, `deploy/ollama-override.conf`, WIP 63 to 68 log entries.

## NOT tested
- Real Ollama scheduling (does a second model request wait, swap, or run?). Expected, not measured.
- Real Ganda Gemma loading time, real translation quality, real RAM use with one or two models.
- `npm run bench` (needs Ollama), the real express (stand-in used), and any browser behaviour of the new delay before the first Luganda bubble.
- Whether the 45 s `translateChunkTimeoutMs` is enough when the Ganda model has to be loaded after the English answer. Open.

## Trade-off to be aware of
- With the safe default, the first Luganda text appears only after the whole English answer is written (capped by `MAX_REPLY_TOKENS_LG`), then the Ganda model is loaded or swapped in. If your machine can really hold both models, `LUGANDA_INTERLEAVE=true` restores the WIP 68 behaviour. Measure both.

## Not done on purpose (out of scope)
- Warming the Ganda model at server start (it would evict the chat model while `OLLAMA_MAX_LOADED_MODELS=1`), starter row redesign, product/store cards, chat modal redesign, backend 500 errors, `askEn`. `bubbles.js`, `pacer.js`, `deliver.js`, `ollama/client.js`, `assistantProxy.js`, `sanitize.js` and all frontend files were not touched.

## Exact next step
1. `cd ai-assistant && npm ci && npm run selftest` (expect 226 passed, 0 failed).
2. On the real machine: `ollama ps`, `free -m`, `npm run bench` with `LUGANDA_INTERLEAVE=false`, then again with `LUGANDA_INTERLEAVE=true`. Compare "first Luganda text after ..." and total time, and look at whether any sentences stayed English.
3. Test a Luganda question that misses the phrasebook in the browser in both modes. Only consider `OLLAMA_MAX_LOADED_MODELS=2` and `LUGANDA_INTERLEAVE=true` if `free -m` shows enough room for both models. If sentences stay English because of the 45 s timer, the next WIP can make that timer start when the request actually starts (not read-only any more then).

# Nexi WIP 70 checkpoint log

## Baseline / environment
- WIP 63 item 3 was read: starters are the question row above the composer, for both the hero and panel; WIP 67, 68 and 69 entries were read in full before editing.
- Read in full before editing: `js/assistant.js`, `css/assistant.css`, `ai-assistant/scripts/widget-test.py`, `ai-assistant/src/lang/starters.json` (read only), and the `CACHE_VERSION` area of `service-worker.js`.
- `cd ai-assistant && npm ci` was attempted and timed out in this sandbox. Per the WIP instruction, tiny `express`, `cors`, and `dotenv` stand-ins were used only outside the project through `NODE_PATH`; they are not packaged.
- Baseline `node scripts/selftest.js`: **226 passed, 0 failed** with the outside stand-ins.
- Baseline existing widget browser test: `CHROMIUM_PATH=/usr/bin/chromium python3 scripts/widget-test.py` -> **passed**. The requested `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` path was no longer present at this run, so `/usr/bin/chromium` was used.

## Step 1 — markup/order and starter scroll helper
- `js/assistant.js`: kept the `.nexi-starters`, label and `.nexi-starters-row` classes and public API unchanged.
- Added two real `button type="button"` arrow controls with `aria-label="Previous questions"` and `aria-label="More questions"`.
- Added one small `wireStarterRow()` helper that hides arrows at the start/end, hides both when there is no overflow, updates on scroll/resize, and scrolls about 80% of the visible row with reduced-motion-aware behavior.
- Hero DOM order is now head -> thread -> starters -> composer -> foot.
- Panel starters moved out of `.nexi-panel-body` into `.nexi-panel-bottom`, directly above the composer; the conversation area remains the scrolling body.
- Removed the `nexi-starters--list` class use.
- Starter hide/show behavior remains `state.messages.length > 0`; it still returns after New chat. Persistent starters after the first message remain an **open design choice** and were not changed.
- Selftest after Step 1: **226 passed, 0 failed**.

## Step 2 — coherent starter-row CSS
- `css/assistant.css`: replaced the old starter layout layers with one coherent `.nexi-starters` block used by hero and panel at all widths.
- Removed the old WIP 56/WIP 57 starter layout rules: the `.nexi-starters--list` column/list rules, its chevron pseudo-element rules, the panel-specific starter padding/list and phone-row overrides, the hero two-column grid, the odd-last-card grid rule, and the hero phone-only row override. No `nexi-starters--list` selector remains.
- Kept the existing global `.nexi-chip` base colour, border, hover, focus and disabled styling, so `.nexi-suggest .nexi-chip` remains unaffected. New starter-only rules are scoped under `.nexi-starters`.
- Starter cards are one horizontal row, fixed/equal height, `clamp()` width around 200–240 px, wrapping text, scroll snap, hidden scrollbar, end fade mask, contained horizontal overscroll, and no starter `::after` chevron.
- Page-level horizontal overflow browser smoke check passed at **1000x760, 390x800 and 700x480**: `document.documentElement.scrollWidth <= innerWidth` was true at all three sizes. Cards were one row and equal height.
- Selftest after Step 2: **226 passed, 0 failed**.

## Step 3 — starter-row browser regression test
- Added `ai-assistant/scripts/starter-row-test.py` and `npm run test:starters` without changing or weakening `widget-test.py`.
- The test uses Playwright, the same `CHROMIUM_PATH` fallback pattern, fake fetch only, and no network. It mounts the hero and opens the panel through the existing public API.
- Covered at **1000x760, 390x800 and 700x480**: DOM adjacency to the composer, one-row/equal-height cards, phone overflow and peeking card, no page overflow, arrow state/scrolling/no-overflow hiding, English vs Luganda payloads, starter hiding after a message, New chat restore, Luganda repaint + scroll reset, pending disabled state, and flagged `.nexi-suggest .nexi-chip` isolation using a fake `done` event with `flag: {type: 'off_topic'}`.
- `CHROMIUM_PATH=/usr/bin/chromium python3 scripts/starter-row-test.py` -> **passed**.
- Screenshots saved in `ai-assistant/`: `starter-row-hero-desktop.png`, `starter-row-hero-phone.png`, `starter-row-panel-desktop.png`, `starter-row-panel-phone.png`.
- Screenshots were actually inspected. They show the horizontal starter row, equal-height cards, phone next-card peek, edge arrow, and panel starters directly above the composer with the conversation area retaining its space. No visual horizontal page overflow was seen.
- Selftest after Step 3: **226 passed, 0 failed**.

## Step 4 — cache bump
- `service-worker.js`: changed only `CACHE_VERSION` from `'v49'` to `'v50'`.
- No HTML files contain version query strings for `assistant.js` or `assistant.css`.
- `cd nextastore-backend && npm run qa:static` was attempted but **could not complete**: the sandbox copy is missing `nextastore-backend/.env.example`, and `scripts/qa-static.js` exits with `ENOENT` before completing.
- Selftest after Step 4: **226 passed, 0 failed**.

## Final verification / not tested
- Tested and passed: baseline existing widget test; new starter-row browser test; selftest at every step; three-viewport page-overflow/layout smoke check; screenshot inspection; JS syntax check for `js/assistant.js`; JSON parse check for `ai-assistant/package.json`.
- Not tested here: real NextaStore production page with its full surrounding CSS/HTML, real touch/finger scrolling on a physical phone, real backend/network responses, and `qa:static` because the sandbox package is missing `.env.example`.
- `ai-assistant/src` was not changed. Backend code was not changed.

## Exact next step
On the target machine run `cd ai-assistant && npm ci`, then `npm run selftest` with the real dependencies; run `npm run qa:static` in `nextastore-backend`; hard-refresh the marketplace page on a phone and desktop, scroll the starter row with a finger and with the arrow buttons, switch to Luganda, and click one starter.

# Nexi WIP 71 checkpoint log

## Scope
WIP 71 implements the **server half** of Nexi product/store cards. Changes are confined to `ai-assistant/` plus this log. No `js/`, `css/`, HTML, service-worker, or `nextastore-backend/` files were changed. Browser card rendering, Open/Share buttons, CSS, cache bump, and browser testing are WIP 72.

## Step 0 — baseline / environment
- WIP 70 recorded the previous clean baseline as **226 passed, 0 failed**.
- `cd ai-assistant && npm ci` was attempted in this sandbox and timed out. Per the WIP instructions, testing used tiny `express`, `cors`, and `dotenv` stand-ins under `/tmp/nexi-standins` through `NODE_PATH`; none were packaged.
- After fixing the test-only Express stand-in so the existing access-token test could run, the completed WIP 71 selftest finished at **255 passed, 0 failed**.
- The +29 count is the new WIP 71 coverage; existing tests were retained.

## Step 1 — catalog tool and configuration
Changed:
- `ai-assistant/src/config.js` — added `catalogCards` controlled by new `NEXI_CATALOG_CARDS` (enabled unless `0/false/no/off`) and `catalogTimeoutMs` controlled by new `CATALOG_TIMEOUT_MS` (default 2500 ms).
- `ai-assistant/src/tools/catalog.js` — new conservative, English-only catalog intent detector and fixed-path catalog lookup. Product lookups use `GET ${NEXTASTORE_API_BASE}/products/public?q=<encoded>&limit=4&sort=popular`; store lookups use the existing bounded `GET ${NEXTASTORE_API_BASE}/store/search?q=<encoded>&limit=4` and its `stores` part. For place wording such as `stores in Kampala`, `/store/search` was chosen because it is the already-reviewed public autocomplete/search endpoint with a bounded result set; no new endpoint was invented.
- `ai-assistant/.env.example`, `.env.vps.example`, `.env.vps-4gb.example` — documented the two new variables with one-line comments.
- `ai-assistant/scripts/selftest.js` — added 12+ positive and 12+ negative intent cases, all six English starters, URL/encoding checks, whitelist/extra-field checks, length caps, four-card cap, and config flag checks.

Card whitelist:
- Product: `{ type, id, name, price, originalPrice, thumbnail, storeName, storeSlug }`.
- Store: `{ type, id, slug, name, logo, district, description }`, with description capped at 120 characters.
- Extra phone numbers, directions, map coordinates, emails, tokens, and other backend fields are discarded. Results are plain data with no HTML.

Step 1 visitor/catalog behavior was tested only against a fake local backend, not the real NextaStore backend.

## Step 2 — delivery cards
Changed:
- `ai-assistant/src/chat/deliver.js` — added the requested `cards(payload)` method. It forwards to `pacer.cards(payload)` only when a pacer exists; without streaming/onToken it is silent. Reset now also clears queued card work while preserving the existing reset notification behavior for already-delivered content.
- `ai-assistant/scripts/selftest.js` — verifies text -> cards order, silent non-streaming behavior, and clearing a pending cards event.

## Step 3 — pipeline wiring
Changed:
- `ai-assistant/src/chat/pipeline.js` — added the CATALOG stage after FAQ and before model work, gated by `config.catalogCards`, and skipped for detected/forced Luganda. Catalog answers never call the model and are not answer-cached.
- `ai-assistant/scripts/selftest.js` — added fake-backend tests for products, stores, zero results, backend 500, timeout, abort, FAQ precedence, English starters, Luganda exclusion, feature-flag-off behavior, no model call, no caching, and the streaming route event order.

Visitor sentences added:
- Products: `Here are some products on NextaStore that match "<query>".`
- Stores: `Here are some stores on NextaStore that match "<query>".`
- Zero results: `I could not find anything for "<query>" on NextaStore yet. You can also try the search box on the marketplace page.`
- Backend failure/timeout: `I cannot look that up right now. Please try the search box on the marketplace page.`

Catalog query text is control-character/quote stripped and length-capped before appearing in these fixed sentences.

The stream route already had `makeStreamOut` support for `cards` and `done` spreading, so `routes/assistant.js` did **not** need changing. `instantPath` was left unchanged because a real backend catalog lookup is network/database-dependent and can wait up to 2.5 seconds; it is therefore not treated as the cheap local instant path.

One existing design constraint required no invented status event: current instant stages do not expose a status value, and the required catalog stream test expects `meta -> token(s) -> cards -> done` without queue/status wording. Card delivery can still emit the existing `typing` event from the already-existing pacer; the selftest ignores that presentation-only event when checking the semantic order.

## Exact WIP 72 client contract
Cards event example:
```json
{
  "type": "cards",
  "kind": "products",
  "query": "phones",
  "items": [
    {
      "type": "product",
      "id": "p1",
      "name": "Phone",
      "price": 1000,
      "originalPrice": null,
      "thumbnail": "/p.png",
      "storeName": "Shop",
      "storeSlug": "shop"
    }
  ]
}
```

`done.cards` shape:
```json
{
  "kind": "products",
  "query": "phones",
  "items": [
    {
      "type": "product",
      "id": "p1",
      "name": "Phone",
      "price": 1000,
      "originalPrice": null,
      "thumbnail": "/p.png",
      "storeName": "Shop",
      "storeSlug": "shop"
    }
  ]
}
```

Store cards use the same wrapper with `kind: "stores"` and the store-card whitelist above.

## Verification
- **Tested and passed:** final `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js` — **255 passed, 0 failed**.
- **Tested and passed:** catalog intent positives/negatives; fixed URL paths and encoded query; field whitelist; finite numbers; caps; feature flags; delivery card event; pipeline catalog behavior; fake 500/timeout/abort; FAQ/starter/Luganda precedence; no model call; no catalog caching; stream route cards event and `done.cards`.
- **Read only:** `WIP_LOG.md` WIP 63 plan item 4 and WIP 64-70 entries; `pipeline.js`, `deliver.js`, `pacer.js`, `routes/assistant.js`, `liveFacts.js`, `faqMatch.js`, `smalltalk.js`, `relevance.js`, `config.js`, `selftest.js`; backend product/store public/search routes and serialization helpers.
- **Not tested:** real NextaStore backend catalog responses, real database, real Ollama, browser rendering, Open/Share buttons, CSS, and physical-device behavior. The real backend catalog lookup remains subject to the user's existing backend database issue; if those endpoints return 500, Nexi intentionally gives the fixed `cannot look that up` sentence rather than inventing products/stores.

## Exact next step
**WIP 72:** render the server `cards` events in `js/assistant.js`, add **Open** and **Share** actions, update CSS for the cards, bump the service-worker cache version, and run the browser regression test.

# Nexi WIP 72 checkpoint log

## Scope and environment
- WIP 72 remains server-only: changes are confined to `ai-assistant/` plus this log. No `js/`, `css/`, HTML, `service-worker.js`, or `nextastore-backend/` files were changed.
- Read the WIP 71 checkpoint entry and reviewed `ai-assistant/src/tools/catalog.js`, the WIP 71 catalog stage in `ai-assistant/src/chat/pipeline.js`, the catalog-related selftests, and `ai-assistant/src/config.js`.
- Read only (backend, unchanged): `nextastore-backend/src/routes/store.js` GET `/public/all` and GET `/search`, plus `nextastore-backend/src/routes/products.js` GET `/public`. `/store/public/all` searches store name, description, district and address and returns `{ data: [store...], pagination }`; `/store/search` searches store names only. `/products/public` matches product names only, which explains why plural retry is useful and product queries must drop place suffixes.
- `cd ai-assistant && npm ci --ignore-scripts --no-audit --no-fund` was attempted but timed out in this sandbox. Per instructions, tests ran using the existing external test-only Express/CORS/dotenv stand-ins at `/tmp/nexi-standins/node_modules` via `NODE_PATH`; those stand-ins are not part of the project or package.
- WIP 71 baseline confirmed: `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js` -> **255 passed, 0 failed**.

## Step 1 — conservative catalog intent
Changed:
- `ai-assistant/src/tools/catalog.js`: removed the `I need` and `I want` product triggers; strips up to two leading determiners; rejects queries over five words, invalid leading words, and product queries containing support/account/payment/seller/store terms. Keeps the FAQ exclusions. Product queries drop a trailing ` in <place>` phrase. Generic directory phrases such as `list some shops` return `{ kind: 'stores', query: '' }`. Added `job`/`jobs` to the blocked product words so “looking for a job” does not become a product search.
- `ai-assistant/scripts/selftest.js`: expanded positive and negative detector cases, including every message listed in the WIP 72 problem statement and the required cleaned-query assertions.
- Step 1 test result: **257 passed, 0 failed**.

Existing assertions changed and why:
- `I am looking for a school bag`: expected query changed from `a school bag` to `school bag`, because leading articles are now removed.
- `list some shops`: expected query changed from `shops` to the empty string, because this is a directory listing rather than a search for a store literally named “shops”.
- The prior positive `I need cooking oil` and `I want a wrist watch` cases were removed because WIP 72 explicitly removes those trigger families; other allowed trigger positives remain covered.
- The generic `stores` negative remains a negative because it has no explicit directory trigger; the required triggered phrase `list some shops` is the empty-query directory positive.

## Step 2 — store endpoint, plural retry, price guard
Changed:
- `ai-assistant/src/tools/catalog.js`: store requests now use fixed `GET /store/public/all?limit=4`, adding encoded `q` only when non-empty, and parse the `data` array. The comment documents why `/store/public/all` replaced `/store/search`. Empty queries are allowed only for stores; products still require at least two characters. After a successful empty result, a single trailing-plural retry is attempted when the last word has at least four characters, ends in `s`, and not `ss`; `ies` becomes `y`, otherwise the final `s` is removed. The original query is retained in the result. Failed lookups are never retried. Null/empty product prices are discarded before numeric conversion.
- `ai-assistant/scripts/selftest.js`: fake-server tests now verify the fixed store URL, encoded query, empty-query URL, array parsing, extra-field whitelist, plural retry and preserved query, no retry after failure, null/blank price rejection, and per-answer request counts.
- Worst-case catalog lookup wait is **2 × `CATALOG_TIMEOUT_MS`** (default 5 seconds), because one successful empty result can trigger one additional lookup. There are never more than two calls per answer.
- The pipeline fake backend was updated from the old `/store/search` response shape to `/store/public/all` with `data: [...]`, so existing pipeline coverage continues to test the current endpoint.
- Step 2 test result: **262 passed, 0 failed**.

Existing assertions changed and why:
- The store endpoint assertion now expects `/store/public/all?limit=4&q=...` instead of `/store/search`, because the latter matches store names only and cannot reliably answer place/description searches.
- The store fake-server response now uses `body.data` as an array and includes deliberately extra fields; this matches the documented real endpoint and verifies that those fields are discarded.

## Step 3 — empty directory copy
Changed:
- `ai-assistant/src/chat/pipeline.js`: when the store query is empty, successful results use `Here are some stores on NextaStore.` and zero results use `I could not find any stores on NextaStore yet. You can also try the search box on the marketplace page.` Other catalog sentences and stage order are unchanged.
- `ai-assistant/scripts/selftest.js`: added tests for `list some shops` with two fake stores, the cards event, no model call/cache, empty-directory zero results, and `I need help with my order` reaching the normal model path. FAQ precedence remains covered.

Existing assertions changed and why:
- The backend-500 and timeout tests now snapshot `lastMain` immediately before each failing catalog lookup. The new order-help test intentionally calls the fake model earlier in the suite, so comparing against the old suite-wide snapshot would no longer isolate whether the failed lookup itself called the model.

Visitor sentences added for the empty store query:
- Found: `Here are some stores on NextaStore.`
- Zero: `I could not find any stores on NextaStore yet. You can also try the search box on the marketplace page.`

## Verification and limitations
- Tested and passed: final `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js` -> **266 passed, 0 failed**.
- Tested and passed: JavaScript syntax checks for `ai-assistant/src/tools/catalog.js` and `ai-assistant/src/chat/pipeline.js`.
- Read only: the backend store/product route behavior described above. No files under `nextastore-backend/` were changed.
- Not tested: real backend catalog responses, the real database, real Ollama, or browser card rendering. Real lookups remain untested here and may still return the existing backend/database 500s; this WIP does not fix those.
- Selftest counts: WIP 71 baseline **255/0**; after Step 1 **257/0**; after Step 2 **262/0**; final after Step 3 **266/0**.

## Exact next step
**WIP 73:** render cards in `js/assistant.js` with Open and Share buttons, update CSS, bump the service-worker cache to `v51`, run the browser test, and fix the “Try asking” label alignment. Read `resolveImageUrl` in `js/main.js` first because backend thumbnails may be relative paths. WIP 72 did not touch these files.

# Nexi WIP 73 checkpoint log

## Scope
- Client-only WIP. Changed only `js/assistant.js`, `css/assistant.css`, `service-worker.js` (`CACHE_VERSION` only), and this log.
- No files under `ai-assistant/`, `nextastore-backend/`, HTML, `js/main.js`, or any other JS/CSS file were changed.
- The server code remains unchanged and its self-test remains **266 passed, 0 failed**.

## Step 1 — card data flow and persistence
Changed `js/assistant.js`:
- Added one `cleanCards()` whitelist/cleaner for `products` and `stores`, capped at 4 items, matching item types, bounded string fields, finite numeric prices, and drop-if-no-id-and-no-name behavior. Invalid wrapper/item shapes produce no cards. It is used by stream cards, `done.cards`, plain `/chat` fallback, and `load()`.
- Added `cards` to bot-message state and the `save()` whitelist; `load()` sanitizes stored cards again.
- `readStream()` now stores `cards` events, accepts `done.cards` only when no cards were already stored, and clears cards on `reset`.
- `syncThread()` now detects card-only changes and `fillBubble()`/`updateMessageNode()` render cards under the final bot bubble.
- All server-provided card text is inserted with `textContent`; card URLs are built only through guarded `app` helpers or the specified local fallbacks.

## Step 2 — rendering and actions
Changed `js/assistant.js` and `css/assistant.css`:
- Added compact vertical product/store cards for both hero and panel views through the existing shared bubble rendering path.
- Product cards show 56px thumbnails, name, price, optional struck original price, and store name. Store cards show 56px logo/initial, name, district, and description.
- Added real `<a>` **Open** links and **Share** buttons with 44px minimum touch height, focus outlines, aria labels, same-tab navigation, Web Share support, clipboard fallback with polite `Link copied`, and hiding Share when neither sharing method is available.
- Relative images are resolved through `app.resolveImageUrl` only when `app` exists; otherwise relative paths remain placeholders. Failed images switch to the placeholder.
- Product links use `app.productLink(item)` when available, otherwise `/p/<id>`. Store links use `app.storeLink(item)` when available, otherwise a validated `/<slug>` or `/marketplace` fallback.
- The product/store card CSS is prefixed with `nexi-` and constrained to fit the existing 360px panel layout.

## Step 3 — “Try asking” alignment
Changed `css/assistant.css`:
- Confirmed the base cause: `.nexi-starters-label` had `margin-left: 2px`, while `.nexi-starters-row` starts its first chip after `padding-left: 12px`. The panel therefore had a 10px left-edge mismatch.
- The base label margin is now `2px 12px 8px` so the panel label aligns with the first chip.
- The hero row has `margin-inline: -12px` while retaining `padding-left: 12px`, so the hero’s first chip moves back to the hero content edge. Therefore `.hero-chat .nexi-starters-label { margin-left: 0; }` is the minimal hero-specific correction. The starter row itself and starter text were not changed.

## Step 4 — cache
Changed `service-worker.js` only at `CACHE_VERSION`: **`v50` -> `v51`**. The assistant files use the runtime cache, but the project rule requires the version bump; no precache entry was added.

## Verification
- **Tested and passed:** original WIP 72 archive, before edits, with external test-only stand-ins at `/tmp/nexi-standins/node_modules`: `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js` -> **266 passed, 0 failed**.
- **Tested and passed:** final WIP 73 server self-test with the same external stand-ins -> **266 passed, 0 failed**.
- **Tested and passed:** `node --check js/assistant.js` after the client edits.
- **Tested and passed:** a DOM-free assistant harness using the edited `assistant.js`: cards event storage, `done.cards` no-duplication behavior, reset clearing, plain fallback cards, save/load round trip, and tampered stored cards rejection.
- **Tested and passed:** static diff against WIP 72 confirms only the four permitted project files differ (`js/assistant.js`, `css/assistant.css`, `service-worker.js`, `WIP_LOG.md`).
- **Read only:** `js/main.js` helpers `resolveImageUrl`, `productLink`, `storeLink`, `storeLinkFor`, and `formatCurrency`; `ai-assistant/src/chat/pipeline.js` and `ai-assistant/src/routes/assistant.js` card-send locations; WIP 72 contract and log.
- **Safety/app finding:** `assistant.js` uses `typeof app !== 'undefined'` guards for every `app` reference, including the new image/link/currency helpers. Without `app`, product/store fallbacks are used and relative images stay placeholders.
- **Not tested:** real NextaStore backend catalog lookups, real database, real Ollama, real catalog card data, or physical-device behavior.
- **Browser test:** attempted the real `marketplace.html` and `safety.html` with the system Chromium against a temporary static/fake-assistant service. Chromium did not complete the headless runs within the environment timeout and produced no usable screenshots/results, so **no browser result is claimed**. In particular, hero/panel appearance, 360px layout, Open navigation, Web Share, clipboard fallback, image-failure rendering, navigation persistence in a real browser, and the safety-page live catalog question remain browser-unverified.
- `npm ci` was attempted as requested but timed out in this environment. The self-tests therefore used only external stand-ins under `/tmp/nexi-standins`; no stand-ins are in the project or package.

## Exact next step
**WIP 74 = fix what the user's real-backend run shows (tell them what to report).**


# Nexi WIP 74 checkpoint log

- **WIP:** 74 — catalog-card client fixes.
- **Allowed files changed:** `css/assistant.css`, `js/assistant.js`, `service-worker.js`, `WIP_LOG.md` only. No `ai-assistant/`, `nextastore-backend/`, HTML, `js/main.js`, or other JS/CSS files were changed.
- **Defect A — Open button readability:** The cause was the existing `.nexi-bubble a` rule (specificity 0,1,1) and, on marketplace, `.marketplace-container a:not(.cart-btn)` (0,2,1) overriding `.nexi-card-open` (0,1,0). The card Open/Share controls now use the required `.nexi-bubble .nexi-cards` specificity, with Open/visited using `#008558` (`var(--nx-green-d)`), white text, and no underline; hover uses `var(--nx-ink)`; the existing 3px gold focus outline is retained.
- **Defect B — Share visibility:** `renderCards()` now decides once per card whether sharing is available using `navigator.share` or `navigator.clipboard.writeText`. When neither exists, Share is hidden at render time and no live status span is created.
- **Defect C — hidden attribute:** Added `.nexi-card-share[hidden] { display: none; }` in `assistant.css`, so hiding Share no longer depends on `main.css`.
- **Before computed values from the supplied WIP 73 real-browser run:** marketplace panel Open was green-dark text on green with measured contrast **1.66:1** and underline; marketplace hero Open measured `rgb(23,48,42)` on green and was underlined. The intended white on `#01B075` was only **2.81:1**; white on `--nx-green-d` / `#008558` is **4.67:1**.
- **After computed values:** the required target is CSS-resolved to white `rgb(255,255,255)`, `text-decoration-line: none`, background `rgb(0,133,88)`, with calculated contrast **4.67:1**. A real-browser computed-style measurement was **not obtained in this environment**, so these are not claimed as measured browser results.
- **Cache:** `service-worker.js` changed only `CACHE_VERSION` from `v51` to `v52`. `assistant.js` and `assistant.css` are served by the runtime cache (no precache entry); the version bump is required by the project rule.
- **Baseline/self-test:** `node --check js/assistant.js` passed before and after the edit. `scripts/selftest.js` could not reach the required **266/0** because the archive has no installed dependencies; `npm ci --ignore-scripts --no-audit --no-fund` was attempted but did not complete in the environment. External temporary stand-ins were tried only outside the project, but the full self-test did not complete, so **266/0 is not claimed**.
- **Browser verification:** A real Chromium headless run was attempted against a temporary static server plus fake assistant NDJSON service. Chromium did not complete the run in this environment, so there is **no browser result claimed** and no screenshots were produced. The requested real-browser checks (hero/panel/safety computed styles, no-share render, clipboard fallback, focus screenshots, all WIP 73 regression checks) remain unverified here.
- **Step 3 user report:** The USER REPORT rows in the supplied prompt contain placeholders rather than actual filled-in backend observations, so there was no actionable real-backend report to fix. No Step 3 code changes were made.
- **Observations for later:** (a) cards are about 130px tall because Open and Share are on their own row; ask whether the user wants more compact cards with actions beside the text, or wants the answer text kept in view when cards arrive. (b) real slugs that are not alphanumeric can be URL-encoded by `app.storeLink`; real slugs are valid and `js/main.js` is out of scope, so no change. (c) `assistant.css` has no dark-mode rules, so cards follow the assistant light theme; no change. (d) `cleanCards` uses `Number.isFinite` (ES6); current browsers support it, so no change.
- **Files read only:** WIP 73 log entry; the specified assistant CSS/JS areas; `marketplace.css`, `main.css`, `service-worker.js`; relevant app helper context. No out-of-scope edits were made.
- **Exact next step:** **WIP 75 = act on the user's answer about card compactness and anything the real-backend run still shows.**

# Nexi WIP 75 checkpoint log

- **WIP:** 75 — keep catalog-answer text visible when cards arrive.
- **Scope:** Client-only. Changed only `js/assistant.js`, `service-worker.js` (`CACHE_VERSION` only), and `WIP_LOG.md`. No CSS change was needed because WIP 74 already supplied the required card-control styles. No `ai-assistant/`, `nextastore-backend/`, HTML, `js/main.js`, or other JS/CSS files were changed.
- **Decisions:** D1 defaults to **KEEP** (no card-layout redesign in this WIP). D2 defaults to **YES** (keep the answer in view when cards arrive). The supplied USER REPORT rows are placeholders rather than actual test results, so Step 2 made no client/server fixes.

## Step 0 — baseline
- `node --check js/assistant.js`: **passed** before the edit.
- `NODE_PATH=/tmp/nexi-standins/node_modules node scripts/selftest.js`: **could not run to completion**; it stopped because `dotenv` is unavailable (`Cannot find module 'dotenv'`). No 266/0 claim is made. No stand-ins were added to the project or package.

## Step 1 — answer-in-view scroll fix
Changed `js/assistant.js` only inside `syncThread()`:
- Added `cardsArrivedNode` and set it only when an existing message changes from no cards (`rec.cards === ''`) to cards (`m.cards` truthy).
- If cards arrived while the user was already near the bottom and the updated bubble is taller than the scroller, the view now moves so the top of that bubble is about 8px below the scroller top, using the requested bounding-rectangle calculation and clamping to zero.
- New nodes, restored nodes, and users who have scrolled up retain the existing behavior. The existing panel-open `panelParts.body.scrollTop = ...scrollHeight` line near `open()` was deliberately not changed.
- `node --check js/assistant.js` after the edit: **passed**.
- Before code behavior: cards arriving on an existing bubble always executed `sc.scrollTop = sc.scrollHeight` when `nearBottom` was true. After code behavior: tall card-bearing bubbles use the top-of-bubble positioning rule; other cases retain the previous bottom behavior.
- **Measured browser rect/scroll values:** unavailable because the required headless Chromium/Playwright runner is not available in this environment. No numeric browser measurement is claimed.

## Step 2 — supplied user report
- The five supplied report rows contain placeholders (`cards appeared?`, `same four questions`, `yes/no`) and no actual observations. Therefore: **no user report supplied, nothing changed**.
- Observation for later WIP: the panel-open scroll near the existing `open()` code still scrolls to the bottom, so reopening a panel containing cards can hide the answer again. Ask whether the same answer-in-view rule should apply on panel reopen in WIP 76.
- Observation for later testing: marketplace hero and panel render the same cards, so browser selectors must scope to `#nexiPanel` or `.hero-chat`.

## Step 3 — cache
- `service-worker.js`: changed only `CACHE_VERSION` from **`v52` to `v53`**.
- `assistant.js` and `assistant.css` are served by the runtime cache and have no precache entry; the bump is for the project cache-version rule.

## Step 4 — verification
- **Tested and passed:** `node --check js/assistant.js` before and after the edit.
- **Not tested:** required real headless Chromium/Playwright run. The specified Chromium path was unavailable and Playwright was not resolvable from the global npm root in this environment, so no browser result or screenshot is claimed.
- **Not tested:** final `scripts/selftest.js` to 266/0; the same missing `dotenv` dependency prevents completion.
- **Read only / retained facts from the supplied WIP 75 prompt:** WIP 74's later external browser measurements reportedly passed its 22 checks, including Open computed style (`rgb(255,255,255)` on `rgb(0,133,88)`, no underline, 4.67:1 contrast), 44px controls, Share hiding/fallback behavior, focus outline, no horizontal scroll, and no page errors. The WIP 74 checkpoint in this archive itself recorded no browser result in its own environment; these WIP 75 facts are therefore treated as supplied prior-test results, not rerun here.
- The real backend, database, real card data, and real assistant service remain untested in this WIP.

## WIP 74 supplied browser results retained for regression expectations
The supplied WIP 75 prompt says the following must continue to pass: hero and panel card rendering; text-only answers without cards; safe text rendering for HTML-like names; rejection of `javascript:` and `data:` thumbnails; broken-image placeholder; store initial when no logo; original-price strike only when higher; correct product/store Open fallback paths; same-tab navigation; Web Share absolute URL; harmless AbortError/rejected share; clipboard fallback and expiry; cards restored after navigation; tampered session storage dropped without script execution; no horizontal scroll; Open/Share focus outline; Share hidden when both share mechanisms are absent; clipboard-only Share fallback; safety-page hidden Share; and the Open computed-style requirements listed above.

## Exact next step
**WIP 76 = act on the user's answer about the panel-open scroll, act on D1 if `REDESIGN LATER` is chosen, and address anything the real-backend run still shows.**

# Nexi WIP 76 checkpoint log

- **WIP:** 76 — make the WIP 75 answer-in-view scroll writes instant so the hero follow-up does not get stranded in a smooth-scroll animation.
- **Scope:** Client-only. Changed only `js/assistant.js`, `service-worker.js` (`CACHE_VERSION` only), and `WIP_LOG.md`. No `css/assistant.css` change was made. No files under `ai-assistant/`, `nextastore-backend/`, HTML, `js/main.js`, or any other JS/CSS file were changed.
- **Decisions:** D1 = **KEEP** (no card redesign in this WIP). D2 = **INSTANT**. D3 = **NO**, so the panel-open scroll was deliberately not changed. The supplied USER REPORT rows contain only the template questions/placeholders, so there was **no user report supplied, nothing changed** in Step 3.

## Read-first findings
- Read the WIP 75 entry at the end of this log before editing.
- Read `js/assistant.js` `syncThread()` and the panel-open line near 969. The panel still opens with `panelParts.body.scrollTop = state.messages.length ? panelParts.body.scrollHeight : 0;` and this was not changed because D3 = NO.
- Read `css/assistant.css`: the panel thread overrides to `scroll-behavior: auto`, while the general/hero `.nexi-thread` rule at line 235 remains `scroll-behavior: smooth`. Card styles were read and left unchanged.

## Step 0 — baseline
- `node --check js/assistant.js`: **passed** before the edit.
- `node scripts/selftest.js`: **could not run** because the archive has no installed `dotenv` dependency (`Cannot find module 'dotenv'`). An `npm ci --ignore-scripts --no-audit --no-fund` attempt was made but timed out in this environment. No 266/0 result is claimed and no stand-ins were added to the project/package.
- Required real-browser reproduction of the WIP 75 hero regression was attempted before editing, but this environment blocked browser navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`. Therefore the required 135px reproduction was **not independently rerun here**.

## Step 1 — hero regression fix
Changed `js/assistant.js` inside `syncThread()` only:
- Added a tiny local `writeScroll(value)` helper that saves `sc.style.scrollBehavior`, sets it to `auto`, writes `sc.scrollTop`, then restores the saved inline value.
- Used it for all three existing scroll writes: empty-thread reset, `cardsArrivedNode` positioning, and the existing bottom jump.
- The `nearBottom` read and all branch conditions are unchanged. No timer was added. No CSS was changed. The panel-open line was not touched.
- `node --check js/assistant.js` after the edit: **passed**.
- **Required after-fix browser measurement:** unfinished/not available in this environment. The available Chromium is `/usr/bin/chromium`, but the requested WIP harness navigation is blocked by `ERR_BLOCKED_BY_ADMINISTRATOR`; the specified `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and global npm Playwright path are also absent. No after-fix numeric pass is claimed.
- The measured WIP 75 baseline supplied for this WIP remains: hero 1280x800, two questions, final `scrollTop = 607`, `scrollHeight = 1072`, `clientHeight = 330`, gap **135px**; **4/4 failed**. Removing only the WIP 75 `cardsArrivedNode` branch gave gap 0 in **4/4** runs; injecting `scroll-behavior: auto !important` gave **3/3** passes. The supplied measured cause was the hero's smooth scrolling causing a later `syncThread()` to read a mid-animation `scrollTop` (152px when cards arrived), while the earlier animation ended at the old bottom (607px).

### D2 trade-off
**INSTANT** keeps the answer-in-view feature and makes every `syncThread()` scroll write instant. The hero no longer glides while following a streaming answer; that gliding came from CSS and is replaced by the instant jump inside `syncThread()`. The CSS `scroll-behavior: smooth` line remains unchanged.

## WIP 75 browser results supplied for regression expectations
These are the measured results supplied with the WIP 76 request; they were **read only**, not rerun here:
- Panel 360x740: scroller `.nexi-panel-body` rect top 145, bottom 608, height 463; `show me phones`: 3 text bubbles + 4 product cards; `scrollTop 58`, `scrollHeight 871`; first bubble 153–239 and first card 400–529 were inside.
- Hero 1280x800: scroller `.hero-chat .nexi-thread` rect 411–741, height 330; `scrollTop 56`, `scrollHeight 826`; first bubble 413–478 inside; first card 617–748, with its bottom 7px past the scroller.
- Hero 360x740: thread 431–741, height 311; `scrollTop 50`, `scrollHeight 904`; first bubble 438–525 inside; first card 729–858, with about 12px visible above the thread bottom.
- safety.html panel: first bubble 153–239 inside the 145–608 scroller; product Open href was `/p/<id>`.
- Panel short answer + 1 card: bottom gap 0.
- Panel user scrolled to 0 before cards arrived 1.8s later: remained 0; 4 cards rendered.
- Panel text-only follow-up after cards: bottom gap 0.
- Open computed style in panel, hero 1280, hero 360 and safety panel: white `rgb(255,255,255)`, background `rgb(0,133,88)`, no underline, height 44px.
- Failed WIP 75 hero regression: 4/4 failed at gap 135px as recorded above. The branch-removed comparison was 4/4 gap 0; injected auto-scroll was 3/3 pass.
- WIP 75's own archive/log had no browser result or `wip75-screens` folder; the supplied measured WIP 75 results above are therefore retained as the prior measured baseline, not a WIP 76 browser claim.

## Step 2 — panel reopen
Skipped because D3 = **NO**. The panel-open scroll still scrolls to the bottom when messages exist. If the user later changes D3 to YES, a small WIP should apply the same answer-in-view rule only at panel open, after confirming the panel is measurable at that point.

## Step 3 — user report
- **No user report supplied, nothing changed.** The supplied rows are still template questions/placeholders, not actual observations.
- D1 remains KEEP; no card redesign was made.

## Step 4 — cache
- `service-worker.js`: changed only `CACHE_VERSION` from **`v53` to `v54`**.
- `assistant.js` and `assistant.css` are served by the runtime cache and have no precache entry; the bump is for the project cache-version rule.

## Step 5 — verification status
### Tested and passed
- `node --check js/assistant.js` before editing.
- `node --check js/assistant.js` after editing.
- Static diff against the supplied WIP 75 archive confirms the only project-code changes are the requested `syncThread()` helper/replacements in `js/assistant.js` and the one-line `CACHE_VERSION` bump in `service-worker.js`.

### Read only
- WIP 75 checkpoint log and the WIP 75 measured browser results supplied in the task.
- `css/assistant.css` thread/card regions and the panel-open code in `js/assistant.js`.

### Not tested
- Required real headless WIP 76 browser suite: blocked by environment `ERR_BLOCKED_BY_ADMINISTRATOR` on local/file navigation; no browser pass is claimed and no screenshots were produced.
- Required WIP 76 after-fix hero measurement (4/4 at 1280x800 and 4/4 at 360x740).
- Full WIP 73/74 regression suite, panel scenarios, safety panel, Open/Share computed styles, focus/hover/share/clipboard/navigation/sessionStorage/security checks, and screenshots.
- `scripts/selftest.js` to 266/0; blocked by missing `dotenv`.
- Real backend, database, real assistant service, and real card data.
- Physical-device behavior.

## Exact next step
**WIP 77 = act on D1 if REDESIGN IN WIP 77 is chosen, plus anything the real-backend run still shows.** If D3 is later changed from NO to YES, use a small follow-up WIP for the panel-open answer-in-view rule instead of changing it here.

# Nexi WIP 77 checkpoint log

- **WIP:** 77 — checkpoint after the WIP 76 instant-scroll fix. No client code change was made in this WIP because D1–D4 use their defaults and the supplied user-report rows contain only template placeholders.
- **Scope:** Client-only. `js/assistant.js`, `css/assistant.css`, and `service-worker.js` were not changed. Only `WIP_LOG.md` was updated. No HTML, `js/main.js`, other JS/CSS, `ai-assistant/`, or `nextastore-backend/` files were changed.

## Decisions and user report
- D1 = **KEEP**. No card redesign.
- D3 = **NO**. Step 2 was skipped; the existing panel-open bottom scroll remains unchanged.
- D4 = **LOG ONLY**. No hero 360px layout change was made.
- User report: all supplied rows remain template questions/placeholders. **No user report supplied, nothing changed.**

## Step 0 — baseline
- `node --check js/assistant.js`: **passed**.
- `node scripts/selftest.js`: **could not run to 266/0** because the archive does not have the `dotenv` dependency installed (`Cannot find module 'dotenv'`). No 266/0 result is claimed.
- Read only: `syncThread()` still contains the WIP 76 `writeScroll` helper and all three existing writes use it. The panel-open line near `open()` remains `panelParts.body.scrollTop = state.messages.length ? panelParts.body.scrollHeight : 0;`.
- Read only: `css/assistant.css` still has the hero/general `.nexi-thread { scroll-behavior: smooth; }` rule. No CSS was edited.

## Step 1 — no scroll change
The WIP 76 hero regression is already fixed and was measured by the user. No scroll code was changed in WIP 77.

### Measured by the user on the WIP 76 zip
| Scenario | WIP 76 result | WIP 75 comparison |
|---|---:|---:|
| Hero 1280x800, second short answer + 1 card, no-delay cards timing | gap 0, **4/4** | gap 134, **4/4 failed** |
| Hero 360x740, second short answer + 1 card, no-delay cards timing | gap 0, **4/4** | gap 157, **4/4 failed** |
| Hero thread computed `scroll-behavior` | `smooth` | — |
| Page errors in those tests | none | — |

Timing note supplied by the user: the WIP 75 regression only appeared when the cards event came right after the last token. With cards 300–1800 ms later, WIP 75 also passed. The WIP 76 fix therefore remains untouched.

## Step 2 — panel reopen
Skipped because D3 = **NO**. The panel still scrolls to the bottom when messages exist. If D3 is later changed to YES, use a small follow-up WIP for the panel-open answer-in-view rule.

## Step 3 — hero 360px observation
D4 = **LOG ONLY**. The previously observed issue remains: at 360x740 the hero's first card can be barely visible and the composer can sit below the fold. No CSS/layout change was made and no before/after values are claimed.

## Step 4 — user report
No actual report was supplied, so no client or server issue was changed. No backend/server file was touched.

## Step 5 — cache
No `js/` or `css/` file changed, so `service-worker.js` remains at **`CACHE_VERSION = 'v54'`**. No cache bump was made.

## Verification
### Tested and passed
- `node --check js/assistant.js`.

### Read only
- WIP 76 `syncThread()` `writeScroll` helper and its three writes.
- WIP 76 panel-open scroll line.
- WIP 76 CSS hero/thread and card regions.
- The user's real-browser measurements of WIP 76 listed above.

### Not tested
- Browser measurement: intentionally not attempted in WIP 77, per instruction. No browser result is claimed.
- Panel scenarios, safety.html panel, Open/Share styles, focus/hover/share/clipboard/navigation/sessionStorage/security checks.
- Full WIP 73/74 regression list.
- `scripts/selftest.js` 266/0 because `dotenv` is unavailable.
- Real backend, database, assistant service, and real card data.
- Physical-device behavior.

## Diff / packaging check
- Compared the WIP 77 working tree against the supplied WIP 76 archive: only `WIP_LOG.md` differs.
- No `node_modules` or test harness was added to the package.

## Exact next step
**Next step: browser measurement of whatever WIP 77 changes — currently only the unchanged WIP 76 behavior — plus anything the real-backend run still shows.** If the user later chooses D1 = REDESIGN, WIP 78 (or the next agreed WIP) can handle the whole-card-tap proposal. If D3 changes to YES, use a small follow-up WIP for the panel-open answer-in-view rule.
