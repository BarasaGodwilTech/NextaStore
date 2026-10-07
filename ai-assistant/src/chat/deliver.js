'use strict';
/**
 * WIP 64: how ONE answer reaches the visitor.
 *
 * The pipeline hands everything it says to a delivery object instead of calling onToken directly:
 *   instant(textOrBubbles, source)  ready-made answers (FAQ, small talk, phrasebook, flag, cache, fallback):
 *                                   split into bubbles, wait a beat, type them out with pauses between bubbles.
 *   live()                          live model text: returns push(chunk); a blank line / sentence boundary
 *                                   becomes a new bubble and text is passed on as it arrives.
 *   bubbles()                       the bubbles that were actually sent (goes into `done.bubbles`).
 *   reset()                         throw away what was already sent (a model failed half-way and a fallback
 *                                   answer follows) so the browser clears its partial bubbles.
 *   drain()                         resolves when everything queued has been sent.
 *
 * Hooks: onToken(text), onBreak(), onTyping(), onCards(payload), onReset(), signal.
 * Without onToken (non-streaming callers) nothing is paced or sent: instant() just returns the bubbles.
 */
const { splitReply, createBubbleGate } = require('./bubbles');
const { createPacer } = require('./pacer');

function createDelivery(hooks = {}) {
    const streaming = typeof hooks.onToken === 'function';
    let parts = [];

    const pacer = streaming
        ? createPacer((ev) => {
            if (ev.type === 'token') hooks.onToken(ev.text);
            else if (ev.type === 'break') { if (hooks.onBreak) hooks.onBreak(); }
            else if (ev.type === 'typing') { if (hooks.onTyping) hooks.onTyping(); }
            else if (ev.type === 'cards') {
                if (hooks.onCards) { const { type, ...payload } = ev; hooks.onCards(payload); }
            }
        }, { signal: hooks.signal, ...(hooks.pace || {}) })
        : null;

    function clean(list) { return list.map((s) => String(s).trim()).filter(Boolean); }

    return {
        async instant(content, source) {
            const bubbles = clean(Array.isArray(content) ? content : splitReply(content));
            parts = bubbles.slice();
            if (!pacer || !bubbles.length) return bubbles;
            pacer.setSource(source);
            bubbles.forEach((b, i) => { if (i) pacer.brk(); pacer.token(b); });
            await pacer.drain();
            return bubbles;
        },

        cards(payload) {
            if (pacer) pacer.cards(payload);
        },

        live() {
            parts = [''];
            const gate = createBubbleGate(
                (t) => { parts[parts.length - 1] += t; if (pacer) pacer.token(t); },
                () => { parts.push(''); if (pacer) pacer.brk(); },
            );
            return gate.push;
        },

        bubbles() { return clean(parts); },

        /** True when live text has already reached the visitor. */
        delivered() { return parts.some((p) => p.trim()); },

        reset() {
            const hadDelivered = this.delivered();
            parts = [];
            if (pacer) pacer.reset();
            if (hadDelivered && hooks.onReset) hooks.onReset();
        },

        drain() { return pacer ? pacer.drain() : Promise.resolve(); },
    };
}

module.exports = { createDelivery };
