/**
 * Deliberately simple, dependency-free language detection.
 *
 * WIP 53 fix: markers are now matched against whole WORDS (tokens), not as
 * substrings. Before, short markers like "ki" and "nga" matched inside
 * ordinary English words ("marketing", "looking", "changing"), so English
 * questions could be answered as if they were Luganda. Words that are also
 * ordinary English ("kale", "muzungu") were removed for the same reason.
 */

const LUGANDA_WORDS = [
    'gyebale', 'webale', 'nkwagala', 'nsonyiwa', 'nedda', 'nkusaba', 'nkwegayirira',
    'ssente', 'nnyabo', 'ssebo', 'katonda', 'mukama', 'oyagala', 'nnina', 'sirina',
    'mpozzi', 'weewaawo', 'ekibiina', 'omuntu', 'okugula', 'okutunda', 'sente',
    'akatale', 'nkozesa', 'nnyinza', 'ntya', 'edduuka', 'amaduuka', 'sitowa',
    'okutandika', 'nkyatandika', 'ntunde', 'bbeeyi', 'bakasitoma', 'obusuubuzi',
    'ensimbi', 'ebirowoozo', 'ebintu', 'mpa', 'mbuulira', 'nsobola', 'osobola',
    'tonnasasula', 'okusasula', 'omutunzi', 'abatunzi', 'ekiragiro', 'ebiragiro',
];
const LUGANDA_PHRASES = ['oli otya', 'wasuze otya', 'osiibye otya', 'ki kati'];

const SWAHILI_WORDS = [
    'habari', 'asante', 'karibu', 'ndiyo', 'hapana', 'pesa', 'duka',
    'nataka', 'ninahitaji', 'samahani', 'tafadhali', 'jambo',
];

const ENGLISH_STOPWORDS = new Set([
    'the', 'is', 'are', 'how', 'what', 'my', 'i', 'to', 'do', 'can', 'and', 'for',
    'of', 'in', 'on', 'with', 'a', 'an', 'should', 'where', 'why', 'me', 'you',
]);

function tokens(text) {
    return (String(text || '').toLowerCase().match(/[a-zŋ']+/g) || []);
}

function countHits(toks, joined, words, phrases = []) {
    const set = new Set(words);
    let n = toks.reduce((acc, t) => (set.has(t) ? acc + 1 : acc), 0);
    for (const p of phrases) if (joined.includes(` ${p} `)) n += 1;
    return n;
}

/** True when the text reads as English (>= 2 common English function words). */
function looksEnglish(text) {
    const toks = tokens(text);
    return toks.filter((t) => ENGLISH_STOPWORDS.has(t)).length >= 2;
}

/**
 * @returns {{ code: 'lg'|'sw'|'en', label: string, confidence: 'low'|'medium' }}
 */
function detectLanguage(text) {
    const toks = tokens(text);
    const joined = ` ${toks.join(' ')} `;
    const lg = countHits(toks, joined, LUGANDA_WORDS, LUGANDA_PHRASES);
    const sw = countHits(toks, joined, SWAHILI_WORDS);
    if (lg > 0 && lg >= sw) return { code: 'lg', label: 'Luganda', confidence: lg >= 2 ? 'medium' : 'low' };
    if (sw > 0) return { code: 'sw', label: 'Swahili', confidence: sw >= 2 ? 'medium' : 'low' };
    return { code: 'en', label: 'English', confidence: 'low' };
}

module.exports = { detectLanguage, looksEnglish, LUGANDA_WORDS, SWAHILI_WORDS };
