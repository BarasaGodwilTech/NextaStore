#!/usr/bin/env node
/**
 * npm run lg:misses - turns data/lg-misses.jsonl (needs LOG_LUGANDA_MISSES=true) into a CSV
 * of the most common Luganda questions the phrasebook could not answer, most frequent first.
 * A Luganda speaker fills the last two columns; the good ones become phrasebook entries
 * or translation-memory pairs. Open the CSV in Excel/Sheets.
 */
const fs = require('fs');
const path = require('path');
const lgMisses = require('../src/lang/lgMisses');
const config = require('../src/config');

const file = lgMisses.file();
if (!fs.existsSync(file)) { console.log(`Nothing logged yet (${file}). Set LOG_LUGANDA_MISSES=true and let people use the assistant.`); process.exit(0); }

const counts = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
        const t = JSON.parse(line).text.toLowerCase().replace(/\s+/g, ' ').trim();
        if (t) counts.set(t, (counts.get(t) || 0) + 1);
    } catch (e) { /* skip bad line */ }
}
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const csv = ['times_asked,question_luganda,meaning_in_english,approved_luganda_answer', ...rows.map(([q, n]) => `${n},${esc(q)},,`)].join('\n') + '\n';
const out = path.join(config.dataDir, `lg-misses-${new Date().toISOString().slice(0, 10)}.csv`);
fs.writeFileSync(out, csv, 'utf8');
console.log(`${rows.length} distinct questions -> ${out}`);
