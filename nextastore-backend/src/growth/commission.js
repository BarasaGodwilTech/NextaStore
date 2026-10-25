/**
 * Money logic for NextaStore Circle and NextaStore Crew. Pure functions: no database,
 * no Express. The service (service.js) loads rows and calls these; the tests
 * call them directly with plain objects.
 *
 * Commission row shape used here:
 *   { amount, status: 'held'|'available'|'voided', clearsAt, type }
 *   amount is signed: clawbacks are negative.
 * Withdrawal row shape:
 *   { amount, status: 'requested'|'in_review'|'approved'|'paid'|'rejected'|'cancelled', requestedAt }
 */
const crypto = require('crypto');
const R = require('./rules');

const DAY = 86400000;

// ---- Codes ---------------------------------------------------------------------------
function generatePartnerCode(program, randomBytes = crypto.randomBytes) {
    const bytes = randomBytes(R.CODE_LENGTH);
    let body = '';
    for (let i = 0; i < R.CODE_LENGTH; i++) body += R.CODE_ALPHABET[bytes[i] % R.CODE_ALPHABET.length];
    return `${R.CODE_PREFIX[program]}-${body}`;
}

/** Accepts "crew-4htr9", " CREW 4HTR9 ", "CIRCLE-K7M3Q" (and old "scout-4htr9" codes); returns the code as stored, or null. */
function normalizeCode(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const prefix of [...Object.values(R.CODE_PREFIX), ...R.LEGACY_CODE_PREFIXES]) {
        if (s.startsWith(prefix) && s.length === prefix.length + R.CODE_LENGTH) {
            const body = s.slice(prefix.length);
            if ([...body].every((c) => R.CODE_ALPHABET.includes(c))) return `${prefix}-${body}`;
        }
    }
    return null;
}

// ---- Ranks (Crew) ------------------------------------------------------------------
function rankFor(cleared90d) {
    let best = R.SCOUT_RANKS[0];
    for (const rank of R.SCOUT_RANKS) if (cleared90d >= rank.minCleared90d) best = rank;
    return best;
}

/**
 * The rank a Scout actually holds. Rank follows the rolling 90-day count (so it can step
 * down when activity stops), but a promotion only lands while quality is healthy.
 */
function effectiveRank(cleared90d, qualityScore, currentKey = 'trailhead') {
    const earned = rankFor(cleared90d);
    const held = R.SCOUT_RANKS.find((r) => r.key === currentKey) || R.SCOUT_RANKS[0];
    const promoting = R.SCOUT_RANKS.indexOf(earned) > R.SCOUT_RANKS.indexOf(held);
    return promoting && qualityScore < R.RANK_MIN_QUALITY_SCORE ? held : earned;
}

function nextRank(rank, cleared90d) {
    const i = R.SCOUT_RANKS.findIndex((r) => r.key === rank.key);
    const next = R.SCOUT_RANKS[i + 1];
    return next ? { ...next, remaining: Math.max(0, next.minCleared90d - cleared90d) } : null;
}

// ---- Commission for a store's first approved payment ---------------------------------
/**
 * @param program   'circle' | 'scout'
 * @param payment   { amount, periodMonths }
 * @param opts      { rank (scout), campaignBoostPercent }
 * @returns         array of line items [{ type, amount, note }] (empty if nothing earned)
 */
function commissionForFirstPayment(program, payment, opts = {}) {
    const lines = [];
    const rate = program === 'scout' ? (opts.rank || R.SCOUT_RANKS[0]).rate : R.COMMISSION.circle.rate;
    const baseCap = R.COMMISSION.baseMonths * R.PASS_PRICE_PER_MONTH_UGX;
    const base = Math.min(Number(payment.amount) || 0, baseCap);
    const main = Math.round((base * rate) / 100) * 100; // whole hundreds, neat on MoMo
    if (main > 0) lines.push({ type: 'first_payment', amount: main, note: `${Math.round(rate * 100)}% of the first month (UGX ${base.toLocaleString('en-UG')})` });

    const cfg = R.COMMISSION[program];
    if (Number(payment.periodMonths) >= R.COMMISSION.kickerMinMonths && cfg.commitmentKicker) {
        lines.push({ type: 'commitment_kicker', amount: cfg.commitmentKicker, note: `Store committed ${payment.periodMonths} months up front` });
    }
    const boost = Number(opts.campaignBoostPercent) || 0;
    if (boost > 0 && main > 0) {
        lines.push({ type: 'campaign_boost', amount: Math.round((main * boost) / 100 / 100) * 100, note: `Campaign boost +${boost}%` });
    }
    return applyUpfrontCap(lines.filter((l) => l.amount > 0), Number(payment.amount) || 0);
}

/**
 * The margin guard. Everything paid on a first payment together may not exceed
 * `maxUpfrontShare` of what the store actually paid. If it would, the smallest-priority
 * extras are trimmed first (boost, then live bonus, then kicker), and the main commission last.
 */
function applyUpfrontCap(lines, paid) {
    const cap = Math.floor((paid * R.COMMISSION.maxUpfrontShare) / 100) * 100;
    let total = lines.reduce((sum, l) => sum + l.amount, 0);
    if (total <= cap) return lines;
    const out = lines.map((l) => ({ ...l }));
    for (const type of ['campaign_boost', 'live_bonus', 'commitment_kicker', 'first_payment']) {
        const over = total - cap;
        if (over <= 0) break;
        const line = out.find((l) => l.type === type);
        if (!line) continue;
        const cut = Math.min(line.amount, over);
        line.amount -= cut; total -= cut;
        if (cut > 0 && line.amount > 0) line.note += ` (capped at ${Math.round(R.COMMISSION.maxUpfrontShare * 100)}% of the first payment)`;
    }
    return out.filter((l) => l.amount > 0);
}

/** Planning estimate of the mobile money fee NextaStore pays on a payout of this size. */
function estimatePayoutFee(amount) {
    const a = Number(amount) || 0;
    if (a <= 0) return 0;
    return R.PAYOUT_FEE.tiers.find((t) => a <= t.upTo).fee;
}

/**
 * Rewards for a store's first on-time renewal: the stay bonus, plus (Scouts) a stocked-store
 * bonus when the store still has products on its shelf. Returns [] when nothing is due.
 * Paid once per store; the caller passes alreadyPaidRenewal.
 */
function renewalRewardsFor(program, { previousCoverageEnd, approvedAt, alreadyPaidRenewal, liveProducts = 0 }) {
    if (alreadyPaidRenewal || !previousCoverageEnd) return [];
    const lateBy = (new Date(approvedAt) - new Date(previousCoverageEnd)) / DAY;
    if (lateBy > R.COMMISSION.renewalWithinDays) return [];
    const cfg = R.COMMISSION[program];
    const lines = [];
    if (cfg.renewalBonus) lines.push({ type: 'renewal', amount: cfg.renewalBonus, note: 'Your store renewed its Seller Pass' });
    if (program === 'scout' && cfg.liveBonus && Number(liveProducts) >= R.COMMISSION.liveMinProducts) {
        lines.push({ type: 'live_bonus', amount: cfg.liveBonus, note: `Store still had ${liveProducts} products when it renewed` });
    }
    return lines;
}

function clearsAtFor(approvedAt) { return new Date(new Date(approvedAt).getTime() + R.CLEARANCE.days * DAY); }

// ---- Balances ------------------------------------------------------------------------
/**
 * pending   money tied to approved payments still inside the clearance window
 * available cleared money minus everything already requested/approved/paid out
 * inFlight  requested or approved, not yet paid
 * paid      lifetime paid out
 * A negative `available` means a clawback is being worked off: withdrawals are blocked.
 */
function computeBalances(commissions, withdrawals, now = new Date()) {
    let pending = 0, cleared = 0;
    for (const c of commissions) {
        if (c.status === 'voided') continue;
        const amount = Number(c.amount);
        const isCleared = c.status === 'available' || (c.status === 'held' && c.clearsAt && new Date(c.clearsAt) <= now);
        if (isCleared || amount < 0) cleared += amount; else pending += amount;
    }
    let inFlight = 0, paid = 0;
    for (const w of withdrawals) {
        const amount = Number(w.amount);
        if (w.status === 'paid') paid += amount;
        else if (['requested', 'in_review', 'approved'].includes(w.status)) inFlight += amount;
    }
    return { pending, available: cleared - paid - inFlight, inFlight, paid, lifetimeEarned: cleared + pending };
}

// ---- Trust level ----------------------------------------------------------------------
function trustLevel({ joinedAt, clearedConversions, qualityScore, openFlags = 0, frozen = false }, now = new Date()) {
    const ageDays = (now - new Date(joinedAt)) / DAY;
    if (frozen) return 'new';
    if (ageDays >= R.TRUST_RULES.trustedAfterDays && clearedConversions >= R.TRUST_RULES.trustedAfterClearedConversions
        && qualityScore >= R.TRUST_RULES.trustedMinQualityScore && openFlags === 0) return 'trusted';
    if (ageDays >= R.TRUST_RULES.standardAfterDays && clearedConversions >= R.TRUST_RULES.standardAfterClearedConversions) return 'standard';
    return 'new';
}

/** "Thu 16 Oct, 3:40 pm" in East Africa Time: what a person reads, never a raw timestamp. */
function formatEat(d) {
    const e = new Date(new Date(d).getTime() + R.EAT_OFFSET_HOURS * 3600 * 1000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const h = e.getUTCHours(), m = String(e.getUTCMinutes()).padStart(2, '0');
    return `${days[e.getUTCDay()]} ${e.getUTCDate()} ${months[e.getUTCMonth()]}, ${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'am' : 'pm'}`;
}

// ---- Withdrawal eligibility ---------------------------------------------------------------
/**
 * Everything that can say "no" to a withdrawal, in the order a person would want to hear it.
 * Returns { ok, code, message, needsSecondApproval, limits }.
 *
 * partner:  { joinedAt, frozen, payoutNumber, payoutNumberChangedAt, trust, clearedConversions }
 * history:  withdrawals (all) for this partner
 */
function checkWithdrawal({ partner, amount, balances, history, now = new Date() }) {
    const limits = R.TRUST_LEVELS[partner.trust] || R.TRUST_LEVELS.new;
    const fail = (code, message) => ({ ok: false, code, message, limits });
    const amt = Math.round(Number(amount));
    const fmt = (n) => `UGX ${Number(n).toLocaleString('en-UG')}`;

    if (partner.frozen) return fail('FROZEN', 'Withdrawals are paused on your account while we review it. Our team will reach out.');
    if (!partner.payoutNumber) return fail('NO_PAYOUT_NUMBER', 'Add the mobile money number you want to be paid on first.');
    if (partner.payoutNumberChangedAt) {
        const unlockAt = new Date(new Date(partner.payoutNumberChangedAt).getTime() + R.WITHDRAWAL.payoutNumberChangeLockHours * 3600 * 1000);
        if (unlockAt > now) return fail('PAYOUT_NUMBER_LOCK', `You changed your payout number recently. For your safety, withdrawals reopen ${formatEat(unlockAt)}.`);
    }
    const open = history.filter((w) => ['requested', 'in_review', 'approved'].includes(w.status)).length;
    if (open >= R.WITHDRAWAL.openRequestsAtOnce) return fail('OPEN_REQUEST', 'You already have a withdrawal in progress. It must be paid before you request another.');

    if (!Number.isFinite(amt) || amt <= 0) return fail('BAD_AMOUNT', 'Enter an amount to withdraw.');
    if (amt < R.WITHDRAWAL.minAmount) return fail('BELOW_MINIMUM', `The smallest withdrawal is ${fmt(R.WITHDRAWAL.minAmount)}.`);
    if (balances.available < 0) return fail('NEGATIVE_BALANCE', 'A reversed payment is being taken off your balance. Withdrawals reopen once it is back above zero.');
    if (amt > balances.available) return fail('INSUFFICIENT', `You have ${fmt(Math.max(0, balances.available))} available to withdraw.`);

    const everPaid = history.some((w) => w.status === 'paid' || w.status === 'approved');
    if (!everPaid) {
        const ageDays = (now - new Date(partner.joinedAt)) / DAY;
        if (ageDays < R.WITHDRAWAL.firstWithdrawalAfterDays) {
            return fail('FIRST_WITHDRAWAL_TOO_SOON', `Your first withdrawal opens ${R.WITHDRAWAL.firstWithdrawalAfterDays} days after you join. This protects everyone from fake accounts.`);
        }
        if (partner.clearedConversions < R.WITHDRAWAL.firstWithdrawalNeedsClearedConversions) {
            return fail('FIRST_NEEDS_CONVERSION', 'Your first withdrawal opens after your first store has paid and cleared.');
        }
    }

    const startOfEatDay = (d) => { const e = new Date(new Date(d).getTime() + R.EAT_OFFSET_HOURS * 3600 * 1000); e.setUTCHours(0, 0, 0, 0); return e.getTime() - R.EAT_OFFSET_HOURS * 3600 * 1000; };
    const counted = history.filter((w) => !['rejected', 'cancelled'].includes(w.status));
    const todays = counted.filter((w) => startOfEatDay(w.requestedAt) === startOfEatDay(now));
    if (todays.length >= R.WITHDRAWAL.requestsPerDay) return fail('DAILY_REQUEST_LIMIT', 'One withdrawal per day. Try again tomorrow.');

    const last = counted.map((w) => new Date(w.requestedAt).getTime()).sort((a, b) => b - a)[0];
    if (last && (now.getTime() - last) < limits.minGapDays * DAY) {
        const daysLeft = Math.ceil((last + limits.minGapDays * DAY - now.getTime()) / DAY);
        return fail('TOO_SOON', `${limits.label} accounts can withdraw once every ${limits.minGapDays} day${limits.minGapDays === 1 ? '' : 's'}. You can withdraw again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Fewer, larger withdrawals mean NextaStore can keep covering your mobile money fees.`);
    }

    if (amt > limits.perRequestMax) return fail('PER_REQUEST_LIMIT', `${limits.label} accounts can withdraw up to ${fmt(limits.perRequestMax)} at a time.`);
    const todaySum = todays.reduce((s, w) => s + Number(w.amount), 0);
    if (todaySum + amt > limits.dailyMax) return fail('DAILY_LIMIT', `${limits.label} accounts can withdraw up to ${fmt(limits.dailyMax)} a day.`);
    const monthAgo = now.getTime() - 30 * DAY;
    const monthSum = counted.filter((w) => new Date(w.requestedAt).getTime() >= monthAgo).reduce((s, w) => s + Number(w.amount), 0);
    if (monthSum + amt > limits.monthlyMax) return fail('MONTHLY_LIMIT', `${limits.label} accounts can withdraw up to ${fmt(limits.monthlyMax)} in 30 days.`);

    const needsSecondApproval = amt >= R.WITHDRAWAL.secondApprovalFromAmount || (R.WITHDRAWAL.firstWithdrawalAlwaysSecondApproval && !everPaid);
    return { ok: true, needsSecondApproval, limits, amount: amt };
}

/**
 * Separation of duties. The admin who approved the Seller Pass payments behind someone's
 * earnings must not also be the person who releases that person's payout.
 */
function separationOfDutiesOk({ payoutAdminId, recentPaymentApproverIds }) {
    return !recentPaymentApproverIds.includes(payoutAdminId);
}

/** Two-person rule for big or first payouts: approver and payer must differ. */
function twoPersonRuleOk({ approvedBy, paidBy, needsSecondApproval }) {
    if (!needsSecondApproval) return true;
    return !!approvedBy && !!paidBy && approvedBy !== paidBy;
}

// ---- Quality score (0-100) -----------------------------------------------------------------
/**
 * Behaviour, not volume. Fresh partners start at 70 so a brand-new Scout is not punished
 * for having no history.
 */
function qualityScore({ signups, cleared, reversed, flagged, renewed, eligibleForRenewal }) {
    if (!signups || signups < 3) return 70;
    const conversion = Math.min(1, cleared / signups);
    const reversalRate = cleared + reversed > 0 ? reversed / (cleared + reversed) : 0;
    const flagRate = Math.min(1, flagged / signups);
    const renewalRate = eligibleForRenewal > 0 ? renewed / eligibleForRenewal : 0.5;
    const score = 100 * (0.35 * Math.min(1, conversion / 0.4) + 0.25 * (1 - reversalRate) + 0.25 * (1 - flagRate) + 0.15 * renewalRate);
    return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
    generatePartnerCode, normalizeCode, rankFor, effectiveRank, nextRank, commissionForFirstPayment,
    renewalRewardsFor, clearsAtFor, applyUpfrontCap, estimatePayoutFee, formatEat, computeBalances, trustLevel, checkWithdrawal, separationOfDutiesOk,
    twoPersonRuleOk, qualityScore
};
