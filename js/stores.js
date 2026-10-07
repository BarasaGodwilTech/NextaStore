/**
 * All stores directory (stores.html).
 *
 * Built to keep working as the number of stores grows:
 *  - the server pages the list (24 per page; 24 fills 2, 3 and 4 columns evenly), so only one page is ever in the DOM
 *  - numbered pagination with a collapsing window (1 ... 7 8 9 ... 412) and a "go to page" box on phones
 *  - every control (search, category, sort, badged-only, page) lives in the URL, so a filtered page can be
 *    shared, reloaded, and the browser Back button steps through pages
 *  - requests are numbered: a slow, older response can never overwrite a newer one
 *  - images are lazy and a broken image falls back to the placeholder
 */
const STORES_PAGE_SIZE = 24;
const STORES_SORTS = ['featured', 'newest', 'name'];
const STORES_MAX_PAGE = 5000;

class StoresDirectory {
    constructor() {
        this.state = { q: '', category: '', sort: 'featured', badged: false, page: 1 };
        this.total = 0;
        this.pages = 1;
        this.seq = 0;
        this.previewSeq = 0;
        this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));
    }

    // ---------- setup ----------
    async init() {
        const search = document.getElementById('storesSearch');
        const onSearch = app.debounce(() => {
            const q = search.value.trim().slice(0, 100);
            if (q === this.state.q) return;
            this.state.q = q;
            this.state.page = 1;
            this.load();
        }, 300);
        search?.addEventListener('input', onSearch);
        search?.addEventListener('input', app.debounce(() => this.renderPreview(search.value), 180));
        search?.addEventListener('focus', () => this.renderPreview(search.value));
        search?.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closePreview();
            if (e.key === 'Enter') { this.closePreview(); this.state.q = search.value.trim().slice(0, 100); this.state.page = 1; this.load(); }
        });
        document.addEventListener('click', e => { if (!document.getElementById('storesSearchBar')?.contains(e.target)) this.closePreview(); });

        document.getElementById('storesCategory')?.addEventListener('change', e => {
            this.state.category = e.target.value || '';
            this.state.page = 1;
            this.load();
        });
        document.getElementById('storesSort')?.addEventListener('change', e => {
            this.state.sort = STORES_SORTS.includes(e.target.value) ? e.target.value : 'featured';
            this.state.page = 1;
            this.load();
        });
        document.getElementById('storesBadged')?.addEventListener('click', () => {
            this.state.badged = !this.state.badged;
            this.state.page = 1;
            this.paintControls();
            this.load();
        });

        // removable filter chips + "Clear all"
        document.getElementById('storesActive')?.addEventListener('click', e => {
            const b = e.target.closest('[data-remove]');
            if (!b) return;
            const what = b.getAttribute('data-remove');
            if (what === 'q' || what === 'all') this.state.q = '';
            if (what === 'category' || what === 'all') this.state.category = '';
            if (what === 'badged' || what === 'all') this.state.badged = false;
            this.state.page = 1;
            this.paintControls();
            this.load();
        });
        // empty-state "Clear filters" / error "Try again"
        document.getElementById('storesGrid')?.addEventListener('click', e => {
            if (e.target.closest('#storesClear')) {
                this.state.q = ''; this.state.category = ''; this.state.badged = false; this.state.page = 1;
                this.paintControls(); this.load();
            } else if (e.target.closest('#storesRetry')) {
                this.load();
            }
        });
        // a broken image falls back to the placeholder instead of a broken-image icon
        document.getElementById('storesGrid')?.addEventListener('error', e => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG') return;
            if (img.closest('.directory-logo')) img.replaceWith(Object.assign(document.createElement('i'), { className: 'fas fa-store' }));
            else img.remove();
        }, true);

        // pagination (buttons + numbers + "go to page")
        const pager = document.getElementById('storesPager');
        pager?.addEventListener('click', e => {
            const b = e.target.closest('[data-page]');
            if (b && !b.disabled) this.goToPage(Number(b.getAttribute('data-page')));
        });
        pager?.addEventListener('submit', e => {
            e.preventDefault();
            const input = pager.querySelector('.pg-jump input');
            if (input) this.goToPage(Number(input.value));
        });

        window.addEventListener('popstate', async () => { await this.applyUrlFilters(); this.paintControls(); this.load({ sync: false }); });

        await this.applyUrlFilters();
        this.paintControls();
        await this.load({ scroll: false }); // replaceState: tidies a stale /stores?page=9999&sort=junk link
    }

    /** /stores?q=…&category=…&sort=…&badged=1&page=… (the marketplace's "View all stores" link opens already filtered). */
    async applyUrlFilters() {
        const params = new URLSearchParams(window.location.search);
        const category = (params.get('category') || '').toLowerCase();
        const sort = params.get('sort') || '';
        const page = Math.floor(Number(params.get('page')));
        // The category picker fills the <select> on DOMContentLoaded; wait for it before choosing a value.
        if (category && document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
        this.state = {
            q: (params.get('q') || '').trim().slice(0, 100),
            category: category && window.NXCategories && window.NXCategories.get(category) ? category : '',
            sort: STORES_SORTS.includes(sort) ? sort : 'featured',
            badged: params.get('badged') === '1',
            page: Number.isFinite(page) && page > 1 ? Math.min(page, STORES_MAX_PAGE) : 1,
        };
    }

    writeUrl(push) {
        const p = new URLSearchParams();
        if (this.state.q) p.set('q', this.state.q);
        if (this.state.category) p.set('category', this.state.category);
        if (this.state.sort !== 'featured') p.set('sort', this.state.sort);
        if (this.state.badged) p.set('badged', '1');
        if (this.state.page > 1) p.set('page', String(this.state.page));
        const qs = p.toString();
        const next = window.location.pathname + (qs ? `?${qs}` : '');
        if (next === window.location.pathname + window.location.search) return;
        try { window.history[push ? 'pushState' : 'replaceState'](null, '', next); } catch (e) { /* URL sync is a convenience */ }
    }

    paintControls() {
        const search = document.getElementById('storesSearch');
        if (search && search.value.trim() !== this.state.q) search.value = this.state.q;
        const cat = document.getElementById('storesCategory');
        if (cat && cat.value !== this.state.category) cat.value = this.state.category;
        const sort = document.getElementById('storesSort');
        if (sort) sort.value = this.state.sort;
        const badged = document.getElementById('storesBadged');
        if (badged) badged.setAttribute('aria-pressed', String(this.state.badged));
    }

    // ---------- search preview (dropdown under the search box) ----------
    async renderPreview(term) {
        const bar = document.getElementById('storesSearchBar');
        const dropdown = document.getElementById('storesSearchPreview');
        const q = (term || '').trim();
        if (!bar || !dropdown) return;
        if (q.length < 2) { this.closePreview(); return; }
        const seq = ++this.previewSeq;
        dropdown.innerHTML = '<div class="search-preview-empty"><i class="fas fa-spinner fa-spin"></i> Searching…</div>';
        bar.classList.add('open');
        try {
            const res = await app.apiRequest(`/store/public/all?q=${encodeURIComponent(q)}&limit=6`);
            if (seq !== this.previewSeq) return;
            const stores = res.data || [];
            if (!stores.length) { dropdown.innerHTML = `<div class="search-preview-empty">No stores match “${app.escapeHtml(q)}”.</div>`; return; }
            dropdown.innerHTML = stores.map(store => `<a class="search-preview-item" href="${app.escapeHtml(app.storeLink(store))}"><span class="search-preview-thumb" style="${store.logo ? `background-image:url('${app.escapeHtml(app.resolveImageUrl(store.logo))}')` : ''}">${store.logo ? '' : '<i class="fas fa-store"></i>'}</span><span><span class="search-preview-name">${app.escapeHtml(store.name)}</span><span class="search-preview-meta">${app.escapeHtml(store.district || 'Uganda')}</span></span></a>`).join('');
        } catch (err) {
            if (seq !== this.previewSeq) return;
            dropdown.innerHTML = '<div class="search-preview-empty">Search is temporarily unavailable. Please try again.</div>';
        }
    }

    closePreview() { this.previewSeq++; document.getElementById('storesSearchBar')?.classList.remove('open'); }

    // ---------- loading ----------
    goToPage(n) {
        if (!Number.isFinite(n)) return;
        n = Math.max(1, Math.min(Math.floor(n), this.pages || 1));
        if (n === this.state.page) { this.paintPager(); return; }
        this.state.page = n;
        this.load({ push: true, scroll: true });
    }

    skeletons(count) {
        const card = '<div class="directory-store-card is-skeleton" aria-hidden="true"><div class="directory-banner"></div><div class="directory-info"><span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-line sk-short"></span></div></div>';
        return card.repeat(count);
    }

    async load(opts = {}) {
        const { push = false, scroll = false, sync = true } = opts;
        const seq = ++this.seq;
        const root = document.getElementById('storesGrid');
        if (!root) return;
        // keep the grid's height while the next page loads so the page does not jump
        root.style.minHeight = root.offsetHeight ? `${root.offsetHeight}px` : '';
        root.setAttribute('aria-busy', 'true');
        root.innerHTML = this.skeletons(8);
        const params = new URLSearchParams({
            page: String(this.state.page),
            limit: String(STORES_PAGE_SIZE),
            q: this.state.q,
            category: this.state.category || 'all',
            sort: this.state.sort,
        });
        if (this.state.badged) params.set('badged', '1');
        try {
            const response = await app.apiRequest(`/store/public/all?${params.toString()}`);
            if (seq !== this.seq) return; // a newer request has taken over
            const stores = response.data || [];
            const pagination = response.pagination || {};
            this.total = Number(pagination.total) || stores.length;
            this.pages = Math.max(1, Number(pagination.pages) || 1);
            // The list shrank (or a stale link points past the end): land on the last real page instead of an empty one.
            if (!stores.length && this.total > 0 && this.state.page > this.pages) {
                this.state.page = this.pages;
                return this.load({ push: false, scroll, sync });
            }
            this.stores = stores;
            this.render();
            this.paintStatus();
            this.paintPager();
            if (sync) this.writeUrl(push);
            if (scroll) this.scrollToTop();
        } catch (e) {
            if (seq !== this.seq) return;
            this.total = 0; this.pages = 1;
            root.innerHTML = `<div class="empty-state directory-empty"><div class="empty-icon"><i class="fas fa-triangle-exclamation"></i></div><h3>Couldn't load stores</h3><p>${app.escapeHtml(e.message || 'Please check your connection and try again.')}</p><button type="button" class="btn btn-outline" id="storesRetry">Try again</button></div>`;
            this.paintStatus();
            this.paintPager();
        } finally {
            if (seq === this.seq) { root.style.minHeight = ''; root.removeAttribute('aria-busy'); }
        }
    }

    scrollToTop() {
        const tools = document.getElementById('storesTools');
        if (!tools) return;
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        tools.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }

    // ---------- rendering ----------
    hasFilters() { return !!(this.state.q || this.state.category || this.state.badged); }

    cardHtml(s) {
        const esc = v => app.escapeHtml(v);
        const color = /^#[0-9a-f]{3,8}$/i.test(String(s.bannerColor || '')) ? s.bannerColor : '#00B074';
        const count = Number(s.productCount) || 0;
        const badges = app.renderSellerBadges(s, { limit: 1, more: true });
        return `<a class="directory-store-card" href="${esc(app.storeLink(s))}">
            <div class="directory-banner" style="background:${color}">${s.banner ? `<img class="directory-banner-img" src="${esc(app.resolveImageUrl(s.banner))}" alt="" loading="lazy" decoding="async">` : ''}
                ${badges ? `<span class="directory-badges">${badges}</span>` : ''}
                <div class="directory-logo">${s.logo ? `<img src="${esc(app.resolveImageUrl(s.logo))}" alt="" loading="lazy" decoding="async">` : '<i class="fas fa-store"></i>'}</div>
            </div>
            <div class="directory-info">
                <h2>${esc(s.name)}</h2>
                <div class="directory-loc"><i class="fas fa-location-dot" aria-hidden="true"></i><span>${esc(s.district || 'Uganda')}</span></div>
                <p>${esc(s.description || 'Local seller on NextaStore')}</p>
                <div class="directory-meta"><span>${count.toLocaleString()} ${count === 1 ? 'product' : 'products'}</span><span class="directory-go" aria-hidden="true"><i class="fas fa-arrow-right"></i></span></div>
            </div>
        </a>`;
    }

    render() {
        const root = document.getElementById('storesGrid');
        if (!this.stores.length) {
            root.innerHTML = this.hasFilters()
                ? '<div class="empty-state directory-empty"><div class="empty-icon"><i class="fas fa-store-slash"></i></div><h3>No matching stores</h3><p>Try a different search, or remove a filter.</p><button type="button" class="btn btn-outline" id="storesClear">Clear filters</button></div>'
                : '<div class="empty-state directory-empty"><div class="empty-icon"><i class="fas fa-store"></i></div><h3>No stores yet</h3><p>New sellers are joining all the time. Check back soon.</p></div>';
            return;
        }
        root.innerHTML = this.stores.map(s => this.cardHtml(s)).join('');
    }

    paintStatus() {
        const count = document.getElementById('storesCount');
        const active = document.getElementById('storesActive');
        if (count) {
            if (!this.total || !this.stores || !this.stores.length) count.textContent = '';
            else {
                const from = (this.state.page - 1) * STORES_PAGE_SIZE + 1;
                const to = from + this.stores.length - 1;
                const n = this.total.toLocaleString();
                count.textContent = this.total <= STORES_PAGE_SIZE && this.state.page === 1
                    ? `${n} ${this.total === 1 ? 'store' : 'stores'}${this.hasFilters() ? ' found' : ''}`
                    : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${n} stores`;
            }
        }
        if (!active) return;
        const chips = [];
        const chip = (key, label) => `<button type="button" class="stores-chip" data-remove="${key}" aria-label="Remove filter: ${app.escapeHtml(label)}"><span>${app.escapeHtml(label)}</span><i class="fas fa-xmark" aria-hidden="true"></i></button>`;
        if (this.state.q) chips.push(chip('q', `“${this.state.q}”`));
        if (this.state.category) {
            const C = window.NXCategories;
            chips.push(chip('category', (C && C.label && C.label(this.state.category)) || this.state.category));
        }
        if (this.state.badged) chips.push(chip('badged', 'Badged sellers'));
        active.innerHTML = chips.length
            ? chips.join('') + (chips.length > 1 ? '<button type="button" class="stores-clear" data-remove="all">Clear all</button>' : '')
            : '';
    }

    /** 1 … 7 8 [9] 10 11 … 412 — first, last and the neighbours of the current page. */
    pageWindow(page, pages) {
        if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
        const set = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
        const nums = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
        const out = [];
        nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('…'); out.push(n); });
        return out;
    }

    paintPager() {
        const nav = document.getElementById('storesPager');
        if (!nav) return;
        const { page } = this.state;
        const pages = this.pages;
        if (pages <= 1 || !this.stores || !this.stores.length) { nav.hidden = true; nav.innerHTML = ''; return; }
        const nums = this.pageWindow(page, pages).map(n => n === '…'
            ? '<li class="pg-gap" aria-hidden="true">…</li>'
            : `<li><button type="button" class="pg-num${n === page ? ' is-current' : ''}" data-page="${n}"${n === page ? ' aria-current="page"' : ''} aria-label="Page ${n}">${n.toLocaleString()}</button></li>`).join('');
        nav.innerHTML = `<button type="button" class="pg-btn pg-prev" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="Previous page"><i class="fas fa-chevron-left" aria-hidden="true"></i><span>Previous</span></button>
            <ol class="pg-list">${nums}</ol>
            <form class="pg-jump"><label>Page <input type="number" inputmode="numeric" min="1" max="${pages}" value="${page}" aria-label="Go to page"> of ${pages.toLocaleString()}</label></form>
            <button type="button" class="pg-btn pg-next" data-page="${page + 1}"${page >= pages ? ' disabled' : ''} aria-label="Next page"><span>Next</span><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;
        nav.classList.toggle('is-many', pages > 7);
        nav.hidden = false;
    }
}

window.storesDirectory = new StoresDirectory();
