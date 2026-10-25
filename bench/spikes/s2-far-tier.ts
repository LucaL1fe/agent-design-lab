// Spike S2: how to draw 1000 far-away screens. (a) one DOM element per screen with a sprite background,
// (b) one canvas inside the world that covers the viewport and is redrawn when the view changes.
// Measures frame deltas (headless Chrome uses the real GPU at 60 Hz on macOS) during zoom sweeps and pans.
import { chromium } from 'playwright-core';

const N = Number(process.argv[2] ?? 1000);
const page = `<!doctype html><html><head><style>
html,body{margin:0;height:100%;overflow:hidden;background:#141413}
#vp{position:fixed;inset:0;overflow:hidden}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.s{position:absolute;width:390px;height:844px;background-repeat:no-repeat;border-radius:24px}
.sec{position:absolute;border:2px solid #333;border-radius:12px}
#cv{position:absolute;left:0;top:0;transform-origin:0 0}
</style></head><body><div id="vp"><div id="world"></div></div><script>
const N=${N};
const items=[];const cols=20;
for(let i=0;i<N;i++){const sec=Math.floor(i/17), si=i%17; const sx=(sec%6)*8000, sy=Math.floor(sec/6)*2400;
 items.push({x:sx+ (si%9)*440, y:sy+Math.floor(si/9)*1000, w:390, h:844, hue:(i*37)%360});}
// atlas: 64x138 sprites
const SW=64, SH=138, PER=32;
const sheets=[];
for(let s=0;s<Math.ceil(N/(PER*14));s++){const c=new OffscreenCanvas(PER*SW,14*SH);const g=c.getContext('2d');
 for(let k=0;k<PER*14;k++){const i=s*PER*14+k;if(i>=N)break;const it=items[i];const x=(k%PER)*SW,y=Math.floor(k/PER)*SH;
  g.fillStyle='hsl('+it.hue+' 40% 20%)';g.fillRect(x,y,SW,SH);g.fillStyle='hsl('+it.hue+' 70% 55%)';g.fillRect(x+6,y+10,SW-12,14);
  for(let r=0;r<5;r++){g.fillStyle='#2a2a2a';g.fillRect(x+6,y+34+r*16,SW-12,11);} g.fillStyle='#58CC02';g.fillRect(x+6,y+SH-22,SW-12,12);
  it.sheet=s; it.sx=x; it.sy=y;}
 sheets.push(c);}
window.urls=[];
window.setup=async(mode)=>{
 const world=document.getElementById('world'); world.innerHTML='';
 if(mode==='dom'){
  const blobs=await Promise.all(sheets.map(c=>c.convertToBlob()));const urls=blobs.map(b=>URL.createObjectURL(b));
  const scale=390/SW;
  const frag=document.createDocumentFragment();
  for(const it of items){const d=document.createElement('div');d.className='s';d.style.left=it.x+'px';d.style.top=it.y+'px';
   d.style.backgroundImage='url('+urls[it.sheet]+')';d.style.backgroundSize=(PER*SW*scale)+'px '+(14*SH*scale)+'px';
   d.style.backgroundPosition=(-it.sx*scale)+'px '+(-it.sy*scale)+'px';frag.appendChild(d);}
  world.appendChild(frag);
  await new Promise(r=>setTimeout(r,500));
 } else {
  const bitmaps=await Promise.all(sheets.map(c=>createImageBitmap(c)));
  const cv=document.createElement('canvas');cv.id='cv';world.appendChild(cv);const g=cv.getContext('2d');
  window.draw=(v)=>{const dpr=devicePixelRatio, W=innerWidth, H=innerHeight;
   if(cv.width!==W*dpr){cv.width=W*dpr;cv.height=H*dpr;}
   const wx=-v.x/v.k, wy=-v.y/v.k, ww=W/v.k, wh=H/v.k;
   cv.style.transform='translate('+wx+'px,'+wy+'px) scale('+(1/v.k)+')';cv.style.width=W+'px';cv.style.height=H+'px';
   g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);
   g.setTransform(dpr*v.k,0,0,dpr*v.k,dpr*v.x,dpr*v.y);
   for(const it of items){ if(it.x>wx+ww||it.y>wy+wh||it.x+it.w<wx||it.y+it.h<wy)continue;
    g.drawImage(bitmaps[it.sheet],it.sx,it.sy,SW,SH,it.x,it.y,it.w,it.h);} };
 }
 window.mode=mode;
};
window.run=async(kind,willChange)=>{
 const world=document.getElementById('world');world.style.willChange=willChange?'transform':'auto';
 const deltas=[];let last=performance.now();let longs=0;
 const po=new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.duration>=50)longs++;});
 try{po.observe({type:'long-animation-frame',buffered:false});}catch{}
 const t0=performance.now();const dur=3000;
 await new Promise(res=>{const f=(t)=>{const now=performance.now();deltas.push(now-last);last=now;const p=(now-t0)/dur;
   let v;if(kind==='zoom'){const k=0.03*Math.pow(10,Math.sin(p*Math.PI)*1.2);v={k,x:innerWidth/2-24000*k,y:innerHeight/2-10000*k};}
   else{const k=0.04;v={k,x:-p*30000*k+50,y:20};}
   world.style.transform='translate('+v.x+'px,'+v.y+'px) scale('+v.k+')';
   if(window.mode==='canvas')window.draw(v);
   if(p<1)requestAnimationFrame(f);else res();};requestAnimationFrame(f);});
 po.disconnect();deltas.shift();
 const s=[...deltas].sort((a,b)=>a-b);const dropped=deltas.reduce((n,d)=>n+Math.max(0,Math.round(d/16.67)-1),0);
 return {frames:deltas.length,dropped,droppedPct:+(100*dropped/(deltas.length+dropped)).toFixed(1),p50:+s[Math.floor(s.length*.5)].toFixed(1),p95:+s[Math.floor(s.length*.95)].toFixed(1),max:+s[s.length-1].toFixed(1),longs};
};
</script></body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.setContent(page);
for (const mode of ['dom', 'canvas']) {
  await p.evaluate((m) => (window as any).setup(m), mode);
  for (const kind of ['zoom', 'pan'])
    for (const wc of [false, true]) {
      const r = await p.evaluate(([k, w]) => (window as any).run(k, w), [kind, wc] as const);
      console.log(`${mode.padEnd(6)} ${kind.padEnd(4)} will-change=${String(wc).padEnd(5)}`, JSON.stringify(r));
    }
}
const mem = await p.evaluate(() => (performance as any).memory?.usedJSHeapSize / 1e6);
console.log('js heap MB', mem?.toFixed(1));
await browser.close();
