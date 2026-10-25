#!/usr/bin/env node
/**
 * npm run review:traffic - what real visitors asked that Nexi did not simply answer, for the owner's weekly review.
 *
 * Reads (all opt-in, all on this server only):
 *   data/flagged.jsonl    LOG_FLAGGED_MESSAGES=true: handoffs, clarifies, "not in the guides" answers, flagged messages (the handoff log and the flag log are this one file)
 *   data/lg-misses.jsonl  LOG_LUGANDA_MISSES=true: Luganda questions the phrasebook missed (read only if the file exists)
 * Writes traffic-review/TRAFFIC_REVIEW.csv: question (scrubbed), count, route, top_section, suggested_alias_line. Most asked first.
 * The alias line is a SUGGESTION to paste by hand at the end of a section's `aliases:` line in src/knowledge/*.md. This script never edits a guide.
 *
 *   npm run review:traffic                  everything logged so far
 *   npm run review:traffic -- --days 7      only the last 7 days (the weekly run)
 *   options: --min-count N   --data DIR   --out FILE
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const { buildReview, toCsv } = require('./lib/traffic-review');

const dataDir = path.resolve(arg('--data', process.env.DATA_DIR || path.join(ROOT, 'data')));
const out = path.resolve(arg('--out', path.join(ROOT, 'traffic-review', 'TRAFFIC_REVIEW.csv')));
const days = Number(arg('--days', 0)) || 0;
const minCount = Math.max(1, Number(arg('--min-count', 1)) || 1);

function readJsonl(file) {
    if (!fs.existsSync(file)) return null;
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch (e) { /* skip a bad line */ } }
    return rows;
}

const flagRows = readJsonl(path.join(dataDir, 'flagged.jsonl'));
const lgRows = readJsonl(path.join(dataDir, 'lg-misses.jsonl'));
if (!flagRows && !lgRows) {
    console.log(`Nothing logged yet (looked in ${dataDir}). Set LOG_FLAGGED_MESSAGES=true (and LOG_LUGANDA_MISSES=true for Luganda) and let people use the assistant.`);
    process.exit(0);
}
const { rows, skipped, considered } = buildReview(flagRows || [], lgRows || [], { since: days ? Date.now() - days * 86400000 : 0, minCount });
if (!rows.length) { console.log(`No unanswered, clarified or handed-off questions${days ? ` in the last ${days} day(s)` : ''}.`); process.exit(0); }

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, toCsv(rows), 'utf8');
const byRoute = {}; rows.forEach((r) => { byRoute[r.route] = (byRoute[r.route] || 0) + r.count; });
console.log(`${considered} question(s) in ${rows.length} group(s)${days ? `, last ${days} day(s)` : ''}:`);
Object.entries(byRoute).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`  ${r.padEnd(32)} ${n}`));
const sk = Object.entries(skipped).map(([t, n]) => `${t} ${n}`).join(', ');
if (sk) console.log(`  left out on purpose (abusive, private or unreadable text): ${sk}`);
console.log(`CSV -> ${path.relative(process.cwd(), out) || out}`);
console.log('Suggested alias lines are NOT applied. Paste a good one at the end of the right section\'s `aliases:` line by hand; for a real gap write guide text instead.');
