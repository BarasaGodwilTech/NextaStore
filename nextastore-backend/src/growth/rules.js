/**
 * Growth program rules: NextaStore Circle (the affiliate program) and NextaStore Crew (the field team).
 * (Internally the field team is still called 'scout': database values, API paths, permission names. Only what people SEE says Crew.)
 *
 * One dependency-free file, same idea as src/platformRules.js: every number the
 * code enforces and every number the docs / Nexi describe lives HERE. Change a
 * value and the service, the routes, the dashboards and the tests all follow.
 *
 * All money is UGX, whole shillings. "Days" are calendar days unless the name
 * says WORKING. Figures marked (PROPOSED) are starting points for the owner to
 * confirm before launch; nothing else in the folder hard-codes them.
 */

const PROGRAMS = Object.freeze({ circle: 'circle', scout: 'scout' });

const PROGRAM_LABELS = {
    circle: { name: 'NextaStore Circle', short: 'Circle', descriptor: 'Affiliate Program', tagline: 'Bring a store into your circle.', member: 'Circle member' },
    scout: { name: 'NextaStore Crew', short: 'Crew', descriptor: 'Field Team', tagline: 'Find the stores worth finding.', member: 'Crew member' }
};

// What a store pays for the Seller Pass. Mirrors src/platformRules.js on purpose;
// when wired in, the service should read the live value from there instead.
const PASS_PRICE_PER_MONTH_UGX = 20000;
const TRIAL_DAYS = 7;   // mirrors platformRules.TRIAL_DAYS; used only for copy shown to invitees

// ---- Attribution: who gets credit for a store -----------------------------------
const ATTRIBUTION = {
    clickWindowDays: 30,        // a ?ref= link stays valid this long in the visitor's browser
    lateClaimDays: 7,           // a new seller may type a code in within this many days of signup...
    lateClaimRequiresNoPayment: true, // ...but only while no payment has been submitted
    qualifyingWindowDays: 60,   // the store's first payment must be APPROVED within this many days of signup
    leadLockDays: 14,           // Scouts: a logged lead is that Scout's alone for this long
    leadLockMaxExtensions: 2,   // each logged follow-up visit extends the lock...
    leadLockExtendDays: 7,      // ...by this many days
    oneReferrerPerStore: true,  // first valid attribution wins, never re-assigned
    singleLevelOnly: true       // NO downlines, NO overrides: you are paid for stores you personally brought
};

// ---- What a successful store is worth ---------------------------------------------
// Design rule: pay LESS up front and MORE once the store has proved it stays.
//   - upfront (first approved payment): a percentage of ONE month, plus the 6-month kicker and any boost
//   - on the first on-time renewal: the stay bonus, and for Scouts a stocked-store bonus
//     (the store still has products on its shelf). Both are only paid for stores that came back.
// A hard guard on top: everything paid on a first payment is capped at maxUpfrontShare of what the
// store actually paid, so NextaStore always keeps the rest, whatever the rank, kicker or boost.
// Figures marked (PROPOSED) are starting points. Run scripts/growth-economics.js after changing them.
const COMMISSION = {
    baseMonths: 1,
    circle: { rate: 0.20, commitmentKicker: 3000, renewalBonus: 3000 },        // (PROPOSED) 20% of month one = UGX 4,000
    // Scout rate rises with rank (see SCOUT_RANKS). The rest are flat.
    scout: { commitmentKicker: 5000, renewalBonus: 4000, liveBonus: 2000 },    // (PROPOSED) liveBonus = stocked-store bonus, paid on renewal
    maxUpfrontShare: 0.40,
    // A first payment covering this many months or more earns the kicker. It matches the
    // 6-month Verified Seller threshold: stores that commit are stores that stay.
    kickerMinMonths: 6,
    // The store's NEXT approved payment must arrive no later than this many days after the
    // previous coverage ended. Paid once per store.
    renewalWithinDays: 45,
    // Stocked-store bonus (Scouts): at least this many products on the shelf when the store renews.
    liveMinProducts: 3
};

// Scouts climb by CLEARED conversions in the last 90 days. Rank changes the commission
// rate only, never the withdrawal limits (those follow trust, see TRUST_LEVELS).
const SCOUT_RANKS = [
    { key: 'trailhead',   label: 'Trailhead',   minCleared90d: 0,  rate: 0.25 },
    { key: 'pathfinder',  label: 'Pathfinder',  minCleared90d: 5,  rate: 0.30 },
    { key: 'trailblazer', label: 'Trailblazer', minCleared90d: 15, rate: 0.35 },
    { key: 'summit',      label: 'Summit',      minCleared90d: 30, rate: 0.40 }
];
const RANK_WINDOW_DAYS = 90;
const RANK_MIN_QUALITY_SCORE = 60; // below this a Scout keeps their rank but cannot be promoted

// ---- When money becomes real --------------------------------------------------------
//   held       approved payment exists, clearance window running (can still be voided)
//   available  cleared: can be withdrawn
//   voided     payment reversed / fraud found before payout
// A clawback is a NEGATIVE entry that pulls a balance down after a payout already happened.
const CLEARANCE = {
    days: 3,                       // (PROPOSED) held this long after the store's payment is approved
    clawbackWindowDays: 30         // a payment reversed within this many days of approval => clawback if already paid
};

// ---- Withdrawals --------------------------------------------------------------------
// Trust decides the ceilings. It is earned by behaviour, not by rank.
// minGapDays = the shortest time between two withdrawals. NextaStore pays the mobile money fee on
// every payout, so fewer, larger payouts cost less; the gap shrinks as an account earns trust.
const TRUST_LEVELS = {
    new:      { label: 'New',      perRequestMax: 50000,  dailyMax: 50000,  monthlyMax: 150000,  minGapDays: 7 },
    standard: { label: 'Standard', perRequestMax: 150000, dailyMax: 200000, monthlyMax: 800000,  minGapDays: 3 },
    trusted:  { label: 'Trusted',  perRequestMax: 400000, dailyMax: 500000, monthlyMax: 2500000, minGapDays: 1 }
};
const TRUST_RULES = {
    // A partner stays "new" until BOTH are true:
    standardAfterDays: 14,
    standardAfterClearedConversions: 2,
    // "trusted" needs ALL of these and zero open fraud flags:
    trustedAfterDays: 60,
    trustedAfterClearedConversions: 10,
    trustedMinQualityScore: 75
};
const WITHDRAWAL = {
    minAmount: 15000,                  // fees are on us, so tiny payouts are not worth the fee
    openRequestsAtOnce: 1,             // one request in flight, always
    requestsPerDay: 1,
    firstWithdrawalAfterDays: 7,       // days since joining
    firstWithdrawalNeedsClearedConversions: 1,
    payoutNumberChangeLockHours: 48,   // any change of payout number freezes withdrawals this long
    secondApprovalFromAmount: 100000,  // at or above this a second, different admin must release it
    firstWithdrawalAlwaysSecondApproval: true,
    // The promise to the partner: paid within 2 WORKING days of the request.
    payWithinWorkingDays: 2,
    dailyCutoffHourEAT: 15,            // requests after 15:00 EAT start counting from the next working day
    payByHourEAT: 17,                  // "due by" is 17:00 EAT on the target working day
    networks: ['mtnMomo', 'airtelMoney']
};

// NextaStore pays the mobile money fee: the partner receives the FULL amount they withdrew.
// The table below is a PLANNING ESTIMATE ONLY, not the tariff. The real fee depends on the network
// and the amount: check mtn.co.ug/tariffs/mobile-money-tariffs and airtel.co.ug/airtelmoney/transaction_fees,
// then correct these numbers. The admin also records the ACTUAL fee on every payout, and the
// Economics tab shows real cost, so the estimate only matters for planning.
const PAYOUT_FEE = {
    paidBy: 'nextastore',
    isEstimate: true,
    tiers: [ { upTo: 30000, fee: 700 }, { upTo: 60000, fee: 1000 }, { upTo: 125000, fee: 1500 }, { upTo: 250000, fee: 2200 }, { upTo: Infinity, fee: 3500 } ]
};

// East Africa Time is UTC+3 all year (no daylight saving).
const EAT_OFFSET_HOURS = 3;

// Public holidays that never move (MM-DD), plus movable ones by exact date.
// Eid dates depend on the moon sighting so they are NOT listed here: add them through
// GrowthSettings.extraHolidays the week they are announced.
const FIXED_HOLIDAYS_MMDD = ['01-01', '01-26', '02-16', '03-08', '05-01', '06-03', '06-09', '10-09', '12-25', '12-26'];
const MOVABLE_HOLIDAYS = ['2026-04-03', '2026-04-06', '2027-03-26', '2027-03-29']; // Good Friday + Easter Monday

// ---- Following up on delayed recruits -----------------------------------------------
const FOLLOW_UP = {
    paymentApprovalTargetHours: 24,      // after this, "waiting for approval" becomes "delayed" for the recruiter
    askUsToCheckAfterHours: 24,          // the recruiter's "Ask us to check" button unlocks at this age
    askUsToCheckCooldownHours: 24,       // one ask per referral per day
    stuckSignedUpAfterDays: 3,           // signed up but no live store yet
    stuckLiveAfterDays: 5,               // live store but nothing submitted yet
    trialEndingNudgeDays: 2              // the recruiter hears when a recruit's trial ends within this many days
};

// ---- Signals the risk engine looks at (weights live in risk.js) ----------------------
const RISK = {
    reviewAtScore: 30,   // conversion is held for a human to release
    blockAtScore: 60,    // conversion voided pending investigation, partner frozen
    signupBurstPerHour: 5,
    signupBurstPerDay: 12,
    sameIpRecruitsPer7Days: 3,
    lowConversionMinSignups: 10,
    lowConversionBelow: 0.05,
    reversalRateWarn: 0.20,
    disposableEmailDomains: ['mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com']
};

// ---- Program cost guard (admin Economics tab) -----------------------------------------
// Rewards plus mobile money fees, as a share of the Seller Pass revenue the referred stores brought
// in during the period. The tab turns amber at warnAt and red at alertAt.
const COST_GUARD = { warnAt: 0.30, alertAt: 0.40, windowDays: 30 };

// ---- Field tools -----------------------------------------------------------------------
const FIELD = {
    offlineLeadMaxAgeHours: 48,   // a lead captured offline keeps its claim time if it syncs within this long
    maxOpenLeads: 40,
    leaderboardSize: 5
};

// ---- Scout territories ---------------------------------------------------------------
// Values match Store.district. A territory never blocks a sign-up; it shapes the Trail Map
// and the "gap" suggestions. Leads are protected by the lead lock, not by geography.
const TERRITORIES = { maxPerScout: 3 };

// ---- Partner codes -------------------------------------------------------------------
// Readable, no 0/O/1/I, e.g. CIRCLE-K7M3Q or CREW-4HTR9.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CODE_PREFIX = { circle: 'CIRCLE', scout: 'CREW' };
// Codes issued before the rename started with SCOUT-. They keep working everywhere a code is typed, scanned or linked.
const LEGACY_CODE_PREFIXES = ['SCOUT'];

// ---- Admin permissions this feature adds (see INTEGRATION_GUIDE) -----------------------
const GROWTH_PERMISSIONS = Object.freeze({
    VIEW: 'growth.view',           // read dashboards, partners, referrals
    REVIEW: 'growth.review',       // approve Scouts, release/void flagged conversions, freeze partners
    PAYOUTS: 'growth.payouts',     // approve and mark withdrawals paid
    SETTINGS: 'growth.settings'    // campaigns, holidays, pause the programs
});

module.exports = {
    PROGRAMS, PROGRAM_LABELS, PASS_PRICE_PER_MONTH_UGX, TRIAL_DAYS, ATTRIBUTION, COMMISSION, SCOUT_RANKS, RANK_WINDOW_DAYS,
    RANK_MIN_QUALITY_SCORE, CLEARANCE, TRUST_LEVELS, TRUST_RULES, WITHDRAWAL, PAYOUT_FEE, EAT_OFFSET_HOURS,
    FIXED_HOLIDAYS_MMDD, MOVABLE_HOLIDAYS, FOLLOW_UP, RISK, COST_GUARD, FIELD, TERRITORIES, CODE_ALPHABET, CODE_LENGTH,
    CODE_PREFIX, LEGACY_CODE_PREFIXES, GROWTH_PERMISSIONS
};
