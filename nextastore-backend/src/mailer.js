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

async function sendMail({ to, subject, text, html }) {
    const t = getTransporter();
    if (!t) {
        console.log(`\n[mailer] SMTP not configured — logging email instead of sending:\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
        return { delivered: false };
    }
    await t.sendMail({
        from: process.env.SMTP_FROM || 'NextaStore <no-reply@nextastores.com>',
        to,
        subject,
        text,
        html
    });
    return { delivered: true };
}

module.exports = { sendMail };
