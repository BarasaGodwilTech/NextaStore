'use strict';
/**
 * Tiny in-process BM25 keyword search. No model, no network, no files on disk.
 * The whole knowledge base is a few dozen chunks, so building the index takes a
 * millisecond or two and a search takes microseconds - which is why the assistant
 * can rebuild it on the fly whenever a knowledge file changes (see retrieve.js).
 */

const STOPWORDS = new Set((
    'a an and are as at be but by can could do does for from had has have how i if in into is it its just me my of on or our so ' +
    'than that the their them then there these they this to up us was we were what when where which who why will with would you your ' +
    'about also any get got dont im ive not no yes please tell want need like ' +
    'should shall may might must much many very really some more most other such only too here those been being am'
).split(/\s+/));

/** Very light suffix stripping so "selling/sells/sell", "price/pricing/prices" meet in the middle. */
function stem(word) {
    let w = word;
    if (w.length <= 3) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + 'y';
    else if (/(ss|ch|sh|x|z)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
    else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3) w = w.slice(0, -1);
    if (w.length > 3 && /e$/.test(w)) w = w.slice(0, -1);           // price -> pric, pricing -> pric
    if (w.length > 3 && /([^aeiou])\1$/.test(w) && !/(ss|ll)$/.test(w)) w = w.slice(0, -1); // shipp -> ship
    return w;
}

/** Lowercase words (keeps Luganda ŋ), apostrophes dropped. */
function rawTokens(text) {
    return (String(text || '').toLowerCase().normalize('NFC').replace(/['’`]/g, '').match(/[a-z0-9ŋ]+/g) || []);
}

/** Indexable terms: stopwords out, stems in. */
function terms(text) {
    return rawTokens(text).filter((t) => !STOPWORDS.has(t)).map(stem);
}

class BM25 {
    /**
     * @param {{heading: string, title?: string, text: string}[]} docs
     * The heading counts three times, the file title once, so a section named "Payments" beats a passing mention.
     */
    constructor(docs, { k1 = 1.5, b = 0.75, headingWeight = 3 } = {}) {
        this.k1 = k1;
        this.b = b;
        this.tf = [];          // per doc: Map(term -> weighted count)
        this.len = [];
        this.df = new Map();   // term -> number of docs containing it
        let total = 0;
        for (const d of docs) {
            const m = new Map();
            const add = (list, w) => { for (const t of list) m.set(t, (m.get(t) || 0) + w); };
            add(terms(d.heading), headingWeight);
            add(terms(d.title || ''), 1);
            add(terms(d.text), 1);
            let len = 0;
            for (const c of m.values()) len += c;
            this.tf.push(m);
            this.len.push(len);
            total += len;
            for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
        }
        this.n = docs.length;
        this.avgLen = this.n ? total / this.n : 0;
    }

    idf(term) {
        const n = this.df.get(term) || 0;
        return Math.log(1 + (this.n - n + 0.5) / (n + 0.5));
    }

    /**
     * @param {Map<string, number>} queryTerms term -> weight (1 for the user's own words, lower for expansions)
     * @returns {{index: number, score: number}[]} best first, only docs with score > 0
     */
    search(queryTerms, limit = 10) {
        const out = [];
        for (let i = 0; i < this.n; i++) {
            const tf = this.tf[i];
            const norm = this.k1 * (1 - this.b + this.b * (this.len[i] / (this.avgLen || 1)));
            let score = 0;
            for (const [t, w] of queryTerms) {
                const f = tf.get(t);
                if (!f) continue;
                score += w * this.idf(t) * ((f * (this.k1 + 1)) / (f + norm));
            }
            if (score > 0) out.push({ index: i, score });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, limit);
    }
}

module.exports = { BM25, terms, rawTokens, stem, STOPWORDS };
