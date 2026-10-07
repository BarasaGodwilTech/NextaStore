#!/usr/bin/env node
'use strict';
/**
 * Used by start.bat. Only matters when RETRIEVAL=hybrid (the default keyword search needs no index).
 * Makes sure the embedding index exists and is current:
 * rebuilds it when it is missing, unreadable, built with a different embedding model
 * than .env now says, or older than a file in src/knowledge/. Otherwise does nothing.
 * (Same result as `npm run reindex`, just only when needed.)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const config = require('../src/config');
const { buildIndex } = require('../src/rag/build');

function newestKnowledgeMtime() {
    return fs.readdirSync(config.knowledgeDir)
        .filter((f) => f.endsWith('.md'))
        .reduce((m, f) => Math.max(m, fs.statSync(path.join(config.knowledgeDir, f)).mtimeMs), 0);
}

(async () => {
    if (config.retrieval !== 'hybrid') {
        console.log('Knowledge search is keyword-based (RETRIEVAL=bm25): there is no index to build. Knowledge files are picked up automatically.');
        return;
    }
    let reason = '';
    if (!fs.existsSync(config.indexPath)) {
        reason = 'there is no knowledge index yet';
    } else {
        try {
            const idx = JSON.parse(fs.readFileSync(config.indexPath, 'utf8'));
            if (idx.embedModel !== config.embedModel) reason = `the index was built with '${idx.embedModel}' but .env now says '${config.embedModel}'`;
            else if (newestKnowledgeMtime() > fs.statSync(config.indexPath).mtimeMs) reason = 'a knowledge file changed since the last index';
        } catch (e) {
            reason = 'the index file is unreadable';
        }
    }
    if (!reason) { console.log('Knowledge index is up to date.'); return; }
    console.log(`Building the knowledge index (${reason})...`);
    await buildIndex();
})().catch((err) => {
    console.error('Could not build the knowledge index: ' + err.message);
    process.exit(1);
});
