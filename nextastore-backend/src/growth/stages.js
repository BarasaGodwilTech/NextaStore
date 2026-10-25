/**
 * What the recruiter sees for each recruit, and what to do about it.
 * Pure: give it a referral snapshot, get back a label, a plain-language reason,
 * a suggested next step, a "needs you" flag and a sort priority.
 *
 * snapshot: {
 *   stage: 'lead'|'signed_up'|'store_live'|'payment_pending'|'paid'|'lapsed'|'blocked'|'void',
 *   program, signedUpAt, storeLiveAt, paymentSubmittedAt, trialEndsAt, lockExpiresAt, lastAskedAt,
 *   commissionStatus: null|'held'|'available'|'review', commissionAmount, clearsAt
 * }
 */
const R = require('./rules');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const STAGE_LABELS = {
    lead: 'Lead logged',
    signed_up: 'Signed up',
    store_live: 'Store is live',
    payment_pending: 'Payment sent, awaiting approval',
    paid: 'Paid',
    lapsed: 'Expired',
    blocked: 'Under review',
    void: 'Not counted'
};

const hoursSince = (d, now) => (now - new Date(d)) / HOUR;
const daysUntil = (d, now) => (new Date(d) - now) / DAY;

function describe(s, now = new Date()) {
    const out = { stage: s.stage, label: STAGE_LABELS[s.stage] || s.stage, tone: 'neutral', needsYou: false, priority: 50, reason: '', nextStep: '', canAskUs: false };

    switch (s.stage) {
        case 'lead': {
            const left = s.lockExpiresAt ? daysUntil(s.lockExpiresAt, now) : null;
            out.reason = 'They have not created an account yet.';
            out.nextStep = left !== null && left <= 3
                ? `Your claim on this lead ends in ${Math.max(0, Math.ceil(left))} day${Math.ceil(left) === 1 ? '' : 's'}. Visit again and log it to keep it.`
                : 'Share your code and walk them through signing up.';
            out.needsYou = left !== null && left <= 3;
            out.tone = out.needsYou ? 'warn' : 'neutral';
            out.priority = out.needsYou ? 20 : 60;
            break;
        }
        case 'signed_up': {
            const days = s.signedUpAt ? (now - new Date(s.signedUpAt)) / DAY : 0;
            out.reason = 'Their account exists but the store is not live yet.';
            out.nextStep = 'Offer to sit with them and add their first three products. Live stores pay far more often.';
            if (days >= R.FOLLOW_UP.stuckSignedUpAfterDays) { out.needsYou = true; out.tone = 'warn'; out.priority = 25; out.reason = `Signed up ${Math.floor(days)} days ago and the store is still not live.`; }
            else out.priority = 55;
            break;
        }
        case 'store_live': {
            const days = s.storeLiveAt ? (now - new Date(s.storeLiveAt)) / DAY : 0;
            const trialLeft = s.trialEndsAt ? daysUntil(s.trialEndsAt, now) : null;
            out.reason = 'Their store is live and the free trial is running.';
            out.nextStep = 'Remind them the Seller Pass keeps the store visible after the trial. Paying by MTN or Airtel takes about two minutes.';
            out.priority = 45; out.tone = 'good';
            if (trialLeft !== null && trialLeft <= R.FOLLOW_UP.trialEndingNudgeDays) {
                out.needsYou = true; out.tone = 'warn'; out.priority = 10;
                out.reason = trialLeft <= 0 ? 'Their trial has ended. Their store is hidden until they pay.' : `Their free trial ends in ${Math.max(1, Math.ceil(trialLeft))} day${Math.ceil(trialLeft) === 1 ? '' : 's'}.`;
                out.nextStep = 'This is the best moment to call. Walk them through the payment steps.';
            } else if (days >= R.FOLLOW_UP.stuckLiveAfterDays) {
                out.needsYou = true; out.tone = 'warn'; out.priority = 30;
            }
            break;
        }
        case 'payment_pending': {
            const hrs = s.paymentSubmittedAt ? hoursSince(s.paymentSubmittedAt, now) : 0;
            const delayed = hrs >= R.FOLLOW_UP.paymentApprovalTargetHours;
            out.reason = delayed
                ? `Their payment was sent ${Math.floor(hrs)} hours ago and has not been approved yet. That is longer than we aim for.`
                : 'Their payment is with our team. We aim to approve within 24 hours.';
            out.nextStep = delayed
                ? 'Check they used the right transaction ID. If they did, tap "Ask us to check" and we will look at it today.'
                : 'Nothing to do yet. Your earning appears the moment it is approved.';
            out.tone = delayed ? 'warn' : 'good';
            out.needsYou = delayed;
            out.priority = delayed ? 5 : 40;
            const cooled = !s.lastAskedAt || hoursSince(s.lastAskedAt, now) >= R.FOLLOW_UP.askUsToCheckCooldownHours;
            out.canAskUs = hrs >= R.FOLLOW_UP.askUsToCheckAfterHours && cooled;
            if (delayed && !cooled) out.nextStep = 'You asked us to check recently. We are on it.';
            break;
        }
        case 'paid': {
            out.tone = 'good'; out.priority = 90;
            if (s.commissionStatus === 'review') {
                out.reason = 'Approved. Your earning is being double-checked before it is released.';
                out.nextStep = 'No action needed. You will be notified when it is released.';
                out.tone = 'warn';
            } else if (s.commissionStatus === 'held' && s.clearsAt) {
                const left = Math.max(1, Math.ceil(daysUntil(s.clearsAt, now)));
                out.reason = `Approved. Your earning clears in ${left} day${left === 1 ? '' : 's'}.`;
                out.nextStep = 'Nothing to do. Keep them happy: renewals earn you a bonus too.';
            } else {
                out.reason = 'Approved and cleared. This earning is yours to withdraw.';
                out.nextStep = 'Check back when their Seller Pass renews to earn a renewal bonus.';
            }
            break;
        }
        case 'lapsed':
            out.reason = `They did not pay within ${R.ATTRIBUTION.qualifyingWindowDays} days of signing up.`;
            out.nextStep = 'If they are still interested, they can pay now, but it will no longer count for your earnings.';
            out.priority = 95; out.tone = 'muted'; break;
        case 'blocked':
            out.reason = 'This one is being reviewed by our team.';
            out.nextStep = 'No action needed. We will message you if we need anything.';
            out.priority = 70; out.tone = 'warn'; break;
        default:
            out.reason = 'This sign-up does not count towards your earnings.';
            out.nextStep = '';
            out.priority = 99; out.tone = 'muted';
    }
    return out;
}

/** Most urgent first: delayed approvals, trials ending, stuck stores, then the calm ones. */
function sortForRecruiter(rows) {
    return [...rows].sort((a, b) => a.priority - b.priority);
}

/** "3 stores need you today" for the top of the dashboard. */
function summarize(rows) {
    const needsYou = rows.filter((r) => r.needsYou).length;
    const by = (stage) => rows.filter((r) => r.stage === stage).length;
    return {
        total: rows.length,
        needsYou,
        awaitingApproval: by('payment_pending'),
        live: by('store_live'),
        signedUp: by('signed_up'),
        paid: by('paid')
    };
}

module.exports = { STAGE_LABELS, describe, sortForRecruiter, summarize };
