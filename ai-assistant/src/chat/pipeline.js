const config = require('../config');
const ollama = require('../ollama/client');
const { retrieve } = require('../rag/retrieve');
const { detectLanguage, looksEnglish } = require('../lang/detect');
const { matchPhrasebook } = require('../lang/phrasebook');
const translator = require('../lang/translator');
const lgMisses = require('../lang/lgMisses');
const { buildSystemPrompt, buildSmallTalkPrompt } = require('./systemPrompt');
const { isSmallTalk, normalise } = require('./smalltalk');
const smalltalkReplies = require('./smalltalkReplies');
const { createDelivery } = require('./deliver');
const faqMatch = require('./faqMatch');
const fallback = require('./fallback');
const answerCache = require('./answerCache');
const { detectLanguage: detectLangForCache } = require('../lang/detect');
const { getLivePaymentMethodsContext } = require('../tools/liveFacts');
const { detectCatalogIntent, searchCatalog } = require('../tools/catalog');
const { analyseTurn, markerGate, stripMarker, DRIFT_THRESHOLD } = require('./relevance');
const { cannedReply } = require('./canned');
const flagLog = require('./flagLog');

const LANGUAGE_LABELS = { en: 'English', lg: 'Luganda', sw: 'Swahili' };
const LG_PARTIAL_NOTE = '\n\n(Some parts are shown in English.)';
const LG_NO_TRANSLATOR_NOTE = '\n\nI’ll answer in English here because Luganda translation is not enabled on this server.';

function formatContext(chunks) {
    if (!chunks.length) return '';
    return chunks.map((c) => `### ${c.heading} (source: ${c.source})\n${c.text}`).join('\n\n');
}

function fitRetrievedContext({ retrieved, liveContext, languageLabel, audience, page, translationHint, lugandaInputUntranslated, history, historyTurns = config.historyTurns, message }) {
    const base = buildSystemPrompt({
        languageLabel, audience, page, translationHint, lugandaInputUntranslated, retrievedContext: '',
    });
    const historyChars = trimHistory(history, historyTurns).reduce((n, m) => n + String(m.content || '').length, 0);
    const budget = Math.max(1200, config.numCtx * 4 - base.length - historyChars - String(message || '').length - 300);
    let block = [formatContext(retrieved), liveContext].filter(Boolean).join('\n\n');
    if (block.length <= budget) return block;
    // Keep the fixed rules untouched. Trim retrieved prose first, then live data
    // only if necessary. The live block is deliberately short and should survive.
    const chunks = retrieved.map((r) => ({ ...r, text: String(r.text || '') }));
    let per = Math.max(280, Math.floor(Math.max(280, budget - String(liveContext || '').length - 100) / Math.max(1, chunks.length)));
    let fitted = chunks.map((r) => ({ ...r, text: r.text.slice(0, per).replace(/\s+\S*$/, '') }));
    block = [formatContext(fitted), liveContext].filter(Boolean).join('\n\n');
    if (block.length > budget && liveContext) {
        const remaining = Math.max(0, budget - 120);
        block = [formatContext(fitted), liveContext.slice(0, remaining)].filter(Boolean).join('\n\n');
    }
    return block.slice(0, budget);
}
function trimHistory(history = [], turns = config.historyTurns) {
    return history.slice(-(turns * 2));
}

/**
 * One turn. Returns the same shape for streaming and non-streaming callers.
 * hooks: { onMeta(meta), onToken(text), onStatus(stage), onBreak(), onTyping(), onCards(payload), onReset(), pace, signal }
 *
 * Luganda strategy (no human review needed at runtime):
 *  1. exact phrasebook hit -> curated answer
 *  2. Ganda Gemma 1B runs on this server (see lang/translator.js): answer in English with the
 *     knowledge base, then translate English->Luganda sentence by sentence (streamed as each
 *     sentence finishes). Luganda INPUT is not translated; the keyword lexicon (src/lang/retrieval-lexicon.json)
 *     and a prompt hint handle it.
 *  3. otherwise answer in English plus a short Luganda note. We never let a
 *     generic model improvise Luganda about money or policies.
 * Nothing is sent to any outside service.
 */
async function runCore({ message, history = [], lang, context = {} }, hooks = {}) {
    const { onMeta, onToken, onStatus, onBreak, onTyping, onCards, onReset, pace, signal } = hooks;
    const delivery = createDelivery({ onToken, onBreak, onTyping, onCards, onReset, signal, pace });
    const status = (stage) => { if (onStatus) onStatus(stage); };
    const detected = lang
        ? { code: lang, label: LANGUAGE_LABELS[lang] || lang, confidence: 'forced' }
        : detectLanguage(message);
    const meta = { language: detected };

    // WIP 55: clearly off-topic, abusive, private-detail or manipulation messages are flagged here,
    // before any model work, and answered with a curated reply (instant, free, always safe).
    const analysis = analyseTurn({ message, history });
    if (analysis.type) {
        const flag = { type: analysis.type, reason: analysis.reason, conversation: analysis.conversation, source: 'rules' };
        const reply = cannedReply(flag.type, { conversation: flag.conversation, lang: detected.code === 'lg' ? 'lg' : 'en' });
        flagLog.record({ ...flag, message, page: context.page, audience: context.audience, lang: detected.code });
        if (onMeta) onMeta({ ...meta, source: 'flag' });
        await delivery.instant(reply, 'flag');
        return { reply, bubbles: delivery.bubbles(), language: detected, source: 'flag', retrieved: [], flag };
    }

    if (detected.code === 'lg') {
        const hit = matchPhrasebook(message);
        if (hit) {
            const result = { reply: hit.lg_answer, language: detected, source: 'phrasebook', phrasebookId: hit.id, retrieved: [] };
            if (onMeta) onMeta({ ...meta, source: 'phrasebook' });
            await delivery.instant(result.reply, 'phrasebook');
            result.bubbles = delivery.bubbles();
            return result;
        }
        lgMisses.record(message);
    }

    const wantsLuganda = detected.code === 'lg';
    const lgProvider = wantsLuganda ? translator.provider() : 'off';
    const translating = lgProvider !== 'off';
    const messageIsEnglish = looksEnglish(message);

    // The question we reason over is the person's own text (Luganda input is not machine-translated).
    const workingMessage = message;

    // T2: strict small talk is fully local and never reaches Ollama.
    const smallTalk = isSmallTalk(workingMessage);
    if (smallTalk) {
        const historyForReply = history.slice(-12);
        const reply = smalltalkReplies.pick({
            lang: detected.code,
            message: workingMessage,
            history: historyForReply,
            normalise,
        });
        const result = { reply, language: detected, source: 'smalltalk', retrieved: [], usedLiveData: false, smallTalk: true };
        if (onMeta) onMeta({ ...meta, source: 'smalltalk', smallTalk: true });
        await delivery.instant(reply, 'smalltalk');
        result.bubbles = delivery.bubbles();
        return result;
    }

    // T3: high-confidence FAQ matches answer instantly from the local knowledge/facts snapshot.
    const faq = faqMatch.match(workingMessage, { audience: context.audience || 'guest' });
    if (faq) {
        const result = { reply: faq.answer, language: detected, source: 'faq', retrieved: [], usedLiveData: false, faqId: faq.id };
        if (onMeta) onMeta({ ...meta, source: 'faq', faqId: faq.id, score: Number(faq.score.toFixed(3)), margin: Number(faq.margin.toFixed(3)) });
        await delivery.instant(result.reply, 'faq');
        result.bubbles = delivery.bubbles();
        return result;
    }

    // WIP 71: real catalog data wins over the model. English only for now; the
    // reviewed Luganda vocabulary is not ready for catalog intent detection.
    if (config.catalogCards && detected.code !== 'lg') {
        const catalogIntent = detectCatalogIntent(workingMessage);
        if (catalogIntent) {
            const found = await searchCatalog({ ...catalogIntent, signal });
            if (signal?.aborted) return { reply: '', bubbles: [], language: detected, source: 'cards', retrieved: [] };
            const query = String(catalogIntent.query || '').replace(/[\u0000-\u001F\u007F"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
            if (found === null) {
                const reply = 'I cannot look that up right now. Please try the search box on the marketplace page.';
                const result = { reply, language: detected, source: 'cards', retrieved: [], usedLiveData: false };
                if (onMeta) onMeta({ ...meta, source: 'cards', kind: catalogIntent.kind, query });
                await delivery.instant(reply, 'cards');
                result.bubbles = delivery.bubbles();
                return result;
            }
            if (!found.items.length) {
                const reply = found.kind === 'stores' && !query
                    ? 'I could not find any stores on NextaStore yet. You can also try the search box on the marketplace page.'
                    : `I could not find anything for "${query}" on NextaStore yet. You can also try the search box on the marketplace page.`;
                const result = { reply, language: detected, source: 'cards', retrieved: [], usedLiveData: false };
                if (onMeta) onMeta({ ...meta, source: 'cards', kind: found.kind, query: found.query });
                await delivery.instant(reply, 'cards');
                result.bubbles = delivery.bubbles();
                return result;
            }
            const sentence = found.kind === 'stores' && !query
                ? 'Here are some stores on NextaStore.'
                : found.kind === 'products'
                    ? `Here are some products on NextaStore that match "${query}".`
                    : `Here are some stores on NextaStore that match "${query}".`;
            const result = {
                reply: sentence,
                language: detected,
                source: 'cards',
                retrieved: [],
                usedLiveData: false,
                cards: { kind: found.kind, query: found.query, items: found.items },
            };
            if (onMeta) onMeta({ ...meta, source: 'cards', kind: found.kind, query: found.query });
            await delivery.instant(sentence, 'cards');
            delivery.cards(result.cards);
            await delivery.drain();
            result.bubbles = delivery.bubbles();
            return result;
        }
    }

    const loadAdaptive = Boolean(context.loadAdaptive);
    const ragTopK = loadAdaptive ? config.loadTopK : config.ragTopK;
    const maxTokens = loadAdaptive ? config.loadMaxTokens : config.maxReplyTokens;
    const historyTurns = loadAdaptive ? config.loadHistoryTurns : config.historyTurns;
    let retrieved = [];
    let liveContext = '';
    try { retrieved = await retrieve(workingMessage, ragTopK); } catch (err) { retrieved = []; }
    liveContext = await getLivePaymentMethodsContext(workingMessage);
    const replyLabel = (wantsLuganda || detected.code === 'en') ? 'English' : detected.label;
    const contextBlock = fitRetrievedContext({
        retrieved,
        liveContext,
        languageLabel: replyLabel,
        audience: context.audience,
        page: context.page,
        translationHint: translating,
        lugandaInputUntranslated: translating && !messageIsEnglish,
        history,
        historyTurns,
        message: workingMessage,
    });
    const messages = [
        {
            role: 'system',
            content: buildSystemPrompt({
                languageLabel: replyLabel,
                retrievedContext: contextBlock,
                audience: context.audience,
                page: context.page,
                translationHint: translating,
                // The model is being handed Luganda it cannot read well.
                lugandaInputUntranslated: translating && !messageIsEnglish,
            }),
        },
        ...trimHistory(history, historyTurns),
        { role: 'user', content: workingMessage },
    ];
    const modelOpts = {};
    const retrievedMeta = retrieved.map((r) => ({ source: r.source, heading: r.heading, score: Number(r.score.toFixed(3)) }));
    if (onMeta) onMeta({ ...meta, source: 'model', retrieved: retrievedMeta, smallTalk: false });

let reply;
    let source = 'model';
    let modelMarked = false;
    const modelTimeout = setTimeout(() => {
        if (gotFirstToken || signal?.aborted) return;
        // Abort the model call only while there has been no usable progress.
        // The catch below supplies the local fallback.
        try { modelAbort.abort(); } catch (e) { /* ignore */ }
    }, config.modelFirstTokenTimeoutMs);
    if (modelTimeout.unref) modelTimeout.unref();
    const modelAbort = new AbortController();
    const modelSignal = signal ? AbortSignal.any([signal, modelAbort.signal]) : modelAbort.signal;
    let gotFirstToken = false;
    const livePush = delivery.live();
    const guardedToken = onToken ? (chunk) => {
        if (!gotFirstToken) {
            gotFirstToken = true;
            clearTimeout(modelTimeout);
        }
        livePush(chunk);
    } : undefined;

    try {
        if (translating) {
            status('thinking');
            let english = '';
            const streamTranslator = translator.createStreaming({
                signal: modelSignal,
                onProgress: () => status('translating'),
                onChunk: guardedToken,
                // WIP 69: by default translation starts only after the English stream ends (one loaded model).
                hold: !config.lugandaInterleave,
            });
            const gate = markerGate((chunk) => {
                gotFirstToken = true;
                clearTimeout(modelTimeout);
                english += chunk;
                streamTranslator.push(chunk);
            });
            await ollama.chatStream(messages, (chunk) => gate.push(chunk), {
                ...modelOpts,
                signal: modelSignal,
                numPredict: loadAdaptive ? Math.min(config.loadMaxTokens, config.maxReplyTokensLg) : config.maxReplyTokensLg,
                numCtx: config.numCtx,
            });
            gate.end();
            modelMarked = gate.marked;
            const t = await streamTranslator.end();
            if (t && t.translated > 0) {
                reply = t.text;
                source = `model+${lgProvider}`;
                if (t.total && t.translated < t.total) {
                    reply += LG_PARTIAL_NOTE;
                    if (guardedToken) guardedToken(LG_PARTIAL_NOTE);
                }
            } else if (t) {
                // WIP 69: the translator ran but every piece stayed English. The English was already streamed
                // piece by piece (onChunk), so only the note is added; "not enabled" would be wrong here.
                reply = t.text + LG_PARTIAL_NOTE;
                if (guardedToken) guardedToken(LG_PARTIAL_NOTE);
            } else {
                reply = english + LG_NO_TRANSLATOR_NOTE;
                if (guardedToken && !t) guardedToken(english);
                if (guardedToken) guardedToken(LG_NO_TRANSLATOR_NOTE);
            }
        } else if (guardedToken) {
            const gate = markerGate(guardedToken);
            const raw = await ollama.chatStream(messages, (t) => { gotFirstToken = true; gate.push(t); }, { ...modelOpts, signal: modelSignal, numPredict: maxTokens, numCtx: config.numCtx });
            gate.end();
            reply = stripMarker(raw).text;
            modelMarked = gate.marked;
            if (wantsLuganda) { reply += LG_NO_TRANSLATOR_NOTE; guardedToken(LG_NO_TRANSLATOR_NOTE); }
        } else {
            const stripped = stripMarker(await ollama.chat(messages, { ...modelOpts, signal: modelSignal, numPredict: maxTokens, numCtx: config.numCtx }));
            reply = stripped.text;
            modelMarked = stripped.marked;
            if (wantsLuganda) reply += LG_NO_TRANSLATOR_NOTE;
        }
    } catch (err) {
        clearTimeout(modelTimeout);
        if (signal?.aborted) throw err;
        const local = await fallback.build(workingMessage, { audience: context.audience || 'guest' });
        const result = {
            ...local,
            reply: local.reply,
            language: detected,
            source: 'fallback',
            smallTalk: false,
        };
        if (onMeta) onMeta({ ...meta, source: 'fallback', retrieved: local.retrieved || [] });
        delivery.reset();
        await delivery.instant(local.reply, 'fallback');
        result.bubbles = delivery.bubbles();
        return result;
    } finally {
        clearTimeout(modelTimeout);
    }

    if (!onToken) livePush(reply);
    await delivery.drain();
    const bubbles = delivery.bubbles();
    reply = bubbles.join('\n\n');
    const result = {
        reply,
        bubbles,
        language: detected,
        source,
        retrieved: retrievedMeta,
        usedLiveData: Boolean(liveContext),
        smallTalk,
    };
    // Second net: the model judged the question unrelated. Trust it only when the message has no
    // NextaStore / shopping / selling vocabulary (the rules above already found none in unflagged messages).
    if (modelMarked && analysis.onTopicHits === 0) {
        result.flag = { type: 'off_topic', reason: 'judged unrelated by the model', conversation: analysis.flaggedRecent + 1 >= DRIFT_THRESHOLD, source: 'model' };
        flagLog.record({ ...result.flag, message, page: context.page, audience: context.audience, lang: detected.code });
    }
    return result;
}

/**
 * Public turn wrapper: cache complete model answers and merge identical model
 * requests. Only empty-history, non-live, non-flagged model answers are cached.
 */
async function run({ message, history = [], lang, context = {} }, hooks = {}) {
    const { onToken, onBreak, onTyping, onCards, onReset, pace, signal } = hooks;
    const delivery = createDelivery({ onToken, onBreak, onTyping, onCards, onReset, signal, pace });
    const audience = context.audience || 'guest';
    const detected = lang ? { code: lang } : detectLangForCache(message);
    const language = detected.code || 'en';
    const canCache = history.length === 0;
    const key = canCache ? answerCache.keyOf(message, language, audience) : '';
    if (canCache && key) {
        const cached = answerCache.get(key);
        if (cached) {
            const result = { ...cached, source: 'cache' };
            if (hooks.onMeta) hooks.onMeta({ language: result.language, source: 'cache' });
            await delivery.instant(result.bubbles || result.reply, 'cache');
            result.bubbles = delivery.bubbles();
            return result;
        }
        const existing = answerCache.getInflight(key);
        if (existing) {
            const base = await existing;
            const result = { ...base, source: 'cache' };
            if (hooks.onMeta) hooks.onMeta({ language: result.language, source: 'cache' });
            await delivery.instant(result.bubbles || result.reply, 'cache');
            result.bubbles = delivery.bubbles();
            return result;
        }
    }

    const promise = runCore({ message, history, lang, context }, hooks);
    if (canCache && key) {
        answerCache.setInflight(key, promise);
        promise.then((result) => {
            if (answerCache.shouldCache({ history, result })) answerCache.set(key, result);
        }).finally(() => answerCache.clearInflight(key, promise)).catch(() => {});
    }
    return promise;
}

/** Back-compat signature used by the original /chat route and demo widget. */
function answer(message, history = [], forcedLang, context = {}) {
    return run({ message, history, lang: forcedLang, context });
}

module.exports = { run, answer, LANGUAGE_LABELS };
