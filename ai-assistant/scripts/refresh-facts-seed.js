#!/usr/bin/env node
/**
 * npm run facts:seed
 * Rewrites src/knowledge/90-project-facts.generated.md straight from the backend source
 * (../nextastore-backend/src/platformRules.js), with no server running. Use it after you
 * change a price, trial length, cancel rule, status or tier in the backend, so the saved
 * copy that ships with Nexi is right even before the live sync has run.
 * Only works when the two folders sit side by side (the project zip layout).
 */
const fs = require('fs');
const path = require('path');
const rulesPath = path.join(__dirname, '..', '..', 'nextastore-backend', 'src', 'platformRules.js');
if (!fs.existsSync(rulesPath)) {
    console.error('Cannot find ../nextastore-backend/src/platformRules.js. Run this from the full project, or just start the assistant while the backend is running: it syncs on its own.');
    process.exit(1);
}
const { buildFacts } = require(rulesPath);
const { validateFacts, renderFactsMarkdown } = require('../src/sync/factsSync');
const config = require('../src/config');
const facts = buildFacts();
const problem = validateFacts(facts);
if (problem) { console.error('Facts payload problem:', problem); process.exit(1); }
fs.writeFileSync(config.factsFile, renderFactsMarkdown(facts), 'utf8');
console.log(`Wrote ${path.relative(process.cwd(), config.factsFile)}`);
