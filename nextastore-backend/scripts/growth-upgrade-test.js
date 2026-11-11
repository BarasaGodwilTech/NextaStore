/**
 * Circle -> Crew upgrade, end to end, with NO database (in-memory stand-in, the REAL service code).
 *   node scripts/growth-upgrade-test.js
 *
 * The thing under test is money: after an approved upgrade, stores that signed up through the Circle link BEFORE it must still be
 * paid as Circle, stores that sign up AFTER it (through the very same old link) must be paid as Crew, and nothing breaks either way.
 */
const path = require('path');
const { createGrowth } = require(path.join(__dirname, '..', 'src', 'growth', 'index.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');

let nowMs = new Date('2026-10-12T07:00:00Z').getTime();
const clock = () => new Date(nowMs);
const advance = (ms) => { nowMs += ms; };
const HOUR = 3600000, DAY = 86400000;
let n = 0; const uid = () => `t${++n}`;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const expectError = async (name, code, fn) => { try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, e.code === code, `got ${e.code || e.message}`); } };

async function main() {
    const prisma = createMemoryPrisma(clock);
    const notes = [];
    const audits = [];
    const growth = createGrowth({ prisma, now: clock, createNotification: async (x) => { notes.push(x); }, recordAdminAudit: async (a) => { audits.push(a); } });
    const { partners, hooks, upgrades, admin } = growth;
    const db = prisma._db;

    const mkUser = (id, name, email, extra = {}) => { const u = { id, name, email, role: 'seller', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock(), ...extra }; db.user.push(u); return u; };
    const mkStore = (id, ownerId, name) => { const s = { id, ownerId, name, district: 'kampala', phoneNumber: '', trialEndsAt: new Date(nowMs + 7 * DAY), subscriptionPaidUntil: null, deletedAt: null, isPublished: true }; db.store.push(s); return s; };
    const pay = (storeId, extra = {}) => { const p = { id: uid(), storeId, amount: 20000, periodMonths: 1, reference: `TX${uid()}`, status: 'pending', submittedAt: clock(), ...extra }; db.subscriptionPayment.push(p); return p; };
    async function recruit(code, label, { approveNow = true } = {}) {
        advance(2 * HOUR);
        const user = mkUser(`u_${label}`, `${label} Owner`, `${label.toLowerCase()}@mail.test`);
        await hooks.onSignup({ user, code, ip: `10.${(++n % 200) + 1}.${n % 250}.9` });
        const store = mkStore(`s_${label}`, user.id, `${label} Shop`); store.phoneNumber = `07${String(10000000 + n * 7919).slice(0, 8)}`;
        await hooks.onStoreCreated({ user, store });
        for (let i = 0; i < 3; i++) db.product.push({ id: uid(), storeId: store.id });
        const p = pay(store.id);
        await hooks.onPaymentSubmitted({ payment: p, store });
        if (approveNow) { p.status = 'approved'; p.reviewedAt = clock(); return { user, store, payment: p, out: await hooks.onPaymentApproved({ payment: p, store, adminId: 'admin1' }) }; }
        return { user, store, payment: p };
    }
    const firstPay = (partnerId, referralId) => db.growthCommission.filter((c) => c.partnerId === partnerId && c.referralId === referralId && c.type === 'first_payment').reduce((s, c) => s + c.amount, 0);
    const refOf = (userId) => db.growthReferral.find((r) => r.recruitUserId === userId);

    // ------------------------------------------------------------------ set up a Circle member with history
    console.log('Circle member with stores before the move');
    const amina = mkUser('u_amina', 'Amina Nakato', 'amina@mail.test');
    const circle = await partners.joinCircle(amina, { phone: '0772123456', agreedTerms: true });
    const oldCode = circle.code;
    check('starts as Circle', circle.program === 'circle' && /^CIRCLE-/.test(oldCode));

    const before = await recruit(oldCode, 'Before');                 // signed up AND paid under Circle
    const pending = await recruit(oldCode, 'Pending', { approveNow: false });   // signed up under Circle, payment still waiting
    check('a referral remembers the program it signed up under', refOf(before.user.id).program === 'circle' && refOf(pending.user.id).program === 'circle');
    const circleRate = firstPay(circle.id, refOf(before.user.id).id);
    check('Circle store paid the Circle rate (20% of 20,000 = 4,000)', circleRate === 4000, String(circleRate));

    // ------------------------------------------------------------------ applying
    console.log('Applying to move up');
    const apply = (u, over = {}) => partners.applyUpgrade(u, { phone: '0701234567', territories: ['kampala'], note: 'I know many traders', kycFileUrl: 'growth-kyc/x.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.1.1.1', ...over });
    await expectError('terms are required', 'TERMS_REQUIRED', () => apply(amina, { agreedTerms: false }));
    await expectError('an ID photo is required', 'KYC_REQUIRED', () => apply(amina, { kycFileUrl: null }));
    await expectError('an area is required', 'TERRITORY_REQUIRED', () => apply(amina, { territories: [] }));
    await expectError('a bad phone is refused', 'BAD_PHONE', () => apply(amina, { phone: '123' }));
    await expectError('an unverified email is refused', 'EMAIL_UNVERIFIED', () => apply({ ...amina, emailVerifiedAt: null }));
    await expectError('someone who never joined Circle cannot "upgrade"', 'NOT_A_PARTNER', () => apply(mkUser('u_x', 'X Person', 'x@mail.test')));
    await growth.ctx.getSettings();
    await prisma.growthSettings.update({ where: { id: 'singleton' }, data: { crewOpen: false } });
    await expectError('closed Crew applications refuse an upgrade request', 'PROGRAM_CLOSED', () => apply(amina));
    await prisma.growthSettings.update({ where: { id: 'singleton' }, data: { crewOpen: true } });

    const el0 = await partners.eligibility(amina, 'crew');
    check('a Circle member looking at Crew is offered an upgrade, not told they are in the wrong program', el0.mode === 'upgrade' && el0.canJoin && !el0.blockers.includes('program'));
    check('a brand-new person looking at Crew sees a normal join', (await partners.eligibility(mkUser('u_new', 'New Person', 'new@mail.test'), 'crew')).mode === 'join');
    const elCrewOnCircle = await partners.eligibility(mkUser('u_c', 'C Person', 'c@mail.test'), 'circle');
    check('Circle page for a non-member is a plain join', elCrewOnCircle.mode === 'join');

    const sent = await apply(amina);
    check('the request is recorded as applied', sent.status === 'applied');
    await expectError('a second request while one is open is refused', 'UPGRADE_PENDING', () => apply(amina));
    const during = await partners.dashboard(amina);
    check('while waiting: still a working Circle member with the same code', during.partner.program === 'circle' && during.partner.code === oldCode && during.partner.status === 'active');
    check('while waiting: dashboard says pending', during.upgrade.state === 'pending');
    const stillRecruit = await recruit(oldCode, 'During');
    check('while waiting: new sign-ups through the Circle link are still Circle, still paid', refOf(stillRecruit.user.id).program === 'circle' && firstPay(circle.id, refOf(stillRecruit.user.id).id) === 4000);
    check('the member is told it was received', notes.some((x) => x.title === 'Crew application received' && /keeps working/.test(x.body)));

    // ------------------------------------------------------------------ declined first: nothing changes
    console.log('A declined request changes nothing');
    const queue = await upgrades.list({});
    check('it is on the admin waiting list with vetting facts', queue.length === 1 && queue[0].hasKyc && queue[0].circle.paidStores === 2 && queue[0].signals.duplicatePhone === false, JSON.stringify(queue[0] && queue[0].circle));
    await expectError('declining needs a reason', 'REASON_REQUIRED', () => upgrades.decline('adminA', queue[0].id, 'no'));
    await upgrades.decline('adminA', queue[0].id, 'We need a clearer ID photo, please try again.');
    const afterDecline = await partners.dashboard(amina);
    check('after a decline: still Circle, same code, still active', afterDecline.partner.program === 'circle' && afterDecline.partner.code === oldCode && afterDecline.partner.status === 'active');
    check('after a decline: they are told when they can ask again', afterDecline.upgrade.state === 'declined' && !!afterDecline.upgrade.canReapplyAt && afterDecline.upgrade.reason.includes('ID photo'));
    await expectError('cannot ask again straight away', 'UPGRADE_COOLDOWN', () => apply(amina));
    await expectError('a handled request cannot be handled again', 'ALREADY_HANDLED', () => upgrades.decline('adminA', queue[0].id, 'again please'));
    await expectError('a declined request cannot be approved', 'ALREADY_HANDLED', () => upgrades.approve('adminA', queue[0].id));
    const lateCircle = await recruit(oldCode, 'AfterDecline');
    check('after a decline Circle sign-ups still pay Circle', refOf(lateCircle.user.id).program === 'circle');
    advance(15 * DAY);
    const again = await apply(amina, { note: 'new photo' });
    check('after the waiting period they can ask again', again.status === 'applied');

    // ------------------------------------------------------------------ approving
    console.log('Approval');
    const q2 = (await upgrades.list({}))[0];
    // duplicate phone is caught
    const other = (await partners.joinCircle(mkUser('u_o', 'Other Person', 'o@mail.test'), { phone: '0701234567', agreedTerms: true }));
    await expectError('a phone already used by another partner blocks approval', 'DUPLICATE_PHONE', () => upgrades.approve('adminA', q2.id));
    db.growthPartner.find((p) => p.id === other.id).phone = '0799999999';
    // frozen blocks it
    db.growthPartner.find((p) => p.id === circle.id).status = 'frozen';
    await expectError('a frozen Circle account cannot be moved up', 'NOT_IN_GOOD_STANDING', () => upgrades.approve('adminA', q2.id));
    db.growthPartner.find((p) => p.id === circle.id).status = 'active';

    const balanceBefore = (await partners.dashboard(amina)).balances;
    const done = await upgrades.approve('adminA', q2.id);
    check('approval issues a new Crew code', /^CREW-/.test(done.newCode) && done.oldCode === oldCode);
    const row = db.growthPartner.find((p) => p.id === circle.id);
    check('same partner row, now Crew, new code, old code kept', row.program === 'crew' && row.code === done.newCode && row.previousCodes.includes(oldCode) && row.upgradedFrom === 'circle' && row.rankKey === 'trailhead');
    check('area, phone and ID came from the request', row.territories.join() === 'kampala' && row.phone === '256701234567' && row.kycFileUrl === 'growth-kyc/x.jpg', row.phone);
    const balanceAfter = (await partners.dashboard(amina)).balances;
    check('money is untouched by the move (balance, pending, paid identical)', JSON.stringify(balanceBefore) === JSON.stringify(balanceAfter));
    check('the member is told, and told the old link still works', notes.some((x) => /Crew/.test(x.title) && /old Circle code and link still work/.test(x.body)));
    await expectError('approving twice is refused', 'ALREADY_HANDLED', () => upgrades.approve('adminA', q2.id));

    // ------------------------------------------------------------------ links: the old one keeps working
    console.log('Links and codes');
    check('the old Circle code still resolves to the same person', (await partners.findByCode(oldCode)).id === circle.id);
    check('the new Crew code resolves too', (await partners.findByCode(done.newCode)).id === circle.id);
    check('an unknown code resolves to nobody', (await partners.findByCode('CIRCLE-ZZZZZ')) === null);
    const viaOld = await recruit(oldCode, 'ViaOldLink', { approveNow: false });
    const viaNew = await recruit(done.newCode, 'ViaNewLink', { approveNow: false });
    check('a sign-up through the OLD link after approval counts as Crew', refOf(viaOld.user.id).program === 'crew' && refOf(viaOld.user.id).partnerId === circle.id);
    check('a sign-up through the NEW link counts as Crew', refOf(viaNew.user.id).program === 'crew');
    // a person who arrives with a typed lowercase / spaced old code
    const typed = mkUser('u_typed', 'Typed Owner', 'typed@mail.test');
    const r = await hooks.onSignup({ user: typed, code: oldCode.toLowerCase().replace('-', ' '), ip: '10.9.9.9' });
    check('a typed, lower-case, spaced old code still finds her', r && r.partnerId === circle.id && r.program === 'crew');
    const newPartnerCodeNeverReusesOld = await partners.uniqueCode('circle');
    check('an old code is never handed to someone else', newPartnerCodeNeverReusesOld !== oldCode);

    // ------------------------------------------------------------------ the money rule
    console.log('Money: who is paid under which program');
    // the store that signed up under Circle but was still waiting for approval is approved AFTER the move
    pending.payment.status = 'approved'; pending.payment.reviewedAt = clock();
    const outPending = await hooks.onPaymentApproved({ payment: pending.payment, store: pending.store, adminId: 'admin1' });
    check('a store that signed up under Circle but is approved after the move is STILL paid as Circle (4,000, not the Crew 25%)', firstPay(circle.id, refOf(pending.user.id).id) === 4000, String(firstPay(circle.id, refOf(pending.user.id).id)));
    check('...and its program stays Circle', refOf(pending.user.id).program === 'circle');

    viaOld.payment.status = 'approved'; viaOld.payment.reviewedAt = clock();
    await hooks.onPaymentApproved({ payment: viaOld.payment, store: viaOld.store, adminId: 'admin1' });
    check('a store that signed up through the old link after approval is paid as Crew (Trailhead 25% = 5,000)', firstPay(circle.id, refOf(viaOld.user.id).id) === 5000, String(firstPay(circle.id, refOf(viaOld.user.id).id)));
    // renewal bonuses follow the referral's program too
    const prevEnd = new Date(nowMs - 2 * DAY);
    const ren = await hooks.onPaymentApproved({ payment: { ...pay(before.store.id), status: 'approved' }, store: before.store, adminId: 'admin1', previousPaidUntil: prevEnd });
    const renLines = (ren && ren.lines) || [];
    check('a renewal from a Circle-era store pays the Circle stay bonus (3,000) and no Crew stocked bonus', renLines.some((l) => l.type === 'renewal' && l.amount === 3000) && !renLines.some((l) => l.type === 'live_bonus'), JSON.stringify(renLines));
    // campaigns for one program apply to the referral's program, not the member's current one
    db.growthCampaign.push({ id: 'c1', title: 'Circle boost', program: 'circle', district: '', boostPercent: 50, startsAt: new Date(nowMs - DAY), endsAt: new Date(nowMs + DAY), isActive: true });
    const lateOld = await recruit(oldCode, 'CampaignCrew', { approveNow: false });
    lateOld.payment.status = 'approved'; lateOld.payment.reviewedAt = clock();
    await hooks.onPaymentApproved({ payment: lateOld.payment, store: lateOld.store, adminId: 'admin1' });
    check('a Circle-only campaign does not boost a Crew-era sign-up', !db.growthCommission.some((c) => c.referralId === refOf(lateOld.user.id).id && c.type === 'campaign_boost'));

    // ------------------------------------------------------------------ dashboard + ranks
    console.log('Dashboard and rank');
    const dash = await partners.dashboard(amina);
    check('dashboard now shows Crew', dash.partner.program === 'crew' && dash.partner.programName.includes('Crew'));
    check('dashboard says she was upgraded and lists the old code', dash.upgrade.state === 'upgraded' && dash.upgrade.previousCodes.includes(oldCode));
    check('Crew rank starts at the bottom', dash.rank.key === 'trailhead');
    check('the Crew rank counts only the 2 Crew-era stores that paid, not the Circle-era ones', dash.rank.cleared90d === 2, String(dash.rank.cleared90d));
    const pendingRecruit = dash.recruits.find((x) => x.id === refOf(before.user.id).id);
    check('Circle-era recruits stay in the list', !!pendingRecruit);

    // ------------------------------------------------------------------ the member can leave Crew path / misc
    console.log('Edge cases');
    await expectError('a Crew member cannot "upgrade" again', 'ALREADY_CREW', () => apply(amina));
    const direct = mkUser('u_direct', 'Direct Crew', 'direct@mail.test');
    const crewDirect = await partners.applyCrew(direct, { phone: '0711111111', territories: ['jinja'], kycFileUrl: 'x.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true });
    check('a direct Crew application still works as before', crewDirect.status === 'applied' && crewDirect.program === 'crew');
    await expectError('a Crew applicant cannot be pushed through the upgrade path', 'ALREADY_CREW', () => apply(direct));
    const elDirect = await partners.eligibility(direct, 'circle');
    check('a Crew member looking at Circle is still told one program at a time', elDirect.blockers.includes('program'));

    // withdraw
    const w = mkUser('u_w', 'Wendy Circle', 'w@mail.test'); await partners.joinCircle(w, { phone: '0788888888', agreedTerms: true });
    await apply(w, { phone: '0788888888' });
    const wOpen = (await upgrades.list({})).find((x) => x.displayName === 'Wendy Circle');
    check('the phone she used is her own, so it is not a duplicate', wOpen && !wOpen.signals.duplicatePhone);
    await partners.withdrawUpgrade(w);
    check('withdrawing closes the request and Circle is untouched', (await partners.dashboard(w)).partner.program === 'circle' && (await partners.dashboard(w)).upgrade.state !== 'pending');
    await expectError('nothing left to withdraw', 'NO_OPEN_UPGRADE', () => partners.withdrawUpgrade(w));
    const re = (await upgrades.list({ status: 'withdrawn' }))[0];
    await upgrades.reopen('adminA', re.id, 'She asked on the phone to be reconsidered.');
    check('an admin can reopen a withdrawn request', (await partners.dashboard(w)).upgrade.state === 'pending');

    // two admins approving at once: one wins
    const z = mkUser('u_z', 'Zed Circle', 'z@mail.test'); await partners.joinCircle(z, { phone: '0766666666', agreedTerms: true });
    await apply(z, { phone: '0766666666' });
    const zq = (await upgrades.list({})).find((x) => x.displayName === 'Zed Circle');
    const results = await Promise.allSettled([upgrades.approve('adminA', zq.id), upgrades.approve('adminB', zq.id)]);
    check('two admins approving together: exactly one succeeds', results.filter((x) => x.status === 'fulfilled').length === 1 && results.filter((x) => x.status === 'rejected').length === 1, JSON.stringify(results.map((x) => x.status)));
    const zp = db.growthPartner.find((p) => p.displayName === 'Zed Circle');
    check('and she was moved exactly once (one old code kept)', zp.program === 'crew' && zp.previousCodes.length === 1);

    // admin economics keep the programs apart
    const eco = await admin.economics();
    check('economics counts Circle-era stores under Circle and Crew-era under Crew', eco.lifetime.circle.storesPaid >= 3 && eco.lifetime.crew.storesPaid >= 1, `${eco.lifetime.circle.storesPaid}/${eco.lifetime.crew.storesPaid}`);
    check('overview reports open upgrade requests', typeof (await admin.overview()).pendingUpgrades === 'number');
    check('audit trail was written', audits.some((a) => a.action === 'growth.upgrade_approved') && audits.some((a) => a.action === 'growth.upgrade_declined'));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
