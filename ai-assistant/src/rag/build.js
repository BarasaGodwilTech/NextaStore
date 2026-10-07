const fs = require('fs');
const path = require('path');
const config = require('../config');
const ollama = require('../ollama/client');
const { chunkMarkdown } = require('./chunk');

/**
 * Rebuilds src/rag/index.json from every .md file in src/knowledge/.
 *
 * This is the mechanism that keeps the assistant "up to date" as the
 * platform changes: there is no fine-tuning and no retraining involved.
 * Whenever a feature ships, someone edits the relevant file in
 * src/knowledge/ (or adds a new one) and reruns `npm run reindex`. The next
 * question that touches that topic is answered from the new text.
 *
 * A plain JSON file (not a real vector database) is intentional here: a
 * help-center-sized knowledge base is a few hundred chunks at most, and a
 * brute-force cosine-similarity scan over a few hundred vectors is
 * effectively instant. Reach for a real vector DB only if this ever grows
 * to thousands of documents.
 */
async function buildIndex({ log = console.log } = {}) {
    const files = fs
        .readdirSync(config.knowledgeDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

    if (files.length === 0) {
        throw new Error(`No .md files found in ${config.knowledgeDir} — nothing to index.`);
    }

    const allChunks = [];
    for (const file of files) {
        const raw = fs.readFileSync(path.join(config.knowledgeDir, file), 'utf8');
        const { chunks } = chunkMarkdown(file, raw);
        allChunks.push(...chunks);
    }

    log(`Embedding ${allChunks.length} chunks from ${files.length} knowledge file(s) using '${config.embedModel}'...`);

    const embedded = [];
    for (const [i, chunk] of allChunks.entries()) {
        const vector = await ollama.embed(`${chunk.heading}\n${chunk.text}`);
        embedded.push({ ...chunk, vector });
        if ((i + 1) % 5 === 0 || i === allChunks.length - 1) {
            log(`  ${i + 1}/${allChunks.length}`);
        }
    }

    const index = {
        builtAt: new Date().toISOString(),
        embedModel: config.embedModel,
        chunks: embedded,
    };
    fs.writeFileSync(config.indexPath, JSON.stringify(index));
    log(`Wrote ${config.indexPath} (${embedded.length} chunks).`);
    return index;
}

module.exports = { buildIndex };
