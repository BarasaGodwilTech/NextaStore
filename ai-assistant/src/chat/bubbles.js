'use strict';
/**
 * Chat bubbles (WIP 63, reworked in WIP 64).
 * An answer is delivered as a few short messages, like a person typing, not one wall of text.
 *  - splitReply(text)      finished text -> array of bubble strings (instant answers)
 *  - createBubbleGate(...) live model text -> onToken / onBreak calls
 * Rules shared by both: a blank line starts a new bubble; a list always stays inside one bubble
 * (together with the sentence that introduces it when that sentence ends with ":"); a link-only
 * line stays with the bubble before it; at most MAX_BUBBLES bubbles per answer.
 */
const MAX_BUBBLES = 4;
const SOFT_LIMIT = 180; // a plain paragraph longer than this is cut at a sentence end (finished text)
const GATE_MIN = 110;   // live text: break after one sentence once the bubble is this long, or after two sentences

const LIST_LINE = /(^|\n)[ \t]*(?:[-*\u2022]|\d+[.)])[ \t]+\S/;
const LINK_ONLY = /^\s*\[[^\]\n]{1,80}\]\(\/[A-Za-z0-9\-_/]*\)\s*$/;
const SENTENCE_END = /[.!?]["')\]\u201D\u2019]*$/;
const LIST_MARKER_TAIL = /(^|\s)\d+[.)]$/; // "Step 1." must not count as a finished sentence

function isList(block) { return LIST_LINE.test(block); }

function countSentences(text) { return (String(text).match(/[.!?]+(?=\s|$)/g) || []).length; }

/** Group sentences, at most two per bubble and about SOFT_LIMIT characters. */
function splitSentences(paragraph) {
    const sentences = (paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [paragraph]).map((s) => s.trim()).filter(Boolean);
    const out = [];
    let cur = [];
    let len = 0;
    for (const s of sentences) {
        if (cur.length && (cur.length >= 2 || len + 1 + s.length > SOFT_LIMIT)) { out.push(cur.join(' ')); cur = []; len = 0; }
        cur.push(s);
        len += (len ? 1 : 0) + s.length;
    }
    if (cur.length) out.push(cur.join(' '));
    return out;
}

/** Too many bubbles: join the shortest neighbouring pair until the limit is met. */
function mergeDown(bubbles, max) {
    const out = bubbles.slice();
    while (out.length > max && out.length > 1) {
        let at = 0;
        let best = Infinity;
        for (let i = 0; i < out.length - 1; i += 1) {
            const size = out[i].length + out[i + 1].length;
            if (size < best) { best = size; at = i; }
        }
        out.splice(at, 2, `${out[at]}\n\n${out[at + 1]}`);
    }
    return out;
}

function splitReply(text, { max = MAX_BUBBLES } = {}) {
    const clean = String(text || '').replace(/\r/g, '').trim();
    if (!clean) return [];
    const out = [];
    for (const block of clean.split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean)) {
        if (out.length && LINK_ONLY.test(block)) { out[out.length - 1] += `\n\n${block}`; continue; }
        if (isList(block) || block.length <= SOFT_LIMIT) out.push(block);
        else out.push(...splitSentences(block));
    }
    return mergeDown(out, Math.max(1, max));
}

/**
 * Live version for streamed text. push(chunk) forwards text through onToken and calls onBreak()
 * where a new bubble should start.
 * Whitespace is held back until the next visible text arrives, because only then is it known whether
 * the gap is a blank line (new bubble), a line break, a sentence gap or just a space. That also means
 * a break is only ever emitted when more text really follows, so there is never an empty last bubble,
 * and it works for tokens that carry their space at the start (" Next") or at the end.
 * Text in one push() call is passed on in one onToken call (split only where a break falls).
 */
function createBubbleGate(onToken, onBreak, { max = MAX_BUBBLES } = {}) {
    let bubbles = 1;
    let text = '';  // text of the current bubble (what has been passed on, plus anything queued in out)
    let ws = '';    // whitespace waiting for the next visible text
    let out = '';

    function flush() { if (out) { const t = out; out = ''; onToken(t); } }
    function put(t) { text += t; out += t; }

    function wantsBreak(gap) {
        if (bubbles >= max || !text) return false;
        if (/\n[ \t]*\n/.test(gap)) return true;
        if (isList(text)) return false;
        if (!SENTENCE_END.test(text) || LIST_MARKER_TAIL.test(text)) return false;
        return countSentences(text) >= 2 || text.length >= GATE_MIN;
    }

    function push(chunk) {
        const s = String(chunk || '');
        if (!s) return;
        for (const piece of s.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) { ws += piece; continue; }
            if (ws) {
                if (text) {
                    if (wantsBreak(ws)) { flush(); if (onBreak) onBreak(); bubbles += 1; text = ''; }
                    else put(ws);
                }
                ws = '';
            }
            put(piece);
        }
        flush();
    }
    return { push, count: () => bubbles };
}

module.exports = { splitReply, createBubbleGate, isList, MAX_BUBBLES, SOFT_LIMIT };
