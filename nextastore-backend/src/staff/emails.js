'use strict';
/* E-mails for staff: plain and sober on purpose (no marketing layout). Each returns { subject, text, html }. */
const { esc } = require('../emailTemplates');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

function shell(heading, paragraphs, label, url, note) {
    const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#24352d">${p}</p>`).join('');
    return `<!doctype html><html lang="en"><body style="margin:0;background:#f2f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" style="background:#f2f6f4"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #dfe9e3;border-radius:14px;overflow:hidden"><tr><td style="background:#08261c;padding:18px 26px;color:#fff;font-weight:700">NextaStore <span style="color:#ffb038;font-weight:600">· Staff</span></td></tr><tr><td style="padding:26px"><h1 style="margin:0 0 14px;font-size:20px;color:#0b3b2b">${esc(heading)}</h1>${body}<p style="margin:20px 0"><a href="${esc(url)}" style="background:#008558;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;display:inline-block">${esc(label)}</a></p><p style="margin:0;font-size:12px;color:#6b7c73">${note}</p></td></tr></table></td></tr></table></body></html>`;
}

function staffInviteEmail({ name, inviterName, roleName, link, hours }) {
    const subject = 'You have been invited to the NextaStore Staff Console';
    const text = `Hi ${first(name)},\n\n${inviterName} invited you to the NextaStore Staff Console as ${roleName}.\n\nSet your password and two-step verification here (valid for ${hours} hours, one use):\n${link}\n\nYou will need an authenticator app (Google Authenticator, Microsoft Authenticator, Authy or 1Password). If you were not expecting this, ignore this email.\n`;
    const html = shell('Welcome to the Staff Console', [`Hi ${esc(first(name))}, ${esc(inviterName)} invited you as <strong>${esc(roleName)}</strong>.`, 'You will choose a password and set up two-step verification with an authenticator app.'], 'Set up my account', link, `This link works for ${esc(hours)} hours and once only. If you were not expecting it, ignore this email.`);
    return { subject, text, html };
}

function staffResetEmail({ name, link, minutes }) {
    const subject = 'Reset your NextaStore staff password';
    const text = `Hi ${first(name)},\n\nA password reset was requested for your NextaStore staff account:\n${link}\n\nThe link works for ${minutes} minutes, once. You will still need your authenticator code to sign in. If this was not you, ignore this email and tell a Super Admin.\n`;
    const html = shell('Reset your staff password', [`Hi ${esc(first(name))}, a password reset was requested for your staff account.`, 'You will still need your authenticator code to sign in afterwards.'], 'Choose a new password', link, `Works for ${esc(minutes)} minutes, once. If this was not you, ignore it and tell a Super Admin.`);
    return { subject, text, html };
}

module.exports = { staffInviteEmail, staffResetEmail };
