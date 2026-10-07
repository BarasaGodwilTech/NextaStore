const express = require('express');
const proxy = require('../assistantProxy');
const { factsHandler } = require('../assistantFacts');

const router = express.Router();

// Public on purpose: guests and shoppers ask Nexi too. Limits live in app.js.
router.get('/starters', proxy.starters);
// Platform rules (price, trial, cancel rule, statuses...) for Nexi's self-updating knowledge. Read-only, no user data.
router.get('/facts', factsHandler);
router.post('/chat', proxy.chat);
router.post('/chat/stream', proxy.chatStream);

module.exports = router;
