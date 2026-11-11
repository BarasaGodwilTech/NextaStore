'use strict';
/*
 * Message templates: the variable syntax and the starter library.
 *
 * Variables are written {{like_this}}. Only the ones listed here exist; anything else is left as typed so a typo is visible in the
 * preview instead of silently vanishing. Rendering is plain text substitution (HTML is escaped later, when an email is built).
 */
const VARIABLES = Object.freeze([
    ['first_name', 'The person\'s first name', 'Amina'],
    ['name', 'The person\'s full name', 'Amina Nakato'],
    ['staff_name', 'Your name', 'Sam']
]);
const KINDS = Object.freeze(['reply', 'email', 'notification']);

function render(text, vars = {}) {
    return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k.toLowerCase()) && vars[k.toLowerCase()] ? String(vars[k.toLowerCase()]) : m));
}
const varsFor = (user, staff) => {
    const name = String((user && user.name) || '').trim();
    return { name: name || 'there', first_name: name.split(/\s+/)[0] || 'there', staff_name: String((staff && staff.name) || 'NextaStore Support').split(/\s+/)[0] };
};

// id is stable so the migration can seed them with ON CONFLICT DO NOTHING (deleting one in the console never brings it back).
const STARTER_TEMPLATES = Object.freeze([
    { id: 'tpl_reply_order_on_way', kind: 'reply', category: 'orders', title: 'Order is on its way', subject: '', body: 'Hi {{first_name}}, thanks for your patience. Your order has been confirmed by the seller and is on its way. If it has not arrived within the delivery time they gave you, reply here and we will follow up with them straight away.\n\n{{staff_name}}, NextaStore Support' },
    { id: 'tpl_reply_need_details', kind: 'reply', category: 'general', title: 'We need a few more details', subject: '', body: 'Hi {{first_name}}, we would like to help but need a little more information. Could you send us the order number, the store name, and a short description of what went wrong? A screenshot helps too.\n\n{{staff_name}}, NextaStore Support' },
    { id: 'tpl_reply_payment_received', kind: 'reply', category: 'billing', title: 'Seller Pass payment received', subject: '', body: 'Hi {{first_name}}, we have received your Seller Pass payment and our finance team is confirming it now. This normally takes a few hours on working days. You will get a notification as soon as your store is renewed.\n\n{{staff_name}}, NextaStore Support' },
    { id: 'tpl_reply_account_unlocked', kind: 'reply', category: 'account', title: 'Account unlocked', subject: '', body: 'Hi {{first_name}}, your account is open again and you can sign in. If you did not expect the lock, we recommend changing your password from Account settings.\n\n{{staff_name}}, NextaStore Support' },
    { id: 'tpl_reply_closing', kind: 'reply', category: 'general', title: 'Closing the ticket', subject: '', body: 'Hi {{first_name}}, we are glad this is sorted. We will close this ticket now, but you can reply any time and it will reopen.\n\n{{staff_name}}, NextaStore Support' },
    { id: 'tpl_email_welcome_seller', kind: 'email', category: 'onboarding', title: 'Welcome, seller', subject: 'Welcome to NextaStore, {{first_name}}', body: 'Hi {{first_name}},\n\nWelcome to NextaStore. The fastest way to get your first sale is to add 5 products with clear photos and share your store link on WhatsApp.\n\nIf you get stuck, reply to this email and a real person will help.\n\n{{staff_name}}, NextaStore' },
    { id: 'tpl_email_trial_ending', kind: 'email', category: 'billing', title: 'Free trial ending soon', subject: 'Your NextaStore trial ends soon', body: 'Hi {{first_name}},\n\nYour free trial is about to end. To keep your store visible to shoppers, activate your Seller Pass from the Subscription page. Choosing 6 months or more earns the seller badge after approval.\n\nNeed help paying? Reply and we will walk you through it.\n\n{{staff_name}}, NextaStore' },
    { id: 'tpl_email_policy_warning', kind: 'email', category: 'trust', title: 'Policy reminder', subject: 'A reminder about marketplace rules', body: 'Hi {{first_name}},\n\nWe noticed activity on your account that goes against our marketplace rules. Please review the rules and update your listings within 3 days. If we do not hear from you, we may have to restrict the listing.\n\nIf you think this is a mistake, just reply and tell us.\n\n{{staff_name}}, NextaStore Trust & Safety' },
    { id: 'tpl_note_maintenance', kind: 'notification', category: 'platform', title: 'Planned maintenance', subject: 'Planned maintenance tonight', body: 'NextaStore will be briefly unavailable tonight for maintenance. Your store and orders are safe.' },
    { id: 'tpl_note_new_feature', kind: 'notification', category: 'platform', title: 'New feature announcement', subject: 'Something new on NextaStore', body: 'We just launched something new for you. Open your dashboard to try it.' }
]);

module.exports = { VARIABLES, KINDS, render, varsFor, STARTER_TEMPLATES };
