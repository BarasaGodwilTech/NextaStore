// Layout-only Leaflet stand-in (real Leaflet can't be downloaded in this sandbox).
(function(){
  const C0=[0.3136,32.5811], SCALE=0.00005;
  function toLatLng(m,x,y){return {lat:m.center[0]-(y-m.h/2)*SCALE,lng:m.center[1]+(x-m.w/2)*SCALE};}
  window.L={
    divIcon:o=>o,
    map(id){
      const el=document.getElementById(id); el.classList.add('leaflet-container');
      const pane=document.createElement('div');pane.style.cssText='position:absolute;inset:0;overflow:hidden;z-index:400';el.appendChild(pane);
      const m={el,pane,center:C0,handlers:{},w:0,h:0,
        setView(c){this.center=c;this.invalidateSize();return this},
        invalidateSize(){const r=el.getBoundingClientRect();this.w=r.width;this.h=r.height;},
        on(t,f){(this.handlers[t]=this.handlers[t]||[]).push(f)},
        removeLayer(l){l.dom&&l.dom.remove()}, remove(){el.innerHTML=''},
        markers:[],
        panInside(ll,o){ // mimics Leaflet's: shift centre just enough to put the point inside the padded box
          const tl=o.paddingTopLeft||[0,0], br=o.paddingBottomRight||[0,0];
          let x=(ll.lng-this.center[1])/SCALE+this.w/2, y=-(ll.lat-this.center[0])/SCALE+this.h/2, dx=0, dy=0;
          if(y>this.h-br[1]) dy=y-(this.h-br[1]); else if(y<tl[1]) dy=y-tl[1];
          if(x>this.w-br[0]) dx=x-(this.w-br[0]); else if(x<tl[0]) dx=x-tl[0];
          this.center=[this.center[0]-dy*SCALE,this.center[1]+dx*SCALE];
          this.markers.forEach(k=>k.place());
        }
      };
      el.addEventListener('click',e=>{if(e.target.closest('.marker-host'))return;const r=el.getBoundingClientRect();
        (m.handlers.click||[]).forEach(f=>f({latlng:toLatLng(m,e.clientX-r.left,e.clientY-r.top)}))});
      return m;
    },
    tileLayer(){return{addTo(){return this}}},
    control:{zoom(){return{addTo(m){const z=document.createElement('div');z.className='leaflet-control-zoom';z.style.cssText='position:absolute;top:0;right:0;z-index:800;background:#fff;border:1px solid #ccc';z.innerHTML='<a style="display:block;width:30px;height:30px;text-align:center;line-height:30px">+</a><a style="display:block;width:30px;height:30px;text-align:center;line-height:30px">-</a>';m.el.appendChild(z);return this}}}},
    marker(ll,o){
      const mk={latlng:ll,handlers:{},
        place(){const m=this.map;const x=(this.latlng.lng-m.center[1])/SCALE+m.w/2, y=-(this.latlng.lat-m.center[0])/SCALE+m.h/2;this.dom.style.left=(x-22)+'px';this.dom.style.top=(y-22)+'px';},
        addTo(m){this.map=m;m.markers.push(this);const d=document.createElement('div');d.className='marker-host leaflet-marker-icon '+(o.icon.className||'');d.style.cssText='position:absolute;width:44px;height:44px';d.innerHTML=o.icon.html;
          const r=m.el.getBoundingClientRect();const x=(ll.lng-m.center[1])/SCALE+m.w/2, y=-(ll.lat-m.center[0])/SCALE+m.h/2;
          d.style.left=(x-22)+'px';d.style.top=(y-22)+'px';m.pane.appendChild(d);this.dom=d;this.x=x;this.y=y;return this},
        getLatLng(){return this.latlng}, bindPopup(){}, setPopupContent(){}, on(t,f){}
      };return mk;
    }
  };
})();
