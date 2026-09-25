#!/usr/bin/env node
/**
 * End-to-end runtime smoke test for a DEDICATED PostgreSQL test database.
 *
 * Required:
 *   TEST_DATABASE_URL=postgresql://... npm run test:integration
 *
 * This intentionally resets the database. Never point TEST_DATABASE_URL at a
 * production database. The test proves migrations apply from scratch, seeds
 * the dev accounts, exercises the public API checkout/report/admin flow, and
 * verifies the final moderation fields directly in PostgreSQL through Prisma.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

// Prisma reads DATABASE_URL from the process environment. The child processes
// receive the test URL below, but the integration runner must set it here too
// so final direct-to-Postgres assertions cannot accidentally hit .env's DB.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';

const root = path.resolve(__dirname, '..');
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.error('FAIL  TEST_DATABASE_URL is required (use a dedicated throwaway PostgreSQL database).');
  process.exit(2);
}
if (/production/i.test(process.env.NODE_ENV || '')) {
  console.error('FAIL  Refusing to run integration tests with NODE_ENV=production.');
  process.exit(2);
}

const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'test', PORT: '4018', CORS_ORIGIN: '*' };
const prisma = new PrismaClient();
let server;

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    console.error(result.stdout || '');
    console.error(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

async function request(base, method, pathname, token, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function waitForApi(base) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('API did not become ready.');
}

async function main() {
  console.log('1/8 Resetting and applying every Prisma migration from scratch...');
  run('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed']);

  console.log('2/8 Running the development seed...');
  run('npm', ['run', 'seed:dev']);

  console.log('3/8 Creating a second seller/store/product for the cross-store checkout...');
  const secondSeller = await prisma.user.create({
    data: {
      name: 'Second Test Seller',
      email: 'second-seller@example.com',
      passwordHash: bcrypt.hashSync('password123', 10),
      role: 'seller',
      store: { create: {
        slug: 'second-test-store', name: 'Second Test Store',
        description: 'Integration test store', contactEmail: 'second-seller@example.com',
        payments: { mtnMomo: true, airtelMoney: true, card: false },
        district: 'Central', address: '10 Test Street', detailedDirections: 'Next to the test market', mapCoordinates: '0.3136,32.5811'
      } }
    },
    include: { store: true }
  });
  const firstSeller = await prisma.user.findUnique({ where: { email: 'amina@example.com' }, include: { store: true } });
  const firstProduct = await prisma.product.findFirst({ where: { storeId: firstSeller.store.id, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  const secondProduct = await prisma.product.create({ data: {
    storeId: secondSeller.store.id, name: 'Integration Test Mug', description: 'test', price: 25000,
    category: 'home', stock: 10, icon: 'fa-mug-hot'
  } });

  const base = 'http://127.0.0.1:4018';
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  await waitForApi(base);

  console.log('4/8 Exercising browse + admin authentication...');
  const products = await request(base, 'GET', `/api/products?store=${encodeURIComponent(firstSeller.store.slug)}&page=1&limit=2`);
  if (!Array.isArray(products.data) || products.data.length !== 2 || !products.pagination) throw new Error('Paginated browse endpoint did not return the expected shape.');
  const publicStores = await request(base, 'GET', '/api/store/public/all?page=1&limit=2');
  if (!Array.isArray(publicStores.data) || publicStores.data.length !== 2 || !publicStores.pagination) throw new Error('Paginated store directory did not return the expected shape.');
  const search = await request(base, 'GET', '/api/store/search?q=Integration%20Test&limit=6');
  if (!search.data?.products?.some(p => p.name === 'Integration Test Mug')) throw new Error('Server-side search did not find the test product.');
  const buyerLogin = await request(base, 'POST', '/api/auth/login', null, { email: 'brian@example.com', password: 'password123' });
  const adminLogin = await request(base, 'POST', '/api/auth/login', null, { email: 'admin@example.com', password: 'password123' });
  if (adminLogin.user?.role !== 'admin') throw new Error('Admin login did not return role=admin.');

  // Admins must not inherit seller write access merely because they can
  // moderate reports. This guards the least-privilege boundary explicitly.
  const adminWriteAttempt = await fetch(`${base}/api/products`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminLogin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Should Be Rejected', price: 1, stock: 1, category: 'other' })
  });
  if (adminWriteAttempt.status !== 403) throw new Error(`Admin seller-write boundary returned ${adminWriteAttempt.status}, expected 403.`);

  console.log('5/8 Checking two-store batch checkout: pickup + delivery...');
  const batch = await request(base, 'POST', '/api/orders/batch', buyerLogin.token, {
    customerName: 'Brian Kato', customerPhone: '0700000999', deliveryAddress: 'Delivery Test Address', acknowledgment: true,
    stores: [
      { storeId: firstSeller.store.id, fulfillmentMethod: 'pickup', paymentMethod: 'mtnMomo', items: [{ productId: firstProduct.id, quantity: 1 }] },
      { storeId: secondSeller.store.id, fulfillmentMethod: 'delivery', paymentMethod: 'mtnMomo', items: [{ productId: secondProduct.id, quantity: 1 }] }
    ]
  });
  const orders = batch.data;
  if (!Array.isArray(orders) || orders.length !== 2) throw new Error(`Expected 2 orders, got ${JSON.stringify(orders)}`);
  const pickup = orders.find(o => o.storeId === firstSeller.store.id);
  const delivery = orders.find(o => o.storeId === secondSeller.store.id);
  if (pickup.fulfillmentMethod !== 'pickup' || delivery.fulfillmentMethod !== 'delivery') throw new Error('Fulfillment methods were not persisted correctly.');

  const sellerLogin = await request(base, 'POST', '/api/auth/login', null, { email: 'amina@example.com', password: 'password123' });
  const publicSecondBefore = await request(base, 'GET', `/api/store/public/${encodeURIComponent(secondSeller.store.slug)}`);
  if (publicSecondBefore.data?.ownerId !== undefined || publicSecondBefore.data?.passwordHash !== undefined) throw new Error('Public store payload leaked private ownership data.');
  const sellerOrder = await request(base, 'GET', `/api/orders/${pickup.id}`, sellerLogin.token);
  if (sellerOrder.data.fulfillmentMethod !== 'pickup') throw new Error('Seller order detail lost pickup fulfillment.');
  if (!sellerOrder.data.store?.address || sellerOrder.data.store.address !== firstSeller.store.address) throw new Error('Seller order detail did not include the pickup store location.');

  const secondSellerLogin = await request(base, 'POST', '/api/auth/login', null, { email: 'second-seller@example.com', password: 'password123' });
  const secondStockAfterCheckout = (await prisma.product.findUnique({ where: { id: secondProduct.id } })).stock;
  await request(base, 'PUT', `/api/orders/${delivery.id}/status`, secondSellerLogin.token, { status: 'cancelled' });
  const secondStockAfterCancel = (await prisma.product.findUnique({ where: { id: secondProduct.id } })).stock;
  if (secondStockAfterCancel !== secondStockAfterCheckout + 1) throw new Error('Cancelling an order did not restore product stock.');

  console.log('6/8 Filing a buyer report, then reviewing it as admin...');
  await request(base, 'POST', `/api/orders/${pickup.id}/report`, buyerLogin.token, { reason: 'Integration test report: please review.' });
  const reports = await request(base, 'GET', '/api/admin/reports', adminLogin.token);
  const report = reports.data.find(r => r.order?.id === pickup.id);
  if (!report) throw new Error('Admin report list did not contain the newly filed report.');
  const reviewed = await request(base, 'PUT', `/api/admin/reports/${report.id}/review`, adminLogin.token, {});
  if (!reviewed.data.reviewedAt || reviewed.data.reviewedBy !== adminLogin.user.id) throw new Error('Admin review did not populate reviewedAt/reviewedBy.');
  const persisted = await prisma.orderReport.findUnique({ where: { id: report.id } });
  if (!persisted?.reviewedAt || persisted.reviewedBy !== adminLogin.user.id) throw new Error('Reviewed fields were not persisted in PostgreSQL.');

  const upgraded = await request(base, 'POST', '/api/user/become-seller', buyerLogin.token);
  if (upgraded.data?.role !== 'seller') throw new Error('Buyer-to-seller upgrade did not return seller role.');

  console.log('7/8 Exercising Seller Pass top-ups + badge progression...');
  const initialSubscription = await request(base, 'GET', '/api/subscription', sellerLogin.token);
  if (initialSubscription.data?.status !== 'trial' || initialSubscription.data?.isPaid) throw new Error('Fresh seeded seller should start in a free trial, not a paid subscription.');
  await request(base, 'PUT', '/api/admin/settings', adminLogin.token, {
    mtnMomoCode: '171145', mtnMomoName: 'NextaStore', airtelMoneyCode: '760000', airtelMoneyName: 'NextaStore'
  });
  const wrongAmount = await fetch(`${base}/api/subscription/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sellerLogin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 1, method: 'mtnMomo', reference: 'WRONG-AMOUNT-1', periodMonths: 3 })
  });
  if (wrongAmount.status !== 400) throw new Error(`Wrong subscription amount returned ${wrongAmount.status}, expected 400.`);

  // Strategic top-up flow: seller pays 3 months first, then adds another 3
  // months while the first coverage is still active. The second approval must
  // stack onto the existing paid-until date and unlock the 6-month badge.
  const firstThree = await request(base, 'POST', '/api/subscription/payments', sellerLogin.token, {
    amount: 60000, method: 'mtnMomo', reference: 'TOPUP-THREE-ONE', periodMonths: 3
  });
  if (!firstThree.data?.id) throw new Error('3-month subscription payment submission failed.');
  const queue1 = await request(base, 'GET', '/api/admin/subscription-payments', adminLogin.token);
  const queued1 = queue1.data.find(p => p.id === firstThree.data.id);
  await request(base, 'PUT', `/api/admin/subscription-payments/${queued1.id}/approve`, adminLogin.token, {});
  const afterThree = await request(base, 'GET', '/api/subscription', sellerLogin.token);
  if (afterThree.data?.commitmentMonths !== 3 || afterThree.data?.badge) throw new Error('First 3-month payment should create 3 months of coverage without a badge.');

  const paidUntilAfterThree = new Date(afterThree.data.subscriptionPaidUntil);
  const secondThree = await request(base, 'POST', '/api/subscription/payments', sellerLogin.token, {
    amount: 60000, method: 'mtnMomo', reference: 'TOPUP-THREE-TWO', periodMonths: 3
  });
  const queue2 = await request(base, 'GET', '/api/admin/subscription-payments', adminLogin.token);
  const queued2 = queue2.data.find(p => p.id === secondThree.data.id);
  await request(base, 'PUT', `/api/admin/subscription-payments/${queued2.id}/approve`, adminLogin.token, {});
  const activeSub = await request(base, 'GET', '/api/subscription', sellerLogin.token);
  const paidUntilAfterSix = new Date(activeSub.data.subscriptionPaidUntil);
  if (activeSub.data?.status !== 'active' || !activeSub.data?.isPaid || activeSub.data?.commitmentMonths !== 6) throw new Error('Second 3-month payment did not stack to 6 months of active coverage.');
  if (activeSub.data?.badge?.key !== 'verified-seller') throw new Error('Cumulative 6-month commitment did not return the Verified Seller badge.');
  if (!(paidUntilAfterSix > paidUntilAfterThree)) throw new Error('Second payment did not extend the existing paid-until date.');
  const persistedStore = await prisma.store.findUnique({ where: { id: firstSeller.store.id } });
  if (!persistedStore?.verified || !persistedStore.subscriptionPaidUntil || persistedStore.badgeCommitmentMonths !== 6) throw new Error('Approved top-up did not persist the 6-month Verified Seller state.');

  console.log(`PASS  migrations-from-scratch + seed + two-store checkout + seller pickup detail + buyer report + admin review + Seller Pass payment approval`);
}

main()
  .catch(err => { console.error(`FAIL  ${err.stack || err}`); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
  });
