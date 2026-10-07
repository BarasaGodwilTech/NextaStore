#!/usr/bin/env node
'use strict';
/*
 * A product's address (/<store-slug>/<name>-<key>) is built in two places: the
 * server (src/slugs.js, used for redirects, canonical tags, JSON-LD, notifications)
 * and the browser (js/main.js, used for every card, search result, share...). If
 * they ever disagreed, every link would cost a 301 and the canonical tag would
 * contradict the address bar. This runs both on the same inputs, and checks the
 * round trip the route depends on.
 *
 *   npm run test:product-url
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const slugs = require('../src/slugs');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const mainSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'js', 'main.js'), 'utf8');

// ---- pull the browser's copy out of main.js and run it ------------------------
const block = mainSrc.slice(mainSrc.indexOf('// nx:product-url:start'), mainSrc.indexOf('// nx:product-url:end'));
check('main.js carries the marked product-address block', block.length > 100);
const method = /\n {4}productLink\(product, storeKey\) \{[\s\S]*?\n {4}\}\n/.exec(mainSrc);
check('main.js has app.productLink() next to the store link helpers', !!method);
const ctx = {};
vm.runInNewContext(`${block}\nthis.productKey = nxProductKey; this.productSlug = nxProductSlug; this.productPath = nxProductPath;\nthis.app = { ${method ? method[0] : ''} };`, ctx);
const browser = ctx;

// ---- a corpus that includes the awkward cases ---------------------------------
const ids = ['abc', 'abc1', 'abc12', 'abc1234', 'abc12345', 'abc123456', 'cmg8x2k1a0003abcd5efgh6ij', 'CMG8X2K1A0003ABCD5EFGH6IJ', 'cabc123', 'p1', 'x', '', null, undefined, 'a-b_c.d/e', 'id with spaces 12345678', 'cl9x8y7z60000abcd1234efgh'];
const names = ['Blue Sofa', '  Blue   Sofa  ', 'Blue Sofa (3-seater)!', 'KITENGE & Co. \u2013 Bag #1', '', '   ', null, undefined, '\u00c9tag\u00e8re en bois', '\u6d4b\u8bd5', '\ud83d\udd25\ud83d\udd25', '"><script>alert(1)</script>', 'a'.repeat(200), 'word '.repeat(60), '---', '100% cotton / 2-pack', 'Sofa 3'];
const stores = ['asia-ivan', 'amina-crafts', 'a', 'Mixed-Case-1', '', 'has space', 'a/b', '../x', 'caf\u00e9', null];

let mismatches = [];
let compared = 0;
for (const id of ids) for (const name of names) for (const store of stores) {
  compared++;
  const server = slugs.productPath({ id, name }, store);
  const client = browser.productPath({ id, name }, store);
  if (server !== client) mismatches.push([id, name, store, server, client]);
}
check(`server and browser build the SAME address for ${compared} id / name / store combinations (including null, unicode, emoji, hostile text)`, mismatches.length === 0, JSON.stringify(mismatches.slice(0, 3)));
check('keys agree for every id in the corpus', ids.every(id => slugs.productKey(id) === browser.productKey(id)));
check('name slugs agree for every name in the corpus', names.every(n => slugs.productSlugFrom(n) === browser.productSlug(n)));

// ---- documented examples ------------------------------------------------------
check('example: a normal product', slugs.productPath({ id: 'cmg8x2k1a0003abcd5efgh6ij', name: 'Blue Sofa' }, 'asia-ivan') === '/asia-ivan/blue-sofa-5efgh6ij');
check('example: punctuation and case collapse to single hyphens', slugs.productPath({ id: 'cmg8x2k1a0003abcd5efgh6ij', name: 'KITENGE & Co. \u2013 Bag #1' }, 'amina-crafts') === '/amina-crafts/kitenge-co-bag-1-5efgh6ij');
check('example: a name with nothing usable still gets a readable word', slugs.productPath({ id: 'cmg8x2k1a0003abcd5efgh6ij', name: '\ud83d\udd25' }, 'asia-ivan') === '/asia-ivan/product-5efgh6ij');
check('example: upper-case ids give a lower-case key', slugs.productKey('CMG8X2K1A0003ABCD5EFGH6IJ') === '5efgh6ij');
check('no store slug, an unsafe one, or an id too short to key on: no clean address (callers use /p/<id>)', slugs.productPath({ id: 'cmg8x2k1a0003abcd5efgh6ij', name: 'x' }, '') === null && slugs.productPath({ id: 'cmg8x2k1a0003abcd5efgh6ij', name: 'x' }, 'a/b') === null && slugs.productPath({ id: 'p1', name: 'x' }, 'asia-ivan') === null);
check('an address is never longer than store + 60 readable characters + key', ids.every(id => names.every(n => { const p = slugs.productPath({ id, name: n }, 'asia-ivan'); return p === null || p.length <= '/asia-ivan/'.length + 60 + 1 + 8; })));

// ---- the browser's productLink() ----------------------------------------------
const L = (p, s) => browser.app.productLink(p, s);
const id = 'cmg8x2k1a0003abcd5efgh6ij';
check('productLink: store slug given', L({ id, name: 'Blue Sofa' }, 'asia-ivan') === '/asia-ivan/blue-sofa-5efgh6ij');
check('productLink: falls back to the product\'s own storeSlug, then store.slug', L({ id, name: 'Blue Sofa', storeSlug: 'asia-ivan' }) === '/asia-ivan/blue-sofa-5efgh6ij' && L({ id, name: 'Blue Sofa', store: { slug: 'asia-ivan' } }) === '/asia-ivan/blue-sofa-5efgh6ij');
check('productLink: accepts productId (as chat cards carry it)', L({ productId: id, name: 'Blue Sofa' }, 'asia-ivan') === '/asia-ivan/blue-sofa-5efgh6ij');
check('productLink: no store known -> /p/<id> (the server sends it on); the id is encoded', L({ id, name: 'x' }) === `/p/${id}` && L({ id: 'a b', name: 'x' }) === '/p/a%20b');
check('productLink: a store key that cannot be an address segment -> /p/<id>, never a broken or hostile link', L({ id, name: 'x' }, 'a/b') === `/p/${id}` && L({ id, name: 'x' }, '../x') === `/p/${id}`);
check('productLink: no id at all -> the marketplace', L({ name: 'x' }, 'asia-ivan') === '/marketplace' && L(null, 'asia-ivan') === '/marketplace' && L({ id: '' }, 'asia-ivan') === '/marketplace');

// ---- the round trip the route relies on ---------------------------------------
// For many random cuid-like ids and awkward names: the key parsed back out of the
// last part of the address must be the id's key, and the id must END WITH it
// (which is exactly what the database lookup asks).
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rid = () => 'c' + Array.from({ length: 24 }, () => alnum[Math.floor(rnd() * alnum.length)]).join('');
const bits = ['sofa', '3', 'x', '-', '--', '2-pack', 'Caf\u00e9', '(new)', '100%', 'a', '', '9', 'blue', '\ud83d\udd25'];
const rname = () => Array.from({ length: Math.floor(rnd() * 8) }, () => bits[Math.floor(rnd() * bits.length)]).join(rnd() < 0.5 ? ' ' : '-');
let roundTripBad = [], N = 5000;
for (let i = 0; i < N; i++) {
  const pid = rid(), name = rname();
  const p = slugs.productPath({ id: pid, name }, 'asia-ivan');
  const parts = p.split('/');                       // ['', 'asia-ivan', '<name>-<key>']
  const key = slugs.productKeyFromSlug(parts[2]);
  if (parts.length !== 3 || !/^[a-z0-9-]+$/.test(parts[2]) || key !== slugs.productKey(pid) || !pid.toLowerCase().endsWith(key)) roundTripBad.push([pid, name, p, key]);
}
check(`round trip over ${N} random ids and names: the key read back from the address is the id's key, and the id ends with it`, roundTripBad.length === 0, JSON.stringify(roundTripBad.slice(0, 3)));
check('productKeyFromSlug: only a real key comes out (>= 4 letters/digits, after the LAST hyphen)', slugs.productKeyFromSlug('blue-sofa-5efgh6ij') === '5efgh6ij' && slugs.productKeyFromSlug('5efgh6ij') === '5efgh6ij' && slugs.productKeyFromSlug('blue-sofa-') === null && slugs.productKeyFromSlug('blue-sofa-ab') === null && slugs.productKeyFromSlug('blue-sofa-5EFGH6IJ') === '5efgh6ij' && slugs.productKeyFromSlug('') === null && slugs.productKeyFromSlug(null) === null && slugs.productKeyFromSlug('a'.repeat(33)) === null);
check('"p" is a reserved store slug (nextastores.com/p/<id> must never be a store\'s address)', slugs.isReservedSlug('p') === true);

let failed = 0;
for (const c of results) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` \u2014 ${c.detail}`}`); if (!c.ok) failed++; }
console.log(`\n${results.length - failed}/${results.length} product-url checks passed.`);
process.exitCode = failed ? 1 : 0;
