# NextaStore AI Assistant

> **WIP 59 (read first):** the assistant is now **fully local**. Hosted Luganda (Sunbird) was removed, and the knowledge search is a built-in
> keyword search that needs **no embedding model, no index and no `npm run reindex`**: edit or add a file in `src/knowledge/` and it is live within a second or two.
> **WIP 60:** platform facts (Seller Pass price, trial, cancel rule, order statuses, badge tiers) are copied from the backend automatically into `src/knowledge/90-project-facts.generated.md` every few minutes (`FACTS_SYNC_MS`); never type those numbers into the other knowledge files.
> Current production plan and deployment profiles: `WIP_NEXI_PLAN_v2.md`. Older sections below that mention
> `reindex`, `bge-m3` or Sunbird describe the previous design; the optional `RETRIEVAL=hybrid` mode keeps the embedding path alive if you ever want it.

> **WIP 53:** this service is now wired into the site (hero chat + floating assistant on every page). Read section 0 first.
>
> **WIP 54:** Luganda replies can now run on your own server (Ganda Gemma 1B), and there is a ready-made setup for an 8 GB VPS. Read section 0b, then `DEPLOY_VPS.md`.

A local, self-hosted assistant for the NextaStore platform. It runs entirely
against a local [Ollama](https://ollama.com) instance on your own machine or
server — **no external AI API, no per-message cost, no customer data leaving
the box it runs on.** You control the model, the knowledge it has, and the
data it sees.

This folder is a standalone deliverable. It doesn't touch any of your
existing NextaStore files. When you're ready, you drop two files
(`widget/assistant-widget.js` + `.css`) into your real pages and point them
at wherever you run this service. Nothing here assumes that's done yet.

---

## 0. WIP 53: how it is wired into NextaStore

```
browser (js/assistant.js)
   -> nextastore-backend  /api/assistant/*   (rate limited, validates input, strips client "system" roles)
        -> this service    http://127.0.0.1:4100  (Ollama + knowledge base; everything runs on this machine)
```
- **Run it:** `cd ai-assistant && npm install && npm start`, with `ollama serve` running.
  In `nextastore-backend/.env` set `ASSISTANT_URL=http://127.0.0.1:4100` (that is also the default).
- **No reindex needed any more** (WIP 59): knowledge files (08 first store, 09 what to sell, 10 selling tips, 11 shopping tips and the rest) are read straight from `src/knowledge/`
  and reload by themselves.
- **Keep this service private.** Only the backend should reach it (same machine / private network). Don't expose port 4100 publicly:
  the rate limits live in the backend proxy.
- **Streaming:** `POST /api/assistant/chat/stream` (newline-delimited JSON events: meta, token, done, error). `POST /chat` still works for the old widget.
- **What Nexi does now:** platform help (only from the knowledge base) **and** advice for sellers and shoppers (what to sell, first store, pricing, photos,
  first customers, buying safely). Platform facts and general advice are kept apart in the prompt; it must not invent figures or promise income.
  The browser also tells it whether the visitor is a guest, buyer or seller and which page they are on.
- **Tests (no Ollama needed):** `npm run selftest` runs the real pipeline against a mock Ollama and mock Sunbird.
  It proves plumbing, not answer quality.

### Luganda: the no-hand-review plan
Nobody on the team has to write or check Luganda by hand:
1. **Chat answers.** Set `SUNBIRD_API_KEY`. Luganda questions go Luganda -> English (Sunbird Sunflower), are answered in English from the knowledge
   base by the local model, then translated back to Luganda by Sunflower. Sunflower is trained for Ugandan languages and is the right tool for this;
   a generic 7B model is not. Links stay intact.
2. **Conversation starters.** Run `SUNBIRD_API_KEY=... npm run translate:starters`. It regenerates the Luganda starters from the English ones
   and stamps `lg_status` in `src/lang/starters.json`. The site picks them up from `/api/assistant/starters`.
3. **Without a key** (today's default): Luganda questions get an English answer plus a short note. The shipped Luganda starters are *drafts* until step 2 is run.
- **Honest limits:** this is machine translation. It is much better than a generic model but not human-verified. Money, policy and safety answers should
  be spot-checked by a Luganda speaker once, and the exact-match phrasebook (`luganda-phrasebook.json`) still wins whenever it has a curated answer.
  The Sunbird API's terms, price and free-tier limits were not verified here: check them before launch.
- **Privacy:** with a key set, Luganda messages and their answers are sent to Sunbird. English chats stay local. Mention this in your privacy policy.

## 0b. WIP 54: Luganda on your own server + VPS deployment

- **New:** set `GANDA_MODEL=crane-ai-labs/ganda-gemma-1b:q4-k-m` (after `ollama pull` of it) and Luganda questions are answered like this:
  phrasebook hit -> curated answer; otherwise the chat model answers in **English** from the knowledge base, then Ganda Gemma 1B translates that answer into
  **Luganda on this machine**, sentence by sentence (each sentence streams as soon as it is done). No customer message leaves the server.
- **Safety rails** (`src/lang/localTranslate.js`): links are protected, layout and bullets are kept, and a sentence stays **English** if the translator changes a
  number, drops a link, or just repeats the English. A note says when part of an answer is in English. Human-approved pairs in `src/lang/translation-memory.json` win over the model.
- **Limit:** Ganda Gemma only *writes* Luganda. It cannot translate Luganda *questions* into English, so those rely on the phrasebook, the Luganda/Swahili word list in
  `src/lang/retrieval-lexicon.json` (used only to find the right knowledge section) and a prompt hint. Nothing is sent to an outside service.
- **`LUGANDA_PROVIDER`:** `auto` (default) = local if `GANDA_MODEL` is set, else English + note. Or force `local` or `off`. (`sunbird` was removed; an old value is treated as `off`.)
  `MAX_REPLY_TOKENS_LG` keeps answers that will be translated short, because translation time grows with length.
- **Measure before you pay:** `npm run bench` prints real speed, then run `free -h` and `ollama ps`.
- **Review loop:** `LOG_LUGANDA_MISSES=true` stores Luganda questions the phrasebook missed (on this server only); `npm run lg:misses` turns them into a CSV for a Luganda speaker.
- **Server hardening:** `HOST=127.0.0.1` (listen only locally) and an optional `ASSISTANT_TOKEN` shared secret (the backend proxy sends it as `x-assistant-token`
  when its own `ASSISTANT_TOKEN` matches). The stream now also sends `status` pings (`thinking`, `translating`); the browser ignores unknown event types.
- **Fixed:** `OLLAMA_KEEP_ALIVE=-1` from a `.env` file was sent to Ollama as the *string* "-1", which Ollama can reject; it is now sent as the number -1.
- **Deploy:** `.env.vps.example`, `deploy/setup-vps.sh`, `deploy/nextastore-ai.service`, `deploy/ollama-override.conf`, `deploy/Caddyfile.example` and `DEPLOY_VPS.md`.
- **Tests:** `npm run selftest` is now 52 checks (adds a mock Ganda Gemma, number/link protection, memory, token, miss log).

## 1. Why Ollama (and not an API)

You said you don't want to depend on an external API — that's the right
call for a customer-support assistant that will see real questions about
orders, payments, and accounts:

- **No per-message cost** — the free trial anxiety a Seller Pass buyer feels
  about UGX doesn't need to apply to you running an assistant.
- **No data leaves your infrastructure** — nothing about a real user's
  question goes to a third-party API by default.
- **Works offline / on a bad connection** — relevant given the platform's
  own audience.
- **You own the roadmap** — swapping models, fine-tuning later, or running
  this on your own server when you scale is entirely in your hands.

Ollama specifically (over raw llama.cpp or vLLM) because it has the best
"just works" story for a small team: one install, `ollama pull <model>`,
and a stable local HTTP API. If you outgrow it later, everything Ollama-
specific in this project lives in **one file** — `src/ollama/client.js` —
so switching to vLLM/LM Studio/etc. is a contained change, not a rewrite.

## 2. Choosing a model

Set these in `.env` (copy `.env.example` first). Defaults are already
filled in — you only need to change them if your hardware is different or
you want to experiment.

| VPS profile | Chat model (`CHAT_MODEL`) | Key settings |
|---|---|---|
| **4 GB RAM, CPU only** | **`qwen2.5:1.5b-instruct`** | BM25, `NUM_CTX=2048`, `MAX_CONCURRENT=2`, Ganda Gemma off, 2 GB swap |
| **8 GB RAM, CPU only** | **`qwen2.5:3b-instruct`** | BM25, `NUM_CTX=2048`, `MAX_CONCURRENT=2`, optional local Ganda Gemma |
| Larger hardware | Choose a larger local model manually | Not part of the supported VPS profile; measure before changing the shipped defaults. |

Why Qwen2.5 as the default rather than Llama: Qwen's multilingual training
mix is broader, which matters directly for your Swahili/French users even
before you get to the Luganda problem below — Llama models tend to be more
English-centric at the same size. If your team has a strong preference for
Llama (e.g. familiarity, licensing), `llama3.1:8b-instruct` is a fine
substitute — just change `CHAT_MODEL`.

**Embedding model (optional since WIP 59):** the default search is keyword-based and needs none. Only if you set `RETRIEVAL=hybrid`, `bge-m3` (`EMBED_MODEL`) turns
your knowledge-base text and user questions into vectors for retrieval. It's
genuinely multilingual (100+ languages) — a common mistake is using an
English-only embedder like the plain `nomic-embed-text`, which quietly makes
retrieval worse for every non-English question even if the chat model
itself could have handled the language fine.

```bash
ollama pull qwen2.5:1.5b-instruct   # light default; qwen2.5:3b-instruct on an 8 GB machine
# ollama pull bge-m3                # only for the optional RETRIEVAL=hybrid mode
```

## 3. Being honest about Luganda

You asked for local-language support, specifically Luganda. I looked into
this properly before building anything, and want to be straight with you
rather than quietly ship something that looks like it works and doesn't:

**No general local model — Qwen, Llama, Gemma, Mistral, gpt-oss, none of
them — is genuinely fluent in Luganda today.** Independent benchmarking
(IrokoBench, AfriMMLU) specifically calls out Luganda as one of the
lowest-resourced languages even among African languages, because there's
very little Luganda text on the internet to train on in the first place.
Ask any of these models a Luganda question and you'll sometimes get
something usable and sometimes get confident, fluent-sounding nonsense —
which is worse than an honest "I don't know" for a marketplace where wrong
answers involve real money.

So rather than pretend the model handles Luganda and hope for the best,
this project uses a **three-layer, most-trustworthy-first approach**:

1. **Detection** (`src/lang/detect.js`) — a small keyword list flags a
   message as likely Luganda or Swahili. Simple on purpose, and easy for a
   non-engineer to extend (add a word to the list).
2. **Curated phrasebook** (`src/lang/luganda-phrasebook.json`) — for the
   ~15 most common things people will actually ask (how to buy, how to pay,
   how to sell, tracking an order, forgot password, safety, etc.), the
   assistant answers with a **fixed, human-reviewable Luganda string**
   instead of letting the model improvise. This guarantees your most
   frequent traffic gets a correct, consistent answer regardless of how
   good the underlying model's Luganda actually is.
   **Important: I wrote a first draft of these translations myself. I am
   not a native Luganda speaker and neither is the model — every entry is
   flagged `"needs_review": true` and must be checked by a fluent speaker
   before this goes in front of real users.** Treat the current file as a
   structural template with placeholder content, not a finished product.
3. **Model fallback** — anything that doesn't match the phrasebook still
   gets an answer from the LLM, instructed to keep sentences simple and to
   add a short English clarification rather than risk a confidently wrong
   translation of something about money or policy (see
   `src/chat/systemPrompt.js`).

### Upgrading this later
If/when you want real fluency instead of a safety net, two concrete paths,
both still fully local:

- **A Luganda-specific model as a GGUF import into Ollama.** Research
  groups have started publishing Luganda-tuned models (e.g. "ugGPT", built
  specifically for Luganda, and the "AfriqueLLM"/"Lugha-Llama" family
  adapting Llama 3.1 for African languages). If/when one of these is
  published with (or convertible to) GGUF weights on Hugging Face, you can
  `ollama create` a custom model from it with a one-line Modelfile and set
  it as a second model just for Luganda traffic. Check Hugging Face for the
  latest state of these — this is a fast-moving research area.
- **A local NLLB-200 translation bridge.** Meta's NLLB-200 (No Language
  Left Behind) is a free, local, open-weight translation model that
  explicitly includes Luganda (`lug_Latn`) among its 200 languages, unlike
  most embedding/chat models. The idea: translate the incoming Luganda
  message to English with a small local NLLB model, run it through the
  normal English pipeline (which is much stronger), then translate the
  reply back. This is more engineering work than what's here today, but is
  a well-understood pattern and stays 100% local (runs via `transformers`
  in Python, no API). Worth doing once Luganda volume justifies it.

**Update (WIP 54):** the first path is now built for the *output* side: Ganda Gemma 1B
(`crane-ai-labs/ganda-gemma-1b`, an English/Luganda model on Gemma 3 1B) runs through
Ollama and writes the Luganda reply (see section 0b). The NLLB bridge for Luganda *input* is
still not built: it needs a Python service, about 1.5 GB more RAM, and a bigger server than 8 GB
if all other models stay loaded. `src/lang/translator.js` is where it would plug in.

## 4. Setup

```bash
# 1. Install Ollama if you haven't: https://ollama.com/download

# 2. Pull the chat model (keyword search needs no embedding model)
ollama pull qwen2.5:1.5b-instruct

# 3. In this folder:
npm install
cp .env.example .env          # defaults are fine to start

# 4. Sanity check Ollama is reachable and models are present
npm run check-ollama

# 5. Run the assistant (knowledge files in src/knowledge/*.md are read and reloaded automatically)
npm start
# -> NextaStore AI Assistant listening on http://localhost:4100
```

Then open `widget/demo.html` directly in a browser (no server needed for
this static file) to try the widget end-to-end without touching your real
site. Try an English question, then try a Luganda one (e.g. `"engeri
y'okugula"`) to see the phrasebook kick in.

## 5. How "stay up to date as we ship features" actually works

There's no training or fine-tuning here — that would make "stays current"
a slow, expensive process. Instead:

- **`src/knowledge/*.md`** is the assistant's entire factual memory of how
  the platform works. When a feature ships or changes, edit the relevant
  file (see `KNOWLEDGE_EDITING_GUIDE.md` for how to write good entries),
  done. The next matching question is answered from
  the new text — no reindex and no restart needed.
- **`src/tools/liveFacts.js`** goes one step further for things that change
  from the admin console rather than a code deploy — payment methods being
  the concrete example already wired up, since that's exactly what your
  `dynamic-payment-methods` branch is building. When someone asks a
  payment-related question, the assistant calls your real backend's
  `GET /api/payments/methods` live and answers with what's actually enabled
  right now, instead of a static (and potentially stale) doc. This is
  deliberately a narrow, hand-picked set of "safe to fetch live" facts —
  see the comment at the top of that file before adding more, so the model
  never gets to construct arbitrary requests against your real API.
- The system prompt (`src/chat/systemPrompt.js`) is written so that if a
  question touches something not covered by either of the above, the
  assistant says it doesn't know rather than guessing.

## 6. Connecting real account data (not done yet, on purpose)

Right now this assistant knows nothing about any individual user — no order
history, no balance, no messages. That's a deliberate default, not a
missing feature: wiring in real account data safely needs a few decisions
made on purpose rather than by default:

- The assistant backend would need to receive and **verify** the same JWT
  your main API uses (see `nextastore-backend/src/routes/auth.js` for how
  tokens are issued), never trust a user ID sent in the request body.
- Any per-user data fetched should go through narrow, purpose-built
  endpoints (e.g. "this user's last 5 orders"), the same pattern as
  `liveFacts.js` above — never a generic "run this query" tool.
- Decide what's in scope. "What's the status of my last order" is probably
  fine to automate. "Why was my payment rejected" probably still needs a
  human, per the ground rules already in the system prompt.

Happy to build this out as a phase 2 once the core assistant is live and
you've seen what people actually ask it.

## 7. Adding the widget to your real pages (later, as you said)

When you're ready — this needs nothing from this backend to change:

```html
<link rel="stylesheet" href="/path/to/assistant-widget.css">
<script>
  window.NextaAssistantConfig = { apiBase: 'https://your-domain.example/api/assistant' };
</script>
<script src="/path/to/assistant-widget.js"></script>
```

Two lines added to whichever pages you want it on (or your shared layout,
if the codebase has one) — it renders itself as a floating bubble bottom-
right, matching your existing brand colors from `css/main.css`, and doesn't
require any change to `js/main.js` or your existing auth/session code.

## 8. Project layout

```
ai-assistant/
├── server.js                    # entry point (npm start)
├── src/
│   ├── config.js                # every tunable, all env-driven
│   ├── app.js                   # Express app
│   ├── ollama/client.js         # the ONLY file that talks to Ollama
│   ├── rag/                     # chunking, bm25.js keyword search, retrieve.js (auto-reloads knowledge; optional hybrid)
│   ├── knowledge/*.md           # the assistant's factual memory — edit these
│   ├── lang/                    # detection, phrasebook, translator.js (local only), localTranslate.js, translation-memory.json, retrieval-lexicon.json
│   ├── chat/                    # system prompt + orchestration pipeline
│   ├── tools/liveFacts.js       # narrow bridge to the real backend's live data
│   └── routes/assistant.js      # POST /api/assistant/chat, GET /health
├── scripts/                     # reindex (hybrid mode only), check-ollama, bench, lg:misses export, selftest
├── deploy/                      # setup-vps.sh, systemd unit, Ollama override, Caddy example
├── DEPLOY_VPS.md                # step by step for an 8 GB VPS
├── .env.vps.example             # ready-made settings for that VPS
├── widget/                      # assistant-widget.js/css + demo.html
└── KNOWLEDGE_EDITING_GUIDE.md
```

## 9. What I'd do next, roughly in order
1. Get a fluent Luganda speaker to correct `src/lang/luganda-phrasebook.json`.
2. Run it for real for a week or two against the actual site and see what
   people actually ask — you'll almost certainly find gaps in
   `src/knowledge/` faster than you'd find them by guessing up front.
3. Add streaming responses in the widget (the backend already supports it
   in `ollama/client.js`'s `chatStream`, just not wired to the route yet)
   so replies feel instant instead of arriving all at once.
4. Consider the NLLB translation bridge once you see real Luganda volume.
5. Decide on the phase-2 "real account data" scope from section 6.

## Staying on topic: flagging irrelevant questions (WIP 55)

Nexi only helps with NextaStore, buying, selling and starting a small business. Every message is checked **before** the model runs
(`src/chat/relevance.js`, no model, microseconds), so a flagged message costs nothing and always gets the same safe, curated reply (`src/chat/canned.js`).

| Flag | Meaning | Example |
|---|---|---|
| `off_topic` | clearly another subject, no store/selling words in it | homework, coding, football, politics, jokes, medical/legal advice |
| `inappropriate` | abusive or sexual language | |
| `sensitive` | the person is *sharing* a password, PIN/OTP or card number (asking "how do I reset my password?" is fine) | |
| `manipulation` | trying to override Nexi's instructions or read its prompt | "ignore all previous instructions..." |
| `unclear` | keyboard mashing, no readable words | |

- **Conservative on purpose:** if a message mentions stores, selling, prices, payments, delivery and so on (English or Luganda), it is never flagged as off-topic
  ("What is the best football jersey to sell?" passes). Short follow-ups (3 words or fewer) inside a store conversation pass too.
- **Second net:** the system prompt asks the model to start its reply with `[OFF_TOPIC]` when it judges the question unrelated. The pipeline strips the marker
  (it is never shown) and flags the turn, unless the message has store/selling vocabulary.
- **Conversation flag:** 3 or more flagged questions among the last 5 mark the whole conversation as drifting (`flag.conversation: true`). The service is stateless, so it re-checks the user turns the browser sends back as history.
- **API:** `done` events (and the plain `/chat` JSON) carry `flag: { type, reason, conversation, source }` when a turn was flagged. Nothing changes for unflagged turns.
- **Review loop (opt-in):** `LOG_FLAGGED_MESSAGES=true` keeps one JSON line per flagged message in `data/flagged.jsonl` (type, reason, page, audience, language, text cut to 200 characters;
  no account id, IP or history; **a shared password / card number is never stored**). `npm run flags` prints a summary and writes a CSV; `npm run flags -- 7` = last 7 days.
- **Luganda wording:** the curated Luganda replies in `canned.js` were written by hand and are **not reviewed by a native speaker**. Please have one check them.
- **Tuning:** the word lists live at the top of `relevance.js`. If a real question is wrongly flagged, add its words to `ON_TOPIC_TOKEN`; if something off-topic slips through, add a pattern to `OFF_TOPIC_PATTERNS`. `npm run selftest` covers both directions.
