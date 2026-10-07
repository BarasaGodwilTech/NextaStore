/**
 * Small talk detection (WIP 61).
 *
 * "hi", "good morning", "thanks", "who are you", "how are you", "bye" are NOT answered from a
 * canned list: the model writes them, so each one sounds like a real reply to this person. What this
 * file decides is only WHICH PROMPT the model gets: a short one with no knowledge text, a short reply
 * limit and a bit more variety. That is faster (less for a small CPU model to read) and warmer.
 *
 * It is deliberately strict. A message is small talk only when every word is social filler. Anything
 * with a real question in it ("hi, how do I open a store?") goes the normal way.
 */
const WORDS = new Set([
    // English
    'hi', 'hello', 'hey', 'heya', 'hiya', 'yo', 'howdy', 'good', 'morning', 'afternoon', 'evening', 'night', 'day',
    'how', 'are', 'you', 'doing', 'is', 'it', 'going', 'whats', "what's", 'up', 'sup', 'nexi', 'there', 'again',
    'thanks', 'thank', 'thankyou', 'thx', 'ty', 'much', 'very', 'so', 'a', 'lot', 'many', 'appreciate', 'that',
    'ok', 'okay', 'cool', 'great', 'nice', 'awesome', 'fine', 'well', 'alright', 'sure', 'yes', 'yeah', 'yep', 'no', 'nope',
    'bye', 'goodbye', 'see', 'later', 'take', 'care', 'cheers', 'welcome', 'please', 'sorry', 'pardon',
    'who', 'am', 'i', 'talking', 'to', 'your', 'name', 'what', 'can', 'do', 'help', 'me', 'my', 'friend', 'dear', 'sir', 'madam', 'boss',
    // Luganda
    'oli', 'otya', 'wasuze', 'osiibye', 'ssebo', 'nnyabo', 'nyabo', 'gyebale', 'ko', 'webale', 'nyo', 'nnyo', 'kale', 'bambi', 'mbadde',
    'nze', 'gwe', 'ani', 'oyo', 'ggwe', 'bulungi', 'wangi', 'weebale', 'sula', 'bulungi', 'tuliba', 'tuddemu', 'olaba', 'nkwagala',
    // Swahili
    'habari', 'yako', 'mambo', 'hujambo', 'hamjambo', 'salama', 'poa', 'sawa', 'asante', 'sana', 'karibu', 'kwaheri', 'shikamoo', 'vipi', 'nzuri', 'pole',
]);
// Words that show the person wants a platform answer, so the message must NOT be treated as small talk.
const TASK_WORDS = /\b(store|shop|sell|selling|seller|buy|buying|order|orders|pay|payment|price|fee|fees|subscription|pass|trial|product|products|cart|account|login|password|signup|sign up|deliver|delivery|refund|cancel|message|messages|safety|scam|money|mobile|momo|airtel|mtn)\b/i;

function normalise(text) {
    return String(text || '').toLowerCase().replace(/[!?.,;:()"“”…~*_]+/g, ' ').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isSmallTalk(message) {
    const raw = String(message || '');
    if (!raw.trim() || raw.length > 60) return false;
    const text = normalise(raw);
    if (!text) return true; // only an emoji or punctuation: a friendly reply is still right
    if (TASK_WORDS.test(text)) return false;
    const words = text.split(' ');
    if (words.length > 7) return false;
    return words.every((w) => WORDS.has(w));
}

module.exports = { isSmallTalk, normalise };
