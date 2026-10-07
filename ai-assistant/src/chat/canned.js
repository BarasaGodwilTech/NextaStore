/**
 * Curated replies for flagged messages (WIP 55). These never touch the model, so they are
 * instant, free and always say the same safe thing.
 *
 * LUGANDA NOTE: the Luganda lines below were written by hand in simple wording and have NOT been
 * reviewed by a native speaker. Please have one check them (and fix anything that reads oddly)
 * before relying on them; the English lines are the source of truth.
 */
const REPLIES = {
    off_topic: {
        en: 'I can only help with NextaStore: buying, selling, orders, payments and starting a business. I can\'t help with that one, but here are things I can do:',
        lg: 'Nsonyiwa, nsobola kuyamba ku bya NextaStore byokka: okugula, okutunda, okusasula n\'okutandika obusuubuzi. Gezaako okubuuza ku ebyo:',
    },
    inappropriate: {
        en: 'Let\'s keep things respectful. I\'m happy to help with buying or selling on NextaStore whenever you\'re ready.',
        lg: 'Tuwaŋŋane ekitiibwa. Nsanyuka okukuyamba ku kugula oba okutunda ku NextaStore.',
    },
    sensitive: {
        en: 'Please don\'t share passwords, OTP codes, PINs or card numbers here. Nexi never needs them. Only type them on the official NextaStore or mobile money page, and delete this message if you can.',
        lg: 'Tosaana kuwa pasiwaadi, koodi ya OTP, PIN oba nnamba ya kaadi wano. Nexi tabyetaaga. Zikozese ku lupapula lwa NextaStore oba lwa mobile money olwa nnamaddala lwokka.',
    },
    manipulation: {
        en: 'I can\'t change how I work, but I\'m glad to help with NextaStore questions: buying, selling, payments and getting started.',
        lg: 'Siyinza kukyusa nkola yange, naye nsobola okukuyamba ku bibuuzo bya NextaStore.',
    },
    unclear: {
        en: 'I couldn\'t understand that. Could you ask your question in a few words, in English or Luganda?',
        lg: 'Sitegedde. Buuza ekibuuzo kyo mu bigambo ebitonotono, mu Luganda oba mu Lungereza.',
    },
};
const DRIFT = {
    en: 'This chat has moved away from NextaStore. I can only help with buying, selling and running a store here. Start a new chat whenever you have a NextaStore question.',
    lg: 'Emboozi eno etuuse wala okuva ku NextaStore. Tandika emboozi empya bw\'oba olina ekibuuzo ku NextaStore.',
};

function cannedReply(type, { conversation = false, lang = 'en' } = {}) {
    const code = lang === 'lg' ? 'lg' : 'en';
    if (conversation) return DRIFT[code];
    return (REPLIES[type] || REPLIES.off_topic)[code];
}

module.exports = { cannedReply, REPLIES, DRIFT };
