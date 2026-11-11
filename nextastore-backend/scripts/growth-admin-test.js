/**
 * WIP 113: the admin operating kit, driven through the REAL service code on the in-memory database (no Postgres, no browser).
 * Run:  node scripts/growth-admin-test.js
 */
'use strict';
const path = require('path');
const { createGrowth } = require(path.join(__dirname, '..', 'src', 'growth', 'index.js'));
const I = require(path.join(__dirname, '..', 'src', 'growth', 'insights.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');

let nowMs = new Date('2026-10-12T07:00:00Z').getTime();
const clock = () => new Date(nowMs);
const DAY = 86400000, HOUR = 3600000;
let passed = 0, failed = 0, n = 0;
const check = (name, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + name); } else { failed += 1; console.log('  FAIL ' + name + (x ? ' -> ' + x : '')); } };
const fails = async (name, code, fn) => { try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, !code || e.code === code, `got ${e.code || e.message}`); } };

(async () => {
    const prisma = createMemoryPrisma(clock);
    const audits = [], notes = [];
    const growth = createGrowth({ prisma, now: clock, createNotification: async (x) => { notes.push(x); }, recordAdminAudit: async (a) => { audits.push(a); prisma._db.adminAuditLog = prisma._db.adminAuditLog || []; } });
    const { partners, admin } = growth;
    const db = prisma._db;
    const mkUser = (id, name, email, extra = {}) => { const u = { id, name, email, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock(), ...extra }; db.user.push(u); return u; };

    console.log('Join layers (eligibility)');
    const ann = mkUser('u_ann', 'Ann Circle', 'ann@gmail.test');
    let e = await partners.eligibility(ann, 'circle');
    check('a verified, free account can join Circle', e.canJoin && e.blockers.length === 0 && e.steps.join() === 'account,email,agree');
    const unv = mkUser('u_unv', 'Una Unverified', 'una@gmail.test', { emailVerifiedAt: null });
    e = await partners.eligibility(unv, 'crew');
    check('an unverified email is a named blocker with a fix', !e.canJoin && e.blockers.join() === 'email' && /verification email/.test(e.checks.find((c) => c.id === 'email').fix));
    check('Crew has a review step and says how long it takes', e.steps.includes('review') && e.reviewWorkingDays === 2);
    const adm = mkUser('u_adm', 'Admin', 'adm@nextastore.test', { role: 'admin' });
    check('an admin account is blocked from joining', (await partners.eligibility(adm, 'circle')).blockers.includes('account'));
    await partners.joinCircle(ann, { phone: '0772000111', agreedTerms: true, ip: '10.1.1.1' });
    e = await partners.eligibility(ann, 'circle');
    check('a member sees themselves as already in', !e.canJoin && e.existing && e.existing.sameProgram);
    e = await partners.eligibility(ann, 'crew');
    // Changed on purpose (WIP 115): a Circle member looking at Crew is offered the UPGRADE path, not turned away as "wrong program".
    // The reverse (a Crew member looking at Circle) is still blocked: see growth-upgrade-test.js.
    check('a Circle member looking at Crew is offered an upgrade, and is not shown as already in Crew', e.mode === 'upgrade' && e.canJoin && !e.blockers.includes('program') && e.existing.sameProgram === false);

    console.log('\nMembers, segments, search');
    const mk = async (i, program, extra = {}) => {
        const u = mkUser(`u${i}`, `Person ${i}`, `p${i}@gmail.test`);
        if (program === 'circle') return { u, p: await partners.joinCircle(u, { phone: `07720001${String(i).padStart(2, '0')}`, agreedTerms: true, ip: `10.${i}.0.1` }) };
        const p = await partners.applyCrew(u, { phone: `07540001${String(i).padStart(2, '0')}`, territories: ['kampala'], kycFileUrl: `private/${i}.jpg`, cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: `10.${i}.0.2` });
        return { u, p };
    };
    const c1 = await mk(1, 'circle'), c2 = await mk(2, 'circle'), s1 = await mk(3, 'crew'), s2 = await mk(4, 'crew');
    await admin.approveCrew('admin1', s1.p.id);
    let seg = await admin.segments();
    check('Circle and Crew are counted apart', seg.circle.active === 3 && seg.crew.active === 1 && seg.crew.applied === 1);
    check('the oldest waiting application is measured in hours', seg.crew.oldestApplicationHours !== null && seg.crew.oldestApplicationHours >= 0);
    let m = await admin.members({ program: 'crew' });
    check('the member list can show Crew only', m.total === 2 && m.rows.every((r) => r.program === 'crew'));
    m = await admin.members({ program: 'circle', pageSize: 5, page: 1 });
    check('and Circle only, with paging numbers', m.total === 3 && m.page === 1 && m.pages === 1);
    m = await admin.members({ q: 'person 4' });
    check('search finds by name', m.total === 1 && m.rows[0].displayName === 'Person 4', JSON.stringify(m.rows.map((r) => r.displayName)));
    m = await admin.members({ q: c1.p.code });
    check('search finds by code', m.total === 1 && m.rows[0].id === c1.p.id, JSON.stringify([m.total, c1.p.code]));
    m = await admin.members({ status: 'applied' });
    check('filter by status', m.total === 1 && m.rows[0].id === s2.p.id);
    const lk = await admin.lookup('Person 1');
    check('lookup finds the partner behind a name', lk.partners.some((p) => p.id === c1.p.id));
    await fails('lookup refuses a 1-letter search', undefined, () => admin.lookup('a'));

    console.log('\nDiagnose: "why can\'t she withdraw?"');
    let d = await admin.diagnose(c1.p.id);
    check('a new member with no payout number is told exactly that', d.findings.some((f) => f.level === 'block' && /NO_PAYOUT_NUMBER/.test(f.title) && /payout number/.test(f.fix)));
    await partners.setPayout(c1.u, { network: 'mtnMomo', number: '0772000111', name: 'Person One' });
    d = await admin.diagnose(c1.p.id);
    check('after adding one, the payout-number change lock is named', d.findings.some((f) => /PAYOUT_NUMBER_LOCK/.test(f.title)));
    await admin.freeze('admin1', c1.p.id, 'Checking a pattern');
    d = await admin.diagnose(c1.p.id);
    check('a frozen account says so first, with the reason', d.findings[0].level === 'block' && d.findings.some((f) => /frozen/i.test(f.title) && /Checking a pattern/.test(f.detail)));
    d = await admin.diagnose(s2.p.id);
    check('a Crew applicant is told the application is undecided', d.findings.some((f) => /Application not decided/.test(f.title)));
    await fails('diagnose of an unknown id is a clean 404', undefined, () => admin.diagnose('nope'));

    console.log('\nSecurity scan');
    const ids = I.securityFindings({
        partners: [
            { id: 'a', userId: 'ua', displayName: 'A', code: 'CIRCLE-A', status: 'active', payoutNumber: '0772 111 222', phone: '0701000001', signupIpPrefix: '41.1.1' },
            { id: 'b', userId: 'ub', displayName: 'B', code: 'CIRCLE-B', status: 'active', payoutNumber: '+256772111222', phone: '0701000002', signupIpPrefix: '41.1.1' },
            { id: 'c', userId: 'uc', displayName: 'C', code: 'CREW-C', status: 'active', payoutNumber: '0709999999', phone: '0701000001', signupIpPrefix: '41.1.1' },
            { id: 'd', userId: 'ud', displayName: 'D', code: 'CIRCLE-D', status: 'rejected', payoutNumber: '0772111222', phone: '', signupIpPrefix: '' }
        ],
        users: [{ id: 'ua', email: 'a@mailinator.com' }, { id: 'ub', email: 'b@gmail.com' }],
        referrals: [{ partnerId: 'a', storeId: 's1' }], stores: [{ id: 's1', ownerId: 'ua', name: 'A Shop' }],
        withdrawals: [{ partnerId: 'b', status: 'rejected' }, { partnerId: 'b', status: 'rejected' }, { partnerId: 'b', status: 'rejected' }]
    });
    const codes = ids.map((f) => f.code);
    check('two partners paid to one number (written two different ways) are caught', codes.includes('shared_payout_number') && ids.find((f) => f.code === 'shared_payout_number').partnerIds.sort().join() === 'a,b');
    check('a rejected application does not count as a duplicate', !ids.find((f) => f.code === 'shared_payout_number').partnerIds.includes('d'));
    check('a shared registered phone is caught', codes.includes('shared_phone'));
    check('a partner who owns a store they are credited for is caught', codes.includes('self_referral') && ids.find((f) => f.code === 'self_referral').severity === 'high');
    check('three partners from one network are a cluster', codes.includes('same_network_cluster'));
    check('a throwaway email is caught', codes.includes('disposable_email'));
    check('repeated rejected payouts are caught', codes.includes('repeated_rejected_payouts'));
    check('findings are ordered most serious first', ['high', 'medium', 'low'].indexOf(ids[0].severity) === 0);
    check('a clean set gives no findings', I.securityFindings({ partners: [{ id: 'x', userId: 'ux', displayName: 'X', code: 'C', status: 'active', payoutNumber: '0772000001', phone: '0772000002' }], users: [{ id: 'ux', email: 'x@gmail.com' }] }).length === 0);
    const scan = await admin.securityScan();
    check('the live scan runs over the database and names partners', Array.isArray(scan.findings) && scan.partnersScanned >= 4);

    console.log('\nPeople actions');
    await fails('retiring needs a reason', 'REASON_REQUIRED', () => admin.retire('admin1', s1.p.id, ''));
    const r = await admin.retire('admin1', s1.p.id, 'Left the program at her own request');
    check('retire works, keeps history, and tells the admin about any balance', r.ok && db.growthPartner.find((p) => p.id === s1.p.id).status === 'retired');
    await fails('a retired member cannot be retired twice', undefined, () => admin.retire('admin1', s1.p.id, 'again please'));
    await admin.rejectCrew('admin1', s2.p.id, 'We could not read your ID photo');
    await fails('reopen needs a note', 'REASON_REQUIRED', () => admin.reopenCrew('admin1', s2.p.id, ''));
    await admin.reopenCrew('admin1', s2.p.id, 'ID re-uploaded by phone');
    check('a declined Crew application can be reopened', db.growthPartner.find((p) => p.id === s2.p.id).status === 'applied' && notes.some((x) => /looked at again/.test(x.title)));
    await fails('only a declined application can be reopened', undefined, () => admin.reopenCrew('admin1', c2.p.id, 'not a crew member'));
    await admin.addNote('admin1', c2.p.id, 'Called her, she is fine');
    check('a note lands in the audit trail', audits.some((a) => a.action === 'growth.partner_note' && a.metadata.note === 'Called her, she is fine'));

    console.log('\nMoney corrections (no admin can create withdrawable money alone)');
    await fails('an adjustment needs a real reason', 'REASON_REQUIRED', () => admin.adjust('admin1', c2.p.id, { amount: -1000, reason: 'x' }));
    await fails('and a real amount', undefined, () => admin.adjust('admin1', c2.p.id, { amount: 0, reason: 'nothing to do here' }));
    await fails('and a sane size', 'TOO_LARGE', () => admin.adjust('admin1', c2.p.id, { amount: 500000, reason: 'a very large gift to someone' }));
    const credit = await admin.adjust('admin1', c2.p.id, { amount: 5000, reason: 'Goodwill after a delayed payment' });
    check('a credit is NOT applied at once: it waits for a second admin', !credit.applied && db.growthCommission.find((c) => c.id === credit.id).status === 'review');
    await fails('the admin who made it cannot release it', 'SEPARATION_OF_DUTIES', () => admin.releaseCommission('admin1', credit.id));
    await admin.releaseCommission('admin2', credit.id);
    check('a different admin can', db.growthCommission.find((c) => c.id === credit.id).status === 'held');
    const debit = await admin.adjust('admin1', c2.p.id, { amount: -2000, reason: 'Duplicate credit from last week' });
    check('a deduction applies at once (it can only reduce what she can take)', debit.applied && db.growthCommission.find((c) => c.id === debit.id).status === 'available' && db.growthCommission.find((c) => c.id === debit.id).amount === -2000);
    check('both are in the audit trail', audits.some((a) => a.action === 'growth.adjustment_credit_pending') && audits.some((a) => a.action === 'growth.adjustment_debit'));

    console.log('\nBulk actions');
    const bulk = await admin.bulk('admin1', 'freeze', [c1.p.id, c2.p.id, 'missing'], 'Pattern under review');
    check('bulk reports each one separately: the missing id fails, the others do not stop', bulk.results.length === 3 && bulk.done >= 1 && bulk.results.find((x) => x.id === 'missing').ok === false);
    await fails('an unknown bulk action is refused', undefined, () => admin.bulk('admin1', 'delete_everything', [c1.p.id]));
    await fails('an empty selection is refused', undefined, () => admin.bulk('admin1', 'freeze', [], 'x'));

    console.log('\nExports');
    const csv = I.toCsv([{ a: '=HYPERLINK("http://evil")', b: 'Normal, with comma', c: -5, d: '@cmd', e: 'He said "hi"' }], [{ label: 'A', value: (r) => r.a }, { label: 'B', value: (r) => r.b }, { label: 'C', value: (r) => r.c }, { label: 'D', value: (r) => r.d }, { label: 'E', value: (r) => r.e }]);
    check('a cell that starts like a formula is neutralised', csv.includes("'=HYPERLINK") && csv.includes("'@cmd"));
    check('commas and quotes are escaped, negative numbers stay numbers', csv.includes('"Normal, with comma"') && csv.includes('"He said ""hi"""') && csv.includes(',-5,'));
    const out = await admin.exportCsv('admin1', 'partners', { program: 'circle' });
    check('the partners export has a header, only the chosen program, and a dated name', out.csv.startsWith('Code,Name,Program') && out.rows === 3 && /^nextastore-growth-partners-2026-10-12\.csv$/.test(out.filename));
    check('exports are audited', audits.some((a) => a.action === 'growth.export'));
    check('money exports are marked as needing payout permission', admin.exportKinds().withdrawals === 'payouts' && admin.exportKinds().partners === 'view');
    await fails('an unknown export is refused', undefined, () => admin.exportCsv('admin1', 'passwords'));

    console.log('\nObserved rates');
    const o = I.observedRates({ referrals: [], commissions: [], now: clock() });
    check('with no data the rates are null, not zero, and flagged untrustworthy', o.renewalRate === null && o.reversalRate === null && !o.trustworthy.renewal);
    const refs = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, stage: 'paid', paidAt: new Date(nowMs - 120 * DAY), createdAt: new Date(nowMs - 125 * DAY) }));
    const comm = [...refs.map((r) => ({ type: 'first_payment', status: 'available', referralId: r.id })), ...refs.slice(0, 18).map((r) => ({ type: 'renewal', status: 'available', referralId: r.id }))];
    const o2 = I.observedRates({ referrals: refs, commissions: comm, now: clock() });
    check('renewal rate is measured on stores old enough to have renewed (18 of 30 = 60%)', Math.abs(o2.renewalRate - 0.6) < 1e-9 && o2.trustworthy.renewal && o2.medianDaysToFirstPayment === 5);
    const live = await admin.economicsModel();
    check('the economics model endpoint returns observed rates and fee tiers that can be sent as JSON', JSON.parse(JSON.stringify(live)).feeTiers.length === 5 && live.feeIsEstimate === true);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
