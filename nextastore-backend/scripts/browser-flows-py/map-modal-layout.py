import json, sys
from playwright.sync_api import sync_playwright
VPS=[("320x568",320,568),("360x640",360,640),("375x667",375,667),("390x844",390,844),("412x915",412,915),("640x360-land",640,360),("768x1024",768,1024),("1440x900",1440,900)]
out=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,w,h in VPS:
        ctx=b.new_context(viewport={"width":w,"height":h},device_scale_factor=2,has_touch=w<700,is_mobile=w<700)
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("**/nominatim.openstreetmap.org/**",lambda r:r.fulfill(json={"display_name":"Plot 14, Kampala Road, Nakasero, Kampala, Central Region, Uganda","address":{"road":"Kampala Road","suburb":"Nakasero","city":"Kampala"}}))
        pg.goto("http://localhost:8123/harness.html"); pg.click("#go"); pg.wait_for_timeout(400)
        def box(sel):
            e=pg.query_selector(sel); return e.bounding_box() if e and e.is_visible() else None
        r={"vp":name,"errs":errs}
        r["modal"]=box(".map-modal-content"); r["filters"]=box(".map-modal-filters"); r["map"]=box("#mpMapContainer")
        r["guid"]=box("#mpGuidance"); r["actions"]=box(".map-action-bar")
        r["sel_h"]=box("#mpRegionSelect")["height"]
        r["btns"]=[box("#mpCancelBtn"),box("#mpSaveBtn")]
        r["hscroll"]=pg.evaluate("document.documentElement.scrollWidth>innerWidth")
        pg.screenshot(path=f"s_{name}_1.png")
        # tap the bottom part of map (worst case for the floating card) and the middle
        m=r["map"]
        pg.mouse.click(m["x"]+m["width"]/2, m["y"]+m["height"]-25); pg.wait_for_timeout(500)
        r["card"]=box("#mpLocationCard"); r["pin"]=box(".marker-crosshair-ring"); r["guid_after"]=box("#mpGuidance")
        pin=r["pin"]; card=r["card"]
        if pin and card:
            r["pin_hidden_by_card"]= not (pin["y"]+pin["height"]<=card["y"] or pin["y"]>=card["y"]+card["height"] or pin["x"]+pin["width"]<=card["x"] or pin["x"]>=card["x"]+card["width"])
        pg.screenshot(path=f"s_{name}_2.png")
        out.append(r); ctx.close()
    b.close()
for r in out:
    m=r["map"]; mo=r["modal"]
    print(r["vp"], "modal",round(mo["width"]),"x",round(mo["height"]),"| map h",round(m["height"]), f'({round(100*m["height"]/mo["height"])}% of modal)',"| select h",round(r["sel_h"]),
          "| btn h",[round(x["height"]) for x in r["btns"]],"| actions bottom",round(r["actions"]["y"]+r["actions"]["height"]),"vs vh",mo["y"]+mo["height"],
          "| hscroll",r["hscroll"],"| pin hidden by card:",r.get("pin_hidden_by_card"),"| errs",r["errs"])
