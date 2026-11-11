# Real-Chromium check of the dashboard share sheet + Promote studio against a tiny fake API on localhost:4000.
# Run: pip install playwright && playwright install chromium; python3 dashboard-promote-test.py  (PROMOTE_SHOTS=dir to keep screenshots)
import json, os, base64, threading, time, sys, http.server, socketserver, urllib.parse
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..','..')); OUT=os.environ.get('PROMOTE_SHOTS','/tmp/promote-shots'); os.makedirs(OUT,exist_ok=True)
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
TOKEN=f"{b64({'alg':'none'})}.{b64({'userId':'u_s','exp':int(time.time())+3600})}.sig"
USER={'id':'u_s','name':'Grace Nakato','email':'g@example.com','role':'seller'}
STORE={'id':'s1','slug':'grace-crafts','name':"Grace's Crafts",'description':'Handmade baskets and gifts','district':'kampala','address':'Main St','contactEmail':'g@example.com','phoneNumber':'+256 700 111 222','phonePublic':True,'payments':{},'followers':42,'status':'active','isPublished':True,'bannerColor':'#7A3E9D','badges':[],'stats':{'totalProducts':8,'totalOrders':21,'totalRevenue':640000}}
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        p=urllib.parse.urlparse(self.path).path
        if p.startswith('/api/'):
            d=USER if p=='/api/user/me' else STORE if p=='/api/store' else STORE['stats'] if 'stats' in p else []
            if p=='/api/growth/me/summary' or p.startswith('/api/growth'):
                self.send_response(404); self.end_headers(); self.wfile.write(b'{"success":false}'); return
            body=json.dumps({'success':True,'data':d,'pagination':{'page':1,'limit':20,'total':0,'pages':1}}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(body); return
        rel=p.lstrip('/') or 'index.html'
        f=os.path.join(ROOT,rel)
        if not os.path.exists(f) and os.path.exists(f+'.html'): f+='.html'
        if not os.path.isfile(f): self.send_response(404); self.end_headers(); return
        ct={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf'}.get(os.path.splitext(f)[1],'application/octet-stream')
        data=open(f,'rb').read(); self.send_response(200); self.send_header('Content-Type',ct); self.end_headers(); self.wfile.write(data)
socketserver.ThreadingTCPServer.allow_reuse_address=True
srv=socketserver.ThreadingTCPServer(('localhost',4000),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
res=[]; 
def check(n,ok,extra=''): res.append(ok); print(('PASS  ' if ok else 'FAIL  ')+n+(('  -> '+str(extra)) if (extra and not ok) else ''))
errors=[]
with sync_playwright() as pw:
    br=pw.chromium.launch()
    for (w,h,tag) in [(360,740,'360'),(390,844,'390'),(768,900,'768'),(1280,900,'1280')]:
        ctx=br.new_context(viewport={'width':w,'height':h},accept_downloads=True,device_scale_factor=1)
        ctx.add_init_script("try{localStorage.setItem('nextastore_token',%s);localStorage.setItem('nextastore_user',%s)}catch(e){}"%(json.dumps(TOKEN),json.dumps(json.dumps(USER))))
        pg=ctx.new_page(); pg.on('pageerror',lambda e,t=tag: errors.append(f'[{t}] {e}'))
        pg.goto('http://localhost:4000/dashboard'); 
        try: pg.wait_for_function("document.getElementById('storeDisplayName') && document.getElementById('storeDisplayName').textContent.trim()!=='My Store'",timeout=8000)
        except Exception: pass
        try: pg.wait_for_function("!document.getElementById('nxLoader')",timeout=8000)
        except Exception: pass
        time.sleep(.5)
        t=f'[{tag}] '
        # share sheet
        pg.evaluate("dashboardManager.showShareModal()"); time.sleep(.5)
        m=pg.evaluate("""()=>{const s=document.querySelector('.share-sheet').getBoundingClientRect();const c=document.getElementById('shareQrCanvas');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0;for(let i=0;i<d.length;i+=4)if(d[i]<80)dark++;return {l:s.left,r:s.right,t:s.top,b:s.bottom,vw:innerWidth,vh:innerHeight,doc:document.documentElement.scrollWidth,dark,url:document.getElementById('storeUrlModal').value,bodyScroll:getComputedStyle(document.querySelector('.share-sheet .modal-body')).overflowY}}""")
        check(t+'share sheet fits the screen',m['l']>=-1 and m['r']<=m['vw']+1 and m['t']>=-1 and m['b']<=m['vh']+1,m)
        check(t+'share QR is drawn',m['dark']>500,m['dark'])
        check(t+'no sideways scroll with sheet open',m['doc']<=m['vw']+1,m['doc'])
        pg.screenshot(path=f'{OUT}/share-{tag}.png')
        pg.evaluate("dashboardManager.hideShareModal()")
        # promote
        pg.evaluate("dashboardManager.switchSection('promote')"); time.sleep(1.2)
        # WIP 121: Promote opens on "Product posts"; this test covers the store posters and cards, so switch to them
        pg.evaluate("document.querySelector('[data-pp-mode=\"store\"]').click()"); time.sleep(.6)
        m=pg.evaluate("""()=>({doc:document.documentElement.scrollWidth,vw:innerWidth,tabbar:getComputedStyle(document.getElementById('mobileTabbar')).display,prev:document.getElementById('pmPreview').width,title:document.querySelector('.top-bar-left h2').textContent})""")
        check(t+'promote has no sideways scroll',m['doc']<=m['vw']+1,m)
        check(t+'preview drawn',m['prev']>100,m)
        check(t+'tab bar only on phones',(m['tabbar']!='none')==(w<=768),m)
        pg.screenshot(path=f'{OUT}/promote-{tag}.png',full_page=True)
        if tag in ('390','1280'):
            for tid,label in [('poster','poster'),('sign','sign'),('story','story'),('square','square'),('card','card')]:
                grp={'poster':'poster','sign':'poster','story':'social','square':'social','card':'card'}[tid]
                idx={'poster':0,'social':1,'card':2}[grp]
                pg.locator('#pmTabs .pm-tab').nth(idx).click()
                if grp!='card' and tid in('sign','square'): pg.locator('#pmSub .pm-chip').nth(1).click()
                time.sleep(.6)
                with pg.expect_download() as dl: pg.click('#pmDownload')
                path=f'{OUT}/{tag}-{tid}.png'; dl.value.save_as(path)
                check(t+f'{tid} PNG downloads',os.path.getsize(path)>8000,os.path.getsize(path))
                if tag=='390': pg.screenshot(path=f'{OUT}/ui-{tid}.png',full_page=False)
            if tag=='390':
                with pg.expect_download() as dl: pg.click('#pmPdf')
                dl.value.save_as(f'{OUT}/cards-sheet.pdf')
                pg.locator('#pmTabs .pm-tab').nth(0).click(); time.sleep(.4)
                with pg.expect_download() as dl: pg.click('#pmPdf')
                dl.value.save_as(f'{OUT}/poster.pdf')
                with pg.expect_download() as dl: pg.click('#pmQrSvg')
                dl.value.save_as(f'{OUT}/qr.svg')
        ctx.close()
    br.close()
print('page errors:',errors[:6])
print(f'{sum(res)}/{len(res)} passed')
