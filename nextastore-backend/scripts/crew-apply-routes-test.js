#!/usr/bin/env node
// The Crew application page is routed: /crew-apply (path mode), crew.<domain>/apply (subdomain mode), with redirects from the other hosts.
const path = require('path');
const { createHostRouter } = require('../src/growth/subdomains');
const { createHosts, fromEnv } = require('../src/growth/hosts');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else fail++; console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : '   ' + (extra || '')}`); };
function call(router, url, host) {
    return new Promise((resolve) => {
        const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, removeHeader() {}, end(b) { this.body = b ? String(b) : ''; resolve({ status: this.statusCode, headers: this.headers, body: this.body, next: false }); } };
        router({ url, method: 'GET', headers: { host: host || 'localhost' }, socket: {} }, res, () => resolve({ next: true }));
    });
}
(async () => {
    const dir = path.join(__dirname, '..', '..');
    const p = createHostRouter({ hosts: createHosts(fromEnv({})), pagesDir: dir });
    const a = await call(p, '/crew-apply'); check('path mode: /crew-apply serves the application page', a.status === 200 && /Apply to join the Crew/.test(a.body) && /NEXTA_HOSTS=/.test(a.body), a.status);
    const b = await call(p, '/apply'); check('path mode: /apply serves it too', b.status === 200 && /id="caForm"|caMain/.test(b.body));
    const hosts = createHosts(fromEnv({ GROWTH_MODE: 'subdomain', GROWTH_ROOT_DOMAIN: 'nextastore.com' }));
    const sp = createHostRouter({ hosts, pagesDir: dir });
    check('hosts.applyUrl in subdomain mode is crew.<domain>/apply', hosts.applyUrl() === 'https://crew.nextastore.com/apply', hosts.applyUrl());
    check('hosts.applyUrl in path mode is /crew-apply', createHosts(fromEnv({})).applyUrl() === '/crew-apply');
    const c = await call(sp, '/apply', 'crew.nextastore.com'); check('crew host: /apply serves the page', c.status === 200 && /Apply to join the Crew/.test(c.body), c.status);
    const d = await call(sp, '/crew-apply?x=1', 'crew.nextastore.com'); check('crew host: /crew-apply serves the page too', d.status === 200);
    const e = await call(sp, '/crew-apply', 'nextastore.com'); check('main host: redirects to the crew host', e.status === 302 && e.headers.location === 'https://crew.nextastore.com/apply', JSON.stringify(e.headers));
    const f = await call(sp, '/apply', 'circle.nextastore.com'); check('circle host: redirects to the crew host', f.status === 302 && f.headers.location === 'https://crew.nextastore.com/apply', JSON.stringify(f.headers));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
