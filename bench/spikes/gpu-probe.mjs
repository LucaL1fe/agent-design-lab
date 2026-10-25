import { chromium } from 'playwright-core';

for (const args of [[], ['--enable-gpu', '--use-angle=metal']]) {
  const b = await chromium.launch({ channel: 'chrome', headless: true, args });
  const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas><div id=d style="width:100px;height:100px;background:red"></div>');
  const r = await p.evaluate(async () => {
    const gl = document.getElementById('c').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const ren = gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'none';
    let n = 0;
    const t0 = performance.now();
    const d = document.getElementById('d');
    await new Promise((res) => {
      const f = (_t) => {
        n++;
        d.style.transform = `translateX(${n % 100}px)`;
        if (performance.now() - t0 < 1000) requestAnimationFrame(f);
        else res();
      };
      requestAnimationFrame(f);
    });
    return { ren, fps: n };
  });
  console.log(JSON.stringify(args), r);
  await b.close();
}
