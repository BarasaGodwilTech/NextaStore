'use strict';
/*
 * For the browser tests: answers a product's own address the way routes/seo.js
 * does, using the REAL src/seo.js (renderProductShell / buildProductShare) and
 * src/slugs.js on the REAL product-detail.html, so a real browser gets exactly
 * the HTML the API would send - root-relative assets, the nx-product-id /
 * nx-store-slug <meta> tags, the product's own <head> - with only the database
 * replaced by one fixture product and one fixture store.
 *
 *   const handle = makeProductAddressHandler({ root, product, store });
 *   // in a throwaway http server, before serving files:
 *   if (handle(req, res)) return;
 *
 * Handles /<store>/<name>-<key> (200, a 301 to the real spelling, or a 404 page
 * for an unknown product) and /p/<id> (301 to the real address). Returns false for
 * everything else, which the caller serves as a normal static file.
 */
const fs = require('fs');
const path = require('path');
const seo = require('../../src/seo');
const slugs = require('../../src/slugs');

module.exports = function makeProductAddressHandler({ root, product, store }) {
  const shell = () => fs.readFileSync(path.join(root, 'product-detail.html'), 'utf8');
  const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); return true; };
  const redirect = (res, status, location) => { res.writeHead(status, { location }); res.end(); return true; };

  return function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const origin = `http://${req.headers.host}`;
    const base = { siteUrl: origin, appUrl: origin };
    const canonical = slugs.productPath(product, store.slug);

    let m = /^\/p\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m) {
      if (m[1] !== product.id) return html(res, 404, seo.renderProductShell(shell(), base));
      return redirect(res, 301, canonical + url.search);
    }

    m = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)$/.exec(p);
    if (!m || slugs.isReservedSlug(slugs.slugify(m[1]))) return false;
    const key = slugs.productKeyFromSlug(m[2]);
    if (!key) return false;
    const known = (m[1] === store.slug || m[1] === store.id) && product.id.toLowerCase().endsWith(key);
    if (!known) return html(res, 404, seo.renderProductShell(shell(), base));
    if (p !== canonical) return redirect(res, 301, canonical + url.search);
    const full = { ...product, store };
    const share = seo.buildProductShare({ product: full, store, ...base });
    return html(res, 200, seo.renderProductShell(shell(), { share, product: full, store, ...base }));
  };
};
