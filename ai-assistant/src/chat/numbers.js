'use strict';
/** WIP 97: one canonical form for figures, so "3-day", "three days", "UGX 50,000" and "50000 shillings" compare equal. */
const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100, once: 1, twice: 2, half: 0.5 };

// WIP 98: numbers written in words compare equal to digits: "twenty-four" = 24, "twenty thousand" = 20,000, "three million" = 3,000,000.
const ONES = 'one|two|three|four|five|six|seven|eight|nine';
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const ANY_WORD = `zero|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|${TENS}|${ONES}`;
const SCALED_RE = new RegExp(`\\b((?:${TENS})(?:[- ](?:${ONES}))?|${ANY_WORD})\\s+(thousand|million)\\b`, 'g');
const COMPOUND_RE = new RegExp(`\\b(${TENS})[- ](${ONES})\\b`, 'g');
/** "twenty thousand" -> "20000", "twenty-four" -> "24" (so the digit scanners below see them). Other words are left alone. */
function spellOutNumbers(text) {
    return String(text || '')
        .replace(SCALED_RE, (m, w, scale) => { const [a, b] = w.split(/[- ]/); const n = (WORDS[a] || 0) + (b ? WORDS[b] || 0 : 0); return ` ${n * (scale === 'million' ? 1e6 : 1e3)} `; })
        .replace(COMPOUND_RE, (m, a, b) => ` ${WORDS[a] + WORDS[b]} `);
}

/** Set of canonical numbers (as strings) mentioned in the text. */
function numbersIn(text) {
    const t = spellOutNumbers(String(text || '').toLowerCase()).replace(/\bugx\b|\bshs?\b|\bshillings?\b/g, ' ');
    const out = new Set();
    for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?\b/g)) {
        let n = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(n)) continue;
        if (m[2] === 'k' || m[2] === 'thousand') n *= 1000; else if (m[2] === 'm' || m[2] === 'million') n *= 1e6;
        out.add(String(n));
    }
    for (const m of t.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|twice|half)\b/g)) out.add(String(WORDS[m[1]]));
    return out;
}

/** True when every figure in `reply` also appears (in any spelling) in `context`. Figures like "1"/"one" used as plain words are ignored. */
function numbersSupported(reply, context) {
    const allowed = numbersIn(context); const small = new Set(['0', '1']);
    for (const n of numbersIn(reply)) if (!allowed.has(n) && !small.has(n)) return false;
    return true;
}

module.exports = { numbersIn, numbersSupported, spellOutNumbers };
