/**
 * The emails NextaStore sends for accounts. Every template returns { subject, text, html }:
 * the text part is what plain clients and spam filters read, the html part is the branded one.
 * Layout is table-based with inline styles on purpose, because email apps ignore most modern CSS.
 */
'use strict';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

function layout({ preheader, heading, paragraphs, buttonLabel, buttonUrl, note }) {
    const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#24352d">${p}</p>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f2f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f4"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dfe9e3">
<tr><td style="background:#0b3b2b;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.2px">NextaStore</td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#0b3b2b">${esc(heading)}</h1>${body}</td></tr>
<tr><td style="padding:6px 28px 26px"><a href="${esc(buttonUrl)}" style="display:inline-block;background:#12a06f;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 26px;border-radius:12px">${esc(buttonLabel)}</a>
<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#5b6e65">If the button does not work, copy this address into your browser:<br><a href="${esc(buttonUrl)}" style="color:#0f7b53;word-break:break-all">${esc(buttonUrl)}</a></p></td></tr>
<tr><td style="padding:16px 28px;background:#f7faf8;font-size:12px;line-height:1.5;color:#6b7c73">${note}</td></tr>
</table></td></tr></table></body></html>`;
}

function verifyEmail({ name, link, hours = 24 }) {
    const subject = 'Confirm your NextaStore email';
    const text = `Hi ${first(name)},\n\nConfirm your email address to finish setting up your NextaStore account:\n${link}\n\nThis link works for ${hours} hours and can be used once.\nIf you did not create a NextaStore account, you can ignore this email.\n\nNextaStore`;
    const html = layout({
        preheader: 'One tap to confirm your email address.', heading: `Welcome, ${first(name)}`,
        paragraphs: ['Please confirm your email address. It lets us reach you about your orders and keeps your account safe.'],
        buttonLabel: 'Confirm my email', buttonUrl: link,
        note: `This link works for ${esc(hours)} hours and can be used once. If you did not create a NextaStore account, you can safely ignore this email.`
    });
    return { subject, text, html };
}

function resetPassword({ name, link, hours = 1 }) {
    const subject = 'Reset your NextaStore password';
    const text = `Hi ${first(name)},\n\nWe received a request to reset your password:\n${link}\n\nThis link works for ${hours} hour${hours === 1 ? '' : 's'} and can be used once.\nIf you did not ask for this, ignore this email: your password has not changed.\n\nNextaStore`;
    const html = layout({
        preheader: 'Choose a new password.', heading: 'Reset your password',
        paragraphs: [`Hi ${esc(first(name))}, we received a request to reset the password on your NextaStore account.`],
        buttonLabel: 'Choose a new password', buttonUrl: link,
        note: `This link works for ${esc(hours)} hour${hours === 1 ? '' : 's'} and can be used once. If you did not ask for this, ignore this email: your password has not changed.`
    });
    return { subject, text, html };
}

module.exports = { verifyEmail, resetPassword, esc };
