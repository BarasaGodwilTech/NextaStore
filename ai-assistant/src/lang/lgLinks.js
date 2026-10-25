'use strict';
/**
 * WIP 92c: link labels on Luganda turns.
 * postProcessReply and the translator restore links such as [Open a store](/signup); the label is English.
 * On a Luganda turn every label is replaced from this table (by path), or by a neutral label for paths
 * without a reviewed draft. English turns never touch this module.
 *
 * ALL labels below are DRAFTS for a fluent Luganda speaker to review (see OPEN_ITEMS.md). They are short,
 * imperative, single words/phrases on purpose, so a wrong guess is cheap to fix.
 */
const NEUTRAL_LABEL = 'Genda wano'; // DRAFT: "Go here"
const LG_LINK_LABELS = {
    '/signup': 'Tandika edduuka',   // DRAFT: "Start a shop"
    '/login': 'Yingira',            // DRAFT: "Log in / enter"
    '/marketplace': 'Akatale',      // DRAFT: "Marketplace"
    '/stores': 'Amaduuka',          // DRAFT: "Shops"
    '/subscription': 'Seller Pass', // brand term, kept as is
    '/orders': 'Oda',               // DRAFT: from the pinned glossary (order = oda)
    '/messages': 'Obubaka',         // DRAFT: "Messages"
    '/safety': 'Obukuumi',          // DRAFT: "Safety"
    '/terms': 'Amateeka',           // DRAFT: "Rules / terms"
};
const LINK_RE = /(!?)\[([^\]\n]{1,120})\]\((\/[A-Za-z0-9\-_/]*)(\?[^)\s]*)?\)/g;

function labelFor(path) {
    const key = '/' + String(path || '').split('/').filter(Boolean)[0];
    return LG_LINK_LABELS[key] || NEUTRAL_LABEL;
}

/** Replace the label of every in-site markdown link. Images and external links are left alone. */
function localizeLinkLabels(text) {
    return String(text || '').replace(LINK_RE, (m, bang, label, p, q) => (bang ? m : `[${labelFor(p)}](${p}${q || ''})`));
}

module.exports = { LG_LINK_LABELS, NEUTRAL_LABEL, labelFor, localizeLinkLabels };
