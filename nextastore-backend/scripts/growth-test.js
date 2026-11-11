/**
 * Growth program tests. No database, no network, no npm install needed:
 *   node growth-program/backend/scripts/growth-test.js
 * Covers the pure logic: working-day clock, commission maths, balances, withdrawal
 * limits, trust, fraud signals and the recruiter-facing stage hints.
 */
const path = require('path');
const G = path.join(__dirname, '..', 'src', 'growth');
const R = require(path.join(G, 'rules.js'));
const C = require(path.join(G, 'commission.js'));
const W = require(path.join(G, 'workingDays.js'));
const K = require(path.join(G, 'risk.js'));
const S = require(path.join(G, 'stages.js'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
    if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// EAT helper: build an instant from a Kampala wall-clock time.
const eat = (iso) => new Date(new Date(`${iso}:00Z`).getTime() - R.EAT_OFFSET_HOURS * 3600 * 1000);
const dueText = (iso) => W.formatDueBy(W.payoutDueBy(eat(iso)));

console.log('Working-day clock (EAT)');
// 2026-10-12 is a Monday.
check('Mon 10:00 -> Wed 5:00 pm', dueText('2026-10-12T10:00') === 'Wed 14 Oct, 5:00 pm', dueText('2026-10-12T10:00'));
check('Mon 16:00 (after cut-off) -> Thu 5:00 pm', dueText('2026-10-12T16:00') === 'Thu 15 Oct, 5:00 pm', dueText('2026-10-12T16:00'));
check('Fri 11:00 -> Tue 5:00 pm', dueText('2026-10-16T11:00') === 'Tue 20 Oct, 5:00 pm', dueText('2026-10-16T11:00'));
check('Saturday request counts from Monday -> Wed', dueText('2026-10-17T09:00') === 'Wed 21 Oct, 5:00 pm', dueText('2026-10-17T09:00'));
check('Thu 8 Oct: Independence Day (Fri 9 Oct) is skipped -> Tue', dueText('2026-10-08T10:00') === 'Tue 13 Oct, 5:00 pm', dueText('2026-10-08T10:00'));
check('Wed 23 Dec 10:00: Christmas Day (Fri), Sat and Sun skipped -> Mon 28 Dec', dueText('2026-12-23T10:00') === 'Mon 28 Dec, 5:00 pm', dueText('2026-12-23T10:00'));
check('extra holiday from settings is honoured', W.formatDueBy(W.payoutDueBy(eat('2026-10-12T10:00'), ['2026-10-13'])) === 'Thu 15 Oct, 5:00 pm');
check('overdue detection', W.isOverdue(W.payoutDueBy(eat('2026-10-12T10:00')), eat('2026-10-14T17:30')) && !W.isOverdue(W.payoutDueBy(eat('2026-10-12T10:00')), eat('2026-10-14T16:59')));

console.log('Codes');
const code = C.generatePartnerCode('crew');
check('code format (new Crew codes start CREW-)', /^CREW-[A-HJKMNP-Z2-9]{5}$/.test(code), code);
check('normalize tolerates spaces and case', C.normalizeCode(' crew 4htr9 ') === 'CREW-4HTR9');
check('codes are understood however they are typed (spaces, case) and kept as stored', C.normalizeCode(' crew 4htr9 ') === 'CREW-4HTR9' && C.normalizeCode('crew-4htr9') === 'CREW-4HTR9' && C.normalizeCode('circle k7m3q') === 'CIRCLE-K7M3Q');
check('normalize rejects look-alike characters (0/O/1/I)', C.normalizeCode('CREW-4HTR0') === null && C.normalizeCode('CIRCLE-K7M3I') === null);
check('normalize rejects junk', C.normalizeCode('hello') === null && C.normalizeCode('') === null);

console.log('Commission');
const pay1 = { amount: 20000, periodMonths: 1 };
const shape = (lines) => lines.map((l) => [l.type, l.amount]);
const circle = C.commissionForFirstPayment('circle', pay1);
check('Circle: 20% of month one = UGX 4,000, nothing else', eq(shape(circle), [['first_payment', 4000]]), JSON.stringify(circle));
const circle12 = C.commissionForFirstPayment('circle', { amount: 240000, periodMonths: 12 });
check('Circle: a 12-month first payment still bases on ONE month, plus the commitment kicker', eq(shape(circle12), [['first_payment', 4000], ['commitment_kicker', 3000]]), JSON.stringify(circle12));
const crewTrail = C.commissionForFirstPayment('crew', pay1, { rank: R.CREW_RANKS[0] });
check('Crew Trailhead: 25% = 5,000 and no live bonus up front (it is paid when the store renews)', eq(shape(crewTrail), [['first_payment', 5000]]), JSON.stringify(crewTrail));
const crewSummit = C.commissionForFirstPayment('crew', { amount: 120000, periodMonths: 6 }, { rank: R.CREW_RANKS[3] });
check('Crew Summit, 6 months up front: 40% of one month + kicker', eq(shape(crewSummit), [['first_payment', 8000], ['commitment_kicker', 5000]]), JSON.stringify(crewSummit));
const boosted = C.commissionForFirstPayment('crew', pay1, { rank: R.CREW_RANKS[0], campaignBoostPercent: 20 });
check('Campaign boost adds 20% of the main commission (+1,000)', boosted.find((l) => l.type === 'campaign_boost')?.amount === 1000, JSON.stringify(boosted));
const capped = C.commissionForFirstPayment('crew', pay1, { rank: R.CREW_RANKS[3], campaignBoostPercent: 25 });
const cappedTotal = capped.reduce((sum, l) => sum + l.amount, 0);
check('MARGIN GUARD: rewards on a first payment never exceed 40% of what the store paid (we keep 60%+)', cappedTotal <= 8000 && cappedTotal === 8000, JSON.stringify(capped));
check('the guard trims the extras first and keeps the main commission', capped.length === 1 && capped[0].type === 'first_payment');
let always = true;
for (const rank of R.CREW_RANKS) for (const months of [1, 2, 3, 6, 12]) for (const boost of [0, 10, 25, 50]) {
    const amount = months * 20000; const lines = C.commissionForFirstPayment('crew', { amount, periodMonths: months }, { rank, campaignBoostPercent: boost });
    if (lines.reduce((sum, l) => sum + l.amount, 0) > amount * R.COMMISSION.maxUpfrontShare) always = false;
}
check('the guard holds for every rank, length and boost combination', always);
check('Discounted payment below one month still pays proportionally', C.commissionForFirstPayment('circle', { amount: 10000, periodMonths: 1 })[0].amount === 2000);
check('Zero / garbage amount earns nothing', C.commissionForFirstPayment('circle', { amount: 0, periodMonths: 1 }).length === 0);
const stay = (program, extra) => C.renewalRewardsFor(program, { previousCoverageEnd: '2026-11-01', approvedAt: '2026-11-10', alreadyPaidRenewal: false, ...extra });
check('Crew member stay bonus (4,000) + stocked-store bonus (2,000) when the shelf still has 3+ products', eq(shape(stay('crew', { liveProducts: 5 })), [['renewal', 4000], ['live_bonus', 2000]]));
check('Crew member with an empty-ish shelf gets only the stay bonus', eq(shape(stay('crew', { liveProducts: 1 })), [['renewal', 4000]]));
check('Circle stay bonus is 3,000 and there is no stocked-store bonus', eq(shape(stay('circle', { liveProducts: 9 })), [['renewal', 3000]]));
check('Stay rewards never twice', stay('crew', { alreadyPaidRenewal: true, liveProducts: 5 }).length === 0);
check('Stay rewards not paid for a very late return', C.renewalRewardsFor('circle', { previousCoverageEnd: '2026-11-01', approvedAt: '2027-01-15', alreadyPaidRenewal: false }).length === 0);
check('No stay rewards without a previous coverage date', C.renewalRewardsFor('crew', { approvedAt: '2026-11-10', alreadyPaidRenewal: false, liveProducts: 5 }).length === 0);

console.log('Mobile money fee (on NextaStore)');
check('payout fee estimate follows the tiers', C.estimatePayoutFee(15000) === 700 && C.estimatePayoutFee(45000) === 1000 && C.estimatePayoutFee(150000) === 2200 && C.estimatePayoutFee(900000) === 3500);
check('zero payout has no fee', C.estimatePayoutFee(0) === 0);
check('the fee is paid by NextaStore, so a partner receives the full amount', R.PAYOUT_FEE.paidBy === 'nextastore');

console.log('Ranks and quality');
check('0 cleared = Trailhead, 5 = Pathfinder, 15 = Trailblazer, 30 = Summit', ['trailhead', 'pathfinder', 'trailblazer', 'summit'].every((k, i) => C.rankFor([0, 5, 15, 30][i]).key === k));
check('promotion blocked while quality is low', C.effectiveRank(16, 40, 'pathfinder').key === 'pathfinder');
check('promotion allowed with healthy quality', C.effectiveRank(16, 80, 'pathfinder').key === 'trailblazer');
check('rank steps down when the 90-day count falls', C.effectiveRank(3, 90, 'trailblazer').key === 'trailhead');
check('next rank countdown', C.nextRank(R.CREW_RANKS[1], 7).remaining === 8);
check('new partner quality starts at 70', C.qualityScore({ signups: 1 }) === 70);
check('great partner scores high', C.qualityScore({ signups: 20, cleared: 12, reversed: 0, flagged: 0, renewed: 8, eligibleForRenewal: 10 }) >= 85);
check('junk-heavy partner scores low', C.qualityScore({ signups: 30, cleared: 1, reversed: 1, flagged: 12, renewed: 0, eligibleForRenewal: 1 }) < 45);

console.log('Balances');
const now = new Date('2026-10-20T10:00:00Z');
const commissions = [
    { amount: 6000, status: 'held', clearsAt: '2026-10-25T00:00:00Z' },   // pending
    { amount: 8000, status: 'held', clearsAt: '2026-10-19T00:00:00Z' },   // clearance passed -> available
    { amount: 12000, status: 'available' },
    { amount: 5000, status: 'voided' },
    { amount: -2000, status: 'available' }                                 // clawback
];
let b = C.computeBalances(commissions, [], now);
check('pending / available split, void ignored, clawback applied', b.pending === 6000 && b.available === 18000, JSON.stringify(b));
b = C.computeBalances(commissions, [{ amount: 10000, status: 'requested' }, { amount: 3000, status: 'paid' }, { amount: 4000, status: 'rejected' }], now);
check('in-flight and paid withdrawals come off available, rejected does not', b.available === 5000 && b.inFlight === 10000 && b.paid === 3000, JSON.stringify(b));

console.log('Trust level');
const joined = (d) => new Date(now.getTime() - d * 86400000);
check('brand new', C.trustLevel({ joinedAt: joined(2), clearedConversions: 0, qualityScore: 70 }, now) === 'new');
check('standard after 14 days and 2 cleared', C.trustLevel({ joinedAt: joined(20), clearedConversions: 2, qualityScore: 70 }, now) === 'standard');
check('trusted needs time, volume, quality and no flags', C.trustLevel({ joinedAt: joined(90), clearedConversions: 12, qualityScore: 80, openFlags: 0 }, now) === 'trusted');
check('an open flag stops trusted', C.trustLevel({ joinedAt: joined(90), clearedConversions: 12, qualityScore: 80, openFlags: 1 }, now) === 'standard');
check('a frozen partner is treated as new', C.trustLevel({ joinedAt: joined(90), clearedConversions: 12, qualityScore: 90, frozen: true }, now) === 'new');

console.log('Withdrawal rules');
const base = () => ({
    partner: { joinedAt: joined(30), frozen: false, payoutNumber: '0772123456', payoutNumberChangedAt: null, trust: 'standard', clearedConversions: 4 },
    amount: 20000, balances: { available: 50000 }, history: [{ amount: 15000, status: 'paid', requestedAt: joined(10) }], now
});
const run = (mut) => { const x = base(); mut(x); return C.checkWithdrawal(x); };
check('a normal request passes without second approval', (() => { const r = run(() => {}); return r.ok && !r.needsSecondApproval; })());
check('below the minimum (UGX 15,000, because fees are on us)', run((x) => { x.amount = 12000; }).code === 'BELOW_MINIMUM');
check('exactly the minimum is fine', run((x) => { x.amount = 15000; }).ok);
check('too soon after the last withdrawal (Standard waits 3 days)', run((x) => { x.history = [{ amount: 15000, status: 'paid', requestedAt: new Date(now.getTime() - 2 * 86400000) }]; }).code === 'TOO_SOON');
check('a New account waits 7 days between withdrawals', run((x) => { x.partner.trust = 'new'; x.amount = 20000; x.history = [{ amount: 15000, status: 'paid', requestedAt: new Date(now.getTime() - 5 * 86400000) }]; }).code === 'TOO_SOON');
check('a Trusted account can withdraw the next day', run((x) => { x.partner.trust = 'trusted'; x.history = [{ amount: 15000, status: 'paid', requestedAt: new Date(now.getTime() - 26 * 3600000) }]; }).ok);
check('cancelled and rejected requests do not trigger the wait', run((x) => { x.history = [{ amount: 15000, status: 'paid', requestedAt: joined(10) }, { amount: 15000, status: 'rejected', requestedAt: new Date(now.getTime() - 3600000 * 30) }]; }).ok);
check('more than available', run((x) => { x.amount = 60000; }).code === 'INSUFFICIENT');
check('no payout number', run((x) => { x.partner.payoutNumber = ''; }).code === 'NO_PAYOUT_NUMBER');
check('frozen partner', run((x) => { x.partner.frozen = true; }).code === 'FROZEN');
check('payout number changed 5 hours ago locks withdrawals', run((x) => { x.partner.payoutNumberChangedAt = new Date(now.getTime() - 5 * 3600 * 1000); }).code === 'PAYOUT_NUMBER_LOCK');
check('payout number changed 3 days ago is fine', run((x) => { x.partner.payoutNumberChangedAt = new Date(now.getTime() - 72 * 3600 * 1000); }).ok);
check('only one open request at a time', run((x) => { x.history.push({ amount: 10000, status: 'requested', requestedAt: joined(1) }); }).code === 'OPEN_REQUEST');
check('negative balance (clawback) blocks', run((x) => { x.balances.available = -500; }).code === 'NEGATIVE_BALANCE');
check('first withdrawal too soon after joining', run((x) => { x.history = []; x.partner.joinedAt = joined(3); }).code === 'FIRST_WITHDRAWAL_TOO_SOON');
check('first withdrawal needs a cleared store', run((x) => { x.history = []; x.partner.clearedConversions = 0; }).code === 'FIRST_NEEDS_CONVERSION');
check('first withdrawal always needs a second approver', (() => { const r = run((x) => { x.history = []; }); return r.ok && r.needsSecondApproval; })());
check('100,000+ needs a second approver', (() => { const r = run((x) => { x.amount = 100000; x.balances.available = 150000; }); return r.ok && r.needsSecondApproval; })());
check('per-request ceiling for New accounts', run((x) => { x.partner.trust = 'new'; x.amount = 60000; x.balances.available = 90000; }).code === 'PER_REQUEST_LIMIT');
check('per-request ceiling for Standard accounts', run((x) => { x.amount = 160000; x.balances.available = 300000; }).code === 'PER_REQUEST_LIMIT');
check('trusted accounts can take more', run((x) => { x.partner.trust = 'trusted'; x.amount = 300000; x.balances.available = 400000; }).ok);
check('monthly ceiling counts the last 30 days', run((x) => { x.partner.trust = 'new'; x.amount = 50000; x.balances.available = 90000; x.history = [{ amount: 120000, status: 'paid', requestedAt: joined(12) }]; }).code === 'MONTHLY_LIMIT');
check('rejected withdrawals do not count against limits', run((x) => { x.partner.trust = 'new'; x.amount = 50000; x.balances.available = 90000; x.history = [{ amount: 120000, status: 'rejected', requestedAt: joined(12) }, { amount: 1, status: 'paid', requestedAt: joined(20) }]; }).ok);
check('one request per day', run((x) => { x.history.push({ amount: 10000, status: 'paid', requestedAt: new Date(now.getTime() - 2 * 3600 * 1000) }); }).code === 'DAILY_REQUEST_LIMIT');

console.log('Separation of duties');
check('payment approver cannot release that partner\'s payout', !C.separationOfDutiesOk({ payoutAdminId: 'a1', recentPaymentApproverIds: ['a1', 'a2'] }));
check('a different admin can', C.separationOfDutiesOk({ payoutAdminId: 'a3', recentPaymentApproverIds: ['a1', 'a2'] }));
check('two-person rule: same admin cannot approve and pay a big payout', !C.twoPersonRuleOk({ approvedBy: 'a1', paidBy: 'a1', needsSecondApproval: true }));
check('two-person rule: different admins pass', C.twoPersonRuleOk({ approvedBy: 'a1', paidBy: 'a2', needsSecondApproval: true }));
check('two-person rule: not required for small payouts', C.twoPersonRuleOk({ approvedBy: 'a1', paidBy: 'a1', needsSecondApproval: false }));

console.log('Fraud signals');
check('email alias of the partner is caught', K.normalizeEmail('J.Doe+shop@Gmail.com') === K.normalizeEmail('jdoe@googlemail.com'));
check('phone formats normalise together', ['0772123456', '+256 772 123 456', '256772123456', '772123456'].every((p) => K.normalizePhone(p) === '256772123456'));
let v = K.evaluate({ partner: { userId: 'u1' }, recruit: { userId: 'u1' } });
check('self-referral blocks', v.decision === 'block' && v.signals[0].code === 'SELF_REFERRAL');
v = K.evaluate({ partner: { email: 'amina@gmail.com' }, recruit: { email: 'a.mina+x@gmail.com' } });
check('same email in disguise blocks', v.decision === 'block');
v = K.evaluate({ partner: { phones: ['0772123456'] }, recruit: { storePhone: '+256772123456' } });
check('store phone equals partner phone blocks', v.decision === 'block');
v = K.evaluate({ partner: { payoutNumber: '0701000111' }, payment: { payerPhone: '0701 000 111' } });
check('partner paying with their own MoMo blocks', v.decision === 'block');
v = K.evaluate({ payment: { referenceUsedByOtherStore: true } });
check('re-used transaction ID blocks', v.decision === 'block');
v = K.evaluate({ history: { partnersSharingPayoutNumber: 2 } });
check('shared payout number blocks', v.decision === 'block');
v = K.evaluate({ partner: { signupIpPrefix: '41.210.1' }, recruit: { signupIpPrefix: '41.210.1', email: 'x@gmail.com' } });
check('same network alone sends it to review, not block', v.decision === 'review' && v.score === 35);
v = K.evaluate({ recruit: { email: 'z@mailinator.com' }, history: { signupsLastHour: 6 } });
check('throw-away email + burst = review', v.decision === 'review');
v = K.evaluate({ partner: { signupIpPrefix: '41.210.1' }, recruit: { signupIpPrefix: '41.210.1', email: 'z@mailinator.com' }, history: { recruitsSameDevice: 3 } });
check('several soft signals together escalate to block', v.decision === 'block', JSON.stringify(v));
v = K.evaluate({ partner: { userId: 'u1', email: 'a@x.com' }, recruit: { userId: 'u2', email: 'b@y.com', storePhone: '0755000111', signupIpPrefix: '102.8.4' }, history: { signupsLastHour: 1, totalSignups: 4, clearedCount: 2 } });
check('an honest conversion is clear', v.decision === 'clear' && v.score === 0);
check('partner auto-freeze rules', K.partnerHealth({ blockedConversions: 2 }).freeze && K.partnerHealth({ clearedCount: 3, reversedCount: 3 }).freeze && !K.partnerHealth({ clearedCount: 9, reversedCount: 1 }).freeze);

console.log('Recruiter follow-up hints');
const hrs = (h) => new Date(now.getTime() - h * 3600 * 1000);
let d = S.describe({ stage: 'payment_pending', paymentSubmittedAt: hrs(5) }, now);
check('fresh payment: calm, nothing to do', !d.needsYou && !d.canAskUs && d.tone === 'good');
d = S.describe({ stage: 'payment_pending', paymentSubmittedAt: hrs(30) }, now);
check('30h pending: flagged as delayed and the Ask-us button unlocks', d.needsYou && d.canAskUs && /longer than we aim/.test(d.reason) && d.priority === 5);
d = S.describe({ stage: 'payment_pending', paymentSubmittedAt: hrs(30), lastAskedAt: hrs(3) }, now);
check('Ask-us button cools down after use', d.needsYou && !d.canAskUs);
d = S.describe({ stage: 'store_live', storeLiveAt: hrs(24), trialEndsAt: new Date(now.getTime() + 36 * 3600 * 1000) }, now);
check('trial ending in 36h is urgent', d.needsYou && d.priority === 10 && /1 day|2 day/.test(d.reason), d.reason);
d = S.describe({ stage: 'signed_up', signedUpAt: new Date(now.getTime() - 4 * 86400000) }, now);
check('signed up 4 days ago, still no store: stuck', d.needsYou && /4 days/.test(d.reason));
d = S.describe({ stage: 'lead', lockExpiresAt: new Date(now.getTime() + 2 * 86400000) }, now);
check('lead lock about to expire is urgent', d.needsYou && /2 days/.test(d.nextStep));
d = S.describe({ stage: 'paid', commissionStatus: 'held', clearsAt: new Date(now.getTime() + 2 * 86400000) }, now);
check('paid + held shows when it clears', /clears in 2 days/.test(d.reason));
const rows = [{ priority: 90 }, { priority: 5 }, { priority: 40 }];
check('sorted most urgent first', eq(S.sortForRecruiter(rows).map((r) => r.priority), [5, 40, 90]));
check('summary counts', S.summarize([{ stage: 'paid', needsYou: false }, { stage: 'payment_pending', needsYou: true }, { stage: 'signed_up', needsYou: true }]).needsYou === 2);

console.log('Program names and descriptors');
check('Circle is labelled "NextaStore Circle" (short "Circle") with the descriptor "Affiliate Program"', R.PROGRAM_LABELS.circle.name === 'NextaStore Circle' && R.PROGRAM_LABELS.circle.short === 'Circle' && R.PROGRAM_LABELS.circle.descriptor === 'Affiliate Program');
check('Crew is labelled "NextaStore Crew" (short "Crew") with the descriptor "Field Team"', R.PROGRAM_LABELS.crew.name === 'NextaStore Crew' && R.PROGRAM_LABELS.crew.short === 'Crew' && R.PROGRAM_LABELS.crew.descriptor === 'Field Team' && R.PROGRAM_LABELS.crew.member === 'Crew member');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
