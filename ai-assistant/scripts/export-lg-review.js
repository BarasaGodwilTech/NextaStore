#!/usr/bin/env node
/**
 * WIP 93 Tier 3.1: export every user-visible Luganda string (and every string that still NEEDS a Luganda translation)
 * to lg-review/NEXI_LUGANDA_REVIEW.csv for a Luganda speaker.   Usage: node scripts/export-lg-review.js [--out file.csv]
 *
 * Nothing is invented: "current_luganda" is exactly what the code serves today; where there is none, it is empty and status=missing.
 * status:  approved = a speaker approved it (it is in translation-memory.json)
 *          draft    = Luganda exists in the code but NO speaker has approved it
 *          missing  = no Luganda yet (visitors get the Luganda handoff instead)
 * A speaker edits current_luganda, sets status=approved (and ideally reviewer + reviewed_on), and the file goes to import-lg-review.js.
 */
const fs = require('fs');
const path = require('path');
const { toCsv, keepNotes } = require('./lib/lg-review');

const root = path.resolve(__dirname, '..');
const widgetPath = path.resolve(root, '../js/assistant.js');
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

function buildRows() {
    const rows = [];
    const add = (id, where, en, lg, status, extra = '') => rows.push({ id, where_used: where, english_source: en || '', current_luganda: lg || '', status, notes: [keepNotes(en || ''), extra].filter(Boolean).join(' | '), reviewer: '', reviewed_on: '' });

    // 1. FAQ answers: Luganda visitors currently get the Luganda handoff for these (English FAQ text can never be shown on a Luganda turn).
    const faq = require('../src/knowledge/faq-instant.json');
    const { expand } = require('../src/knowledge/factsValues');
    for (const e of faq) {
        let today = ''; try { today = expand(e.answer); } catch (err) { today = `(unresolved: ${err.message})`; }
        add(`faq:${e.id}`, `FAQ answer "${e.id}" (src/knowledge/faq-instant.json); asked as e.g. "${e.questions[0]}"`, e.answer, '', 'missing',
            `answer is sentence-aligned on import: keep the SAME number of sentences${/\{\{/.test(e.answer) ? `; today the placeholders resolve to: ${today}` : ''}`);
    }
    // 2. Luganda phrasebook (curated answers served straight to Luganda questions)
    const pb = require('../src/lang/luganda-phrasebook.json');
    for (const e of pb.entries) add(`phrasebook:${e.id}`, `Luganda phrasebook entry "${e.id}" (src/lang/luganda-phrasebook.json)${e.disabled ? ' - currently DISABLED' : ''}`, e.en_reference, e.lg_answer, e.needs_review === false ? 'approved' : 'draft', e.disabled ? `DISABLED: ${e.disabled_reason || 'its rules are outdated; re-approve before enabling'}` : 'needs_review in the data file');
    // 3. Starter questions
    const st = require('../src/lang/starters.json');
    for (const aud of ['guest', 'seller']) (st.en[aud] || []).forEach((q, i) => add(`starter:${aud}:${i + 1}`, `Starter question ${i + 1} for ${aud}s (src/lang/starters.json)`, q, (st.lg[aud] || [])[i], st.lg_status === 'approved' ? 'approved' : 'draft', `starters lg_status = ${st.lg_status}`));
    // 4. Handoff and clarify texts, link-lead
    const { LG_HANDOFF, EN_HANDOFF } = require('../src/chat/handoff');
    add('handoff:text', 'Handoff reply on every Luganda turn that cannot be answered in Luganda (src/chat/handoff.js)', EN_HANDOFF, LG_HANDOFF, 'draft', 'shown very often; highest-value row to review');
    const pipe = fs.readFileSync(path.join(root, 'src/chat/pipeline.js'), 'utf8');
    const clar = /const clarification = detected\.code === 'lg' \? '((?:[^'\\]|\\.)*)' : '((?:[^'\\]|\\.)*)'/.exec(pipe);
    if (clar) add('clarify:text', 'Clarifying question when a message matches nothing (src/chat/pipeline.js). Not shown to Luganda visitors today (they get the handoff); wording is ready if it is approved and used.', unq(clar[2]), unq(clar[1]), 'draft');
    const linkLead = /Laba wano: /.test(pipe);
    if (linkLead) add('link:lead-in', 'Lead-in before a link when a Luganda visitor asks for "the link" (src/chat/pipeline.js, followed by the link itself)', 'Here’s the page you were asking for:', 'Laba wano:', 'draft');
    // 5. Link labels
    const lgLinks = require('../src/lang/lgLinks');
    const english = {}; // find the English label each in-site path is shown with in the knowledge base
    const dir = path.join(root, 'src/knowledge');
    for (const f of fs.readdirSync(dir).filter((x) => /\.(md|json)$/.test(x))) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\[([^\]\n]{1,60})\]\((\/[A-Za-z0-9\-_/]*)\)/g)) if (!english[m[2]]) english[m[2]] = m[1];
    for (const [p, label] of Object.entries(lgLinks.LG_LINK_LABELS)) add(`link-label:${p}`, `Label of every link to ${p} on a Luganda turn (src/lang/lgLinks.js)`, english[p] || '', label, 'draft', 'link TARGET is never changed; this row is the label shown for EVERY link to this path on a Luganda turn');
    add('link-label:neutral', 'Label of an in-site link with no entry above (src/lang/lgLinks.js)', 'Open', lgLinks.NEUTRAL_LABEL, 'draft');
    // 6. Canned replies and small talk
    const canned = require('../src/chat/canned');
    for (const [k, v] of Object.entries(canned.REPLIES)) add(`canned:${k}`, `Canned reply "${k}" (src/chat/canned.js)`, v.en, v.lg, 'draft');
    const stk = require('../src/chat/smalltalkReplies');
    for (const [cls, arr] of Object.entries(stk.REPLIES.lg)) arr.forEach((lg, i) => add(`smalltalk:${cls}:${i + 1}`, `Small-talk reply "${cls}" #${i + 1} (src/chat/smalltalkReplies.js)`, (stk.REPLIES.en[cls] || [])[i] || '', lg, 'draft', (stk.REPLIES.en[cls] || [])[i] ? 'English source is the same-position English reply' : 'no English counterpart at this position'));
    const { LG_SMALLTALK_DRAFTS } = require('../src/chat/pipeline');
    Object.entries(LG_SMALLTALK_DRAFTS).forEach(([phrase, lg], i) => add(`smalltalk-draft:${i + 1}`, `Reply when the visitor says "${phrase}" (LG_SMALLTALK_DRAFTS in src/chat/pipeline.js)`, '', lg, 'draft', 'identity / language small talk; no English source'));
    // 7. Widget (js/assistant.js)
    if (fs.existsSync(widgetPath)) {
        const w = fs.readFileSync(widgetPath, 'utf8');
        const seen = new Set(); let n = 0;
        for (const m of w.matchAll(/(?:state\.lang === 'lg'|\blg) \? ('(?:[^'\\]|\\.)*') : ('(?:[^'\\]|\\.)*')/g)) {
            const lg = unq(m[1].slice(1, -1)), en = unq(m[2].slice(1, -1)); const key = `${en}|${lg}`; if (seen.has(key)) continue; seen.add(key);
            add(`widget:${++n}`, 'Widget text (js/assistant.js)', en, lg, 'draft');
        }
        // WIP 94: the interface dictionary (T in js/assistant.js): every key is repainted when the visitor switches language
        const tb = w.indexOf('// T-BEGIN'), te = w.indexOf('// T-END');
        if (tb > -1 && te > tb) {
            const block = w.slice(tb, te);
            const reused = new Set([...block.matchAll(/^\s*(\w+): '(?:[^'\\]|\\.)*',?\s*\/\/ REUSED/gm)].map((m) => m[1]));
            let T = null; try { T = new Function(`return (function(){ ${block.slice(block.indexOf('var T = {'))} return T; })()`)(); } catch (e) { /* leave the section out */ }
            if (T) for (const key of Object.keys(T.en)) add(`widget-chrome:${key}`, `Interface text "${key}" (T in js/assistant.js), repainted on every language switch${/\{n\}/.test(T.en[key]) ? '; {n} is replaced by the product or store name' : ''}`, T.en[key], T.lg[key], 'draft', reused.has(key) ? 'wording already in use before WIP 94' : 'NEW in WIP 94: written for review, please correct freely');
        }
        const sum = /var lines = lg \? \[([\s\S]*?)\] : \[([\s\S]*?)\];/.exec(w);
        if (sum) { const lits = (blk) => [...blk.matchAll(/^\s*'((?:[^'\\]|\\.)*)'/gm)].map((x) => unq(x[1])); const l = lits(sum[1]), e = lits(sum[2]); l.forEach((lg, i) => add(`widget:summary-${i + 1}`, 'Line of the WhatsApp handoff summary the visitor can edit before sending (js/assistant.js handoffSummary)', e[i] || '', lg, 'draft', 'the text after the colon is added by the code (page, audience, the visitor\'s own questions)')); }
        // English-only widget strings: needed translations
        const only = new Set();
        for (const line of w.split('\n')) { if (/state\.lang|\blg\b/.test(line)) continue; for (const m of line.matchAll(/\.textContent = '((?:[^'\\]|\\.)*)'/g)) { const t = unq(m[1]); if (/^[A-Z][\w ’'?!.,-]{3,60}$/.test(t) && !seen.has(t)) only.add(t); } }
        [...only].forEach((t, i) => add(`widget-missing:${i + 1}`, 'Widget text with no Luganda yet (js/assistant.js); Luganda visitors see the English', t, '', 'missing'));
    }
    // 8. Approved translation memory
    let tm = { entries: [] }; try { tm = require('../src/lang/translation-memory.json'); } catch (e) { /* none */ }
    (tm.entries || []).forEach((e, i) => add(`tm:${e.id || i + 1}`, 'Approved translation-memory pair (src/lang/translation-memory.json), served exactly', e.en, e.lg, 'approved', e.approved_by ? `approved by ${e.approved_by}` : ''));
    // unique ids
    const ids = new Set(); for (const r of rows) { let id = r.id, k = 2; while (ids.has(id)) id = `${r.id}~${k++}`; r.id = id; ids.add(id); }
    return rows;
}

if (require.main === module) {
    const i = process.argv.indexOf('--out');
    const out = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(root, 'lg-review', 'NEXI_LUGANDA_REVIEW.csv');
    const rows = buildRows();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, toCsv(rows), 'utf8');
    const count = (s) => rows.filter((r) => r.status === s).length;
    console.log(`Wrote ${rows.length} rows to ${out}: ${count('approved')} approved, ${count('draft')} draft, ${count('missing')} missing.`);
}
module.exports = { buildRows };
