#!/usr/bin/env python3
"""Browser test for the Crew application page (crew-apply.html).
Serves the project root, mocks the API, and replaces the map libraries with stand-ins (the real Leaflet map is NOT exercised).
Run:  python3 nextastore-backend/scripts/crew-apply-browser-test.py      (needs: pip install playwright pillow; playwright install chromium)"""
import base64, http.server, io, json, os, random, socketserver, threading, sys
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def translate_path(self, path):   # the real server answers clean addresses (/crew-apply); do the same here
        p = super().translate_path(path)
        return p + '.html' if not os.path.exists(p) and os.path.exists(p + '.html') else p
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', 0), Quiet); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://localhost:{PORT}'

def jpeg(w, h, seed, noise=True):
    random.seed(seed); im = Image.new('RGB', (w, h)); px = im.load()
    for y in range(h):
        for x in range(w):
            v = 120 + (random.randint(-60, 60) if noise else 0) + int(40 * x / w)
            px[x, y] = (max(0, min(255, v)), max(0, min(255, v - 10)), max(0, min(255, v - 20)))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=85); return b.getvalue()
FILES = {k: jpeg(900, 1100, i) for i, k in enumerate(['front', 'back', 'face'])}
def tmp(name):
    p = f'/tmp/{name}.jpg'; open(p, 'wb').write(FILES[name]); return p

def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
TOKEN = f"{b64({'alg':'HS256'})}.{b64({'id':'u1','sub':'u1','exp':4102444800})}.sig"
RULES = {'programs': {'circle': {'name': 'NextaStore Circle', 'short': 'Circle', 'open': True}, 'crew': {'name': 'NextaStore Crew', 'short': 'Crew', 'open': True, 'maxTerritories': 3, 'ranks': [{'ratePercent': 20, 'firstMonth': 1}, {'ratePercent': 40, 'firstMonth': 1}], 'commitmentKicker': 1, 'stayBonus': 1, 'stockedBonus': 1, 'firstMonth': 1, 'commissionPercent': 20}}, 'applicationReviewWorkingDays': 2, 'hosts': {'mode': 'path'}, 'lead': {'lockDays': 14, 'extendDays': 7}, 'kickerMinMonths': 3, 'payouts': {'feeOnUs': True, 'payWithinWorkingDays': 2, 'minWithdrawal': 5000, 'firstWithdrawalNeedsStore': True, 'firstWithdrawalAfterDays': 7, 'clearanceDays': 7}, 'rankMinQuality': 1, 'trialDays': 30, 'payoutChangeLockHours': 24, 'lateClaimDays': 3}

results, posted = [], []
FAIL_APPLY = {'on': False}
def check(name, ok, extra=''):
    results.append(ok); print(('PASS  ' if ok else 'FAIL  ') + name + (f'   [{extra}]' if extra and not ok else ''))

def install(ctx, me_status=404, me_body=None, eligibility=None):
    def api(route):
        req = route.request; path = req.url.split('/api', 1)[1].split('?')[0]; cors = {'Access-Control-Allow-Origin': BASE, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        def ok(d, s=200): route.fulfill(status=s, headers=cors, content_type='application/json', body=json.dumps(d))
        if path == '/growth/rules': return ok({'data': RULES})
        if path == '/growth/me':
            return ok({'data': me_body}) if me_status == 200 else ok({'code': 'NOT_A_PARTNER', 'message': 'no'}, 404)
        if path == '/growth/eligibility': return ok({'data': eligibility or {'canJoin': True, 'blockers': [], 'checks': []}})
        if path in ('/growth/crew/apply', '/growth/crew/upgrade'):
            if FAIL_APPLY['on']: return ok({'message': 'Something went wrong.'}, 500)
            posted.append((path, json.loads(req.post_data))); return ok({'data': {'ok': True}})
        if path == '/user/me': return ok({'data': {'id': 'u1', 'name': 'Test', 'email': 't@x.com', 'role': 'buyer', 'emailVerified': True}})
        return ok({'data': []})
    ctx.route('http://localhost:4000/api/**', api)
    ctx.route('https://unpkg.com/**', lambda r: r.fulfill(status=200, content_type='text/css' if r.request.url.endswith('.css') else 'text/javascript', body='' if r.request.url.endswith('.css') else 'window.L={};'))
    ctx.route('https://cdnjs.cloudflare.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
    ctx.route('**/js/map-picker.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body="window.NextaStoreMapPicker={districtCoordinates:{kampala:[0.3476,32.5825]},open:function(o){window.__opens=(window.__opens||0)+1;window.__opts=o;}};"))
    ctx.route('**/js/map-preview.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body="window.NextaStoreMapPreview={render:function(el,o){el.innerHTML='<div id=\"standin\">map preview</div>';}};"))
    ctx.add_init_script(f"try{{localStorage.setItem('nextastore_token','{TOKEN}');localStorage.setItem('nextastore_user',JSON.stringify({{id:'u1',name:'Test',email:'t@x.com',role:'buyer'}}));}}catch(e){{}}")

def label(page): return page.inner_text('#caStepLabel')
def title(page): return page.inner_text('.ca-step:not([hidden]) .ca-title')

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width': 390, 'height': 844}); install(ctx)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(f'{BASE}/crew-apply.html'); page.wait_for_selector('#caForm')

    check('Page opens on step 1 of 6', label(page) == 'Step 1 of 6 · Your details', label(page))
    check('Six progress segments, first is current', page.locator('#caSegs li').count() == 6 and 'is-now' in page.get_attribute('#caSegs li:first-child', 'class'))
    page.click('#caNext')
    check('Empty name is flagged next to the field and focused', 'full name' in page.inner_text('#caNameErr').lower() and page.evaluate("document.activeElement.id") == 'caName')
    page.fill('#caName', 'Nakato Grace'); page.fill('#caPhone', '0772 123 456'); page.click('#caNext')

    check('Step 2 is the ID, titled "Your ID"', label(page).endswith('ID front and back') and title(page) == 'Your ID', label(page))
    check('Exactly two ID photo tiles: front and back (no selfie)', page.locator('.ca-up').count() == 2 and 'selfie' not in page.inner_text('#caForm').lower())
    page.fill('#caIdNo', 'cm12345678abcd'); check('ID number is upper-cased as typed', page.input_value('#caIdNo') == 'CM12345678ABCD')
    page.click('#caNext'); check('Missing ID photos are flagged', 'front' in page.inner_text('#caIdErr').lower())
    page.set_input_files('#caIdFront', tmp('front')); check('Front tile shows a preview', page.locator('#caIdFrontTile.is-set img').count() == 1)
    page.click('#caNext'); check('Missing back is flagged', 'back' in page.inner_text('#caIdErr').lower())
    page.set_input_files('#caIdBack', tmp('back')); page.click('#caNext')

    check('Step 3 is the passport photo', title(page) == 'Passport photo', title(page))
    page.click('#caNext'); check('Photo is required to continue', 'photo' in page.inner_text('#caPhotoStepErr').lower())
    page.set_input_files('#gpCardPhotoIn', tmp('face')); page.wait_for_selector('#gpPhotoRate .gp-photo-score', timeout=8000)
    page.click('#caNext')

    check('Step 4 heading is "Select working area"', title(page) == 'Select working area' and 'Select working area' in label(page), title(page))
    page.wait_for_function('window.__opens >= 1', timeout=5000); check('The map opens on its own on arrival', page.evaluate('window.__opens') == 1)
    page.click('#caNext'); check('Continuing with no area is refused', 'at least one' in page.inner_text('#caAreasErr').lower())
    check('The map picker is titled for working areas, not stores', page.evaluate('window.__opts.title') == 'Select your working area')
    page.evaluate("window.__opts.onSave({district:'kampala',placeName:'Owino Market',lat:0.3136,lng:32.5811})")
    check('Chosen area is listed by place name, district underneath', page.inner_text('.ca-arealist b') == 'Owino Market' and page.inner_text('.ca-arealist small') == 'Kampala')
    check('Counter reads 1 of 3', page.inner_text('#caCount') == '1 of 3')
    check('No km wording anywhere on the page', ' km' not in page.inner_text('body').lower() and 'how far' not in page.inner_text('body').lower())
    page.click('#caAdd'); page.wait_for_function('window.__opens >= 2'); check('"Add" reopens the map', True)

    page.go_back(); page.wait_for_timeout(200)
    check('Browser Back goes to the previous step, not off the page', title(page) == 'Passport photo' and 'crew-apply' in page.url, title(page))
    page.click('#caNext'); page.wait_for_timeout(200)
    page.click('#caNext'); check('Step 5 (about you) reached', title(page) == 'A little about you', title(page))
    page.fill('#caNote', 'I know the Owino traders.'); page.click('#caNext')

    check('Review lists the place name', 'Owino Market' in page.inner_text('#caSum') and 'Front and back added' in page.inner_text('#caSum'))
    page.click('#caNext'); check('Sending without accepting terms is refused', 'terms' in page.inner_text('#caTermsErr').lower())
    page.check('#caTerms'); FAIL_APPLY['on'] = True; page.click('#caNext'); page.wait_for_function("document.getElementById('caErr').textContent.length > 0", timeout=8000)
    check('A server failure explains itself and keeps the form', 'problem on our side' in page.inner_text('#caErr') and page.locator('#caForm').count() == 1 and not posted)
    FAIL_APPLY['on'] = False; page.click('#caNext'); page.wait_for_selector('.ca-done', timeout=8000)
    check('One application is sent to the Crew endpoint', len(posted) == 1 and posted[0][0] == '/growth/crew/apply')
    body = posted[0][1] if posted else {}
    check('Body carries card photo, ID sheet, area and no km', str(body.get('cardPhoto', '')).startswith('data:image/jpeg') and str(body.get('kycImage', '')).startswith('data:image/jpeg') and body.get('territories') == ['kampala'] and 'km' not in body.get('note', ''), json.dumps({k: (v[:30] if isinstance(v, str) else v) for k, v in body.items()}))
    check('Sent screen shows and links back to Crew', page.inner_text('#caDoneTitle') == 'Application sent' and page.get_attribute('#caHome', 'href') == '/crew')
    check('Draft is cleared after sending', page.evaluate("sessionStorage.getItem('nx_crew_apply_draft')") is None)

    # draft restore + persistence
    p2 = ctx.new_page(); p2.on('dialog', lambda d: d.accept()); p2.goto(f'{BASE}/crew-apply.html'); p2.wait_for_selector('#caForm'); p2.fill('#caName', 'Draft Person'); p2.fill('#caPhone', '0701234567')
    p2.reload(); p2.wait_for_selector('#caForm'); check('Typed details survive a reload', p2.input_value('#caName') == 'Draft Person' and p2.input_value('#caPhone') == '0701234567')
    p2.close()

    # a Circle member moving up uses the same page, posts to the upgrade endpoint
    c2 = br.new_context(viewport={'width': 390, 'height': 844}); install(c2, 200, {'partner': {'program': 'circle', 'status': 'active', 'code': 'ABC', 'displayName': 'C'}, 'upgrade': None})
    pg = c2.new_page(); posted.clear(); pg.goto(f'{BASE}/crew-apply.html'); pg.wait_for_selector('#caForm')
    check('Circle member sees the move-up form', 'Ask to join the Crew' in title(pg), title(pg))
    c2.close()
    # a person who already applied is sent to the Crew page
    c3 = br.new_context(viewport={'width': 390, 'height': 844}); install(c3, 200, {'partner': {'program': 'crew', 'status': 'pending', 'code': 'X'}})
    pg3 = c3.new_page(); pg3.goto(f'{BASE}/crew-apply.html'); pg3.wait_for_url('**/crew', timeout=6000); check('An existing applicant is sent to the Crew page', '/crew' in pg3.url)
    c3.close()
    # blocked (email not verified): checklist, no form
    c4 = br.new_context(viewport={'width': 390, 'height': 844}); install(c4, 404, None, {'canJoin': False, 'blockers': ['email'], 'checks': [{'ok': False, 'label': 'Verify your email', 'fix': 'Check your inbox.'}]})
    pg4 = c4.new_page(); pg4.goto(f'{BASE}/crew-apply.html'); pg4.wait_for_selector('#caVerify'); check('Unverified email shows the checklist instead of the form', pg4.locator('#caForm').count() == 0)
    c4.close()
    # the Crew page now only links to the application
    c5 = br.new_context(viewport={'width': 390, 'height': 844}); install(c5)
    pg5 = c5.new_page(); pg5.goto(f'{BASE}/crew.html'); pg5.wait_for_selector('#gpApply', timeout=8000)
    check('Crew page links to the new application page', pg5.get_attribute('#gpApply', 'href') == '/crew-apply' and pg5.locator('#gpJoin').count() == 0)
    c5.close()
    # desktop layout
    c6 = br.new_context(viewport={'width': 1280, 'height': 800}); install(c6); pg6 = c6.new_page(); pg6.goto(f'{BASE}/crew-apply.html'); pg6.wait_for_selector('#caForm')
    w = pg6.evaluate("document.getElementById('caMain').getBoundingClientRect().width"); check('Desktop keeps the form in a narrow card', 500 <= w <= 620, str(w))
    pg6.screenshot(path='/tmp/ca-desktop.png'); c6.close()
    page.screenshot(path='/tmp/ca-done.png')
    check('No uncaught page errors', not errors, '; '.join(errors)[:300])
    br.close()
print(f"\n{sum(results)}/{len(results)} browser checks passed."); srv.shutdown(); sys.exit(0 if all(results) else 1)
