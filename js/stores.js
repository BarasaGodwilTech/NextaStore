class StoresDirectory {
    constructor() {
        this.stores = [];
        this.page = 1;
        this.pagination = null;
        this.loading = false;
        this.init();
    }

    async init() {
        const search = document.getElementById('storesSearch');
        search?.addEventListener('input', app.debounce(() => this.load(1, false), 300));
        search?.addEventListener('input', app.debounce(() => this.renderPreview(search.value), 180));
        search?.addEventListener('focus', () => this.renderPreview(search.value));
        search?.addEventListener('keydown', e => { if (e.key === 'Escape') this.closePreview(); });
        document.addEventListener('click', e => { if (!document.getElementById('storesSearchBar')?.contains(e.target)) this.closePreview(); });
        ['storesCategory'].forEach(id => document.getElementById(id)?.addEventListener('change', () => this.load(1, false)));
        await this.load();
    }

    async renderPreview(term) {
        const bar = document.getElementById('storesSearchBar');
        const dropdown = document.getElementById('storesSearchPreview');
        const q = (term || '').trim();
        if (!bar || !dropdown) return;
        if (q.length < 2) { this.closePreview(); return; }
        dropdown.innerHTML = '<div class="search-preview-empty"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';
        bar.classList.add('open');
        try {
            const res = await app.apiRequest(`/store/public/all?q=${encodeURIComponent(q)}&limit=6`);
            const stores = res.data || [];
            if (!stores.length) { dropdown.innerHTML = `<div class="search-preview-empty">No stores match “${app.escapeHtml(q)}”.</div>`; return; }
            dropdown.innerHTML = stores.map(store => `<a class="search-preview-item" href="${app.storeLink(store)}"><span class="search-preview-thumb" style="${store.logo ? `background-image:url('${app.escapeHtml(app.resolveImageUrl(store.logo))}')` : ''}">${store.logo ? '' : '<i class="fas fa-store"></i>'}</span><span><span class="search-preview-name">${app.escapeHtml(store.name)}</span><span class="search-preview-meta">${app.escapeHtml(store.district || 'Uganda')}</span></span></a>`).join('');
        } catch (err) { dropdown.innerHTML = '<div class="search-preview-empty">Search is temporarily unavailable. Please try again.</div>'; }
    }

    closePreview() { document.getElementById('storesSearchBar')?.classList.remove('open'); }

    async load(page = 1, append = false) {
        if (this.loading) return;
        this.loading = true;
        const root = document.getElementById('storesGrid');
        if (!append) root.innerHTML = '<div class="directory-loading"><i class="fas fa-spinner fa-spin"></i> Loading stores…</div>';
        const params = new URLSearchParams({
            page: String(page),
            limit: '24',
            q: document.getElementById('storesSearch')?.value.trim() || '',
            category: document.getElementById('storesCategory')?.value || 'all',
        });
        try {
            const response = await app.apiRequest(`/store/public/all?${params.toString()}`);
            this.stores = append ? [...this.stores, ...(response.data || [])] : (response.data || []);
            this.page = page;
            this.pagination = response.pagination || null;
            this.render();
        } catch (e) {
            root.innerHTML = `<div class="empty-state"><h3>Couldn't load stores</h3><p>${app.escapeHtml(e.message)}</p><button class="btn btn-outline" id="storesRetry">Try again</button></div>`;
            document.getElementById('storesRetry')?.addEventListener('click', () => this.load(1, false));
        } finally {
            this.loading = false;
        }
    }

    render() {
        const root = document.getElementById('storesGrid');
        if (!this.stores.length) {
            root.innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fas fa-store-slash"></i></div><h3>No matching stores</h3><p>Try another search or filter.</p></div>';
            return;
        }
        root.innerHTML = this.stores.map(s => `<a class="directory-store-card" href="${app.storeLink(s)}">
            <div class="directory-banner" style="${s.banner ? `background-image:url('${app.resolveImageUrl(s.banner)}')` : `background:${s.bannerColor || '#00B074'}`}">
                <div class="directory-logo">${s.logo ? `<img src="${app.escapeHtml(app.resolveImageUrl(s.logo))}" alt="">` : '<i class="fas fa-store"></i>'}</div>
            </div>
            <div class="directory-info">
                <div class="directory-title"><h2>${app.escapeHtml(s.name)}</h2><span class="directory-badges">${app.renderSellerBadges(s)}</span></div>
                <p>${app.escapeHtml(s.description || 'Local seller on NextaStore')}</p>
                <div class="directory-meta"><span><i class="fas fa-box"></i> ${(s.productCount || 0).toLocaleString()} products</span><span><i class="fas fa-location-dot"></i> ${app.escapeHtml(s.district || 'Uganda')}</span></div>
            </div>
        </a>`).join('') + (this.pagination?.page < this.pagination?.pages
            ? '<button type="button" class="btn btn-outline btn-block" id="storesLoadMore">Load more stores</button>' : '');
        document.getElementById('storesLoadMore')?.addEventListener('click', () => this.load(this.page + 1, true));
    }
}

window.storesDirectory = new StoresDirectory();
