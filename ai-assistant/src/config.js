require('dotenv').config();

// One place for every tunable so nothing is hardcoded three files deep.
// Every value has a sane local-first default — this should run with zero
// configuration as long as Ollama itself is installed and running.
// Ollama wants a duration string ('30m') or a NUMBER of seconds. A bare "-1"
// from a .env file is a string, so turn numeric strings into real numbers.
function parseKeepAlive(raw, fallback) {
    const v = String(raw === undefined ? '' : raw).trim();
    if (!v) return fallback;
    return /^-?\d+$/.test(v) ? Number(v) : v;
}

module.exports = {
    port: Number(process.env.PORT) || 4100,
    // 0.0.0.0 keeps LAN/phone testing working on a laptop. On a server set HOST=127.0.0.1.
    host: process.env.HOST || '0.0.0.0',
    // Optional shared secret. When set, every /api/assistant request must send it as
    // the x-assistant-token header (the nextastore-backend proxy does this for you).
    // Needed only if this service is reachable from outside the machine.
    assistantToken: process.env.ASSISTANT_TOKEN || '',

    ollamaHost: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    // Light local model by default (about 1 GB, fits a 4 GB VPS). Use qwen2.5:3b-instruct on 8 GB.
    chatModel: process.env.CHAT_MODEL || 'qwen2.5:1.5b-instruct',
    // Knowledge retrieval. 'bm25' (default) is in-process keyword search: no model, no index file, no reindex.
    // 'hybrid' also blends in embedding similarity and needs EMBED_MODEL pulled plus `npm run reindex`.
    retrieval: ['bm25', 'hybrid'].includes(String(process.env.RETRIEVAL || '').toLowerCase()) ? String(process.env.RETRIEVAL).toLowerCase() : 'bm25',
    // Only used when RETRIEVAL=hybrid.
    embedModel: process.env.EMBED_MODEL || 'bge-m3',

    corsOrigin: process.env.CORS_ORIGIN || '*',

    // Speed/cost guards for a CPU-bound local model (WIP 53).
    maxReplyTokens: Number(process.env.MAX_REPLY_TOKENS) || 200,
    keepAlive: parseKeepAlive(process.env.OLLAMA_KEEP_ALIVE, '30m'), // '30m', or -1 = never unload
    // WIP 61: how many answers are written at once (keep equal to OLLAMA_NUM_PARALLEL), how many people may
    // wait in line, and how long anyone waits before getting a clear "busy" reply instead of a frozen chat.
    maxConcurrent: Number(process.env.MAX_CONCURRENT) || 2,
    maxQueue: Number(process.env.MAX_QUEUE) || 20,
    queueWaitMs: Number(process.env.QUEUE_WAIT_MS) || 6000,
    // Greetings, thanks and "who are you" still go through the model (so they sound alive) but on a lean
    // prompt with no knowledge text, a short reply and a little more variety.
    smallTalkMaxTokens: Number(process.env.SMALLTALK_MAX_TOKENS) || 90,
    smallTalkTemperature: Number.isFinite(Number(process.env.SMALLTALK_TEMPERATURE)) && process.env.SMALLTALK_TEMPERATURE ? Number(process.env.SMALLTALK_TEMPERATURE) : 0.7,

    // WIP 54: Luganda replies from a small model that runs on THIS machine
    // (nothing leaves the server). Ganda Gemma 1B turns the English answer into Luganda.
    //   LUGANDA_PROVIDER=auto   -> local if GANDA_MODEL is set, else off
    //   LUGANDA_PROVIDER=local | off  -> force one
    // Nothing is ever sent to an outside service. (The old hosted 'sunbird' option was removed; if an
    // old .env still says it, it is treated as off and the server logs a note at start-up.)
    lugandaProvider: ['auto', 'local', 'off'].includes(String(process.env.LUGANDA_PROVIDER || 'auto').toLowerCase())
        ? String(process.env.LUGANDA_PROVIDER || 'auto').toLowerCase() : 'off',
    legacySettingsIgnored: [
        process.env.SUNBIRD_API_KEY ? 'SUNBIRD_API_KEY' : '',
        String(process.env.LUGANDA_PROVIDER || '').toLowerCase() === 'sunbird' ? 'LUGANDA_PROVIDER=sunbird' : '',
    ].filter(Boolean),
    gandaModel: process.env.GANDA_MODEL || '',
    // Replies that will be machine-translated are kept shorter: translation time grows with length.
    maxReplyTokensLg: Number(process.env.MAX_REPLY_TOKENS_LG) || 220,
    translateChunkTimeoutMs: Number(process.env.TRANSLATE_CHUNK_TIMEOUT_MS) || 45000,
    // Opt-in: remember Luganda questions the phrasebook missed so a Luganda speaker can review them.
    logLugandaMisses: /^(1|true|yes)$/i.test(process.env.LOG_LUGANDA_MISSES || ''),
    // WIP 69: translate sentences WHILE the English answer is still streaming. Off by default: with
    // OLLAMA_MAX_LOADED_MODELS=1 the Ganda request is expected to wait for (or swap out) the chat model.
    // Turn on only after OLLAMA_MAX_LOADED_MODELS=2 is set, the machine has RAM for both models, and you measured.
    lugandaInterleave: /^(1|true|yes)$/i.test(process.env.LUGANDA_INTERLEAVE || ''),
    // Opt-in: keep a short record of flagged (off-topic / abusive / private-details) messages for review. See chat/flagLog.js.
    logFlagged: /^(1|true|yes)$/i.test(process.env.LOG_FLAGGED_MESSAGES || ''),
    dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
    translationMemoryPath: require('path').join(__dirname, 'lang', 'translation-memory.json'),

    ragTopK: Number(process.env.RAG_TOP_K) || 3,
    historyTurns: Number(process.env.HISTORY_TURNS) || 4,
    numCtx: Number(process.env.NUM_CTX) || 2048,
    loadTopK: Number(process.env.LOAD_TOP_K) || 2,
    loadMaxTokens: Number(process.env.LOAD_MAX_TOKENS) || 140,
    loadHistoryTurns: Number(process.env.LOAD_HISTORY_TURNS) || 2,
    modelFirstTokenTimeoutMs: Number(process.env.MODEL_FIRST_TOKEN_TIMEOUT_MS) || 20000,
    debug: /^(1|true|yes)$/i.test(process.env.DEBUG || ''),

    // WIP 71: real catalog cards. Off only when explicitly disabled; lookups stay
    // on the fixed NextaStore API paths in src/tools/catalog.js.
    catalogCards: !/^(0|false|no|off)$/i.test(String(process.env.NEXI_CATALOG_CARDS || '').trim()),
    catalogTimeoutMs: Number(process.env.CATALOG_TIMEOUT_MS) > 0 ? Number(process.env.CATALOG_TIMEOUT_MS) : 2500,


    // Optional: the REAL nextastore-backend API (port 4000 by default — see
    // js/main.js's apiBaseUrl). When reachable, a few "live facts" tools use
    // this to answer with genuinely current data (e.g. which payment
    // methods are enabled RIGHT NOW) instead of relying on the static
    // knowledge base for things that change from the admin console rather
    // than a code deploy. See src/tools/liveFacts.js. Safe to leave unset —
    // everything degrades gracefully to the static knowledge base if this
    // isn't reachable.
    nextastoreApiBase: (process.env.NEXTASTORE_API_BASE || 'http://localhost:4000/api').replace(/\/$/, ''),

    // WIP 60: platform facts (Seller Pass price, trial, cancel rule, statuses...) are copied from the
    // real backend into one generated knowledge file. 0 turns the sync off. Minimum 30 s when on.
    factsSyncMs: (() => {
        const raw = process.env.FACTS_SYNC_MS;
        if (raw === undefined || String(raw).trim() === '') return 5 * 60 * 1000;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.max(30000, n);
    })(),
    factsFile: require('path').join(__dirname, 'knowledge', '90-project-facts.generated.md'),

    knowledgeDir: require('path').join(__dirname, 'knowledge'),
    retrievalLexiconPath: require('path').join(__dirname, 'lang', 'retrieval-lexicon.json'),
    indexPath: process.env.INDEX_PATH || require('path').join(__dirname, 'rag', 'index.json'),
    startersPath: require('path').join(__dirname, 'lang', 'starters.json'),
    phrasebookPath: require('path').join(__dirname, 'lang', 'luganda-phrasebook.json'),
};
