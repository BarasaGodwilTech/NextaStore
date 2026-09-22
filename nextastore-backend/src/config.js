require('dotenv').config();

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

// Fail fast on boot rather than limping along with an insecure default.
// A missing JWT_SECRET or DATABASE_URL in production is a deploy-config bug,
// not something the app should silently paper over.
if (isProd) {
    required('DATABASE_URL');
    required('JWT_SECRET');
    required('FRONTEND_URL');
    required('PUBLIC_URL');
    required('SMTP_HOST');
    required('SMTP_FROM');
    required('R2_ENDPOINT');
    required('R2_ACCESS_KEY_ID');
    required('R2_SECRET_ACCESS_KEY');
    required('R2_BUCKET_NAME');
    required('R2_PUBLIC_URL');
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*') {
        throw new Error('CORS_ORIGIN must be set to your real frontend origin(s) in production (not "*").');
    }
    // Not fatal — Prisma works fine without this — but worth a loud warning
    // at boot rather than discovering it as connection-pool exhaustion
    // during a traffic spike. See the comment on DATABASE_URL in
    // .env.example for what to add and why.
    if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL || '')) {
        console.warn('  WARNING: DATABASE_URL has no explicit connection_limit param. Prisma will default to (CPU cores * 2 + 1) connections, which is easy to exhaust under concurrent load. Add ?connection_limit=10&pool_timeout=20 (see .env.example).');
    }
}

// R2 (or any S3-compatible bucket) for image storage. This is the only image
// storage backend — there is no local-disk fallback. Required in production
// (enforced above); in development, saving an image without these set throws
// a clear error at upload time rather than silently writing to disk.
const r2 = {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET_NAME || '',
    publicUrl: process.env.R2_PUBLIC_URL || ''
};
const r2Enabled = !!(r2.endpoint && r2.accessKeyId && r2.secretAccessKey && r2.bucket && r2.publicUrl);

// ---------------------------------------------------------------------------
// Session lifetime parsing
// ---------------------------------------------------------------------------
// jsonwebtoken's `expiresIn` is dangerously overloaded:
//   - a NUMBER is read as seconds
//   - a STRING is read by the `ms` package, which treats a bare numeric
//     string as MILLISECONDS
// Environment variables are always strings, so the natural-looking
// `JWT_EXPIRES_IN=86400` ("a day, in seconds") silently produced an 86ms
// -> 86 second session, and `JWT_EXPIRES_IN=30` produced a token that was
// already expired by the time the login response reached the browser. That
// is the "logged out the moment I sign in" report.
//
// parseTtl() removes the ambiguity: bare numbers are returned as NUMBERS so
// jsonwebtoken reads them as seconds (what anybody setting this actually
// means), unit strings like '30d' are passed through, and anything
// unparseable or implausibly short falls back to a safe default with a loud
// warning instead of quietly logging everyone out.
const TTL_UNIT_PATTERN = /^\d+(\.\d+)?\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years)$/i;
const MIN_TTL_SECONDS = 300; // 5 minutes — below this is a config mistake, not a policy

function parseTtl(raw, fallback, name) {
    const value = String(raw ?? '').trim();
    if (!value) return fallback;

    if (/^\d+$/.test(value)) {
        const seconds = Number(value);
        if (seconds >= MIN_TTL_SECONDS) return seconds; // number => seconds, unambiguous
        console.warn(`[config] ${name}="${value}" looks like a mistake: a bare number is read as SECONDS, and ${seconds}s would log people out almost immediately. Falling back to "${fallback}". Use a unit (e.g. "2d", "12h") to be explicit.`);
        return fallback;
    }

    if (TTL_UNIT_PATTERN.test(value)) return value;

    console.warn(`[config] ${name}="${value}" is not a valid timespan. Falling back to "${fallback}". Use a number of seconds (e.g. 172800) or a unit string (e.g. "2d").`);
    return fallback;
}

// ---------------------------------------------------------------------------
// Session lifetimes
// ---------------------------------------------------------------------------
// Every session has TWO clocks:
//   1. an INACTIVITY window (the *_EXPIRES_IN values): a token slides forward
//      only while the person is really using the site (see attachRenewedToken
//      in middleware.js — background polls do not count), and
//   2. an ABSOLUTE cap (the *_MAX_AGE values), measured from the moment they
//      actually typed their password. A token can never be renewed past it,
//      however active the session is. Before this existed a token that was
//      used at least once per window lived forever.
// "Remember me" sessions last a month of inactivity and at most 90 days in
// total; a plain login lasts two days of inactivity and at most a week.
// Admins never get "remember me": one hour of inactivity, twelve hours total.
// JWT_EXPIRES_IN keeps its original meaning (the long, "Remember me"
// lifetime) so existing deploys that set it to 30d are unaffected.
const rememberTtl = parseTtl(process.env.JWT_REMEMBER_EXPIRES_IN || process.env.JWT_EXPIRES_IN, '30d', 'JWT_REMEMBER_EXPIRES_IN');
const sessionTtl = parseTtl(process.env.JWT_SESSION_EXPIRES_IN, '2d', 'JWT_SESSION_EXPIRES_IN');
const adminTtl = parseTtl(process.env.JWT_ADMIN_EXPIRES_IN, '1h', 'JWT_ADMIN_EXPIRES_IN');
const rememberMaxAge = parseTtl(process.env.JWT_REMEMBER_MAX_AGE, '90d', 'JWT_REMEMBER_MAX_AGE');
const sessionMaxAge = parseTtl(process.env.JWT_SESSION_MAX_AGE, '7d', 'JWT_SESSION_MAX_AGE');
const adminMaxAge = parseTtl(process.env.JWT_ADMIN_MAX_AGE, '12h', 'JWT_ADMIN_MAX_AGE');

const TTL_UNIT_SECONDS = {
    ms: 0.001,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
    w: 604800, week: 604800, weeks: 604800,
    y: 31557600, yr: 31557600, yrs: 31557600, year: 31557600, years: 31557600
};

// Tokens carry an explicit `exp` (see signSessionToken), so lifetimes are
// needed as plain seconds rather than as jsonwebtoken timespan strings.
function ttlSeconds(value) {
    if (typeof value === 'number') return Math.floor(value);
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(String(value).trim());
    if (!match) return NaN;
    return Math.floor(Number(match[1]) * TTL_UNIT_SECONDS[match[2].toLowerCase()]);
}

// An absolute cap shorter than the inactivity window would make the window
// meaningless, so the cap is never allowed below it.
function sessionPolicy(ttl, maxAge) {
    const ttlSecs = ttlSeconds(ttl);
    return { ttlSeconds: ttlSecs, maxAgeSeconds: Math.max(ttlSeconds(maxAge), ttlSecs) };
}

// ---------------------------------------------------------------------------
// Web Push (VAPID)
// ---------------------------------------------------------------------------
// Push is treated as an optional feature, not a boot requirement: a store
// that hasn't generated keys yet should still be able to start the API and
// serve everything else. `pushEnabled` is what src/push.js and
// routes/push.js gate on; GET /api/push/public-key reports it to the
// frontend so the browser never asks for notification permission on a
// deployment that can't actually deliver a push.
const vapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // The push services (Chrome/FxA/etc.) contact this if they need to reach
    // the sender about a subscription problem. web-push requires it to be
    // set whenever keys are configured.
    subject: process.env.VAPID_SUBJECT || 'mailto:support@nextastore.app'
};
const pushEnabled = !!(vapid.publicKey && vapid.privateKey);

if (isProd && !pushEnabled) {
    console.warn('  WARNING: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set. Push notifications are disabled -- run "npm run generate:vapid-keys" once and add the output to your environment. See .env.example.');
}

module.exports = {
    env,
    isProd,
    port: Number(process.env.PORT) || 4000,
    jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
    // How long a session lasts. Two values: one for "Remember me" logins,
    // one for everything else. See parseTtl() above for why these are
    // sanitised rather than passed to jsonwebtoken raw.
    jwtExpiresIn: rememberTtl, // legacy alias: the long lifetime
    jwtRememberTtl: rememberTtl,
    jwtSessionTtl: sessionTtl,
    // Resolved policies, in seconds: { ttlSeconds, maxAgeSeconds }.
    sessionPolicies: {
        remember: sessionPolicy(rememberTtl, rememberMaxAge),
        session: sessionPolicy(sessionTtl, sessionMaxAge),
        admin: sessionPolicy(adminTtl, adminMaxAge)
    },
    corsOrigin: process.env.CORS_ORIGIN || '*',
    publicUrl: process.env.PUBLIC_URL || '',
    // Base URL of the static frontend (http-server on :3000 in dev) — used
    // to build links that go into emails (password reset, email
    // verification), which need an absolute URL the recipient can click.
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    // Public origin that search engines and link previews see: the host of
    // /s/<slug>, /sitemap.xml and /robots.txt. In production this is the same
    // domain as the frontend (a reverse proxy forwards those three paths to
    // this API — see README "Search engine visibility"). In development it
    // defaults to this server so /s/<slug> can be opened directly.
    siteUrl: (process.env.SITE_URL || (env === 'production' ? process.env.FRONTEND_URL : `http://localhost:${Number(process.env.PORT) || 4000}`) || '').replace(/\/$/, ''),
    r2,
    r2Enabled,
    vapid,
    pushEnabled
};
