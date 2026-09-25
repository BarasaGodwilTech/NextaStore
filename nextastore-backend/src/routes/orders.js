const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { generateOrderCode } = require('../orderCode');
const { getStoreForUser, resolveContextStore, serializeOrder, createNotification, getActivePaymentMethods } = require('../helpers');
const { requireAuth, requireSeller } = require('../middleware');
const { validateBody, publicOrderSchema, batchOrderSchema, orderStatusSchema, orderReportSchema, orderCancelSchema } = require('../validation');

const router = express.Router();

// Checkout requires login (item 13) — this is also what makes a real
// "order history" page possible: an order without an authenticated buyer
// has nothing to attribute it to besides a name/phone a customer typed in,
// which any guest can fake. requireAuth is enough (not requireSeller) —
// anyone with an account can buy, sellers included.
router.post('/public', requireAuth, validateBody(publicOrderSchema), async (req, res, next) => {
    try {
        const store = await resolveContextStore(req);
        if (!store) throw apiError('Store not found.', 404);

        const payload = req.body;
        // Payment method labels now come from the platform's live catalog
        // (PaymentMethod) instead of a hardcoded object, so disabling a
        // method platform-wide (e.g. during an outage) blocks it here too,
        // even if a store's own `payments` toggle still says yes.
        const paymentLabels = Object.fromEntries((await getActivePaymentMethods()).map(m => [m.code, m.label]));
        if (payload.paymentMethod) { const key = Object.keys(paymentLabels).find(k => k === payload.paymentMethod || paymentLabels[k].toLowerCase() === String(payload.paymentMethod).toLowerCase()); if (!key || !(store.payments || {})[key]) throw apiError(`That store does not advertise ${paymentLabels[key] || payload.paymentMethod} as an accepted payment method.`, 400); }

        // The order is built entirely from server-side product records —
        // never from client-supplied price/name. This is the fix for the
        // most important bug in the previous version: a request used to be
        // able to submit its own `price` per line item and the total was
        // computed from that, so anyone could check out for any amount they
        // wanted. Price, name, and total are now always looked up fresh.
        const order = await prisma.$transaction(async (tx) => {
            const productIds = payload.items.map(i => i.productId);
            const products = await tx.product.findMany({
                where: { id: { in: productIds }, storeId: store.id, deletedAt: null }
            });
            const byId = new Map(products.map(p => [p.id, p]));

            let total = new Prisma.Decimal(0);
            const itemsData = [];
            for (const line of payload.items) {
                const product = byId.get(line.productId);
                if (!product) throw apiError(`One of the items in your cart is no longer available.`, 409);
                if (product.stock < line.quantity) {
                    throw apiError(`Only ${product.stock} left of "${product.name}".`, 409);
                }
                const unitPrice = product.price;
                total = total.plus(unitPrice.times(line.quantity));
                itemsData.push({
                    productId: product.id,
                    productName: product.name,
                    quantity: line.quantity,
                    unitPrice
                });
            }

            // Decrement stock and bump sold count for every product bought.
            //
            // The `stock < line.quantity` check above reads a snapshot taken at
            // the start of this transaction — under the default (read committed)
            // isolation level, two checkouts racing for the last unit of the
            // same product can both pass that check before either decrements.
            // That used to let a store oversell: two customers both told
            // "confirmed", only one item actually in stock.
            //
            // The fix is to make the decrement itself the stock check: only
            // decrement rows where stock is still >= what's being bought, and
            // treat "0 rows updated" as "someone else just took it" rather than
            // trusting the earlier read.
            const lowStockCandidates = [];
            const LOW_STOCK_THRESHOLD = 3;
            for (const item of itemsData) {
                const result = await tx.product.updateMany({
                    where: { id: item.productId, stock: { gte: item.quantity } },
                    data: { stock: { decrement: item.quantity }, sold: { increment: item.quantity } }
                });
                if (result.count === 0) {
                    const fresh = await tx.product.findUnique({ where: { id: item.productId } });
                    throw apiError(`Only ${fresh ? fresh.stock : 0} left of "${item.productName}".`, 409);
                }
                if (product.stock > LOW_STOCK_THRESHOLD && product.stock - item.quantity <= LOW_STOCK_THRESHOLD && product.stock - item.quantity > 0) lowStockCandidates.push(item.productId);
            }

            // Order ids are short human-friendly codes, not cuids — collide
            // rarely, but retry on the off chance two orders land on the
            // same code at the same instant.
            let created;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    created = await tx.order.create({
                        data: {
                            id: generateOrderCode(),
                            storeId: store.id,
                            buyerId: req.user.id,
                            customerName: payload.customerName,
                            customerPhone: payload.customerPhone,
                            deliveryAddress: payload.deliveryAddress || '',
                            fulfillmentMethod: payload.fulfillmentMethod,
                            paymentMethod: payload.paymentMethod || null,
                            total,
                            status: 'pending',
                            items: { create: itemsData }
                        },
                        include: { items: true }
                    });
                    break;
                } catch (err) {
                    if (err.code === 'P2002' && attempt < 4) continue;
                    throw err;
                }
            }
            return { created, lowStockCandidates };
        });

        // Notifications fire after the transaction commits, outside it —
        // a notification failing to write should never roll back a real
        // order, and createNotification() already swallows its own errors.
        if (store.ownerId) {
            await createNotification({
                userId: store.ownerId,
                type: 'new_order',
                title: `New order ${order.created.id}`,
                body: `${order.created.customerName} placed an order for ${order.created.items.length} item(s).`,
                link: `dashboard.html#orders`
            });

            // Low-stock check: threshold of 3, matching the "low stock"
            // language item 12 asks for. Checked after the decrement above
            // so it reflects the real post-purchase stock level.
            const restocked = await prisma.product.findMany({
                where: { id: { in: order.lowStockCandidates }, stock: { lte: LOW_STOCK_THRESHOLD, gt: 0 } }
            });
            for (const product of restocked) {
                await createNotification({
                    userId: store.ownerId,
                    type: 'low_stock',
                    title: `Low stock: ${product.name}`,
                    body: `Only ${product.stock} left.`,
                    link: `dashboard.html#products`
                });
            }
        }

        res.status(201).json({ data: serializeOrder(order.created) });
    } catch (err) {
        next(err);
    }
});

router.post('/batch', requireAuth, validateBody(batchOrderSchema), async (req, res, next) => {
    try {
        const payload=req.body;
        // Fetched once, outside the transaction — it's a read-only,
        // platform-wide lookup unrelated to the per-store stock/order writes
        // the transaction below is actually guarding.
        const labels = Object.fromEntries((await getActivePaymentMethods()).map(m => [m.code, m.label]));
        const orders=await prisma.$transaction(async tx=>{
            const created=[];
            for(const group of payload.stores){
                const store=await tx.store.findFirst({where:{id:group.storeId,deletedAt:null}});
                if(!store) throw apiError('One of the stores in your cart is no longer available.',409);
                if(group.fulfillmentMethod==='delivery'&&!payload.deliveryAddress) throw apiError('A delivery address is required for delivery orders.',400);
                const accepted=store.payments||{};
                if(group.paymentMethod){const key=Object.keys(labels).find(k=>k===group.paymentMethod||labels[k].toLowerCase()===String(group.paymentMethod).toLowerCase());if(!key||!accepted[key])throw apiError(`That store does not advertise ${labels[key]||group.paymentMethod} as an accepted payment method.`,400);}
                const ids=group.items.map(i=>i.productId); const products=await tx.product.findMany({where:{id:{in:ids},storeId:store.id,deletedAt:null}}); const byId=new Map(products.map(p=>[p.id,p])); let total=new Prisma.Decimal(0); const itemsData=[];
                for(const line of group.items){const product=byId.get(line.productId);if(!product)throw apiError('One of the items in your cart is no longer available.',409);const result=await tx.product.updateMany({where:{id:product.id,stock:{gte:line.quantity}},data:{stock:{decrement:line.quantity},sold:{increment:line.quantity}}});if(!result.count){const fresh=await tx.product.findUnique({where:{id:product.id}});throw apiError(`Only ${fresh?fresh.stock:0} left of "${product.name}".`,409);}total=total.plus(product.price.times(line.quantity));itemsData.push({productId:product.id,productName:product.name,quantity:line.quantity,unitPrice:product.price});}
                created.push(await tx.order.create({data:{id:generateOrderCode(),storeId:store.id,buyerId:req.user.id,customerName:payload.customerName,customerPhone:payload.customerPhone,deliveryAddress:group.fulfillmentMethod==='delivery'?payload.deliveryAddress:'',fulfillmentMethod:group.fulfillmentMethod,paymentMethod:group.paymentMethod||null,paymentStatus:'unpaid',status:'pending',total,items:{create:itemsData}},include:{items:true,store:{select:{id:true,slug:true,name:true,logo:true,address:true,district:true,detailedDirections:true,mapCoordinates:true,verified:true,badgeCommitmentMonths:true}}}}));
            } return created;
        });
        for (const order of orders) {
            const store = await prisma.store.findUnique({ where: { id: order.storeId }, select: { ownerId: true, name: true } });
            if (store?.ownerId) {
                await createNotification({
                    userId: store.ownerId,
                    type: 'new_order',
                    title: `New order ${order.id}`,
                    body: `${order.customerName} placed an order for ${order.items.length} item(s).`,
                    link: 'dashboard.html#orders'
                });
            }
            await createNotification({
                userId: req.user.id,
                type: 'new_message',
                title: `Order ${order.id} placed`,
                body: `${store?.name || 'Seller'} received your order request.`,
                link: `orders.html?order=${encodeURIComponent(order.id)}`
            });
        }
        res.status(201).json({data:orders.map(serializeOrder)});
    } catch(err){next(err);}
});

router.get('/recent', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const { orders } = await listOrdersForOwner(req.user.id, { limit: 5 });
        res.json({ data: orders });
    } catch (err) {
        next(err);
    }
});

// Paginated (item 10) — ?page=1&limit=20 by default, capped at 100 per page
// so a caller can't force an unbounded table scan.
//
// listOrdersForOwner() has a second, unbounded mode (no `page` -> `take:
// undefined`) that /recent relies on internally with a hardcoded limit.
// That mode must never be reachable from this public route: a caller who
// simply omits ?page (or a frontend widget that forgets to pass it) would
// otherwise pull a seller's entire order history — every row, with items
// and store included — in one request. `page` is always defaulted here so
// this route can never take that branch, regardless of what the caller sends.
router.get('/', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const query = { ...req.query, page: req.query.page || 1 };
        const { orders, page, limit, total } = await listOrdersForOwner(req.user.id, query);
        res.json({ data: orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } });
    } catch (err) {
        next(err);
    }
});

// A buyer's own order history (item 14) — the counterpart to the seller's
// GET /orders above, scoped by buyerId instead of storeId.
router.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const where = { buyerId: req.user.id, deletedAt: null };

        const [orders, total] = await Promise.all([
            prisma.order.findMany({
                where,
                include: { items: true, store: { select: { id: true, slug: true, name: true, logo: true } } },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.order.count({ where })
        ]);

        res.json({
            data: orders.map(o => ({ ...serializeOrder(o), store: o.store })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

// Order status lifecycle (item 14): placed -> confirmed/processing ->
// shipped -> delivered, or cancelled. Only the owning seller can move it.
router.post('/:id/report', requireAuth, validateBody(orderReportSchema), async (req,res,next)=>{try{const order=await prisma.order.findFirst({where:{id:req.params.id,deletedAt:null},select:{id:true,buyerId:true,storeId:true}});if(!order)throw apiError('Order not found.',404);const owned=await getStoreForUser(req.user.id);if(order.buyerId!==req.user.id&&owned?.id!==order.storeId)throw apiError('You cannot report this order.',403);const report=await prisma.orderReport.create({data:{orderId:order.id,reporterId:req.user.id,reason:req.body.reason}});await prisma.order.update({where:{id:order.id},data:{flaggedAt:new Date(),flagReason:req.body.reason}});res.status(201).json({data:report});}catch(err){if(err.code==='P2002')return next(apiError('You have already reported this order.'));next(err);}});

router.get('/reports', requireAuth, requireSeller, async(req,res,next)=>{try{const store=await getStoreForUser(req.user.id);if(!store)return res.json({data:[]});const reports=await prisma.orderReport.findMany({where:{order:{storeId:store.id,deletedAt:null}},include:{order:{select:{id:true,customerName:true,status:true,flaggedAt:true,flagReason:true}},reporter:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:'desc'},take:200});res.json({data:reports});}catch(err){next(err);}});

router.get('/:id', requireAuth, async (req, res, next) => {
    try {
        let order=await prisma.order.findFirst({where:{id:req.params.id,buyerId:req.user.id,deletedAt:null},include:{items:true,store:{select:{id:true,slug:true,name:true,logo:true,address:true,district:true,detailedDirections:true,mapCoordinates:true,verified:true,badgeCommitmentMonths:true}}}});
        if(!order){const owned=await getStoreForUser(req.user.id);if(owned)order=await prisma.order.findFirst({where:{id:req.params.id,storeId:owned.id,deletedAt:null},include:{items:true,store:{select:{id:true,slug:true,name:true,logo:true,address:true,district:true,detailedDirections:true,mapCoordinates:true,verified:true,badgeCommitmentMonths:true}}}});}
        if(!order)throw apiError('Order not found.',404);res.json({data:{...serializeOrder(order),store:order.store}});
    }catch(err){next(err);}
});

router.put('/:id/status', requireAuth, requireSeller, validateBody(orderStatusSchema), async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);

        const order = await prisma.order.findFirst({
            where: { id: req.params.id, storeId: store.id, deletedAt: null },
            include: { items: true }
        });
        if (!order) throw apiError('Order not found.', 404);

        // Buyer and seller agree, then the seller handles fulfillment
        // off-platform — this isn't a manual shipment tracker, so the seller
        // only ever needs to Confirm, Mark completed, or Cancel. 'shipped'
        // is kept reachable from 'shipped' itself (-> delivered) purely so
        // any order that already reached it before this simplification can
        // still be closed out; nothing routes a new order through it.
        const transitions = {
            pending: ['processing', 'cancelled'],
            processing: ['delivered', 'cancelled'],
            shipped: ['delivered'],
            delivered: [],
            cancelled: []
        };
        if (req.body.status === order.status) return res.json({ data: serializeOrder(order) });
        if (!transitions[order.status]?.includes(req.body.status)) {
            throw apiError(`An order cannot move from ${order.status} to ${req.body.status}.`, 409);
        }

        const updated = await prisma.$transaction(async tx => {
            if (req.body.status === 'cancelled') {
                // Checkout already reserved/decremented stock. A cancellation
                // must return those units or sellers will permanently lose
                // inventory every time an order is cancelled.
                for (const item of order.items) {
                    if (!item.productId) continue;
                    await tx.product.updateMany({
                        where: { id: item.productId, storeId: store.id, deletedAt: null },
                        data: { stock: { increment: item.quantity }, sold: { decrement: item.quantity } }
                    });
                }
            }
            return tx.order.update({
                where: { id: order.id },
                data: { status: req.body.status },
                include: { items: true }
            });
        });

        if (order.buyerId) {
            await createNotification({
                userId: order.buyerId,
                type: 'new_order',
                title: `Order ${order.id} is ${updated.status}`,
                body: `Your order from ${store.name} has been updated.`,
                link: `orders.html?order=${encodeURIComponent(order.id)}`
            });
        }

        res.json({ data: serializeOrder(updated) });
    } catch (err) {
        next(err);
    }
});

// Buyer self-service cancellation. Separate from PUT /:id/status above,
// which is the seller's own path to 'cancelled' (e.g. out of stock) and
// isn't grace-period- or rate-limited — a seller can cancel anytime, a
// buyer only gets a short window right after placing the order, has to
// give a reason, and can't cycle place-then-cancel indefinitely.
const CANCEL_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes from checkout
const CANCEL_ABUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // rolling 30 days
const CANCEL_ABUSE_LIMIT = 3; // buyer-initiated cancellations allowed per window
const CANCEL_REASON_LABELS = {
    changed_mind: 'Changed their mind',
    wrong_item: 'Ordered the wrong item/size/quantity by mistake',
    duplicate_order: 'Accidentally placed a duplicate order',
    found_elsewhere: 'Found it cheaper or faster elsewhere',
    other: 'Other'
};

router.post('/:id/cancel', requireAuth, validateBody(orderCancelSchema), async (req, res, next) => {
    try {
        const order = await prisma.order.findFirst({
            where: { id: req.params.id, buyerId: req.user.id, deletedAt: null },
            include: { items: true, store: { select: { id: true, ownerId: true, name: true } } }
        });
        if (!order) throw apiError('Order not found.', 404);

        if (order.status === 'cancelled') throw apiError('This order is already cancelled.', 409);
        if (!['pending', 'processing'].includes(order.status)) {
            throw apiError('This order has already moved past the point it can be cancelled here — message the seller instead.', 409);
        }
        const ageMs = Date.now() - new Date(order.createdAt).getTime();
        if (ageMs > CANCEL_GRACE_PERIOD_MS) {
            throw apiError(`Orders can only be cancelled within ${Math.round(CANCEL_GRACE_PERIOD_MS / 60000)} minutes of placing them. Message the seller if you still need to cancel this one.`, 409);
        }

        // Only a buyer-initiated cancel (this endpoint) ever counts toward
        // the buyer's own limit — a seller cancelling an order (e.g. out of
        // stock) never eats into it.
        const recentCancels = await prisma.order.count({
            where: {
                buyerId: req.user.id,
                cancelInitiator: 'buyer',
                cancelledAt: { gte: new Date(Date.now() - CANCEL_ABUSE_WINDOW_MS) }
            }
        });
        if (recentCancels >= CANCEL_ABUSE_LIMIT) {
            throw apiError(`You've reached the limit of ${CANCEL_ABUSE_LIMIT} self-cancelled orders in the last 30 days. Please message the seller directly to cancel this one.`, 429);
        }

        const updated = await prisma.$transaction(async tx => {
            // Same stock-return logic as a seller-initiated cancel (see
            // PUT /:id/status above) — checkout already reserved/decremented
            // stock, so a cancellation must give it back.
            for (const item of order.items) {
                if (!item.productId) continue;
                await tx.product.updateMany({
                    where: { id: item.productId, storeId: order.storeId, deletedAt: null },
                    data: { stock: { increment: item.quantity }, sold: { decrement: item.quantity } }
                });
            }
            return tx.order.update({
                where: { id: order.id },
                data: {
                    status: 'cancelled',
                    cancelledAt: new Date(),
                    cancelReason: req.body.reason,
                    cancelDetails: req.body.details,
                    cancelInitiator: 'buyer'
                },
                include: { items: true }
            });
        });

        if (order.store?.ownerId) {
            await createNotification({
                userId: order.store.ownerId,
                type: 'order_cancelled',
                title: `Order ${order.id} was cancelled by the buyer`,
                body: `${CANCEL_REASON_LABELS[req.body.reason] || req.body.reason} — "${req.body.details}"`,
                link: 'dashboard.html#orders'
            });
        }

        res.json({ data: serializeOrder(updated) });
    } catch (err) {
        next(err);
    }
});

async function listOrdersForOwner(userId, { limit, status, page } = {}) {
    const store = await getStoreForUser(userId);
    if (!store) return { orders: [], page: 1, limit: limit ? Number(limit) : 20, total: 0 };

    const where = { storeId: store.id, deletedAt: null };
    if (status) where.status = status;

    // /recent still calls this with just { limit } and no page — that path
    // keeps its old unpaginated "take: limit" behavior for a fixed-size
    // dashboard widget; the paginated GET / path passes page too.
    if (!page) {
        const orders = await prisma.order.findMany({
            where,
            include: { items: true, store: { select: { id:true, slug:true, name:true, logo:true, address:true, district:true, detailedDirections:true, mapCoordinates:true, verified:true } } },
            orderBy: { createdAt: 'desc' },
            take: limit ? Number(limit) : undefined
        });
        return { orders: orders.map(serializeOrder), page: 1, limit: limit ? Number(limit) : orders.length, total: orders.length };
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const [orders, total] = await Promise.all([
        prisma.order.findMany({
            where,
            include: { items: true, store: { select: { id:true, slug:true, name:true, logo:true, address:true, district:true, detailedDirections:true, mapCoordinates:true, verified:true } } },
            orderBy: { createdAt: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum
        }),
        prisma.order.count({ where })
    ]);
    return { orders: orders.map(serializeOrder), page: pageNum, limit: limitNum, total };
}

module.exports = router;
