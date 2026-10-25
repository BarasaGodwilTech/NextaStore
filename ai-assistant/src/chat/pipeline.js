const config = require('../config');
const ollama = require('../ollama/client');
const { retrieve } = require('../rag/retrieve');
const { detectLanguage, looksEnglish } = require('../lang/detect');
const { effectiveLang, gateReply, LG_HANDOFF } = require('../lang/lgGuard');
const { detectHumanRequest, policyClaimUnsupported, EN_HANDOFF, LG_HANDOFF: LG_HANDOFF_TEXT, withHours } = require('./handoff');
const { markerGate, stripMarkers } = require('./markers');
const { matchPhrasebook } = require('../lang/phrasebook');
const translator = require('../lang/translator');
const lgMisses = require('../lang/lgMisses');
const { buildSystemPrompt, buildSmallTalkPrompt } = require('./systemPrompt');
// WIP 97: messy-question retrieval, answer composition, tiers and the self-knowledge intent (English path; Luganda keeps its own gates).
const aboutNexi = require('./aboutNexi');
const { retrieveForMessage } = require('./retrieveMulti');
const { detectGap } = require('../rag/retrieve');
const { platformConcept } = require('../rag/normalise');
const { isCompoundOrSituational, buildFactsBlock } = require('./compose');
const { cleanEnglishReply, isParroting, isUsableReply, partsCovered } = require('./postprocess');
const { extractiveAnswer } = require('./extractive');
const { gapSentence } = require('./gapLine');
const { isDistress, SAFETY_SECTIONS, TAKEOVER_SECTIONS, ACCOUNT_TAKEOVER_RE, decideTier, honourModelHandoff, clarifyText } = require('./tiers');
const { numbersSupported } = require('./numbers');
const { checkAssertion, NOT_IN_GUIDES } = require('./assertionGuard');
const { isSmallTalk, normalise } = require('./smalltalk');
const smalltalkReplies = require('./smalltalkReplies');
const { createDelivery } = require('./deliver');
const faqMatch = require('./faqMatch');
const fallback = require('./fallback');
const answerCache = require('./answerCache');
const { detectLanguage: detectLangForCache } = require('../lang/detect');
const { getLivePaymentMethodsContext, getSupportHoursNote } = require('../tools/liveFacts');
/** WIP 93: the English handoff, with the admin-set support hours appended when there are any. */
async function enHandoff() { return withHours(EN_HANDOFF, await getSupportHoursNote()); }
const { detectCatalogIntent, searchCatalog } = require('../tools/catalog');
const { analyseTurn, DRIFT_THRESHOLD } = require('./relevance');
const { cannedReply } = require('./canned');
const flagLog = require('./flagLog');
const stats = require('./stats');
const webContext = require('../tools/web');
const retrievalLexicon = require('../lang/retrieval-lexicon.json');

const LANGUAGE_LABELS = { en: 'English', lg: 'Luganda', sw: 'Swahili' };
const LG_HANDOFF_DRAFT = LG_HANDOFF_TEXT;
const LG_SMALLTALK_DRAFTS = { // DRAFTS for Luganda speaker review (WIP 92); served as source 'smalltalk'
     'luganda': 'Kale, tujja kwogera mu Luganda. Oyagala kuyambibwa ku ki?', 'mu luganda': 'Kale, tujja kwogera mu Luganda. Oyagala kuyambibwa ku ki?', 'oliwawa': 'Ndi wano mu NextaStore okukuyamba.', 'bakuyita ani': 'Nze Nexi, omuyambi wa NextaStore.', 'gwe ani': 'Nze Nexi, omuyambi wa NextaStore.', 'oli ani': 'Nze Nexi, omuyambi wa NextaStore.', 'oli mukulembeze': 'Nedda, ndi muyambi wa kompyuta ku NextaStore.', 'oli muntu': 'Nedda, ndi Nexi, omuyambi wa kompyuta ku NextaStore.', 'nsaba omuyambi': 'Yee, ndi wano okukuyamba. Oyagala kumanya ki?', 'ndi ani': 'Ggwe omuntu akoze akawunti yo; sisobola kulaba bikwata ku akawunti yo wano.' };
function ensureLuganda(text, lang, source = 'unknown', opts = {}) { return gateReply({ lang, source, text, ...opts }).text; }

function formatContext(chunks) {
    if (!chunks.length) return '';
    return chunks.map((c) => `### ${c.heading}\n${fallback.scrubFileNames(c.text)}`).join('\n\n');
}

function fitRetrievedContext({ retrieved, liveContext, languageLabel, audience, page, translationHint, lugandaInputUntranslated, history, historyTurns = config.historyTurns, message }) {
    const companion = retrieved.find((r) => r.isFactsCompanion);
    if (companion) {
        const primary = retrieved.filter((r) => !r.isFactsCompanion);
        const primaryBlock = fitRetrievedContext({ retrieved: primary, liveContext, languageLabel, audience, page, translationHint, lugandaInputUntranslated, history, historyTurns, message });
        const basePrompt = buildSystemPrompt({ languageLabel, audience, page, translationHint, lugandaInputUntranslated, retrievedContext: '' });
        const historyChars = trimHistory(history, historyTurns).reduce((n, m) => n + String(m.content || '').length, 0);
        const budget = Math.max(1200, config.numCtx * 4 - basePrompt.length - historyChars - String(message || '').length - 300);
        const withCompanion = [formatContext([...primary, companion]), liveContext].filter(Boolean).join('\n\n');
        return withCompanion.length <= budget ? withCompanion : primaryBlock;
    }
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
// WIP 98: the history sent to the model is limited by SIZE as well as by turns: the model's window is small (numCtx tokens), the facts come first,
// and a long old conversation must never push them out. Newest messages are kept; each one is cut to a reasonable length.
const HISTORY_CHARS = { perMessage: 500, total: 1400 };
function trimHistory(history = [], turns = config.historyTurns) {
    const recent = history.slice(-(turns * 2)).map((m) => ({ ...m, content: String(m.content || '').slice(0, HISTORY_CHARS.perMessage) }));
    let total = 0; const keep = [];
    for (let i = recent.length - 1; i >= 0; i--) { total += recent[i].content.length; if (total > HISTORY_CHARS.total && keep.length) break; keep.unshift(recent[i]); }
    return keep;
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
function validateModelReply(reply, contextText, faq, opts = {}) {
    const text = String(reply || '');
    // WIP 100: assertion-support guard. A reply that asserts yes / no / a figure to a question about availability, fees, limits, prices, locations or policy is allowed only
    // when one sentence of the retrieved text holds the question's key object AND a matching predicate (see assertionGuard.js). General advice is never gated.
    if (opts.question && config.assertionGuard && !opts.skipAssertion) {
        const g = checkAssertion({ question: opts.question, reply: text, contextText, foreign: Boolean(opts.foreign) });
        if (g.applies && !g.ok) return { text: `${NOT_IN_GUIDES} ${EN_HANDOFF}`, substituted: true, handoff: { reason: 'not_in_context' }, assertion: { kind: g.kind, why: g.why, sentence: String(g.assertion || '').slice(0, 120) } };
    }
    const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
    // WIP 97: figures compare in canonical form ("3-day" == "three days", "UGX 20,000" == "20,000").
    const safe = sentences.filter((sentence) => numbersSupported(sentence, contextText));
    let result = safe.join('').trim();
    const context = String(contextText || '').toLowerCase();
    const lower = result.toLowerCase();
    const refundConflict = /\b(refundable|refund)\b/.test(lower) && /seller pass payments are not refundable/i.test(context) && !/not refundable/i.test(lower);
    const trialConflict = /\b(no free trial|trial is not free)\b/.test(lower) && /free trial/i.test(context);
    const inventedStatus = /\b(status is|status will be|marked as)\s+["“]?([a-z][a-z -]{2,24})/i.exec(result);
    const knownStatuses = new Set((context.match(/\b(?:pending|approved|rejected|processing|shipped|delivered|cancelled|completed|paid|failed)\b/g) || []));
    const badStatus = inventedStatus && !knownStatuses.has(inventedStatus[2].trim().toLowerCase());
    // WIP 92d: check the model's ORIGINAL text as well: dropping unsupported-number sentences must never turn an invented
    // claim into silence followed by the original text.
    const unsupportedPolicy = policyClaimUnsupported(result, contextText) || policyClaimUnsupported(text, contextText);
    if (unsupportedPolicy) return { text: EN_HANDOFF, substituted: true, handoff: { reason: 'not_in_context' } };
    // WIP 98: when EVERY sentence was dropped because its figures are not in the context, the original text must never come back: that is an
    // unsupported claim, so it is a handoff (the English path then composes from the guides instead; see the caller).
    if (!result && sentences.some((x) => x.trim())) return { text: EN_HANDOFF, substituted: true, handoff: { reason: 'not_in_context' } };
    if (!result || refundConflict || trialConflict || badStatus) return { text: faq ? faq.answer : (safe.length ? safe.join('').trim() : text), substituted: false, handoff: null };
    return { text: result, substituted: false, handoff: null };
}

async function runCoreInner({ message, history = [], lang, context = {} }, hooks = {}) {
    const { onMeta, onToken, onStatus, onBreak, onTyping, onCards, onReset, pace, signal } = hooks;
    const delivery = createDelivery({ onToken, onBreak, onTyping, onCards, onReset, signal, pace });
    const status = (stage) => { if (onStatus) onStatus(stage); };
    const resolvedLang = effectiveLang(lang, message, history);
    const detected = { ...(detectLanguage(message)), code: resolvedLang, label: LANGUAGE_LABELS[resolvedLang] || resolvedLang, confidence: lang ? 'forced' : 'resolved' };
    const meta = { language: detected };
    const post = (text, intent) => fallback.postProcessReply(text, intent, { lang: detected.code });

    // WIP 55: clearly off-topic, abusive, private-detail or manipulation messages are flagged here,
    // before any model work, and answered with a curated reply (instant, free, always safe).
    const analysis = analyseTurn({ message, history });
    if (analysis.type) {
        const flag = { type: analysis.type, reason: analysis.reason, conversation: analysis.conversation, source: 'rules' };
        const safetyHandoff = /\b(scam|scammer|fraud|hacked|compromised|stolen account|money dispute|took my money|payment dispute)\b/i.test(String(message || ''));
        if (safetyHandoff) meta.handoff = { reason: 'safety' };
        const rawFlagReply = post(cannedReply(flag.type, { conversation: flag.conversation, lang: detected.code === 'lg' ? 'lg' : 'en' }), message);
        const flagGate = gateReply({ lang: detected.code, source: 'canned', text: rawFlagReply });
        const reply = flagGate.text;
        if (flagGate.handoff && !meta.handoff) meta.handoff = flagGate.handoff;
        flagLog.record({ ...flag, message, page: context.page, audience: context.audience, lang: detected.code });
        if (onMeta) onMeta({ ...meta, source: 'flag', ...(safetyHandoff ? { handoff: meta.handoff } : {}) });
        await delivery.instant(reply, 'flag');
        return { reply, bubbles: delivery.bubbles(), language: detected, source: 'flag', retrieved: [], flag, ...(safetyHandoff ? { handoff: meta.handoff } : {}), needs_review: detected.code === 'lg' };
    }

    // WIP 91 Part A: resolve a direct link request from the preceding conversation before
    // FAQ/retrieval can mistake the word 'link' for an unrelated sign-in article.
    let directLinkReply = fallback.linkRequestReply(message, history);
    if (directLinkReply && detected.code === 'lg') {
        // The English sentence around the link cannot be shown on a Luganda turn: keep only the link, with a short DRAFT lead-in.
        const m = /(\[[^\]\n]+\]\(\/[A-Za-z0-9\-_/]*\))\s*$/.exec(directLinkReply);
        directLinkReply = m && /^Here’s the page/.test(directLinkReply) ? `Laba wano: ${m[1]}` : '';
    }
    if (directLinkReply) {
        const reply = post(directLinkReply, message);
        const result = { reply, language: detected, source: 'link', retrieved: [], usedLiveData: false, ...(detected.code === 'lg' ? { needs_review: true } : {}) };
        if (onMeta) onMeta({ ...meta, source: 'link' });
        await delivery.instant(reply, 'link');
        result.bubbles = delivery.bubbles();
        return result;
    }

    // WIP 97 Part 3: questions about Nexi itself are answered from 12-about-nexi.md only (never improvised, never a handoff).
    if (detected.code === 'en' && !detectHumanRequest(message)) {
        const about = aboutNexi.match(message);
        if (about) {
            const aboutReply = post(about.text, message);
            const result = { reply: aboutReply, language: detected, source: 'about', retrieved: [], usedLiveData: false, aboutId: about.id };
            if (onMeta) onMeta({ ...meta, source: 'about', aboutId: about.id });
            await delivery.instant(aboutReply, 'about');
            result.bubbles = delivery.bubbles();
            return result;
        }
    }

    if (detected.code === 'lg') {
        const lgKey = String(message || '').trim().toLowerCase();
        const lgDrafts = LG_SMALLTALK_DRAFTS;
        if (lgDrafts[lgKey]) { const reply = gateReply({ lang: 'lg', source: 'smalltalk', text: post(lgDrafts[lgKey], message) }).text; const result = { reply, language: detected, source: 'smalltalk', retrieved: [], needs_review: true }; if (onMeta) onMeta({ ...meta, source: 'smalltalk', needs_review: true }); await delivery.instant(reply, 'smalltalk'); result.bubbles = delivery.bubbles(); return result; }
        const hit = matchPhrasebook(message);
        if (hit) {
            const phraseGate = gateReply({ lang: 'lg', source: 'phrasebook', text: post(hit.lg_answer, message) });
            const reply = phraseGate.text;
            const result = { reply, language: detected, source: 'phrasebook', phrasebookId: hit.id, retrieved: [] };
            if (onMeta) onMeta({ ...meta, source: 'phrasebook' });
            await delivery.instant(reply, 'phrasebook');
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
        const rawReply = smalltalkReplies.pick({
            lang: detected.code,
            message: workingMessage,
            history: historyForReply,
            normalise,
        });
        const smallGate = gateReply({ lang: detected.code, source: 'smalltalk', text: post(rawReply, message) });
        const reply = smallGate.text;
        const result = { reply, language: detected, source: smallGate.handoff ? 'handoff' : 'smalltalk', retrieved: [], usedLiveData: false, smallTalk: true, ...(smallGate.handoff ? { handoff: smallGate.handoff, needs_review: true } : {}) };
        if (onMeta) onMeta({ ...meta, source: result.source, smallTalk: true, ...(smallGate.handoff ? { handoff: smallGate.handoff, needs_review: true } : {}) });
        await delivery.instant(reply, 'smalltalk');
        result.bubbles = delivery.bubbles();
        return result;
    }

    // Keep the original message for the model, but resolve short references for retrieval.
    const retrievalQuery = fallback.resolveFollowupQuery(workingMessage, history);
    const isFollowup = retrievalQuery !== workingMessage;

    // T3: only stand-alone FAQ questions can be instant answers; follow-ups need their context.
    const faq = isFollowup ? null : faqMatch.match(workingMessage, { audience: context.audience || 'guest' });
    // Human requests are checked after FAQ matching so the established contact-support FAQ text remains unchanged.
    if (detectHumanRequest(message)) {
        if (faq && faq.id === 'contact_support') {
            const result = { reply: faq.answer, language: detected, source: 'faq', retrieved: [], faqId: faq.id, handoff: { reason: 'user_request' } };
            if (onMeta) onMeta({ ...meta, source: 'faq', faqId: faq.id, handoff: result.handoff });
            await delivery.instant(result.reply, 'faq'); result.bubbles = delivery.bubbles(); return result;
        }
        const handoffReply = detected.code === 'lg' ? LG_HANDOFF_DRAFT : await enHandoff();
        const result = { reply: handoffReply, language: detected, source: 'handoff', retrieved: [], handoff: { reason: 'user_request' }, ...(detected.code === 'lg' ? { needs_review: true } : {}) };
        if (onMeta) onMeta({ ...meta, source: 'handoff', handoff: result.handoff, ...(detected.code === 'lg' ? { needs_review: true } : {}) });
        await delivery.instant(handoffReply, 'handoff'); result.bubbles = delivery.bubbles(); return result;
    }
    // WIP 97 Part 2.1: a verbatim canned answer only for a single intent. Two-part or situational questions are composed, with the FAQ entry as top context.
    const faqCompound = Boolean(faq && faq.direct && detected.code === 'en' && isCompoundOrSituational(workingMessage));
    // WIP 98: an instant FAQ answer is not given when the question asks for a platform fact the guides do not hold ("minimum age to open a store" is not "how do I open a store").
    const faqGapped = Boolean(faq && faq.direct && detected.code === 'en' && faq.id !== 'contact_support' && detectGap(workingMessage));
    const faqDirect = Boolean(faq && faq.direct && !faqCompound && !faqGapped);
    if (faqDirect) {
        const faqGate = gateReply({ lang: detected.code, source: 'faq', text: post(faq.answer, message) });
        const reply = faqGate.text;
        // WIP 92d: the contact_support answer text is unchanged, but it always carries the user_request handoff so the
        // widget offers the WhatsApp button next to the e-mail address (English turns; a Luganda turn already got its handoff).
        const supportHandoff = !faqGate.handoff && faq.id === 'contact_support' ? { reason: 'user_request' } : null;
        const handoff = faqGate.handoff || supportHandoff;
        const result = { reply, language: detected, source: faqGate.handoff ? 'handoff' : 'faq', retrieved: [], usedLiveData: false, faqId: faq.id, ...(handoff ? { handoff } : {}), ...(faqGate.handoff ? { needs_review: true } : {}) };
        if (onMeta) onMeta({ ...meta, source: result.source, faqId: faq.id, score: Number(faq.score.toFixed(3)), margin: Number(faq.margin.toFixed(3)), ...(handoff ? { handoff } : {}), ...(faqGate.handoff ? { needs_review: true } : {}) });
        await delivery.instant(result.reply, 'faq');
        result.bubbles = delivery.bubbles();
        return result;
    }

    // WIP 71: real catalog data wins over the model. English only for now; the
    // reviewed Luganda vocabulary is not ready for catalog intent detection.
    if (config.catalogCards && detected.code !== 'lg') {
        const catalogIntent = platformConcept(workingMessage) ? null : detectCatalogIntent(workingMessage);   // WIP 98: "do you have discount codes" is about the platform, never a product search
        if (catalogIntent) {
            const found = await searchCatalog({ ...catalogIntent, signal });
            if (signal?.aborted) return { reply: '', bubbles: [], language: detected, source: 'cards', retrieved: [] };
            const query = String(catalogIntent.query || '').replace(/[\u0000-\u001F\u007F"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
            if (found === null) {
                const reply = post('I cannot look that up right now. Please try the search box on the marketplace page.', message);
                const result = { reply, language: detected, source: 'cards', retrieved: [], usedLiveData: false };
                if (onMeta) onMeta({ ...meta, source: 'cards', kind: catalogIntent.kind, query });
                await delivery.instant(reply, 'cards');
                result.bubbles = delivery.bubbles();
                return result;
            }
            if (!found.items.length) {
                const reply = post(found.kind === 'stores' && !query
                    ? 'I could not find any stores on NextaStore yet. You can also try the search box on the marketplace page.'
                    : `I could not find anything for "${query}" on NextaStore yet. You can also try the search box on the marketplace page.`, message);
                const result = { reply, language: detected, source: 'cards', retrieved: [], usedLiveData: false };
                if (onMeta) onMeta({ ...meta, source: 'cards', kind: found.kind, query: found.query });
                await delivery.instant(reply, 'cards');
                result.bubbles = delivery.bubbles();
                return result;
            }
            const sentence = post(found.kind === 'stores' && !query
                ? 'Here are some stores on NextaStore.'
                : found.kind === 'products'
                    ? `Here are some products on NextaStore that match "${query}".`
                    : `Here are some stores on NextaStore that match "${query}".`, message);
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
    let webResults = null;
    let multi = null;
    try { [multi, webResults] = await Promise.all([detected.code === 'en' ? retrieveForMessage(retrievalQuery, ragTopK) : retrieve(retrievalQuery, ragTopK).then((r) => ({ retrieved: r, groups: [], compound: false })), webContext.search(workingMessage)]); retrieved = multi.retrieved; } catch (err) { if (!Array.isArray(retrieved)) retrieved = []; webResults = null; }
    // WIP 101 (A1): a distress question ("a seller took my money and disappeared") is answered from the safety / report sections, which go first whatever the ranking said.
    if (detected.code === 'en' && isDistress(retrievalQuery)) {
        try {
            const takeover = ACCOUNT_TAKEOVER_RE.test(retrievalQuery);
            const wanted = takeover ? [SAFETY_SECTIONS[1], SAFETY_SECTIONS[2], ...TAKEOVER_SECTIONS] : SAFETY_SECTIONS;   // an account problem leads with reporting and safety, then log-out and reset
            // the safety sections are guaranteed to be present; their ORDER is the ranking of the person's own words (a "how do I report ..." leads with the report section)
            const pool = await retrieve(retrievalQuery, 100);
            const rank = (c) => { const i = pool.findIndex((x) => x.heading === c.heading); return i < 0 ? 1e6 : i; };
            const picked = wanted.map((re) => pool.find((c) => re.test(c.heading))).filter(Boolean).sort((x, y) => rank(x) - rank(y)).map((c) => ({ ...c, gap: null, band: 'answer', coverage: 1 }));
            if (picked.length) retrieved = [...picked, ...retrieved.filter((r) => !picked.some((p) => p.heading === r.heading))];
        } catch (err) { /* keep the ranking as it was */ }
    }
    const hasPointer = Boolean(fallback.factsPointerChunk(retrieved));
    const hasFacts = retrieved.some((r) => /(?:^|\/)90-project-facts\.generated\.md$/i.test(String(r.source || '')));
    if (hasPointer && !hasFacts) {
        try {
            const wider = await retrieve(retrievalQuery, 100);
            const companion = fallback.selectFactsCompanion(wider, retrieved, retrievalQuery);
            if (companion) retrieved = [...retrieved, { ...companion, isFactsCompanion: true }];
        } catch (err) { /* keep the original retrieval if the companion search fails */ }
    }
    liveContext = await getLivePaymentMethodsContext(retrievalQuery);
    const completeProductPolicyQuestion = /\?/.test(String(message || '')) || /^(what|how|when|where|does|do|is|are|can|will|which|how much|how long)\b/i.test(String(message || '').trim());
    const strongRetrieval = retrieved.some((r) => Number(r.score) >= 0.035);
    const englishProductPolicy = /\b(product|price|fee|refund|delivery|warranty|available|stock|policy|return|cancel|payment|seller pass|account|order)\b/i.test(String(message || ''));
    const lgWords = String(message || '').toLowerCase().match(/[a-zŋ']+/g) || [];
    const lgExpanded = detected.code === 'lg' && lgWords.some(w => Object.prototype.hasOwnProperty.call(retrievalLexicon.lg || {}, w));
    const asksProductPolicy = englishProductPolicy || lgExpanded;
    // WIP 97 Part 4: the SERVER decides answer / clarify / handoff for English turns (see tiers.js). The model's own [HANDOFF] marker is only
    // honoured when this decision also sees a platform-specific question the guides do not cover.
    const gapTopic = detected.code === 'en' ? ((retrieved[0] && retrieved[0].gap) || detectGap(retrievalQuery || workingMessage)) : null;
    if (detected.code === 'en' && (!faq || gapTopic) && !webResults && !liveContext && ((retrieved.length && (analysis.onTopicHits > 0 || gapTopic)) || gapTopic)) {
        const tier = decideTier({ message: retrievalQuery || workingMessage, retrieved, history, gap: gapTopic });
        meta.tier = { tier: tier.tier, reason: tier.reason };
        if (tier.tier === 'handoff') {
            // WIP 97: when the guides simply do not cover a topic, say so plainly before offering the team.
            const handoffReply = (tier.gap ? `${gapSentence(tier.gap)} ` : '') + await enHandoff();
            const result = { reply: handoffReply, language: detected, source: 'handoff', retrieved: retrieved.map((r) => ({ heading: r.heading, score: r.score })), handoff: { reason: tier.reason === 'user_request' ? 'user_request' : 'not_in_context' }, tier: meta.tier };
            if (onMeta) onMeta({ ...meta, source: 'handoff', handoff: result.handoff });
            await delivery.instant(handoffReply, 'handoff'); result.bubbles = delivery.bubbles(); return result;
        }
        if (tier.tier === 'clarify') {
            const options = tier.options || [];
            const clarifyReply = post(clarifyText(options), '');
            const result = { reply: clarifyReply, language: detected, source: 'clarify', retrieved: retrieved.map((r) => ({ heading: r.heading, score: r.score })), tier: meta.tier, ...(options.length >= 2 ? { clarify: { options } } : {}) };
            if (onMeta) onMeta({ ...meta, source: 'clarify', ...(result.clarify ? { clarify: result.clarify } : {}) });
            await delivery.instant(clarifyReply, 'clarify'); result.bubbles = delivery.bubbles(); return result;
        }
    }
    if (detected.code !== 'en' && !faq && !strongRetrieval && !liveContext && !webResults && completeProductPolicyQuestion && asksProductPolicy) {
        const handoffReply = detected.code === 'lg' ? LG_HANDOFF_DRAFT : await enHandoff();
        const result = { reply: handoffReply, language: detected, source: 'handoff', retrieved: [], handoff: { reason: 'not_in_context' }, needs_review: detected.code === 'lg' };
        if (onMeta) onMeta({ ...meta, source: 'handoff', handoff: result.handoff, needs_review: !!result.needs_review });
        await delivery.instant(handoffReply, 'handoff'); result.bubbles = delivery.bubbles(); return result;
    }
    if (detected.code !== 'en' && !faq && !webResults && retrieved.length && Number(retrieved[0].score) < 0.035) {
        const clarification = detected.code === 'lg' ? 'Nsobola okukuyamba ku akawunti, ebiragiro, okusasula, Seller Pass oba okutunda. Oyagala kumanya ki?' : 'I can help with NextaStore accounts, orders, payments, Seller Pass, or selling advice. Which of those are you asking about?';
        const reply = post(clarification, '');
        const finalReply = detected.code === 'lg' ? LG_HANDOFF_DRAFT : reply;
        const result = { reply: finalReply, language: detected, source: detected.code === 'lg' ? 'handoff' : 'clarify', retrieved: retrieved.map((r) => ({ heading: r.heading, score: r.score })), ...(detected.code === 'lg' ? { handoff: { reason: 'language_guard' }, needs_review: true } : {}) };
        if (onMeta) onMeta({ ...meta, source: result.source, ...(result.handoff ? { handoff: result.handoff, needs_review: true } : {}) });
        await delivery.instant(finalReply, result.source); result.bubbles = delivery.bubbles(); return result;
    }
    const replyLabel = (wantsLuganda || detected.code === 'en') ? 'English' : detected.label;
    const faqContext = faq && !faqDirect ? `### Authoritative FAQ answer (${faq.id})\n${faq.answer}` : '';
    const webBlock = webResults && webResults.length ? `### General information from external sources (not NextaStore policy)\n${webResults.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n')}` : '';
    const profile = config.modelProfile;
    const enFacts = detected.code === 'en'
        ? buildFactsBlock({
            retrieved, groups: (multi && multi.groups) || [], liveContext,
            faqAnswer: faq && !faqDirect ? faq.answer : '',
            maxChunks: profile.contextChunks, sentencesPerChunk: profile.sentencesPerChunk,
            budget: (liveContext || (multi && multi.compound)) ? profile.contextCharBudget.max : profile.contextCharBudget.typical,
        })
        : null;
    // The claim guard checks a reply against the FULL text of what was used, so a correct paraphrase of a trimmed-away sentence is never replaced.
    const validationContext = enFacts
        ? [faq && !faqDirect ? faq.answer : '', ...enFacts.used.map((r) => r.text), liveContext, webResults && webResults.length ? webResults.map((r) => r.snippet).join(' ') : ''].filter(Boolean).join('\n')
        : null;
    const contextBlock = enFacts ? [enFacts.block, webBlock].filter(Boolean).join('\n\n') : [faqContext, fitRetrievedContext({
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
    }), webBlock].filter(Boolean).join('\n\n');
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
    const modelOpts = { temperature: config.modelProfile.temperature };
    const retrievedMeta = retrieved.map((r) => ({ source: r.source, heading: r.heading, score: Number(r.score.toFixed(3)) }));
    if (onMeta) onMeta({ ...meta, source: 'model', retrieved: retrievedMeta, smallTalk: false });

    // WIP 92c: a Luganda turn with no translator never calls the English model: the reply would be discarded anyway.
    if (wantsLuganda && !translating) {
        const result = { reply: LG_HANDOFF_DRAFT, language: detected, source: 'handoff', retrieved: retrieved.map((r) => ({ heading: r.heading, score: r.score })), handoff: { reason: 'language_guard' }, needs_review: true };
        if (onMeta) onMeta({ ...meta, source: 'handoff', handoff: result.handoff, needs_review: true });
        await delivery.instant(LG_HANDOFF_DRAFT, 'handoff'); result.bubbles = delivery.bubbles(); return result;
    }

    let reply;
    let source = 'model';
    let modelMarked = false;       // the model's [OFF_TOPIC] marker (flagging). [HANDOFF] is tracked separately via meta.handoff.
    let translatedPieces = [];     // real provenance for the Luganda gate: one entry per translated/untranslated piece
    let englishStreamed = false;   // English live text was already delivered to the visitor
    let handoffDelivered = false;
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
    const markProgress = () => { gotFirstToken = true; clearTimeout(modelTimeout); };
    const livePush = delivery.live();

    try {
        if (translating) {
            status('thinking');
            let english = '';
            // Held translation is mandatory (WIP 92c retires LUGANDA_INTERLEAVE): nothing is translated or shown until
            // the English answer is complete and has passed the checks below, so English can never reach a Luganda turn.
            const streamTranslator = translator.createStreaming({
                signal: modelSignal,
                onProgress: () => status('translating'),
                hold: true,
            });
            const gate = markerGate((chunk) => { english += chunk; streamTranslator.push(chunk); });
            await ollama.chatStream(messages, (chunk) => { markProgress(); gate.push(chunk); }, {
                ...modelOpts,
                signal: modelSignal,
                numPredict: loadAdaptive ? Math.min(config.loadMaxTokens, config.maxReplyTokensLg) : config.maxReplyTokensLg,
                numCtx: config.numCtx,
            });
            const marks = gate.end();
            modelMarked = marks.off_topic;
            // the English source is checked against the FULL text of what the model was given (not the trimmed translation prompt)
            const lgContext = validationContext || [contextBlock, ...retrieved.slice(0, profile.contextChunks).map((r) => r.text)].join('\n');
            const lgVerdict = (txt) => validateModelReply(txt, lgContext, faq, { question: workingMessage, foreign: !messageIsEnglish });
            if (marks.handoff) {
                streamTranslator.cancel();
                reply = LG_HANDOFF_DRAFT; meta.handoff = { reason: 'not_in_context' }; source = 'handoff';
            } else if (lgVerdict(english).handoff) {
                streamTranslator.cancel();
                reply = LG_HANDOFF_DRAFT; meta.handoff = { reason: 'not_in_context' }; source = 'handoff';
            } else {
                // WIP 98: the SAME check an English turn gets runs on the English text before it is translated. If it removed an unsupported
                // sentence, only the checked text is translated (a fresh translator: the held one already saw the original).
                let activeTranslator = streamTranslator;
                const checked = lgVerdict(english).text;
                if (checked.trim() !== english.trim()) {
                    streamTranslator.cancel();
                    activeTranslator = translator.createStreaming({ signal: modelSignal, onProgress: () => status('translating'), hold: true });
                    activeTranslator.push(checked);
                }
                let t;
                try { t = await activeTranslator.end(); } catch (terr) { if (!signal?.aborted) stats.translatorFailure('error'); throw terr; }
                if (t && t.translated > 0 && t.translated >= t.total) {
                    reply = t.text;
                    source = 'model+local';
                    // Provenance for the gate: sentences served from translation-memory.json are reviewed wording (approved), the rest is model output.
                    translatedPieces = Array.from({ length: t.total }, (_, i) => ({ translated: true, approved: i < (t.approved || 0) }));
                } else {
                    // Partly or wholly untranslated: the whole answer is discarded, never shown half in English.
                    stats.translatorFailure('partial');
                    reply = LG_HANDOFF_DRAFT; meta.handoff = { reason: 'language_guard' }; source = 'handoff';
                }
            }
        } else if (onToken) {
            const gate = markerGate((t) => livePush(t));
            const raw = await ollama.chatStream(messages, (t) => { markProgress(); gate.push(t); }, { ...modelOpts, signal: modelSignal, numPredict: maxTokens, numCtx: config.numCtx });
            const marks = gate.end();
            modelMarked = marks.off_topic;
            if (marks.handoff && honourModelHandoff({ retrieved, message: workingMessage })) {
                if (delivery.delivered()) delivery.reset();
                reply = await enHandoff(); meta.handoff = { reason: 'not_in_context' }; source = 'handoff';
            } else if (marks.handoff) {
                // WIP 97: the server sees coverage, so the model's own [HANDOFF] is ignored: composed from the guides below instead.
                reply = '';
            } else {
                reply = gate.text.trim() || stripMarkers(raw).text;
                englishStreamed = true;
            }
        } else {
            const stripped = stripMarkers(await ollama.chat(messages, { ...modelOpts, signal: modelSignal, numPredict: maxTokens, numCtx: config.numCtx }));
            reply = stripped.text;
            modelMarked = stripped.off_topic;
            if (stripped.handoff && honourModelHandoff({ retrieved, message: workingMessage })) { reply = await enHandoff(); meta.handoff = { reason: 'not_in_context' }; source = 'handoff'; }
            else if (stripped.handoff) reply = '';
        }
    } catch (err) {
        clearTimeout(modelTimeout);
        if (signal?.aborted) throw err;
        stats.modelError();
        let local;
        if (detected.code === 'en' && retrieved.length) {
            // WIP 97 Part 2.6: Ollama down / timeout / empty: compose 1-3 sentences for THIS question, never a whole section.
            const ex = extractiveAnswer({ message: workingMessage, retrieved, groups: (multi && multi.groups) || [], gap: retrieved[0].gap || null, band: retrieved[0].band || 'answer' });
            local = { reply: ex.text, source: 'fallback', retrieved: retrievedMeta, usedLiveData: Boolean(liveContext) };
        } else {
            local = await fallback.build(retrievalQuery || workingMessage, { audience: context.audience || 'guest' });
        }
        local.reply = detected.code === 'lg' ? LG_HANDOFF_DRAFT : post(local.reply, message);
        if (detected.code === 'lg') meta.handoff = { reason: 'language_guard' };
        const result = {
            ...local,
            reply: local.reply,
            language: detected,
            source: 'fallback',
            smallTalk: false,
            ...(detected.code === 'lg' ? { handoff: meta.handoff, needs_review: true } : {}),
        };
        if (onMeta) onMeta({ ...meta, source: 'fallback', retrieved: local.retrieved || [], ...(meta.handoff ? { handoff: meta.handoff, needs_review: detected.code === 'lg' } : {}) });
        delivery.reset();
        await delivery.instant(local.reply, 'fallback');
        result.bubbles = delivery.bubbles();
        return result;
    } finally {
        clearTimeout(modelTimeout);
    }

    // English wording is validated against the retrieved context. Luganda text is not: its English source was
    // validated above (policy claims) and the translated text passes the Luganda gate below.
    if (detected.code === 'en' && source !== 'handoff') {
        // WIP 97 Part 2.4/2.5: tidy the model's wording; a reply that is empty or only parrots one section becomes the extractive answer.
        reply = cleanEnglishReply(reply, { headings: retrieved.map((r) => r.heading) });
        const sectionTexts = retrieved.slice(0, config.modelProfile.contextChunks).map((r) => r.text);
        if (!isUsableReply(reply) || isParroting(reply, sectionTexts, (multi && multi.groups) || []) || (multi && multi.compound && !partsCovered(reply, multi.parts, retrieved.slice(0, 2).map((r) => r.heading).join(' ')))) {
            const ex = extractiveAnswer({ message: workingMessage, retrieved, groups: (multi && multi.groups) || [], gap: (retrieved[0] && retrieved[0].gap) || null, band: (retrieved[0] && retrieved[0].band) || 'answer' });
            reply = ex.text; meta.composed = ex.kind;
        }
    }
    if (detected.code !== 'lg' && source !== 'handoff') {
        // WIP 100: a reply composed from the guides themselves (extractive) is not a model assertion, so only the model's own words are checked.
        let validation = validateModelReply(reply, validationContext || contextBlock, faq, { question: workingMessage, foreign: false, skipAssertion: Boolean(meta.composed) });
        if (validation.handoff && !validation.assertion && detected.code === 'en' && retrieved.length && !retrieved[0].gap && retrieved[0].band !== 'none') {
            // WIP 97: a model that invents figures must not turn an answerable question into a handoff: compose from the guides instead.
            const ex = extractiveAnswer({ message: workingMessage, retrieved, groups: (multi && multi.groups) || [], gap: null, band: retrieved[0].band || 'answer' });
            const again = validateModelReply(ex.text, validationContext || contextBlock, faq);
            if (!again.handoff) { validation = again; meta.composed = 'after_claim_guard'; }
        }
        if (validation.handoff && validation.text === EN_HANDOFF) validation.text = await enHandoff();
        else if (validation.assertion) validation.text = `${NOT_IN_GUIDES} ${await enHandoff()}`;
        reply = validation.text;
        if (validation.handoff) meta.handoff = validation.handoff;
    }
    const finalGate = gateReply({ lang: detected.code, source, text: post(reply, message), translatedPieces });
    reply = finalGate.text;
    if (finalGate.handoff) { meta.handoff = finalGate.handoff; if (detected.code === 'lg') source = 'handoff'; }
    const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    if (englishStreamed) {
        // The English text was streamed live. If validation or the handoff changed it, replace what the visitor saw.
        if (flat(reply) !== flat(delivery.bubbles().join(' '))) { delivery.reset(); await delivery.instant(reply, source === 'handoff' ? 'handoff' : 'fallback'); }
    } else if (!handoffDelivered) {
        if (source === 'handoff') { delivery.reset(); await delivery.instant(reply, 'handoff'); } else livePush(reply);
    }
    await delivery.drain();
    let bubbles = delivery.bubbles();
    // The stream's final `done` event replaces the provisional tokens in the existing client.
    // Process the complete final text here so links are never injected into partial chunks.
    if (onToken && englishStreamed) {
        reply = post(bubbles.join('\n\n'), message);
        bubbles = reply ? reply.split(/\n\n+/) : [];
    }
    reply = bubbles.join('\n\n');
    const result = {
        reply,
        bubbles,
        language: detected,
        source,
        retrieved: retrievedMeta,
        usedLiveData: Boolean(liveContext),
        smallTalk,
        ...(meta.handoff ? { handoff: meta.handoff, needs_review: detected.code === 'lg' } : {}),
    };
    // Second net: the model judged the question unrelated. Trust it only when the message has no
    // NextaStore / shopping / selling vocabulary (the rules above already found none in unflagged messages).
    if (modelMarked && !meta.handoff && analysis.onTopicHits === 0) {
        result.flag = { type: 'off_topic', reason: 'judged unrelated by the model', conversation: analysis.flaggedRecent + 1 >= DRIFT_THRESHOLD, source: 'model' };
        flagLog.record({ ...result.flag, message, page: context.page, audience: context.audience, lang: detected.code });
    }
    return result;
}


const invariantStats = { recoveries: 0 };
const LAST_RESORT_EN = 'I can help with NextaStore buying, selling, orders, payments, and starting a store. What would you like to know?';

/**
 * WIP 92d last-line invariant. Whatever the routing above did, a non-error, non-aborted result MUST carry a
 * non-empty reply and at least one non-empty bubble (an empty reply used to reach the widget as a blank answer).
 * Otherwise: English turns get the local fallback answer, Luganda turns get the Luganda handoff.
 */
async function runCore(args, hooks = {}) {
    const result = await runCoreInner(args, hooks);
    const { signal } = hooks;
    if (signal && signal.aborted) return result;
    if (result && result.error) return result;
    const okReply = result && typeof result.reply === 'string' && result.reply.trim().length > 0;
    const okBubbles = result && Array.isArray(result.bubbles) && result.bubbles.some((b) => String(b || '').trim());
    if (okReply && okBubbles) return result;

    invariantStats.recoveries += 1;
    stats.recovery();
    const { message, history = [], lang, context = {} } = args;
    const code = effectiveLang(lang, message, history);
    const language = (result && result.language) || { code, label: LANGUAGE_LABELS[code] || code, confidence: 'resolved' };
    const delivery = createDelivery({ onToken: hooks.onToken, onBreak: hooks.onBreak, onTyping: hooks.onTyping, onCards: hooks.onCards, onReset: hooks.onReset, signal, pace: hooks.pace });
    let recovered;
    if (code === 'lg') {
        recovered = { reply: LG_HANDOFF_DRAFT, language, source: 'handoff', retrieved: [], handoff: { reason: 'language_guard' }, needs_review: true };
    } else {
        let local = null;
        try { local = await fallback.build(fallback.resolveFollowupQuery(message, history) || message, { audience: context.audience || 'guest' }); } catch (e) { local = null; }
        const text = fallback.postProcessReply(String((local && local.reply) || '').trim(), message, { lang: code }) || LAST_RESORT_EN;
        recovered = { ...(local || {}), reply: String(text).trim() || LAST_RESORT_EN, language, source: 'fallback', retrieved: (local && local.retrieved) || [], smallTalk: false };
    }
    if (hooks.onReset) hooks.onReset();
    if (hooks.onMeta) hooks.onMeta({ language, source: recovered.source, ...(recovered.handoff ? { handoff: recovered.handoff, needs_review: true } : {}) });
    delivery.reset();
    await delivery.instant(recovered.reply, recovered.source === 'handoff' ? 'handoff' : 'fallback');
    recovered.bubbles = delivery.bubbles();
    if (!recovered.bubbles.length) recovered.bubbles = [recovered.reply];
    return recovered;
}

/**
 * Public turn wrapper: cache complete model answers and merge identical model
 * requests. Only empty-history, non-live, non-flagged model answers are cached.
 */
async function run({ message, history = [], lang, context = {} }, hooks = {}) {
    const { onToken, onBreak, onTyping, onCards, onReset, pace, signal } = hooks;
    const delivery = createDelivery({ onToken, onBreak, onTyping, onCards, onReset, signal, pace });
    const audience = context.audience || 'guest';
    const resolvedLang = effectiveLang(lang, message, history);
    const detected = { code: resolvedLang || detectLangForCache(message).code };
    const language = detected.code || 'en';
    // WIP 92d: Luganda turns never touch the answer cache or the in-flight map. A concurrent identical Luganda
    // question must get its own answer, never a handoff produced for someone else's request.
    const canCache = history.length === 0 && language !== 'lg';
    const key = canCache ? answerCache.keyOf(message, language, audience) : '';
    if (canCache && key) {
        const cached = answerCache.get(key);
        if (cached) {
            const result = { ...cached, source: 'cache' };
            if (hooks.onMeta) hooks.onMeta({ language: result.language, source: result.source });
            await delivery.instant(result.bubbles || result.reply, 'cache');
            result.bubbles = delivery.bubbles();
            return result;
        }
        const existing = answerCache.getInflight(key);
        if (existing) {
            const base = await existing;
            const result = { ...base, source: 'cache' };
            if (hooks.onMeta) hooks.onMeta({ language: result.language, source: result.source });
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

/** WIP 93: count every served turn (cached ones too) and log handoffs, without changing what the turn returns. */
const runUncounted = run;
async function runObserved(args, hooks = {}) {
    const result = await runUncounted(args, hooks);
    try {
        if (!(hooks.signal && hooks.signal.aborted) && result && !result.error) {
            stats.turn();
            const ctx = (args && args.context) || {};
            const top = (result.retrieved && result.retrieved[0] && result.retrieved[0].heading) || '';
            const lang = result.language && result.language.code;
            if (result.handoff) {
                stats.handoff(result.handoff.reason);
                flagLog.recordHandoff({ reason: result.handoff.reason, message: args && args.message, lang, source: result.source, page: ctx.page, audience: ctx.audience, top });
            } else if (result.source === 'clarify') {
                // WIP 99: a clarify (chips or plain question) is a question the guides did not settle: kept for the weekly traffic review
                flagLog.recordTraffic({ type: 'clarify', reason: (result.tier && result.tier.reason) || '', message: args && args.message, lang, source: result.source, page: ctx.page, audience: ctx.audience, route: `clarify:${(result.tier && result.tier.reason) || 'clarify'}`, top });
            } else if (require('./gapLine').isNotInGuidesReply(result.reply)) {
                flagLog.recordTraffic({ type: 'unsure', reason: 'not_in_guides', message: args && args.message, lang, source: result.source, page: ctx.page, audience: ctx.audience, route: 'unsure:not_in_guides', top });
            }
        }
    } catch (e) { /* observability must never break an answer */ }
    return result;
}

module.exports = { run: runObserved, answer, invariantStats, LANGUAGE_LABELS, formatContext, ensureLuganda, validateModelReply, LG_SMALLTALK_DRAFTS };
