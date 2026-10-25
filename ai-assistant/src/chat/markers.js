'use strict';
/**
 * WIP 92c: ONE marker gate for model output (dependency-free).
 *
 * The system prompt lets the model begin a reply with [OFF_TOPIC] (unrelated question) or
 * [HANDOFF] (not in the knowledge base, hand over to a human). Both markers are protocol, never
 * visitor text, and the two flags are kept apart:
 *   off_topic -> the turn may be flagged (relevance.js decides whether to trust it)
 *   handoff   -> the reply is replaced by the handoff text and handoff metadata is attached
 *
 * Streaming contract: clean text goes to onText LIVE. The only text held back is a trailing piece
 * that could still turn into a marker (it starts with "[" and is a proper prefix of a marker), so
 * a normal reply is delayed by at most a handful of characters and only when it really looks like
 * the start of a marker. Markers split across chunks are recognised; markers are removed wherever
 * they appear (leading or mid-text) so the streamed text always equals the final reply.
 *
 * A LEADING [HANDOFF] means the model's own prose is going to be replaced by the handoff text, so
 * everything after it is swallowed (never streamed) and `suppressed` is true.
 */
const MARKERS = [
    { name: 'off_topic', text: '[OFF_TOPIC]' },
    { name: 'handoff', text: '[HANDOFF]' },
];
const MAX_MARKER = Math.max(...MARKERS.map((m) => m.text.length));
const MARKER_RES = MARKERS.map((m) => ({ ...m, re: new RegExp(m.text.replace(/[[\]]/g, '\\$&'), 'ig') }));

/** Length of the longest suffix of s that is a PROPER prefix of some marker (case-insensitive). */
function pendingSuffixLength(s) {
    const lower = s.toLowerCase();
    const from = Math.max(0, lower.length - (MAX_MARKER - 1));
    for (let i = from; i < lower.length; i++) {
        if (lower[i] !== '[') continue;
        const tail = lower.slice(i);
        if (MARKERS.some((m) => m.text.toLowerCase().startsWith(tail) && tail.length < m.text.length)) return lower.length - i;
    }
    return 0;
}

/** Remove every marker from a complete string. Pure; used for non-streaming text. */
function stripMarkers(text) {
    let s = String(text || '');
    const flags = { off_topic: false, handoff: false };
    let leadingHandoff = false;
    const head = s.replace(/^\s+/, '');
    if (/^\[HANDOFF\]/i.test(head)) leadingHandoff = true;
    for (const m of MARKER_RES) {
        m.re.lastIndex = 0;
        if (m.re.test(s)) flags[m.name] = true;
        m.re.lastIndex = 0;
        s = s.replace(m.re, ' ');
    }
    s = s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '').replace(/ +\n/g, '\n').trim();
    return { text: s, ...flags, marked: flags.off_topic || flags.handoff, leadingHandoff };
}

function createMarkerGate(onText) {
    let pending = '';
    let emitted = '';
    let ended = false;
    let swallowNext = ''; // '' | 'all' (whitespace incl. newlines after a leading marker) | 'h' (spaces/tabs after a mid-text marker)
    const flags = { off_topic: false, handoff: false };
    let suppressed = false;

    const emit = (t) => {
        if (!t) return;
        emitted += t;
        if (onText) onText(t);
    };

    /** Remove complete markers (anywhere) and the whitespace that directly followed them. */
    function removeMarkers(s) {
        let out = '';
        let i = 0;
        const lower = s.toLowerCase();
        while (i < s.length) {
            const m = MARKERS.find((mk) => lower.startsWith(mk.text.toLowerCase(), i));
            if (!m) { out += s[i]; i += 1; continue; }
            flags[m.name] = true;
            const atStart = emitted === '' && out.trim() === '';
            if (m.name === 'handoff' && atStart) suppressed = true;
            i += m.text.length;
            const ws = (atStart ? /^\s*/ : /^[ \t]*/).exec(s.slice(i));
            i += ws[0].length;
            if (i >= s.length) swallowNext = atStart ? 'all' : 'h';
        }
        return out;
    }

    function drain(final) {
        let s = pending;
        pending = '';
        if (swallowNext && s) {
            s = s.replace(swallowNext === 'all' ? /^\s+/ : /^[ \t]+/, '');
            if (s) swallowNext = '';
        }
        s = removeMarkers(s);
        if (!final) {
            const hold = pendingSuffixLength(s);
            if (hold) { pending = s.slice(s.length - hold); s = s.slice(0, s.length - hold); }
        }
        if (suppressed) return;
        emit(s);
    }

    return {
        push(chunk) {
            if (ended) return;
            pending += String(chunk || '');
            drain(false);
        },
        end() {
            if (!ended) { ended = true; drain(true); }
            return { marked: flags.off_topic || flags.handoff, off_topic: flags.off_topic, handoff: flags.handoff, suppressed };
        },
        get off_topic() { return flags.off_topic; },
        get handoff() { return flags.handoff; },
        get marked() { return flags.off_topic || flags.handoff; },
        get suppressed() { return suppressed; },
        get text() { return emitted; },
    };
}

module.exports = { MARKERS, createMarkerGate, markerGate: createMarkerGate, stripMarkers, pendingSuffixLength };
