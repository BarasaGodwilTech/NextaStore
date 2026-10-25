/**
 * Fraud signal engine. Pure: the service gathers facts (a plain `facts` object),
 * this file turns them into signals, a score and a decision.
 *
 *   decision 'clear'   -> normal flow
 *   decision 'review'  -> conversion is held; a human with growth.review must release or void it
 *   decision 'block'   -> conversion voided, partner frozen, admin notified
 *
 * "Hard" signals block on their own, whatever the score. Soft signals add weight.
 * The reasons are stored with the decision so an admin sees WHY, in plain words.
 */
const R = require('./rules');

/** Gmail-style normalisation so a.b+x@gmail.com and ab@gmail.com compare equal. */
function normalizeEmail(email) {
    const [local = '', domain = ''] = String(email || '').trim().toLowerCase().split('@');
    const d = domain === 'googlemail.com' ? 'gmail.com' : domain;
    let l = local.split('+')[0];
    if (d === 'gmail.com') l = l.replace(/\./g, '');
    return `${l}@${d}`;
}

/** Ugandan numbers: 0772123456, +256772123456, 256 772 123 456 -> 256772123456. */
function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('256') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return `256${digits.slice(1)}`;
    if (digits.length === 9) return `256${digits}`;
    return digits || '';
}

function ipPrefix(ip) {
    const s = String(ip || '');
    if (s.includes(':')) return s.split(':').slice(0, 4).join(':');  // IPv6 /64
    return s.split('.').slice(0, 3).join('.');                       // IPv4 /24
}

/**
 * facts (all optional, missing = no signal):
 *   partner:   { userId, email, phones: [], payoutNumber, signupIpPrefix, usualIpPrefixes: [] }
 *   recruit:   { userId, email, storePhone, signupIpPrefix, deviceHash }
 *   payment:   { reference, payerPhone, referenceUsedByOtherStore }
 *   history:   { signupsLastHour, signupsLast24h, recruitsSameIpPrefix7d, totalSignups, clearedCount,
 *                reversedCount, partnersSharingPayoutNumber, recruitsSameDevice }
 *   recruitHasProducts: number   (how real the store looks)
 */
function evaluate(facts = {}) {
    const { partner = {}, recruit = {}, payment = {}, history = {} } = facts;
    const signals = [];
    const add = (code, weight, hard, message) => signals.push({ code, weight, hard: !!hard, message });

    // ---- Hard signals: the same person on both sides of the deal
    if (partner.userId && recruit.userId && partner.userId === recruit.userId) {
        add('SELF_REFERRAL', 100, true, 'The partner and the new store are the same account.');
    }
    if (partner.email && recruit.email && normalizeEmail(partner.email) === normalizeEmail(recruit.email)) {
        add('SAME_EMAIL', 100, true, 'The new store signed up with an email that is the partner\'s own (aliases and dots counted).');
    }
    const partnerPhones = [...(partner.phones || []), partner.payoutNumber].filter(Boolean).map(normalizePhone);
    if (recruit.storePhone && partnerPhones.includes(normalizePhone(recruit.storePhone))) {
        add('SAME_PHONE', 100, true, 'The store\'s phone number is the partner\'s own number.');
    }
    if (payment.payerPhone && partnerPhones.includes(normalizePhone(payment.payerPhone))) {
        add('PARTNER_PAID_IT', 100, true, 'The Seller Pass was paid from the partner\'s own mobile money number.');
    }
    if (payment.referenceUsedByOtherStore) {
        add('REFERENCE_REUSED', 100, true, 'This mobile money transaction ID was already used for another store.');
    }
    if (history.partnersSharingPayoutNumber > 1) {
        add('SHARED_PAYOUT_NUMBER', 100, true, 'The same payout number is attached to more than one partner account.');
    }

    // ---- Soft signals: patterns that deserve a second look
    if (recruit.signupIpPrefix && partner.signupIpPrefix && recruit.signupIpPrefix === partner.signupIpPrefix) {
        add('SAME_NETWORK_AS_PARTNER', 35, false, 'The store signed up from the same network as the partner.');
    } else if (recruit.signupIpPrefix && (partner.usualIpPrefixes || []).includes(recruit.signupIpPrefix)) {
        add('PARTNER_USUAL_NETWORK', 25, false, 'The store signed up from a network the partner regularly uses.');
    }
    if (history.recruitsSameIpPrefix7d >= R.RISK.sameIpRecruitsPer7Days) {
        add('IP_CLUSTER', 30, false, `${history.recruitsSameIpPrefix7d} of this partner's recruits came from one network in a week.`);
    }
    if (history.recruitsSameDevice >= 2) {
        add('DEVICE_CLUSTER', 35, false, 'Several recruits share one device.');
    }
    if (history.signupsLastHour >= R.RISK.signupBurstPerHour) {
        add('SIGNUP_BURST_HOUR', 30, false, `${history.signupsLastHour} sign-ups in the last hour.`);
    } else if (history.signupsLast24h >= R.RISK.signupBurstPerDay) {
        add('SIGNUP_BURST_DAY', 20, false, `${history.signupsLast24h} sign-ups in the last day.`);
    }
    const domain = String(recruit.email || '').split('@')[1]?.toLowerCase();
    if (domain && R.RISK.disposableEmailDomains.includes(domain)) {
        add('DISPOSABLE_EMAIL', 25, false, 'The store signed up with a throw-away email address.');
    }
    if (history.totalSignups >= R.RISK.lowConversionMinSignups
        && (history.clearedCount / history.totalSignups) < R.RISK.lowConversionBelow) {
        add('LOW_CONVERSION', 15, false, 'Many sign-ups but almost none ever pay.');
    }
    const reversalBase = (history.clearedCount || 0) + (history.reversedCount || 0);
    if (reversalBase >= 5 && history.reversedCount / reversalBase >= R.RISK.reversalRateWarn) {
        add('HIGH_REVERSALS', 30, false, 'A high share of this partner\'s payments were later reversed.');
    }
    if (facts.recruitHasProducts === 0) {
        add('EMPTY_STORE', 10, false, 'The store paid but has no products.');
    }

    const hard = signals.find((s) => s.hard);
    const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
    let decision = 'clear';
    if (hard || score >= R.RISK.blockAtScore) decision = 'block';
    else if (score >= R.RISK.reviewAtScore) decision = 'review';
    return { decision, score, signals, reasons: signals.map((s) => s.message) };
}

/** Partner-level review used by the nightly sweep: should this partner be auto-frozen? */
function partnerHealth({ openFlags = 0, blockedConversions = 0, reversedCount = 0, clearedCount = 0 }) {
    if (blockedConversions >= 2) return { freeze: true, reason: 'Two or more conversions were blocked by fraud checks.' };
    if (openFlags >= 3) return { freeze: true, reason: 'Three or more open flags.' };
    const base = clearedCount + reversedCount;
    if (base >= 5 && reversedCount / base >= 0.4) return { freeze: true, reason: 'Over 40% of payments were reversed.' };
    return { freeze: false };
}

module.exports = { evaluate, partnerHealth, normalizeEmail, normalizePhone, ipPrefix };
