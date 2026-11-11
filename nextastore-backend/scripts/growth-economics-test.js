/**
 * WIP 113: the shared money model (js/growth-economics.js) must agree with the server's own commission.js for every scenario,
 * and its program projection must behave sensibly. No database, no browser.
 * Run:  node scripts/growth-economics-test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(__dirname, '..', 'src', 'growth', 'rules.js'));
const C = require(path.join(__dirname, '..', 'src', 'growth', 'commission.js'));
const E = require(path.join(ROOT, 'js', 'growth-economics.js'));
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };

// the public rules payload, built the way routes.js builds it
const rules = {
    passPricePerMonth: R.PASS_PRICE_PER_MONTH_UGX, kickerMinMonths: R.COMMISSION.kickerMinMonths, maxUpfrontPercent: Math.round(R.COMMISSION.maxUpfrontShare * 100),
    programs: {
        circle: { firstMonth: Math.round(R.PASS_PRICE_PER_MONTH_UGX * R.COMMISSION.baseMonths * R.COMMISSION.circle.rate), commitmentKicker: R.COMMISSION.circle.commitmentKicker, stayBonus: R.COMMISSION.circle.renewalBonus },
        crew: { commitmentKicker: R.COMMISSION.crew.commitmentKicker, stayBonus: R.COMMISSION.crew.renewalBonus, stockedBonus: R.COMMISSION.crew.liveBonus,
            ranks: R.CREW_RANKS.map((r) => ({ key: r.key, label: r.label, firstMonth: Math.round(R.PASS_PRICE_PER_MONTH_UGX * R.COMMISSION.baseMonths * r.rate) })) }
    }
};
const month = R.PASS_PRICE_PER_MONTH_UGX;

console.log('perStore agrees with commission.js');
const partners = [{ program: 'circle', rank: null, key: null }, ...R.CREW_RANKS.map((r) => ({ program: 'crew', rank: r, key: r.key }))];
let mismatches = [];
for (const p of partners) for (const months of [1, 2, 3, 6, 12]) for (const renews of [false, true]) for (const stocked of [true, false]) {
    const first = months * month;
    const up = C.commissionForFirstPayment(p.program, { amount: first, periodMonths: months }, { rank: p.rank }).reduce((s, l) => s + l.amount, 0);
    const rn = renews ? C.renewalRewardsFor(p.program, { previousCoverageEnd: new Date('2026-12-01'), approvedAt: new Date('2026-12-02'), alreadyPaidRenewal: false, liveProducts: stocked ? 3 : 0 }).reduce((s, l) => s + l.amount, 0) : 0;
    const m = E.perStore(rules, p.program, p.key, { months, renews, stocked });
    if (m.upfront !== up || m.renewal !== rn) mismatches.push(`${p.program}/${p.key}/${months}mo/renews=${renews}/stocked=${stocked}: model ${m.upfront}+${m.renewal} vs server ${up}+${rn}`);
}
check(`all ${partners.length * 5 * 4} combinations match the server`, mismatches.length === 0, mismatches.slice(0, 3).join(' | '));
const circle1 = E.perStore(rules, 'circle', null, { months: 1 });
check('a Circle store that pays one month: 4,000 reward, 16,000 kept', circle1.reward === 4000 && circle1.kept === 16000);
check('the upfront guard holds in every scenario (never over the cap of the first payment)', partners.every((p) => [1, 6, 12].every((m) => E.perStore(rules, p.program, p.key, { months: m }).upfront <= Math.floor(m * month * 0.4))));
check('a 6-month prepay earns the kicker, a 5-month one does not', E.perStore(rules, 'circle', null, { months: 6 }).upfront === 7000 && E.perStore(rules, 'circle', null, { months: 5 }).upfront === 4000 || E.perStore(rules, 'circle', null, { months: 5 }).upfront === Math.min(4000, Math.floor(5 * month * 0.4)));
check('a non-stocked Crew renewal skips only the stocked bonus', E.perStore(rules, 'crew', 'summit', { months: 1, renews: true, stocked: false }).renewal === R.COMMISSION.crew.renewalBonus);

console.log('\nThe program projection');
const base = E.project(rules, {});
check('revenue, rewards and fees are all positive for a normal month', base.all.revenue > 0 && base.all.rewards > 0 && base.all.fees > 0);
check('net adds up: revenue - rewards - fees - serving - reversal losses - fixed cost', Math.abs(base.all.net - (base.all.revenue - base.all.rewards - base.all.fees - base.all.serving - base.all.reversalLoss - base.assumptions.fixedMonthlyCost)) < 1e-6);
check('Circle + Crew cohorts add up to the whole', Math.abs(base.circle.revenue + base.crew.revenue - base.all.revenue) < 1e-6 && Math.abs(base.circle.rewards + base.crew.rewards - base.all.rewards) < 1e-6);
check('the program\'s cost share stays under the cost guard on the default assumptions', base.costShare > 0 && base.costShare < R.COST_GUARD.warnAt, String(base.costShare));
const noStores = E.project(rules, { storesPerMonth: 0 });
check('zero stores: no revenue, no nonsense, and the verdict says to add stores', noStores.all.revenue === 0 && noStores.costShare === null && noStores.verdict.tone === 'none');
const pricey = E.project(rules, { servingCostPerStoreMonth: 25000 });
check('if serving a store costs more than it pays, the program is flagged as losing money', pricey.all.net < 0 && pricey.verdict.tone === 'bad');
check('with serving cost entered the "enter your real costs" caveat goes away; with none it is shown', pricey.verdict.caveat === '' && base.verdict.caveat !== '');
const fixed = E.project(rules, { fixedMonthlyCost: 1000000 });
check('a fixed monthly cost says how many stores it takes to cover it', Number.isInteger(fixed.storesToCoverFixedCost) && fixed.storesToCoverFixedCost > 0 && E.project(rules, {}).storesToCoverFixedCost === 0);
check('the break-even serving cost is below the Seller Pass price (otherwise rewards would be free)', base.maxServingCostPerStoreMonth > 0 && base.maxServingCostPerStoreMonth < month);
const heavy = E.project(rules, { crewShare: 1, rankMix: { summit: 1, trailhead: 0, pathfinder: 0, trailblazer: 0 } });
check('an all-Summit Crew costs more per store than the default mix', heavy.costPerPaidStore > base.costPerPaidStore);
check('more reversals cost more', E.project(rules, { reversalRate: 0.2 }).all.net < base.all.net);
check('absurd inputs are clamped, not propagated', Number.isFinite(E.project(rules, { renewRate: 5, crewShare: -3, storesPerMonth: 'abc' }).all.net));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
