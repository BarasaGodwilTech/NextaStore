# WIP: Nexi plan v2 - local light model, instant paths, self-updating knowledge

Status: **Phases 1 (WIP 59), 2 (WIP 60), and 3 (WIP 62) are done**. WIP 62 adds instant paths, FAQ matching, cache/merge, silent load fallback, fairness, and the supported 4 GB/8 GB CPU profiles. Replaces `WIP_NEXI_SPEED.md` (its speed analysis is folded in below).

### Phase 1 - what changed in the code
- Hosted Luganda (Sunbird) removed: `src/lang/sunbird.js` deleted, config/pipeline/translator/docs/scripts cleaned. An old `SUNBIRD_API_KEY` or
  `LUGANDA_PROVIDER=sunbird` in `.env` is ignored with a start-up note. Link protection moved to `src/lang/links.js`.
- Keyword search: `src/rag/bm25.js` + `src/rag/retrieve.js` (in memory, reloads when a knowledge file or the lexicon changes, keeps the last good
  index if a file is caught half-saved, returns nothing instead of junk when nothing matches). `RETRIEVAL=bm25` is the default; `RETRIEVAL=hybrid`
  keeps the old embedding path as an optional blend that falls back to keywords on any problem.
- `src/lang/retrieval-lexicon.json`: Luganda and Swahili words mapped to English search words so those questions find the right section. Needs one
  Luganda/Swahili speaker's review (a wrong entry only costs search relevance).
- No embedding model by default: `start.bat`, `env-for-bat.js`, `ensure-index.js`, `reindex.js`, `check-ollama.js`, `server.js`, `deploy/setup-vps.sh`,
  `.env.example`, `.env.vps.example` updated. `npm run reindex` is a no-op unless `RETRIEVAL=hybrid`.
- Light default model `qwen2.5:1.5b-instruct`, `RAG_TOP_K` default 3, chat model warm-up at start-up.
- `scripts/selftest.js` updated: keyword search, Luganda/Swahili lexicon, new/edited/deleted/half-written file reload, hybrid fallback.
- Your own `.env` was NOT changed (it still says `llama3.2:3b` and has the stray-space `G ANDA_MODEL` line).

### Phase 2 - what changed in the code (WIP 60)
- Backend: `nextastore-backend/src/platformRules.js` (new, no dependencies) holds the Seller Pass price, trial days, purchasable month-blocks, tier months and perks, order statuses and
  their buyer-facing labels, seller transitions, buyer cancel rule (window, limit, rolling days), fulfilment methods, listing types and onboarding steps. `helpers.js`, `routes/orders.js` and
  `validation.js` now import from it instead of owning copies. `src/assistantFacts.js` + `GET /api/assistant/facts` (public, read-only, ETag, 60 s cache) serve `buildFacts()`; platform rules only.
- Nexi: `src/sync/factsSync.js` fetches the endpoint at start-up and every `FACTS_SYNC_MS` (default 5 min, `0` = off), validates it, renders `src/knowledge/90-project-facts.generated.md`
  (one `##` section per topic) and writes it atomically, only when the text changed. A failed fetch, bad status or malformed payload never touches the file. Keyword search picks it up by itself.
  `npm run facts:seed` rebuilds the shipped copy from the backend source without a server.
- Hand-written files `01`, `02`, `04`, `05`, `07`, `08` no longer state numbers or status names; the stale claims are fixed (see the list at the bottom, all done).
- Two Luganda phrasebook answers that state outdated rules (`cancel_order`, `seller_badge`) are switched off (`"disabled": true`) until a Luganda speaker rewrites them; those questions now go through the normal path.
- Tests: `npm run selftest` (sync, failure handling, hot reload, drift check) and `nextastore-backend`: `npm run test:assistant-facts` (23 checks, includes front-end label drift).

## What changed from the previous plan

| Topic | Before | Now |
|---|---|---|
| Chat model | Local default + optional hosted API (`LLM_PROVIDER=openai`: Groq, OpenRouter...) | **Local only.** The hosted option is dropped. No chat text goes to a third-party model. |
| Luganda | Local Ganda Gemma, or Sunbird (hosted) | **Local or off.** Sunbird is removed from the defaults and docs. |
| Online access | Not planned | **Local only. No web-search integration.** |
| Knowledge base | Hand-edited files + reindex; auto-sync planned as the last step | **Self-updating is the core design** (section 2). Nobody should have to remember to edit it. |
| Retrieval | `bge-m3` embeddings + `index.json` + reindex | **In-memory BM25, rebuilt automatically.** No embedding model, no `index.json`, no reindex step. |

## 1. The model: light, local, and kept on a short leash

- Default `qwen2.5:1.5b-instruct` (about 1 GB) on a 4 GB VPS; `qwen2.5:3b-instruct` on 8 GB.
  Only one model loaded (`OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=-1`). Since WIP 61 two answers are written at once (`OLLAMA_NUM_PARALLEL=2`, `MAX_CONCURRENT=2`).
- A small model is weak at remembering facts and weak at deciding when to use tools. So:
  - **Facts never come from the model.** They come from the knowledge base and live data, handed to it in the prompt.
  - **The code decides** when to search the web or call live data (rules below), not the model.
  - The prompt stays short (`RAG_TOP_K` 2-3, truncated chunks, `num_ctx=2048`), and a warm-up call runs at startup.
- Remove `LLM_PROVIDER=openai` from the plan, `.env.example` and README. Set `LUGANDA_PROVIDER=local|off`.
  On 4 GB leave Ganda Gemma off (a second model works against the memory goal); turn it on at 8 GB.

## 2. Knowledge that updates itself (the main change)

Split everything the assistant knows by **how fast it changes** and let a different mechanism own each layer.

### Layer A - facts that live in code: read them from the running backend
Today these are copied by hand into markdown and go stale (see the list at the bottom).
- Add one public, read-only, cached endpoint to `nextastore-backend`, e.g. `GET /api/assistant/facts`.
  It returns values straight from the code that enforces them, so there is a single source of truth:
  - `SUBSCRIPTION_PRICE_UGX`, `TRIAL_DAYS`, `TIER_PERKS` (already exported from `helpers.js`)
  - `CANCEL_GRACE_PERIOD_MS`, `CANCEL_ABUSE_LIMIT` (currently private in `routes/orders.js`; move to `helpers.js` and export)
  - order statuses and the allowed seller transitions, fulfilment types, listing types
  - onboarding step names (move them into one exported array that both `onboarding.html` data and the endpoint use)
- Nexi fetches it at boot, then every 5-10 minutes (and on `ETag` change), and writes
  `src/knowledge/90-project-facts.generated.md`. The BM25 index rebuilds in memory when the file changes.
- If the backend is unreachable, Nexi keeps the last saved snapshot on disk and keeps working.
  Never blank the facts because of a failed fetch.
- Sensitive data stays out: the endpoint returns platform rules only, never user, order or payment records.

### Layer B - facts an admin changes from the console: live data with a short cache
- Keep `src/tools/liveFacts.js` as the pattern: one small, reviewed function per fact, 60-second cache.
- Add to it only where a public endpoint already exists: payment methods (done), dial/payment instructions
  (`platform_settings_dial_instructions`), and anything else admins toggle.
- The model never builds its own URLs against the backend.

### Layer C - advice and how-to prose: hand-written, but with automatic safety nets
- Files in `src/knowledge/` stay for things that are not derivable: tone, selling tips, shopping tips, FAQs.
  Remove every number, fee, limit or status name from them (those belong to Layer A) so they cannot go stale.
- **Hot reload:** a file watcher rebuilds the in-memory BM25 index on any change. No reindex, no restart.
- **Drift test** in `scripts/selftest.js`: fails if a hand-written file states a UGX amount, day count or status
  name that disagrees with the generated facts. This catches a stale line before users do.
- **Gap log:** when retrieval confidence is low and the question is on-topic, record it (same idea as
  `lg-misses.jsonl`). You review one short list now and then instead of hunting for what is missing.

### Result
After this, a code change to a price, trial length, badge tier, cancel rule or admin setting reaches Nexi
within minutes with no knowledge edit. You only write prose when you add a genuinely new concept, and the
gap log tells you when that is.

## 3. Online search: deliberately not part of Nexi

Nexi stays local. Do not add SearXNG, web search, hosted AI, or third-party answer APIs. General advice is answered from the local knowledge base and the model's existing capabilities, while NextaStore platform facts remain grounded in the synced facts.

## 4. Speed and reliability (kept from the previous plan)

1. Instant paths with no model call: greetings, thanks, "who are you", curated FAQ matches; cached answers for
   repeated questions; merge identical in-flight questions.
2. BM25 retrieval in-process (zero extra RAM, under 1 ms). Optional embeddings mode can stay behind
   `RETRIEVAL=bm25|hybrid`, but the default needs no embedding model, so `start.bat` stops downloading `bge-m3`.
3. Never expose load state: if the model is full, times out, or fails, answer from the best local knowledge section. The widget shows only its normal typing indicator while waiting.
4. Concurrency: limiter sized for CPU, one model request per visitor, silent internal waiting, and a local fallback when capacity is unavailable.

## 5. Build order (a WIP zip checkpoint after each phase)

1. **Phase 1 - DONE (WIP 59) - local-only and BM25:** remove hosted provider and Sunbird from code/docs/`.env.example`; BM25 +
   hot reload; delete the reindex dependency; drop `bge-m3` from `start.bat`; model switched to the light default.
2. **Phase 2 - DONE (WIP 60) - self-updating facts:** backend facts endpoint + export the private constants; `sync` job in Nexi;
   generated facts file; rewrite the hand-written files without numbers; drift test; fix the stale facts below.
3. **Phase 3 - DONE (WIP 62) - instant paths, FAQ, cache/merge, fallback answers, fairness, adaptive model path, and 4 GB/8 GB deployment profiles.**
4. **Phase 4 - not planned:** no web search or SearXNG; keep Nexi local.
5. **Phase 5 - future:** gap log and UI-flow facts, only when needed.

Tests to keep green: `ai-assistant/scripts/selftest.js`, `nextastore-backend/scripts/assistant-proxy-test.js`,
`assistant-browser-test.js`. Add tests for: facts sync with backend down, drift detection, search gating
(allowed, blocked for platform facts, blocked for off-topic), and query sanitizing.

## Known stale facts in the guide (all fixed in Phase 2, WIP 60)

Verified in `nextastore-backend`:
- Seller Pass price: **UGX 20,000 per month** (`SUBSCRIPTION_PRICE_UGX`, `helpers.js`). Not in the guide.
- Free trial: **7 days** (`TRIAL_DAYS`). Not in the guide.
- Badge tiers: Verified Seller 6+ months, Gold Partner 12+, Platinum Partner 24+ (`TIER_PERKS`).
  The guide only says "6 months or more -> a badge".
- Order statuses: `pending, processing, shipped, delivered, cancelled` (guide says "confirmed / completed").
  Seller moves: pending -> processing or cancelled; processing -> delivered or cancelled.
- Buyer self-cancel: only `pending`/`processing` orders, **within 30 minutes**, with a reason, max **3 per rolling
  30 days** (`CANCEL_GRACE_PERIOD_MS`, `CANCEL_ABUSE_LIMIT`, `orders.js`). The guide is wrong here.
- Default payment methods: Cash, MTN MoMo, Airtel Money, Card (guide leaves out Cash; the live lookup already
  covers this when an admin changes it).
- Fulfilment is `delivery` or `pickup`; delivery needs an address. Listing types: physical, service, digital.
- Onboarding steps: Store Basics, Branding, Payments, Review and Launch.
- Badge months count continuous paid coverage, not one single purchase (found while building Phase 2; `routes/admin.js`).
- Onboarding is not "submit for review": the last step launches the store, and a store needs at least one product first.
- Subscription payments: seller reports a mobile money payment, a reference can be used once, status
  pending -> approved/rejected by an admin.

## Notes on the current `.env` (still untouched)

- `G ANDA_MODEL=...` has a stray space, so it is ignored ("Luganda model: none"). Leave it until the Luganda
  decision above is made for the VPS size.
- `CHAT_MODEL=llama3.2:3b` is still active; Phase 1 changes the default.
- `NEXTASTORE_API_BASE=http://localhost:4000/api` is what live facts and the new facts sync will use.

## File map

- Pipeline: `ai-assistant/src/chat/pipeline.js`; routes: `src/routes/assistant.js`
- Retrieval: `src/rag/*` (replaced by BM25 in Phase 1); live facts: `src/tools/liveFacts.js`
- Flagging: `src/chat/relevance.js`; canned replies: `src/chat/canned.js`; sanitizer: `src/chat/sanitize.js`
- Widget actually used: `js/assistant.js`; proxy: `nextastore-backend/src/assistantProxy.js`
