/**
 * End-to-end flow test for the growth services, with NO database.
 *   node growth-program/backend/scripts/growth-flow-test.js
 *
 * It swaps Prisma for a tiny in-memory stand-in (scripts/lib/memory-prisma.js) and drives the REAL
 * service code through whole stories: a Circle member earning and withdrawing, a Crew member climbing a
 * rank, fraud attempts being blocked, offline leads, Market Days, the daily digest and the
 * economics view.
 *
 * Honest limit: this proves the logic, not Prisma/Postgres behaviour (partial unique indexes, JSON
 * columns, real transactions). That still needs `migrate deploy` on a copy of the real database.
 */
const path = require('path');
const { createGrowth } = require(path.join(__dirname, '..', 'src', 'growth', 'index.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');

let nowMs = new Date('2026-10-12T07:00:00Z').getTime(); // Monday 10:00 EAT
const clock = () => new Date(nowMs);
const advance = (ms) => { nowMs += ms; };
const HOUR = 3600000, DAY = 86400000;
let n = 0;
const uid = () => `t${++n}`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const expectError = async (name, code, fn) => { try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, e.code === code, `got ${e.code || e.message}`); } };

async function main() {
    const prisma = createMemoryPrisma(clock);
    const notes = [];
    const growth = createGrowth({
        prisma, now: clock,
        createNotification: async (x) => { notes.push(x); prisma._db.notification.push({ id: uid(), createdAt: clock(), ...x }); },
        recordAdminAudit: async () => {}
    });
    const { partners, hooks, leads, withdrawals, admin } = growth;
    const db = prisma._db;

    const mkUser = (id, name, email, extra = {}) => { const u = { id, name, email, role: 'seller', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock(), ...extra }; db.user.push(u); return u; };
    const mkStore = (id, ownerId, name, extra = {}) => { const s = { id, ownerId, name, district: 'kampala', phoneNumber: '', trialEndsAt: new Date(nowMs + 7 * DAY), subscriptionPaidUntil: null, deletedAt: null, isPublished: true, ...extra }; db.store.push(s); return s; };
    const mkProducts = (storeId, count) => { for (let i = 0; i < count; i++) db.product.push({ id: uid(), storeId }); };
    const pay = (storeId, extra = {}) => { const p = { id: uid(), storeId, amount: 20000, periodMonths: 1, reference: `TX${uid()}`, status: 'pending', submittedAt: clock(), ...extra }; db.subscriptionPayment.push(p); return p; };
    const approve = (p) => { p.status = 'approved'; p.reviewedAt = clock(); };
    /** One whole recruit: sign up with a code, create the store, add products, pay, get approved. */
    async function recruit(partner, label, { months = 1, products = 3, district = 'kampala' } = {}) {
        advance(2 * HOUR); // recruits arrive spread out, like real life (and below the "burst" signal)
        const user = mkUser(`u_${label}`, `${label} Owner`, `${label.toLowerCase()}@mail.test`);
        await hooks.onSignup({ user, code: partner.code, ip: `10.${(++n % 200) + 1}.${n % 250}.9` });
        const store = mkStore(`s_${label}`, user.id, `${label} Shop`, { district, phoneNumber: `07${String(10000000 + n * 7919).slice(0, 8)}` });
        await hooks.onStoreCreated({ user, store }); mkProducts(store.id, products);
        const p = pay(store.id, { amount: 20000 * months, periodMonths: months });
        await hooks.onPaymentSubmitted({ payment: p, store });
        approve(p);
        const out = await hooks.onPaymentApproved({ payment: p, store, adminId: 'admin1' });
        return { user, store, payment: p, out };
    }

    // ---------------------------------------------------------------- Circle story
    console.log('Circle: join, invite, recruit pays, earn, clear');
    const amina = mkUser('u_amina', 'Amina Nakato', 'amina@gmail.com');
    await expectError('cannot join without accepting terms', 'TERMS_REQUIRED', () => partners.joinCircle(amina, { agreedTerms: false }));
    await expectError('cannot join with unverified email', 'EMAIL_UNVERIFIED', () => partners.joinCircle({ ...amina, emailVerifiedAt: null }, { agreedTerms: true }));
    const summaryBefore = await partners.summary(amina);
    check('summary for a non-partner invites them to join', summaryBefore.joined === false && summaryBefore.open.circle === true);
    const ap = await partners.joinCircle(amina, { phone: '0772100200', ip: '41.210.1.5', agreedTerms: true });
    check('Circle code issued', /^CIRCLE-[A-Z2-9]{5}$/.test(ap.code));
    await expectError('cannot join twice', 'ALREADY_PARTNER', () => partners.joinCircle(amina, { agreedTerms: true }));

    const joel = mkUser('u_joel', 'Joel Okello', 'joel@yahoo.com');
    const ref1 = await hooks.onSignup({ user: joel, code: ap.code.toLowerCase(), ip: '102.8.4.9' });
    check('sign-up with the code creates a referral (case-insensitive)', ref1 && ref1.stage === 'signed_up' && ref1.partnerId === ap.id);
    const joelStore = mkStore('s_joel', joel.id, 'Joel Electronics', { phoneNumber: '0755111222' });
    await hooks.onStoreCreated({ user: joel, store: joelStore });
    advance(HOUR); await hooks.onStoreLive({ storeId: 's_joel' });
    let dash = await partners.dashboard(amina);
    check('recruiter sees the recruit, no contact details leaked', dash.recruits.length === 1 && dash.recruits[0].name === 'Joel Electronics' && !JSON.stringify(dash).includes('joel@yahoo.com') && !JSON.stringify(dash).includes('0755111222'));
    mkProducts('s_joel', 4);
    const p1 = pay('s_joel'); await hooks.onPaymentSubmitted({ payment: p1, store: joelStore });
    dash = await partners.dashboard(amina);
    check('pending approval is visible and calm at first', dash.recruits[0].stage === 'payment_pending' && !dash.recruits[0].needsYou);

    advance(30 * HOUR);
    dash = await partners.dashboard(amina);
    check('after 30h the recruit is flagged as delayed; recruiter can ask us to check', dash.recruits[0].needsYou && dash.recruits[0].canAskUs && dash.summary.needsYou === 1);
    const ask = await hooks.askUsToCheck({ user: amina, referralId: ref1.id });
    check('"Ask us to check" lands in the admin follow-up list', ask.ok && db.adminFollowUp.length === 1 && /Joel Electronics/.test(db.adminFollowUp[0].title));
    await expectError('cannot spam the button', 'COOLDOWN', () => hooks.askUsToCheck({ user: amina, referralId: ref1.id }));

    console.log('Strategy: Follow-up Radar (daily digest)');
    const swDigest = await hooks.sweep();
    check('the sweep sends ONE "recruits need you" digest for the delayed approval', swDigest.nudged === 1 && notes.filter((x) => x.title === 'Recruits need you today').length === 1);
    await hooks.sweep();
    check('a second sweep the same day does not nag again', notes.filter((x) => x.title === 'Recruits need you today').length === 1);

    approve(p1); await hooks.onPaymentApproved({ payment: p1, store: joelStore, adminId: 'admin1', previousPaidUntil: null });
    const comm = db.growthCommission.filter((c) => c.partnerId === ap.id);
    check('Circle earns 20% of month one = UGX 4,000, held', comm.length === 1 && comm[0].amount === 4000 && comm[0].status === 'held');
    dash = await partners.dashboard(amina);
    check('dashboard: pending 4,000, nothing available yet', dash.balances.pending === 4000 && dash.balances.available === 0);
    await hooks.onPaymentApproved({ payment: p1, store: joelStore, adminId: 'admin1' });
    check('approving the same payment twice does not pay twice', db.growthCommission.filter((c) => c.partnerId === ap.id).length === 1);

    advance(4 * DAY);
    const sw = await hooks.sweep();
    check('sweep releases it after the clearance window', sw.released === 1 && db.growthCommission.find((c) => c.partnerId === ap.id).status === 'available');
    check('partner was told it is ready', notes.some((x) => /ready to withdraw/.test(x.title)));

    await expectError('withdrawal needs a payout number', 'NO_PAYOUT_NUMBER', () => withdrawals.request(amina, 15000));
    await partners.setPayout(amina, { network: 'mtnMomo', number: '0772 100 200', name: 'Amina Nakato' });
    await expectError('just-set payout number locks withdrawals', 'PAYOUT_NUMBER_LOCK', () => withdrawals.request(amina, 15000));
    advance(49 * HOUR);

    const grace = await recruit(ap, 'Grace', { months: 6 });
    const mia = await recruit(ap, 'Mia');
    check('a 6-month first payment earns 4,000 + the 3,000 kicker', grace.out.earned === 7000 && grace.out.lines.length === 2);
    advance(4 * DAY); await hooks.sweep();
    dash = await partners.dashboard(amina);
    check('available is 4,000 + 7,000 + 4,000 = 15,000', dash.balances.available === 15000, JSON.stringify(dash.balances));
    check('dashboard tells the partner NextaStore pays the mobile money fee', dash.withdrawal.feeOnUs === true && dash.withdrawal.min === 15000);

    await expectError('below the 15,000 minimum', 'BELOW_MINIMUM', () => withdrawals.request(amina, 12000));
    await withdrawals.request(amina, 15000);
    const w1 = db.growthWithdrawal[0];
    check('withdrawal recorded with a deadline and a planning fee estimate', w1.amount === 15000 && w1.dueBy instanceof Date && w1.feeEstimate === 700);
    check('first withdrawal needs a second approver', w1.needsSecondApproval === true);
    await expectError('only one open request at a time', 'OPEN_REQUEST', () => withdrawals.request(amina, 15000));
    await expectError('admin who approved the payments behind these earnings cannot release the payout', 'SEPARATION_OF_DUTIES', () => withdrawals.approve('admin1', w1.id));
    await withdrawals.approve('admin2', w1.id);
    await expectError('approver cannot also pay a first payout', 'TWO_PERSON_RULE', () => withdrawals.markPaid('admin2', w1.id, { reference: 'MTN-12345', fee: 700 }));
    await expectError('a negative fee is rejected', 'BAD_FEE', () => withdrawals.markPaid('admin3', w1.id, { reference: 'MTN-12345', fee: -5 }));
    await expectError('a fractional fee is rejected', 'BAD_FEE', () => withdrawals.markPaid('admin3', w1.id, { reference: 'MTN-12345', fee: 12.5 }));
    await withdrawals.markPaid('admin3', w1.id, { reference: 'MTN-12345', fee: 650 });
    check('paid; the REAL fee is stored next to the estimate', db.growthWithdrawal[0].status === 'paid' && db.growthWithdrawal[0].feeActual === 650 && notes.some((x) => /You have been paid/.test(x.title)));
    dash = await partners.dashboard(amina);
    check('available is zero after the payout; the next withdrawal date is shown (New accounts wait 7 days)', dash.balances.available === 0 && dash.balances.paid === 15000 && dash.withdrawal.nextAllowedAt && new Date(dash.withdrawal.nextAllowedAt) > clock());

    console.log('Stay bonus: the store renews');
    const prevEnd = new Date(nowMs + 2 * DAY);
    const p1b = pay('s_joel'); approve(p1b);
    const renewOut = await hooks.onPaymentApproved({ payment: p1b, store: joelStore, adminId: 'admin1', previousPaidUntil: prevEnd });
    check('Circle: first on-time renewal earns the 3,000 stay bonus', renewOut && renewOut.renewal && renewOut.earned === 3000);
    const p1c = pay('s_joel'); approve(p1c);
    check('stay bonus is paid only once per store', (await hooks.onPaymentApproved({ payment: p1c, store: joelStore, adminId: 'admin1', previousPaidUntil: prevEnd })) === null);

    console.log('Economics: is it worth it?');
    let eco = await admin.economics();
    const revenue = [p1, grace.payment, mia.payment, p1b, p1c].reduce((s, p) => s + p.amount, 0);
    check('revenue from referred stores is counted', eco.lifetime.all.revenue === revenue, `${eco.lifetime.all.revenue} vs ${revenue}`);
    check('rewards counted: 4,000 + 7,000 + 4,000 + 3,000 stay = 18,000', eco.lifetime.all.rewards === 18000, String(eco.lifetime.all.rewards));
    check('the REAL fee (650) is used in preference to the estimate (700)', eco.lifetime.all.fees === 650 && eco.fees.actualCount === 1);
    check('cost ratio = (rewards + fees) / revenue and is flagged good', Math.abs(eco.lifetime.all.ratio - (18650 / revenue)) < 1e-9 && eco.lifetime.all.status === 'good', JSON.stringify(eco.lifetime.all));
    check('per-program split: all of it is Circle so far', eco.lifetime.circle.rewards === 18000 && eco.lifetime.crew.rewards === 0);

    // ---------------------------------------------------------------- reversal
    console.log('Reversal: an approved payment turns out bad');
    const nina = await recruit(ap, 'Nina');
    advance(4 * DAY); await hooks.sweep();
    const rv = await hooks.onPaymentReversed({ paymentId: nina.payment.id, adminId: 'admin2', reason: 'MoMo reversed by sender' });
    check('reversal voids the earning', rv.voided === 1);
    check('a reversal opens a flag for the admin', db.growthFlag.some((f) => f.code === 'PAYMENT_REVERSED'));

    // ---------------------------------------------------------------- Fraud
    console.log('Fraud: self-dealing is caught');
    const sam = mkUser('u_sam', 'Sam Kato', 'sam@gmail.com');
    const sp = await partners.joinCircle(sam, { phone: '0701999888', agreedTerms: true });
    await hooks.onSignup({ user: sam, code: sp.code });
    check('using your own code at sign-up is refused and flagged', !(await prisma.growthReferral.findUnique({ where: { recruitUserId: sam.id } })) && db.growthFlag.some((f) => f.code === 'SELF_REFERRAL_ATTEMPT'));
    const sam2 = mkUser('u_sam2', 'Sam Second', 'sam+shop@googlemail.com');
    await hooks.onSignup({ user: sam2, code: sp.code, ip: '41.1.1.1' });
    const sam2Store = mkStore('s_sam2', sam2.id, 'Totally Different Shop', { phoneNumber: '0711222333' }); await hooks.onStoreCreated({ user: sam2, store: sam2Store }); mkProducts('s_sam2', 3);
    const p4 = pay('s_sam2'); await hooks.onPaymentSubmitted({ payment: p4, store: sam2Store });
    const preview = await hooks.previewForPayment(p4.id);
    check('admin preview warns BEFORE approving', preview.referred && preview.decision === 'block' && /email/i.test(preview.reasons.join(' ')));
    const out = await hooks.onPaymentApproved({ payment: p4, store: sam2Store, adminId: 'admin1' });
    check('alias-of-self sign-up earns nothing and is blocked', out.blocked && !db.growthCommission.some((c) => c.partnerId === sp.id));
    check('a hard fraud rule freezes the partner', db.growthPartner.find((p) => p.id === sp.id).status === 'frozen');
    const dashSam = await partners.dashboard(sam);
    check('frozen partner sees a calm message, no accusation', dashSam.partner.frozen && !/fraud/i.test(dashSam.partner.frozenReason));

    const tom = mkUser('u_tom', 'Tom R', 'tom@gmail.com'); const tp = await partners.joinCircle(tom, { phone: '0700123123', agreedTerms: true });
    const t1 = mkUser('u_t1', 'Friend One', 'f1@gmail.com'); await hooks.onSignup({ user: t1, code: tp.code });
    const t1s = mkStore('s_t1', t1.id, 'F1 Shop', { phoneNumber: '0744000001' }); await hooks.onStoreCreated({ user: t1, store: t1s }); mkProducts('s_t1', 2);
    const sharedRef = pay('s_t1', { reference: 'SAMEREF999' }); approve(sharedRef);
    await hooks.onPaymentSubmitted({ payment: sharedRef, store: t1s }); await hooks.onPaymentApproved({ payment: sharedRef, store: t1s, adminId: 'admin1' });
    const t2 = mkUser('u_t2', 'Friend Two', 'f2@gmail.com'); await hooks.onSignup({ user: t2, code: tp.code });
    const t2s = mkStore('s_t2', t2.id, 'F2 Shop', { phoneNumber: '0744000002' }); await hooks.onStoreCreated({ user: t2, store: t2s }); mkProducts('s_t2', 2);
    const dupRef = pay('s_t2', { reference: 'SAMEREF999' });
    await hooks.onPaymentSubmitted({ payment: dupRef, store: t2s });
    const out2 = await hooks.onPaymentApproved({ payment: dupRef, store: t2s, adminId: 'admin1' });
    check('the same MoMo transaction ID on two stores is blocked', out2.blocked && /already used/.test(out2.reasons.join(' ')));

    // ---------------------------------------------------------------- Crew members
    console.log('Crew member: apply, vetting, lead lock, visits');
    const kofi = mkUser('u_kofi', 'Kofi Mensah', 'kofi@gmail.com');
    await expectError('Crew members must upload an ID', 'KYC_REQUIRED', () => partners.applyCrew(kofi, { phone: '0753111000', territories: ['kampala'], agreedTerms: true }));
    const kp = await partners.applyCrew(kofi, { phone: '0753111000', territories: ['kampala', 'wakiso', 'mukono', 'entebbe'], kycFileUrl: 'private/id.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true });
    check('application waits for approval; territories capped at 3', kp.status === 'applied' && kp.territories.length === 3);
    await expectError('cannot log leads before approval', 'NOT_APPROVED', () => leads.logLead(kofi, { business: 'Mama Rose Shop', phone: '0772555111' }));
    await admin.approveCrew('admin1', kp.id);
    let twice = null; try { await admin.approveCrew('admin1', kp.id); } catch (e) { twice = e; }
    check('cannot approve the same application twice', !!twice);

    const lead = await leads.logLead(kofi, { business: 'Mama Rose Shop', contactName: 'Rose', phone: '0772 555 111', district: 'Kampala' });
    check('lead logged with a 14-day lock', lead.lockDays === 14 && lead.offline === false);
    await expectError('same Crew member cannot log it twice', 'YOURS_ALREADY', () => leads.logLead(kofi, { business: 'Mama Rose Shop', phone: '+256772555111' }));
    const op = await (async () => { const u = mkUser('u_kofi2', 'Other Crew member', 'o@gmail.com'); const p = await partners.applyCrew(u, { phone: '0754000999', territories: ['jinja'], kycFileUrl: 'private/id2.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true }); await admin.approveCrew('admin1', p.id); return { user: u, partner: p }; })();
    await expectError('a second Crew member cannot take a locked lead (and is not told who has it)', 'LEAD_TAKEN', () => leads.logLead(op.user, { business: 'Rose Provisions', phone: '0772555111' }));
    await expectError('a Crew member cannot log their own number', 'OWN_NUMBER', () => leads.logLead(kofi, { business: 'My own', phone: '0753111000' }));
    advance(10 * DAY);
    const v1 = await leads.logVisit(kofi, lead.id, { note: 'Showed demo', lat: 0.3136, lng: 32.5811 });
    check('a follow-up visit extends the claim', v1.extended && v1.extensionsLeft === 1, JSON.stringify(v1));

    const rose = mkUser('u_rose', 'Rose N', 'rose@gmail.com');
    const roseStore = mkStore('s_rose', rose.id, 'Mama Rose Shop', { phoneNumber: '+256 772 555 111' });
    await hooks.onStoreCreated({ user: rose, store: roseStore });
    const roseRef = db.growthReferral.find((r) => r.storeId === 's_rose');
    check('a live lead lock wins when the owner signs up without a code', roseRef && roseRef.partnerId === kp.id && roseRef.source === 'lead' && db.growthReferral.filter((r) => r.partnerId === kp.id).length === 1);

    console.log('Strategy: Market Days (campaign boost + board)');
    await expectError('a boost over 50% is refused', undefined, () => admin.createCampaign('admin1', { title: 'Too much', boostPercent: 80, startsAt: clock(), endsAt: new Date(nowMs + DAY) }));
    await admin.createCampaign('admin1', { title: 'Kampala Market Week', description: 'Pay this week', boostPercent: 20, district: 'kampala', startsAt: new Date(nowMs - DAY), endsAt: new Date(nowMs + 3 * DAY) });
    await admin.createCampaign('admin1', { title: 'Circle only weekend', boostPercent: 10, program: 'circle', startsAt: new Date(nowMs - DAY), endsAt: new Date(nowMs + DAY) });
    await admin.createCampaign('admin1', { title: 'Next week', boostPercent: 15, startsAt: new Date(nowMs + 3 * DAY), endsAt: new Date(nowMs + 6 * DAY) });
    await admin.createCampaign('admin1', { title: 'Far away', boostPercent: 15, startsAt: new Date(nowMs + 12 * DAY), endsAt: new Date(nowMs + 14 * DAY) });
    mkProducts('s_rose', 3); advance(DAY);
    const p5 = pay('s_rose'); await hooks.onPaymentSubmitted({ payment: p5, store: roseStore }); approve(p5);
    await hooks.onPaymentApproved({ payment: p5, store: roseStore, adminId: 'admin1' });
    const kc = db.growthCommission.filter((c) => c.partnerId === kp.id);
    check('Trailhead Crew member: 25% (5,000) + campaign boost 20% (1,000), no live bonus yet', eq(kc.map((c) => [c.type, c.amount]).sort(), [['campaign_boost', 1000], ['first_payment', 5000]].sort()), JSON.stringify(kc.map((c) => [c.type, c.amount])));

    const board = await partners.campaigns(kofi);
    check('Crew member sees the live Kampala Market Week and next week\'s, not the Circle-only or far-off ones', eq(board.map((c) => c.title), ['Kampala Market Week', 'Next week']), JSON.stringify(board.map((c) => c.title)));
    const live = board.find((c) => c.live);
    check('the board counts Kofi\'s paid store and ranks him first, by first name only', live.mine === 1 && live.rank === 1 && live.board[0].firstName === 'Kofi' && live.board[0].you === true && live.board.length === 1);
    check('Circle members are not mixed into a Crew member board', !live.board.some((b) => b.firstName === 'Amina'));
    const circleBoard = await partners.campaigns(amina);
    check('the Circle member sees the campaign for everyone and the Circle-only one', circleBoard.some((c) => c.title === 'Circle only weekend') && circleBoard.some((c) => c.title === 'Kampala Market Week'));

    console.log('Stay bonus for Crew members, and rank promotion');
    const roseRenewal = pay('s_rose'); approve(roseRenewal);
    const sr = await hooks.onPaymentApproved({ payment: roseRenewal, store: roseStore, adminId: 'admin1', previousPaidUntil: new Date(nowMs + 2 * DAY) });
    check('Crew member: stay bonus 4,000 + stocked-store bonus 2,000 (3+ products still on the shelf)', sr.earned === 6000 && eq(sr.lines.map((l) => l.type).sort(), ['live_bonus', 'renewal']));
    for (const label of ['K1', 'K2', 'K3', 'K4']) await recruit(kp, label);
    const kAfter = await partners.dashboard(kofi);
    check('five paid stores in 90 days promotes Kofi to Pathfinder (30%)', kAfter.rank.key === 'pathfinder' && kAfter.ratePercent === 30, JSON.stringify(kAfter.rank));
    check('Kofi was told about the promotion', notes.some((x) => /Pathfinder/.test(x.title)));
    const k5 = await recruit(kp, 'K5');
    check('the next store pays the new Pathfinder rate: 30% = 6,000', k5.out.lines.find((l) => l.type === 'first_payment').amount === 6000, JSON.stringify(k5.out));

    console.log('Strategy: Trail Map');
    mkStore('s_w1', 'x', 'Wakiso A', { district: 'wakiso' }); mkStore('s_w2', 'x', 'Wakiso B', { district: 'wakiso' });
    mkStore('s_m1', 'x', 'Mukono A', { district: 'mukono' });
    const trail = await partners.trailMap(kofi);
    const order = trail.districts.map((d) => d.district);
    check('the Trail Map lists the Crew member\'s own areas first, thinnest marketplace first', order.slice(0, 3).join() === 'mukono,wakiso,kampala' && trail.districts.slice(0, 3).every((d) => d.inYourTerritory), order.join());
    const kampala = trail.districts.find((d) => d.district === 'kampala');
    check('it shows the Crew member\'s own footprint in each district', kampala.yours.leads >= 1 && kampala.yours.paid >= 1, JSON.stringify(kampala.yours));
    await expectError('Circle members cannot open the Trail Map', undefined, () => partners.trailMap(amina));

    console.log('Strategy: offline leads');
    const off = await leads.logLead(kofi, { business: 'Quiet Kiosk', phone: '0779000123', district: 'kampala', capturedAt: new Date(nowMs - 5 * HOUR).toISOString() });
    const offRow = db.growthReferral.find((r) => r.id === off.id);
    check('a lead captured 5 hours ago offline keeps that time and is marked offline', off.offline === true && offRow.capturedOffline === true && Math.abs(new Date(offRow.createdAt).getTime() - (nowMs - 5 * HOUR)) < 1000);
    check('its 14-day lock counts from the capture time, not the sync time', Math.abs(new Date(offRow.leadLockExpiresAt).getTime() - (nowMs - 5 * HOUR + 14 * DAY)) < 1000);
    const stale = await leads.logLead(kofi, { business: 'Old Capture', phone: '0779000124', capturedAt: new Date(nowMs - 80 * HOUR).toISOString() });
    check('a capture older than 48 hours counts from now (no backdating)', stale.offline === false && Math.abs(new Date(db.growthReferral.find((r) => r.id === stale.id).createdAt).getTime() - nowMs) < 1000);
    const future = await leads.logLead(kofi, { business: 'Future Capture', phone: '0779000125', capturedAt: new Date(nowMs + 5 * HOUR).toISOString() });
    check('a capture time in the future is ignored', future.offline === false && Math.abs(new Date(db.growthReferral.find((r) => r.id === future.id).createdAt).getTime() - nowMs) < 1000);
    const racedPhone = '0779000200';
    const second = await leads.logLead(op.user, { business: 'Race Shop', phone: racedPhone });
    db.growthReferral.find((r) => r.id === second.id).createdAt = new Date(nowMs - HOUR);
    let disputed = null; try { await leads.logLead(kofi, { business: 'Race Shop', phone: racedPhone, capturedAt: new Date(nowMs - 3 * HOUR).toISOString() }); } catch (e) { disputed = e; }
    check('an earlier offline capture loses the lock but leaves evidence for an admin', disputed && disputed.code === 'LEAD_TAKEN' && /earlier visit time/.test(disputed.message) && db.growthFlag.some((f) => f.code === 'LEAD_DISPUTE' && f.partnerId === kp.id));

    console.log('Strategy: summary widget and admin overview');
    const sum = await partners.summary(amina);
    check('summary for a partner has what a dashboard widget needs', sum.joined && sum.program === 'circle' && sum.code === ap.code && typeof sum.available === 'number' && typeof sum.needsYou === 'number');
    const ov = await admin.overview();
    check('admin overview works (groupBy / aggregate)', ov.partners.length > 0 && ov.referralsByStage.length > 0 && typeof ov.totalOwedToPartners === 'number');
    eco = await admin.economics();
    check('economics splits Circle and Crew rewards', eco.lifetime.crew.rewards > 0 && eco.lifetime.circle.rewards > 0 && eco.window.all.status !== undefined);

    // ---------------------------------------------------------------- Expiry and safety
    console.log('Expiry and safety');
    const old = mkUser('u_old', 'Old Signup', 'old@gmail.com'); await hooks.onSignup({ user: old, code: tp.code });
    advance(61 * DAY);
    const sw2 = await hooks.sweep();
    check('sign-ups that never paid within 60 days lapse', db.growthReferral.find((r) => r.recruitUserId === 'u_old').stage === 'lapsed' && sw2.lapsed >= 1);
    check('an unconverted lead lock expires and frees the number for others', db.growthReferral.find((r) => r.id === off.id).stage === 'lapsed' && (await leads.logLead(op.user, { business: 'Quiet Kiosk', phone: '0779000123' })).lockDays === 14);
    await expectError('late code claim refused after a week', 'TOO_LATE', () => hooks.lateClaim({ user: { ...old, createdAt: new Date(nowMs - 10 * DAY), id: 'u_other' }, code: ap.code }));
    const broken = createGrowth({ prisma: { ...prisma, growthReferral: { findUnique: async () => { throw new Error('db down'); } } }, now: clock });
    const r = await broken.hooks.safe.onPaymentApproved({ payment: { id: 'x' }, store: { id: 'y' }, adminId: 'a' });
    check('a database failure inside a hook never throws into the caller', r === null);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
