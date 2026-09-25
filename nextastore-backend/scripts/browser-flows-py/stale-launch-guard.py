import importlib.util,sys
src=open('e2e.py').read().split("with sync_playwright() as p:")[0]
exec(src)
from playwright.sync_api import sync_playwright
state["products"].append({"name":"x"})
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844})
    ctx.route(lambda u:not u.startswith(BASE) and "localhost:4000" not in u, lambda r:r.abort()); ctx.route("http://localhost:4000/api/**",api)
    ctx.add_init_script("sessionStorage.setItem('nextastore_user',JSON.stringify(%s));sessionStorage.setItem('nextastore_token','tok');"%json.dumps(USER))
    pg=ctx.new_page(); pg.goto(BASE+"/onboarding.html?step=4"); pg.wait_for_timeout(1500)
    print("launch button present:",pg.locator("button:has-text('Launch store')").count()>0)
    state["products"].clear()   # another tab deleted the product
    pg.locator("button:has-text('Launch store')").last.click(); pg.wait_for_timeout(1800)
    print("stayed on onboarding:","onboarding.html" in pg.url, "| published:",state["store"]["isPublished"])
    print("gate re-shown:",pg.locator("text=Add your first product").count()>0)
    b.close()
