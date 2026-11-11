/**
 * Crew ID card: backend rules, NO database, NO network.   node scripts/growth-card-test.js
 * Runs the real growth services on the in-memory stand-in (scripts/lib/memory-prisma.js).
 * Covers: the unlock count, the one-time "ready" notice, the early release by an admin, who may change the photo and when,
 * and that the stored photo key never leaves the server. Honest limit: this does not run the migration against Postgres.
 */
const path = require('path');
const { createGrowth } = require(path.join(__dirname, '..', 'src', 'growth', 'index.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');
const R = require(path.join(__dirname, '..', 'src', 'growth', 'rules.js'));

let nowMs = new Date('2026-11-02T07:00:00Z').getTime();
const clock = () => new Date(nowMs); const HOUR = 3600000;
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + d); } };
const expectError = async (n, code, fn) => { try { await fn(); check(n, false, 'did not throw'); } catch (e) { check(n, e.code === code, 'got ' + (e.code || e.message)); } };

(async () => {
    const prisma = createMemoryPrisma(clock), notes = [], audits = [];
    const growth = createGrowth({ prisma, now: clock, createNotification: async (x) => { notes.push(x); prisma._db.notification.push({ id: 'n' + notes.length, createdAt: clock(), ...x }); }, recordAdminAudit: async (a) => { audits.push(a); } });
    const { partners, leads, admin, card } = growth, db = prisma._db;
    const mk = (id, name) => { const u = { id, name, email: `${id}@gmail.test`, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock() }; db.user.push(u); return u; };
    const readyNotes = (uid) => notes.filter((n) => n.userId === uid && /ID card is ready/.test(n.title || '')).length;
    const lead = async (u, i) => { nowMs += 3 * HOUR; return leads.logLead(u, { business: `Shop ${u.id}-${i}`, contactName: 'Owner', phone: `07${String(70000000 + i * 7919 + u.id.length).slice(0, 8)}`, district: 'kampala' }); };
    let seq = 0;
    const joinCrew = async (id, name, photo) => { const u = mk(id, name); const p = await partners.applyCrew(u, { phone: `0753${String(100000 + (++seq) * 7351).slice(0, 6)}`, territories: ['kampala'], kycFileUrl: 'private/id.jpg', cardPhotoUrl: photo === undefined ? 'private/default.jpg' : photo, agreedTerms: true }); return { u, p }; };

    console.log('The target');
    check('the target is 5 businesses', R.CREW_CARD.unlockLeads === 5 && card.target === 5);
    const a = await joinCrew('u_ann', 'Ann Crew', 'private/card-ann.jpg');
    check('the card photo sent with the application is stored on the application', (await prisma.growthPartner.findUnique({ where: { id: a.p.id } })).cardPhotoUrl === 'private/card-ann.jpg');
    let st = await partners.cardState(await prisma.growthPartner.findUnique({ where: { id: a.p.id } }));
    check('before approval nothing is unlocked', st.unlocked === false && st.leads === 0 && st.needed === 5 && st.hasPhoto === true);
    await admin.approveCrew('admin1', a.p.id);

    console.log('Unlocking by logging businesses');
    for (let i = 1; i <= 4; i++) await lead(a.u, i);
    st = await partners.cardState(await prisma.growthPartner.findUnique({ where: { id: a.p.id } }));
    check('after 4 businesses it is still locked, at 4 of 5', !st.unlocked && st.leads === 4 && st.by === null);
    check('no "ready" notice yet', readyNotes('u_ann') === 0);
    await lead(a.u, 5);
    st = await partners.cardState(await prisma.growthPartner.findUnique({ where: { id: a.p.id } }));
    check('the 5th business unlocks it, by the target', st.unlocked && st.by === 'target' && st.leads === 5);
    check('the member gets exactly one "ready" notice', readyNotes('u_ann') === 1);
    await lead(a.u, 6);
    st = await partners.cardState(await prisma.growthPartner.findUnique({ where: { id: a.p.id } }));
    check('a 6th business does not send the notice again, and progress stays capped at 5', readyNotes('u_ann') === 1 && st.leads === 5);

    console.log('Who may change the photo');
    await expectError('once the card is unlocked the photo is fixed', 'CARD_RELEASED', () => card.setPhoto(a.u, 'private/new.jpg'));
    const b = await joinCrew('u_bea', 'Bea Crew', 'private/card-bea.jpg'); await admin.approveCrew('admin1', b.p.id);
    await card.setPhoto(b.u, 'private/card-bea-2.jpg');
    check('while it is locked a member can replace the photo', (await card.ownPhotoKey(b.u)) === 'private/card-bea-2.jpg');
    await expectError('an empty photo is refused', 'CARD_PHOTO_REQUIRED', () => card.setPhoto(b.u, null));
    const circleUser = mk('u_cy', 'Circle Cy'); await partners.joinCircle(circleUser, { phone: '0752000111', agreedTerms: true });
    await expectError('a Circle member cannot add a card photo', 'NOT_CREW', () => card.setPhoto(circleUser, 'private/x.jpg'));
    check('a Circle member has no card state and no photo key', (await partners.cardState(await prisma.growthPartner.findUnique({ where: { userId: 'u_cy' } }))) === null && (await card.ownPhotoKey(circleUser)) === null);

    console.log('Early release by an admin');
    await expectError('the server refuses a Crew application with no card photo', 'CARD_PHOTO_REQUIRED', () => joinCrew('u_req', 'Req Crew', null));
    check('and the refused application was not saved', !db.growthPartner.some((x) => x.userId === 'u_req'));
    await expectError('it also refuses a Circle upgrade request with no card photo', 'CARD_PHOTO_REQUIRED', async () => { const cu = mk('u_up', 'Up Circle'); await partners.joinCircle(cu, { phone: '0752000222', agreedTerms: true }); await partners.applyUpgrade(cu, { phone: '0752000222', territories: ['kampala'], kycFileUrl: 'private/id.jpg', agreedTerms: true }); });
    await expectError('a member whose photo is missing (older record) cannot be released until one is added', 'CARD_PHOTO_REQUIRED', async () => { const n = await joinCrew('u_nop', 'No Photo'); await admin.approveCrew('admin1', n.p.id); await prisma.growthPartner.update({ where: { id: n.p.id }, data: { cardPhotoUrl: null } }); await card.issue('admin1', n.p.id); });
    const c = await joinCrew('u_cat', 'Cat Crew', 'private/card-cat.jpg');
    await expectError('an application that is not approved cannot be released', 'NOT_APPROVED', () => card.issue('admin1', c.p.id));
    await admin.approveCrew('admin1', c.p.id);
    const out = await card.issue('admin1', c.p.id);
    st = await partners.cardState(await prisma.growthPartner.findUnique({ where: { id: c.p.id } }));
    check('release unlocks it by the admin, with 0 businesses logged', out.ok && out.already === false && st.unlocked && st.by === 'admin' && st.leads === 0);
    check('the member is told', readyNotes('u_cat') === 1);
    check('the release is in the audit trail', audits.some((x) => JSON.stringify(x).includes('card_released')), JSON.stringify(audits.slice(-2)));
    check('releasing twice changes nothing', (await card.issue('admin1', c.p.id)).already === true && readyNotes('u_cat') === 1);
    await expectError('after an early release the photo is fixed too', 'CARD_RELEASED', () => card.setPhoto(c.u, 'private/y.jpg'));
    await expectError('an unknown member is a 404, not a crash', undefined, () => card.issue('admin1', 'nope'));

    console.log('What leaves the server');
    const dash = await partners.dashboard(a.u);
    check('the member dashboard carries the card state for an approved member', dash.card && dash.card.unlocked === true && dash.card.hasPhoto === true);
    check('the dashboard never carries the stored photo key', !JSON.stringify(dash).includes('private/card-ann.jpg'));
    const det = await admin.partnerDetail(a.p.id);
    check('the admin file says a card photo exists but never gives its key', det.partner.hasCardPhoto === true && !JSON.stringify(det).includes('private/card-ann.jpg') && det.card && det.card.unlocked);
    const page = JSON.stringify(await admin.members({}));
    check('the admin member list says who has a card photo but never leaks a key', page.includes('"hasCardPhoto":true') && !page.includes('private/card-'));
    check('the older plain list never leaks a key either', !JSON.stringify(await admin.listPartners({})).includes('private/card-'));

    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
