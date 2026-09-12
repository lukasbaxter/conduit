// Cover colour the way Spotify picks it: not the average (a night-time photo
// averages to grey) but the most PROMINENT saturated colour. Pixels are
// binned coarsely, each bin scored by population x saturation, and mid-tones
// are favoured so the header stays readable under white text.
//
// The image is drawn on a canvas, so it needs to be CORS-readable: same-origin
// through the /jf proxy in the browser, `Access-Control-Allow-Origin: *` from
// Jellyfin for the desktop. If the canvas is tainted we fall back to null and
// the caller keeps the blurhash average.
const cache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export function vibrantColor(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 40;
        const c = document.createElement('canvas'); c.width = N; c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        const bins = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const [, s, l] = rgbToHsl(r, g, b);
          if (l < .08 || l > .92) continue;               // near-black / near-white: no
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, s: 0, l: 0 };
          e.n++; e.r += r; e.g += g; e.b += b; e.s += s; e.l += l;
          bins.set(key, e);
        }
        let best = null, bestScore = -1;
        for (const e of bins.values()) {
          const s = e.s / e.n, l = e.l / e.n;
          const mid = l > .2 && l < .75 ? 1 : .35;
          const score = e.n * (.15 + s) * mid;
          if (score > bestScore) { bestScore = score; best = e; }
        }
        resolve(best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null);
      } catch { resolve(null); } // tainted canvas
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  cache.set(url, p);
  return p;
}
