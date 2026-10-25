#!/usr/bin/env node
/**
 * WIP 93 Tier 3.1: load a Luganda speaker's reviewed CSV into src/lang/translation-memory.json.
 *   node scripts/import-lg-review.js <reviewed.csv> [--dry-run] [--out <memory.json>]
 *
 * ONLY rows with status "approved" are loaded. draft and missing rows are ignored (and counted). Anything else is refused.
 * All-or-nothing: if ANY approved row is unsafe, nothing is written and the exit code is 1. An approved row is unsafe when, between the
 * English source and the Luganda, a number, a UGX amount, a link target or a {{placeholder}} is not preserved, when the Luganda is empty,
 * identical to the English, or contains DRAFT / needs_review, or when the two texts do not have the same number of sentences (the translation
 * memory works sentence by sentence, so an unaligned row could never be served).
 * Approved wording is then served EXACTLY (the Luganda gate trusts approved provenance).
 *
 * The English is stored as it will be looked up at run time: {{placeholders}} resolved from the CURRENT platform facts and markdown links
 * replaced by ⟦n⟧ tokens. If a fact (e.g. the price) changes later the pair simply stops matching and the model/handoff path is used: that is the safe direction.
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, validatePair, STATUSES } = require('./lib/lg-review');

function sentencesOf(text, local, protectLinks) {
    const { out } = protectLinks(text);
    return local.splitPieces(out).filter((p) => p.text && local.hasTranslatableText(p.text)).map((p) => p.text.trim());
}

/** @returns {{pairs: object[], problems: string[], counts: object}} pure: no file is touched. */
function prepare(csvText) {
    const local = require('../src/lang/localTranslate');
    const { protectLinks } = require('../src/lang/links');
    const { expand } = require('../src/knowledge/factsValues');
    const rows = parseCsv(csvText);
    const problems = []; const pairs = [];
    const counts = { rows: rows.length, approved: 0, draft: 0, missing: 0, skipped_blank_status: 0 };
    if (rows.length && !['id', 'english_source', 'current_luganda', 'status'].every((c) => c in rows[0])) { problems.push('the CSV header must contain id, english_source, current_luganda and status'); return { pairs, problems, counts }; }
    rows.forEach((r, idx) => {
        const label = `row ${idx + 2} (${r.id || 'no id'})`;
        const status = String(r.status || '').trim().toLowerCase();
        if (!status) { counts.skipped_blank_status += 1; return; }
        if (!STATUSES.includes(status)) { problems.push(`${label}: unknown status "${r.status}" (use approved, draft or missing)`); return; }
        if (status !== 'approved') { counts[status] += 1; return; }
        counts.approved += 1;
        const rowProblems = validatePair(r.english_source, r.current_luganda).map((p) => `${label}: ${p}`);
        if (rowProblems.length) { problems.push(...rowProblems); return; }
        let en, lg;
        try { en = expand(r.english_source); lg = expand(r.current_luganda); } catch (e) { problems.push(`${label}: ${e.message}`); return; }
        const enS = sentencesOf(en, local, protectLinks), lgS = sentencesOf(lg, local, protectLinks);
        if (enS.length !== lgS.length || !enS.length) { problems.push(`${label}: English has ${enS.length} sentence(s) but the Luganda has ${lgS.length}; split the Luganda into the same sentences, in the same order`); return; }
        enS.forEach((e, i) => {
            const pp = validatePair(e, lgS[i]).filter((p) => !/identical to the English/.test(p) || e.length > 12);
            const tokens = (t) => (t.match(/⟦\d+⟧/g) || []).sort().join('');
            if (tokens(e) !== tokens(lgS[i])) pp.push('link tokens differ between the aligned sentences');
            if (pp.length) problems.push(...pp.map((p) => `${label}, sentence ${i + 1}: ${p}`));
            else pairs.push({ en: e, lg: lgS[i], id: r.id, approved_by: String(r.reviewer || '').trim() || undefined, approved_on: String(r.reviewed_on || '').trim() || undefined });
        });
    });
    // two different approved wordings for the same English sentence
    const seen = new Map();
    for (const p of pairs) { const k = local.norm(p.en); if (seen.has(k) && seen.get(k).lg !== p.lg) problems.push(`conflict: "${p.en}" has two different approved Luganda wordings (${seen.get(k).id} and ${p.id})`); else seen.set(k, p); }
    return { pairs, problems, counts };
}

function merge(existing, pairs) {
    const local = require('../src/lang/localTranslate');
    const data = existing && typeof existing === 'object' ? existing : { entries: [] };
    const entries = Array.isArray(data.entries) ? data.entries.slice() : [];
    let added = 0, replaced = 0, unchanged = 0;
    for (const p of pairs) {
        const i = entries.findIndex((e) => e && local.norm(e.en) === local.norm(p.en));
        const entry = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
        if (i < 0) { entries.push(entry); added += 1; } else if (entries[i].lg === p.lg) unchanged += 1; else { entries[i] = entry; replaced += 1; }
    }
    return { data: { ...data, entries }, added, replaced, unchanged };
}

function run(argv, io = { log: console.log, error: console.error }) {
    const args = argv.filter((a) => !a.startsWith('--'));
    const flag = (n) => argv.includes(n);
    const oi = argv.indexOf('--out');
    const outPath = oi >= 0 ? path.resolve(argv[oi + 1]) : require('../src/config').translationMemoryPath;
    if (!args.length || (oi >= 0 && args[0] === argv[oi + 1])) { io.error('usage: node scripts/import-lg-review.js <reviewed.csv> [--dry-run] [--out <memory.json>]'); return 2; }
    const { pairs, problems, counts } = prepare(fs.readFileSync(path.resolve(args[0]), 'utf8'));
    io.log(`Read ${counts.rows} rows: ${counts.approved} approved, ${counts.draft} draft (ignored), ${counts.missing} missing (ignored), ${counts.skipped_blank_status} with no status (ignored).`);
    if (problems.length) {
        io.error(`REFUSED: ${problems.length} problem(s). Nothing was written.`);
        problems.forEach((p) => io.error(`  - ${p}`));
        return 1;
    }
    let existing = { entries: [] }; try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { /* new file */ }
    const { data, added, replaced, unchanged } = merge(existing, pairs);
    if (flag('--dry-run')) { io.log(`Dry run: would add ${added}, replace ${replaced}, leave ${unchanged} unchanged (${pairs.length} sentence pairs). Nothing written.`); return 0; }
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, outPath);
    io.log(`Loaded ${pairs.length} approved sentence pair(s) into ${outPath}: ${added} added, ${replaced} replaced, ${unchanged} unchanged. Total entries: ${data.entries.length}.`);
    return 0;
}

if (require.main === module) process.exit(run(process.argv.slice(2)));
module.exports = { prepare, merge, run };
