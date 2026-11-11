/**
 * The Circle / Crew money model, in one place the admin screen, the scripts and the tests all share.
 *
 *   perStore(rules, program, rankKey, { months, renews, stocked })  what a partner earns from ONE store, and what NextaStore keeps
 *   project(rules, assumptions)                                      a monthly picture of the whole program from a few inputs
 *
 * `rules` is the public GET /api/growth/rules payload, so the screen needs no private numbers. perStore() is checked against the
 * server's own commission.js for every scenario (scripts/growth-economics-test.js): if the two ever disagree a test fails.
 *
 * What this model does NOT know is what it costs you to serve one store (hosting, support, payment handling) or your admin time.
 * Those are INPUTS, left at zero until you enter them, and the verdict says so instead of pretending to know.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.GrowthEconomics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));

    /** Default fee estimate (the same planning tiers as rules.js PAYOUT_FEE). Replace with the admin's real tariff when known. */
    const DEFAULT_FEE_TIERS = [{ upTo: 30000, fee: 700 }, { upTo: 60000, fee: 1000 }, { upTo: 125000, fee: 1500 }, { upTo: 250000, fee: 2200 }, { upTo: Infinity, fee: 3500 }];
    const feeFor = (amount, tiers = DEFAULT_FEE_TIERS) => (tiers.find((t) => amount <= t.upTo) || tiers[tiers.length - 1]).fee;

    function rewardBase(rules, program, rankKey) {
        const p = rules.programs || {};
        if (program === 'circle') { const c = p.circle || {}; return { first: num(c.firstMonth), kicker: num(c.commitmentKicker), stay: num(c.stayBonus), stocked: 0, label: 'Circle member' }; }
        const s = p.crew || {}, ranks = s.ranks || [];
        const r = ranks.find((x) => x.key === rankKey) || ranks[0] || {};
        return { first: num(r.firstMonth), kicker: num(s.commitmentKicker), stay: num(s.stayBonus), stocked: num(s.stockedBonus), label: `Crew ${r.label || ''}`.trim() };
    }

    /** Everything one store is worth to the partner and to NextaStore, in UGX. */
    function perStore(rules, program, rankKey, { months = 1, renews = false, stocked = true, extraMonths = 0 } = {}) {
        const price = num(rules.passPricePerMonth);
        const b = rewardBase(rules, program, rankKey);
        const firstPaid = months * price;
        let upfront = b.first + (months >= num(rules.kickerMinMonths, 6) ? b.kicker : 0);
        upfront = Math.min(upfront, Math.floor(firstPaid * num(rules.maxUpfrontPercent, 40) / 100));   // the guard: never more than the cap on a first payment
        const renewal = renews ? b.stay + (stocked ? b.stocked : 0) : 0;
        const reward = upfront + renewal;
        const renewalPaid = renews ? price + extraMonths * price : 0;
        const revenue = firstPaid + renewalPaid;
        return { label: b.label, upfront, renewal, reward, firstPaid, revenue, kept: revenue - reward, rewardShare: revenue > 0 ? reward / revenue : null };
    }

    /**
     * A month of new paying stores, start to finish.
     * a = { storesPerMonth, crewShare, rankMix:{key:share}, prepay6Share, renewRate, stockedRate, extraMonthsIfRenewed,
     *       reversalRate, unrecoveredShare, servingCostPerStoreMonth, fixedMonthlyCost, avgWithdrawal, feeTiers }
     */
    function project(rules, a = {}) {
        const A = {
            storesPerMonth: num(a.storesPerMonth, 40), crewShare: clamp01(a.crewShare ?? 0.5), prepay6Share: clamp01(a.prepay6Share ?? 0.1),
            renewRate: clamp01(a.renewRate ?? 0.6), stockedRate: clamp01(a.stockedRate ?? 0.8), extraMonthsIfRenewed: num(a.extraMonthsIfRenewed, 3),
            reversalRate: clamp01(a.reversalRate ?? 0.03), unrecoveredShare: clamp01(a.unrecoveredShare ?? 0.5),
            servingCostPerStoreMonth: num(a.servingCostPerStoreMonth, 0), fixedMonthlyCost: num(a.fixedMonthlyCost, 0), avgWithdrawal: Math.max(1, num(a.avgWithdrawal, 40000)),
            feeTiers: a.feeTiers || DEFAULT_FEE_TIERS
        };
        const ranks = (rules.programs && rules.programs.crew && rules.programs.crew.ranks) || [];
        const mix = {}; let mixSum = 0;
        for (const r of ranks) { mix[r.key] = Math.max(0, num(a.rankMix && a.rankMix[r.key], r.key === ranks[0].key ? 0.6 : 0.4 / Math.max(1, ranks.length - 1))); mixSum += mix[r.key]; }
        for (const k of Object.keys(mix)) mix[k] = mixSum ? mix[k] / mixSum : 0;

        // One program's month of new paying stores. Per store, in expectation:
        //   revenue  = (1 - reversed) x ( first payment + renewRate x (renewed month + extra months) x price )
        //   rewards  = (1 - reversed) x ( upfront + renewRate x (stay bonus + stockedRate x stocked bonus) )
        //   a REVERSED first payment brings no revenue, and the part of its upfront reward that cannot be clawed back is lost.
        const price = num(rules.passPricePerMonth), rr = A.reversalRate;
        const cohort = (program) => {
            const n = A.storesPerMonth * (program === 'crew' ? A.crewShare : 1 - A.crewShare);
            const z = { stores: n, revenue: 0, rewards: 0, fees: 0, serving: 0, reversalLoss: 0, net: 0 };
            if (n <= 0) return z;
            const rankKeys = program === 'crew' ? ranks.map((r) => r.key) : [null];
            for (const k of rankKeys) for (const [months, mShare] of [[1, 1 - A.prepay6Share], [6, A.prepay6Share]]) {
                const w = n * (program === 'crew' ? mix[k] : 1) * mShare; if (w <= 0) continue;
                const base = rewardBase(rules, program, k);
                const one = perStore(rules, program, k, { months, renews: false });
                const renewReward = base.stay + A.stockedRate * base.stocked;
                z.revenue += w * (1 - rr) * (one.firstPaid + A.renewRate * (1 + A.extraMonthsIfRenewed) * price);
                z.rewards += w * (1 - rr) * (one.upfront + A.renewRate * renewReward);
                z.reversalLoss += w * rr * one.upfront * A.unrecoveredShare;
                z.serving += w * (1 - rr) * (months + A.renewRate * (1 + A.extraMonthsIfRenewed)) * A.servingCostPerStoreMonth;
            }
            z.fees = ((z.rewards + z.reversalLoss) / A.avgWithdrawal) * feeFor(A.avgWithdrawal, A.feeTiers);
            z.net = z.revenue - z.rewards - z.fees - z.serving - z.reversalLoss;
            return z;
        };
        const circle = cohort('circle'), crew = cohort('crew');
        const sum = (k) => circle[k] + crew[k];
        const all = { stores: sum('stores'), revenue: sum('revenue'), rewards: sum('rewards'), fees: sum('fees'), serving: sum('serving'), reversalLoss: sum('reversalLoss') };
        all.net = all.revenue - all.rewards - all.fees - all.serving - all.reversalLoss - A.fixedMonthlyCost;
        const cost = all.rewards + all.fees + all.reversalLoss;
        const out = {
            assumptions: A, circle, crew, all,
            costShare: all.revenue > 0 ? cost / all.revenue : null,
            costPerPaidStore: all.stores > 0 ? Math.round((all.rewards + all.fees) / all.stores) : null,
            netPerStore: all.stores > 0 ? Math.round(all.net / all.stores) : null,
            // How much can serving ONE store-month cost before the program stops paying for itself?
            maxServingCostPerStoreMonth: null,
            storesToCoverFixedCost: null
        };
        const servedMonths = all.stores > 0 ? ((1 - rr) * (A.prepay6Share * 6 + (1 - A.prepay6Share) * 1 + A.renewRate * (1 + A.extraMonthsIfRenewed))) * all.stores : 0;
        if (servedMonths > 0) out.maxServingCostPerStoreMonth = Math.max(0, Math.floor((all.revenue - all.rewards - all.fees - all.reversalLoss - A.fixedMonthlyCost) / servedMonths));
        const contribution = all.stores > 0 ? (all.revenue - all.rewards - all.fees - all.serving - all.reversalLoss) / all.stores : 0;
        out.storesToCoverFixedCost = contribution > 0 && A.fixedMonthlyCost > 0 ? Math.ceil(A.fixedMonthlyCost / contribution) : (A.fixedMonthlyCost > 0 ? null : 0);
        out.verdict = verdict(out, rules);
        return out;
    }
    
    /** A plain-words verdict. It never claims more than the inputs justify. */
    function verdict(p, rules) {
        const unknownCosts = p.assumptions.servingCostPerStoreMonth === 0 && p.assumptions.fixedMonthlyCost === 0;
        const share = p.costShare;
        let tone = 'good', headline;
        if (share === null) { tone = 'none'; headline = 'Add some paying stores to see the picture.'; }
        else if (p.all.net < 0) { tone = 'bad'; headline = 'On these inputs the program loses money. Lower the rewards or find out which input is too optimistic.'; }
        else if (share >= 0.4) { tone = 'bad'; headline = 'Rewards and fees take 40% or more of the revenue. That is the red line in the cost guard.'; }
        else if (share >= 0.3) { tone = 'warn'; headline = 'Profitable, but rewards and fees take 30% or more of the revenue. Watch it.'; }
        else headline = 'Each store leaves NextaStore well ahead of what the partner is paid.';
        return { tone, headline, caveat: unknownCosts ? 'Serving cost and fixed cost are still zero here. Enter what a store really costs you to run and what the program costs to manage, then read this again.' : '' };
    }

    return { perStore, project, feeFor, rewardBase, verdict, DEFAULT_FEE_TIERS };
});
