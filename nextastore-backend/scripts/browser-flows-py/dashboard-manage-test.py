# Real-Chromium check of the dashboard Products, Orders and Settings sections (WIP 120) against a tiny fake API on localhost:4000.
# Run: pip install playwright && playwright install chromium; python3 dashboard-manage-test.py  (MANAGE_SHOTS=dir to keep screenshots)
import json, os, base64, threading, time, http.server, socketserver, urllib.parse
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')); OUT = os.environ.get('MANAGE_SHOTS', '/tmp/manage-shots'); os.makedirs(OUT, exist_ok=True)
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
TOKEN = f"{b64({'alg': 'none'})}.{b64({'userId': 'u_s', 'exp': int(time.time()) + 3600})}.sig"
USER = {'id': 'u_s', 'name': 'Grace Nakato', 'email': 'g@example.com', 'role': 'seller'}
STORE = {'id': 's1', 'slug': 'grace-crafts', 'name': "Grace's Crafts", 'description': 'Handmade baskets and gifts', 'district': 'kampala', 'address': 'Main St', 'contactEmail': 'g@example.com', 'phoneNumber': '+256 700 111 222', 'phonePublic': True, 'payments': {}, 'followers': 42, 'status': 'active', 'isPublished': True, 'bannerColor': '#7A3E9D', 'badges': [], 'stats': {'totalProducts': 8, 'totalOrders': 5, 'totalRevenue': 640000}}
PRODUCTS = [
    {'id': f'p{i}', 'name': n, 'price': pr, 'stock': st, 'category': 'crafts', 'listingType': 'physical', 'images': []}
    for i, (n, pr, st) in enumerate([('Woven basket, large', 45000, 24), ('Kitenge tote bag', 38000, 12), ('Handmade soap set', 22000, 3), ('Beaded necklace', 15000, 40),
                                     ('Ceramic mug', 18000, 0), ('Shea body butter', 12000, 31), ('Barkcloth wallet', 30000, 2), ('Hand-dyed scarf', 27000, 9)])]
ORDERS = [
    {'id': '1042', 'customerName': 'Grace Nakato', 'total': 90000, 'status': 'pending', 'createdAt': '2026-10-28T09:00:00Z', 'fulfillmentMethod': 'delivery', 'store': {}},
    {'id': '1041', 'customerName': 'Moses Okello', 'total': 45000, 'status': 'pending', 'createdAt': '2026-10-28T08:00:00Z', 'fulfillmentMethod': 'pickup', 'store': {'district': 'Kampala', 'address': 'Main St'}},
    {'id': '1039', 'customerName': 'Aisha Namukasa', 'total': 128000, 'status': 'processing', 'createdAt': '2026-10-27T08:00:00Z', 'fulfillmentMethod': 'delivery', 'store': {}},
    {'id': '1036', 'customerName': 'Peter Ssemwogerere', 'total': 60000, 'status': 'delivered', 'createdAt': '2026-10-25T08:00:00Z', 'fulfillmentMethod': 'delivery', 'store': {}},
    {'id': '1033', 'customerName': 'Joan Achieng', 'total': 22000, 'status': 'cancelled', 'createdAt': '2026-10-24T08:00:00Z', 'fulfillmentMethod': 'delivery', 'store': {}}]
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); p = u.path; q = urllib.parse.parse_qs(u.query)
        if p.startswith('/api/'):
            if p.startswith('/api/growth'):
                self.send_response(404); self.end_headers(); self.wfile.write(b'{"success":false}'); return
            if p == '/api/products': d = PRODUCTS
            elif p == '/api/orders': d = [o for o in ORDERS if not q.get('status') or o['status'] == q['status'][0]]
            elif p == '/api/user/me': d = USER
            elif p == '/api/store': d = STORE
            elif 'stats' in p: d = STORE['stats']
            else: d = []
            body = json.dumps({'success': True, 'data': d, 'pagination': {'page': 1, 'limit': 24, 'total': len(d) if isinstance(d, list) else 0, 'pages': 1}}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers(); self.wfile.write(body); return
        f = os.path.join(ROOT, p.lstrip('/') or 'index.html')
        if not os.path.exists(f) and os.path.exists(f + '.html'): f += '.html'
        if not os.path.isfile(f): self.send_response(404); self.end_headers(); return
        ct = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf'}.get(os.path.splitext(f)[1], 'application/octet-stream')
        data = open(f, 'rb').read(); self.send_response(200); self.send_header('Content-Type', ct); self.end_headers(); self.wfile.write(data)
socketserver.ThreadingTCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('localhost', 4000), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
res = []
def check(n, ok, extra=''): res.append(bool(ok)); print(('PASS  ' if ok else 'FAIL  ') + n + (('  -> ' + str(extra)) if (extra and not ok) else ''))
errors = []
with sync_playwright() as pw:
    br = pw.chromium.launch()
    for (w, h, tag) in [(360, 740, '360'), (390, 844, '390'), (768, 900, '768'), (1280, 900, '1280')]:
        phone = w <= 560; t = f'[{tag}] '
        ctx = br.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
        ctx.add_init_script("try{localStorage.setItem('nextastore_token',%s);localStorage.setItem('nextastore_user',%s)}catch(e){}" % (json.dumps(TOKEN), json.dumps(json.dumps(USER))))
        pg = ctx.new_page(); pg.on('pageerror', lambda e, tg=tag: errors.append(f'[{tg}] {e}'))
        pg.goto('http://localhost:4000/dashboard')
        try: pg.wait_for_function("document.getElementById('storeDisplayName') && document.getElementById('storeDisplayName').textContent.trim()!=='My Store'", timeout=8000)
        except Exception: pass
        try: pg.wait_for_function("!document.getElementById('nxLoader')", timeout=8000)
        except Exception: pass
        time.sleep(.5)

        # ---------------- Products ----------------
        pg.evaluate("dashboardManager.switchSection('products')")
        try: pg.wait_for_function("document.querySelectorAll('.manage-product-card').length===8", timeout=8000)
        except Exception: pass
        m = pg.evaluate("""()=>{const cards=[...document.querySelectorAll('.manage-product-card')];const c=cards[2];const img=c.querySelector('.manage-product-image').getBoundingClientRect();
          const inl=c.querySelector('.stock-badge--inline'),onimg=c.querySelector('.manage-product-image .stock-badge');
          const vis=e=>e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
          const trash=c.querySelector('.manage-product-actions .btn:last-child').getBoundingClientRect(),edit=c.querySelector('.manage-product-actions .btn').getBoundingClientRect();
          const cols=new Set(cards.map(x=>Math.round(x.getBoundingClientRect().left))).size;
          return {n:cards.length,imgW:img.width,imgH:img.height,cols,inlineShown:vis(inl),onImgShown:vis(onimg),badgeTop:onimg?onimg.getBoundingClientRect().top-img.top:null,trashW:trash.width,trashH:trash.height,editH:edit.height,
                  price:getComputedStyle(c.querySelector('.manage-product-price')).fontWeight,doc:document.documentElement.scrollWidth,vw:innerWidth,
                  searchH:document.querySelector('#productsSection .search-bar').getBoundingClientRect().height}}""")
        check(t + 'products: 8 cards, no sideways scroll', m['n'] == 8 and m['doc'] <= m['vw'] + 1, m)
        check(t + 'products: delete button is a 44px round target, Edit is 44px tall', abs(m['trashW'] - 44) < 1 and m['trashH'] >= 43.5 and m['editH'] >= 43.5, m)
        check(t + 'products: price is bold', int(m['price']) >= 600, m)
        check(t + 'products: search field is 44px tall', m['searchH'] >= 43.5, m)
        if phone:
            check(t + 'products (phone): 72px thumbnail, badge moves beside the stock count', abs(m['imgW'] - 72) < 1 and m['inlineShown'] and not m['onImgShown'], m)
            check(t + 'products (phone): one card per row', m['cols'] == 1, m)
        else:
            check(t + 'products: 168px image with the badge in its top-left corner', abs(m['imgH'] - 168) < 1 and m['onImgShown'] and not m['inlineShown'] and m['badgeTop'] <= 16, m)
            if w >= 1000: check(t + 'products: 4 columns on desktop', m['cols'] == 4, m)
        pg.screenshot(path=f'{OUT}/products-{tag}.png', full_page=True)

        # ---------------- Orders ----------------
        pg.evaluate("dashboardManager.switchSection('orders')")
        try: pg.wait_for_function("document.querySelectorAll('#ordersList tbody tr').length===5", timeout=8000)
        except Exception: pass
        m = pg.evaluate("""()=>{const tr=document.querySelector('#ordersList tbody tr');const badge=tr.querySelector('.badge').getBoundingClientRect(),card=tr.getBoundingClientRect();
          const btns=[...tr.querySelectorAll('[data-order-action]')].map(b=>b.getBoundingClientRect());const view=tr.querySelector('[data-view-seller-order]').getBoundingClientRect();
          const chips=[...document.querySelectorAll('#orderStatusChips .dash-chip')];const sel=document.getElementById('orderStatusFilter').getBoundingClientRect();
          return {rows:document.querySelectorAll('#ordersList tbody tr').length,chips:chips.length,activeChip:chips.filter(c=>c.classList.contains('is-active')).map(c=>c.textContent),chipH:Math.min(...chips.map(c=>c.getBoundingClientRect().height)),
                  selW:sel.width,display:getComputedStyle(tr).display,badge:{r:badge.right,t:badge.top,b:badge.bottom,l:badge.left},card:{l:card.left,r:card.right,t:card.top},btns:btns.map(b=>({t:b.top,h:b.height,l:b.left,w:b.width})),view:{h:view.height,w:view.width},doc:document.documentElement.scrollWidth,vw:innerWidth,
                  pill:getComputedStyle(tr.querySelector('.badge')).backgroundColor}}""")
        check(t + 'orders: 5 rows, 6 status chips with "All" selected, no sideways scroll', m['rows'] == 5 and m['chips'] == 6 and m['activeChip'] == ['All'] and m['doc'] <= m['vw'] + 1, m)
        check(t + 'orders: the old select is still in the page but visually hidden', m['selW'] <= 2, m)
        check(t + 'orders: pending badge uses the amber palette', m['pill'] == 'rgb(255, 244, 221)', m['pill'])
        check(t + 'orders: Confirm and Cancel are at least 36px tall (44px on phones)', len(m['btns']) == 2 and all(b['h'] >= (43.5 if w <= 768 else 35.5) for b in m['btns']), m)
        if w <= 768:
            check(t + 'orders (phone): each order is a grid card', m['display'] == 'grid', m)
            check(t + 'orders (phone): badge sits at the card\'s top-right', m['card']['r'] - m['badge']['r'] < 24 and m['badge']['t'] - m['card']['t'] < 40, m)
            check(t + 'orders (phone): Confirm and Cancel share one row, View is full width underneath', abs(m['btns'][0]['t'] - m['btns'][1]['t']) < 2 and m['view']['w'] > m['btns'][0]['w'] * 1.6, m)
        else:
            check(t + 'orders (desktop): badge above the buttons', m['badge']['b'] <= m['btns'][0]['t'] + 1 and abs(m['btns'][0]['t'] - m['btns'][1]['t']) < 2, m)
        pg.screenshot(path=f'{OUT}/orders-{tag}.png', full_page=True)
        # chip filters through the real select + API
        pg.click('#orderStatusChips .dash-chip[data-status="pending"]'); time.sleep(.8)
        m = pg.evaluate("""()=>({rows:document.querySelectorAll('#ordersList tbody tr').length,sel:document.getElementById('orderStatusFilter').value,active:[...document.querySelectorAll('#orderStatusChips .dash-chip.is-active')].map(c=>c.textContent),pressed:document.querySelector('#orderStatusChips .dash-chip[data-status="pending"]').getAttribute('aria-pressed')})""")
        check(t + 'orders: Pending chip filters to the 2 pending orders and marks itself pressed', m['rows'] == 2 and m['sel'] == 'pending' and m['active'] == ['Pending'] and m['pressed'] == 'true', m)
        pg.click('#orderStatusChips .dash-chip[data-status=""]'); time.sleep(.8)
        n = pg.evaluate("document.querySelectorAll('#ordersList tbody tr').length")
        check(t + 'orders: All chip brings the full list back', n == 5, n)

        # ---------------- Settings ----------------
        pg.evaluate("dashboardManager.switchSection('settings')"); time.sleep(.8)
        m = pg.evaluate("""()=>{const items=[...document.querySelectorAll('#settingsSection .settings-nav-item')];const act=items.find(i=>i.classList.contains('active'));const cs=getComputedStyle(act);
          const sec=document.querySelector('#settingsSection .settings-form-section');const secCs=getComputedStyle(sec);
          const bar=document.querySelector('#settingsSection .settings-form-actions--sticky').getBoundingClientRect();const tb=document.getElementById('mobileTabbar');const tbr=tb&&getComputedStyle(tb).display!=='none'?tb.getBoundingClientRect():null;
          const jump=document.querySelector('.store-settings-jump a.active');
          return {tabs:items.length,tabH:act.getBoundingClientRect().height,tabBg:cs.backgroundColor,tabRadius:cs.borderTopLeftRadius,secRadius:secCs.borderTopLeftRadius,secBorder:secCs.borderTopWidth,
                  barBottom:bar.bottom,vh:innerHeight,tabbarTop:tbr?tbr.top:null,jumpBg:jump?getComputedStyle(jump).backgroundColor:null,doc:document.documentElement.scrollWidth,vw:innerWidth,
                  navDir:getComputedStyle(document.querySelector('#settingsSection .settings-nav')).flexDirection}}""")
        check(t + 'settings: 3 pill tabs in a row, 44px tall, active one filled dark', m['tabs'] == 3 and m['navDir'] == 'row' and m['tabH'] >= 43.5 and m['tabBg'] == 'rgb(11, 59, 43)' and float(m['tabRadius'].replace('px', '')) > 20, m)
        check(t + 'settings: field groups are bordered cards with an 18px radius', m['secRadius'] == '18px' and m['secBorder'] == '1px', m)
        check(t + 'settings: no sideways scroll', m['doc'] <= m['vw'] + 1, m)
        check(t + 'settings: save bar stays on screen' + (' and clears the tab bar' if w <= 768 else ''), m['barBottom'] <= (m['tabbarTop'] if m['tabbarTop'] else m['vh']) + 1.5, m)
        pg.click('.store-settings-jump a[data-jump="ss-location"]'); time.sleep(.9)
        jb = pg.evaluate("(()=>{const a=document.querySelector('.store-settings-jump a.active');return a?[a.textContent.trim(),getComputedStyle(a).backgroundColor]:null})()")
        check(t + 'settings: the jump link you tapped turns dark green', jb == ['Location', 'rgb(0, 133, 88)'], jb)
        pg.screenshot(path=f'{OUT}/settings-{tag}.png')
        pg.click('#settingsSection .settings-nav-item[data-settings-section="account"]'); time.sleep(.4)
        vis = pg.evaluate("[getComputedStyle(document.getElementById('settings-account')).display,getComputedStyle(document.getElementById('settings-store')).display]")
        check(t + 'settings: Account tab swaps the panel', vis == ['block', 'none'], vis)
        ctx.close()
    br.close()
check('no page errors', not errors, errors[:3])
print(f"\n{sum(res)}/{len(res)} checks passed")
srv.shutdown()
raise SystemExit(0 if all(res) else 1)
