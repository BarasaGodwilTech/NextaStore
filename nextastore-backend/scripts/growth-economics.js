/**
 * What does the program cost NextaStore, and what do we keep?
 *   node growth-program/backend/scripts/growth-economics.js
 *
 * Reads rules.js, so change a rate there, run this, and see the effect before you ship it.
 * Prints: (1) what a partner earns per store in each scenario, (2) that as a share of the
 * revenue the store brings, (3) the mobile money fee we absorb, (4) the break-even.
 *
 * Revenue is Seller Pass payments only. It ignores what a store is worth beyond that and any
 * cost of serving it, so treat "we keep" as revenue kept, not profit.
 */
const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'growth', 'rules.js'));
const C = require(path.join(__dirname, '..', 'src', 'growth', 'commission.js'));

const month = R.PASS_PRICE_PER_MONTH_UGX;
const ugx = (n) => Number(n).toLocaleString('en-UG').padStart(8);
const pct = (n) => `${(n * 100).toFixed(0)}%`.padStart(4);

/** Everything a partner earns from one store: first payment, then (optionally) a renewal. */
function perStore(program, rank, { firstMonths, renews, stocked = true }) {
    const first = firstMonths * month;
    const lines = C.commissionForFirstPayment(program, { amount: first, periodMonths: firstMonths }, { rank });
    const upfront = lines.reduce((s, l) => s + l.amount, 0);
    const renewal = renews
        ? C.renewalRewardsFor(program, { previousCoverageEnd: new Date('2026-12-01'), approvedAt: new Date('2026-12-02'), alreadyPaidRenewal: false, liveProducts: stocked ? 3 : 0 }).reduce((s, l) => s + l.amount, 0)
        : 0;
    return { upfront, renewal, reward: upfront + renewal, revenue: first + (renews ? month : 0), first };
}

const scenarios = [
    { label: '1 month, never returns', firstMonths: 1, renews: false },
    { label: '1 month, then renews', firstMonths: 1, renews: true },
    { label: '6 months up front', firstMonths: 6, renews: false },
    { label: '12 months up front', firstMonths: 12, renews: false }
];
const partners = [
    { name: 'Circle member', program: 'circle', rank: null },
    ...R.CREW_RANKS.map((r) => ({ name: `Crew ${r.label}`, program: 'crew', rank: r }))
];

console.log(`Seller Pass: UGX ${month.toLocaleString('en-UG')} a month. Reward base: ${R.COMMISSION.baseMonths} month.`);
console.log(`Guard: rewards paid on a first payment never exceed ${pct(R.COMMISSION.maxUpfrontShare).trim()} of what the store paid.\n`);

for (const sc of scenarios) {
    console.log(`== ${sc.label} ==`);
    console.log('Partner'.padEnd(20), 'Reward'.padStart(8), 'Store paid'.padStart(10), 'Reward %'.padStart(9), 'We keep'.padStart(9), 'after fee'.padStart(10));
    for (const p of partners) {
        const s = perStore(p.program, p.rank, sc);
        // Fee is paid per withdrawal. Worst case: the partner cashes out in the smallest allowed chunks.
        const fee = Math.round(s.reward * C.estimatePayoutFee(R.WITHDRAWAL.minAmount) / R.WITHDRAWAL.minAmount);
        const kept = s.revenue - s.reward;
        console.log(p.name.padEnd(20), ugx(s.reward), ugx(s.revenue).padStart(10), pct(s.reward / s.revenue).padStart(9), ugx(kept).padStart(9), ugx(kept - fee).padStart(10));
    }
    console.log('');
}

console.log('== Mobile money fee we absorb (PLANNING ESTIMATE, verify against the MTN / Airtel tariff) ==');
for (const amt of [R.WITHDRAWAL.minAmount, 30000, 60000, 150000, 400000]) {
    const fee = C.estimatePayoutFee(amt);
    console.log(`  payout of UGX ${amt.toLocaleString('en-UG').padStart(7)}  ->  fee ~UGX ${fee.toLocaleString('en-UG').padStart(5)}  (${(fee / amt * 100).toFixed(1)}% of the payout)`);
}

console.log('\n== Break-even (on Seller Pass revenue only) ==');
for (const p of partners) {
    const s = perStore(p.program, p.rank, { firstMonths: 1, renews: false });
    const months = s.reward / month;
    console.log(`  ${p.name.padEnd(20)} a store that pays 1 month leaves ${pct((s.first - s.reward) / s.first).trim()} of that payment; reward is repaid after ${months.toFixed(2)} month(s) of the store's revenue`);
}
