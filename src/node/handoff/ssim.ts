// Structural similarity (SSIM) between two RGBA images of the same size, on luminance with 8×8 windows. 1 = the
// same picture. It tolerates tiny anti-aliasing and font-rendering differences that a pixel diff counts as wrong.

export interface Img {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

function luma(img: Img): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = d[p + 3]! / 255;
    // composite on white, so transparent areas compare as the page background
    out[i] = (0.299 * d[p]! + 0.587 * d[p + 1]! + 0.114 * d[p + 2]!) * a + 255 * (1 - a);
  }
  return out;
}

export function ssim(a: Img, b: Img, win = 8): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('ssim: sizes differ');
  const x = luma(a);
  const y = luma(b);
  const W = a.width;
  const H = a.height;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let n = 0;
  for (let by = 0; by + win <= H; by += win) {
    for (let bx = 0; bx + win <= W; bx += win) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let j = 0; j < win; j++) {
        const row = (by + j) * W + bx;
        for (let i = 0; i < win; i++) {
          const p = x[row + i]!;
          const q = y[row + i]!;
          sx += p;
          sy += q;
          sxx += p * p;
          syy += q * q;
          sxy += p * q;
        }
      }
      const N = win * win;
      const mx = sx / N;
      const my = sy / N;
      const vx = sxx / N - mx * mx;
      const vy = syy / N - my * my;
      const cxy = sxy / N - mx * my;
      total += ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      n++;
    }
  }
  return n ? total / n : 1;
}
