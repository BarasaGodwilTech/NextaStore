'use strict';
/* Support desk logic shared by the staff routes and the shopper-facing /api/support routes. */
const SLA_HOURS = Object.freeze({ urgent: 2, high: 8, normal: 24, low: 72 });
const PRIORITIES = Object.keys(SLA_HOURS);
const CATEGORIES = ['general', 'orders', 'payments', 'account', 'seller', 'listing', 'report', 'technical', 'other'];
const STATUSES = ['open', 'pending', 'resolved', 'closed'];

const slaDueFrom = (priority, from = new Date()) => new Date(new Date(from).getTime() + (SLA_HOURS[priority] || 24) * 3600 * 1000);
const isBreached = (t, now = Date.now()) => !!t.slaDueAt && ['open', 'pending'].includes(t.status) && new Date(t.slaDueAt).getTime() < now && t.status === 'open';

module.exports = { SLA_HOURS, PRIORITIES, CATEGORIES, STATUSES, slaDueFrom, isBreached };
