/**
 * GET /api/assistant/facts - public, read-only, cached platform rules for Nexi.
 *
 * Returns values straight from platformRules.js (the same constants the routes
 * enforce), never user, order or payment records. Sends an ETag so the
 * assistant's sync can ask "anything new?" and get a cheap 304.
 *
 * Written without express so scripts/assistant-facts-test.js can call it with a
 * fake req/res.
 */
const crypto = require('crypto');
const { buildFacts } = require('./platformRules');

function factsHandler(req, res) {
    const body = JSON.stringify({ data: buildFacts() });
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=60');
    if (req.headers && req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
}

module.exports = { factsHandler };
