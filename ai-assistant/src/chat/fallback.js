'use strict';

const { retrieve } = require('../rag/retrieve');
const { ALLOWED_PATHS } = require('./systemPrompt');

const LINK_RULES = [
    { re: /\b(seller\s*pass|subscription|trial|renew(?:al)?|badge|coverage)\b/i, path: '/subscription', label: 'Open Seller Pass' },
    { re: /\b(report(?:ing)?|scam|fraud|unsafe|safety|harass(?:ment)?|abuse|fake seller)\b/i, path: '/safety', label: 'Open Safety' },
    { re: /\b(order|orders|cancel|delivery|pickup|checkout|cart|pay by card|payment by card|track(?:ing)? (?:my )?order)\b/i, path: '/orders', label: 'Open Orders' },
    { re: /\b(message|contact|support)\b/i, path: '/messages', label: 'Open Messages' },
    { re: /\b(sign ?up|register|create an account|open a store|start a store|onboard)\b/i, path: '/signup', label: 'Open a store' },
    { re: /\b(?:become a seller|start selling|sell on|create a store|open a store|start a store)\b/i, path: '/signup', label: 'Open a store' },
    { re: /\b(buy|product|marketplace|search|favorite|favourite|follow)\b/i, path: '/marketplace', label: 'Open Marketplace' },
    { re: /\b(login|log in|password|account|sign in|forgot password|remember me)\b/i, path: '/login', label: 'Open Login' },
];

const LINK_REQUEST_RE = /^(?:i\s+)?(?:want|need|send|give|show|share)?\s*(?:me\s+)?(?:the\s+)?(?:link|url)(?:\s+please)?[.!?]*$|^(?:where\s+(?:is\s+it|do\s+i\s+click)|take\s+me\s+there|open\s+it|link\s+please|where\s+is\s+the\s+page)[.!?]*$/i;
const REFERENCE_ONLY_RE = /^(?:it|that|this|the\s+link|link|yes|yeah|where|where\s+is\s+it|how\s+long|and\s+card\??|why|link\s+please|take\s+me\s+there|open\s+it|where\s+is\s+the\s+page)[.!?\s]*$/i;

function lastHistoryMessage(history, role) {
    for (let i = (Array.isArray(history) ? history.length : 0) - 1; i >= 0; i--) {
        if (history[i] && history[i].role === role && String(history[i].content || '').trim()) return String(history[i].content).trim();
    }
    return '';
}

function resolveFollowupQuery(message, history = []) {
    const original = String(message || '').trim();
    const words = original.split(/\s+/).filter(Boolean);
    if (words.length > 8 && !REFERENCE_ONLY_RE.test(original)) return original;
    if (!REFERENCE_ONLY_RE.test(original) && !LINK_REQUEST_RE.test(original) && !/^(?:and\s+card|how\s+long|where|why|yes|link please|take me there|open it)\b/i.test(original)) return original;
    const previousUser = lastHistoryMessage(history, 'user');
    const previousAssistant = lastHistoryMessage(history, 'assistant');
    if (!previousUser && !previousAssistant) return original;
    return [previousUser, previousAssistant].filter(Boolean).map((s) => s.slice(0, 500)).join('\n');
}

function linkRequestReply(message, history = []) {
    if (!LINK_REQUEST_RE.test(String(message || '').trim())) return '';
    const previousUser = lastHistoryMessage(history, 'user');
    const previousAssistant = lastHistoryMessage(history, 'assistant');
    const topic = `${previousUser} ${previousAssistant}`.trim();
    const link = topic ? linkFor(topic) : '';
    if (link) return `Here’s the page you were asking for: ${link}`;
    return 'Which page do you need: [sign up](/signup), [Seller Pass](/subscription), [orders](/orders), or the [marketplace](/marketplace)?';
}

function postProcessReply(reply, intentText = '', opts = {}) {
    let text = String(reply || '');
    const protectedParts = [];
    const originalLinks = (text.match(/!?\[[^\]\n]{1,120}\]\([^\)\n]{1,240}\)/g) || []).length;
    const protect = (value) => `\u0000${protectedParts.push(value) - 1}\u0000`;
    // Preserve code spans and existing markdown links exactly as written.
    text = text.replace(/```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]{1,120}\]\([^\)\n]{1,240}\)|https?:\/\/[^\s)]+/gi, protect);
    text = text.replace(/(^|[^A-Za-z0-9_])\/(marketplace|stores|signup|login|dashboard|product-form|subscription|orders|messages|favorites|following|cart|safety|terms|privacy)\b/g, (all, before, slug) => {
        const path = `/${slug}`;
        const label = LINK_RULES.find((r) => r.path === path)?.label || (path === '/login' ? 'Open Login' : path);
        return `${before}[${label}](${path})`;
    });
    const existing = originalLinks + (text.match(/\[[^\]]+\]\((\/[^)]+)\)/g) || []).length;
    const intentLink = linkFor(intentText);
    if (existing < 2 && intentLink && !text.includes(intentLink) && existing === 0 && /\b(?:go to|visit|open|use|click|check|head to|find it on|the page|page for|\bpage\b|link)\b/i.test(text)) text += `\n\n${intentLink}`;
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => protectedParts[Number(i)] || '');
    // WIP 92c: link labels are English; on a Luganda turn they come from the reviewed-draft table in lang/lgLinks.js.
    if (opts && opts.lang === 'lg') text = require('../lang/lgLinks').localizeLinkLabels(text);
    return text;
}

/**
 * WIP 81: the model must never see an internal knowledge-file name (NN-name.md): it repeats them to the user.
 * Removes every such reference from one chunk's text, a reference wrapped over a line break included (any
 * whitespace counts as the separator), and tidies what the removal leaves, with the same rules as the client
 * (js/assistant.js inline()): the lead-in directly before it (see, see also, refer to, in, from, per, at), the
 * connector between two names, a bracket group that held only names, a comma or dash that led into a name ending
 * a clause. Text without such a name is returned unchanged, byte for byte. Gaps are capped ({0,20}) so no input
 * can make these patterns slow.
 */
function scrubFileNames(text) {
    const s = typeof text === 'string' ? text : String(text);
    const hasName = /\b\d{2}-[A-Za-z0-9_-]{1,80}\.md/.test(s);
    const hasFactsPointer = /(?:generated\s+platform\s+facts\s+file|platform\s+facts\s+file|generated\s+facts\s+file|in\s+this\s+knowledge\s+base|hardcoded|because\s+this\s+is\s+admin-configurable)/i.test(s);
    if (!hasName && !hasFactsPointer) return s;
    const lead = /(^|[\s(\[,\u2013\u2014])(?:(?:see also|see|refer to|in|from|per|at)\s{1,20}){1,3}\u0001/gi;
    let out = hasName ? s.replace(/\u0001/g, '')
        .replace(/`?\b\d{2}-[A-Za-z0-9_-]{1,80}\.md`?/g, '\u0001')
        .replace(/\u0001(?:(?:\s{0,20},\s{0,20}(?:(?:and|or)\s{1,20})?|\s{1,20}(?:and|or)\s{1,20}|\s{0,20})\u0001)+/gi, '\u0001')
        .replace(lead, '$1\u0001').replace(/\(\s{0,20}\u0001+\s{0,20}\)/g, '\u0001').replace(lead, '$1\u0001')
        .replace(/(?:[ \t]{0,20}[,\u2013\u2014]|[ \t]-)\s{0,20}\u0001+(?=[ \t]{0,20}(?:[)\]]|[.,;:!?]|\n|$))/g, '')
        .replace(/([.!?])[ \t]{0,20}\u0001+(?:[.,;:?]|!(?!\[))+/g, '$1')
        .replace(/(^|\n)([ \t]{0,40}(?:(?:[-*\u2022]|\d{1,3}[.)])[ \t]{1,20})?)\u0001+(?:[.,;:?]|!(?!\[))*[ \t]{0,20}/g, '$1$2')
        .replace(/([ \t]{0,20})\u0001+([ \t]{0,20})/g, (all, a, b, at, str) => {
            const next = str.charAt(at + all.length);
            const punct = /[.,;:?)\]]/.test(next) || (next === '!' && str.charAt(at + all.length + 1) !== '[');
            if (!next || next === '\n' || (!b && punct) || /[(\[]/.test(at ? str.charAt(at - 1) : '')) return '';
            return a || b ? ' ' : '';
        }) : s;

    // WIP 85: never expose the generated platform-facts pointer in user-facing knowledge.
    // Remove a containing bracket group first; otherwise remove only the whole sentence that holds the pointer.
    // All gaps are bounded so malformed input cannot make these patterns slow.
    out = out.replace(/[ \t\r\n]{0,20}\([^()]{0,400}?(?:generated\s+platform\s+facts\s+file|platform\s+facts\s+file|generated\s+facts\s+file)[^()]{0,400}?\)([.!?])?/ig, '$1')
        .replace(/(^|[.!?])[ \t\r\n]{0,20}Because this is admin-configurable, the exact list of available methods can change over time without any code changes\./ig, '$1')
        .replace(/(^|[.!?])[ \t\r\n]{0,20}[^.!?]{0,1200}?(?:generated\s+platform\s+facts\s+file|platform\s+facts\s+file|generated\s+facts\s+file|in\s+this\s+knowledge\s+base|hardcoded)[^.!?]{0,1200}[.!?]/ig, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/([.!?])[ \t]+(?=[.!?])/g, '$1')
        .replace(/\(\s{0,20}\)/g, '')
        .replace(/^ +/, '')
        .replace(/\.{2,}/g, '.');
    // The removed hardcoded-methods sentence owned this lead-in; do not leave it dangling above the bullets.
    if (/hardcoded/i.test(s)) out = out.replace(/^This means:[ \t]*\r?\n(?=\s*[-*])/i, '');
    return out;
}

function firstSentences(text, max = 4) {
    const cleaned = String(text || '')
        .replace(/^#+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    // WIP 84: a sentence ends at one or more . ! ? followed by any closing quote or bracket and then whitespace or
    // the end. A "." anywhere else (v1.2, 5.5%, a web address) is not a boundary, "e.g." / "i.e." followed by a
    // space is not one either, and no text is ever dropped: the part after the last full stop is kept as the
    // last piece. The lookbehind lets a match start only at the first mark of a run, so the scan stays linear.
    const ending = /(?<![.!?])[.!?]+[)\]"'\u2019\u201D\u00BB\u203A]*(?:\s|$)/g;
    const sentences = [];
    let start = 0;
    let hit;
    while ((hit = ending.exec(cleaned)) !== null) {
        if (/^\.\s$/.test(hit[0]) && /(?:^|[^A-Za-z0-9])(?:e\.g|i\.e)$/i.test(cleaned.slice(Math.max(0, hit.index - 4), hit.index))) continue;
        // WIP 86: a 1-3 digit list marker followed by text is not a sentence end.
        if (/^\.\s$/.test(hit[0]) && /(?:^|[:;,]\s)\d{1,3}$|(?:^|\s)(?:step|steps)\s+\d{1,3}$/i.test(cleaned.slice(0, hit.index)) && /\S/.test(cleaned.slice(hit.index + hit[0].length))) continue;
        const stop = hit.index + hit[0].length;
        sentences.push(cleaned.slice(start, stop));
        start = stop;
    }
    if (start < cleaned.length) sentences.push(cleaned.slice(start));
    return sentences.slice(0, max).join(' ').trim();
}

function condense(text, { maxSentences = 4 } = {}) {
    const lines = String(text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*#{1,6}\s*/, '').trimEnd());
    const blocks = [];
    let current = [];
    const flush = () => {
        if (current.some((line) => line.trim())) blocks.push(current);
        current = [];
    };
    for (const line of lines) {
        if (!line.trim()) flush();
        else current.push(line);
    }
    flush();

    return blocks.map((linesInBlock) => {
        const hasList = linesInBlock.some((line) => /^\s*(?:[-*\u2022]|\d+[.)])\s+\S/.test(line));
        if (hasList) {
            // Lists are already concise, so keep each complete item and its intro line.
            // Never join them into prose: doing so is what used to cut a bullet in half.
            return linesInBlock.join('\n').trim();
        }
        return firstSentences(linesInBlock.join(' '), maxSentences);
    }).filter(Boolean).join('\n\n').trim();
}

function linkFor(message) {
    const hit = LINK_RULES.find((x) => x.re.test(message));
    if (!hit || !ALLOWED_PATHS.split(/\s+/).includes(hit.path)) return '';
    return `[${hit.label}](${hit.path})`;
}

// A guide section that points at the generated facts (old wording: "see the generated platform facts file"; current wording: "... is supplied by the live platform rules").
// WIP 98: the current wording is recognised too, so those sections still get their facts companion (the figures live only there).
const FACTS_POINTER_RE = /(?:generated\s+platform\s+facts\s+file|platform\s+facts\s+file|generated\s+facts\s+file|(?:supplied|provided|given|set)\s+by\s+the\s+live\s+platform\s+rules)/i;

const LEGACY_POINTER_RE = /(?:generated\s+platform\s+facts\s+file|platform\s+facts\s+file|generated\s+facts\s+file)/i;
/** The chunk that points at the generated facts, when the answer needs them. The current wording only counts on the TOP chunk: a weak runner-up must not pull in unrelated facts. */
function factsPointerChunk(retrieved) {
    return (retrieved || []).find((r, i) => LEGACY_POINTER_RE.test(String(r.text || '')) || (i === 0 && FACTS_POINTER_RE.test(String(r.text || '')))) || null;
}

function selectFactsCompanion(wider, retrieved, message) {
    const facts = wider.filter((r) => /(?:^|\/)90-project-facts\.generated\.md$/i.test(String(r.source || '')) && Number(r.score) > 0);
    const pointerChunk = factsPointerChunk(retrieved);
    const hint = `${String(pointerChunk?.source || '')} ${String(pointerChunk?.heading || '')} ${String(message || '')}`.toLowerCase();
    const topicRules = [
        [/badge|tier|verified seller|gold partner|platinum partner/, /Seller badge tiers/i],
        [/seller.?pass|subscription|trial|renew|coverage|price|payment for.*pass/, /Seller Pass price, cost, fee and free trial/i],
        [/buyer.*order|order status|track.*order|where.*orders?/, /Order statuses and what buyers see/i],
        [/seller.*order|manage.*orders?|move.*order/, /How a seller moves an order along/i],
        [/cancel|cancellation/, /Can a buyer cancel an order/i],
        [/delivery|pickup|service|digital listing/, /Delivery, pickup and listing types/i],
        [/password|sign.?up|account|verification e-mail|verification email|reset.*password/, /Account, passwords and sign-in e-mails/i],
        [/support|contact|help|e-mail|email/, /Contact and support/i],
        [/refund|refundable|money back/, /Seller Pass price, cost, fee and free trial/i],
        [/store setup|open.*store|sign.?up|onboarding|store basics/, /Store setup steps/i],
    ];
    const mappedHeading = topicRules.find(([re]) => re.test(hint))?.[1];
    return (mappedHeading && facts.find((r) => mappedHeading.test(String(r.heading || '')))) || facts[0] || null;
}

// WIP 88 (D24): the platform overview is only a useful extra chunk when the question is about the
// platform itself. Behind a higher-ranked chunk from another file it just appends the whole overview list.
const OVERVIEW_SOURCE_RE = /(?:^|\/)00-platform-overview\.md$/i;
const OVERVIEW_QUESTION_RE = /\bwhat\s+(?:is|'s)\s+nextastore\b|\bwhat\s+can\s+i\s+do\s+(?:here|on\s+(?:nextastore|this\s+\w+))\b|\bhow\s+does\s+(?:nextastore|this\s+(?:platform|site|marketplace|app))\s+work\b|^\s*how\s+does\s+it\s+work\s*[?.!]*\s*$|\bwhat\s+is\s+this\s+(?:platform|site|app|marketplace)\b|\b(?:tell\s+me\s+)?about\s+nextastore\b|\b(?:platform|site|marketplace)\s+overview\b/i;
function dropTrailingOverview(retrieved, message) {
    if (OVERVIEW_QUESTION_RE.test(String(message || ''))) return retrieved;
    return retrieved.filter((r, i) => {
        if (i === 0 || !OVERVIEW_SOURCE_RE.test(String(r.source || ''))) return true;
        return !retrieved.slice(0, i).some((h) => !OVERVIEW_SOURCE_RE.test(String(h.source || '')));
    });
}

async function build(message, { audience = 'guest', topK = 2 } = {}) {
    let retrieved = [];
    try { retrieved = await retrieve(message, Math.max(1, Math.min(2, topK))); } catch (err) { retrieved = []; }
    retrieved = dropTrailingOverview(retrieved, message);
    let companion = null;
    const hasPointer = Boolean(factsPointerChunk(retrieved));
    const hasFacts = retrieved.some((r) => /(?:^|\/)90-project-facts\.generated\.md$/i.test(String(r.source || '')));
    if (hasPointer && !hasFacts) {
        try {
            const wider = await retrieve(message, 100);
            companion = selectFactsCompanion(wider, retrieved, message);
        } catch (err) { companion = null; }
    }

    if (retrieved.length && /Seller Pass/i.test(String(retrieved[0].source || '')) && !/\border\b/i.test(String(message || ''))) {
        retrieved = retrieved.filter((r, i) => i === 0 || !/^Can a buyer cancel an order/i.test(String(r.heading || '')));
    }
    const selected = companion ? [...retrieved, { ...companion, isFactsCompanion: true }] : retrieved;
    if (selected.length) {
        const parts = selected.slice(0, 3).map((r) => condense(scrubFileNames(r.text), { maxSentences: 4 })).filter(Boolean);
        let reply = postProcessReply(parts.join('\n\n') || generic(), message);
        return {
            reply,
            source: 'fallback',
            retrieved: selected.map((r) => ({ source: r.source, heading: r.heading, score: Number(r.score.toFixed(3)) })),
            usedLiveData: false,
        };
    }

    return { reply: generic(), source: 'fallback', retrieved: [], usedLiveData: false };
}

function generic() {
    return 'I can help with NextaStore buying, selling, orders, payments, and starting a store. You can ask “How do I open a store?” or “How do I cancel an order?”';
}

module.exports = { FACTS_POINTER_RE, factsPointerChunk, build, firstSentences, condense, generic, scrubFileNames, selectFactsCompanion, linkFor, dropTrailingOverview, resolveFollowupQuery, linkRequestReply, postProcessReply };
