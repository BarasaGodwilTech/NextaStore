/* Stand-in for the real main.js: just what the growth pages use. */
const app = (() => {
    const apiRequest = async (path, opts = {}) => {
        const token = localStorage.getItem('nextastore_token');
        let res;
        try { res = await fetch(`/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } }); }
        catch (e) { const err = new Error('You appear to be offline.'); err.isNetwork = true; throw err; }
        let body = null; try { body = await res.json(); } catch (e) { /* no body */ }
        if (!res.ok) { const err = new Error((body && body.message) || 'Request failed'); err.status = res.status; err.code = body && body.code; throw err; }
        return body;
    };
    return { apiRequest };
})();
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('nextastore_token');
    let user = null; try { user = JSON.parse(localStorage.getItem('nextastore_user')); } catch (e) { /* none */ }
    if (document.body.hasAttribute('data-auth-required') && !token) { location.href = '/login'; return; }
    if (document.body.hasAttribute('data-admin-required') && (!user || user.role !== 'admin')) { location.href = '/marketplace'; return; }
    const slot = document.querySelector('[data-account-nav]');
    if (slot) {
        slot.innerHTML = token ? '<a href="/dashboard">Account</a><button id="stubLogout" type="button">Log out</button>' : '<a href="/login">Log in</a>';
        const out = document.getElementById('stubLogout');
        if (out) out.onclick = () => { ['nextastore_token', 'nextastore_user', 'nextastore_remember'].forEach((k) => localStorage.removeItem(k)); location.href = '/login'; };
    }
});
