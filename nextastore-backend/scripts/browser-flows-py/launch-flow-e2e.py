import json, re, sys
from playwright.sync_api import sync_playwright
BASE="http://localhost:8123"
state={"store":{"id":"s1","name":"Amina Crafts","slug":"amina-crafts","description":"Handmade baskets and beadwork from Kampala.","phoneNumber":"0772123456","phonePublic":True,"district":"kampala","isPublished":False,"bannerColor":"#00B074","publicUrl":"http://localhost:4000/s/amina-crafts","payments":{}},"products":[],"posts":[]}
USER={"id":"u1","name":"Amina Nakato","email":"amina@test.dev","role":"seller","accountStatus":"active"}
def api(route):
    req=route.request; path=req.url.split("/api",1)[1].split("?")[0]; m=req.method
    def ok(data=None,**kw): route.fulfill(status=200,headers={"access-control-allow-origin":"*"},json={"success":True,"data":data,**kw})
    if m=="OPTIONS": return route.fulfill(status=204,headers={"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"})
    state["posts"].append(f"{m} {path}")
    if path=="/auth/signup": 
        body=json.loads(req.post_data); u={**USER,"role":body["accountType"],"name":body["name"]}
        return route.fulfill(status=200,headers={"access-control-allow-origin":"*"},json={"success":True,"user":u,"token":"tok"})
    if path=="/store" and m=="GET": return ok({**state["store"]})
    if path=="/store" and m=="PUT":
        b=json.loads(req.post_data or "{}")
        if b.get("isPublished") is True and not state["store"]["isPublished"] and not state["products"]:
            return route.fulfill(status=400,headers={"access-control-allow-origin":"*"},json={"success":False,"error":"Add at least one product before you launch your store."})
        state["store"].update({k:v for k,v in b.items() if k not in("logo","banner")}); return ok({**state["store"]})
    if path=="/products" and m=="POST":
        state["products"].append(json.loads(req.post_data)); return ok({"id":"p1"})
    if path.startswith("/products"): return ok(state["products"],pagination={"total":len(state["products"])},total=len(state["products"]))
    if path=="/payments/methods": return ok([{"key":"mtn_momo","label":"MTN MoMo","enabled":True},{"key":"cash","label":"Cash on delivery","enabled":True}])
    if path=="/dashboard/stats": return ok({"totalProducts":len(state["products"]),"totalOrders":0,"totalRevenue":0,"pendingOrders":0})
    return ok([])
with sync_playwright() as p:
    b=p.chromium.launch(); res=[]
    def rec(n,ok,extra=""): res.append((n,ok,extra)); print(("PASS " if ok else "FAIL ")+n+(" — "+str(extra) if extra else ""))
    ctx=b.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True)
    ctx.route(lambda u:not u.startswith(BASE) and "localhost:4000" not in u, lambda r:r.abort())
    ctx.route("http://localhost:4000/api/**",api)
    pg=ctx.new_page(); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    # --- 1 index -> signup in seller mode
    pg.goto(BASE+"/index.html"); pg.wait_for_timeout(500)
    pg.locator("a:has-text('Get Started Free')").first.click(); pg.wait_for_url("**/signup.html*")
    rec("Get Started -> signup.html?type=seller", "type=seller" in pg.url, pg.url)
    rec("Seller card pre-selected", pg.is_checked("#accountTypeSeller"))
    rec("Heading follows seller mode", "selling" in pg.inner_text("#authSideHeading").lower() or "selling" in pg.inner_text("h1, h2").lower())
    # --- 2 terms cannot be bypassed
    pg.fill("#name","Amina Nakato"); pg.fill("#email","amina@test.dev"); pg.fill("#password","Strong#Pass1"); pg.fill("#confirmPassword","Strong#Pass1")
    state["posts"].clear(); pg.click("#signupSubmitBtn"); pg.wait_for_timeout(800)
    rec("Unticked terms: no signup request sent", not any("/auth/signup" in x for x in state["posts"]), state["posts"])
    rec("Unticked terms: stays on signup and shows 'You need to agree to continue'", "signup.html" in pg.url and pg.locator("text=You need to agree to continue").is_visible())
    pg.screenshot(path="e_signup_unticked.png")
    with pg.context.expect_page() as newp: pg.click("text=Terms of Service")
    tp=newp.value; tp.wait_for_load_state(); rec("Terms link opens terms.html in a new tab", tp.url.endswith("/terms.html") and "signup.html" in pg.url, tp.url); tp.close()
    pg.check("#agreeTerms"); state["posts"].clear(); pg.click("#signupSubmitBtn"); pg.wait_for_url("**/onboarding.html*",timeout=8000)
    rec("Ticked terms: signup sent as seller, lands on onboarding", any("/auth/signup" in x for x in state["posts"]) and "onboarding.html" in pg.url, pg.url)
    # --- 3 onboarding step 4 gate -> product form -> back -> launch
    pg.goto(BASE+"/onboarding.html?step=4"); pg.wait_for_timeout(1500)
    pg.screenshot(path="e_ob_gate.png")
    txt=pg.inner_text("body")
    rec("Step 4 honoured; 'Add your first product' shown when empty", "first product" in txt.lower(), pg.url)
    rec("Store link shown branded, never localhost", "nextastores.com/s/amina-crafts" in txt and "localhost:4000" not in txt)
    pg.locator("a:has-text('Add your first product'), button:has-text('Add your first product')").last.click()
    pg.wait_for_url("**/product-form.html*",timeout=8000); pg.wait_for_timeout(1200)
    rec("Gate button goes to product-form.html?from=onboarding", "from=onboarding" in pg.url, pg.url)
    body=pg.evaluate("document.body.textContent")
    rec("Product form relabelled for store setup (breadcrumb, back link, heading)", "Back to store setup" in body and "Store setup" in body and "Add your first product" in body)
    pg.screenshot(path="e_pf.png")
    pg.set_input_files("input[type=file]", "p.png"); pg.wait_for_timeout(1200)
    pg.click("button:has-text('Use this photo')"); pg.wait_for_timeout(900)
    pg.fill("#productName","Woven Raffia Basket"); pg.select_option("#productCategory", index=1); pg.fill("#productPrice","45000"); pg.fill("#productStock","5")
    pg.click("button:has-text('Save Product')"); 
    try:
        pg.wait_for_url("**/onboarding.html*",timeout=8000)
    except Exception as e:
        print("no redirect; url",pg.url, [x for x in state["posts"][-4:]]); pg.screenshot(path="e_pf_fail.png"); raise
    pg.wait_for_timeout(1500)
    rec("Saving the product sends POST /products and returns to onboarding (it strips ?step=4 from the URL itself)", "onboarding.html" in pg.url and any(x=="POST /products" for x in state["posts"]), pg.url)
    txt=pg.inner_text("body")
    rec("Gate flips: primary action is now Launch store", pg.locator("button:has-text('Launch store'), a:has-text('Launch store')").count()>0, [x.inner_text().strip() for x in pg.locator("button:visible").all()])
    pg.screenshot(path="e_ob_ready.png")
    pg.locator("button:has-text('Launch store')").last.click()
    pg.wait_for_url("**/dashboard.html*",timeout=10000); pg.wait_for_timeout(2000)
    rec("Launch: store published (PUT isPublished) and dashboard opens", state["store"]["isPublished"] is True, pg.url)
    vis=pg.locator("#storeLiveBanner").is_visible() if pg.locator("#storeLiveBanner").count() else False
    rec("Dashboard shows the 'you're live' banner", vis)
    if vis:
        t=pg.inner_text("#storeLiveBanner"); rec("Banner shows branded link, not localhost", "nextastores.com/s/amina-crafts" in t and "localhost" not in t, t.replace("\n"," | "))
    pg.screenshot(path="e_dash_live.png")
    pg.goto(BASE+"/dashboard.html#settings"); pg.wait_for_timeout(1500)
    pg.evaluate("document.querySelector('[data-section=settings]')?.click()"); pg.wait_for_timeout(800)
    pre=pg.evaluate("document.getElementById('storeUrlPrefix')?.textContent")
    rec("Settings store-link prefix is nextastores.com/s/, not localhost:4000", pre and "nextastores.com/s/" in pre and "localhost" not in pre, pre)
    rec("No uncaught page errors during the whole flow", not errs, errs)
    b.close()
