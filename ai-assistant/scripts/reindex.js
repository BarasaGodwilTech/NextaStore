#!/usr/bin/env node
/**
 * npm run reindex
 * Only for the optional RETRIEVAL=hybrid mode: rebuilds src/rag/index.json (embeddings) from src/knowledge/*.md.
 * The default keyword search needs no index and reloads knowledge files by itself.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const config = require('../src/config');
const { buildIndex } = require('../src/rag/build');

if (config.retrieval !== 'hybrid') {
    console.log('Nothing to do: RETRIEVAL=bm25 (the default) searches the knowledge files directly and reloads them automatically.');
    console.log('Set RETRIEVAL=hybrid in .env if you want the optional embedding index.');
    process.exit(0);
}

buildIndex()
    .then(() => {
        console.log('Done.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Reindex failed:', err.message);
        console.error('Is Ollama running, and is the embed model pulled? Try: npm run check-ollama');
        process.exit(1);
    });
