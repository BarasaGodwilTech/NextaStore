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
    // The secret signs every login token. A short or placeholder value can be
    // guessed offline from one token, and anyone who guesses it can mint a
    // token for any account (admins included).
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret.length < 32 || /change[-_ ]?me|dev-only|secret|password|example/i.test(jwtSecret)) {
        throw new Error('JWT_SECRET must be a random string of at least 32 characters (try: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))").');
    }
    // The Staff Console signs its short-lived sign-in challenges with its OWN secret, so a leaked or guessed shopper JWT secret can never
    // be used against staff, and vice versa.
    const staffSecret = required('STAFF_SECRET');
    if (staffSecret.length < 32 || staffSecret === jwtSecret || /change[-_ ]?me|dev-only|secret|password|example/i.test(staffSecret)) {
        throw new Error('STAFF_SECRET must be a random string of at least 32 characters and must differ from JWT_SECRET.');
    }
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
// Staff sessions are separate (see `staff` below): server-side, 30 minutes idle, 12 hours absolute.
// JWT_EXPIRES_IN keeps its original meaning (the long, "Remember me"
// lifetime) so existing deploys that set it to 30d are unaffected.
const rememberTtl = parseTtl(process.env.JWT_REMEMBER_EXPIRES_IN || process.env.JWT_EXPIRES_IN, '30d', 'JWT_REMEMBER_EXPIRES_IN');
const sessionTtl = parseTtl(process.env.JWT_SESSION_EXPIRES_IN, '2d', 'JWT_SESSION_EXPIRES_IN');
const rememberMaxAge = parseTtl(process.env.JWT_REMEMBER_MAX_AGE, '90d', 'JWT_REMEMBER_MAX_AGE');
const sessionMaxAge = parseTtl(process.env.JWT_SESSION_MAX_AGE, '7d', 'JWT_SESSION_MAX_AGE');

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

// ---------------------------------------------------------------------------
// Staff Console (src/staff/)
// ---------------------------------------------------------------------------
const intEnv = (name, fallback, min = 1) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= min ? n : fallback; };
const frontOrigin = (() => { try { return new URL(process.env.FRONTEND_URL || 'http://localhost:3000').origin; } catch (e) { return 'http://localhost:3000'; } })();
const staffSecret = process.env.STAFF_SECRET || 'dev-only-staff-secret-change-me-32chars!!';
const staff = {
    // Signs the short sign-in challenge (between password and MFA). NOT the shopper JWT secret.
    secret: staffSecret,
    // Key that encrypts every staff member's TOTP secret at rest. Defaults to a key derived from STAFF_SECRET; set STAFF_MFA_KEY to rotate independently.
    mfaKey: process.env.STAFF_MFA_KEY || staffSecret,
    issuer: process.env.STAFF_MFA_ISSUER || 'NextaStore Staff',
    cookieName: 'nxs_staff',
    idleMinutes: intEnv('STAFF_IDLE_MINUTES', 30),
    absoluteHours: intEnv('STAFF_SESSION_HOURS', 12),
    maxSessions: intEnv('STAFF_MAX_SESSIONS', 5),
    lockoutAttempts: intEnv('STAFF_LOCKOUT_ATTEMPTS', 5),
    lockoutMinutes: intEnv('STAFF_LOCKOUT_MINUTES', 15),
    reauthMinutes: intEnv('STAFF_REAUTH_MINUTES', 10),
    challengeMinutes: 5,
    // Risk-based two-step verification: the authenticator code is always asked on the first sign-in, on a browser we have not
    // seen, when a remembered browser has expired, and when a sign-in looks suspicious (src/staff/risk.js).
    deviceCookieName: 'nxs_dev',
    deviceTrustDays: intEnv('STAFF_DEVICE_TRUST_DAYS', 30),
    // Roles at or above this rank (default: Super Admin only) must enter the code on EVERY sign-in. Set 0 to disable the exception.
    mfaAlwaysRank: intEnv('STAFF_MFA_ALWAYS_RANK', 100, 0),
    // Sensitive-action PIN
    pinLockoutAttempts: intEnv('STAFF_PIN_LOCKOUT_ATTEMPTS', 5),
    pinLockoutMinutes: intEnv('STAFF_PIN_LOCKOUT_MINUTES', 15),
    inviteHours: intEnv('STAFF_INVITE_HOURS', 48),
    resetMinutes: 60,
    // Comma-separated IPs/CIDRs (IPv4). Empty = no restriction. When set, /api/staff answers 404 to everyone else.
    ipAllowlist: String(process.env.STAFF_IP_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean),
    // Origins whose pages may call /api/staff with cookies. Defaults to the site itself (+ localhost in development).
    origins: Array.from(new Set([frontOrigin, ...String(process.env.STAFF_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean),
        ...(isProd ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'])])),
    // Where the console lives, for links in emails. A dedicated host (https://staff.example.com) is recommended; a path on the site works too.
    consoleUrl: (process.env.STAFF_CONSOLE_URL || `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/staff`).replace(/\/$/, ''),
    cookieSecure: isProd || String(process.env.STAFF_COOKIE_SECURE || '').toLowerCase() === 'true'
};

module.exports = {
    env,
    staff,
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
        session: sessionPolicy(sessionTtl, sessionMaxAge)
    },
    corsOrigin: process.env.CORS_ORIGIN || '*',
    publicUrl: process.env.PUBLIC_URL || '',
    // Base URL of the static frontend (http-server on :3000 in dev) — used
    // to build links that go into emails (password reset, email
    // verification), which need an absolute URL the recipient can click.
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    // "Continue with Google": the OAuth Web client id(s) from Google Cloud Console (comma-separated if you have more than one).
    // Not set = the Google button simply does not appear and /auth/google answers "not set up".
    // Email verification is required to sign in for every account created at or after this moment. Accounts that already existed
    // (when verification was optional) keep working and are nudged to verify; the money features still need a verified email either way.
    emailVerificationRequiredFrom: (() => { const d = new Date(process.env.EMAIL_VERIFICATION_REQUIRED_FROM || '2026-10-28T00:00:00Z'); return Number.isNaN(d.getTime()) ? new Date('2026-10-28T00:00:00Z') : d; })(),
    googleClientIds: String(process.env.GOOGLE_CLIENT_ID || '').split(',').map((x) => x.trim()).filter(Boolean),
    // Nexi, the AI assistant, runs as a separate service (see /ai-assistant).
    // The browser only ever talks to this API; /api/assistant/* is proxied there.
    assistantUrl: (process.env.ASSISTANT_URL || 'http://127.0.0.1:4100').replace(/\/$/, ''),
    // Optional shared secret sent to the assistant service (its ASSISTANT_TOKEN). Needed when the
    // assistant is NOT on the same machine; harmless when it is.
    assistantToken: process.env.ASSISTANT_TOKEN || '',
    assistantTimeoutMs: Number(process.env.ASSISTANT_TIMEOUT_MS) || 120000,
    // Folder that holds the static site (store-detail.html and friends). A store's
    // public address, nextastores.com/<slug>, is answered by this API with the real
    // store-detail.html page plus that store's own title/preview tags (see
    // routes/seo.js), so the API needs to read that one file. Defaults to the
    // folder above nextastore-backend/ (how this project is laid out); when the
    // site is deployed somewhere else the API falls back to downloading the file
    // from FRONTEND_URL instead.
    frontendDir: process.env.FRONTEND_DIR || require('path').resolve(__dirname, '..', '..'),
    // Public origin that search engines and link previews see: the host of a
    // store's address (nextastores.com/<slug>), /sitemap.xml and /robots.txt. In
    // production this is the same domain as the frontend (a reverse proxy sends
    // anything that is not a real file to this API - see README "Store links").
    // In development it defaults to the site itself (FRONTEND_URL), which forwards /<slug> here.
    siteUrl: (process.env.SITE_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
    r2,
    r2Enabled,
    vapid,
    pushEnabled
};
