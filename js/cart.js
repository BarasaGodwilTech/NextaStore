/* Shared persistent cart — one source of truth across every shopper page. */
(function (global) {
    const KEY = 'nextastore_cart_v1';

    class NextaCart {
        constructor() { this.items = this.read(); }
        read() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
        save() { localStorage.setItem(KEY, JSON.stringify(this.items)); this.notify(); }
        notify() {
            const count = this.count();
            const total = this.total();
            document.querySelectorAll('[data-cart-count], .cart-count').forEach(el => el.textContent = count);
            document.querySelectorAll('[data-cart-total]').forEach(el => {
                el.textContent = (typeof app !== 'undefined' && app.formatCurrency) ? app.formatCurrency(total) : `UGX ${total.toLocaleString()}`;
            });
            // Re-render every mounted mini-cart immediately (same tab) so adds/removes/qty
            // changes show up without a page refresh — this used to only happen cross-tab.
            document.querySelectorAll('.cart-items').forEach(root => this.renderMiniCart(root));
            document.dispatchEvent(new CustomEvent('nextastore:cart-changed', { detail: { items: this.items, count, total } }));
        }
        count() { return this.items.reduce((n, i) => n + Number(i.quantity || 0), 0); }
        total() { return this.items.reduce((n, i) => n + Number(i.price || 0) * Number(i.quantity || 0), 0); }
        add(product, quantity = 1, store = null) {
            quantity = Math.max(1, Number(quantity) || 1);
            const storeId = store?.id || product.storeId;
            const existing = this.items.find(i => i.productId === product.id);
            const stock = Number(product.stock ?? Infinity);
            if (existing && existing.quantity + quantity > stock) throw new Error(`Only ${stock} left in stock.`);
            if (!existing && quantity > stock) throw new Error(`Only ${stock} left in stock.`);
            if (existing) existing.quantity += quantity;
            else this.items.push({
                productId: product.id, quantity, name: product.name, price: Number(product.price),
                image: product.thumbnail || product.image || (Array.isArray(product.images) ? product.images[0] : null),
                icon: product.icon || 'fa-box', stock,
                storeId, storeName: store?.name || product.storeName || 'NextaStore Seller', storeSlug: store?.slug || product.storeSlug || null,
                storeLogo: store?.logo || null, storeDistrict: store?.district || null, storeAddress: store?.address || null, storeDirections: store?.detailedDirections || null, storeMapCoordinates: store?.mapCoordinates || null, storePayments: store?.payments || null
            });
            this.save();
        }
        setQuantity(productId, quantity) {
            const item = this.items.find(i => i.productId === productId); if (!item) return;
            quantity = Number(quantity); const stock = Number(item.stock ?? Infinity);
            if (!Number.isFinite(quantity) || quantity <= 0) return this.remove(productId);
            if (quantity > stock) throw new Error(`Only ${stock} left in stock.`);
            item.quantity = Math.floor(quantity); this.save();
        }
        change(productId, delta) { const item = this.items.find(i => i.productId === productId); if (item) this.setQuantity(productId, item.quantity + Number(delta)); }
        remove(productId) { this.items = this.items.filter(i => i.productId !== productId); this.save(); }
        clear() { this.items = []; this.save(); }
        groups() {
            const map = new Map();
            this.items.forEach(i => { if (!map.has(i.storeId)) map.set(i.storeId, { storeId: i.storeId, storeName: i.storeName, storeSlug: i.storeSlug, storeLogo: i.storeLogo, district: i.storeDistrict, address: i.storeAddress, detailedDirections: i.storeDirections, mapCoordinates: i.storeMapCoordinates, payments: i.storePayments, items: [] }); map.get(i.storeId).items.push(i); });
            return [...map.values()].map(g => ({ ...g, subtotal: g.items.reduce((n, i) => n + i.price * i.quantity, 0) }));
        }
        renderMiniCart(root) {
            if (!root) return;
            if (!this.items.length) { root.innerHTML = '<div class="cart-empty"><i class="fas fa-cart-shopping"></i><p>Your cart is empty</p><a class="btn btn-primary btn-sm" href="marketplace.html">Keep shopping</a></div>'; return; }
            root.innerHTML = this.items.map(i => `<div class="cart-item"><div class="cart-item-thumb">${i.image ? `<img src="${i.image}" alt="">` : `<i class="fas ${i.icon} product-thumb-icon"></i>`}</div><div class="cart-item-details"><h4>${app.escapeHtml(i.name)}</h4><small>${app.escapeHtml(i.storeName)}</small><p>${app.formatCurrency(i.price)}</p><div class="quantity-selector"><button class="qty-btn" onclick="window.NextaCart.change('${i.productId}',-1)">−</button><span>${i.quantity}</span><button class="qty-btn" onclick="window.NextaCart.change('${i.productId}',1)">+</button></div></div><button class="remove-item" onclick="window.NextaCart.remove('${i.productId}')" aria-label="Remove"><i class="fas fa-trash"></i></button></div>`).join('');
        }
    }
    global.NextaCart = new NextaCart();
    window.addEventListener('storage', e => { if (e.key === KEY) { global.NextaCart.items = global.NextaCart.read(); global.NextaCart.notify(); } });

    // Cart-drawer wiring — shared by every page that ships the store-detail
    // style ".cart-btn" + "#cartDrawer" markup (currently store-detail and
    // product-detail only; marketplace/stores link their cart icon straight
    // to cart.html and never render #cartDrawer at all). Living here instead
    // of in each page's own script means every page gets identical
    // open/close/checkout behaviour for free just by including the markup,
    // with one place to change it.
    //
    // Even on a page that has the drawer, it's a desktop-only convenience —
    // a shopper who's mid-browse on a big screen can peek at their cart
    // without losing their place. On mobile there's no spare screen real
    // estate for a slide-out panel next to page content, so the same
    // ".cart-btn" click just goes to the real cart page instead of opening
    // the drawer, matching how every other page's cart icon already works.
    const MOBILE_CART_BREAKPOINT = '(max-width: 768px)';
    function setupCartDrawer() {
        const drawer = document.getElementById('cartDrawer');
        if (!drawer) return; // page doesn't use the drawer-style cart

        document.querySelectorAll('.cart-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (window.matchMedia(MOBILE_CART_BREAKPOINT).matches) {
                    window.location.href = 'cart.html';
                } else {
                    drawer.classList.add('open');
                }
            });
        });
        document.querySelectorAll('.cart-close').forEach(btn => {
            btn.addEventListener('click', () => drawer.classList.remove('open'));
        });
        document.getElementById('checkoutBtn')?.addEventListener('click', () => {
            window.location.href = 'cart.html';
        });
        document.getElementById('orderConfirmationCloseBtn')?.addEventListener('click', () => {
            drawer.classList.remove('open');
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        global.NextaCart.notify();
        setupCartDrawer();
    });
})(window);
