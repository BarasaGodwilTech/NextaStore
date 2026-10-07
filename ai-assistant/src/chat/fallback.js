'use strict';

const { retrieve } = require('../rag/retrieve');
const { ALLOWED_PATHS } = require('./systemPrompt');

const LINK_RULES = [
    { re: /\b(message|contact|seller|support)\b/i, path: '/messages', label: 'Open Messages' },
    { re: /\b(safe|safety|scam|fraud|password|otp|pin)\b/i, path: '/safety', label: 'Open Safety' },
    { re: /\b(order|cancel|delivery|pickup|checkout|cart)\b/i, path: '/orders', label: 'Open Orders' },
    { re: /\b(pass|subscription|trial|badge|renew|coverage)\b/i, path: '/subscription', label: 'Open Seller Pass' },
    { re: /\b(store|sell|seller|selling|open|start|onboard|shop)\b/i, path: '/signup', label: 'Open a store' },
    { re: /\b(buy|product|shop|marketplace)\b/i, path: '/marketplace', label: 'Open Marketplace' },
    { re: /\b(login|password|account|sign in)\b/i, path: '/login', label: 'Open Login' },
];

function firstSentences(text, max = 4) {
    const cleaned = String(text || '')
        .replace(/^#+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    const sentences = cleaned.match(/[^.!?]+[.!?](?:\s|$)|[^.!?]+$/g) || [cleaned];
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

async function build(message, { audience = 'guest', topK = 2 } = {}) {
    let retrieved = [];
    try { retrieved = await retrieve(message, Math.max(1, Math.min(2, topK))); } catch (err) { retrieved = []; }

    if (retrieved.length) {
        const parts = retrieved.slice(0, 2).map((r) => condense(r.text, { maxSentences: 4 })).filter(Boolean);
        let reply = parts.join('\n\n');
        const link = linkFor(message);
        if (link && !reply.includes(link)) reply += `\n\n${link}`;
        return {
            reply: reply || generic(),
            source: 'fallback',
            retrieved: retrieved.map((r) => ({ source: r.source, heading: r.heading, score: Number(r.score.toFixed(3)) })),
            usedLiveData: false,
        };
    }

    return { reply: generic(), source: 'fallback', retrieved: [], usedLiveData: false };
}

function generic() {
    return 'I can help with NextaStore buying, selling, orders, payments, and starting a store. You can ask “How do I open a store?” or “How do I cancel an order?”';
}

module.exports = { build, firstSentences, condense, generic };
