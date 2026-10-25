const express = require('express');
const proxy = require('../assistantProxy');
const { factsHandler } = require('../assistantFacts');
const { getPlatformSettings } = require('../helpers');
const { normalizeUgandanWhatsapp } = require('../whatsapp-normalizer');

const router = express.Router();

// Public on purpose: guests and shoppers ask Nexi too. Limits live in app.js.
router.get('/starters', proxy.starters);
// Platform rules (price, trial, cancel rule, statuses...) for Nexi's self-updating knowledge. Read-only, no user data.
router.get('/facts', factsHandler);
// Public read-only, deliberately allowlisted: never expose other platform settings.
router.get('/handoff-contact', async (req, res, next) => {
    try {
        const s = await getPlatformSettings();
        const digits = normalizeUgandanWhatsapp(s.supportWhatsappNumber || '');
        const enabled = s.supportWhatsappEnabled === true && /^2567\d{8}$/.test(digits);
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
        res.json({ enabled, whatsappDigits: enabled ? digits : '', displayNumber: enabled ? ('+' + digits) : '', label: String(s.supportContactLabel || 'NextaStore support team'), hoursNote: String(s.supportHoursNote || '') });
    } catch (err) { next(err); }
});
router.post('/chat', proxy.chat);
router.post('/chat/stream', proxy.chatStream);

module.exports = router;
