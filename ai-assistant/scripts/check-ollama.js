#!/usr/bin/env node
/** npm run check-ollama - quick sanity check before you fight with anything else. */
const config = require('../src/config');
const ollama = require('../src/ollama/client');
const translator = require('../src/lang/translator');

(async () => {
    console.log(`Checking Ollama at ${config.ollamaHost} ...`);
    const health = await ollama.checkHealth();

    if (!health.reachable) {
        console.error(`x ${health.error}`);
        console.error('  Install: https://ollama.com/download');
        console.error("  Then run: ollama serve   (or just open the Ollama app)");
        process.exit(1);
    }
    console.log('ok Ollama is reachable.');
    console.log(`   Installed models: ${health.models.join(', ') || '(none)'}`);

    let good = true;
    const line = (ok, label, model) => {
        if (ok) console.log(`ok ${label} '${model}' is present.`);
        else { good = false; console.warn(`x  ${label} '${model}' not found. Run: ollama pull ${model}`); }
    };
    line(health.chatModelPulled, 'Chat model', config.chatModel);
    if (config.retrieval === 'hybrid') line(health.embedModelPulled, 'Embed model', config.embedModel);
    else console.log('ok Retrieval is keyword search (no embedding model needed).');

    const lg = translator.describe();
    if (config.gandaModel) line(health.gandaModelPulled, 'Luganda model', config.gandaModel);
    console.log(`   Luganda mode: ${lg.provider}${lg.model ? ` (${lg.model})` : ''}${lg.provider === 'local' ? ' - English answers translated on this machine; Luganda questions are understood via the phrasebook and multilingual search' : ''}`);

    process.exit(good ? 0 : 1);
})();
