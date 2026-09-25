const { z } = require('zod');
const { apiError } = require('./utils');

// z.coerce.boolean() runs every non-empty value through Boolean(), so the
// STRING "false" (exactly what a JSON body sends when a client stringifies
// its form state) comes out `true` — only "", 0 and actual `false`/`null`/
// `undefined` survive coercion as false. That silently turned an unticked
// "Remember me" checkbox into a long-lived session for any caller that sent
// rememberMe as a string. This treats the handful of common "falsy-looking"
// strings as false and leaves real booleans alone.
const looseBoolean = (fallback) => z.preprocess((v) => {
    if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === '') return false;
        if (normalized === 'true' || normalized === '1') return true;
    }
    return v;
}, z.boolean().optional().default(fallback));

/** Wraps a zod schema into Express middleware that validates req.body,
 *  replacing it with the parsed (and coerced/defaulted) result. Validation
 *  failures become a 400 with the first issue's message, matching the
 *  existing apiError()-driven error shape the frontend already expects. */
function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body || {});
        if (!result.success) {
            const first = result.error.issues[0];
            return next(apiError(first ? `${first.path.join('.') || 'value'}: ${first.message}` : 'Invalid request.'));
        }
        req.body = result.data;
        next();
    };
}

const signupSchema = z.object({
    name: z.string().trim().min(1, 'is required'),
    email: z.string().trim().email('must be a valid email'),
    password: z.string().min(8, 'must be at least 8 characters'),
    // What kind of account this signup creates. Defaults to "buyer" so any
    // caller that doesn't send it (old clients, API scripts) gets the safer,
    // no-store-created behavior rather than silently becoming a seller.
    accountType: z.enum(['buyer', 'seller']).default('buyer')
});

const loginSchema = z.object({
    email: z.string().trim().min(1, 'is required'),
    password: z.string().min(1, 'is required'),
    // Optional so older clients (and the mock API) keep working unchanged;
    // absent means "no", i.e. the shorter session. See looseBoolean() above
    // for why this isn't z.coerce.boolean().
    rememberMe: looseBoolean(false)
});

const forgotPasswordSchema = z.object({
    email: z.string().trim().email('must be a valid email')
});

const updateUserSchema = z.object({
    name: z.string().trim().min(1).optional(),
    avatar: z.string().nullable().optional(),
    cover: z.string().nullable().optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8, 'must be at least 8 characters').optional()
});

const updateStoreSchema = z.object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    contactEmail: z.string().email().or(z.literal('')).optional(),
    phoneNumber: z.string().optional(),
    // Plain z.boolean() (no default/coercion), matching isPublished below:
    // omitted means "leave it as-is" (Prisma skips undefined fields on
    // update), not "set it to false". A default() here would silently
    // reset the seller's visibility choice on every save that doesn't
    // happen to touch this checkbox — see routes/store.js's generic
    // `data: { ...req.body }` update.
    phonePublic: z.boolean().optional(),
    address: z.string().optional(),
    theme: z.string().optional(),
    layout: z.string().optional(),
    logo: z.string().nullable().optional(),
    banner: z.string().nullable().optional(),
    // Must be a real #rrggbb hex value — this gets written straight into an
    // inline `style` attribute on the frontend, so anything looser than a
    // hex pattern here is a CSS-injection opening (e.g. `red; } </style>...`).
    bannerColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like #00B074').optional(),
    district: z.string().trim().optional(),
    detailedDirections: z.string().optional(),
    mapCoordinates: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'must be "lat,lng"').or(z.literal('')).optional(),
    payments: z.object({}).passthrough().optional(),
    seo: z.object({}).passthrough().optional(),
    slug: z.string().trim().min(1).optional(),
    // Accepted here only so onboarding.js's launch() can send it through the
    // one shared PUT /store save path. Dashboard Settings
    // never sends this field — see onboarding.js.
    isPublished: z.boolean().optional()
});

const productSchema = z.object({
    name: z.string().trim().min(1, 'is required'),
    description: z.string().optional().default(''),
    price: z.coerce.number().positive('must be greater than 0'),
    originalPrice: z.coerce.number().positive().nullable().optional(),
    category: z.string().optional().default('other'),
    images: z.array(z.string()).optional().default([]),
    // Parallel to `images` (same index), each entry the small client-generated
    // variant of the image at that index — see product-form.js. Optional and
    // independently-lengthed on purpose: the backend pads/truncates it to
    // match `images` rather than rejecting a mismatch, since older frontend
    // code (or a future non-browser client) may simply never send it.
    thumbnails: z.array(z.string()).optional().default([]),
    icon: z.string().optional().default('fa-box'),
    stock: z.coerce.number().int().min(0).optional().default(0)
});

const productUpdateSchema = productSchema.partial();

const orderItemSchema = z.object({
    productId: z.string().min(1),
    quantity: z.coerce.number().int().positive()
});

function rejectDuplicateItems(items, ctx) {
    const ids = items.map(item => item.productId);
    if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'Each product may appear only once per order.' });
    }
}

const publicOrderSchema = z.object({
    customerName: z.string().trim().min(1, 'is required'),
    customerPhone: z.string().trim().min(1, 'is required'),
    deliveryAddress: z.string().trim().optional().default(''),
    fulfillmentMethod: z.enum(['delivery','pickup']).default('delivery'),
    paymentMethod: z.string().trim().max(50).optional().nullable(),
    items: z.array(orderItemSchema).min(1, 'Your cart is empty.')
}).superRefine((v, ctx) => {
    rejectDuplicateItems(v.items, ctx);
    if (v.fulfillmentMethod === 'delivery' && !v.deliveryAddress) {
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['deliveryAddress'],message:'is required for delivery'});
    }
});

const batchOrderSchema = z.object({
    customerName: z.string().trim().min(1, 'is required'),
    customerPhone: z.string().trim().min(1, 'is required'),
    deliveryAddress: z.string().trim().optional().default(''),
    acknowledgment: z.literal(true),
    stores: z.array(z.object({
        storeId: z.string().min(1),
        fulfillmentMethod: z.enum(['delivery','pickup']).default('delivery'),
        paymentMethod: z.string().trim().max(50).optional().nullable(),
        items: z.array(orderItemSchema).min(1)
    })).min(1)
}).superRefine((v, ctx) => {
    const storeIds = v.stores.map(s => s.storeId);
    if (new Set(storeIds).size !== storeIds.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stores'], message: 'Each store may appear only once per checkout.' });
    }
    v.stores.forEach((store, index) => {
        const ids = store.items.map(item => item.productId);
        if (new Set(ids).size !== ids.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stores', index, 'items'], message: 'Each product may appear only once per store order.' });
        }
    });
    if (v.stores.some(s => s.fulfillmentMethod === 'delivery') && !v.deliveryAddress) {
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['deliveryAddress'],message:'is required when any order uses delivery'});
    }
});

const orderReportSchema = z.object({ reason: z.string().trim().min(5, 'Please describe the issue.').max(1000) });

const orderStatusSchema = z.object({
    status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled'])
});

// Buyer-initiated cancellation (POST /orders/:id/cancel). `reason` is a
// closed set of template reasons shown as a picker on the frontend
// (js/orders.js keeps the matching label text); `details` is always
// required alongside it, even for 'other', so the seller never gets a bare
// reason code with no context for why their order was cancelled.
const orderCancelSchema = z.object({
    reason: z.enum(['changed_mind', 'wrong_item', 'duplicate_order', 'found_elsewhere', 'other']),
    details: z.string().trim().min(5, 'Please add a few details for the seller.').max(500)
});

// A message is either plain text, or a rich attachment (a seller sharing
// one of their own products, or either party sharing a location) with an
// optional text caption riding alongside it. `body` alone being empty is
// only allowed when an attachment is present — enforced by the .refine()
// below rather than by making `body` itself required, since a caption-free
// attachment message is a normal thing to send.
const messageAttachmentSchema = z.object({
    type: z.enum(['product', 'location']),
    productId: z.string().min(1).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    label: z.string().trim().max(200).optional()
}).refine(a => a.type !== 'product' || !!a.productId, { message: 'productId is required for a product attachment', path: ['productId'] })
  .refine(a => a.type !== 'location' || (typeof a.lat === 'number' && typeof a.lng === 'number'), { message: 'lat/lng are required for a location attachment', path: ['lat'] });

// Client-generated id for one send attempt. Lets the server recognise a
// retry of a message it already stored (the reply was lost on a flaky
// connection, the sender taps Resend) and return the original instead of
// creating a duplicate.
const clientMessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'is not a valid id').optional();

const sendMessageSchema = z.object({
    storeId: z.string().min(1, 'is required'),
    productId: z.string().min(1).nullable().optional(),
    body: z.string().trim().max(2000).optional().default(''),
    attachment: messageAttachmentSchema.optional(),
    clientId: clientMessageIdSchema
}).refine(data => data.body.length > 0 || !!data.attachment, { message: 'Message cannot be empty', path: ['body'] });

// Which people's online status a presence stream should report. Keys are
// deliberately indirect ("conversation:<id>", "store:<slug>") so the API
// never has to hand internal user ids to the browser; the server resolves
// each key to a person and checks the caller may see it (routes/presence.js).
const presenceWatchKeySchema = z.string().max(90).regex(/^(conversation|store):[A-Za-z0-9_-]{1,80}$/, 'is not a valid presence key');
const presenceStreamSchema = z.object({
    watch: z.array(presenceWatchKeySchema).max(100).optional().default([])
});

const replyMessageSchema = z.object({
    body: z.string().trim().max(2000).optional().default(''),
    attachment: messageAttachmentSchema.optional(),
    clientId: clientMessageIdSchema
}).refine(data => data.body.length > 0 || !!data.attachment, { message: 'Message cannot be empty', path: ['body'] });

const resetPasswordSchema = z.object({
    token: z.string().min(1, 'is required'),
    newPassword: z.string().min(8, 'must be at least 8 characters')
});

const adminUserUpdateSchema = z.object({
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    role: z.enum(['buyer', 'seller', 'admin']).optional(),
    accountStatus: z.enum(['active', 'suspended']).optional(),
    adminLevel: z.enum(['standard', 'super_admin']).optional(),
    adminRoleId: z.string().nullable().optional()
});

const adminRoleSchema = z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(240).optional().default(''),
    permissions: z.array(z.string().min(1)).max(50).default([])
});

const followUpSchema = z.object({
    title: z.string().trim().min(2).max(120),
    note: z.string().trim().max(1000).optional().default(''),
    status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    relatedUserId: z.string().nullable().optional(),
    assignedToId: z.string().nullable().optional(),
    adminRoleId: z.string().nullable().optional()
});

// A seller self-reporting a mobile money payment toward their subscription
// (see routes/subscription.js) — amount/method/reference only, an admin
// confirms it actually landed before the badge/access is granted.
const subscriptionPaymentSchema = z.object({
    amount: z.coerce.number().positive('must be a positive amount'),
    method: z.enum(['mtnMomo', 'airtelMoney'], { errorMap: () => ({ message: 'must be mtnMomo or airtelMoney' }) }),
    reference: z.string().trim().min(3, 'enter the transaction reference/ID'),
    periodMonths: z.coerce.number().int().refine(v => [1, 3, 6, 12, 24].includes(v), 'choose 1, 3, 6, 12 or 24 months').optional().default(1)
});

// Admin-editable mobile money merchant codes shown to sellers on
// subscription.html (see routes/admin.js GET/PUT /admin/settings). Every
// field optional — an admin can update just one code at a time.
const platformSettingsSchema = z.object({
    mtnMomoCode: z.string().trim().max(40).optional(),
    mtnMomoName: z.string().trim().max(60).optional(),
    airtelMoneyCode: z.string().trim().max(40).optional(),
    airtelMoneyName: z.string().trim().max(60).optional()
});

// Admin create/update for the payment-method catalog (see prisma schema
// PaymentMethod). `code` is only required on create — PUT identifies the
// row by :id and code is immutable once orders may already reference it
// by that string (see orders.js paymentMethod matching).
const paymentMethodCreateSchema = z.object({
    code: z.string().trim().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Use a short camelCase code, e.g. "mtnMomo".'),
    label: z.string().trim().min(1).max(60),
    icon: z.string().trim().max(60).optional(),
    isActive: z.boolean().optional(),
    currency: z.string().trim().max(10).optional(),
    allowedCountries: z.array(z.string().trim().max(5)).optional(),
    environment: z.enum(['live', 'test']).optional(),
    sortOrder: z.number().int().optional()
});
const paymentMethodUpdateSchema = paymentMethodCreateSchema.omit({ code: true }).partial();

// Web Push subscribe/unsubscribe (see routes/push.js). Matches the shape
// PushSubscription.toJSON() produces in the browser: { endpoint, keys: {
// p256dh, auth } }. userAgent is informational only (shown in a future "your
// devices" list) and capped generously since real UA strings run long.
const pushSubscribeSchema = z.object({
    endpoint: z.string().trim().url().max(2000),
    keys: z.object({
        p256dh: z.string().trim().min(1).max(500),
        auth: z.string().trim().min(1).max(500)
    }),
    userAgent: z.string().trim().max(300).optional()
});
const pushUnsubscribeSchema = z.object({
    endpoint: z.string().trim().url().max(2000)
});

module.exports = {
    validateBody,
    signupSchema,
    loginSchema,
    forgotPasswordSchema,
    updateUserSchema,
    updateStoreSchema,
    productSchema,
    productUpdateSchema,
    publicOrderSchema,
    batchOrderSchema,
    orderStatusSchema,
    orderReportSchema,
    orderCancelSchema,
    sendMessageSchema,
    replyMessageSchema,
    presenceStreamSchema,
    resetPasswordSchema,
    subscriptionPaymentSchema,
    platformSettingsSchema,
    paymentMethodCreateSchema,
    paymentMethodUpdateSchema,
    adminUserUpdateSchema,
    adminRoleSchema,
    followUpSchema,
    pushSubscribeSchema,
    pushUnsubscribeSchema
};
