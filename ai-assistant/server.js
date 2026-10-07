const app = require('./src/app');
const config = require('./src/config');
const ollama = require('./src/ollama/client');

app.listen(config.port, config.host, async () => {
    console.log(`NextaStore AI Assistant listening on http://${config.host}:${config.port}`);
    console.log(`  Ollama host:  ${config.ollamaHost}`);
    console.log(`  Chat model:   ${config.chatModel}`);
    console.log(`  Retrieval:    ${config.retrieval === 'hybrid' ? 'hybrid (keywords + embeddings, embed model ' + config.embedModel + ')' : 'keyword search (in memory, reloads when knowledge files change)'}`);
    const lg = require('./src/lang/translator').describe();
    if (config.legacySettingsIgnored.length) console.warn(`  NOTE: ${config.legacySettingsIgnored.join(', ')} in .env is ignored: hosted Luganda services were removed, nothing is sent outside this server. You can delete the line.`);
    console.log(`  Luganda:      ${lg.provider}${lg.model ? ' (' + lg.model + ')' : ''}`);
    if (config.assistantToken) console.log('  Access:       x-assistant-token required');
    else if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.warn('  NOTE: listening on all interfaces without ASSISTANT_TOKEN. Fine on a laptop; on a server set HOST=127.0.0.1 or ASSISTANT_TOKEN.');

    const health = await ollama.checkHealth().catch((e) => ({ reachable: false, error: e.message }));
    if (!health.reachable) {
        console.warn(`  WARNING: cannot reach Ollama at ${config.ollamaHost}. Run 'ollama serve' (or open the Ollama app), then restart this service.`);
    } else {
        if (!health.chatModelPulled) console.warn(`  WARNING: chat model '${config.chatModel}' isn't pulled yet. Run: ollama pull ${config.chatModel}`);
        if (config.retrieval === 'hybrid' && !health.embedModelPulled) console.warn(`  WARNING: embed model '${config.embedModel}' isn't pulled yet. Run: ollama pull ${config.embedModel}`);
        if (lg.provider === 'local' && !health.gandaModelPulled) console.warn(`  WARNING: Luganda model '${config.gandaModel}' isn't pulled yet. Run: ollama pull ${config.gandaModel}  (until then Luganda answers fall back to English)`);
        if (health.chatModelPulled && health.embedModelPulled) {
            console.log(`  Ollama: reachable, ${config.retrieval === 'hybrid' ? 'chat + embed models' : 'chat model'} present.`);
            // Load the chat model now so the first visitor does not pay for it.
            ollama.warmup().then((ok) => console.log(ok ? '  Chat model warmed up.' : '  Warm-up skipped (the first question may be slower).'));
        }
    }

    const factsSync = require('./src/sync/factsSync');
    if (config.factsSyncMs) {
        console.log(`  Facts sync:   from ${config.nextastoreApiBase}/assistant/facts every ${Math.round(config.factsSyncMs / 1000)} s (keeps the last saved copy if the backend is down)`);
        factsSync.start();
    } else {
        console.log('  Facts sync:   off (FACTS_SYNC_MS=0); the saved facts file is used as it is');
    }

    try {
        const knowledge = require('./src/rag/retrieve').stats();
        console.log(`  Knowledge:    ${knowledge.chunks} sections from ${knowledge.files} files`);
    } catch (err) {
        console.warn(`  WARNING: cannot read the knowledge folder (${err.message}). Platform questions will not be answered from the guide.`);
    }
    if (config.retrieval === 'hybrid' && !require('fs').existsSync(config.indexPath)) {
        console.warn(`  WARNING: RETRIEVAL=hybrid but there is no embedding index. Run 'npm run reindex' (until then search uses keywords only).`);
    }
});
