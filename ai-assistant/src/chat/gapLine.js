'use strict';
/**
 * WIP 99: the one sentence that says "this is not in the guides".
 *
 * A gap topic is printed ("I'm not sure about delivery fees and delivery times: ...") ONLY when it is a curated phrase the maintainers wrote
 * in query-normalisation.json ("gaps" and "fact_kinds"): those read well. Any other gap topic is a raw word the evidence check picked out of the
 * question ("loyalty", "language", "rider", "guns"): printed after "about" it reads like a typo, so the sentence has no dangling topic.
 */
const { loadData } = require('../rag/normalise');

const NATURAL = "I don't have that in the NextaStore guides, and I don't want to guess.";

function curatedTopics() {
    const d = loadData();
    return new Set([...(d.gaps || []).map((g) => g.topic), ...(d.factKinds || []).map((k) => k.topic)].map((t) => String(t).toLowerCase()));
}

/** True when `gap` is one of the curated topic phrases (and so reads well after "about"). */
function isCuratedGap(gap) { return Boolean(gap) && curatedTopics().has(String(gap).toLowerCase()); }

/** The "not in the guides" sentence for a gap topic (or none). Never prints a raw rare word. */
function gapSentence(gap) {
    return isCuratedGap(gap) ? `I'm not sure about ${gap}: it isn't in the NextaStore guides and I don't want to guess.` : NATURAL;
}

/** Does a reply say plainly that the guides do not have it (the sentence above, either wording, or the old "I'm not sure about ..." form)? */
const NOT_IN_GUIDES_RE = /(?:isn't|is not|not) in the NextaStore guides|don't have (?:it|that) in the NextaStore guides/i;
function isNotInGuidesReply(reply) { return NOT_IN_GUIDES_RE.test(String(reply || '')); }

module.exports = { isNotInGuidesReply, NOT_IN_GUIDES_RE, NATURAL, isCuratedGap, gapSentence, curatedTopics };
