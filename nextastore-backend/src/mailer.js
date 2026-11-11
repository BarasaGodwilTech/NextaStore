const config = require('./config');

// No email provider is wired up in this sandbox (nodemailer needs real SMTP
// credentials to do anything, and none are available here to test against).
// This is written so it's a one-line swap once you have them: set
// SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM in .env and everything
// below routes through nodemailer instead of console.log. Until then, every
// "sent" email is printed to the server log — good enough for development,
// but reset/verification links will only ever reach the terminal, not an
// inbox, until real credentials are set.
let transporter = null;
function getTransporter() {
    if (transporter) return transporter;
    if (!process.env.SMTP_HOST) return null;
    // Lazily required so a deployment that never configures SMTP doesn't
    // need the nodemailer package installed at all.
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    return transporter;
}

// Is email usable right now? Used to decide whether password sign-up can safely ask people to confirm an address.
//  - SMTP configured: yes, unless the last few sends in a row failed (a provider outage): then we say no for a few minutes so people
//    are steered to "Continue with Google" instead of creating an account whose confirmation email never arrives.
//  - SMTP not configured: yes in development (the link is printed in the server log and handed back to the page), no in production.
const OUTAGE_AFTER = 3, OUTAGE_WINDOW_MS = 5 * 60 * 1000;
let consecutiveFailures = 0, lastFailureAt = 0;
function status() {
    const configured = !!process.env.SMTP_HOST;
    if (!configured) return { configured: false, available: !config.isProd, devMode: !config.isProd };
    const outage = consecutiveFailures >= OUTAGE_AFTER && Date.now() - lastFailureAt < OUTAGE_WINDOW_MS;
    return { configured: true, available: !outage, devMode: false };
}

async function sendMail({ to, subject, text, html }) {
    const t = getTransporter();
    if (!t) {
        console.log(`\n[mailer] SMTP not configured — logging email instead of sending:\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
        return { delivered: false };
    }
    try {
        await t.sendMail({
            from: process.env.SMTP_FROM || 'NextaStore <no-reply@nextastores.com>',
            to,
            subject,
            text,
            html
        });
    } catch (err) {
        consecutiveFailures += 1; lastFailureAt = Date.now();
        throw err;
    }
    consecutiveFailures = 0;
    return { delivered: true };
}

module.exports = { sendMail, status };
