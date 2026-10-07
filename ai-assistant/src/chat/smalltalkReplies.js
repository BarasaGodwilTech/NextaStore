'use strict';

/**
 * Curated small-talk replies. These are deliberately factual-light: they never
 * invent platform rules, prices or links. Selection avoids the previous reply
 * in the same conversation.
 */
const REPLIES = {
    en: {
        greet: [
            'Hi! I’m Nexi. What would you like to know about NextaStore?',
            'Hello! I’m here to help with buying, selling, or starting a store.',
            'Hey! Good to see you. What can I help you with on NextaStore?',
            'Hi there! Ask me anything about buying or selling on NextaStore.',
            'Hello! Ready when you are. What would you like help with?',
            'Hey! I’m Nexi, your NextaStore guide. What are you working on?',
            'Hi! Glad you’re here. How can I help with NextaStore?',
            'Hello there! Tell me what you’d like to do and I’ll point you in the right direction.',
        ],
        thanks: [
            'You’re welcome! I’m happy to help.',
            'Anytime! Let me know what you need next.',
            'You’re very welcome. I’m here if you have another question.',
            'Glad I could help!',
            'No problem at all. Ask me anything else you need.',
            'Happy to help! What would you like to explore next?',
            'My pleasure. I’m here whenever you need a hand.',
            'You’re welcome! We can keep going whenever you’re ready.',
        ],
        goodbye: [
            'Take care! I’ll be here when you need me.',
            'Goodbye! Wishing you a great day.',
            'See you later! Good luck with your NextaStore plans.',
            'Take care, and come back whenever you need help.',
            'Bye for now! Have a good one.',
            'See you soon! I’ll be here if another question comes up.',
            'Have a great day! Take care.',
            'Goodbye! All the best with your buying and selling.',
        ],
        identity: [
            'I’m Nexi, NextaStore’s guide for buying, selling, orders, payments, and stores.',
            'I’m Nexi. I help people understand NextaStore and make practical buying and selling decisions.',
            'I’m Nexi, the assistant inside NextaStore. I can help with shopping, selling, and getting started.',
            'I’m Nexi. Think of me as your guide for using NextaStore and growing a store.',
            'I’m Nexi, here to help with NextaStore questions and practical selling or shopping tips.',
            'I’m Nexi. I can guide you through buying, selling, orders, payments, and opening a store.',
            'I’m Nexi, your NextaStore guide. Ask me about shopping, selling, or setting up a store.',
            'I’m Nexi. I’m here to make NextaStore easier to understand and use.',
        ],
    },
    lg: {
        greet: [
            'Gyebale ko! Nze Nexi. Nkuyambe ku ki ku NextaStore?',
            'Oli otya! Nnyamba okukuyamba ku kugula oba okutunda.',
            'Wasuze otya! Buuza ku NextaStore, nange nkuyambe.',
            'Gyebale! Ndi wano okukuyamba ku by’obusuubuzi ku NextaStore.',
            'Oli bulungi? Buuza ekibuuzo kyo ku NextaStore.',
            'Kale! Nze Nexi, era ndi wano okukuyamba.',
            'Gyebale nnyo! Oyagala kuyambibwa ku ki?',
            'Oli otya! Tandika n’ekibuuzo kyo, nkuyambe.',
        ],
        thanks: [
            'Kale, webale! Ndi wano okukuyamba nate.',
            'Webale nnyo. Buuza ekirala bw’oba oyagala.',
            'Tewali buzibu. Nsanyuse okukuyamba.',
            'Kale nnyo! Ndi wano bw’oba olina ekibuuzo ekirala.',
            'Webale! Tugende mu maaso bw’oba oyagala.',
            'Nsanyuse okukuyamba. Buuza nate.',
            'Kale, nkusanyukira. Ndi wano okukuyamba.',
            'Webale nnyo! Oyinza okubuuza ekirala.',
        ],
        goodbye: [
            'Weeraba! Nkwagaliza olunaku olulungi.',
            'Kale, weeraba! Nja kuba wano bw’oba onneetaaga.',
            'Weeraba, weeraba bulungi!',
            'Kale nnyo. Nkwagaliza ebirungi.',
            'Weeraba! Okomawo bw’oba olina ekibuuzo.',
            'Sula bulungi! Nja kuba wano nate.',
            'Kale, tukyalaba nate.',
            'Weeraba! Katonda akuwe omukisa.',
        ],
        identity: [
            'Nze Nexi, omuyambi wa NextaStore ku kugula, okutunda n’okutandika edduuka.',
            'Nze Nexi. Nkuyamba okutegeera NextaStore n’okutunda oba okugula.',
            'Nze Nexi, omuyambi ali mu NextaStore. Nkuyamba ku bintu eby’obusuubuzi.',
            'Nze Nexi. Ndi wano okukuyamba ku kugula, okutunda n’eddduuka lyo.',
            'Nze Nexi, omukulembeze wo ku bibuuzo bya NextaStore.',
            'Nze Nexi. Nkuyamba ku orders, okusasula, okugula n’okutunda.',
            'Nze Nexi, era nsobola okukuyamba okutandika edduuka.',
            'Nze Nexi, omuyambi wo mu NextaStore.',
        ],
    },
    sw: {
        greet: [
            'Habari! Mimi ni Nexi. Nikusaidie nini kuhusu NextaStore?',
            'Hujambo! Niko hapa kusaidia kuhusu kununua au kuuza.',
            'Mambo! Uliza swali lako kuhusu NextaStore.',
            'Habari yako! Niko tayari kukusaidia.',
            'Karibu! Ungependa msaada kuhusu nini?',
            'Habari! Mimi ni Nexi, mwongozo wako wa NextaStore.',
            'Poa! Niambie ungependa kufanya nini kwenye NextaStore.',
            'Hujambo! Tuanzie kwenye swali lako.',
        ],
        thanks: [
            'Karibu! Niko hapa kukusaidia tena.',
            'Asante pia! Uliza chochote kingine unachohitaji.',
            'Hakuna shida. Nimefurahi kusaidia.',
            'Karibu sana! Tunaweza kuendelea.',
            'Sawa! Niko hapa ukihitaji msaada zaidi.',
            'Furaha yangu kukusaidia.',
            'Karibu! Uliza swali lingine ukiwa tayari.',
            'Asante! Niko hapa kwa swali lako linalofuata.',
        ],
        goodbye: [
            'Kwaheri! Uwe na siku njema.',
            'Kwaheri! Rudi wakati wowote ukihitaji msaada.',
            'Tutaonana baadaye. Kila la heri!',
            'Kwaheri, jitunze!',
            'Uwe na siku nzuri. Tutaonana tena.',
            'Kwaheri! Niko hapa utakaporudi.',
            'Sawa, kwaheri na kila la heri.',
            'Tutaonana tena! Jitunze.',
        ],
        identity: [
            'Mimi ni Nexi, mwongozo wa NextaStore kwa kununua, kuuza na kuanzisha duka.',
            'Mimi ni Nexi. Nasaidia kuelewa NextaStore na biashara yake.',
            'Mimi ni Nexi, msaidizi wa NextaStore kwa wanunuzi na wauzaji.',
            'Mimi ni Nexi. Naweza kusaidia kuhusu manunuzi, mauzo na duka.',
            'Mimi ni Nexi, mwongozo wako wa NextaStore.',
            'Mimi ni Nexi. Niko hapa kusaidia kuhusu oda, malipo na maduka.',
            'Mimi ni Nexi, msaidizi wa kununua na kuuza kwenye NextaStore.',
            'Mimi ni Nexi. Uliza kuhusu NextaStore na nitakuelekeza.',
        ],
    },
};

function classify(text, normalise) {
    const s = normalise(text);
    if (/\b(bye|goodbye|see you|later|take care|cheers|kwaheri|sula|weeraba|tuliba|tuddemu)\b/i.test(s)) return 'goodbye';
    if (/\b(thanks|thank|thankyou|thx|ty|appreciate|webale|weebale|gyebale|asante)\b/i.test(s)) return 'thanks';
    if (/\b(who am i talking to|who are you|what can you do|your name|nze|gwe ani|wewe ni nani)\b/i.test(s)) return 'identity';
    return 'greet';
}

function pick({ lang = 'en', message, history = [], normalise, random = Math.random }) {
    const code = REPLIES[lang] ? lang : 'en';
    const type = classify(message, normalise);
    const pool = REPLIES[code][type];
    const used = new Set(history.filter((m) => m && m.role === 'assistant').map((m) => String(m.content || '').trim()));
    const choices = pool.filter((r) => !used.has(r));
    const source = choices.length ? choices : pool;
    return source[Math.floor(random() * source.length)];
}

module.exports = { REPLIES, classify, pick };
