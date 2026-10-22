/* =============================================================================
 * LanaiMaterialsExt: exterior material pass for the lanai diorama (three.js r128)
 *   window.LanaiMaterialsExt.apply(CTX), called once after the scene is built.
 *   Touches only exterior surfaces: stucco + trim, fascia/gutters/soffits,
 *   steel window frames + glass, white French doors, roof shingles + ridges,
 *   pavers, pool mosaic + water tint, travertine coping, navy herringbone,
 *   lawn and shrubs. No lights, no post, no geometry changes.
 *   All textures are procedural and deterministic (seeded RNG).
 * ===========================================================================*/
(function (root) {
'use strict';

/* ------------------------------------------------------------ utilities */
function mkRng(seed) {
  let s = seed | 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapI = (v, n) => ((v % n) + n) % n;
function ss(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/* periodic value noise (quintic fade), px/py lattice cells across the canvas; adds amp*[-1,1] into out */
function addNoise(out, w, h, px, py, amp, rnd) {
  px = Math.max(1, px | 0); py = Math.max(1, py | 0);
  const L = new Float32Array(px * py);
  for (let i = 0; i < L.length; i++) L[i] = rnd() * 2 - 1;
  const x0 = new Int32Array(w), x1 = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const f = x * px / w, i = Math.floor(f), t = f - i;
    x0[x] = i % px; x1[x] = (i + 1) % px; xt[x] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  for (let y = 0; y < h; y++) {
    const f = y * py / h, j = Math.floor(f), t = f - j, ty = t * t * t * (t * (t * 6 - 15) + 10);
    const r0 = (j % py) * px, r1 = ((j + 1) % py) * px;
    let o = y * w;
    for (let x = 0; x < w; x++, o++) {
      const a = x0[x], b = x1[x], tx = xt[x];
      const la = L[r0 + a], top = la + (L[r0 + b] - la) * tx;
      const lc = L[r1 + a], bot = lc + (L[r1 + b] - lc) * tx;
      out[o] += amp * (top + (bot - top) * ty);
    }
  }
}
function fbmDirect(w, h, px, py, oct, rnd, gain) {
  const out = new Float32Array(w * h);
  let amp = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    if (px > w || py > h) break;
    addNoise(out, w, h, px, py, amp, rnd);
    n += amp; amp *= gain; px *= 2; py *= 2;
  }
  const k = n ? 1 / n : 1;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}
/* fractal value noise; smooth fields are evaluated at reduced resolution (>= 8 px per finest cell) and upsampled with wrap */
function fbm(w, h, px, py, oct, rnd, gain) {
  gain = gain || 0.5;
  const fx = px * Math.pow(2, oct - 1), fy = py * Math.pow(2, oct - 1);
  let sw = w, sh = h;
  while (sw % 2 === 0 && sw / 2 >= fx * 8) sw /= 2;
  while (sh % 2 === 0 && sh / 2 >= fy * 8) sh /= 2;
  if (sw === w && sh === h) return fbmDirect(w, h, px, py, oct, rnd, gain);
  const lo = fbmDirect(sw, sh, px, py, oct, rnd, gain), out = new Float32Array(w * h), kx = sw / w, ky = sh / h;
  const xa = new Int32Array(w), xb = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) { const f = (x + 0.5) * kx - 0.5, i = Math.floor(f); xa[x] = wrapI(i, sw); xb[x] = wrapI(i + 1, sw); xt[x] = f - i; }
  for (let y = 0; y < h; y++) {
    const f = (y + 0.5) * ky - 0.5, j = Math.floor(f), ty = f - j, r0 = wrapI(j, sh) * sw, r1 = wrapI(j + 1, sh) * sw;
    let o = y * w;
    for (let x = 0; x < w; x++, o++) {
      const a = xa[x], b = xb[x], t = xt[x];
      const top = lo[r0 + a] + (lo[r0 + b] - lo[r0 + a]) * t, bot = lo[r1 + a] + (lo[r1 + b] - lo[r1 + a]) * t;
      out[o] = top + (bot - top) * ty;
    }
  }
  return out;
}
function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let k = -r; k <= r; k++) s += src[o + wrapI(k, w)];
    for (let x = 0; x < w; x++) { tmp[o + x] = s * inv; s += src[o + wrapI(x + r + 1, w)] - src[o + wrapI(x - r, w)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[wrapI(k, h) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s * inv; s += tmp[wrapI(y + r + 1, h) * w + x] - tmp[wrapI(y - r, h) * w + x]; }
  }
  return out;
}
/* tangent-space normal map (OpenGL convention, +Y = +v with flipY textures) from a height field in pixel units (Sobel) */
function normalData(H, w, h, depth) {
  const d = new Uint8ClampedArray(w * h * 4), s = depth / 8;
  for (let y = 0; y < h; y++) {
    const r0 = wrapI(y - 1, h) * w, r1 = y * w, r2 = wrapI(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const a = x > 0 ? x - 1 : w - 1, c = x < w - 1 ? x + 1 : 0;
      const tl = H[r0 + a], t = H[r0 + x], tr = H[r0 + c], l = H[r1 + a], r = H[r1 + c], bl = H[r2 + a], b = H[r2 + x], br = H[r2 + c];
      const nx = -((tr + 2 * r + br) - (tl + 2 * l + bl)) * s;
      const ny = ((bl + 2 * b + br) - (tl + 2 * t + tr)) * s;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), j = (r1 + x) << 2;
      d[j] = (nx * inv * 0.5 + 0.5) * 255; d[j + 1] = (ny * inv * 0.5 + 0.5) * 255; d[j + 2] = (inv * 0.5 + 0.5) * 255; d[j + 3] = 255;
    }
  }
  return d;
}
function grayData(F, w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < F.length; i++, j += 4) { const v = clamp(F[i], 0, 1) * 255; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
  return d;
}
function canvasFrom(w, h, data) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h); img.data.set(data); g.putImageData(img, 0, 0); return c;
}
function forDisc(w, h, cx, cy, r, fn) {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) { const yy = wrapI(y, h), dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) fn(yy * w + wrapI(x, w), x + 0.5 - cx, dy); }
}
function cyclicWidths(total, wmin, wmax, rnd) {
  const ws = []; let sum = 0;
  while (sum < total) { const v = Math.round(wmin + rnd() * (wmax - wmin)); ws.push(v); sum += v; }
  ws[ws.length - 1] -= sum - total;
  if (ws.length > 1 && ws[ws.length - 1] < wmin * 0.8) { const l = ws.pop(); ws[ws.length - 1] += l; }
  return ws;
}
/* pack color (Uint8ClampedArray rgba), height (Float32, px units), roughness (Float32 0..1) */
function pack(w, h, col, H, depth, Rg) {
  return { w, h, color: canvasFrom(w, h, col), normal: H ? canvasFrom(w, h, normalData(H, w, h, depth || 1)) : null, rough: Rg ? canvasFrom(w, h, grayData(Rg, w, h)) : null };
}

/* ------------------------------------------------------------ STUCCO: smooth hand-troweled, subtle (canvas = 2 m) */
function genStucco(S, rnd) {
  const w = S, h = S, N = w * h, k = S / 1024;
  const base = hex('#ebdcbd');
  const low = fbm(w, h, 3, 3, 3, rnd, 0.5), mid = fbm(w, h, 9, 9, 3, rnd, 0.5), tro = fbm(w, h, 14, 14, 3, rnd, 0.45);
  const fine = fbm(w, h, 128, 128, 2, rnd, 0.5), tint = fbm(w, h, 4, 4, 2, rnd, 0.5);
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const g = rnd() - 0.5;
    /* trowel edges: thin, soft ridges where passes overlap, only in half the area */
    const rid = (1 - ss(0, 0.13, Math.abs(tro[i]))) * ss(0, 0.35, mid[i]);
    const flat = ss(-0.2, 0.3, low[i]);                      // burnished plateaus
    H[i] = (2.6 * low[i] + 0.9 * mid[i] + 0.3 * rid + 0.22 * fine[i] * (1 - 0.6 * flat) + 0.12 * g) * k;
    const f = 1 + 0.018 * low[i] + 0.008 * mid[i] + 0.012 * rid + 0.006 * fine[i] + g * 0.012;
    const wt = tint[i] * 0.012;
    col[j] = base[0] * f * (1 + wt); col[j + 1] = base[1] * f; col[j + 2] = base[2] * f * (1 - wt * 1.6); col[j + 3] = 255;
    Rg[i] = 0.9 + 0.03 * mid[i] - 0.1 * rid - 0.05 * flat + 0.02 * g;
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ SHINGLES: dark laminated architectural (canvas = 2.2 m, 16 courses)
   Each course = a full-width top layer (1 m strips) + random-width laminated pads on its lower part;
   the gaps between pads show the recessed top layer, and every butt edge throws a shadow line. */
function genShingle(S, rnd) {
  const w = S, h = S, N = w * h, nr = 16, rh = h / nr, pxm = S / 2.2, k = S / 1024;
  const padOf = new Int32Array(nr * w), pads = [], stripOf = new Int32Array(nr * w), strips = [];
  for (let r = 0; r < nr; r++) {
    let x0 = Math.floor(rnd() * w);
    for (const sw of cyclicWidths(w, Math.round(0.86 * pxm), Math.round(1.0 * pxm), rnd)) {
      strips.push({ v: 74 + rnd() * 10, warm: (rnd() - 0.5) * 3 });
      for (let x = x0; x < x0 + sw; x++) stripOf[r * w + wrapI(x, w)] = strips.length - 1;
      x0 += sw;
    }
    x0 = Math.floor(rnd() * w);
    for (const tw of cyclicWidths(w, Math.round(0.09 * pxm), Math.round(0.3 * pxm), rnd)) {
      const u = rnd();
      pads.push({ x0, w: tw, v: u < 0.12 ? 68 + rnd() * 6 : u > 0.94 ? 90 + rnd() * 8 : 77 + rnd() * 11, warm: (rnd() - 0.5) * 5,
        gap: rnd() < 0.7 ? Math.round((0.015 + rnd() * 0.045) * pxm) : 0, top: 0.36 + rnd() * 0.24, tilt: rnd() - 0.5 });
      for (let x = x0; x < x0 + tw; x++) padOf[r * w + wrapI(x, w)] = pads.length - 1;
      x0 += tw;
    }
  }
  const streak = fbm(w, h, 5, 3, 3, rnd, 0.5), mot = fbm(w, h, 32, 32, 2, rnd, 0.5);
  const bw = w >> 1, blk = new Float32Array(bw * (h >> 1)); for (let i = 0; i < blk.length; i++) blk[i] = rnd() - 0.5;
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const r = Math.min(nr - 1, Math.floor(y / rh)), ly = (y + 0.5 - r * rh) / rh;   // 0 = up-slope edge, 1 = butt
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, t = pads[padOf[r * w + x]], st = strips[stripOf[r * w + x]];
      let lx = x - t.x0; if (lx < 0) lx += w;
      const inPadZone = ly > t.top, inGap = lx < t.gap, onPad = inPadZone && !inGap;
      let v, wr;
      if (onPad) {
        const ed = Math.min(lx - t.gap, t.w - lx) / (2.5 * k);                 // soft dark edge around each pad
        v = t.v * (0.86 + 0.14 * ss(0, 1, ed)) * (0.9 + 0.1 * ss(0, 0.06, ly - t.top)); wr = t.warm;
      } else { v = st.v * (inPadZone ? 0.82 : 1); wr = st.warm; }
      v *= (0.96 + 0.08 * mot[i]) * (0.45 + 0.55 * ss(0, 0.13, ly));          // butt-edge shadow from the course above
      const bk = blk[(y >> 1) * bw + (x >> 1)], wn = rnd() - 0.5, s = rnd();
      const gr = bk * 12 + wn * 11 + (s < 0.02 ? -20 : s > 0.975 ? 38 : 0);
      const f = 1 + 0.05 * streak[i];
      col[j] = v * f + gr + wr; col[j + 1] = v * f + gr + 0.5; col[j + 2] = v * f + gr + 1.5 - wr; col[j + 3] = 255;
      H[i] = (1.5 * ly + (onPad ? 1.3 + t.tilt * 0.4 : 0) + bk * 0.45 + wn * 0.22) * k * 1.3;
      Rg[i] = (s > 0.975 ? 0.5 : 0.8) + wn * 0.08;
    }
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ PAVERS: tumbled concrete, same running pattern + palette (canvas = 2.4 m, 16 rows) */
function genPaver(S, rnd) {
  const w = S, h = S, N = w * h, k = S / 1024, rows = 16, rh = S / rows, jt = 2.4 * k, rc = 7 * k, bev = 10 * k;
  const pal = ['#c9cbcd', '#dccdb0', '#e8dfcd', '#b4b9bf', '#d2c2a4', '#bfc3c8', '#e3d6bd'].map(c => hex(c).map(v => v * 0.88)), joint = hex('#7f796f');
  const segOf = new Int32Array(rows * w), pav = [];
  for (let r = 0; r < rows; r++) {
    const ws = cyclicWidths(w, 60 * k, 128 * k, rnd); let x0 = Math.floor(rnd() * w);
    for (const pw of ws) {
      pav.push({ x0, w: pw, c: Math.floor(rnd() * pal.length), alt: Math.floor(rnd() * pal.length), tx: rnd() * 2 - 1, ty: rnd() * 2 - 1,
        mix: 0.15 + rnd() * 0.25, dome: 0.6 + rnd() * 0.8, sh: 0.96 + rnd() * 0.07 });
      for (let x = x0; x < x0 + pw; x++) segOf[r * w + wrapI(x, w)] = pav.length - 1;
      x0 += pw;
    }
  }
  const mott = fbm(w, h, 14, 14, 4, rnd, 0.55), fine = fbm(w, h, 160, 160, 2, rnd, 0.5), en = fbm(w, h, 56, 56, 3, rnd, 0.5), dirt = fbm(w, h, 4, 4, 3, rnd, 0.5);
  const C = new Float32Array(N), nC = Math.round(1300 * k * k);
  for (let p = 0; p < nC; p++) {
    const r = (0.8 + Math.pow(rnd(), 2.2) * 4.5) * k, r2 = r * r, dep = 0.4 + rnd() * 0.8;
    forDisc(w, h, rnd() * w, rnd() * h, r, (i, dx, dy) => { const q = 1 - (dx * dx + dy * dy) / r2; if (q > 0) { const v = dep * Math.sqrt(q); if (v > C[i]) C[i] = v; } });
  }
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor(y / rh)), ly = y + 0.5 - r * rh;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, wn = rnd() - 0.5, p = pav[segOf[r * w + x]];
      let lx = x - p.x0; if (lx < 0) lx += w; lx += 0.5;
      const qx = Math.abs(lx - p.w / 2) - (p.w / 2 - jt - rc), qy = Math.abs(ly - rh / 2) - (rh / 2 - jt - rc);
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
      const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rc + en[i] * 3.0 * k + C[i] * 1.5 * k * (qx > -bev || qy > -bev ? 1 : 0);
      const dm = dirt[i];
      if (sd < 0) {
        const e = ss(0, bev, -sd), prof = Math.sqrt(e);
        const u = lx / p.w - 0.5, v = ly / rh - 0.5;
        H[i] = (1.0 + 3.2 * prof + 0.9 * (p.tx * u + p.ty * v * (rh / p.w)) + p.dome * 0.8 * (1 - 4 * (u * u + v * v * 0.25)) + 0.45 * mott[i] + 0.22 * fine[i] - 1.1 * C[i]) * k;
        const a = pal[p.c], b = pal[p.alt], m = clamp(0.5 + mott[i] * 1.8, 0, 1) * p.mix;
        const s = rnd(); let fl = s < 0.03 ? -24 : s > 0.988 ? 18 : 0; fl += wn * 12 + fine[i] * 6;
        const f = p.sh * (1 - 0.1 * (1 - e) - 0.08 * C[i]) * (1 - 0.035 * dm);
        col[j] = (a[0] + (b[0] - a[0]) * m) * f + fl; col[j + 1] = (a[1] + (b[1] - a[1]) * m) * f + fl; col[j + 2] = (a[2] + (b[2] - a[2]) * m) * f + fl * 0.95;
        Rg[i] = 0.78 + 0.07 * fine[i] + 0.08 * (1 - e) + 0.08 * C[i] + 0.04 * mott[i];
      } else {
        const s = rnd(), f = 0.92 + wn * 0.25 + (s < 0.06 ? -0.15 : s > 0.94 ? 0.12 : 0);
        col[j] = joint[0] * f; col[j + 1] = joint[1] * f; col[j + 2] = joint[2] * f;
        H[i] = (0.2 + 0.35 * wn + 0.2 * fine[i]) * k; Rg[i] = 0.97;
      }
      col[j + 3] = 255;
    }
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ POOL: deep navy / teal glass mosaic (canvas = 0.8 m) */
function genPool(S, rnd) {
  const w = S, h = S, N = w * h, k = S / 512, cell = 32 * k, chipW = 28 * k, grout = hex('#3b4851');
  const fine = fbm(w, h, 128, 128, 2, rnd, 0.5);
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  function groutFill(y0, y1) {
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, wn = rnd() - 0.5, f = 1 + wn * 0.16 + 0.05 * fine[i];
      col[j] = grout[0] * f; col[j + 1] = grout[1] * f; col[j + 2] = grout[2] * f; col[j + 3] = 255;
      H[i] = (0.2 + wn * 0.25) * k; Rg[i] = 0.85;
    }
  }
  function pick() {
    const u = rnd();
    if (u < 0.62) return hsl(208 + rnd() * 12, 62 + rnd() * 18, 15 + rnd() * 11);
    if (u < 0.9) return hsl(188 + rnd() * 10, 55 + rnd() * 20, 19 + rnd() * 11);
    if (u < 0.97) return hsl(220 + rnd() * 8, 45, 10 + rnd() * 5);
    return hsl(192 + rnd() * 8, 45, 38 + rnd() * 10);
  }
  function chip(x0, y0, cw, ch, c, gloss) {
    const rc = 3 * k, bev = 3.5 * k, gx = (rnd() - 0.5) * 2, gy = (rnd() - 0.5) * 2, tx = (rnd() - 0.5) * 0.6, ty = (rnd() - 0.5) * 0.6;
    for (let y = Math.floor(y0); y < y0 + ch; y++) for (let x = Math.floor(x0); x < x0 + cw; x++) {
      const lx = x + 0.5 - x0, ly = y + 0.5 - y0;
      const qx = Math.abs(lx - cw / 2) - (cw / 2 - rc), qy = Math.abs(ly - ch / 2) - (ch / 2 - rc);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc;
      if (sd >= 0) continue;
      const i = wrapI(y, h) * w + wrapI(x, w), j = i << 2, e = ss(0, bev, -sd), u = lx / cw - 0.5, v = ly / ch - 0.5;
      /* glass: lighter, more saturated rim where light refracts through the bevel; a few seed bubbles */
      const f = 0.95 + 0.12 * (u * gx + v * gy) + 0.22 * (1 - e) + (rnd() > 0.996 ? 0.4 : 0) + (rnd() - 0.5) * 0.04;
      col[j] = c[0] * f; col[j + 1] = c[1] * f; col[j + 2] = c[2] * f; col[j + 3] = 255;
      H[i] = (0.4 + 2.4 * Math.sqrt(e) + (tx * u + ty * v) * 2 + 0.05 * fine[i]) * k; Rg[i] = gloss + 0.08 * (1 - e);
    }
  }
  groutFill(0, h);
  for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 16; cy++) chip(cx * cell + 2 * k, cy * cell + 2 * k, chipW, chipW, pick(), 0.05);
  const pool = pack(w, h, col, H, 1, Rg);
  /* wall: dark slate-blue waterline tile band at the top (canvas top = coping), then the mosaic grid */
  const bandH = Math.round(56 * k), band = hex('#1c2c3b');
  groutFill(0, Math.round(64 * k));
  for (let bx = 0; bx < 4; bx++) chip(bx * w / 4 + 1.5 * k, 0, w / 4 - 3 * k, bandH, band.map(c => c * (0.9 + rnd() * 0.2)), 0.07);
  const wall = pack(w, h, col, H, 1, Rg);
  return { pool, wall };
}

/* ------------------------------------------------------------ TRAVERTINE COPING (canvas = 1.2 m x 0.32 m, two stones) */
function genTrav(W, rnd) {
  const w = W, h = W / 4, N = w * h, k = W / 1024, base = hex('#e3d6bd');
  const warp = fbm(w, h, 3, 2, 4, rnd, 0.55), mo = fbm(w, h, 12, 4, 4, rnd, 0.5), fine = fbm(w, h, 128, 32, 2, rnd, 0.5);
  const P = new Float32Array(N);
  for (let p = 0; p < Math.round(380 * k * k); p++) {
    const rx = (2 + Math.pow(rnd(), 1.6) * 9) * k, ry = (0.8 + rnd() * 2) * k, dep = 0.5 + rnd() * 0.5;
    forDisc(w, h, rnd() * w, rnd() * h, rx, (i, dx, dy) => { const q = 1 - dx * dx / (rx * rx) - dy * dy / (ry * ry); if (q > 0) { const v = dep * Math.sqrt(q); if (v > P[i]) P[i] = v; } });
  }
  const tone = [0.98 + rnd() * 0.05, 0.98 + rnd() * 0.05], pit = [176, 156, 124];
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, wn = rnd() - 0.5, st = x < w / 2 ? 0 : 1, lx = x - st * w / 2;
    const dj = Math.min(lx + 0.5, w / 2 - lx - 0.5), de = Math.min(y + 0.5, h - y - 0.5);
    const bd = Math.sin(TAU * (5 * y / h + warp[i] * 1.4 + st * 0.37));
    const vein = 1 - ss(0, 0.12, Math.abs(bd));
    const f = tone[st] * (1 + 0.02 * bd + 0.035 * mo[i] + wn * 0.03 - 0.04 * vein), pa = clamp(P[i] * 1.15, 0, 0.7);
    const jn = dj < 1.2 * k ? 0.72 : 1;
    col[j] = (base[0] * f * (1 - pa) + pit[0] * pa) * jn; col[j + 1] = (base[1] * f * (1 - pa) + pit[1] * pa) * jn; col[j + 2] = (base[2] * f * (1 - pa) + pit[2] * pa - 3 * vein) * jn; col[j + 3] = 255;
    const eb = ss(0, 6 * k, Math.min(dj, de * 1.4));
    H[i] = (1.6 * Math.sqrt(eb) + 0.2 * bd + 0.3 * mo[i] + 0.12 * fine[i] - 2.2 * P[i] + wn * 0.08) * k;
    Rg[i] = 0.58 + 0.06 * mo[i] + 0.3 * P[i] + (dj < 1.2 * k ? 0.3 : 0);
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ NAVY HERRINGBONE (45 deg, tiles w x 4w, w = 6.5 cm) */
function genHerring(S, rnd) {
  const w = S, h = S, N = w * h, n = 4, A = S / 512 * 8, tw = S / (A * Math.SQRT2), mPer = A / n, kPer = A;   // px per tile width
  const grout = hex('#8d9196'), wave = fbm(w, h, 8, 8, 3, rnd, 0.55), fine = fbm(w, h, 96, 96, 2, rnd, 0.5);
  const nT = mPer * kPer * 2, tc = [], tilt = [];
  for (let t = 0; t < nT; t++) {
    const u = rnd();
    tc.push(hsl(219 + rnd() * 8, 30 + rnd() * 14, u < 0.15 ? 8 + rnd() * 3 : u > 0.9 ? 17 + rnd() * 3 : 11 + rnd() * 5));
    tilt.push([(rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.2, rnd()]);
  }
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  const gw = 1.3 * (S / 512), bev = 3.2 * (S / 512), inv = 1 / (Math.SQRT2 * tw);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) {
    const i = Y * w + X, j = i << 2, px = X + 0.5, py = Y + 0.5;
    const a = (px + py) * inv, b = (py - px) * inv, dd = a - b;
    const m0 = Math.floor((dd + n + 1) / (2 * n));
    let id = -1, lx = 0, ly = 0, Lx = 1, Ly = 1;
    for (let q = 0; q < 3 && id < 0; q++) {
      const m = m0 + (q === 0 ? 0 : q === 1 ? -1 : 1), ap = a - m * n, bp = b + m * n;
      let kk = Math.floor(bp);
      if (ap >= kk && ap < kk + n) { id = ((wrapI(m, mPer) * kPer + wrapI(kk, kPer)) * 2); lx = ap - kk; ly = bp - kk; Lx = n; Ly = 1; break; }
      kk = Math.floor(ap);
      if (bp >= kk + 1 && bp < kk + 1 + n) { id = ((wrapI(m, mPer) * kPer + wrapI(kk, kPer)) * 2 + 1); lx = ap - kk; ly = bp - kk - 1; Lx = 1; Ly = n; break; }
    }
    const wn = rnd() - 0.5;
    if (id < 0) { col[j] = grout[0]; col[j + 1] = grout[1]; col[j + 2] = grout[2]; col[j + 3] = 255; H[i] = 0; Rg[i] = 0.85; continue; }
    const de = Math.min(lx, Lx - lx, ly, Ly - ly) * tw;   // px to the tile edge
    if (de < gw) {
      const f = 1 + wn * 0.18 + 0.05 * fine[i];
      col[j] = grout[0] * f; col[j + 1] = grout[1] * f; col[j + 2] = grout[2] * f; col[j + 3] = 255;
      H[i] = 0.2 * wn; Rg[i] = 0.85;
    } else {
      const c = tc[id], tl = tilt[id], e = ss(0, bev, de - gw);
      const u = lx / Lx - 0.5, v = ly / Ly - 0.5;
      const f = 1 + 0.05 * wave[i] + 0.1 * (1 - e) + 0.06 * (u * tl[0] + v * tl[1]) + wn * 0.03;
      col[j] = c[0] * f; col[j + 1] = c[1] * f; col[j + 2] = c[2] * f; col[j + 3] = 255;
      H[i] = (1.8 * Math.sqrt(e) + 0.5 * wave[i] + 0.9 * (u * tl[0] * Lx + v * tl[1] * Ly) / n * 2 + 0.04 * fine[i]);
      Rg[i] = 0.07 + 0.04 * tl[2] + 0.03 * wave[i] + 0.12 * (1 - e);
    }
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ LAWN: dense turf with clumps (canvas = 2.2 m) */
function genLawn(S, rnd) {
  const w = S, h = S, N = w * h, k = S / 512;
  const patch = fbm(w, h, 5, 5, 3, rnd, 0.55), clump = fbm(w, h, 40, 40, 2, rnd, 0.5);
  const blade = new Float32Array(N); addNoise(blade, w, h, 256 * k, 48 * k, 1, rnd); addNoise(blade, w, h, 160 * k, 36 * k, 0.6, rnd);
  const lush = [76, 122, 46], dark = [56, 94, 36], dry = [112, 132, 62];
  const col = new Uint8ClampedArray(N * 4), H = new Float32Array(N), Rg = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = rnd(), hgt = 0.5 + 0.5 * clump[i] + 0.55 * blade[i] + (r - 0.5) * 0.7;
    const dm = clamp(0.45 - patch[i] * 0.9, 0, 1), yl = clamp(patch[i] * 1.6 - 0.5, 0, 1) * 0.45 + (r > 0.985 ? 0.5 : 0);
    let c0 = lush[0] + (dark[0] - lush[0]) * dm, c1 = lush[1] + (dark[1] - lush[1]) * dm, c2 = lush[2] + (dark[2] - lush[2]) * dm;
    c0 += (dry[0] - c0) * yl; c1 += (dry[1] - c1) * yl; c2 += (dry[2] - c2) * yl;
    const f = 0.62 + 0.55 * clamp(hgt, 0, 1.4) / 1.4 + 0.1;
    col[j] = c0 * f; col[j + 1] = c1 * f; col[j + 2] = c2 * f; col[j + 3] = 255;
    H[i] = hgt * 2.2 * k; Rg[i] = 0.86 + 0.1 * (1 - clamp(hgt, 0, 1));
  }
  return pack(w, h, col, H, 1, Rg);
}

/* ------------------------------------------------------------ SHRUB FOLIAGE: overlapping small leaves */
function genLeaves(S, rnd) {
  const w = S, h = S, N = w * h, k = S / 256;
  const Hh = new Float32Array(N).fill(-1), id = new Int32Array(N).fill(-1), lc = [], nL = Math.round(1700 * k * k);
  for (let l = 0; l < nL; l++) {
    const cx = rnd() * w, cy = rnd() * h, a = (2.2 + rnd() * 2.6) * k, b = a * (0.42 + rnd() * 0.2), ang = rnd() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang), z = rnd();
    const u = rnd(); lc.push(u < 0.5 ? hsl(98 + rnd() * 18, 42 + rnd() * 18, 23 + rnd() * 10) : u < 0.85 ? hsl(85 + rnd() * 15, 40 + rnd() * 15, 30 + rnd() * 12) : hsl(105, 30, 16 + rnd() * 6));
    forDisc(w, h, cx, cy, a, (i, dx, dy) => {
      const px = dx * ca + dy * sa, py = -dx * sa + dy * ca, q = 1 - px * px / (a * a) - py * py / (b * b);
      if (q <= 0) return; const v = z * 3 + Math.sqrt(q) * 1.4 + (Math.abs(py) < 0.35 * k ? -0.25 : 0);
      if (v > Hh[i]) { Hh[i] = v; id[i] = l; }
    });
  }
  const col = new Uint8ClampedArray(N * 4), Rg = new Float32Array(N), gap = [22, 34, 16];
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    if (id[i] < 0) { col[j] = gap[0]; col[j + 1] = gap[1]; col[j + 2] = gap[2]; Hh[i] = -1.5; Rg[i] = 1; }
    else { const c = lc[id[i]], f = 0.7 + 0.12 * Hh[i]; col[j] = c[0] * f; col[j + 1] = c[1] * f; col[j + 2] = c[2] * f; Rg[i] = 0.62; }
    col[j + 3] = 255; Hh[i] *= k;
  }
  return pack(w, h, col, Hh, 1, Rg);
}

/* ------------------------------------------------------------ apply */
const GEN = { genStucco, genShingle, genPaver, genPool, genTrav, genHerring, genLawn, genLeaves };

function apply(CTX) {
  const THREE = CTX.THREE, scene = CTX.scene, M = CTX.M, MOBILE = !!CTX.MOBILE, renderer = CTX.renderer;
  const now = () => (window.performance && performance.now) ? performance.now() : Date.now();
  const t0 = now(), timings = {};
  let ANISO = 4;
  try { ANISO = Math.min(MOBILE ? 4 : 16, renderer.capabilities.getMaxAnisotropy() || 1); } catch (e) { ANISO = 4; }
  const big = MOBILE ? 512 : 1024, med = MOBILE ? 256 : 512;
  function tex(c, srgb) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = ANISO; return t; }
  function texSet(p) { return { map: tex(p.color, true), normalMap: p.normal ? tex(p.normal, false) : null, roughnessMap: p.rough ? tex(p.rough, false) : null }; }
  const likeCache = new Map();   // identical transforms share one texture (one GPU upload)
  function like(t, ref, rep) {
    const c = t.clone();
    if (ref) { c.repeat.copy(ref.repeat); c.offset.copy(ref.offset); c.center.copy(ref.center); c.rotation = ref.rotation; }
    if (rep) { c.repeat.set(rep[0], rep[1]); if (rep[2] !== undefined) c.offset.set(rep[2], rep[3]); if (rep[4] !== undefined) { c.center.set(0.5, 0.5); c.rotation = rep[4]; } }
    const key = t.uuid + '|' + [c.repeat.x, c.repeat.y, c.offset.x, c.offset.y, c.rotation, c.center.x, c.center.y].map(v => v.toFixed(5)).join(',');
    if (likeCache.has(key)) { c.dispose(); return likeCache.get(key); }
    c.needsUpdate = true; likeCache.set(key, c); return c;
  }
  /* put a texture set on a material, keeping (or overriding) the transform of its current map */
  function setMaps(m, set, opts) {
    opts = opts || {};
    const ref = opts.ref !== undefined ? opts.ref : (m.map || m.normalMap || null), rep = opts.rep;
    if (set.map && opts.noColor !== true) m.map = like(set.map, ref, rep);
    if (set.normalMap) { m.normalMap = like(set.normalMap, ref, rep); m.normalScale.set(opts.ns || 1, opts.ns || 1); m.bumpMap = null; }
    if (set.roughnessMap) { m.roughnessMap = like(set.roughnessMap, ref, rep); m.roughness = opts.rough !== undefined ? opts.rough : 1; }
    m.needsUpdate = true;
  }
  function run(key, fn) { const ts = now(); try { fn(); } catch (e) { console.warn('[LanaiMaterialsExt] ' + key + ' skipped', e); } timings[key] = Math.round(now() - ts); }
  const mats = o => o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
  scene.updateMatrixWorld(true);

  /* remember the original maps before anything changes (roof meshes carry dissolve clones that share them) */
  const orig = {};
  ['stucco', 'trim', 'shingle', 'paver', 'herring', 'trav', 'lawn'].forEach(k => { orig[k] = M[k] ? M[k].map : null; });
  const allMeshes = []; scene.traverse(o => { if (o.isMesh) allMeshes.push(o); });
  const usesImage = (m, t) => !!(m && t && m.map && m.map.image === t.image);

  /* ---------------- stucco walls + trim ---------------- */
  run('stucco', () => {
    const st = texSet(genStucco(big, mkRng(101)));
    const m = M.stucco;
    setMaps(m, st, { ns: 0.9 });
    m.color.set('#ffffff'); m.roughness = 1; m.metalness = 0; m.envMapIntensity = 0.55;
    /* boxes (tower, wing, kitchen wall) map 0..1 per face: give each face a clone at true 2 m texture scale
       so the plaster is not stretched into large tan blotches */
    const faceCache = new Map(), near2 = (a, b) => Math.abs(a - b) < 1e-3;
    const faceMat = (fw, fh) => {
      const key = fw.toFixed(2) + 'x' + fh.toFixed(2); if (faceCache.has(key)) return faceCache.get(key);
      const c = m.clone(), rep = [fw / 2, fh / 2];
      c.map = like(st.map, null, rep); c.normalMap = like(st.normalMap, null, rep); c.roughnessMap = like(st.roughnessMap, null, rep);
      c.needsUpdate = true; faceCache.set(key, c); return c;
    };
    allMeshes.forEach(o => {
      const g = o.geometry; if (!g || g.type !== 'BoxGeometry' || !g.parameters) return;
      const p = g.parameters, dims = [[p.depth, p.height], [p.depth, p.height], [p.width, p.depth], [p.width, p.depth], [p.width, p.height], [p.width, p.height]];
      if (Array.isArray(o.material)) { if (o.material.indexOf(m) < 0) return; o.material = o.material.map((mm, i) => mm === m ? faceMat(dims[i][0], dims[i][1]) : mm); }
      else if (o.material === m && !(near2(p.width, 1) && near2(p.height, 1))) {
        /* single-material box: use the largest face size (all its big faces share it) */
        const a = [p.width * p.height, p.depth * p.height, p.width * p.depth], i = a.indexOf(Math.max(...a));
        o.material = faceMat(...(i === 0 ? [p.width, p.height] : i === 1 ? [p.depth, p.height] : [p.width, p.depth]));
      }
    });
    M.stuccoFaces = Array.from(faceCache.values());
    /* trim and crown: same plaster, smoother, a touch brighter, no mottling */
    const t = M.trim, ref = orig.trim;
    t.map = null; t.color.set('#ece0c8');
    t.normalMap = like(st.normalMap, ref); t.normalScale.set(0.3, 0.3); t.bumpMap = null;
    t.roughnessMap = null; t.roughness = 0.74; t.metalness = 0; t.envMapIntensity = 0.6; t.needsUpdate = true;
    if (M.trimDS) { M.trimDS.copy(t); M.trimDS.side = THREE.DoubleSide; M.trimDS.needsUpdate = true; }
    /* fascia, gutters, downspouts, soffits: smooth semi-gloss exterior paint */
    const paint = new THREE.MeshStandardMaterial({ color: '#e2d3b6', roughness: 0.7, metalness: 0, envMapIntensity: 0.7 });
    M.trimPaint = paint;
    const near = (a, b) => Math.abs(a - b) < 2e-3;
    allMeshes.forEach(o => {
      if (o.material !== t) return;
      const g = o.geometry, p = g && g.parameters || {};
      let hit = false;
      if (g.type === 'BoxGeometry') {
        if (near(p.height, 0.22) && (p.depth < 0.045 || p.width < 0.045)) hit = true;                      // fascia boards
        else if (near(p.height, 0.12) && (near(p.depth, 0.12) || near(p.width, 0.12))) hit = true;          // gutters
        else if (near(p.width, 0.08) && near(p.depth, 0.08) && p.height > 2) hit = true;                    // downspouts
      } else if (g.type === 'PlaneGeometry' && Math.abs(o.rotation.x - Math.PI / 2) < 1e-3) hit = true;  // soffits
      if (hit) o.material = paint;
    });
    /* the lifting roof lid uses dissolve clones: retune those in place so the ember shader keeps working */
    if (CTX.roof) CTX.roof.traverse(o => {
      if (!o.isMesh) return;
      mats(o).forEach(mm => {
        if (!mm || mm === t || mm === paint) return;
        if (ref && mm.map === ref) {
          mm.map = null; mm.normalMap = null; mm.roughnessMap = null; mm.bumpMap = null;
          mm.color.set('#e2d3b6'); mm.roughness = 0.7; mm.metalness = 0; mm.envMapIntensity = 0.7; mm.needsUpdate = true;
        }
      });
    });
  });

  /* ---------------- steel window + door frames: charcoal / dark-bronze satin powder coat ---------------- */
  run('frames', () => {
    const fr = [M.frame].concat(CTX.frameMats || []);
    fr.forEach(f => { if (!f) return; f.color.set('#232220'); f.roughness = 0.56; f.metalness = 0.1; f.envMapIntensity = 0.35; f.needsUpdate = true; });
    if (M.frameWhite) Object.assign(M.frameWhite, { roughness: 0.34, metalness: 0, envMapIntensity: 0.85 }), M.frameWhite.color.set('#f3efe6'), M.frameWhite.needsUpdate = true;
    if (M.darkGlass) { M.darkGlass.color.set('#141a1f'); Object.assign(M.darkGlass, { roughness: 0.02, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }); M.darkGlass.needsUpdate = true; }
  });

  /* ---------------- architectural glass ----------------
     Premultiplied blending: the pane adds its own reflection on top of what is behind it and lets
     T = Tglass*(1-F)^2 of the background through (F = Schlick Fresnel), so head-on it is clear and
     lightly tinted, and at grazing angles it turns into a mirror of the sky. */
  run('glass', () => {
    const g = M.glass; if (!g) return;
    g.color.set('#0b1012');
    Object.assign(g, { roughness: 0.02, metalness: 0, reflectivity: 0.6, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 1.6, opacity: 1,
      transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide });
    const uT = { value: 0.82 }, uH = { value: 0.22 };
    g.userData.extGlass = { transmission: uT, headOnReflection: uH };
    g.onBeforeCompile = function (sh) {
      sh.uniforms.uGlassT = uT; sh.uniforms.uGlassHead = uH;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlassT,uGlassHead;')
        .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          `/* LanaiMaterialsExt glass */
           float _nv=clamp(abs(dot(normalize(vViewPosition),normal)),0.0,1.0);
           float _F=0.045+0.955*pow(1.0-_nv,5.0);
           float _T=uGlassT*(1.0-_F)*(1.0-_F);
           /* keep head-on reflections faint so the lit interior reads; full mirror toward grazing */
           vec3 _rf=outgoingLight*mix(uGlassHead,1.0,pow(1.0-_nv,3.0));
           gl_FragColor=vec4(_rf,1.0-_T);`)
        .replace('#include <premultiplied_alpha_fragment>', '');
    };
    g.customProgramCacheKey = () => 'lanai-ext-glass-v1';
    g.needsUpdate = true;
  });

  /* ---------------- roof: dark dimensional shingles ---------------- */
  run('shingle', () => {
    const sh = texSet(genShingle(big, mkRng(202)));
    const targets = new Set([M.shingle]);
    allMeshes.forEach(o => mats(o).forEach(mm => { if (usesImage(mm, orig.shingle)) targets.add(mm); }));
    targets.forEach(mm => { setMaps(mm, sh, { ns: 1.25 }); mm.color.set('#ffffff'); mm.metalness = 0; mm.envMapIntensity = 0.8; });
    /* ridge caps: match the shingle tone */
    allMeshes.forEach(o => mats(o).forEach(mm => {
      if (mm && mm.isMeshStandardMaterial && !mm.map && mm.color && mm.color.getHexString() === '2a2d31' && o.geometry.type === 'BoxGeometry') {
        mm.color.set('#454545'); mm.roughness = 0.85; mm.needsUpdate = true;
      }
    }));
  });

  /* ---------------- pavers ---------------- */
  run('paver', () => {
    const pv = texSet(genPaver(big, mkRng(303)));
    const targets = new Set([M.paver]);
    allMeshes.forEach(o => mats(o).forEach(mm => { if (usesImage(mm, orig.paver)) targets.add(mm); }));
    targets.forEach(mm => { setMaps(mm, pv, { ns: 1.15 }); mm.color.set('#ffffff'); mm.metalness = 0; mm.envMapIntensity = 0.6; });
  });

  /* ---------------- pool mosaic, waterline band, water tint ---------------- */
  run('pool', () => {
    const P = CTX.POOL; if (!P) return;
    const pp = genPool(med, mkRng(404)), ps = texSet(pp.pool), pw = texSet(pp.wall);
    allMeshes.forEach(o => {
      if (!o.geometry || o.geometry.type !== 'PlaneGeometry' || Array.isArray(o.material)) return;
      const p = o.getWorldPosition(new THREE.Vector3());
      if (p.x < P.x0 - 0.05 || p.x > P.x1 + 0.05 || p.z < P.z0 - 0.05 || p.z > P.z1 + 0.05 || p.y > 0 || p.y < P.y - 0.05) return;
      const m = o.material; if (!m.isMeshStandardMaterial || !m.map) return;
      const floor = Math.abs(p.y - (P.y + 0.002)) < 0.01;
      setMaps(m, floor ? ps : pw, { ns: 0.9 });
      m.color.set('#ffffff'); m.metalness = 0; m.envMapIntensity = 0.9;
    });
    if (M.water) { M.water.color.set('#0b4a68'); M.water.opacity = 0.5; M.water.envMapIntensity = 0.7; M.water.needsUpdate = true; }
  });

  /* ---------------- travertine coping: per-piece UV scale so the stones are true size ---------------- */
  run('trav', () => {
    if (!M.trav) return;
    const tv = texSet(genTrav(big, mkRng(505))), travMats = new Map();
    allMeshes.forEach(o => {
      if (o.material !== M.trav || !o.geometry || o.geometry.type !== 'BoxGeometry') return;
      const p = o.geometry.parameters, mk = p.width.toFixed(3) + 'x' + p.depth.toFixed(3);
      if (travMats.has(mk)) { o.material = travMats.get(mk); return; }
      const m = M.trav.clone(); travMats.set(mk, m);
      /* box faces map 0..1 per face: long along x -> repeat along u; long along z -> rotate a quarter turn */
      if (p.width >= p.depth) setMaps(m, tv, { ns: 1, ref: null, rep: [p.width / 1.2, p.depth / 0.32] });
      else setMaps(m, tv, { ns: 1, ref: null, rep: [p.depth / 1.2, p.width / 0.32, 0, 0, Math.PI / 2] });
      m.color.set('#ffffff'); m.metalness = 0; m.envMapIntensity = 0.7;
      o.material = m;
    });
  });

  /* ---------------- glossy navy herringbone wall ---------------- */
  run('herring', () => {
    if (!M.herring) return;
    const S = med, hb = texSet(genHerring(S, mkRng(606)));
    const canvasM = (S / 512 * 8) * Math.SQRT2 * 0.065;   // physical size of one canvas
    let rep = [5, 5.6];
    allMeshes.forEach(o => { if (Array.isArray(o.material) && o.material.indexOf(M.herring) >= 0 && o.geometry.parameters) {
      const p = o.geometry.parameters; rep = [p.width / canvasM, p.height / canvasM]; } });
    setMaps(M.herring, hb, { ns: 0.9, ref: null, rep });
    M.herring.color.set('#ffffff'); M.herring.metalness = 0; M.herring.envMapIntensity = 0.75;
  });

  /* ---------------- lawn + shrubs + grasses ---------------- */
  run('lawn', () => {
    if (!M.lawn) return;
    const lw = texSet(genLawn(med, mkRng(707)));
    setMaps(M.lawn, lw, { ns: 1.0 });
    M.lawn.color.set('#ffffff'); M.lawn.envMapIntensity = 0.45;
    /* break the tiling with a slow world-space tone drift */
    M.lawn.onBeforeCompile = function (sh) {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLwW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLwW=(modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vLwW;
        float lwH(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float lwN(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(lwH(i),lwH(i+vec2(1,0)),f.x),mix(lwH(i+vec2(0,1)),lwH(i+vec2(1,1)),f.x),f.y);}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float _ln=lwN(vLwW.xz*0.45)*0.6+lwN(vLwW.xz*1.3+7.0)*0.4;
          diffuseColor.rgb*=mix(vec3(0.88,0.91,0.86),vec3(1.07,1.05,0.96),_ln);`);
    };
    M.lawn.customProgramCacheKey = () => 'lanai-ext-lawn-v1';
    M.lawn.needsUpdate = true;
  });
  run('shrubs', () => {
    const lv = texSet(genLeaves(MOBILE ? 128 : 256, mkRng(808)));
    const done = new Set();
    allMeshes.forEach(o => {
      const g = o.geometry; if (!g || g.type !== 'IcosahedronGeometry' || Array.isArray(o.material)) return;
      const m = o.material; if (!m.map || done.has(m)) return; done.add(m);
      setMaps(m, lv, { ns: 1.2 }); m.color.set('#ffffff'); m.envMapIntensity = 0.4;
      /* self-shadowing: darker underneath and toward the core */
      if (!g.attributes.color) {
        const p = g.attributes.position, c = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) { const y = p.getY(i), r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i)); const v = (0.42 + 0.58 * ss(-1, 0.7, y)) * (0.75 + 0.25 * ss(0.92, 1.08, r)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      m.vertexColors = true; m.needsUpdate = true;
    });
    /* ornamental grass blades */
    allMeshes.forEach(o => { const g = o.geometry; if (g && g.type === 'ConeGeometry' && o.material && !Array.isArray(o.material) && o.material.color && o.material.color.getHexString() === '6f7a3a') {
      o.material.color.set('#7f8a45'); o.material.roughness = 0.8; o.material.needsUpdate = true; } });
  });

  timings.total = Math.round(now() - t0);
  root.LanaiMaterialsExt.timings = timings;
  if (root.console && console.info) console.info('[LanaiMaterialsExt] textures ' + timings.total + ' ms', JSON.stringify(timings));
}

root.LanaiMaterialsExt = { apply: function (CTX) { try { apply(CTX); } catch (e) { console.error('[LanaiMaterialsExt]', e); } }, _gen: GEN, _rng: mkRng, version: 1 };
})(typeof window !== 'undefined' ? window : this);
