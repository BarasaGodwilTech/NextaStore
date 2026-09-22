class FavoritesPageManager {
    constructor() { this.page = 1; this.init(); }

    async init() { await this.load(1); }

    async load(page) {
        const c = document.getElementById('favoritesListContainer');
        c.innerHTML = Array.from({ length: 4 }).map(() =>
            '<div class="product-card is-skeleton"><div class="skeleton" style="width:100%;aspect-ratio:1;border-radius:12px;"></div><div class="skeleton skeleton-text" style="width:70%;margin-top:10px;"></div><div class="skeleton skeleton-text-sm" style="width:40%"></div></div>'
        ).join('');
        try {
            const r = await app.apiRequest(`/favorites?page=${page}&limit=24`);
            this.page = page;
            this.render(r.data, r.pagination);
        } catch (e) {
            c.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon"><i class="fas fa-circle-exclamation"></i></div><h3>Couldn't load your favorites</h3><p>${app.escapeHtml(e.message)}</p><button class="btn btn-outline" id="favoritesRetry">Try again</button></div>`;
            document.getElementById('favoritesRetry')?.addEventListener('click', () => this.load(page));
        }
    }

    render(products, p) {
        const c = document.getElementById('favoritesListContainer');
        if (!products.length) {
            c.innerHTML = `<div class="favorites-empty" style="grid-column:1/-1;"><i class="far fa-heart"></i><h2>No favorites yet</h2><p>Tap the heart on any product to save it here for later.</p><a href="marketplace.html" class="btn btn-primary">Browse marketplace</a></div>`;
            document.getElementById('favoritesPagination').style.display = 'none';
            return;
        }

        c.innerHTML = products.map(product => {
            const thumb = app.productThumb(product);
            return `
            <div class="product-card" data-product-id="${app.escapeHtml(product.id)}">
                <div class="product-image" style="${thumb ? `background-image: url(${thumb})` : ''}">
                    ${!thumb ? `<i class="fas ${product.icon || 'fa-box'}"></i>` : ''}
                    <button class="favorite-remove-btn" type="button" aria-label="Remove from favorites" data-remove-favorite="${app.escapeHtml(product.id)}"><i class="fas fa-heart"></i></button>
                    ${product.originalPrice && product.originalPrice > product.price
                        ? `<span class="product-badge">-${Math.round((1 - product.price / product.originalPrice) * 100)}%</span>` : ''}
                </div>
                <div class="product-info">
                    <p class="product-store">${app.escapeHtml(product.storeName || 'NextaStore Seller')}</p>
                    <h4 class="product-name">${app.escapeHtml(product.name)}</h4>
                    <div class="product-price">
                        <span class="current-price">${app.formatCurrency(product.price)}</span>
                        ${product.originalPrice && product.originalPrice > product.price
                            ? `<span class="product-original-price">${app.formatCurrency(product.originalPrice)}</span>` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');

        c.querySelectorAll('[data-product-id]').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('[data-remove-favorite]')) return;
                const storeKey = products.find(p => p.id === card.dataset.productId)?.storeSlug;
                window.location.href = `product-detail.html?id=${encodeURIComponent(card.dataset.productId)}${storeKey ? `&store=${encodeURIComponent(storeKey)}` : ''}`;
            });
        });

        c.querySelectorAll('[data-remove-favorite]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const productId = btn.dataset.removeFavorite;
                btn.disabled = true;
                try {
                    await app.apiRequest(`/favorites/${encodeURIComponent(productId)}`, { method: 'DELETE' });
                    app.showAlert('Removed from favorites', 'success');
                    // Refresh the current page so pagination stays accurate;
                    // drop back a page if this was the last item on it.
                    const remaining = products.length - 1;
                    const goTo = (remaining === 0 && this.page > 1) ? this.page - 1 : this.page;
                    this.load(goTo);
                } catch (err) {
                    app.showAlert(err.message || 'Could not remove this favorite. Please try again.', 'error');
                    btn.disabled = false;
                }
            });
        });

        const pe = document.getElementById('favoritesPagination');
        if (p && p.pages > 1) {
            pe.style.display = 'flex';
            pe.innerHTML = `<button class="btn btn-outline btn-sm" ${p.page <= 1 ? 'disabled' : ''} data-prev>Previous</button><span>Page ${p.page} of ${p.pages}</span><button class="btn btn-outline btn-sm" ${p.page >= p.pages ? 'disabled' : ''} data-next>Next</button>`;
            pe.querySelector('[data-prev]')?.addEventListener('click', () => this.load(this.page - 1));
            pe.querySelector('[data-next]')?.addEventListener('click', () => this.load(this.page + 1));
        } else {
            pe.style.display = 'none';
        }
    }
}
window.favoritesPageManager = new FavoritesPageManager();
