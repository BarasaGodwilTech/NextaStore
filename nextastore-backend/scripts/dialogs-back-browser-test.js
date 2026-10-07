#!/usr/bin/env node
// WIP 40: desktop notification text wraps in full, app.prompt() (the in-site replacement for
// window.prompt), and the smart Back link (js/back-nav.js). Serves the static site itself; the API is stubbed.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', '..');
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = path.join(root, p); if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  const ext = path.extname(f); r.writeHead(200, {'Content-Type': {'.html':'text/html','.js':'text/javascript','.css':'text/css'}[ext]||'application/octet-stream'}); r.end(fs.readFileSync(f));
});
let pass=0, fail=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); c?pass++:fail++;};
(async()=>{
  await new Promise(r=>srv.listen(0,r)); const base='http://localhost:'+srv.address().port;
  const b = await chromium.launch(); 
  const ctx = await b.newContext({viewport:{width:1280,height:800}}); const page = await ctx.newPage();
  await page.route(/cdnjs|fonts\.g/, r=>r.abort());
  await page.route('**/api/**', r=>r.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await page.goto(base+'/marketplace.html'); await page.waitForFunction(()=>typeof app!=='undefined');
  // 1. notifications wrap on desktop
  const res = await page.evaluate(()=>{
    const d=document.createElement('div'); d.className='notification-nav-wrap open'; d.style.cssText='position:fixed;top:60px;right:20px';
    d.innerHTML='<div class="notification-preview"><div class="notification-preview-list"><a class="notification-preview-item"><span class="notification-preview-icon"></span><span class="notification-preview-main"><strong>Your store is currently hidden from shoppers</strong><span>Your trial ended and no subscription payment has been confirmed yet. Renew your Seller Pass to return to the marketplace; a 6+ month commitment restores a seller badge after approval.</span><time>30 Sept</time></span></a></div></div>';
    document.body.appendChild(d); const s=d.querySelector('.notification-preview-main span'), t=d.querySelector('strong');
    return {ws:getComputedStyle(s).whiteSpace, to:getComputedStyle(s).textOverflow, h:s.getBoundingClientRect().height, tws:getComputedStyle(t).whiteSpace, scroll:s.scrollWidth<=s.clientWidth+1};
  });
  ok('desktop notification body wraps (white-space normal, no ellipsis, multi-line)', res.ws==='normal' && res.tws==='normal' && res.h>30 && res.scroll);
  // 2. app.prompt
  const p1 = page.evaluate(()=>app.prompt({title:'Report an issue',minLength:5,maxLength:1000}));
  await page.waitForSelector('.site-dialog-form'); await page.waitForTimeout(150);
    await page.fill('.site-dialog-input','abc'); await page.click('[data-dialog-confirm]');
  ok('too-short text shows inline error and keeps dialog open', (await page.textContent('.site-dialog-error')).length>0 && await page.$('.site-dialog-form')!==null);
  await page.fill('.site-dialog-input','The item never arrived'); 
  await page.mouse.click(3,3); // backdrop click while text typed
  ok('backdrop click does NOT discard typed text', await page.$('.site-dialog-form')!==null);
  await page.click('[data-dialog-confirm]');
  ok('valid text resolves trimmed value', (await p1)==='The item never arrived' && await page.$('.site-dialog-form')===null);
  const p2 = page.evaluate(()=>app.prompt({title:'x'})); await page.waitForSelector('.site-dialog-form'); await page.waitForTimeout(150); ok('prompt opens focused on its field', await page.evaluate(()=>document.activeElement.classList.contains('site-dialog-input'))); await page.keyboard.press('Escape');
  ok('Escape resolves null', (await p2)===null);
  const p3 = page.evaluate(()=>app.prompt({title:'Link',readOnly:true,copyable:true,multiline:false,defaultValue:'https://x.test/r?t=1',confirmText:'Done'})); await page.waitForSelector('.site-dialog-form');
  ok('read-only copy dialog has no Cancel and shows value', await page.$('[data-dialog-cancel]')===null && (await page.inputValue('.site-dialog-input'))==='https://x.test/r?t=1');
  await page.click('[data-dialog-confirm]'); await p3;
  // 4. back link behaviour end to end: favorites -> cart
  const pg2 = await ctx.newPage(); await pg2.route(/cdnjs|fonts\.g/, r=>r.abort()); await pg2.route('**/api/**', r=>r.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await pg2.goto(base+'/cart.html'); await pg2.waitForSelector('[data-back-link]');
  ok('cold open of cart: label is "Continue shopping", href=/marketplace', (await pg2.textContent('[data-back-link]')).trim()==='Continue shopping' && (await pg2.getAttribute('[data-back-link]','href'))==='/marketplace');
  // 3. back-nav unit logic
  const bn = await pg2.evaluate(()=>{ const L={href:'https://a.test/store-x',origin:'https://a.test',pathname:'/store-x',search:''}; const c=NextaBack.canGoBack;
    return [c('https://a.test/favorites',L,3), c('',L,3), c('https://other.test/x',L,3), c('https://a.test/login',L,3), c('https://a.test/store-x',L,3), c('https://a.test/cart',L,1), c('https://a.test/p/abc',L,3)]; });
  ok('canGoBack: in-site=true, none=false, external=false, login=false, same page=false, new tab(len1)=false', JSON.stringify(bn.slice(0,6))==='[true,false,false,false,false,false]');
  await pg2.goto(base+'/safety.html'); await pg2.waitForSelector('[data-back-link]');
  ok('safety page cold: fallback label present', (await pg2.textContent('[data-back-link]')).includes('Back to marketplace'));
  await pg2.goto(base+'/about-nothing'); // 404 page
  await pg2.goto(base+'/safety.html');
  await pg2.evaluate(()=>{ const a=document.createElement('a'); a.href='/cart.html'; a.id='jump'; a.textContent='go'; document.body.prepend(a); }); await pg2.click('#jump');
  await pg2.waitForSelector('[data-back-link]'); await pg2.waitForFunction(()=>document.querySelector('[data-back-link]')?.dataset.backMode);
  ok('arrived from safety page: label becomes plain "Back"', (await pg2.textContent('[data-back-link]')).trim()==='Back' && (await pg2.getAttribute('[data-back-link]','data-back-mode'))==='history');
  await pg2.click('[data-back-link]'); await pg2.waitForURL(/safety/);
  ok('clicking Back returns to the page we came from (not the marketplace)', /safety/.test(pg2.url()));
  console.log(`\n${pass}/${pass+fail} passed`); await b.close(); srv.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2)});
