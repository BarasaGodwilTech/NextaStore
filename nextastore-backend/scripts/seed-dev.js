/**
 * Seeds a handful of demo stores/products/orders for LOCAL DEVELOPMENT ONLY.
 * Nothing in the server startup path (server.js/app.js) calls this — it must
 * be run explicitly with `npm run seed:dev`, and it refuses to run at all if
 * NODE_ENV=production, so it's not possible to accidentally point this at a
 * live production database and fill it with fake stores.
 *
 * Usage:
 *   1. Make sure DATABASE_URL in your .env points at a DEV database.
 *   2. npm run migrate:dev   (creates the schema)
 *   3. npm run seed:dev
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { generateOrderCode } = require('../src/orderCode');

if ((process.env.NODE_ENV || 'development') === 'production') {
    console.error('Refusing to seed: NODE_ENV=production. This script is for local/dev databases only.');
    process.exit(1);
}

const prisma = new PrismaClient();

const DEMO_PRODUCT_TEMPLATES = [
    { name: 'Kanzu Traditional Wear', price: 45000, originalPrice: 60000, category: 'clothing', sold: 128, stock: 20, icon: 'fa-vest', description: 'Authentic Ugandan Kanzu made from soft, breathable cotton — tailored for ceremonies and everyday elegance.' },
    { name: 'Handmade Beaded Necklace', price: 12000, originalPrice: null, category: 'accessories', sold: 89, stock: 15, icon: 'fa-gem', description: 'Beaded by hand in small batches, each necklace carries traditional patterns unique to the maker.' },
    { name: 'Organic Coffee Beans (1kg)', price: 18000, originalPrice: 22000, category: 'food', sold: 342, stock: 50, icon: 'fa-mug-saucer', description: 'Single-origin, sun-dried arabica beans from the slopes of Mount Elgon. Roasted to order.' },
    { name: 'African Print Dress', price: 55000, originalPrice: 70000, category: 'clothing', sold: 195, stock: 10, icon: 'fa-shirt', description: 'A bold Ankara-print dress cut from quality cotton, finished with a hand-sewn hem.' }
];

// One demo login per starter admin role (created by the default_admin_roles
// migration), so each role's console can be tried locally. Restart-safe.
async function ensureStaffAccounts() {
    const staff = [
        ['Sam Support', 'support@example.com', 'Support Agent'],
        ['Mia Moderator', 'moderator@example.com', 'Moderator'],
        ['Steve Store-Manager', 'storemanager@example.com', 'Store Manager']
    ];
    for (const [name, email, roleName] of staff) {
        const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
        if (!role) continue; // migration not applied yet
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) continue;
        await prisma.user.create({ data: { name, email, passwordHash: bcrypt.hashSync('password123', 10), role: 'admin', adminLevel: 'standard', adminRoleId: role.id } });
    }
}

async function main() {
    console.log('Seeding dev database...');

    // start-local.bat may run this every time the local stack starts. Keep the
    // demo login data stable rather than creating duplicate users/stores/orders
    // on every restart.
    const existingAmina = await prisma.user.findUnique({ where: { email: 'amina@example.com' } });
    if (existingAmina) {
        await prisma.user.update({ where: { id: existingAmina.id }, data: { role: 'seller' } });
        const existingAdmin = await prisma.user.findUnique({ where: { email: 'admin@example.com' } });
        if (existingAdmin) await prisma.user.update({ where: { id: existingAdmin.id }, data: { role: 'admin', adminLevel: 'super_admin', accountStatus: 'active' } });
        const existingBuyer = await prisma.user.findUnique({ where: { email: 'brian@example.com' } });
        if (existingBuyer) await prisma.user.update({ where: { id: existingBuyer.id }, data: { role: 'buyer', accountStatus: 'active' } });
        await ensureStaffAccounts();
        console.log('Dev demo accounts already exist; kept existing test login data unchanged.');
        console.log('Demo seller login: amina@example.com / password123');
        console.log('Demo buyer login: brian@example.com / password123');
        console.log('Demo super-admin login: admin@example.com / password123');
        return;
    }

    const user = await prisma.user.create({
        data: {
            name: 'Amina Nakato',
            email: 'amina@example.com',
            passwordHash: bcrypt.hashSync('password123', 10),
            role: 'seller',
            store: {
                create: {
                    slug: 'amina-crafts',
                    name: "Amina's Crafts & Coffee",
                    description: 'Handmade fashion, beadwork and single-origin coffee from Kampala, made by local artisans.',
                    contactEmail: 'amina@example.com',
                    // New stores start with no payment method on; the demo store
                    // accepts Mobile Money so the demo orders/checkout work.
                    payments: { mtnMomo: true, airtelMoney: true, card: false },
                    followers: 1240
                    // bannerColor omitted so it picks up the schema default (#00B074) —
                    // Amina's Store is the reference store for that color, so it should
                    // never drift from whatever the platform default actually is.
                }
            }
        },
        include: { store: true }
    });

    for (const tpl of DEMO_PRODUCT_TEMPLATES) {
        await prisma.product.create({ data: { ...tpl, storeId: user.store.id } });
    }

    const products = await prisma.product.findMany({ where: { storeId: user.store.id } });
    const orderSeed = [
        { customerName: 'Grace Achieng', customerPhone: '0700000001', status: 'delivered', productIndex: 0, quantity: 1 },
        { customerName: 'Peter Okello', customerPhone: '0700000002', status: 'processing', productIndex: 1, quantity: 1 },
        { customerName: 'Sarah Namutebi', customerPhone: '0700000003', status: 'pending', productIndex: 2, quantity: 2 },
        { customerName: 'David Mugisha', customerPhone: '0700000004', status: 'shipped', productIndex: 3, quantity: 1 }
    ];

    for (const o of orderSeed) {
        const product = products[o.productIndex];
        await prisma.order.create({
            data: {
                id: generateOrderCode(),
                storeId: user.store.id,
                customerName: o.customerName,
                customerPhone: o.customerPhone,
                total: product.price.times(o.quantity),
                status: o.status,
                items: {
                    create: [{ productId: product.id, productName: product.name, quantity: o.quantity, unitPrice: product.price }]
                }
            }
        });
    }

    // A plain buyer account too, so role-gating (seller-only routes, the
    // marketplace redirect, the "Become a seller" upgrade path) all have
    // something to log in as besides Amina.
    await prisma.user.create({
        data: {
            name: 'Brian Kato',
            email: 'brian@example.com',
            passwordHash: bcrypt.hashSync('password123', 10),
            role: 'buyer'
        }
    });

    await prisma.user.create({
        data: {
            name: 'NextaStore Admin',
            email: 'admin@example.com',
            passwordHash: bcrypt.hashSync('password123', 10),
            role: 'admin',
            adminLevel: 'super_admin'
        }
    });

    await ensureStaffAccounts();
    console.log(`Seeded 3 users (1 seller, 1 buyer, 1 admin), 1 store, ${products.length} products, ${orderSeed.length} orders.`);
    console.log('Demo seller login: amina@example.com / password123');
    console.log('Demo buyer login: brian@example.com / password123');
    console.log('Demo super-admin login: admin@example.com / password123');
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
