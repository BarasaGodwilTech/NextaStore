import os
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CSS = (ROOT / 'css' / 'assistant.css').read_text(encoding='utf-8')
JS = (ROOT / 'js' / 'assistant.js').read_text(encoding='utf-8')

EN_GUEST = [
    'How do I start my first store?',
    'What should I sell as a beginner?',
    'Give me business ideas I can start with a small budget',
    'How do I price my products?',
    'How do I find a trustworthy seller?',
    'How can I buy safely on NextaStore?',
]
LG_GUEST = [
    'Nnyinza ntya okutandika edduuka lyange erisooka?',
    'Ntunde ki nga nkyatandika?',
    "Mpa ebirowoozo by'obusuubuzi bye nsobola okutandika n'ensimbi entono",
    "Nsalawo ntya ku bbeeyi y'ebintu byange?",
    'Nnyinza ntya okufuna omutunzi omwesigwa?',
    'Nnyinza ntya okugula mu ngeri etaliimu bulabe?',
]

en_js = json.dumps(EN_GUEST, ensure_ascii=False)
lg_js = json.dumps(LG_GUEST, ensure_ascii=False)

HTML = '''<!doctype html><html><head><meta charset="utf-8">
<meta name="nextastore-assistant-base" content="http://fake.test/api">
<style>''' + CSS + '''</style>
<style>body{margin:0;padding:30px;background:#eef3f0;font-family:system-ui,sans-serif}.marketplace-hero{max-width:760px;margin:auto}.hero-chat{max-width:580px!important}</style>
</head><body><section class="marketplace-hero"><div id="hero" class="hero-chat"></div></section>
<script>
(function(){
  const requests=[]; let pendingRelease=null;
  const en=''' + en_js + '''; const lg=''' + lg_js + ''';
  const payload=()=>({en:{guest:en,seller:en.slice(0,1)},lg:{guest:lg,seller:lg.slice(0,1)}});
  window.__requests=requests; window.__holdNext=false;
  window.__releaseNext=()=>{if(pendingRelease){pendingRelease();pendingRelease=null;}};
  const done=(flag)=>({type:'done',reply:'Here is a flagged reply.',bubbles:['Here is a flagged reply.'],source:'model',flag:flag||undefined});
  window.fetch=async function(url,opts){
    const u=String(url);
    if(u.endsWith('/starters')) return new Response(JSON.stringify(payload()),{status:200,headers:{'Content-Type':'application/json'}});
    if(u.endsWith('/chat/stream')){
      let body={}; try{body=JSON.parse((opts&&opts.body)||'{}')}catch(e){}
      requests.push(body);
      const hold=window.__holdNext; window.__holdNext=false;
      const flag=body.message==='Flag this reply' ? {type:'off_topic',conversation:false} : null;
      const enc=new TextEncoder();
      const stream=new ReadableStream({start(c){
        if(hold){pendingRelease=()=>{c.enqueue(enc.encode(JSON.stringify(done(flag))+'\\n'));c.close();};return;}
        c.enqueue(enc.encode(JSON.stringify(done(flag))+'\\n'));c.close();
      }});
      return new Response(stream,{status:200,headers:{'Content-Type':'application/x-ndjson'}});
    }
    return new Response('{}',{status:404});
  };
})();
</script>
<script>
window.__store={};
Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>window.__store[k]||null,setItem:(k,v)=>window.__store[k]=String(v),removeItem:k=>delete window.__store[k]},configurable:true});
Object.defineProperty(window,'localStorage',{value:{getItem:k=>null,setItem:()=>{},removeItem:()=>{}},configurable:true});
</script><script>''' + JS + '''</script>
<script>window.NexiAssistant.mountHero(document.getElementById('hero'));</script>
</body></html>'''


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def starters(page, root):
    return page.locator(root + ' .nexi-starters')


def run_viewport(page, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    page.set_content(HTML, wait_until='load')
    page.wait_for_timeout(100)
    if width in (1000, 390):
        page.screenshot(path=str(ROOT / 'ai-assistant' / ('starter-row-hero-desktop.png' if width == 1000 else 'starter-row-hero-phone.png')), full_page=True)
    page.evaluate('window.NexiAssistant.open()')
    page.wait_for_timeout(400)
    if width in (1000, 390):
        page.screenshot(path=str(ROOT / 'ai-assistant' / ('starter-row-panel-desktop.png' if width == 1000 else 'starter-row-panel-phone.png')), full_page=True)

    hero_box = starters(page, '#hero')
    panel_box = starters(page, '.nexi-panel')
    assert_true(hero_box.count() == 1 and panel_box.count() == 1, f'{width}x{height}: hero/panel starters missing')
    assert_true(page.locator('#hero .nexi-starters').evaluate("e => e.nextElementSibling && e.nextElementSibling.classList.contains('nexi-composer')"), 'hero starters not immediately before composer')
    assert_true(panel_box.evaluate("e => e.nextElementSibling && e.nextElementSibling.classList.contains('nexi-composer')"), 'panel starters not immediately before composer')

    for root in ['#hero', '.nexi-panel']:
        chips = page.locator(root + ' .nexi-starters .nexi-chip')
        tops = chips.evaluate_all('(els) => els.map(e => e.getBoundingClientRect().top)')
        heights = chips.evaluate_all('(els) => els.map(e => e.getBoundingClientRect().height)')
        assert_true(max(tops) - min(tops) <= 2, f'{width}x{height}: chips are not one row: {tops}')
        assert_true(max(heights) - min(heights) <= 2, f'{width}x{height}: chip heights differ: {heights}')

    overflow = page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert_true(overflow, f'{width}x{height}: page has horizontal overflow')

    page.evaluate('window.NexiAssistant.close()')
    row = page.locator('#hero .nexi-starters-row')
    prev = page.locator('#hero .nexi-starters-arrow--prev')
    nxt = page.locator('#hero .nexi-starters-arrow--next')
    row_overflow = row.evaluate('e => e.scrollWidth > e.clientWidth')
    if width == 390:
        assert_true(row_overflow, 'phone hero row does not overflow')
        second_left = page.locator('#hero .nexi-starters .nexi-chip').nth(1).evaluate('e => e.getBoundingClientRect().left')
        viewport_right = row.evaluate('e => e.getBoundingClientRect().right')
        assert_true(second_left < viewport_right, 'phone next card does not peek into the row')
    assert_true(prev.get_attribute('aria-label') == 'Previous questions' and nxt.get_attribute('aria-label') == 'More questions', 'arrow aria-labels wrong')
    assert_true(prev.is_hidden(), f'{width}x{height}: previous arrow should be hidden at start')
    if row_overflow:
        before = row.evaluate('e => e.scrollLeft')
        nxt.click(); page.wait_for_timeout(120)
        after = row.evaluate('e => e.scrollLeft')
        assert_true(after > before, f'{width}x{height}: next arrow did not advance scrollLeft')
    # Check the panel arrow path too, then the non-overflow state.
    page.evaluate('window.NexiAssistant.open()'); page.wait_for_timeout(50)
    prow = page.locator('.nexi-panel .nexi-starters-row')
    pprev = page.locator('.nexi-panel .nexi-starters-arrow--prev')
    pnxt = page.locator('.nexi-panel .nexi-starters-arrow--next')
    p_overflow = prow.evaluate('e => e.scrollWidth > e.clientWidth')
    assert_true(pprev.is_hidden(), f'{width}x{height}: panel previous arrow should be hidden at start')
    if p_overflow:
        before = prow.evaluate('e => e.scrollLeft')
        pnxt.click(); page.wait_for_timeout(120)
        after = prow.evaluate('e => e.scrollLeft')
        assert_true(after > before, f'{width}x{height}: panel next arrow did not advance scrollLeft')
    # Explicit no-overflow guard: remove all but one chip and force the scroll-state update.
    page.locator('#hero .nexi-starters .nexi-chip').evaluate_all('(els) => els.slice(1).forEach(e => e.remove())')
    page.locator('.nexi-panel .nexi-starters .nexi-chip').evaluate_all('(els) => els.slice(1).forEach(e => e.remove())')
    page.evaluate("window.dispatchEvent(new Event('resize'))")
    assert_true(prev.is_hidden() and nxt.is_hidden() and pprev.is_hidden() and pnxt.is_hidden(), f'{width}x{height}: arrows not hidden for a non-overflowing row')


def main():
    with sync_playwright() as p:
        candidates = [
            os.environ.get('CHROMIUM_PATH', ''),
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
        ]
        exe = next((x for x in candidates if x and os.path.exists(x)), None)
        if not exe:
            raise SystemExit('starter row test: Chromium executable not found')
        browser = p.chromium.launch(headless=True, executable_path=exe, args=['--no-sandbox'])
        for width, height in [(1000, 760), (390, 800), (700, 480)]:
            page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            run_viewport(page, width, height)
            page.close()

        # Behaviour, language, pending state, New chat, and flagged-reply isolation.
        page = browser.new_page(viewport={'width': 390, 'height': 800}, device_scale_factor=1)
        page.set_content(HTML, wait_until='load'); page.wait_for_timeout(100)
        hero_box = starters(page, '#hero')
        chip = page.locator('#hero .nexi-starters .nexi-chip').first
        first_text = chip.inner_text()
        chip.click(); page.wait_for_timeout(80)
        req = page.evaluate('window.__requests[0]')
        assert_true(req['message'] == first_text and 'lang' not in req, 'English starter payload mismatch')
        assert_true(hero_box.is_hidden(), 'starters did not hide after a message')
        page.get_by_role('button', name='Start a new chat').click(); page.wait_for_timeout(50)
        assert_true(not hero_box.is_hidden(), 'starters did not return after New chat')

        # Luganda repaint resets the row and sends lang: lg.
        row = page.locator('#hero .nexi-starters-row')
        row.evaluate('e => e.scrollLeft = e.scrollWidth')
        page.get_by_role('button', name='Luganda').click(); page.wait_for_timeout(50)
        assert_true(row.evaluate('e => e.scrollLeft') == 0, 'Luganda repaint did not reset scrollLeft')
        lg_chip = page.locator('#hero .nexi-starters .nexi-chip').first
        assert_true(lg_chip.inner_text() == LG_GUEST[0], 'Luganda starters did not repaint')
        lg_text = lg_chip.inner_text(); lg_chip.click(); page.wait_for_timeout(80)
        lg_req = page.evaluate('window.__requests[1]')
        assert_true(lg_req['message'] == lg_text and lg_req['lang'] == 'lg', 'Luganda starter payload mismatch')
        page.get_by_role('button', name='Start a new chat').click(); page.wait_for_timeout(50)

        # Chips disabled while pending.
        page.evaluate('window.__holdNext=true')
        pending_chip = page.locator('#hero .nexi-starters .nexi-chip').first
        pending_chip.click(); page.wait_for_timeout(50)
        assert_true(page.locator('#hero .nexi-starters .nexi-chip').first.is_disabled(), 'starter chips were not disabled while pending')
        page.evaluate('window.__releaseNext()'); page.wait_for_timeout(80)
        assert_true(not page.locator('#hero .nexi-starters .nexi-chip').first.is_disabled(), 'starter chips did not re-enable after pending')
        page.get_by_role('button', name='Start a new chat').click(); page.wait_for_timeout(50)

        # Flagged reply suggestions remain normal .nexi-suggest chips and are not starter chips.
        page.locator('#hero textarea').fill('Flag this reply')
        page.locator('#hero form').evaluate("form => form.dispatchEvent(new Event('submit', {cancelable:true,bubbles:true}))")
        page.wait_for_timeout(100)
        assert_true(page.locator('#hero .nexi-suggest .nexi-chip').count() == 3, 'flagged reply suggestions did not render')
        assert_true(page.locator('#hero .nexi-suggest .nexi-chip').evaluate_all('(els)=>els.some(e=>e.closest(\'.nexi-starters\'))') is False, 'flagged suggestions are inside starters')

        page.close()

        page = browser.new_page(viewport={'width': 1000, 'height': 760}, device_scale_factor=1)
        page.set_content(HTML, wait_until='load'); page.wait_for_timeout(100); page.evaluate('window.NexiAssistant.open()'); page.wait_for_timeout(100)
        page.close()
        browser.close()

    print('starter row test: layout, scrolling, language, pending state, New chat, and flagged-suggestion isolation passed')


if __name__ == '__main__':
    main()
