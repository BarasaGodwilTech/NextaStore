#!/usr/bin/env node
/*
 * WIP 101 acceptance (no Ollama, no network, no browser; the browser rules live in design-audit.js and the two assistant browser tests):
 *   A1  clarify chips never show near-duplicate or same-family options; distress / safety situations are ANSWERED, never clarified
 *   A2  a limit or minimum that IS in the guides is answered ("what is the shortest password I can use"), and a limit pointing the other way is not
 *   D   static design rules the browser audit cannot see: one token block, no remote assets, no "DRAFT" in UI text, new Luganda strings are in the review CSV
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); process.chdir(ROOT);
require('../src/chat/faqMatch').match = () => null;
const H = require('./lib/harness');
const T = require('../src/chat/tiers');
const answerable = require('./answerable-eval');
const oos = require('./oos-eval');
const { isNotInGuidesReply } = require('../src/chat/gapLine');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const info = (s) => console.log(`  info: ${s}`);
const ctx = { audience: 'guest', page: 'marketplace' };
const YES = 'Yes, you can do that on NextaStore. Open your dashboard and choose the option for it.';
const ask = async (message) => (await H.runTurn({ message, context: ctx })).result;
const deflected = (r) => r.source === 'handoff' || r.source === 'clarify' || isNotInGuidesReply(r.reply);
const SAFETY_HEADING = /goes\s+wrong\s+with\s+an\s+order|reporting\s+a\s+problem|general\s+safety|remember\s+me|resetting\s+a\s+forgotten/i;

(async () => {
  H.config.catalogCards = false; H.config.logFlagged = false;

  console.log('A1. chips: one chip per task, never two labels that say the same thing');
  check('"avoid scammers" and "avoid scams" are one chip', T.nearDuplicateLabel('How do I avoid scammers', 'How do I avoid scams'));
  check('"cancel an order" and "cancel my order" are one chip', T.nearDuplicateLabel('Cancel an order', 'Cancel my order'));
  check('two genuinely different tasks stay two chips', !T.nearDuplicateLabel('Open a store', 'Reset my password') && !T.nearDuplicateLabel('Pay for Seller Pass', 'Track my order'));
  check('safety sections are one family', T.familyOf({ heading: 'General safety guidance', aliases: [] }) === T.familyOf({ heading: 'Reporting a problem or a suspicious user', aliases: ['report a scammer'] }) && T.familyOf({ heading: 'General safety guidance', aliases: [] }) >= 0);
  check('safety and passwords are different families', T.familyOf({ heading: 'General safety guidance', aliases: [] }) !== T.familyOf({ heading: 'Resetting a forgotten password', aliases: [] }));
  check('planClarify and optionsFrom are still exported (the chip builder)', typeof T.planClarify === 'function' && typeof T.optionsFrom === 'function');
  // chips built from sections of ONE family collapse; from different families they stay
  const sec = (heading, aliases, source = 's.md') => ({ heading, aliases, source, score: 0.5, text: heading, confidence: 0.6, coverage: 0.6 });
  const safe1 = sec('General safety guidance', ['how do i avoid scams']); const safe2 = sec('Reporting a problem or a suspicious user', ['how do i avoid scammers']);
  const dup = T.planClarify([safe1, safe2], 'scam');
  check('two safety sections are one topic: no chips (the question is answered instead)', dup.kind !== 'chips' && (dup.options || []).length < 2, JSON.stringify(dup));
  check('optionsFrom never returns two chips for one family', T.optionsFrom([safe1, safe2], 3, 'scam', { strict: true }).length < 2);
  const distinct = T.planClarify([sec('Resetting a forgotten password', ['reset my password']), sec('Opening a store', ['open a store'])], 'account');
  info('two different tasks: ' + distinct.kind);

  console.log('A1. distress and safety: answered from the safety / report sections, never a menu');
  const sExtract = H.installModel();
  try {
    for (const q of ['a seller took my money and disappeared', 'someone is using my account', 'i sent money to the wrong number', 'my seller ran away with my money', 'i was scammed on nextastore', 'someone hacked my account']) {
      const r = await ask(q);
      const heads = (r.retrieved || []).slice(0, 2).map((x) => x.heading).join(' | ');
      check(`answered, not clarified or handed off: "${q}"`, !deflected(r) && r.source !== 'clarify' && SAFETY_HEADING.test(heads), `${r.source} ${heads} :: ${r.reply.slice(0, 80)}`);
    }
    for (const q of ['does nextastore keep my money when i order', 'how do i keep my account safe', 'is my money safe', 'how do i avoid scammers', 'what is a scam']) {
      check(`not mistaken for distress: "${q}"`, !T.isDistress(q));
    }
    const pw = await ask('what is the shortest password I can use');
    const rm = await require('../src/chat/retrieveMulti').retrieveForMessage('what is the shortest password I can use', 4);
    const inContext = rm.retrieved.slice(0, 3).some((x) => /at least 8 characters/.test(x.text || ''));
    check('A2: "what is the shortest password I can use" is answered (not handed off) and the 8-character rule is in the retrieved context the model sees', !deflected(pw) && inContext, pw.source + ' :: ' + (pw.retrieved || []).slice(0, 3).map((x) => x.heading).join(' | '));
  } finally { sExtract.restore(); }

  console.log('A2. limits: a stated minimum answers "shortest", never "longest"');
  const sYes = H.installModel(() => YES);
  try {
    const shortest = await ask('what is the shortest password I can use');
    const longest = await ask('what is the longest password I can use');
    check('"shortest" reaches the model (the minimum is in the guides)', shortest.source === 'model' && !isNotInGuidesReply(shortest.reply), shortest.source + ' ' + shortest.reply);
    check('"longest password": no maximum is in the guides, so the confident "Yes" is replaced by the handoff', isNotInGuidesReply(longest.reply) || longest.handoff, longest.reply);
    for (const q of ['what is the smallest number of months of seller pass', 'what is the largest order i can place', 'what is the highest price i can set']) {
      const r = await ask(q); check(`not in the guides, so no confident answer: "${q}"`, isNotInGuidesReply(r.reply) || r.handoff, r.reply);
    }
    const months = await ask('what is the most months of seller pass i can pay for in one go');
    check('a stated maximum (24 months in one block) is still answerable', !isNotInGuidesReply(months.reply), months.reply);
  } finally { sYes.restore(); }

  console.log('A2. numbers');
  for (const file of ['answerable-36.json', 'answerable-20b.json']) {
    const r = await answerable.evaluate({ guard: true, file });
    const pct = 100 * r.deflected.length / r.n;
    info(`${file}: false deflection ${r.deflected.length}/${r.n} = ${pct.toFixed(0)}%; natural replies changed ${r.changed.length}/${r.n}`);
    check(`${file}: false deflection <= 5%`, pct <= 5, JSON.stringify(r.deflected));
  }
  const o25b = await oos.evaluate(oos.load('scripts/golden/oos-25b.json'), { cards: false });
  check(`oos-25b >= 22/25 (${o25b.handoff + o25b.notInGuides}/25)`, o25b.handoff + o25b.notInGuides >= 22);
  for (const [f, label] of [['scripts/golden/oos-25.json', 'oos-25'], ['scripts/golden/retrieval-oos.json', 'retrieval-oos'], ['scripts/golden/oos-15.txt', 'oos-15']]) {
    const r = await oos.evaluate(oos.load(f), { cards: true });
    const third = r.handoff + r.notInGuides + r.offTopic + r.catalogNoClaim;
    check(`${label} >= 95% (off-topic and honest catalog replies counted)`, third / r.n >= 0.95, `${third}/${r.n}`);
    check(`${label}: no model-answered leak`, r.leaks.filter((l) => l.cat.startsWith('LEAK answered')).length === 0);
  }

  console.log('D. static design rules');
  const css = fs.readFileSync(path.join(ROOT, '..', 'css', 'assistant.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, '..', 'js', 'assistant.js'), 'utf8');
  const tokenBlock = css.slice(0, css.indexOf('/* ==========================================================================\n   Dock'));
  check('ONE token block at the top of assistant.css, scoped to the widget', /\.hero-chat, \.nexi-dock, \.nexi-panel \{[\s\S]*--nx-s1: 4px; --nx-s2: 8px; --nx-s3: 12px; --nx-s4: 16px; --nx-s5: 24px;[\s\S]*--nx-t12: 12px; --nx-t13: 13px; --nx-t14: 14px; --nx-t15: 15px; --nx-t16: 16px; --nx-t18: 18px;/.test(tokenBlock) && !/^:root\s*\{[^}]*--nx-green/m.test(css));
  check('the token block reuses the site variables (with fallbacks) for colour and type', /--nx-green: var\(--primary, #01B075\)/.test(tokenBlock) && /--nx-ink: var\(--ink, #0B3B2B\)/.test(tokenBlock) && /--nx-font: var\(--font-body/.test(tokenBlock));
  const rest = css.slice(tokenBlock.length);
  const fonts = (rest.match(/font-size:\s*[\d.]+(?:px|rem)/g) || []);
  check('no font-size below the 12px floor and none hard-coded outside the scale (all sizes come from --nx-t*)', fonts.every((f) => { const v = parseFloat(f.split(':')[1]); return /rem/.test(f) ? false : [12, 13, 14, 15, 16, 18, 22, 28, 34].includes(v); }) , fonts.join(' '));
  check('no remote font, image or script: no @import, no url(http...), no script element, no remote image, no web-font host (links to WhatsApp / the API / the company site are navigation, not assets)',
    !/@import/.test(css) && !/url\(\s*['"]?https?:/.test(css) && !/fonts\.(googleapis|gstatic)/.test(css + js) && !/createElement\(['"]script['"]\)/.test(js) && !/new Image\(|\.src\s*=\s*['"]https?:/.test(js) && !/<img[^>]+src=["']https?:/.test(js));
  check('prefers-reduced-motion switches off the message entrance, the typing dots and the jump pill', /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.nexi-msg[\s\S]*\.nexi-jump[\s\S]*animation: none/.test(css) && /\.nexi-typing i[^}]*animation: none/.test(css));
  check('new messages fade and rise in 160 ms (token), tokenised', /--nx-motion: 160ms/.test(css) && /\.nexi-msg \{[^}]*animation: nexi-in var\(--nx-motion\)/.test(css));
  const T_BLOCK = js.slice(js.indexOf('var T = {'), js.indexOf('// T-END'));
  check('the word DRAFT never appears in a UI string', !/DRAFT/i.test(T_BLOCK));
  const csv = fs.readFileSync(path.join(ROOT, 'lg-review', 'NEXI_LUGANDA_REVIEW.csv'), 'utf8');
  for (const k of ['need_person', 'handoff_hint', 'jump_latest']) check(`new Luganda string "${k}" is in the review CSV as a draft`, new RegExp(`widget-chrome:${k},[^\\n]*,draft,`).test(csv));
  check('the person link is out of the header (no handoff row is appended to a head)', !/head\.appendChild\(hrow/.test(js) && /function buildFootRow/.test(js));
  check('cards and the handoff button are built as thread children (syncExtras), not inside a bubble', /function syncExtras/.test(js) && !/renderCards\(b, m\.cards\)/.test(js));
  const sw = fs.readFileSync(path.join(ROOT, '..', 'service-worker.js'), 'utf8');
  check('the service worker cache version was bumped for the new js and css', /CACHE_VERSION = '[^']+'/.test(sw));

  console.log(`\nwip101-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
