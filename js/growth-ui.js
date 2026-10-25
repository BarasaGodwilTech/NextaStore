/**
 * GrowthUI: the small shared toolkit for every growth page (so each page stops re-typing it).
 *   esc, ugx, day, when, titleCase            formatting (esc is the ONLY way server text goes into innerHTML)
 *   toast(msg)                                 polite, announced to screen readers
 *   dialog(html, { label })                    accessible <dialog>: focus moves in, Esc and the backdrop close it, focus returns
 *   confirm({ title, body, ok, danger })       Promise<boolean>   (replaces window.confirm)
 *   prompt({ title, body, label, ok, ... })    Promise<string|null> (replaces window.prompt)
 *   busy(btn, fn, onError)                     disables a button while its action runs, shows the error as a toast
 *   keepScroll(fn)                             re-render without the page jumping to the top
 *   online banner + service worker             the Crew: "You are offline" and installable app support
 */
(function (root) {
    'use strict';
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
    const ugx = (n) => `UGX ${Number(n || 0).toLocaleString('en-UG')}`;
    const day = (d) => new Date(d).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' });
    const when = (d) => new Date(d).toLocaleString('en-UG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    // ---- toast: one live region for the whole page
    let live, toastTimer;
    function ensureLive() {
        if (live && live.isConnected) return live;
        live = document.createElement('div');
        live.className = 'gp-toasts'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
        document.body.appendChild(live); return live;
    }
    function toast(msg, ms = 4200) {
        const box = ensureLive(); box.textContent = '';
        const t = document.createElement('div'); t.className = 'gp-toast'; t.textContent = msg; box.appendChild(t);
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.remove(); }, ms);
    }

    // ---- dialogs
    function dialog(html, { label = '', wide = false } = {}) {
        const opener = document.activeElement;
        const d = document.createElement('dialog');
        d.className = `gp-dialog${wide ? ' is-wide' : ''}`;
        if (label) d.setAttribute('aria-label', label);
        d.innerHTML = html; document.body.appendChild(d);
        d.addEventListener('close', () => { d.remove(); if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); });
        d.addEventListener('click', (e) => { if (e.target === d) d.close(); });          // click on the dim area
        d.showModal();
        const first = d.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]), textarea, select');
        if (first) first.focus();
        return d;
    }
    function ask({ title, body = '', label = '', placeholder = '', ok = 'OK', cancel = 'Cancel', danger = false, input = false, multiline = false, required = true, minLength = 0 }) {
        return new Promise((resolve) => {
            const field = !input ? '' : `<div class="gp-field"><label for="gpAskIn">${esc(label || title)}</label>${multiline
                ? `<textarea id="gpAskIn" rows="3" maxlength="300" placeholder="${esc(placeholder)}"></textarea>`
                : `<input id="gpAskIn" maxlength="200" placeholder="${esc(placeholder)}">`}</div><div class="gp-error" id="gpAskErr" role="alert"></div>`;
            const d = dialog(`<form method="dialog" class="gp-form" id="gpAskForm"><h2>${esc(title)}</h2>${body ? `<p class="gp-muted">${esc(body)}</p>` : ''}${field}
                <div class="gp-row gp-row-end"><button type="button" class="gp-btn" id="gpAskNo">${esc(cancel)}</button><button type="submit" class="gp-btn ${danger ? 'is-danger-solid' : 'is-primary'}" id="gpAskYes">${esc(ok)}</button></div></form>`, { label: title });
            let settled = false;
            const finish = (v) => { if (settled) return; settled = true; resolve(v); if (d.open) d.close(); };
            d.querySelector('#gpAskNo').onclick = () => finish(input ? null : false);
            d.addEventListener('close', () => finish(input ? null : false));
            d.querySelector('#gpAskForm').addEventListener('submit', (e) => {
                e.preventDefault();
                if (!input) return finish(true);
                const v = d.querySelector('#gpAskIn').value.trim();
                if (required && v.length < Math.max(1, minLength)) { d.querySelector('#gpAskErr').textContent = minLength > 1 ? `Please write at least ${minLength} characters.` : 'Please fill this in.'; return undefined; }
                return finish(v);
            });
        });
    }
    const confirm = (opts) => ask({ ...opts, input: false });
    const prompt = (opts) => ask({ ...opts, input: true });

    // ---- buttons and scroll
    async function busy(btn, fn, onError) {
        if (!btn || btn.disabled) return;
        btn.disabled = true; btn.setAttribute('aria-busy', 'true');
        try { await fn(); }
        catch (err) { (onError || ((e) => toast(e.message || 'Something went wrong. Please try again.')))(err); }
        finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
    async function keepScroll(fn) { const y = window.scrollY; const r = await fn(); window.scrollTo(0, y); return r; }

    // ---- offline banner (all pages) and the service worker (program hosts only)
    function offlineBanner() {
        let bar;
        const sync = () => {
            if (!navigator.onLine && !bar) { bar = document.createElement('div'); bar.className = 'gp-offline'; bar.setAttribute('role', 'status'); bar.innerHTML = '<i class="fas fa-wifi" aria-hidden="true"></i> You are offline. Anything you log is saved on your phone and sent when the signal is back.'; document.body.prepend(bar); }
            if (navigator.onLine && bar) { bar.remove(); bar = null; }
        };
        window.addEventListener('online', sync); window.addEventListener('offline', sync); sync();
    }
    function registerWorker() {
        const H = root.NextaHosts;
        if (!('serviceWorker' in navigator) || !H || H.mode !== 'subdomain' || !H.isProgramHost) return;
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* an old browser or a blocked worker: the page still works */ });
    }

    root.GrowthUI = { esc, ugx, day, when, titleCase, toast, dialog, confirm, prompt, busy, keepScroll, offlineBanner, registerWorker };
    if (root.NextaHosts) root.NextaHosts.watch();
})(window);
