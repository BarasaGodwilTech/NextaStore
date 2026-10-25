'use strict';
/**
 * WIP 97 Part 3: "Nexi knows itself". A deterministic intent for questions about the assistant. The answer is the matching
 * section of src/knowledge/12-about-nexi.md, verbatim: nothing about internals, model names or prompts is ever improvised.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { chunkMarkdown } = require('../rag/chunk');

const FILE = path.join(config.knowledgeDir, '12-about-nexi.md');
const norm = (m) => String(m || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const BOTWORD = '(?:person|human|bot|robot|ai|chatbot|machine|computer|actual person|real person|real human)';

const RULES = [
    { id: 'Real person or a bot', re: [new RegExp(`\\bare\\s+(?:you|u)\\s+(?:a\\s+|an\\s+)?(?:real\\s+|actual\\s+)?${BOTWORD}\\b`), new RegExp(`\\bam\\s+i\\s+(?:talking|chatting|speaking|texting)\\s+(?:to|with)\\s+(?:a\\s+|an\\s+)?(?:real\\s+|actual\\s+)?${BOTWORD}\\b`), new RegExp(`\\bis\\s+(?:this|it|that|nexi)\\s+(?:a\\s+|an\\s+)?(?:real\\s+|actual\\s+)?${BOTWORD}\\b`), /\bis\s+(?:a\s+)?(?:real\s+)?(?:person|human)\s+(?:typing|replying|answering|behind)\b/, /\b(?:real|actual)\s+(?:person|human)\s+or\s+(?:a\s+)?(?:bot|robot|ai|machine)\b/, /\b(?:bot|robot|ai)\s+or\s+(?:a\s+)?(?:real\s+|actual\s+)?(?:person|human)\b/, /\bare\s+you\s+(?:even\s+)?(?:alive|real)\b/] },
    { id: 'Who made Nexi and what it runs on', re: [/\bwho\s+(?:made|created|built|developed|programmed|designed|owns|trained)\s+(?:you|u|nexi)\b/, /\bwhat\s+(?:model|ai|llm|technology|tech|system|engine|software)\s+(?:are\s+you|do\s+you\s+(?:use|run)|is\s+this|powers?\s+you|runs?\s+you|is\s+nexi)\b/, /\b(?:which|what)\s+(?:model|llm|ai\s+model)\b.*\b(?:you|nexi|this)\b/, /\bare\s+(?:you|u)\s+(?:chat\s*gpt|gpt|gemini|claude|llama|qwen|openai|bard|copilot|deepseek)\b/, /\b(?:show|tell|reveal|print|repeat|share)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|rules|code)\b/, /\bwhat\s+(?:is|are)\s+your\s+(?:system\s+)?(?:prompt|instructions)\b/, /\bhow\s+(?:do|does)\s+(?:you|nexi)\s+(?:work|run)\s+(?:inside|internally|under the hood)\b/] },
    { id: 'Nexi and your account', re: [/\bcan\s+(?:you|u|nexi)\s+(?:see|access|view|read|check|look\s+at|open)\s+(?:my|the|our)\s+(?:account|orders?|messages?|chats?|data|balance|details|info|information|password|profile|store|payments?)\b/, /\bdo\s+(?:you|u)\s+(?:have|got)\s+access\s+to\s+(?:my|the)\s+(?:account|orders?|messages?|data|details)\b/, /\bdo\s+(?:you|u)\s+(?:know|see)\s+(?:my|the)\s+(?:password|account|orders?|balance)\b/] },
    { id: 'Are my chats private', re: [/\b(?:are|is)\s+(?:my|our|this|these)\s+(?:chats?|conversations?|messages?\s+(?:with\s+you|here)|questions?)\s+(?:private|safe|secure|confidential|secret)\b/, /\bwho\s+(?:can|could)\s+(?:read|see)\s+(?:my|our|this)\s+(?:chats?|conversations?)\b/, /\bdo\s+(?:you|u)\s+(?:keep|save|store|record|remember)\s+(?:my|our)\s+(?:chats?|conversations?|questions?|messages?)\b/, /\bis\s+it\s+safe\s+to\s+(?:talk|chat|speak)\s+(?:to|with)\s+(?:you|nexi)\b/] },
    { id: "Where Nexi's answers come from", re: [/\bhow\s+(?:do|did|does)\s+(?:you|u|nexi)\s+(?:get|know|find|come\s+up\s+with|learn)\s+(?:your|the|all|this|that|these|answers?|info)/, /\bwhere\s+(?:do|does)\s+(?:your|you|nexi'?s?)\s+(?:answers?|info|information|knowledge|facts|data)\b.*\b(?:come|from|get)\b/, /\bwhere\s+(?:do|did)\s+(?:you|u)\s+(?:get|learn)\s+(?:your|this|that|the|these)\b/, /\bare\s+(?:your|ur)\s+answers?\s+(?:correct|accurate|reliable|true|right|always\s+right)\b/, /\b(?:can|should)\s+i\s+trust\s+(?:you|what\s+you\s+say|your\s+answers?|nexi)\b/, /\bdo\s+(?:you|u)\s+(?:make|get)\s+mistakes?\b/] },
    { id: 'What Nexi is', re: [/\b(?:who|what)\s+(?:are|r)\s+(?:you|u)\b/, /\b(?:who|what)\s+(?:is|s)\s+nexi\b/, /\btell\s+me\s+about\s+(?:yourself|nexi|you)\b/, /\bintroduce\s+yourself\b/, /\bwhat\s+(?:can|do)\s+(?:you|u)\s+(?:do|help\s+(?:me\s+)?with)\b/, /\bwhat\s+(?:is|are)\s+(?:your|ur)\s+(?:name|job|purpose|role)\b/, /\bwhat\s+(?:is|s)\s+your\s+name\b/, /\byour\s+name\b/] },
];

let cache = null; let stamp = '';
function sections() {
    let st = 'none'; try { const s = fs.statSync(FILE); st = `${s.mtimeMs}:${s.size}`; } catch (e) { return new Map(); }
    if (cache && st === stamp) return cache;
    const { chunks } = chunkMarkdown('12-about-nexi.md', fs.readFileSync(FILE, 'utf8'));
    cache = new Map(chunks.map((c) => [c.heading, c.text.trim()])); stamp = st;
    return cache;
}

/** @returns {{id: string, text: string}|null} */
function match(message) {
    const m = norm(message);
    if (!m || m.split(' ').length > 18) return null;
    const secs = sections();
    for (const rule of RULES) {
        if (rule.re.some((re) => re.test(m)) && secs.has(rule.id)) return { id: rule.id, text: secs.get(rule.id) };
    }
    return null;
}

module.exports = { match, sections, RULES };
