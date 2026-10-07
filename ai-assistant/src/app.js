const express = require('express');
const cors = require('cors');
const config = require('./config');
const assistantRoutes = require('./routes/assistant');

const app = express();

app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','), allowedHeaders: ['Content-Type', 'x-assistant-token'] }));
app.use(express.json({ limit: '256kb' }));

// Optional shared secret (ASSISTANT_TOKEN). Constant-time compare; /  stays open for uptime checks.
const crypto = require('crypto');
function requireToken(req, res, next) {
    if (!config.assistantToken) return next();
    const got = Buffer.from(String(req.headers['x-assistant-token'] || ''));
    const want = Buffer.from(config.assistantToken);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
    return res.status(401).json({ error: 'unauthorized' });
}
app.use('/api/assistant', requireToken, assistantRoutes);

app.get('/', (req, res) => {
    res.json({ name: 'nextastore-ai-assistant', status: 'ok' });
});

// Last-resort error handler — mirrors the "log and keep serving" philosophy
// in the main nextastore-backend rather than letting one bad request take
// the whole assistant down for every other user's tab.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[assistant] error:', err.message);
    res.status(500).json({ error: 'The assistant hit an internal error.' });
});

module.exports = app;
