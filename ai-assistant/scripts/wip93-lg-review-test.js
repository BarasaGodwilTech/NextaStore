#!/usr/bin/env node
/**
 * WIP 93 Tier 3.1 tests: the Luganda review pack (export-lg-review.js, import-lg-review.js).
 * The Luganda strings below marked FIXTURE are test data for the importer's checks only. They are never product text and never written to the real
 * translation-memory.json (every import here uses --out in a temp directory).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } }
const root = path.resolve(__dirname, '..');
const { buildRows } = require('./export-lg-review');
const lib = require('./lib/lg-review');
const imp = require('./import-lg-review');
const realMemoryPath = path.join(root, 'src/lang/translation-memory.json');
const realMemoryBefore = fs.readFileSync(realMemoryPath, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-review-'));

console.log('Export: coverage, statuses, notes');
{
    const rows = buildRows();
    const ids = rows.map((r) => r.id);
    check('columns are exactly id, where_used, english_source, current_luganda, status, notes (+ reviewer, reviewed_on)', lib.COLUMNS.slice(0, 6).join() === 'id,where_used,english_source,current_luganda,status,notes' && lib.COLUMNS.length === 8);
    check(`every row id is unique (${rows.length} rows)`, new Set(ids).size === ids.length);
    check('every status is approved, draft or missing', rows.every((r) => lib.STATUSES.includes(r.status)));
    const faq = require('../src/knowledge/faq-instant.json');
    check(`every FAQ answer has a row (${faq.length})`, faq.every((e) => ids.includes(`faq:${e.id}`)));
    const pb = require('../src/lang/luganda-phrasebook.json').entries;
    check(`every phrasebook entry has a row, disabled ones are marked (${pb.length})`, pb.every((e) => ids.includes(`phrasebook:${e.id}`)) && pb.filter((e) => e.disabled).every((e) => /DISABLED/.test(rows.find((r) => r.id === `phrasebook:${e.id}`).notes)));
    const st = require('../src/lang/starters.json');
    const nStarters = st.en.guest.length + st.en.seller.length;
    check(`every starter question has a row (${nStarters})`, rows.filter((r) => r.id.startsWith('starter:')).length === nStarters);
    check('handoff text, clarify text, link lead-in and every link label have rows', ['handoff:text', 'clarify:text', 'link:lead-in', 'link-label:neutral'].every((i) => ids.includes(i)) && Object.keys(require('../src/lang/lgLinks').LG_LINK_LABELS).every((p) => ids.includes(`link-label:${p}`)));
    check('canned replies, small talk and the widget strings have rows', rows.some((r) => r.id.startsWith('canned:')) && rows.some((r) => r.id.startsWith('smalltalk:')) && rows.some((r) => r.id.startsWith('widget:')) && rows.some((r) => r.id.startsWith('widget:summary-')));
    check('the handoff row carries the exact Luganda handoff served today, as a draft', rows.find((r) => r.id === 'handoff:text').current_luganda === require('../src/chat/handoff').LG_HANDOFF && rows.find((r) => r.id === 'handoff:text').status === 'draft');
    check('NO row is approved while translation-memory.json has no entries', JSON.parse(realMemoryBefore).entries.length === 0 && rows.filter((r) => r.status === 'approved').length === 0);
    check('"missing" rows never carry Luganda; "draft" rows always do', rows.filter((r) => r.status === 'missing').every((r) => !r.current_luganda) && rows.filter((r) => r.status === 'draft').every((r) => r.current_luganda));
    check('no Luganda cell contains DRAFT or needs_review', rows.every((r) => !/\bDRAFT\b|needs_review/i.test(r.current_luganda)));
    const withNumbers = rows.filter((r) => /\d/.test(r.english_source));
    check(`rows with numbers, UGX amounts, links or placeholders say what to keep (${withNumbers.length} rows with digits)`, withNumbers.every((r) => /keep numbers/.test(r.notes)) && rows.filter((r) => /\]\(\//.test(r.english_source)).every((r) => /keep link targets/.test(r.notes)) && rows.filter((r) => /\{\{/.test(r.english_source)).every((r) => /keep placeholders/.test(r.notes) && /resolve to/.test(r.notes)));
    check('export is deterministic', JSON.stringify(buildRows()) === JSON.stringify(rows));
    const csv = lib.toCsv(rows);
    const back = lib.parseCsv(csv);
    check('CSV round-trips every cell (commas, quotes, newlines, ŋ and ’)', back.length === rows.length && back.every((b, i) => lib.COLUMNS.every((c) => b[c] === String(rows[i][c] || ''))));
    check('the generated lg-review/NEXI_LUGANDA_REVIEW.csv matches a fresh export', fs.existsSync(path.join(root, 'lg-review/NEXI_LUGANDA_REVIEW.csv')) && fs.readFileSync(path.join(root, 'lg-review/NEXI_LUGANDA_REVIEW.csv'), 'utf8') === csv);
}

console.log('Import: only approved rows, validated, all-or-nothing');
function csvOf(rows) { return lib.toCsv(rows.map((r) => ({ where_used: 'fixture', notes: '', reviewer: '', reviewed_on: '', ...r }))); }
function importCsv(rows, extra = [], out = path.join(tmp, `tm-${Math.random().toString(36).slice(2)}.json`)) {
    const f = path.join(tmp, `in-${Math.random().toString(36).slice(2)}.csv`); fs.writeFileSync(f, csvOf(rows), 'utf8');
    const log = [], err = [];
    const code = imp.run([f, '--out', out, ...extra], { log: (m) => log.push(m), error: (m) => err.push(m) });
    return { code, log: log.join('\n'), err: err.join('\n'), out, data: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}
{
    const good = { id: 't1', english_source: 'You can open a store in a few minutes. See [Open a store](/signup).', current_luganda: 'FIXTURE okutandika edduuka kitwala eddakiika ntono. Laba [Tandika edduuka](/signup).', status: 'approved', reviewer: 'Fixture Reviewer', reviewed_on: '2026-10-12' };
    const draft = { id: 't2', english_source: 'Never share your password.', current_luganda: 'FIXTURE draft wording', status: 'draft' };
    const missing = { id: 't3', english_source: 'Delivery is arranged with the seller.', current_luganda: '', status: 'missing' };
    let r = importCsv([good, draft, missing]);
    check('approved rows load; draft and missing rows are ignored and counted', r.code === 0 && /1 approved, 1 draft \(ignored\), 1 missing \(ignored\)/.test(r.log) && r.data.entries.length === 2 && !r.data.entries.some((e) => /draft wording/.test(e.lg)), r.log + r.err);
    check('entries are stored sentence by sentence with link tokens and the reviewer recorded', r.data.entries.every((e) => /⟦0⟧/.test(e.en) === /⟦0⟧/.test(e.lg)) && r.data.entries.some((e) => /⟦0⟧/.test(e.en)) && r.data.entries.every((e) => e.approved_by === 'Fixture Reviewer' && e.approved_on === '2026-10-12' && e.id === 't1'), JSON.stringify(r.data));
    check('the real translation-memory.json is untouched by these tests', fs.readFileSync(realMemoryPath, 'utf8') === realMemoryBefore);

    // served EXACTLY through the real translator and trusted by the real gate
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9'; // any real call would fail: approved text must not need the model
    const config = require('../src/config');
    const local = require('../src/lang/localTranslate');
    const lgGuard = require('../src/lang/lgGuard');
    config.translationMemoryPath = r.out; config.gandaModel = 'ganda-test'; local.resetForTests();
    return (async () => {
        const t = await local.translate(good.english_source);
        // The translator restores the link as written in the English; the site-wide Luganda link label (lgLinks) is applied afterwards by the pipeline.
        const lgLinksMod = require('../src/lang/lgLinks');
        check('approved wording is served by the translator EXACTLY, without calling any model; the visible link label then comes from lgLinks', t && t.text.replace('[Open a store]', '[Tandika edduuka]') === good.current_luganda && lgLinksMod.localizeLinkLabels(t.text).includes('(/signup)') && t.translated === t.total && t.approved === t.total, JSON.stringify(t));
        check('the Luganda gate trusts approved provenance even where its heuristics would object', lgGuard.gateReply({ lang: 'lg', source: 'model+local', text: 'Open the page now', translatedPieces: [{ translated: true, approved: true }] }).allowed === true && lgGuard.gateReply({ lang: 'lg', source: 'model+local', text: 'Open the page now', translatedPieces: [{ translated: true, approved: false }] }).allowed === false);

        // DOCUMENTED LIMIT: the translator (and with it the approved memory) is only active when GANDA_MODEL is configured, even though a fully approved
        // sentence never calls the model. Without it Luganda uses the phrasebook, small talk, canned and flag replies, link replies or the handoff.
        { const keep = config.gandaModel; config.gandaModel = ''; local.resetForTests(); const none = await local.translate(good.english_source); config.gandaModel = keep; local.resetForTests();
          check('limit (documented): approved memory is NOT used while GANDA_MODEL is unset; it is used once a model is configured', none === null && local.enabled() === true); }

        // refused rows: each kind of unsafe approval, and all-or-nothing
        const bad = (name, row, rx) => { const o = path.join(tmp, `bad-${name}.json`); const x = importCsv([good, row], [], o); check(`REFUSED (${name}): ${rx}; nothing written even though another row was fine`, x.code === 1 && rx.test(x.err) && !fs.existsSync(o), x.err + x.log); };
        bad('changed number', { id: 'b1', english_source: 'You can add 5 photos.', current_luganda: 'FIXTURE osobola okugatta 6 ebifaananyi.', status: 'approved' }, /numbers differ/);
        bad('dropped UGX', { id: 'b2', english_source: 'It costs UGX 20,000 a month.', current_luganda: 'FIXTURE kigula 20,000 buli mwezi.', status: 'approved' }, /UGX amounts differ/);
        bad('changed link target', { id: 'b3', english_source: 'Go to [Login](/login).', current_luganda: 'FIXTURE genda ku [Yingira](/signup).', status: 'approved' }, /link targets differ/);
        bad('dropped link', { id: 'b4', english_source: 'Go to [Login](/login).', current_luganda: 'FIXTURE genda ku lupapula lw’okuyingira.', status: 'approved' }, /link targets differ/);
        bad('dropped placeholder', { id: 'b5', english_source: 'The free trial is {{SUBSCRIPTION_TRIAL_DAYS}} days.', current_luganda: 'FIXTURE okugezesa kwa bwereere.', status: 'approved' }, /\{\{placeholders\}\} differ/);
        bad('unresolved placeholder', { id: 'b6', english_source: 'Value {{NO_SUCH_FACT_KEY}} here.', current_luganda: 'FIXTURE omuwendo {{NO_SUCH_FACT_KEY}} wano.', status: 'approved' }, /Unresolved FAQ placeholder/);
        bad('empty Luganda', { id: 'b7', english_source: 'Open the page.', current_luganda: '', status: 'approved' }, /Luganda is empty/);
        bad('identical to English', { id: 'b8', english_source: 'Open the marketplace page now.', current_luganda: 'Open the marketplace page now.', status: 'approved' }, /identical to the English/);
        bad('contains DRAFT', { id: 'b9', english_source: 'Open the page.', current_luganda: 'FIXTURE DRAFT kino.', status: 'approved' }, /DRAFT or needs_review/);
        bad('contains needs_review', { id: 'b10', english_source: 'Open the page.', current_luganda: 'FIXTURE kino needs_review.', status: 'approved' }, /DRAFT or needs_review/);
        bad('sentence count differs', { id: 'b11', english_source: 'Open the page. Then tap save.', current_luganda: 'FIXTURE ggulawo olupapula olwo n’okuuma.', status: 'approved' }, /same sentences|sentence\(s\)/);
        bad('unknown status', { id: 'b12', english_source: 'Open the page.', current_luganda: 'FIXTURE kino.', status: 'aproved' }, /unknown status/);
        { const f = path.join(tmp, 'noheader.csv'); fs.writeFileSync(f, 'a,b\n1,2\n'); const e = []; const code = imp.run([f, '--out', path.join(tmp, 'nh.json')], { log() {}, error: (m) => e.push(m) }); check('REFUSED (wrong header)', code === 1 && /header must contain/.test(e.join()) && !fs.existsSync(path.join(tmp, 'nh.json'))); }
        { const o = path.join(tmp, 'conflict.json'); const x = importCsv([{ id: 'c1', english_source: 'Open the page now.', current_luganda: 'FIXTURE wakkire.', status: 'approved' }, { id: 'c2', english_source: 'Open the page now.', current_luganda: 'FIXTURE wakkiriza.', status: 'approved' }], [], o); check('REFUSED (two different approved wordings for one English sentence)', x.code === 1 && /conflict/.test(x.err) && !fs.existsSync(o), x.err); }

        // placeholders: resolved against the CURRENT facts and numbers still checked
        const ph = importCsv([{ id: 'p1', english_source: 'The free trial is {{SUBSCRIPTION_TRIAL_DAYS}} days.', current_luganda: 'FIXTURE okugezesa kuweza {{SUBSCRIPTION_TRIAL_DAYS}} ennaku.', status: 'approved' }]);
        const { expand } = require('../src/knowledge/factsValues');
        check('{{placeholders}} are accepted when preserved and stored resolved from the current facts', ph.code === 0 && ph.data.entries.length === 1 && ph.data.entries[0].en === expand('The free trial is {{SUBSCRIPTION_TRIAL_DAYS}} days.') && ph.data.entries[0].lg.includes(expand('{{SUBSCRIPTION_TRIAL_DAYS}}')), JSON.stringify(ph));

        // merge: same pair unchanged, changed wording replaced, other entries kept; dry run writes nothing; usage error
        const out = path.join(tmp, 'merge.json');
        importCsv([good], [], out);
        const again = importCsv([good], [], out);
        check('re-importing the same approved pair changes nothing', again.code === 0 && /0 added, 0 replaced, 2 unchanged/.test(again.log) && again.data.entries.length === 2);
        const changed = importCsv([{ ...good, current_luganda: 'FIXTURE okutandika edduuka kitwala eddakiika ntono nnyo. Laba [Tandika edduuka](/signup).' }, { id: 'n1', english_source: 'Open the page now.', current_luganda: 'FIXTURE wakkire.', status: 'approved' }], [], out);
        check('a changed approved wording replaces the old one; unrelated entries are kept; new ones are added', changed.code === 0 && changed.data.entries.length === 3 && /nnyo/.test(changed.data.entries.find((e) => e.id === 't1' && !/⟦0⟧/.test(e.en)).lg), changed.log + JSON.stringify(changed.data));
        const dry = path.join(tmp, 'dry.json'); const d = importCsv([good], ['--dry-run'], dry);
        check('--dry-run reports what would change and writes nothing', d.code === 0 && /Dry run/.test(d.log) && !fs.existsSync(dry));
        const e2 = []; check('no CSV argument: usage message, exit code 2', imp.run([], { log() {}, error: (m) => e2.push(m) }) === 2 && /usage/.test(e2.join()));
        check('the memory file keeps its _note and _pinned_glossary when merging into the real format', (() => { const o = path.join(tmp, 'real.json'); fs.writeFileSync(o, realMemoryBefore); const x = importCsv([good], [], o); return x.code === 0 && x.data._note && x.data._pinned_glossary && x.data._pinned_glossary.store === 'edduuka'; })());
        check('the real translation-memory.json is STILL untouched after every import test', fs.readFileSync(realMemoryPath, 'utf8') === realMemoryBefore);
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log(`\nwip93-lg-review-test: ${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
    })();
}
