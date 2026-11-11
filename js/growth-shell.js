/**
 * GrowthShell: the app frame around NextaStore Circle and NextaStore Crew (circle. / crew. hosts, or /circle and /crew).
 *
 * The programs are their own small app, not a page of the marketplace, so they get their own:
 *   - sections:  Circle  Home · Stores · Earnings · Share · More
 *                Crew    Home · Field · Stores · Earnings · More
 *                shown as a bottom tab bar on phones (thumb reach, like a native app) and as the header menu on wider screens
 *   - account menu: the member's own things first (code, payout number, link), then "back to NextaStore" links to the main site
 *   - sign-out:  one hop through the main site, so signing out here really signs out (see auth-bridge ?mode=logout)
 *
 * It owns no data. growth.js tells it who the partner is (setPartner) and which tab is showing (renderTabs);
 * it tells growth.js when a tab or a menu action was chosen (onSelect / onAction).
 * main.js renders the menu through accountMenu() for any [data-account-program] slot.
 * The tab model and menu are plain functions of their inputs so scripts/growth-shell-test.js can check them without a browser.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.GrowthShell = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

    const TABS = {
        circle: [
            { id: 'home', label: 'Home', icon: 'fa-house' },
            { id: 'recruits', label: 'Stores', icon: 'fa-store' },
            { id: 'earn', label: 'Earnings', icon: 'fa-wallet' },
            { id: 'share', label: 'Share', icon: 'fa-share-nodes' },
            { id: 'more', label: 'More', icon: 'fa-ellipsis' }
        ],
        crew: [
            { id: 'home', label: 'Home', icon: 'fa-house' },
            { id: 'field', label: 'Field', icon: 'fa-route' },
            { id: 'recruits', label: 'Stores', icon: 'fa-store' },
            { id: 'earn', label: 'Earnings', icon: 'fa-wallet' },
            { id: 'more', label: 'More', icon: 'fa-ellipsis' }
        ]
    };
    const key = (program) => (program === 'crew' ? 'crew' : 'circle');
    const SHORT = { circle: 'Circle', crew: 'Crew' };
    const isActive = (p) => !!p && (p.status === 'active' || p.status === 'frozen');

    const tabs = (program) => TABS[key(program)].slice();
    /** "#recruits" -> "recruits". Anything that is not a tab of THIS program (a stale or hand-typed hash) is Home. */
    function tabFromHash(program, hash) {
        const id = String(hash || '').replace(/^#/, '');
        return TABS[key(program)].some((t) => t.id === id) ? id : 'home';
    }

    /** The links for one tab bar. badges: { tabId: number | true }  (a number is a count, true is a plain dot) */
    function tabsHtml(program, active, badges = {}) {
        return TABS[key(program)].map((t) => {
            const b = badges[t.id];
            const badge = b === true ? '<span class="gp-dot" aria-label="needs attention"></span>' : (b > 0 ? `<span class="gp-count" aria-label="${esc(b)} need you">${esc(b > 9 ? '9+' : b)}</span>` : '');
            const on = t.id === active;
            return `<a href="#${t.id}" data-tab="${t.id}" data-local class="${on ? 'is-active' : ''}"${on ? ' aria-current="page"' : ''}><span class="gp-tab-ic"><i class="fas ${t.icon}" aria-hidden="true"></i>${badge}</span><span class="gp-tab-label">${esc(t.label)}</span></a>`;
        }).join('');
    }

    /**
     * The account menu for the program header: what main.js puts in the dropdown on circle. / crew.
     *   ctx = { program, partner, user, hosts }     (all optional; before the dashboard has loaded it still gives a usable menu)
     * Returns { role, itemsHtml }.
     */
    function menuModel(ctx) {
        const program = key(ctx.program), H = ctx.hosts, p = ctx.partner || null, user = ctx.user || {};
        const main = (path) => (H ? H.main(path) : path);
        const about = H ? H.about(program) : `/about-${program === 'crew' ? 'crew' : 'circle'}`;
        const item = (attrs, icon, label, extra = '') => `<a ${attrs} class="account-menu-item${extra ? ' ' + extra : ''}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</a>`;
        const action = (name, icon, label, extra = '') => `<button type="button" class="account-menu-item${extra ? ' ' + extra : ''}" data-gp-action="${name}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</button>`;

        let role = SHORT[program];
        const rows = [];
        if (isActive(p)) {
            role = `${SHORT[program]} member · ${esc(p.code)}`;
            rows.push(item('href="#home" data-tab-link="home" data-local', 'fa-house', 'Home'));
            rows.push(item('href="#earn" data-tab-link="earn" data-local', 'fa-wallet', 'My earnings'));
            rows.push(action('copy', 'fa-copy', 'Copy my invite link'));
            rows.push(action('payout', 'fa-mobile-screen', 'Payout number'));
        } else if (p && p.status === 'applied') {
            role = `${SHORT[program]} applicant`;
        }
        const backFirst = rows.length ? 'is-divider-top' : '';
        rows.push(item(`href="${esc(main('/marketplace'))}"`, 'fa-store', 'NextaStore marketplace', backFirst));
        if (user.role === 'seller') rows.push(item(`href="${esc(main('/dashboard'))}"`, 'fa-gauge', 'My store dashboard'));
        rows.push(item(`href="${esc(main('/messages'))}"`, 'fa-message', 'Messages <span class="unread-badge hidden" data-unread-badge></span>'));
        rows.push(item(`href="${esc(about)}"`, 'fa-circle-info', `About ${SHORT[program]}`, 'is-divider-top'));
        rows.push(item(`href="${esc(main('/terms'))}"`, 'fa-file-lines', 'Terms'));
        return { role, itemsHtml: rows.join('') };
    }

    // ------------------------------------------------------------------ browser wiring
    const state = { program: (root.document && root.document.body && root.document.body.getAttribute('data-program') === 'crew') ? 'crew' : 'circle', partner: null, active: 'home', onSelect: null, onAction: null, wired: false };

    function setPartner(p, program) { state.partner = p || null; if (program) state.program = key(program); }

    /** Called by main.js renderAccountNav for a [data-account-program] slot. */
    function accountMenu(app) {
        return menuModel({ program: state.program, partner: state.partner, user: app && app.user, hosts: root.NextaHosts });
    }

    function wire() {
        if (state.wired || !root.document) return;
        state.wired = true;
        root.document.addEventListener('click', (e) => {
            const t = e.target.closest && e.target.closest('[data-tab], [data-tab-link]');
            if (t && state.onSelect) {
                e.preventDefault();
                const menu = t.closest('[data-account-menu]'); if (menu) menu.classList.remove('open');
                state.onSelect(t.getAttribute('data-tab') || t.getAttribute('data-tab-link'));
                return;
            }
            const a = e.target.closest && e.target.closest('[data-gp-action]');
            if (a && state.onAction) {
                const menu = a.closest('[data-account-menu]'); if (menu) menu.classList.remove('open');
                state.onAction(a.getAttribute('data-gp-action'));
            }
        });
    }

    /** Show the section tabs (dashboard): top menu on wide screens, bottom bar on phones. */
    function renderTabs({ program, active, badges }) {
        const d = root.document; if (!d) return;
        state.program = key(program); state.active = active; wire();
        const top = d.getElementById('gpTopNav'), bar = d.getElementById('gpTabbar');
        const html = tabsHtml(program, active, badges || {});
        if (top) { top.innerHTML = html; top.hidden = false; top.setAttribute('aria-label', `${SHORT[key(program)]} sections`); }
        if (bar) { bar.innerHTML = html; bar.hidden = false; bar.setAttribute('aria-label', `${SHORT[key(program)]} sections`); }
        d.body.classList.add('has-tabbar');
    }

    /** Join / waiting / closed screens have no sections: just the way to the info page and back to NextaStore. */
    function renderLinks({ program }) {
        const d = root.document; if (!d) return;
        state.program = key(program); wire();
        const H = root.NextaHosts, k = key(program);
        const top = d.getElementById('gpTopNav'), bar = d.getElementById('gpTabbar');
        if (bar) { bar.hidden = true; bar.innerHTML = ''; }
        d.body.classList.remove('has-tabbar');
        if (top) {
            top.hidden = false; top.setAttribute('aria-label', 'Navigation');
            top.innerHTML = `<a href="${esc(H ? H.about(k) : '/about-' + (k === 'crew' ? 'crew' : 'circle'))}"><i class="fas fa-circle-info" aria-hidden="true"></i><span>About ${SHORT[k]}</span></a><a href="${esc(H ? H.main('/marketplace') : '/marketplace')}"><i class="fas fa-store" aria-hidden="true"></i><span>NextaStore</span></a>`;
        }
    }

    return { tabs, tabFromHash, tabsHtml, menuModel, setPartner, accountMenu, renderTabs, renderLinks, onSelect: (fn) => { state.onSelect = fn; }, onAction: (fn) => { state.onAction = fn; }, esc };
});
