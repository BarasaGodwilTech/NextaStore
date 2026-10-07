#!/usr/bin/env node
/**
 * npm run flags - turns data/flagged.jsonl (needs LOG_FLAGGED_MESSAGES=true) into a CSV and prints a
 * short summary: how many messages were flagged by type, the most common off-topic questions, and
 * how many conversations drifted. Open the CSV in Excel/Sheets.
 *   npm run flags            all rows
 *   npm run flags -- 7       only the last 7 days
 */
const fs = require('fs');
const path = require('path');
const flagLog = require('../src/chat/flagLog');
const config = require('../src/config');

const file = flagLog.file();
if (!fs.existsSync(file)) { console.log(`Nothing logged yet (${file}). Set LOG_FLAGGED_MESSAGES=true and let people use the assistant.`); process.exit(0); }

const days = Number(process.argv[2]) || 0;
const since = days ? Date.now() - days * 86400000 : 0;
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!since || Date.parse(r.at) >= since) rows.push(r); } catch (e) { /* skip bad line */ }
}
if (!rows.length) { console.log('No flagged messages in that period.'); process.exit(0); }

const byType = {};
rows.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
console.log(`${rows.length} flagged message(s)${days ? ` in the last ${days} day(s)` : ''}:`);
Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t.padEnd(14)} ${n}`));
console.log(`  conversations marked as drifting: ${rows.filter((r) => r.conversation).length}`);

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csv = ['when,type,reason,source,conversation_drifting,page,audience,lang,text', ...rows.map((r) => [r.at, r.type, esc(r.reason), r.source, r.conversation ? 'yes' : '', r.page, r.audience, r.lang, esc(r.text)].join(','))].join('\n') + '\n';
const out = path.join(config.dataDir, `flagged-${new Date().toISOString().slice(0, 10)}.csv`);
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(out, csv, 'utf8');
console.log(`CSV -> ${out}`);
