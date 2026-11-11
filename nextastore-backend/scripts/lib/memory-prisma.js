/**
 * A tiny in-memory stand-in for the Prisma client, just big enough for the growth services.
 * It exists so the growth logic can be exercised end to end with NO database. It is NOT Prisma:
 * it does not know about indexes, real transactions or JSON columns. Used by growth-flow-test.js
 * and growth-browser-test.js.
 */
let seq = 0;
const uid = () => `id${++seq}`;

function createMemoryPrisma(clock) {
    const DEFAULTS = {
        growthPartner: () => ({ previousCodes: [], upgradedAt: null, upgradedFrom: null, status: 'active', rankKey: 'trailhead', territories: [], usualIpPrefixes: [], qualityScore: 70, phone: '', signupIpPrefix: '', frozenReason: '', payoutNumber: null, payoutNetwork: null, payoutName: null, payoutNumberChangedAt: null, approvedAt: null, joinedAt: clock(), createdAt: clock() }),
        growthReferral: () => ({ program: null, stage: 'signed_up', source: 'link', riskDecision: 'clear', riskScore: 0, riskReasons: [], leadLockExtensions: 0, leadBusiness: '', leadContactName: '', leadPhone: '', leadDistrict: '', leadNote: '', signupIpPrefix: '', deviceHash: '', recruitUserId: null, storeId: null, firstPaymentId: null, paymentSubmittedAt: null, paidAt: null, lastAskedAt: null, storeLiveAt: null, signedUpAt: null, leadLockExpiresAt: null, capturedOffline: false, createdAt: clock() }),
        growthUpgrade: () => ({ status: 'applied', territories: [], note: '', phone: '', reviewNote: '', reviewedBy: null, reviewedAt: null, oldCode: '', newCode: '', appliedAt: clock(), createdAt: clock() }),
        growthCommission: () => ({ status: 'held', voidReason: '', note: '', createdAt: clock(), paymentReviewedBy: null }),
        growthWithdrawal: () => ({ status: 'requested', payoutName: '', rejectReason: '', needsSecondApproval: false, approvedBy: null, paidBy: null, payoutReference: '', feeEstimate: 0, feeActual: null, requestedAt: clock(), createdAt: clock() }),
        growthFlag: () => ({ status: 'open', createdAt: clock() }),
        growthCampaign: () => ({ isActive: true, boostPercent: 0, district: '', program: null, description: '' }),
        growthSettings: () => ({ circleOpen: true, crewOpen: true, extraHolidays: [], termsVersion: 'test' }),
        growthVisit: () => ({ visitedAt: clock() }),
        adminFollowUp: () => ({ status: 'open' }),
        notification: () => ({ createdAt: clock() }),
        user: () => ({ createdAt: clock(), tokenVersion: 0, accountStatus: 'active', emailVerifiedAt: null, googleId: null }), store: () => ({ deletedAt: null }), product: () => ({}), subscriptionPayment: () => ({ status: 'pending' })
    };
    const UNIQUE = { growthCommission: ['paymentId', 'partnerId', 'type'] };
    // Stand-in for the database's partial unique index: one OPEN upgrade request per partner.
    const GUARDS = { growthUpgrade: (rows, d) => d.status !== 'approved' && d.status !== 'declined' && d.status !== 'withdrawn' && rows.some((r) => r.partnerId === d.partnerId && r.status === 'applied') };

    const num = (x) => (x instanceof Date ? x.getTime() : x);
    function matches(row, where = {}) {
        return Object.entries(where).every(([k, cond]) => {
            if (k === 'OR') return cond.some((c) => matches(row, c));
            if (k === 'AND') return cond.every((c) => matches(row, c));
            if (k === 'NOT') return !(Array.isArray(cond) ? cond.some((c) => matches(row, c)) : matches(row, cond));
            const v = row[k];
            if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
                return Object.entries(cond).every(([op, arg]) => {
                    switch (op) {
                        case 'gt': return v != null && num(v) > num(arg);
                        case 'gte': return v != null && num(v) >= num(arg);
                        case 'lt': return v != null && num(v) < num(arg);
                        case 'lte': return v != null && num(v) <= num(arg);
                        case 'in': return arg.includes(v);
                        case 'not': return arg === null ? v != null : v !== arg;
                        case 'startsWith': return typeof v === 'string' && v.startsWith(arg);
                        case 'contains': return typeof v === 'string' && v.toLowerCase().includes(String(arg).toLowerCase());
                        case 'has': return Array.isArray(v) && v.includes(arg);
                        case 'mode': return true;
                        default: throw new Error(`memory-prisma: unsupported operator ${op}`);
                    }
                });
            }
            return v === cond || (v instanceof Date && cond instanceof Date && v.getTime() === cond.getTime());
        });
    }
    const sorter = (orderBy) => { if (!orderBy) return null; const [[k, dir]] = Object.entries(orderBy); return (a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * (dir === 'desc' ? -1 : 1); };

    function model(name, db) {
        const rows = db[name] = db[name] || [];
        // A user written with `store: { create: {...} }` also creates that store (the real client does this in one step).
    const liftStore = (name, row, data) => {
        if (name !== 'user' || !data || !data.store || !data.store.create) return data;
        if (!db.store.some((st) => st.ownerId === row.id)) db.store.push({ id: `store_${db.store.length + 1}`, ownerId: row.id, deletedAt: null, ...data.store.create });
        const { store, ...rest } = data; return rest;
    };
    const fill = (data) => ({ id: data.id || uid(), ...DEFAULTS[name](), ...data });
        const attach = (r, include) => {
            const out = { ...r };
            if (include && include.partner) out.partner = db.growthPartner.find((p) => p.id === r.partnerId);
            if (include && include.store) out.store = db.store.find((s) => s.id === r.storeId);
            return out;
        };
        return {
            findUnique: async ({ where, include }) => { const r = rows.find((x) => matches(x, where)); return r ? attach(r, include) : null; },
            findFirst: async ({ where, orderBy, include }) => { let r = rows.filter((x) => matches(x, where)); const s = sorter(orderBy); if (s) r = [...r].sort(s); return r[0] ? attach(r[0], include) : null; },
            findMany: async ({ where, orderBy, take, include } = {}) => { let r = rows.filter((x) => matches(x, where)); const s = sorter(orderBy); if (s) r = [...r].sort(s); return (take ? r.slice(0, take) : r).map((x) => attach(x, include)); },
            count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
            create: async ({ data }) => { const row = fill(data); if (name === 'user') { row.id = row.id || `user_${rows.length + 1}`; const lifted = liftStore(name, row, row); Object.keys(row).forEach((k) => { if (k === 'store') delete row[k]; }); void lifted; } if (GUARDS[name] && GUARDS[name](rows, row)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); rows.push(row); return row; },
            createMany: async ({ data, skipDuplicates }) => {
                let n = 0;
                for (const d of data) {
                    const keys = UNIQUE[name];
                    if (skipDuplicates && keys && rows.some((r) => keys.every((k) => r[k] === d[k]))) continue;
                    rows.push(fill(d)); n++;
                }
                return { count: n };
            },
            update: async ({ where, data }) => {
                const row = rows.find((r) => matches(r, where)); if (!row) throw new Error(`memory-prisma: ${name} not found`);
                data = liftStore(name, row, data);
                for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v ? (row[k] || 0) + v.increment : (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'push' in v ? [...(row[k] || []), v.push] : v);
                return row;
            },
            updateMany: async ({ where, data }) => { const hit = rows.filter((r) => matches(r, where)); hit.forEach((r) => { for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'push' in v ? [...(r[k] || []), v.push] : v; }); return { count: hit.length }; },
            groupBy: async ({ by, where, _count }) => {
                const groups = new Map();
                for (const r of rows.filter((x) => matches(x, where))) {
                    const key = by.map((k) => r[k]).join('\u0000');
                    if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(by.map((k) => [k, r[k]])), _count: { _all: 0 } });
                    groups.get(key)._count._all++;
                }
                return [...groups.values()];
            },
            aggregate: async ({ where, _count, _sum }) => {
                const hit = rows.filter((r) => matches(r, where));
                const out = {};
                if (_count) out._count = { _all: hit.length };
                if (_sum) out._sum = Object.fromEntries(Object.keys(_sum).map((k) => [k, hit.reduce((s, r) => s + (Number(r[k]) || 0), 0)]));
                return out;
            }
        };
    }

    const db = {};
    const prisma = { _db: db, _uid: uid, $transaction: async (fn) => fn(prisma) };
    for (const m of Object.keys(DEFAULTS)) prisma[m] = model(m, db);
    return prisma;
}

module.exports = { createMemoryPrisma };
