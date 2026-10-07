import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CSS = (ROOT / 'css' / 'assistant.css').read_text(encoding='utf-8')
JS = (ROOT / 'js' / 'assistant.js').read_text(encoding='utf-8')

html = '''<!doctype html><html><head><meta charset="utf-8">
<meta name="nextastore-assistant-base" content="http://fake.test/api">
<style>''' + CSS + '''</style>
<style>body{margin:0;padding:30px;background:#eef3f0;font-family:system-ui,sans-serif}.marketplace-hero{max-width:760px;margin:auto}.hero-chat{max-width:580px!important}</style>
</head><body><section class="marketplace-hero"><div id="hero" class="hero-chat"></div></section>
<script>
(function(){
  const enc=new TextEncoder();
  window.fetch=async function(url){
    if(String(url).endsWith('/starters')) return new Response('{}',{status:404});
    const events=[
      {type:'meta',language:{code:'en'},source:'model'},
      {type:'token',text:'Here is the first bubble. '},
      {type:'token',text:'It stays in place while text grows.'},
      {type:'break'},
      {type:'token',text:'- First complete point'},
      {type:'token',text:'\\n- Second complete point'},
      {type:'done',reply:'Here is the first bubble. It stays in place while text grows.\\n\\n- First complete point\\n- Second complete point',bubbles:['Here is the first bubble. It stays in place while text grows.','- First complete point\\n- Second complete point'],source:'model'}
    ];
    const stream=new ReadableStream({async start(c){for(const ev of events){c.enqueue(enc.encode(JSON.stringify(ev)+'\\n'));await new Promise(r=>setTimeout(r,60));}c.close();}});
    return new Response(stream,{status:200,headers:{'Content-Type':'application/x-ndjson'}});
  };
})();
</script><script>window.__store={};Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>window.__store[k]||null,setItem:(k,v)=>window.__store[k]=String(v),removeItem:k=>delete window.__store[k]},configurable:true});Object.defineProperty(window,'localStorage',{value:{getItem:k=>null,setItem:()=>{},removeItem:()=>{}},configurable:true});</script><script>''' + JS + '''</script>
<script>window.NexiAssistant.mountHero(document.getElementById('hero'));
window.__removed=0;
new MutationObserver(records=>records.forEach(r=>r.removedNodes.forEach(n=>{if(n.nodeType===1&&n.classList.contains('nexi-bubble'))window.__removed++;}))).observe(document.getElementById('hero'),{subtree:true,childList:true});</script>
</body></html>'''

with sync_playwright() as p:
    candidates = [
        os.environ.get('CHROMIUM_PATH',''),
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ]
    exe = next((x for x in candidates if x and os.path.exists(x)), None)
    if not exe:
        raise SystemExit('widget test: Chromium executable not found')
    browser = p.chromium.launch(headless=True, executable_path=exe, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1000,'height':760}, device_scale_factor=1)
    page.set_content(html, wait_until='load')
    page.locator('#hero textarea').fill('Test multi bubble')
    page.locator('#hero form').evaluate("form => form.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}))")
    page.wait_for_timeout(900)
    result = page.evaluate("""() => ({
      bots:[...document.querySelectorAll('#hero .nexi-msg.is-bot')].map(m=>({stack:m.classList.contains('is-stack'),bubbles:[...m.querySelectorAll('.nexi-bubble')].map(b=>b.innerText)})),
      removed:window.__removed,
      persisted: (() => { try { return JSON.parse(sessionStorage.getItem('nx.nexi.v1')).messages.some(m => Array.isArray(m.parts)); } catch(e) { return false; } })()
    })""")
    page.screenshot(path=str(ROOT / 'nexi-widget-test.png'), full_page=True)
    browser.close()

bots = result['bots']
assert len(bots) == 1 and bots[0]['stack'] and len(bots[0]['bubbles']) == 2, result
assert result['removed'] == 0, result
assert result['persisted'], result
print('widget test: browser multi-bubble render, in-place updates and parts persistence passed')
print(result)
