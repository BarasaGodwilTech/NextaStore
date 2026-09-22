class FollowingPageManager {
    constructor() { this.page = 1; this.init(); }

    async init() { await this.load(1); }

    async load(page) {
        const c = document.getElementById('followingListContainer');
        c.innerHTML = Array.from({ length: 4 }).map(() =>
            '<div class="store-card is-skeleton"><div class="skeleton" style="width:100%;aspect-ratio:2.4;border-radius:12px 12px 0 0;"></div><div style="padding:14px;"><div class="skeleton skeleton-text" style="width:70%;"></div><div class="skeleton skeleton-text-sm" style="width:40%"></div></div></div>'
        ).join('');
        try {
            const r = await app.apiRequest(`/store/follows?page=${page}&limit=24`);
            this.page = page;
            this.render(r.data, r.pagination);
        } catch (e) {
            c.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon"><i class="fas fa-circle-exclamation"></i></div><h3>Couldn't load stores you follow</h3><p>${app.escapeHtml(e.message)}</p><button class="btn btn-outline" id="followingRetry">Try again</button></div>`;
            document.getElementById('followingRetry')?.addEventListener('click', () => this.load(page));
        }
    }

    render(stores, p) {
        const c = document.getElementById('followingListContainer');
        if (!stores.length) {
            c.innerHTML = `<div class="following-empty" style="grid-column:1/-1;"><i class="far fa-heart"></i><h2>Not following any stores yet</h2><p>Follow a seller's store to keep up with their new products here.</p><a href="marketplace.html" class="btn btn-primary">Browse marketplace</a></div>`;
            document.getElementById('followingPagination').style.display = 'none';
            return;
        }

        c.innerHTML = stores.map(store => {
            const bannerStyle = store.banner
                ? `background-image: url(${app.resolveImageUrl(store.banner)}); background-size: cover; background-position: center;`
                : `background: ${store.bannerColor || window.NextaStoreBanner?.DEFAULT_BANNER_COLOR || '#00B074'};`;

            return `
            <div class="store-card" data-store-id="${app.escapeHtml(store.id)}" data-store-slug="${app.escapeHtml(store.slug || '')}">
                <div class="store-banner" style="${bannerStyle}"></div>
                <div class="store-info">
                    <div class="store-logo" style="${store.logo ? `background-image: url(${app.resolveImageUrl(store.logo)}); background-size: cover; background-position: center;` : ''}">
                        ${!store.logo ? app.getInitial(store.name) : ''}
                    </div>
                    <h3 class="store-name">${app.escapeHtml(store.name)} <span class="store-badge-row">${app.renderSellerBadges(store, { limit: 2 })}</span></h3>
                    <p class="store-description">${app.escapeHtml(store.description || 'No description available')}</p>
                    <div class="store-meta">
                        <span class="store-meta-item"><i class="fas fa-users"></i> ${(store.followers || 0).toLocaleString()}</span>
                        <span class="store-meta-item"><i class="fas fa-box"></i> ${store.productCount || 0} products</span>
                    </div>
                    <div class="store-actions">
                        <button type="button" class="btn btn-primary" data-visit-store="${app.escapeHtml(store.id)}">Visit Store</button>
                        <button type="button" class="btn btn-outline" data-unfollow-store="${app.escapeHtml(store.id)}">Unfollow</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        c.querySelectorAll('[data-visit-store]').forEach(btn => {
            btn.addEventListener('click', () => {
                const store = stores.find(s => s.id === btn.dataset.visitStore);
                window.location.href = app.storeLink(store);
            });
        });

        c.querySelectorAll('[data-unfollow-store]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const storeId = btn.dataset.unfollowStore;
                btn.disabled = true;
                try {
                    await app.apiRequest(`/store/follow/${encodeURIComponent(storeId)}`, { method: 'DELETE' });
                    app.showAlert('Unfollowed this store', 'success');
                    // Refresh the current page so pagination stays accurate;
                    // drop back a page if this was the last item on it.
                    const remaining = stores.length - 1;
                    const goTo = (remaining === 0 && this.page > 1) ? this.page - 1 : this.page;
                    this.load(goTo);
                } catch (err) {
                    app.showAlert(err.message || 'Could not unfollow this store. Please try again.', 'error');
                    btn.disabled = false;
                }
            });
        });

        const pe = document.getElementById('followingPagination');
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
window.followingPageManager = new FollowingPageManager();
