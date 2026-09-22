const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const cache = require('./cache');

// express-rate-limit's default MemoryStore counts requests per-process. The
// moment this app runs as more than one instance (the normal way to scale
// it horizontally, since auth here is stateless JWT), each instance gets
// its own separate counter — a client effectively gets `limit` requests
// PER INSTANCE instead of in total, and the limiter stops doing its job.
// Use a shared Redis store when REDIS_URL is configured (see cache.js);
// omit `store` entirely otherwise so express-rate-limit's own MemoryStore
// is used, which is fine for local dev / a single instance.
function sharedStore() {
    if (!cache.isRedisEnabled()) return undefined;
    try {
        const RedisStore = require('rate-limit-redis');
        return new RedisStore({
            sendCommand: (...args) => cache.redisClient.call(...args)
        });
    } catch (err) {
        console.warn('[rate-limit] REDIS_URL is set but "rate-limit-redis" isn\u2019t installed (run `npm install`). Falling back to a per-instance in-memory limiter.');
        return undefined;
    }
}
const { notFound, errorHandler } = require('./middleware');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const storeRoutes = require('./routes/store');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');
const messageRoutes = require('./routes/messages');
const notificationRoutes = require('./routes/notifications');
const paymentRoutes = require('./routes/payments');
const reviewRoutes = require('./routes/reviews');
const favoriteRoutes = require('./routes/favorites');
const adminRoutes = require('./routes/admin');
const subscriptionRoutes = require('./routes/subscription');
const pushRoutes = require('./routes/push');
const presenceRoutes = require('./routes/presence');
const seoRoutes = require('./routes/seo');

const app = express();

// Railway (and any platform that fronts the app with a reverse proxy/load
// balancer) delivers every request from the proxy's own IP, with the real
// client IP only in X-Forwarded-For. Without telling Express to trust that
// proxy hop, two things break — both invisible at low traffic and both
// exactly the kind of bug that surfaces the moment real concurrent users
// show up:
//   1. req.ip resolves to the proxy's IP for EVERY request, so
//      express-rate-limit (keyed on req.ip below and in auth.js) puts every
//      visitor in the same bucket. Under real traffic that means the first
//      ~120 requests/min from ALL shoppers combined exhausts the public
//      catalog limiter, and everyone after that gets 429'd together.
//   2. express-rate-limit v7 actively validates this and throws at request
//      time when it sees X-Forwarded-For but trust proxy isn't configured,
//      which would 500 every rate-limited route in production.
// `1` = trust exactly one hop (the platform's own proxy) — enough for
// Railway/Render/Heroku-style single-proxy deploys. If this ever sits
// behind an additional CDN/proxy layer, this number needs to grow to match
// the number of hops, or req.ip becomes spoofable by a client-supplied
// X-Forwarded-For header instead.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map(o => o.trim()),
    // Without this the browser strips X-Session-Token from cross-origin
    // responses and the sliding-expiry renewal silently never reaches the
    // frontend — sessions would then still die at the hard cap.
    exposedHeaders: ['X-Session-Token']
}));
// Gzip/brotli-negotiated compression for every JSON response. Paginated
// list endpoints already cap how many rows come back, but the payload for
// even one page (product grids with descriptions, order histories with
// line items, admin tables) only grows as the catalog grows — compression
// is what keeps that transfer fast on a slow/mobile connection without
// having to shrink the page size itself. Cheap in CPU terms relative to
// the bytes it saves; skip it only for responses under ~1KB by default
// (compression's own threshold), where the overhead isn't worth it.
app.use(compression());
app.use(config.isProd ? morgan('combined') : morgan('dev'));
// Product photos, avatars, and store logos/banners arrive as base64 JSON,
// so the routes that actually save one of those need a generous limit.
// Every other route — auth included — only ever receives plain JSON, and
// used to share this SAME 50MB ceiling: an unauthenticated POST to
// /auth/login or /auth/signup could send an up-to-50MB body before hitting
// any rate limiter (limiter middleware runs per-route, after the body is
// already parsed). Two parsers instead of one: the generous limit is
// mounted first, but only on the specific upload-capable route prefixes, so
// it "claims" the body there; body-parser sets req._body once it has
// parsed a request, so the second, small-limit parser below silently skips
// anything the first one already handled and only ever applies its 100kb
// ceiling to the routes that were never meant to need more than that.
const uploadJsonLimiter = express.json({ limit: '20mb' });
app.use(['/api/user', '/api/store', '/api/products'], uploadJsonLimiter);
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// The public catalog/search endpoints have no login to gate them (that's
// the point — anyone can browse), which also makes them the easiest thing
// on this API to scrape or accidentally hammer from a buggy client. Login/
// signup already had brute-force protection (src/routes/auth.js); these
// share the same mechanism but with a much higher ceiling since real
// shoppers legitimately fire several of these per page load (grid +
// autocomplete + individual product/store lookups).
const publicCatalogLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: sharedStore(),
    message: { message: 'Too many requests. Please slow down and try again shortly.' }
});
app.use(['/api/products/public', '/api/products/deals', '/api/store/public', '/api/store/search'], publicCatalogLimiter);

// Baseline ceiling for every other /api route (dashboard, orders, messages,
// notifications, reviews, favorites, admin, subscription) — none of these
// had any rate limiting before, so a single runaway client (a buggy retry
// loop, a scraper, or a compromised account) could otherwise consume
// unlimited backend/DB capacity and degrade the service for every other
// concurrent user. Generous on purpose: this is a safety net against abuse,
// not a throttle on normal authenticated usage. It stacks with (doesn't
// replace) the tighter auth and public-catalog limiters above.
const generalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    store: sharedStore(),
    message: { message: 'Too many requests. Please slow down and try again shortly.' }
});
app.use('/api', generalApiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/presence', presenceRoutes);

// Search-engine surface: /s/<slug> store pages, /sitemap.xml, /robots.txt.
// Crawlers hit these unauthenticated, so they get the same per-IP ceiling as
// the public catalog. In production a reverse proxy must forward these paths
// to this server (see README "Search engine visibility").
app.use(['/s', '/sitemap.xml', '/robots.txt'], publicCatalogLimiter);
app.use(seoRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
