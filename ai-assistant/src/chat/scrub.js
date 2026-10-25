/**
 * WIP 93 Tier 3.3: the SAME sensitive-data rules the widget applies to the WhatsApp handoff summary (js/assistant.js scrubHandoffText),
 * so a question stored for the team is scrubbed exactly like the one a visitor sends. A parity test (scripts/wip93-widget-test.js) runs
 * the widget's real function and this one on the same inputs and fails if they ever differ.
 * Keeps prices and order references; removes passwords/OTP/PIN values, card numbers, e-mail addresses and phone numbers.
 */
function scrubSensitive(value) {
    return String(value || '')
        .replace(/\b(?:password|passcode|otp|pin|verification code|security code)\b(?:\s+(?:is|was|are)\b)?\s*[:=]?\s*[^\s,;]+/ig, '[redacted]')
        .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[card redacted]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[email redacted]')
        .replace(/(?:\+?\d[\d ()-]{8,}\d)/g, function (m, offset, whole) {
            var before = whole.slice(Math.max(0, offset - 24), offset);
            if (/order\s*(?:#|number)?\s*$/i.test(before) || /reference\s*[:#]?\s*$/i.test(before) || /ref\s*[:#]?\s*$/i.test(before)) return m;
            var digits = m.replace(/\D/g, '');
            return digits.length >= 9 && digits.length <= 15 ? '[phone redacted]' : m;
        })
        .replace(/\s+/g, ' ').trim();
}
module.exports = { scrubSensitive };
