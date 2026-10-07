# Deploying the assistant on a VPS (8 GB RAM, 4 vCPU, CPU only)

Written for the OVHcloud VPS-2 class machine (4 vCore, 8 GB RAM, 75 GB NVMe) but any Ubuntu 22.04/24.04
server with the same size works.

**Status of this guide:** the code is tested against mock servers (`npm run selftest`).
The setup script passed `bash -n` and shellcheck but has **not** been run on a real server, and the real
speed of the models on your CPU has not been measured. Do the "Before you pay" step first, and expect to
fix one or two small things on the first real run.

## Before you pay (15 minutes, free)

On your own computer, with Ollama running and the models pulled (no embedding model is needed any more):

```bash
ollama pull qwen2.5:3b-instruct
ollama pull crane-ai-labs/ganda-gemma-1b:q4-k-m
cp .env.vps.example .env        # then set HOST=0.0.0.0 and ASSISTANT_TOKEN= (empty) for local testing
npm install
npm run bench                   # in a second terminal while it runs:  free -h   and   ollama ps
```

`npm run bench` prints the chat speed in tokens/second and the time for an English question and a Luganda
question. A cloud VPS CPU is usually a bit slower than a modern laptop, so leave margin. If an English answer
takes more than about 20 seconds on your laptop, the VPS will feel slow: use a smaller chat model
(`qwen2.5:1.5b-instruct`) or a bigger plan.

## Pick a layout

**A. Everything on one VPS (recommended to start).** Backend, database and assistant on the same machine.
The assistant listens only on 127.0.0.1, nothing about it is public. Use `ASSISTANT_URL=http://127.0.0.1:4100`.

**B. Assistant alone on the VPS, backend elsewhere.** Then the assistant must be reachable over the internet.
Use `deploy/Caddyfile.example` (HTTPS), keep `ASSISTANT_TOKEN` set on both sides, and never open ports
4100 or 11434.

## Install

1. Buy the server. Pick **No commitment** for the first month or two; switch to 6 or 12 months once the
   real memory use and speed are proven.
2. Log in over SSH, upload and unzip the project (or `git clone`), then:

```bash
cd NextaStore*/ai-assistant
sudo bash deploy/setup-vps.sh --firewall
```

It adds 4 GB of swap, installs Node 22 and Ollama (locked to 127.0.0.1, models kept loaded), creates a
service user, installs the app in `/opt/nextastore-ai`, writes `.env` with a fresh `ASSISTANT_TOKEN`, pulls the
models and starts the `nextastore-ai` service (knowledge search is built in, there is no index to build). The first run downloads
a few GB, so allow some time. Re-running it later is safe.

3. Edit `/opt/nextastore-ai/.env`: set `CORS_ORIGIN` to your real site address, then
   `sudo systemctl restart nextastore-ai`.
4. In `nextastore-backend/.env` set:

```
ASSISTANT_URL=http://127.0.0.1:4100
ASSISTANT_TOKEN=<the value the script printed; it is also in /opt/nextastore-ai/.env>
ASSISTANT_TIMEOUT_MS=150000
```

## Check it

```bash
sudo -u nexi bash -c 'cd /opt/nextastore-ai && npm run check-ollama'
curl -s -H "x-assistant-token: $(grep ^ASSISTANT_TOKEN /opt/nextastore-ai/.env | cut -d= -f2)" http://127.0.0.1:4100/api/assistant/health
free -h
ollama ps
```

You want: every model you use listed by `ollama ps`, at least 1.5 GB "available" in `free -h` while idle, and
swap barely used. If swap use keeps growing, drop to `qwen2.5:1.5b-instruct` or upgrade the plan.

## Production VPS profiles

| Profile | Model | RAM guard | Retrieval | Concurrency |
|---|---|---|---|---|
| 4 GB | `qwen2.5:1.5b-instruct` | 2 GB swap; Nexi Node `MemoryMax=400M` | BM25 | 2 |
| 8 GB | `qwen2.5:3b-instruct` | 4 GB swap target | BM25 | 2 |

`deploy/setup-vps.sh` reads `free -m`: below 6000 MB selects the 4 GB profile; otherwise it selects the 8 GB profile. It prints the selected profile. `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_FLASH_ATTENTION=1`, and `OLLAMA_NUM_PARALLEL=2` are installed by the Ollama override.

## How Luganda works here

- **Phrasebook first.** Common questions get the curated answer instantly.
- **Everything else:** the chat model answers in English from the knowledge base, then Ganda Gemma 1B
  translates it into Luganda on the server, one sentence at a time, so words appear as each sentence is finished.
- **One loaded model means swapping (expected, not measured).** `deploy/ollama-override.conf` sets
  `OLLAMA_MAX_LOADED_MODELS=1`. With one slot, a Luganda question that misses the phrasebook makes Ollama swap
  between the chat model and the Ganda model, which costs seconds. From how Ollama schedules models, a Ganda request
  sent while the English answer is still streaming is expected to wait for the chat request to finish (and then wait
  for the swap), so nothing is gained by starting it early. For that reason Nexi finishes the English answer first
  and only then translates (`LUGANDA_INTERLEAVE=false`, the default). Setting `LUGANDA_INTERLEAVE=true` translates
  sentences while English is still streaming; use it only after `OLLAMA_MAX_LOADED_MODELS=2` is set AND the machine
  has enough RAM for both models. This guide does not claim the 4 GB profile can hold both. Measure on the real
  machine: `free -m`, `ollama ps` and `npm run bench` (it prints the time to the first Luganda text).
- **Safety rails:** a sentence is kept in English if the translator changes a number, loses a link or just
  repeats the English. If that happens to part of an answer, a note says some parts are in English.
- **Limit you should know about:** Ganda Gemma only produces Luganda. It cannot read Luganda questions
  into English. Those are understood through the phrasebook, the Luganda/Swahili word list used by the
  knowledge search (`src/lang/retrieval-lexicon.json`) and a prompt hint to the chat model, which is decent
  for simple questions and weaker for long or unusual ones. Nothing is ever sent to an outside translation service.
- **Quality:** its published score is modest in absolute terms (BLEU about 7, chrF++ about 40 on English to
  Luganda). It is among the best small open options, but it is not human quality. Have a Luganda speaker
  read real answers, especially anything about money, and put approved wording in
  `src/lang/translation-memory.json`.
- **Review loop:** with `LOG_LUGANDA_MISSES=true`, run `npm run lg:misses` weekly for a CSV of the most
  common unanswered Luganda questions. Approved answers go into the phrasebook.

## Day to day

| Task | Command |
|---|---|
| Logs | `journalctl -u nextastore-ai -f` |
| Restart | `sudo systemctl restart nextastore-ai` |
| Memory | `free -h` and `ollama ps` |
| After editing `src/knowledge/*.md` | nothing: the assistant reloads knowledge files by itself within a second or two |
| Update the code | upload the new folder, run `sudo bash deploy/setup-vps.sh --skip-models` again (keeps `.env`) |

## If something goes wrong

- **Slow answers:** instant small talk/FAQ/cache paths should start quickly. When the CPU model is saturated, Nexi uses a local knowledge fallback instead of exposing load state. If model answers remain slow, lower `MAX_REPLY_TOKENS` or use the 4 GB profile.
  You can move only Ollama to a stronger machine by changing `OLLAMA_HOST` (keep it private with a VPN or SSH tunnel).
- **Luganda answers come back in English with a note:** run `check-ollama`; the Luganda model is probably not pulled.
- **Out of memory kills:** `journalctl -k | grep -i oom`. Switch to the 1.5B chat model, or turn Luganda off with `LUGANDA_PROVIDER=off`.
- **Turn the Luganda model off quickly:** set `LUGANDA_PROVIDER=off` in `.env` and restart.

## Not verified (please check before launch)

- Real tokens per second on the VPS CPU, and the true memory use with all three models loaded.
- The OVHcloud price, billing terms and any setup fees at checkout.
- The Luganda quality on your real questions.
- `setup-vps.sh` on a clean server.
