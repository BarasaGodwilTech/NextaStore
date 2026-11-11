#!/usr/bin/env node
'use strict';
/*
 * WIP 122: tests for GET /api/media/proxy (routes/media.js). A fake "R2 bucket" runs on a random local port and the real
 * router is mounted on a tiny Express app, so nothing outside this machine is touched.
 *   node scripts/media-proxy-test.js
 */
process.env.NODE_ENV = 'test';          // config.js demands every production secret otherwise
const http = require('http');
const path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const upstream = http.createServer((req, res) => {
    if (req.url === '/pub/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/pub/logo.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
    if (req.url === '/pub/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
    if (req.url === '/pub/redir.png') { res.writeHead(302, { Location: 'http://127.0.0.1:1/secret' }); return res.end(); }
    if (req.url === '/pub/huge.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(20 * 1024 * 1024) }); return res.end(); }
    if (req.url === '/other/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
});
upstream.listen(0, '127.0.0.1', () => {
    const port = upstream.address().port, base = `http://127.0.0.1:${port}/pub`;
    Object.assign(process.env, { R2_ENDPOINT: 'http://x', R2_ACCESS_KEY_ID: 'x', R2_SECRET_ACCESS_KEY: 'x', R2_BUCKET_NAME: 'x', R2_PUBLIC_URL: base });
    let express; try { express = require('express'); } catch (e) { console.log('SKIP  express is not installed here (run from the backend folder after npm install)'); process.exit(0); }
    const app = express(); app.use('/api/media', require(path.resolve(__dirname, '..', 'src', 'routes', 'media.js')));
    const server = app.listen(0, '127.0.0.1', async () => {
        const get = (u) => new Promise((resolve) => http.get(`http://127.0.0.1:${server.address().port}/api/media/proxy?u=${encodeURIComponent(u)}`, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }));
        let r = await get(base + '/ok.png');
        ok('an image in our bucket comes back', r.status === 200 && r.headers['content-type'] === 'image/png' && r.body.equals(PNG), r.status);
        ok('it is cacheable and usable cross-origin', /max-age=\d+/.test(r.headers['cache-control']) && r.headers['cross-origin-resource-policy'] === 'cross-origin');
        r = await get(`http://127.0.0.1:${port}/other/ok.png`); ok('a path outside the bucket is refused', r.status === 400, r.status);
        r = await get('http://example.com/pub/ok.png'); ok('another host is refused', r.status === 400, r.status);
        r = await get(`http://127.0.0.1:${port}.evil.com/pub/ok.png`); ok('a look-alike host is refused', r.status === 400, r.status);
        r = await get('http://169.254.169.254/latest/meta-data/'); ok('a cloud metadata address is refused', r.status === 400, r.status);
        r = await get(base + '/../other/ok.png'); ok('path traversal is refused', r.status === 400 || r.status === 404, r.status);
        r = await get(base + '/%2e%2e/other/ok.png'); ok('encoded path traversal is refused', r.status === 400, r.status);
        r = await get('file:///etc/passwd'); ok('a file: URL is refused', r.status === 400, r.status);
        r = await get('javascript:alert(1)'); ok('a javascript: URL is refused', r.status === 400, r.status);
        r = await get(''); ok('an empty URL is refused', r.status === 400, r.status);
        r = await get(base + '/logo.svg'); ok('SVG is refused (it can carry script)', r.status === 415, r.status);
        r = await get(base + '/page.html'); ok('a web page is refused', r.status === 415, r.status);
        r = await get(base + '/redir.png'); ok('redirects are not followed', r.status === 502, r.status);
        r = await get(base + '/huge.png'); ok('an oversized image is refused', r.status === 413, r.status);
        r = await get(base + '/missing.png'); ok('a missing image gives 404', r.status === 404, r.status);
        console.log(`\n${pass} passed, ${fail} failed`); server.close(); upstream.close(); process.exit(fail ? 1 : 0);
    });
});
