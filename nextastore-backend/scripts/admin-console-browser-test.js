#!/usr/bin/env node
'use strict';
/*
 * Real admin.html + js/admin.js + css/admin.css in headless Chromium against a
 * fake API on localhost:4000, signed in as each kind of administrator:
 *
 *   npm run test:admin-console-browser
 *
 * Proves, per role: only the modules that role may use exist in the page (the
 * others are REMOVED from the DOM, not hidden) and their endpoints are never
 * called; what the user table and the edit dialog offer follows the role;
 * Escape closes the dialog. Proves for layout: sidebar on desktop, scrolling
 * strip + card-stacked tables on phones, 44px touch targets, no sideways
 * scrolling. Screenshots go to $ADMIN_SHOTS (default /tmp/admin-shots).
 * Does NOT prove the real API's answers (see test:admin-rbac) or iOS Safari.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PRESENCE_TEST_PORT || 4000);
const SHOTS = process.env.ADMIN_SHOTS || '/tmp/admin-shots';
fs.mkdirSync(SHOTS, { recursive: true });

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenFor = (id) => `${b64({ alg: 'none' })}.${b64({ userId: id, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const ROLES = {
  super: { adminLevel: 'super_admin', adminRole: null },
  store_manager: { adminLevel: 'standard', adminRole: { id: 'r1', name: 'Store Manager', permissions: ['dashboard.view', 'users.view', 'users.edit', 'subscriptions.review', 'followups.manage'] } },
  support_agent: { adminLevel: 'standard', adminRole: { id: 'r2', name: 'Support Agent', permissions: ['dashboard.view', 'users.view', 'users.password_reset', 'followups.manage'] } },
  moderator: { adminLevel: 'standard', adminRole: { id: 'r3', name: 'Moderator', permissions: ['dashboard.view', 'users.view', 'users.suspend', 'reports.review', 'followups.manage'] } },
  no_role: { adminLevel: 'standard', adminRole: null }
};
const userFor = (key) => ({ id: key, name: key, email: `${key}@x.test`, role: 'admin', accountStatus: 'active', ...ROLES[key] });

// endpoint -> the module it belongs to, and the permission that opens it
const ENDPOINT_PERM = [
  [/^\/api\/admin\/overview/, 'dashboard.view'], [/^\/api\/admin\/users/, 'users.view'],
  [/^\/api\/admin\/subscription-payments/, 'subscriptions.review'], [/^\/api\/admin\/reports/, 'reports.review'],
  [/^\/api\/admin\/follow-ups/, 'followups.manage'], [/^\/api\/admin\/audit/, 'audit.view'],
  [/^\/api\/admin\/settings/, 'settings.manage'], [/^\/api\/admin\/payment-methods/, 'settings.manage']
];
const USERS = [
  { id: 'u_buyer', name: 'Bea Buyer', email: 'bea@example.com', role: 'buyer', accountStatus: 'active', adminLevel: 'standard', createdAt: '2026-09-01T10:00:00Z', emailVerified: true, store: null },
  { id: 'u_seller', name: 'Sam Seller With A Fairly Long Name', email: 'sam.seller.with.a.long.address@example.com', role: 'seller', accountStatus: 'active', adminLevel: 'standard', createdAt: '2026-09-02T10:00:00Z', emailVerified: true, store: { id: 's1', name: 'Sam Goods', subscription: { status: 'active' }, verified: false } },
  { id: 'u_admin', name: 'Adam Admin', email: 'adam@example.com', role: 'admin', accountStatus: 'active', adminLevel: 'standard', adminRole: { id: 'r2', name: 'Support Agent' }, createdAt: '2026-09-03T10:00:00Z', emailVerified: true, store: null },
  { id: 'u_super', name: 'Sue Super', email: 'sue@example.com', role: 'admin', accountStatus: 'active', adminLevel: 'super_admin', createdAt: '2026-09-04T10:00:00Z', emailVerified: true, store: null }
];

let currentWho = 'super';
let apiLog = [];
const writes = [];
let METHODS = [{ id: 'm1', code: 'mtnMomo', label: 'MTN Mobile Money', icon: 'fa-mobile-screen', isActive: true, currency: 'UGX', allowedCountries: ['UG'], environment: 'live', sortOrder: 0 }, { id: 'm2', code: 'card', label: 'Card', icon: 'fa-credit-card', isActive: false, currency: 'USD', allowedCountries: ['UG', 'KE'], environment: 'test', sortOrder: 1 }];
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://l').pathname;
  if (p.startsWith('/api/')) {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let sent = null; try { sent = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch (e) { /* not json */ }
      const auth = req.headers.authorization || '';
      const who = (() => { try { return JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1], 'base64').toString()).userId; } catch (e) { return currentWho; } })();
      const me = userFor(ROLES[who] ? who : currentWho);
      apiLog.push(p); if (req.method !== 'GET') writes.push({ method: req.method, path: p, body: sent });
      const has = (perm) => me.adminLevel === 'super_admin' || (me.adminRole?.permissions || []).includes(perm);
      const gate = ENDPOINT_PERM.find(([re]) => re.test(p));
      let status = 200; let data = [];
      if (p === '/api/user/me') data = me;
      else if (gate && !has(gate[1])) { status = 403; data = { message: 'You do not have permission to perform this action.' }; }
      else if (p === '/api/admin/payment-methods') data = METHODS;
      else if (p === '/api/admin/overview') data = { users: 120, sellers: 30, admins: has('admins.manage') ? 4 : null, openReports: 2, pendingPayments: 3, openFollowUps: 5, stores: 28 };
      else if (p === '/api/admin/users') data = { users: USERS, page: 1, pages: 1, total: USERS.length };
      else if (/^\/api\/admin\/users\/[^/]+$/.test(p)) data = { user: USERS.find((u) => p.endsWith(u.id)) || USERS[0], followUps: [], audit: [] };
      else if (p === '/api/admin/roles') { if (!has('roles.manage') && !has('admins.manage')) { status = 403; data = { message: 'no' }; } else data = { roles: [{ id: 'r1', name: 'Store Manager', permissions: ['users.view'], _count: { users: 1 } }, { id: 'r9', name: 'Settings Owner', permissions: ['settings.manage'], _count: { users: 0 } }], permissions: ['dashboard.view', 'users.view', 'users.edit', 'users.suspend', 'users.password_reset', 'admins.manage', 'roles.manage', 'reports.review', 'subscriptions.review', 'settings.manage', 'followups.manage', 'audit.view'] }; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { success: true, data } : data));
    });
    return;
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let passed = 0; let failed = 0;
function check(name, ok, extra) { if (ok) { passed++; console.log('PASS  ' + name); } else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); } }
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const EXPECT_TABS = {
  super: ['overview', 'users', 'team', 'payments', 'reports', 'followups', 'settings', 'audit'],
  store_manager: ['overview', 'users', 'payments', 'followups'],
  support_agent: ['overview', 'users', 'followups'],
  moderator: ['overview', 'users', 'reports', 'followups'],
  no_role: ['overview']
};
const EXPECT_STATS = {
  super: ['Accounts', 'Sellers', 'Payments waiting', 'Reports waiting', 'Administrators', 'Open follow-ups'],
  store_manager: ['Accounts', 'Sellers', 'Payments waiting', 'Open follow-ups'],
  support_agent: ['Accounts', 'Sellers', 'Open follow-ups'],
  moderator: ['Accounts', 'Sellers', 'Reports waiting', 'Open follow-ups'],
  no_role: []
};
const TAB_PERM = { users: 'users.view', payments: 'subscriptions.review', reports: 'reports.review', followups: 'followups.manage', settings: 'settings.manage', audit: 'audit.view' };

async function open(browser, who, w, h) {
  currentWho = who; apiLog = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 });
  await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', JSON.stringify(u)); } catch (e) { /* ignore */ } }, [tokenFor(who), userFor(who)]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/admin.html`);
  await page.waitForSelector('#adminNav', { timeout: 5000 });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}
const tabsIn = (page) => page.evaluate(() => [...document.querySelectorAll('[data-admin-tab]')].map((b) => b.dataset.adminTab));

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    // ---------------- per-role console ----------------------------------------
    for (const who of Object.keys(ROLES)) {
      const { ctx, page, errors } = await open(browser, who, 1280, 800);
      const label = who.replace('_', ' ');
      const tabs = await tabsIn(page);
      check(`${label}: sidebar has exactly ${EXPECT_TABS[who].join(', ')}`, sameSet(tabs, EXPECT_TABS[who]), tabs.join(','));
      const removed = Object.keys(TAB_PERM).filter((m) => !EXPECT_TABS[who].includes(m));
      const leftovers = await page.evaluate((mods) => mods.filter((m) => document.querySelector(`[data-admin-section="${m}"], [data-jump="${m}"], [data-admin-tab="${m}"]`)), removed);
      check(`${label}: modules it cannot use are removed from the page, not hidden (${removed.length || 'none'} removed)`, leftovers.length === 0, leftovers.join(','));
      const stats = await page.evaluate(() => [...document.querySelectorAll('.admin-stat span')].map((s) => s.textContent));
      check(`${label}: stat cards are ${EXPECT_STATS[who].join(' / ') || 'none'}`, sameSet(stats, EXPECT_STATS[who]), stats.join(','));
      const visibleStat = await page.evaluate(() => [...document.querySelectorAll('.admin-stat')].every((s) => s.offsetParent !== null));
      check(`${label}: every remaining stat card is actually visible`, visibleStat);
      const head = await page.textContent('#adminLevelLabel');
      check(`${label}: header shows the role`, who === 'super' ? /Super administrator/.test(head) : (who === 'no_role' ? /Administrator/.test(head) : head.includes(ROLES[who].adminRole.name)), head);

      // walk every visible tab; only permitted endpoints may be requested
      for (const t of tabs) { await page.click(`[data-admin-tab="${t}"]`); await page.waitForTimeout(250); }
      const forbidden = apiLog.filter((u) => { const g = ENDPOINT_PERM.find(([re]) => re.test(u)); if (!g) return false; const me = userFor(who); return !(me.adminLevel === 'super_admin' || (me.adminRole?.permissions || []).includes(g[1])); });
      check(`${label}: never calls an endpoint it lacks permission for`, forbidden.length === 0, forbidden.join(','));
      const denied = await page.evaluate(() => document.querySelectorAll('.admin-empty .fa-lock').length);
      check(`${label}: no "access restricted" or error panels shown`, denied === 0, String(denied));
      check(`${label}: no script errors`, errors.length === 0, errors.join(' | '));
      await page.click('[data-admin-tab="overview"]');
      await page.screenshot({ path: path.join(SHOTS, `${who}-desktop-overview.png`) });
      if (tabs.includes('users')) { await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table'); await page.screenshot({ path: path.join(SHOTS, `${who}-desktop-users.png`) }); }
      await ctx.close();
    }

    // ---------------- user table + edit dialog follow the role ------------------
    const rows = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.admin-table tbody tr')].map((r) => [r.querySelector('strong').textContent.split(' ')[0], [...r.querySelectorAll('.admin-actions button')].map((b) => b.textContent.trim()).join('|') || (r.textContent.includes('View only') ? 'view-only' : '')])));
    {
      const { ctx, page } = await open(browser, 'support_agent', 1280, 800);
      await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table');
      const r = await rows(page);
      check('support agent: can reset a buyer or seller password but has no Edit button anywhere', r.Bea === 'Reset password' && r.Sam === 'Reset password' && !Object.values(r).some((v) => /Edit/.test(v)), JSON.stringify(r));
      check('support agent: administrators (and the super admin) are view-only, with no reset', r.Adam === 'view-only' && r.Sue === 'view-only', JSON.stringify(r));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, 'store_manager', 1280, 800);
      await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table');
      const r = await rows(page);
      check('store manager: can edit buyers and sellers, no reset button, administrators are view-only', r.Bea === 'Edit' && r.Sam === 'Edit' && r.Adam === 'view-only' && r.Sue === 'view-only', JSON.stringify(r));
      await page.click('[data-edit-user="u_seller"]'); await page.waitForSelector('#userEditForm');
      const f = await page.evaluate(() => ({ names: [...document.querySelectorAll('#userEditForm [name]')].map((e) => e.name), roleOpts: [...document.querySelectorAll('#userEditForm [name=role] option')].map((o) => o.value) }));
      check('store manager dialog: name, email and account role are editable; no status, admin level or admin role fields', sameSet(f.names, ['name', 'email', 'role']), f.names.join(','));
      check('store manager dialog: cannot pick "Administrator" as an account role', !f.roleOpts.includes('admin'), f.roleOpts.join(','));
      const dlg = await page.evaluate(() => { const m = document.querySelector('.admin-modal'); const b = m.getBoundingClientRect(); return { inView: b.top >= 0 && b.bottom <= innerHeight, role: m.getAttribute('role') }; });
      check('dialog fits the viewport and is marked as a dialog', dlg.inView && dlg.role === 'dialog', JSON.stringify(dlg));
      await page.keyboard.press('Escape');
      check('Escape closes the dialog', await page.evaluate(() => !document.querySelector('.admin-modal')));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, 'moderator', 1280, 800);
      await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table');
      const r = await rows(page);
      check('moderator: can open buyers and sellers (to suspend), no reset button, administrators are view-only', r.Bea === 'Edit' && r.Adam === 'view-only', JSON.stringify(r));
      await page.click('[data-edit-user="u_buyer"]'); await page.waitForSelector('#userEditForm');
      const names = await page.evaluate(() => [...document.querySelectorAll('#userEditForm [name]')].map((e) => e.name));
      check('moderator dialog: only the Status field is editable (details are read-only text)', sameSet(names, ['accountStatus']), names.join(','));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, 'super', 1280, 800);
      await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table');
      const r = await rows(page);
      check('super admin: Edit + Reset on every account, including administrators', Object.values(r).every((v) => v === 'Edit|Reset password'), JSON.stringify(r));
      await page.click('[data-edit-user="u_admin"]'); await page.waitForSelector('#userEditForm');
      const names = await page.evaluate(() => [...document.querySelectorAll('#userEditForm [name]')].map((e) => e.name));
      check('super admin dialog on an administrator: every field including admin level and admin role', sameSet(names, ['name', 'email', 'role', 'accountStatus', 'adminLevel', 'adminRoleId']), names.join(','));
      await page.keyboard.press('Escape');
      await page.click('[data-admin-tab="team"]'); await page.waitForSelector('.role-row');
      check('super admin: role list has Edit and Delete for every role, and a Create button', await page.evaluate(() => document.querySelectorAll('[data-edit-role]').length === 2 && document.querySelectorAll('[data-delete-role]').length === 2 && !!document.getElementById('createRole')));
      await page.click('#createRole'); await page.waitForSelector('#roleForm');
      const perms = await page.evaluate(() => document.querySelectorAll('#roleForm input[name=permissions]').length);
      check('super admin: role editor offers all 12 permissions', perms === 12, String(perms));
      await ctx.close();
    }

    // ---------------- payment methods ----------------------------------------------
    {
      const { ctx, page, errors } = await open(browser, 'super', 1280, 800);
      await page.click('[data-admin-tab="settings"]'); await page.waitForSelector('#paymentMethodsList .role-row');
      const rows = await page.evaluate(() => [...document.querySelectorAll('#paymentMethodsList .role-row')].map((r) => r.textContent.replace(/\s+/g, ' ')));
      check('super admin: payment methods listed with state, currency, countries and mode', rows.length === 2 && /MTN Mobile Money.*On.*UGX.*UG.*Live/.test(rows[0]) && /Card.*Off.*USD.*UG, KE.*Test mode/.test(rows[1]), rows.join(' | '));
      writes.length = 0;
      await page.click('[data-toggle-method="m1"]'); await page.waitForTimeout(200);
      check('Turn off sends PUT { isActive:false }', writes.some((w) => w.method === 'PUT' && w.path.endsWith('/m1') && w.body.isActive === false), JSON.stringify(writes));
      await page.click('#addPaymentMethod'); await page.waitForSelector('#pmForm');
      await page.fill('#pmForm [name=code]', 'airtel'); await page.fill('#pmForm [name=label]', 'Airtel Money'); await page.fill('#pmForm [name=countries]', 'ug, ke');
      writes.length = 0;
      await page.click('#pmForm button[type=submit]'); await page.waitForTimeout(200);
      const w = writes.find((x) => x.method === 'POST');
      check('Add method POSTs code, label, upper-cased countries and isActive', w && w.body.code === 'airtel' && w.body.label === 'Airtel Money' && JSON.stringify(w.body.allowedCountries) === '["UG","KE"]' && w.body.isActive === true, JSON.stringify(w));
      await page.click('[data-edit-method="m2"]'); await page.waitForSelector('#pmForm');
      check('editing a method locks its code', await page.evaluate(() => document.querySelector('#pmForm [name=code]').readOnly));
      await page.keyboard.press('Escape');
      check('payment methods screen: no script errors', errors.length === 0, errors.join(' | '));
      await page.setViewportSize({ width: 390, height: 844 });
      const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, minH: Math.min(...[...document.querySelectorAll('#paymentMethodsList .btn, #addPaymentMethod')].map((b) => b.getBoundingClientRect().height)) }));
      check('390px: payment methods have no sideways scroll and 44px buttons', o.over <= 0 && o.minH >= 44, JSON.stringify(o));
      await page.screenshot({ path: path.join(SHOTS, 'super-mobile-payment-methods.png') });
      await ctx.close();
    }
    for (const who of ['store_manager', 'support_agent', 'moderator']) {
      const { ctx, page } = await open(browser, who, 1280, 800);
      check(`${who.replace('_', ' ')}: no payment-methods UI and no payment-methods call`, await page.evaluate(() => !document.getElementById('paymentMethodsList') && !document.getElementById('addPaymentMethod')) && !apiLog.some((u) => /payment-methods/.test(u)));
      await ctx.close();
    }

    // ---------------- layout ----------------------------------------------------
    {
      const { ctx, page } = await open(browser, 'super', 1280, 800);
      const g = await page.evaluate(() => { const n = document.getElementById('adminNav').getBoundingClientRect(); const m = document.querySelector('.admin-main').getBoundingClientRect(); return { navLeft: n.left, navW: n.width, mainLeft: m.left, over: document.documentElement.scrollWidth - innerWidth, navBtnH: Math.min(...[...document.querySelectorAll('.admin-nav button')].map((b) => b.getBoundingClientRect().height)) }; });
      check('desktop: sidebar sits to the left of the content', g.navLeft < g.mainLeft && g.navW > 180 && g.navW < 280, JSON.stringify(g));
      check('desktop: no sideways page scroll; nav items are 44px tall', g.over <= 0 && g.navBtnH >= 44, JSON.stringify(g));
      await ctx.close();
    }
    for (const [w, h] of [[390, 844], [360, 740], [320, 568]]) {
      const { ctx, page } = await open(browser, 'super', w, h);
      const nav = await page.evaluate(() => { const n = document.getElementById('adminNav'); const cs = getComputedStyle(n); const btns = [...n.querySelectorAll('button')]; return { dir: cs.flexDirection, sticky: cs.position, labelsShown: [...document.querySelectorAll('.admin-nav-label')].some((l) => l.offsetParent !== null), minH: Math.min(...btns.map((b) => b.getBoundingClientRect().height)), minW: Math.min(...btns.map((b) => b.getBoundingClientRect().width)), scrolls: n.scrollWidth > n.clientWidth, over: document.documentElement.scrollWidth - innerWidth }; });
      check(`${w}px: sidebar becomes a horizontal strip, sticky, with group labels hidden`, nav.dir === 'row' && nav.sticky === 'sticky' && !nav.labelsShown && nav.scrolls, JSON.stringify(nav));
      check(`${w}px: strip buttons are at least 44x44 and the page does not scroll sideways`, nav.minH >= 44 && nav.minW >= 44 && nav.over <= 0, JSON.stringify(nav));
      await page.click('[data-admin-tab="users"]'); await page.waitForSelector('.admin-table');
      const t = await page.evaluate(() => { const rows = [...document.querySelectorAll('.admin-table tbody tr')]; const r0 = rows[0].getBoundingClientRect(); const head = document.querySelector('.admin-table thead').getBoundingClientRect(); const btns = [...document.querySelectorAll('.admin-table .btn')]; const labelled = [...document.querySelectorAll('.admin-table tbody td:not(:first-child):not(.admin-actions-cell)')].every((td) => td.dataset.label); return { rowsFit: rows.every((r) => { const b = r.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5; }), theadPx: head.width * head.height, cardStacked: getComputedStyle(rows[0]).display === 'grid', minBtnH: Math.min(...btns.map((b) => b.getBoundingClientRect().height)), labelled, over: document.documentElement.scrollWidth - innerWidth }; });
      check(`${w}px: users table is a stack of cards inside the viewport, each value labelled`, t.rowsFit && t.cardStacked && t.labelled && t.theadPx <= 1, JSON.stringify(t));
      check(`${w}px: table action buttons are 44px tall; no sideways page scroll`, t.minBtnH >= 44 && t.over <= 0, JSON.stringify(t));
      await page.click('[data-edit-user="u_seller"]'); await page.waitForSelector('.admin-modal');
      const m = await page.evaluate(() => { const b = document.querySelector('.admin-modal').getBoundingClientRect(); const foot = document.querySelector('.admin-modal-footer .btn').getBoundingClientRect(); return { bottomSheet: Math.abs(b.bottom - innerHeight) < 2 && b.width >= innerWidth - 1, footerOnScreen: foot.bottom <= innerHeight && foot.height >= 44, top: b.top }; });
      check(`${w}px: edit dialog is a bottom sheet with its Save button on screen`, m.bottomSheet && m.footerOnScreen && m.top >= 0, JSON.stringify(m));
      if (w === 390) { await page.screenshot({ path: path.join(SHOTS, 'super-mobile-dialog.png') }); }
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(SHOTS, `super-mobile-${w}-users.png`) });
      await page.click('[data-admin-tab="overview"]');
      const o = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(`${w}px: overview has no sideways scroll`, o <= 0, String(o));
      if (w === 390) await page.screenshot({ path: path.join(SHOTS, 'super-mobile-overview.png') });
      await ctx.close();
    }
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${passed}/${passed + failed} admin console checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
