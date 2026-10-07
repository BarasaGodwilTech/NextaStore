/**
 * Regenerates the Luganda conversation starters from the English ones by machine
 * translation, so nobody has to hand-write Luganda. Uses the local Ganda Gemma model (GANDA_MODEL).
 * Run:  npm run translate:starters
 * These are shown to every visitor, so have a Luganda speaker read the result once.
 */
const fs = require('fs');
const config = require('../src/config');
const translator = require('../src/lang/translator');

(async () => {
    const provider = translator.provider();
    if (provider === 'off') {
        console.error('No Luganda translator configured. Set GANDA_MODEL (and run ollama pull), then retry.');
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(config.startersPath, 'utf8'));
    const out = { guest: [], seller: [] };
    for (const group of ['guest', 'seller']) {
        for (const q of data.en[group]) {
            const res = await translator.toLuganda(q);
            // A partly-English result is not good enough for a button label.
            if (!res || (res.total && res.translated < res.total)) { console.error(`Translation failed for: ${q}`); process.exit(1); }
            const lg = res.text.replace(/\s+/g, ' ').trim();
            out[group].push(lg);
            console.log(`${q}\n  -> ${lg}`);
        }
    }
    data.lg = out;
    const model = config.gandaModel;
    data.lg_status = `machine-translated by ${model} on ${new Date().toISOString().slice(0, 10)} - needs a Luganda speaker's review`;
    fs.writeFileSync(config.startersPath, JSON.stringify(data, null, 2) + '\n');
    console.log('\nWrote', config.startersPath);
})();
