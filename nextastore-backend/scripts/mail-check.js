/**
 * Sends the real "confirm your email" message to one address, so you can check that email is set up end to end.
 * With SMTP_* unset it prints the message instead (that is what the server does in development).
 * Usage:  node scripts/mail-check.js you@example.com
 */
'use strict';
const config = require('../src/config');
const { sendMail } = require('../src/mailer');
const emails = require('../src/emailTemplates');

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { console.error('Usage: node scripts/mail-check.js you@example.com'); process.exit(1); }
(async () => {
    const mail = emails.verifyEmail({ name: 'Test', link: `${config.frontendUrl}/verify-email?token=this-is-only-a-test` });
    const out = await sendMail({ to, ...mail });
    console.log(out.delivered ? `Sent to ${to}. Check the inbox (and the spam folder).` : 'SMTP is not set up, so the message was printed above instead of sent.');
})().catch((e) => { console.error(`Could not send: ${e.message}`); process.exit(1); });
