/*
 * Staff Console runtime config (loaded as an external script so the page CSP can stay free of inline scripts).
 *
 *  api: base URL of the staff API.
 *    - Same origin as this console (default): leave '/api/staff'.
 *    - Different origin (e.g. https://api.nextastore.com/api/staff): put the full URL here AND add that origin to the
 *      `connect-src` directive of the <meta http-equiv="Content-Security-Policy"> tag in every page of this folder,
 *      and to STAFF_ORIGINS / the CORS allow-list on the server. The cookie is SameSite=Strict, so both origins must
 *      be on the same registrable domain (console.example.com + api.example.com is fine).
 */
window.STAFF_CONFIG = { api: '/api/staff' };
