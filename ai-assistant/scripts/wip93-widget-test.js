#!/usr/bin/env node
/**
 * WIP 93 Tier 2.5: the REAL js/assistant.js running in a VM with a small fake DOM (no browser, no jsdom).
 * Covers the human-handoff UI: anchor attributes, href set once the contact loads, summary question, disabled contact, redaction, a11y.
 * Not covered here (needs a real browser): layout, focus rings, the actual WhatsApp app opening.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } }
const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const widgetPath = path.resolve(__dirname, '../../js/assistant.js');
const rawSrc = fs.readFileSync(widgetPath, 'utf8');

class FakeNode {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.parentNode = null; this._text = ''; this.classSet = new Set(); this.listeners = {}; this.hidden = false; this.style = {}; this.dataset = {}; }
    get className() { return [...this.classSet].join(' '); }
    set className(v) { this.classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    get classList() { const s = this.classSet; return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c), toggle: (c, f) => { if (f === undefined ? !s.has(c) : f) s.add(c); else s.delete(c); } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    get href() { return this.attrs.href || ''; } set href(v) { this.attrs.href = String(v); }
    get target() { return this.attrs.target || ''; } set target(v) { this.attrs.target = String(v); }
    get rel() { return this.attrs.rel || ''; } set rel(v) { this.attrs.rel = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
    set innerHTML(v) { this._text = String(v || '').replace(/<[^>]*>/g, ''); this.children = []; }
    get innerHTML() { return this._text; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener() {}
    focus() {}
    closest() { return null; }
    contains(n) { return n === this || this.children.some((c) => c.contains && c.contains(n)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const cls = /^\.([\w-]+)$/.exec(sel); const attr = /^\[([\w-]+)\]$/.exec(sel); const out = [];
        const walk = (n) => { for (const c of n.children) { if (attr ? (c.hasAttribute && c.hasAttribute(attr[1])) : cls ? c.classSet && c.classSet.has(cls[1]) : (c.tagName === String(sel).toUpperCase())) out.push(c); walk(c); } };
        walk(this); return out;
    }
}

/** Load the real widget into a fresh VM. `net` = { contact: object|'fail', facts: object|'fail' }. */
function loadWidget(net) {
    const src = rawSrc.replace(/\}\)\(\);\s*$/, 'window.__w93={jsonParse:function(x){return JSON.parse(x);},doc:document,T:T,t:t,chrome:chrome,applyChrome:applyChrome,emit:emit,buildLang:buildLang,buildHandoffRow:buildHandoffRow,lastUserText:lastUserText,renderCards:renderCards,el:el,bubbleNode:bubbleNode,buildExtras:buildExtras,prepareHandoffAnchor:prepareHandoffAnchor,previousUserQuestion:previousUserQuestion,handoffSummary:handoffSummary,scrubHandoffText:scrubHandoffText,buildHandoffHref:buildHandoffHref,state:state};\n})();');
    if (src === rawSrc) throw new Error('could not expose widget helpers');
    const doc = {
        readyState: 'loading', addEventListener() {}, removeEventListener() {}, body: new FakeNode('body'), documentElement: new FakeNode('html'),
        createElement: (t) => new FakeNode(t), createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n; }, createDocumentFragment: () => new FakeNode('#frag'),
        querySelector: () => null, querySelectorAll: (sel) => doc.body.querySelectorAll(sel), getElementById: () => null,
    };
    const store = () => ({ getItem() { return null; }, setItem() {}, removeItem() {} });
    const calls = [];
    const fetchStub = (url) => {
        calls.push(String(url));
        const answer = (v) => (v === 'fail' ? Promise.reject(new Error('network')) : Promise.resolve({ ok: true, json: () => Promise.resolve(v) }));
        if (/\/handoff-contact/.test(url)) return answer(net.contact);
        if (/\/facts/.test(url)) return answer(net.facts === undefined ? {} : net.facts);
        return Promise.reject(new Error('unexpected ' + url));
    };
    const window = { NexiAssistant: null, location: { pathname: '/marketplace', search: '' }, addEventListener() {}, sessionStorage: store(), localStorage: store(), document: doc };
    const sandbox = { window, document: doc, navigator: {}, location: { pathname: '/marketplace', search: '', hostname: 'localhost', origin: 'http://localhost' }, matchMedia: () => ({ matches: false, addEventListener() {} }), sessionStorage: window.sessionStorage, localStorage: window.localStorage, console, URL, URLSearchParams, fetch: fetchStub, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, requestAnimationFrame: (f) => setTimeout(f, 0), AbortController, Promise };
    vm.runInNewContext(src, sandbox, { filename: 'js/assistant.js' });
    return { w: window.__w93, calls };
}
const find = (node, pred, out = []) => { for (const c of node.children) { if (pred(c)) out.push(c); find(c, pred, out); } return out; };
const hasClass = (c, k) => c.classSet && c.classSet.has(k);
const WA = { enabled: true, whatsappDigits: '256761789006' };

(async () => {
    console.log('Handoff bubble: anchor, href once the contact loads, preceding user question');
    {
        const { w } = loadWidget({ contact: WA });
        w.state.lang = 'en';
        const q1 = { role: 'user', text: 'How do I price my products?' };
        const bot1 = { role: 'bot', text: 'I need to connect you with a human team member.', parts: ['I need to connect you with a human team member.'], handoff: { reason: 'not_in_context' } };
        const q2 = { role: 'user', text: 'And what about my second question, order 123456?' };
        const bot2 = { role: 'bot', text: 'Sure.', parts: ['Sure.'] };
        w.state.messages = [q1, bot1, q2, bot2];
        const row = { children: w.buildExtras(bot1) };   // WIP 101: the handoff button is a thread-level extra, not part of the bubble row
        const anchors = find(row, (n) => n.tagName === 'A' && hasClass(n, 'nexi-handoff'));
        check('handoff message renders exactly one <a class="nexi-handoff">', anchors.length === 1);
        const a = anchors[0];
        check('anchor is a link that opens in a new tab safely (target=_blank, rel=noopener)', a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener');
        check('before the contact loads there is no href and the anchor is aria-disabled; the explanation stays hidden until a tap', a.getAttribute('href') === null && a.getAttribute('aria-disabled') === 'true' && find(row, (n) => hasClass(n, 'nexi-handoff-notice')).every((n) => n.hidden === true));
        await tick();
        check('once the contact loads: href is a wa.me link for the configured number, aria-disabled removed', /^https:\/\/wa\.me\/256761789006\?text=/.test(a.getAttribute('href') || '') && a.getAttribute('aria-disabled') === null && a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener', JSON.stringify(a.attrs));
        const text = decodeURIComponent((a.getAttribute('href') || '').split('?text=')[1] || '');
        const lastLine = text.split('\n').pop();
        check('summary question is the USER question that PRECEDED the handoff, not a later one', /Question Nexi could not answer: How do I price my products\?$/.test(lastLine) && !/second question/.test(lastLine), lastLine);
        check('summary keeps the order reference of the recent questions and stays within 600 characters', /order 123456/.test(text) && text.length <= 600);
        check('previousUserQuestion finds the nearest earlier user message', w.previousUserQuestion(bot1) === 'How do I price my products?' && w.previousUserQuestion(bot2) === q2.text);
    }

    console.log('Disabled / unreachable contact: nothing shown until a tap; then a visible message and an email (or support page) link, no silent redirect');
    for (const [label, net, expectHref] of [
        ['contact disabled, support e-mail known', { contact: { enabled: false }, facts: { support: { email: 'support@nextawillstechnologies.com' } } }, 'mailto:support@nextawillstechnologies.com'],
        ['contact disabled, support URL known', { contact: { enabled: false }, facts: { data: { support: { url: 'https://nextawillstechnologies.com' } } } }, 'https://nextawillstechnologies.com'],
        ['contact request fails, facts unavailable (built-in support page)', { contact: 'fail', facts: 'fail' }, 'https://nextawillstechnologies.com'],
        ['WhatsApp number malformed', { contact: { enabled: true, whatsappDigits: '12345' }, facts: {} }, 'https://nextawillstechnologies.com'],
    ]) {
        const { w } = loadWidget(net); w.state.lang = 'en';
        const bot = { role: 'bot', text: 'x', parts: ['x'], handoff: { reason: 'language_guard' } };
        w.state.messages = [{ role: 'user', text: 'help me' }, bot];
        const row = { children: w.buildExtras(bot) };   // WIP 101: the handoff button is a thread-level extra, not part of the bubble row
        const a = find(row, (n) => n.tagName === 'A' && hasClass(n, 'nexi-handoff'))[0];
        const notice = find(row, (n) => hasClass(n, 'nexi-handoff-notice'))[0];
        await tick(20);
        check(`${label}: before any tap the button has no href and the notice is hidden (no permanent warning)`, a.hidden !== true && a.getAttribute('href') === null && notice.hidden === true && notice.textContent === '', JSON.stringify({ hidden: a.hidden, notice: notice.textContent }));
        const click = { prevented: false, preventDefault() { this.prevented = true; } };
        a.listeners.click[0](click); await tick(20);
        const link = find(notice, (n) => n.tagName === 'A')[0];
        check(`${label}: a tap shows "WhatsApp is unavailable" + the support link and does not navigate`, click.prevented === true && notice.hidden === false && /unavailable/i.test(notice.textContent) && link && link.getAttribute('href') === expectHref && link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noopener', JSON.stringify({ prevented: click.prevented, notice: notice.textContent, link: link && link.attrs }));
    }

    console.log('Redaction in the handoff summary');
    {
        const { w } = loadWidget({ contact: WA }); w.state.lang = 'en';
        const keep = ['Price UGX 45,000 order 123456', 'order #987654321 is late', 'reference 7654321 not found', 'ref: 5551234', 'I paid UGX 1,200,000 for 3 items', 'order number 20261012345'];
        for (const k of keep) { const out = w.scrubHandoffText(k); check(`kept: ${k}`, out === k.replace(/\s+/g, ' ').trim(), out); }
        const gone = [['my OTP: 482913', /482913/], ['password hunter2', /hunter2/], ['pin 4821', /4821/], ['card 4111 1111 1111 1111', /4111/], ['mail me at john.doe@example.com', /john\.doe@example\.com/], ['call +256 761 234 567', /761 234 567/]];
        // WIP 93: the keyword is often followed by "is" ("my otp is 482913"); the old rule swallowed "is" and LEFT the number in the summary.
        gone.push(['my otp is 482913', /482913/], ['my password is hunter2', /hunter2/], ['pin is 4821', /4821/], ['the verification code is 556677', /556677/], ['password was Summer2026', /Summer2026/]);
        for (const [input, secret] of gone) { const out = w.scrubHandoffText(input); check(`redacted: ${input}`, !secret.test(out) && /redacted/.test(out), out); }
        w.state.messages = [{ role: 'user', text: 'My OTP: 482913 and order 123456, price UGX 45,000' }];
        const summary = w.handoffSummary('My OTP: 482913 and order 123456, price UGX 45,000');
        check('summary: secrets redacted, order reference and price survive in both the recent-questions line and the question line', !/482913/.test(summary) && (summary.match(/order 123456/g) || []).length === 2 && (summary.match(/UGX 45,000/g) || []).length === 2, summary);
    }

    console.log('Parity: the server-side scrub (chat/scrub.js) gives the same output as the widget for the same input');
    {
        const { w } = loadWidget({ contact: WA });
        const { scrubSensitive } = require('../src/chat/scrub');
        const corpus = ['', 'hello', 'Price UGX 45,000 order 123456', 'order #987654321 is late', 'reference 7654321', 'ref: 5551234', 'my OTP: 482913', 'my otp is 482913', 'password hunter2', 'pin is 4821', 'card 4111 1111 1111 1111', 'mail me at john.doe@example.com', 'call +256 761 234 567', 'call 0761234567 now', 'order 0761234567', 'verification code is 556677 and security code 123', 'I forgot my password', 'my pin', '  lots   of   space  '];
        let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const alphabet = ['password', 'otp', 'pin', 'is', 'was', 'order', 'ref', '#', ':', '=', '+256', '0761', '234', '567', '4111', '1111', 'UGX', '45,000', 'a@b.co', ' ', ' ', 'x', ',', '.'];
        for (let i = 0; i < 3000; i++) { let t = ''; const n = 1 + Math.floor(rnd() * 9); for (let k = 0; k < n; k++) t += alphabet[Math.floor(rnd() * alphabet.length)] + (rnd() < 0.7 ? ' ' : ''); corpus.push(t); }
        const diffs = corpus.filter((t) => w.scrubHandoffText(t) !== scrubSensitive(t));
        check(`widget scrubHandoffText and server scrubSensitive agree on ${corpus.length} inputs (fixed cases + 3000 random)`, diffs.length === 0, JSON.stringify(diffs.slice(0, 3)));
    }

    console.log('"Need a person? Chat on WhatsApp" (composer footer link, WIP 101: it left the header): keyboard reachable, named, href rebuilt from the CURRENT chat');
    for (const lang of ['en', 'lg']) {
        const { w } = loadWidget({ contact: WA }); w.state.lang = lang; w.state.messages = [];
        const { row, link, note } = w.buildHandoffRow(w.lastUserText); w.doc.body.appendChild(row);
        const L = w.T[lang];
        check(`(${lang}) while loading: aria-label equals the visible text, tabindex 0, aria-disabled, no href, explanation hidden`, link.textContent === L.need_person && link.getAttribute('aria-label') === L.need_person && link.getAttribute('tabindex') === '0' && link.getAttribute('aria-disabled') === 'true' && link.getAttribute('href') === null && note.hidden === true, JSON.stringify(link.attrs));
        await tick();
        const read = () => decodeURIComponent((link.getAttribute('href') || '').split('?text=')[1] || '');
        check(`(${lang}) once the contact loads: a real wa.me link, not disabled, no role override`, /^https:\/\/wa\.me\/256761789006\?text=/.test(link.getAttribute('href')) && link.getAttribute('aria-disabled') === null && link.getAttribute('role') === null && link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noopener');
        const idle = read();
        check(`(${lang}) with no chat yet the summary has no empty "recent questions" / "could not answer" lines`, !/My recent questions|Question Nexi could not answer|Ebibuuzo byange|Ekibuuzo Nexi/.test(idle) && idle.split('\n').every((l) => !/:\s*$/.test(l)), idle);
        check(`(${lang}) the summary language line follows the language`, lang === 'lg' ? /Olulimi: Luganda/.test(idle) : /Language: English/.test(idle));
        // messages arrive: only a repaint (emit), pointerdown, focus or click may refresh the href - never a remount
        w.state.messages = [{ id: 1, v: 0, role: 'user', text: 'Where is my order 123456?' }];
        w.emit('change');
        const afterRepaint = read();
        check(`(${lang}) after messages arrive the href is rebuilt on repaint`, /Where is my order 123456\?/.test(afterRepaint) && /(My recent questions|Ebibuuzo byange): Where is my order/.test(afterRepaint) && /(Question Nexi could not answer|Ekibuuzo Nexi ky’etannyanukula): Where is my order/.test(afterRepaint), afterRepaint);
        for (const ev of ['pointerdown', 'focus', 'click']) {
            w.state.messages = [{ id: 1, v: 0, role: 'user', text: 'first question' }, { id: 2, v: 0, role: 'user', text: 'second question ' + ev }];
            link.listeners[ev][0]({ preventDefault() {} });
            check(`(${lang}) ${ev} rebuilds the href from the current conversation`, new RegExp('second question ' + ev).test(read()));
        }
        // the explanation appears only after the tap, in the current language
        check(`(${lang}) after a tap on a working link the explanation is shown in ${lang}`, note.hidden === false && note.textContent === L.talk_explain, note.textContent);
        const click = { prevented: false, preventDefault() { this.prevented = true; } };
        link.listeners.click[0](click);
        check(`(${lang}) activating a working link does not cancel the navigation`, click.prevented === false);
        // keyboard: Enter on a link without an href must still act
    }
    {
        const { w } = loadWidget({ contact: { enabled: false }, facts: { support: { email: 'support@nextawillstechnologies.com' } } }); w.state.lang = 'en';
        const { row, link, note } = w.buildHandoffRow(w.lastUserText); w.doc.body.appendChild(row);
        await tick(20);
        check('contact disabled: the link stays visible and focusable (role=button), nothing is shown until it is used', link.hidden !== true && link.getAttribute('tabindex') === '0' && link.getAttribute('role') === 'button' && link.getAttribute('href') === null && note.hidden === true);
        const ev = { key: 'Enter', prevented: false, preventDefault() { this.prevented = true; } };
        link.listeners.keydown[0](ev); await tick(20);
        check('contact disabled: Enter on the href-less link shows the unavailable message + support link', ev.prevented === true && note.hidden === false && /unavailable/i.test(note.textContent) && find(note, (n) => n.tagName === 'A').length === 1);
        w.state.lang = 'lg'; w.emit('lang');
        check('the visible unavailable message repaints in Luganda on a language switch', note.textContent.startsWith(w.T.lg.talk_unavailable), note.textContent);
    }

    console.log('Luganda chrome repaints on a language switch (and back)');
    {
        const { w } = loadWidget({ contact: WA }); w.state.lang = 'en'; w.state.messages = [];
        const lang = w.buildLang(); const { row, link } = w.buildHandoffRow(w.lastUserText);
        const foot = w.el('p', 'nexi-foot'); w.chrome(foot, { text: 'foot' });
        const send = w.el('button', 'x'); w.chrome(send, { 'aria-label': 'message_nexi', title: 'new_chat_title' });
        const cardsHost = w.el('div', 'bubble');
        w.renderCards(cardsHost, w.jsonParse(JSON.stringify({ kind: 'products', items: [{ type: 'product', id: 'p1', name: 'Samsung A15', price: 650000 }, { type: 'product', id: 'p2' }] })));
        [lang, row, foot, send, cardsHost].forEach((n) => w.doc.body.appendChild(n));
        const snap = () => ({ link: link.textContent, linkAria: link.getAttribute('aria-label'), langAria: lang.getAttribute('aria-label'), foot: foot.textContent, sendAria: send.getAttribute('aria-label'), sendTitle: send.getAttribute('title'),
            cardsAria: find(cardsHost, (n) => hasClass(n, 'nexi-cards'))[0].getAttribute('aria-label'), open: find(cardsHost, (n) => hasClass(n, 'nexi-card-open')).map((n) => n.textContent + '|' + n.getAttribute('aria-label')), share: find(cardsHost, (n) => hasClass(n, 'nexi-card-share')).map((n) => n.getAttribute('title') + '|' + n.getAttribute('aria-label')), nameFallback: find(cardsHost, (n) => hasClass(n, 'nexi-card-name')).map((n) => n.textContent) });
        const expect = (k) => { const L = w.T[k]; return { link: L.need_person, linkAria: L.need_person, langAria: L.chat_language, foot: L.foot, sendAria: L.message_nexi, sendTitle: L.new_chat_title, cardsAria: L.products, open: [L.card_open + '|' + L.card_open_aria.replace('{n}', 'Samsung A15'), L.card_open + '|' + L.card_open_aria.replace('{n}', k === 'lg' ? L.item : 'item')], share: [L.card_share + '|' + L.card_share_aria.replace('{n}', 'Samsung A15'), L.card_share + '|' + L.card_share_aria.replace('{n}', k === 'lg' ? L.item : 'item')], nameFallback: ['Samsung A15', L.product] }; };
        check('English chrome is built from the dictionary', JSON.stringify(snap()) === JSON.stringify(expect('en')), JSON.stringify(snap()));
        w.state.lang = 'lg'; w.emit('lang');
        check('after the switch EVERY marked string (link, group labels, footer, tooltips, card strings, fallback names) is Luganda', JSON.stringify(snap()) === JSON.stringify(expect('lg')), JSON.stringify(snap()));
        w.state.lang = 'en'; w.emit('lang');
        check('switching back repaints everything to English', JSON.stringify(snap()) === JSON.stringify(expect('en')), JSON.stringify(snap()));
        const keys = Object.keys(w.T.en);
        check('every English interface key has a Luganda counterpart and vice versa', JSON.stringify(keys.sort()) === JSON.stringify(Object.keys(w.T.lg).sort()));
        check('no Luganda string equals its English one (except the Luganda/English toggle labels, which are not in the dictionary)', keys.every((k) => w.T.lg[k] !== w.T.en[k]), keys.filter((k) => w.T.lg[k] === w.T.en[k]).join(','));
    }
    {
        // WIP 101: the person link left the header; both views build it ONCE-defined in buildFootRow (which calls buildHandoffRow), under the composer
        const builders = (rawSrc.match(/buildHandoffRow\(lastUserText\)/g) || []).length; const foots = (rawSrc.match(/buildFootRow\(\)/g) || []).length;
        check('both widget views (hero and panel) build the handoff row through buildFootRow -> buildHandoffRow, under the composer, and neither header holds a link or a notice', builders === 1 && foots === 3 && !/head\.appendChild\(hn\)|head\.appendChild\(human\)|head\.appendChild\(hrow/.test(rawSrc), builders + ' / ' + foots);
        check('widget source never contains DRAFT or needs_review', !/DRAFT|needs_review/i.test(rawSrc));
    }

    console.log(`\nwip93-widget-test: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
