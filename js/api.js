/**
 * NextaStore development Mock API
 * ---------------------------------------------------------------------------
 * This file is intentionally development-only. The real PostgreSQL/Express
 * API is the default path in js/main.js; add `?mock=1` to a page URL when you
 * need a local UI-only data layer without a running database.
 * ---------------------------------------------------------------------------
 */

(function (global) {
    const DB_KEY = 'nextastore_db_v1';
    const SESSION_KEY = 'nextastore_token';

    function uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    function slugify(text) {
        return (text || 'my-store')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') || 'my-store';
    }

    function hash(str) {
        // Not cryptographic — this is a client-only demo data layer.
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (h << 5) - h + str.charCodeAt(i);
            h |= 0;
        }
        return String(h);
    }

    const DEMO_PRODUCT_TEMPLATES = [
        { name: 'Kanzu Traditional Wear', price: 45000, originalPrice: 60000, category: 'clothing', rating: 4.5, reviews: 42, sold: 128, icon: 'fa-vest', description: 'Authentic Ugandan Kanzu made from soft, breathable cotton — tailored for ceremonies and everyday elegance.' },
        { name: 'Handmade Beaded Necklace', price: 12000, originalPrice: null, category: 'accessories', rating: 5, reviews: 28, sold: 89, icon: 'fa-gem', description: 'Beaded by hand in small batches, each necklace carries traditional patterns unique to the maker.' },
        { name: 'Organic Coffee Beans (1kg)', price: 18000, originalPrice: 22000, category: 'food', rating: 4.8, reviews: 156, sold: 342, icon: 'fa-mug-saucer', description: 'Single-origin, sun-dried arabica beans from the slopes of Mount Elgon. Roasted to order.' },
        { name: 'African Print Dress', price: 55000, originalPrice: 70000, category: 'clothing', rating: 4.3, reviews: 67, sold: 195, icon: 'fa-shirt', description: 'A bold Ankara-print dress cut from quality cotton, finished with a hand-sewn hem.' }
    ];

    function seedDatabase() {
        const now = Date.now();
        const users = [
            { id: 'user_demo', name: 'Amina Nakato', email: 'amina@example.com', passwordHash: hash('password123'), avatar: null, cover: null, createdAt: now }
        ];

        const stores = {
            store_demo: {
                id: 'store_demo', ownerId: 'user_demo', slug: 'amina-crafts',
                name: "Amina's Crafts & Coffee", description: 'Handmade fashion, beadwork and single-origin coffee from Kampala, made by local artisans.',
                theme: 'default', layout: 'grid',
                logo: null, banner: null,
                payments: { mtnMomo: true, airtelMoney: true, card: false },
                seo: { title: '', description: '', keywords: '', analyticsId: '' },
                followers: 1240,
                district: 'kampala',
                address: 'Nakawa Market, Shop 45',
                detailedDirections: 'Near the main entrance, next to the craft stalls',
                createdAt: now
            }
        };

        // A handful of other public stores so the marketplace / deals feed looks alive.
        const otherStores = [
            { id: 'store_ufh', name: 'Uganda Fashion Hub', slug: 'uganda-fashion-hub' },
            { id: 'store_cu', name: 'Crafts Uganda', slug: 'crafts-uganda' },
            { id: 'store_mcc', name: 'Mountain Coffee Co.', slug: 'mountain-coffee-co' }
        ];
        otherStores.forEach(s => {
            stores[s.id] = {
                id: s.id, ownerId: null, slug: s.slug, name: s.name,
                description: 'A NextaStore seller.', theme: 'default', layout: 'grid',
                logo: null, banner: null,
                payments: { mtnMomo: true, airtelMoney: false, card: false },
                seo: {}, followers: Math.floor(200 + Math.random() * 2000),
                createdAt: now
            };
        });

        const products = {};
        DEMO_PRODUCT_TEMPLATES.forEach((tpl, i) => {
            const id = `prod_demo_${i}`;
            products[id] = { id, storeId: 'store_demo', ...tpl, image: null, createdAt: now - i * 86400000 };
        });

        // A couple of extra products on other stores so the homepage deals feed has variety.
        const extras = [
            { id: 'prod_extra_1', storeId: 'store_ufh', name: 'Embroidered Gomesi', price: 120000, originalPrice: 150000, category: 'clothing', rating: 4.6, reviews: 51, sold: 74, icon: 'fa-shirt', description: 'A ceremonial Gomesi with hand embroidery along the neckline and sash.' },
            { id: 'prod_extra_2', storeId: 'store_cu', name: 'Woven Sisal Basket', price: 32000, originalPrice: null, category: 'home', rating: 4.9, reviews: 33, sold: 61, icon: 'fa-basket-shopping', description: 'A durable, hand-woven sisal basket — great for storage or as a statement piece.' },
            { id: 'prod_extra_3', storeId: 'store_mcc', name: 'Robusta Coffee (500g)', price: 11000, originalPrice: 14000, category: 'food', rating: 4.7, reviews: 98, sold: 210, icon: 'fa-mug-saucer', description: 'Bold, full-bodied robusta beans grown in the highlands around Mount Rwenzori.' }
        ];
        extras.forEach(p => { products[p.id] = { ...p, image: null, createdAt: now }; });

        const orders = {};
        const orderSeed = [
            { customerName: 'Grace Achieng', total: 63000, status: 'delivered', items: [{ productId: 'prod_demo_0', quantity: 1 }] },
            { customerName: 'Peter Okello', total: 12000, status: 'processing', items: [{ productId: 'prod_demo_1', quantity: 1 }] },
            { customerName: 'Sarah Namutebi', total: 36000, status: 'pending', items: [{ productId: 'prod_demo_2', quantity: 2 }] },
            { customerName: 'David Mugisha', total: 55000, status: 'shipped', items: [{ productId: 'prod_demo_3', quantity: 1 }] },
            { customerName: 'Esther Kirabo', total: 18000, status: 'cancelled', items: [{ productId: 'prod_demo_2', quantity: 1 }] }
        ];
        orderSeed.forEach((o, i) => {
            const id = uid('order');
            orders[id] = { id: id.replace('order_', '').slice(0, 6).toUpperCase(), storeId: 'store_demo', createdAt: now - i * 3 * 3600000, ...o };
        });

        return { users, stores, products, orders, customers: { store_demo: 186 } };
    }

    function loadDB() {
        try {
            const raw = localStorage.getItem(DB_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* fall through to reseed */ }
        const fresh = seedDatabase();
        localStorage.setItem(DB_KEY, JSON.stringify(fresh));
        return fresh;
    }

    function saveDB(db) {
        localStorage.setItem(DB_KEY, JSON.stringify(db));
    }

    function apiError(message, status) {
        const err = new Error(message);
        err.status = status || 400;
        return err;
    }

    class MockAPI {
        constructor() {
            this.db = loadDB();
        }

        getToken() {
            return localStorage.getItem(SESSION_KEY);
        }

        getCurrentUser() {
            const token = this.getToken();
            if (!token) return null;
            const userId = token.replace('token_', '');
            const user = this.db.users.find(u => u.id === userId) || null;
            return user;
        }

        getStoreForUser(userId) {
            const store = Object.values(this.db.stores).find(s => s.ownerId === userId) || null;
            return store;
        }

        /** Resolve which store the current page is looking at (storefront view). */
        resolveContextStore() {
            let slug = null;
            try {
                slug = new URLSearchParams(window.location.search).get('store');
            } catch (e) { /* noop */ }
            if (slug) {
                const bySlug = Object.values(this.db.stores).find(s => s.slug === slug);
                if (bySlug) return bySlug;
            }
            const user = this.getCurrentUser();
            if (user) {
                const owned = this.getStoreForUser(user.id);
                if (owned) return owned;
            }
            return this.db.stores.store_demo;
        }

        requireAuth() {
            const user = this.getCurrentUser();
            if (!user) throw apiError('You need to be logged in.', 401);
            return user;
        }

        async handle(endpoint, options = {}) {
            const method = (options.method || 'GET').toUpperCase();
            const body = options.body ? JSON.parse(options.body) : {};
            // Simulate a touch of network latency so loading states are visible.
            await new Promise(res => setTimeout(res, 220));

            const route = `${method} ${endpoint.split('?')[0]}`;
            const idMatch = endpoint.match(/^\/([a-z]+)\/([^/?]+)/);
            

            // ---- Auth ----
            if (route === 'POST /auth/signup') return this.signup(body);
            if (route === 'POST /auth/login') return this.login(body);
            if (route === 'POST /auth/logout') return this.logout();
            if (route === 'POST /auth/forgot-password') return this.forgotPassword(body);

            // ---- User ----
            if (route === 'GET /user/me') return this.getMe();
            if (route === 'PUT /user/me') return this.updateUser(body);
            if (route === 'POST /user/become-seller') return this.becomeSeller();

            // ---- Store ----
            if (route === 'GET /store') return this.getStore();
            if (route === 'PUT /store') return this.updateStore(body);
            if (method === 'GET' && endpoint.startsWith('/store/follow/')) return this.getFollowState(endpoint.split('/')[3]);
            if (method === 'POST' && endpoint.startsWith('/store/follow/')) return this.followStore(endpoint.split('/')[3]);
            if (method === 'DELETE' && endpoint.startsWith('/store/follow/')) return this.unfollowStore(endpoint.split('/')[3]);
            if (method === 'GET' && endpoint.startsWith('/store/follows')) return this.getFollowedStores(this.parseQuery(endpoint));
            if (route === 'GET /store/public') return this.getPublicStore();
            if (route === 'GET /store/public/all') return this.getPublicStores();
            if (method === 'GET' && endpoint.startsWith('/store/search')) return this.searchPublic(this.parseQuery(endpoint));
                        // Match /store/public/{storeId}
            if (method === 'GET' && endpoint.startsWith('/store/public/') && endpoint.split('/').length === 4) {
                const storeId = endpoint.split('/')[3];
                return this.getPublicStoreById(storeId);
            }

        // ---- Products ----
            if (route === 'GET /products/deals') return this.getDeals();
            if (route === 'GET /products/top') return this.getTopProducts();
            // Single-item lookup (/products/public/{id}) must be checked before
            // the list endpoint below — both start with '/products/public', so
            // a plain startsWith() on the list route was swallowing every
            // single-product request and handing back the whole catalog array
            // instead of one product. That's the root cause of a silent
            // "favorite button does nothing" bug: product-detail.js received
            // an array instead of an object, so `this.product.id` was
            // undefined and every favorite-related call quietly no-op'd.
            if (method === 'GET' && endpoint.startsWith('/products/public/') && endpoint.split('?')[0].split('/').length === 4) {
                const productId = endpoint.split('?')[0].split('/')[3];
                return this.getPublicProduct(productId);
            }
            if (method === 'GET' && endpoint.startsWith('/products/public')) return this.getPublicProducts(this.parseQuery(endpoint));
            if (route === 'GET /products') return this.getProducts();
            if (method === 'GET' && endpoint.startsWith('/products/store/') && endpoint.split('/').length === 4) {
                const storeId = endpoint.split('/')[3];
                return this.getProductsByStore(storeId);
            }
            if (method === 'GET' && endpoint.startsWith('/products/') && endpoint.split('/').length === 3) {
                const productId = endpoint.split('/')[2];
                return this.getPublicProduct(productId);
            }
            if (method === 'GET' && idMatch && idMatch[1] === 'products') return this.getProduct(idMatch[2]);
            if (method === 'POST' && endpoint === '/products') return this.createProduct(body);
            if (method === 'PUT' && idMatch && idMatch[1] === 'products') return this.updateProduct(idMatch[2], body);
            if (method === 'DELETE' && idMatch && idMatch[1] === 'products') return this.deleteProduct(idMatch[2]);

            // ---- Favorites ----
            if (route === 'GET /favorites') return this.getFavorites(this.parseQuery(endpoint));
            if (method === 'GET' && endpoint.startsWith('/favorites/')) return this.getFavoriteState(endpoint.split('/')[2]);
            if (method === 'POST' && endpoint.startsWith('/favorites/')) return this.addFavorite(endpoint.split('/')[2]);
            if (method === 'DELETE' && endpoint.startsWith('/favorites/')) return this.removeFavorite(endpoint.split('/')[2]);

            // ---- Notifications (development mock only) ----
            if (route === 'GET /notifications') return { data: [], unreadCount: 0, bellCount: 0 };
            if (route === 'GET /notifications/unread-count') return { data: { count: 0 } };
            if (route === 'PUT /notifications/acknowledge') return { data: { ok: true } };
            if (route === 'PUT /notifications/read-all') return { data: { ok: true } };
            if (method === 'PUT' && endpoint.startsWith('/notifications/') && endpoint.endsWith('/read')) return { data: {} };

            // ---- Payments (development mock only) ----
            if (method === 'GET' && endpoint.startsWith('/payments/methods')) return {
                data: [
                    { code: 'cash', label: 'Cash', icon: 'fa-money-bill-wave' },
                    { code: 'mtnMomo', label: 'MTN MoMo', icon: 'fa-mobile-screen' },
                    { code: 'airtelMoney', label: 'Airtel Money', icon: 'fa-mobile-screen' },
                    { code: 'card', label: 'Card', icon: 'fa-credit-card' }
                ]
            };

            // ---- Orders ----
            if (route === 'GET /orders/recent') return this.getOrders({ limit: 5 });
            if (method === 'POST' && endpoint === '/orders/public') return this.createPublicOrder(body);
            if (method === 'POST' && endpoint === '/orders/batch') return this.createBatchOrders(body);
            if (method === 'GET' && endpoint.startsWith('/orders/mine')) return this.getMineOrders(this.parseQuery(endpoint));
            if (endpoint.startsWith('/orders')) return this.getOrders(this.parseQuery(endpoint));

            // ---- Dashboard ----
            if (route === 'GET /dashboard/stats') return this.getStats();

            throw apiError(`No mock handler for ${route}`, 404);
        }

        parseQuery(endpoint) {
            const q = endpoint.split('?')[1];
            const params = {};
            if (q) new URLSearchParams(q).forEach((v, k) => { params[k] = v; });
            return params;
        }

        // ---- Auth ----
        signup({ name, email, password }) {
            if (!name || !email || !password) throw apiError('Please fill in every field.');
            if (this.db.users.some(u => u.email.toLowerCase() === String(email).toLowerCase())) {
                throw apiError('An account with that email already exists.');
            }
            const user = { id: uid('user'), name, email, passwordHash: hash(password), avatar: null, cover: null, createdAt: Date.now() };
            this.db.users.push(user);

            const store = {
                id: uid('store'), ownerId: user.id, slug: slugify(`${name}-store`),
                name: `${name}'s Store`, description: 'Tell customers what makes your store special.',
                theme: 'default', layout: 'grid', logo: null, banner: null,
                payments: { mtnMomo: true, airtelMoney: true, card: false },
                seo: { title: '', description: '', keywords: '', analyticsId: '' },
                followers: 0, createdAt: Date.now()
            };
            this.db.stores[store.id] = store;

            // Seed two starter products so a brand-new store isn't a blank slate.
            DEMO_PRODUCT_TEMPLATES.slice(0, 2).forEach((tpl, i) => {
                const id = uid('prod');
                this.db.products[id] = { id, storeId: store.id, ...tpl, image: null, createdAt: Date.now() - i * 86400000 };
            });

            saveDB(this.db);
            const token = `token_${user.id}`;
            localStorage.setItem(SESSION_KEY, token);
            return { token, user: this.publicUser(user) };
        }

        login({ email, password }) {
            const user = this.db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
            if (!user || user.passwordHash !== hash(password || '')) {
                throw apiError('That email and password don\u2019t match our records.', 401);
            }
            const token = `token_${user.id}`;
            localStorage.setItem(SESSION_KEY, token);
            // Also save user data to localStorage for immediate use
            localStorage.setItem('nextastore_user', JSON.stringify(this.publicUser(user)));
            return { token, user: this.publicUser(user) };
        }

        logout() {
            localStorage.removeItem(SESSION_KEY);
            return { data: {} };
        }

        forgotPassword({ email }) {
            if (!email) throw apiError('Enter the email address on your account.');
            // In the real API this queues a reset email; here we just acknowledge it.
            return { data: { message: 'If that email exists, a reset link is on its way.' } };
        }

        getMe() {
            const user = this.requireAuth();
            return { data: this.publicUser(user) };
        }

        publicUser(user) {
            return { id: user.id, name: user.name, email: user.email, avatar: user.avatar || null, cover: user.cover || null };
        }

        becomeSeller() {
            const user = this.requireAuth();
            if (user.role === 'seller') throw apiError('This account is already a seller account.');
            user.role = 'seller';
            const store = {
                id: uid('store'), ownerId: user.id, slug: slugify(`${user.name}-store`),
                name: `${user.name}'s Store`, description: 'Tell customers what makes your store special.',
                theme: 'default', layout: 'grid', logo: null, banner: null,
                payments: { mtnMomo: true, airtelMoney: true, card: false },
                seo: { title: '', description: '', keywords: '', analyticsId: '' },
                followers: 0, createdAt: Date.now()
            };
            this.db.stores[store.id] = store;
            saveDB(this.db);
            return { data: { id: user.id, name: user.name, email: user.email, role: 'seller', avatar: user.avatar || null, cover: user.cover || null, emailVerified: !!user.emailVerifiedAt } };
        }

        updateUser(payload) {
            const user = this.requireAuth();
            if (payload.name !== undefined) {
                if (!String(payload.name).trim()) throw apiError('Name can\u2019t be empty.');
                user.name = String(payload.name).trim();
            }
            if (payload.avatar !== undefined) user.avatar = payload.avatar;
            if (payload.cover !== undefined) user.cover = payload.cover;

            if (payload.newPassword) {
                if (!payload.currentPassword || user.passwordHash !== hash(payload.currentPassword)) {
                    throw apiError('Current password is incorrect.', 401);
                }
                if (String(payload.newPassword).length < 6) {
                    throw apiError('Use a new password with at least 8 characters.');
                }
                user.passwordHash = hash(payload.newPassword);
            }

            saveDB(this.db);
            return { data: this.publicUser(user) };
        }

        // ---- Store ----
        getStore() {
            const user = this.requireAuth();
            let store = this.getStoreForUser(user.id);
            if (!store) throw apiError('No store found for this account.', 404);
            return { data: store };
        }

        getPublicStore() {
            const store = this.resolveContextStore();
            const productCount = Object.values(this.db.products).filter(p => p.storeId === store.id).length;
            return { data: { ...store, productCount } };
        }

        searchPublic({ q = '', limit = 6 } = {}) {
            const term = String(q).trim().toLowerCase();
            if (term.length < 2) return { data: { stores: [], products: [] } };
            const stores = Object.values(this.db.stores).filter(s => `${s.name} ${s.description || ''}`.toLowerCase().includes(term)).slice(0, 3);
            const products = Object.values(this.db.products).filter(p => {
                const store = this.db.stores[p.storeId];
                return store && `${p.name} ${p.description || ''} ${p.category || ''}`.toLowerCase().includes(term);
            }).slice(0, Number(limit) || 6);
            return { data: {
                stores: stores.map(s => ({ ...s, productCount: Object.values(this.db.products).filter(p => p.storeId === s.id).length })),
                products: products.map(p => ({ ...p, storeName: this.db.stores[p.storeId]?.name || 'Seller', storeSlug: this.db.stores[p.storeId]?.slug || null }))
            }};
        }

        getPublicStores() {
            const stores = Object.values(this.db.stores).map(store => {
                const productCount = Object.values(this.db.products).filter(p => p.storeId === store.id).length;
                return { ...store, productCount };
            });
            return { data: stores };
        }

        getPublicStoreById(storeId) {
            const store = this.db.stores[storeId];
            if (!store) {
                console.error('Store not found:', storeId);
                throw apiError('Store not found', 404);
            }
            const productCount = Object.values(this.db.products).filter(p => p.storeId === store.id).length;
            return { data: { ...store, productCount } };
        }

        updateStore(payload) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            if (!store) throw apiError('No store found for this account.', 404);
            Object.assign(store, payload, { id: store.id, ownerId: store.ownerId });
            saveDB(this.db);
            return { data: store };
        }

        getFollowState(storeId) {
            // Was reading `this.user`, a property this class never sets (it
            // always reads the logged-in user fresh via getCurrentUser(),
            // the same way requireAuth() does) — so this always saw a
            // logged-out visitor and reported `following: false` even right
            // after a successful follow. Harmless while the button stayed
            // on the same page (followStore()/unfollowStore() update
            // `this.isFollowing` locally), but it meant the Follow button
            // silently forgot it was following on every reload.
            const user = this.getCurrentUser();
            const store = this.db.stores[storeId];
            if (!store) throw apiError('Store not found', 404);
            const follows = this.db.follows || {};
            const key = user ? `${user.id}:${storeId}` : null;
            return { data: { following: !!(key && follows[key]), followers: Number(store.followers || 0) } };
        }

        followStore(storeId) {
            const user = this.requireAuth();
            const store = this.db.stores[storeId];
            if (!store) throw apiError('Store not found', 404);
            this.db.follows = this.db.follows || {};
            const key = `${user.id}:${storeId}`;
            if (!this.db.follows[key]) { this.db.follows[key] = { storeId, createdAt: Date.now() }; store.followers = Math.max(0, Number(store.followers || 0) + 1); saveDB(this.db); }
            return { data: { following: true, followers: store.followers } };
        }

        unfollowStore(storeId) {
            const user = this.requireAuth();
            const store = this.db.stores[storeId];
            if (!store) throw apiError('Store not found', 404);
            this.db.follows = this.db.follows || {};
            const key = `${user.id}:${storeId}`;
            if (this.db.follows[key]) { delete this.db.follows[key]; store.followers = Math.max(0, Number(store.followers || 0) - 1); saveDB(this.db); }
            return { data: { following: false, followers: store.followers } };
        }

        // Mirrors getFavorites() below, per-store instead of per-product —
        // backs the "Following" page/link.
        getFollowedStores({ page = 1, limit = 24 } = {}) {
            const user = this.requireAuth();
            page = Math.max(1, Number(page) || 1);
            limit = Math.min(60, Math.max(1, Number(limit) || 24));
            this.db.follows = this.db.follows || {};
            const prefix = `${user.id}:`;
            const rows = Object.entries(this.db.follows)
                .filter(([key]) => key.startsWith(prefix))
                .map(([, v]) => v)
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(v => this.db.stores[v.storeId])
                .filter(Boolean)
                .map(s => ({ ...s, productCount: Object.values(this.db.products).filter(p => p.storeId === s.id).length }));
            const total = rows.length;
            const start = (page - 1) * limit;
            return {
                data: rows.slice(start, start + limit),
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
            };
        }

        // ---- Favorites (mirrors follows above, per-product instead of per-store) ----
        getFavoriteState(productId) {
            const user = this.getCurrentUser();
            const favorites = this.db.favorites || {};
            const key = user ? `${user.id}:${productId}` : null;
            return { data: { favorited: !!(key && favorites[key]) } };
        }

        addFavorite(productId) {
            const user = this.requireAuth();
            const product = this.db.products[productId];
            if (!product) throw apiError('Product not found.', 404);
            this.db.favorites = this.db.favorites || {};
            const key = `${user.id}:${productId}`;
            if (!this.db.favorites[key]) { this.db.favorites[key] = { productId, createdAt: Date.now() }; saveDB(this.db); }
            return { data: { favorited: true } };
        }

        removeFavorite(productId) {
            const user = this.requireAuth();
            this.db.favorites = this.db.favorites || {};
            const key = `${user.id}:${productId}`;
            if (this.db.favorites[key]) { delete this.db.favorites[key]; saveDB(this.db); }
            return { data: { favorited: false } };
        }

        getFavorites({ page = 1, limit = 24 } = {}) {
            const user = this.requireAuth();
            page = Math.max(1, Number(page) || 1);
            limit = Math.min(60, Math.max(1, Number(limit) || 24));
            this.db.favorites = this.db.favorites || {};
            const prefix = `${user.id}:`;
            const rows = Object.entries(this.db.favorites)
                .filter(([key]) => key.startsWith(prefix))
                .map(([, v]) => v)
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(v => this.db.products[v.productId])
                .filter(Boolean)
                .map(p => {
                    const store = this.db.stores[p.storeId];
                    return { ...p, storeName: store ? store.name : 'NextaStore Seller', storeSlug: store ? store.slug : null };
                });
            const total = rows.length;
            const start = (page - 1) * limit;
            return {
                data: rows.slice(start, start + limit),
                pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
            };
        }

        // ---- Products ----
        getProducts() {
            // For public access, return all products
            const list = Object.values(this.db.products);
            return { data: list };
        }

        getProductsByStore(storeId) {
            const store = this.db.stores[storeId];
            if (!store) {
                console.error('Store not found:', storeId);
                throw apiError('Store not found', 404);
            }
            const list = Object.values(this.db.products).filter(p => p.storeId === store.id);
            return { data: list };
        }

        getDeals() {
            const list = Object.values(this.db.products)
                .filter(p => p.originalPrice && p.originalPrice > p.price)
                .sort((a, b) => (b.sold || 0) - (a.sold || 0))
                .slice(0, 8)
                .map(p => {
                    const store = this.db.stores[p.storeId];
                    return {
                        ...p,
                        discount: Math.round((1 - p.price / p.originalPrice) * 100),
                        storeName: store ? store.name : 'NextaStore Seller',
                        storeSlug: store ? store.slug : null
                    };
                });
            return { data: list };
        }

        // Mirrors the real GET /products/public endpoint (marketplace-wide
        // catalog, all stores) so ?mock=1 mode has something for the
        // marketplace's Trending/search grid to show beyond the 8 deals.
        getPublicProducts({ q = '', limit = 60, page = 1 } = {}) {
            const term = String(q).trim().toLowerCase();
            const all = Object.values(this.db.products).filter(p => {
                const store = this.db.stores[p.storeId];
                if (!store) return false;
                if (!term) return true;
                return `${p.name} ${p.description || ''} ${p.category || ''} ${store.name || ''}`.toLowerCase().includes(term);
            });
            const safeLimit = Math.min(60, Math.max(1, Number(limit) || 60));
            const safePage = Math.max(1, Number(page) || 1);
            const start = (safePage - 1) * safeLimit;
            const list = all.slice(start, start + safeLimit).map(p => {
                const store = this.db.stores[p.storeId];
                return {
                    ...p,
                    storeName: store ? store.name : 'NextaStore Seller',
                    storeSlug: store ? store.slug : null
                };
            });
            return { data: list, pagination: { page: safePage, limit: safeLimit, total: all.length, pages: Math.ceil(all.length / safeLimit) || 1 } };
        }

        getProduct(id) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            const product = this.db.products[id];
            if (!product || !store || product.storeId !== store.id) throw apiError('Product not found.', 404);
            return { data: product };
        }

        getPublicProduct(id) {
            const product = this.db.products[id];
            if (!product) {
                console.error('Product not found:', id);
                throw apiError('Product not found.', 404);
            }
            return { data: product };
        }

        getTopProducts() {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            if (!store) return { data: [] };
            const list = Object.values(this.db.products)
                .filter(p => p.storeId === store.id)
                .sort((a, b) => (b.sold || 0) - (a.sold || 0))
                .slice(0, 5);
            return { data: list };
        }

        createProduct(payload) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            if (!store) throw apiError('No store found for this account.', 404);
            if (!payload.name || !payload.price) throw apiError('Name and price are required.');
            const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];
            const id = uid('prod');
            const product = {
                id, storeId: store.id,
                name: payload.name,
                description: payload.description || '',
                price: Number(payload.price),
                originalPrice: payload.originalPrice ? Number(payload.originalPrice) : null,
                category: payload.category || 'other',
                images,
                image: images[0] || payload.image || null,
                icon: payload.icon || 'fa-box',
                stock: payload.stock !== undefined ? Number(payload.stock) : 0,
                rating: 0, reviews: 0, sold: 0,
                createdAt: Date.now()
            };
            this.db.products[id] = product;
            saveDB(this.db);
            return { data: product };
        }

        updateProduct(id, payload) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            const product = this.db.products[id];
            if (!product || !store || product.storeId !== store.id) throw apiError('Product not found.', 404);
            Object.assign(product, payload, { id: product.id, storeId: product.storeId });
            if (payload.price !== undefined) product.price = Number(payload.price);
            if (payload.originalPrice !== undefined) product.originalPrice = payload.originalPrice ? Number(payload.originalPrice) : null;
            if (payload.stock !== undefined) product.stock = Number(payload.stock);
            if (Array.isArray(payload.images)) {
                product.images = payload.images.filter(Boolean);
                product.image = product.images[0] || null;
            }
            saveDB(this.db);
            return { data: product };
        }

        deleteProduct(id) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            const product = this.db.products[id];
            if (!product || !store || product.storeId !== store.id) throw apiError('Product not found.', 404);
            delete this.db.products[id];
            saveDB(this.db);
            return { data: { id } };
        }

        // ---- Orders ----
        createPublicOrder(payload) {
            const store = this.resolveContextStore();
            if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
                throw apiError('Your cart is empty.');
            }
            if (!payload.customerName || !payload.customerPhone) {
                throw apiError('Please provide your name and phone number.');
            }
            const total = payload.items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
            const key = uid('order');
            const order = {
                id: key.replace('order_', '').slice(0, 6).toUpperCase(),
                storeId: store.id,
                customerName: payload.customerName,
                customerPhone: payload.customerPhone,
                items: payload.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
                total,
                status: 'pending',
                createdAt: Date.now()
            };
            this.db.orders[key] = order;
            saveDB(this.db);
            return { data: order };
        }

        createBatchOrders(payload) {
            const user = this.requireAuth();
            if (!payload?.stores?.length) throw apiError('Your cart is empty.');
            const orders=[];
            for (const group of payload.stores) {
                const store=this.db.stores[group.storeId]; if(!store) throw apiError('Store not found.',404);
                let total=0; const items=[];
                for(const line of group.items){ const p=this.db.products[line.productId]; if(!p||p.storeId!==store.id) throw apiError('One of the items is no longer available.',409); if(Number(p.stock)<Number(line.quantity)) throw apiError(`Only ${p.stock} left of "${p.name}".`,409); p.stock-=Number(line.quantity); p.sold=(p.sold||0)+Number(line.quantity); total+=Number(p.price)*Number(line.quantity); items.push({productId:p.id,productName:p.name,quantity:Number(line.quantity),unitPrice:Number(p.price)}); }
                const id=uid('order').replace('order_','').slice(0,6).toUpperCase(); const order={id,storeId:store.id,buyerId:user.id,customerName:payload.customerName,customerPhone:payload.customerPhone,deliveryAddress:payload.deliveryAddress||'',items,total,status:'pending',createdAt:Date.now()}; this.db.orders[id]=order; orders.push({...order,store:{id:store.id,slug:store.slug,name:store.name,logo:store.logo}});
            }
            saveDB(this.db); return {data:orders};
        }

        getMineOrders({page=1,limit=10}={}) {
            const user=this.requireAuth(); const all=Object.values(this.db.orders).filter(o=>o.buyerId===user.id).sort((a,b)=>b.createdAt-a.createdAt); const p=Math.max(1,Number(page)||1), l=Math.max(1,Number(limit)||10), data=all.slice((p-1)*l,p*l).map(o=>({...o,store:this.db.stores[o.storeId]||null})); return {data,pagination:{page:p,limit:l,total:all.length,pages:Math.ceil(all.length/l)||1}};
        }

        getOrders({ limit, status } = {}) {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            if (!store) return { data: [] };
            let list = Object.values(this.db.orders)
                .filter(o => o.storeId === store.id)
                .sort((a, b) => b.createdAt - a.createdAt);
            if (status) list = list.filter(o => o.status === status);
            if (limit) list = list.slice(0, Number(limit));
            return { data: list };
        }

        // ---- Dashboard ----
        getStats() {
            const user = this.requireAuth();
            const store = this.getStoreForUser(user.id);
            if (!store) return { data: { totalOrders: 0, totalRevenue: 0, totalCustomers: 0, totalProducts: 0 } };
            const orders = Object.values(this.db.orders).filter(o => o.storeId === store.id);
            const products = Object.values(this.db.products).filter(p => p.storeId === store.id);
            const totalRevenue = orders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + o.total, 0);
            return {
                data: {
                    totalOrders: orders.length,
                    totalRevenue,
                    totalCustomers: this.db.customers[store.id] || Math.max(orders.length, 0),
                    totalProducts: products.length
                }
            };
        }
    }

    global.MockAPI = new MockAPI();
})(window);
