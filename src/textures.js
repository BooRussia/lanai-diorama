/* LanaiTextures - procedural PBR texture upgrade for the lanai diorama.
 *
 *   const T = window.LanaiTextures.build(THREE, renderer, { hiRes:false });
 *   T.stuccoTex = { map, normalMap, roughnessMap, normalScale }   (and the other keys)
 *   T.materialTweaks  -> per-M-key physical suggestions (roughness / metalness / normalScale)
 *   T.applyTo(M)      -> optional helper that wires maps + tweaks into the existing materials
 *
 * Colours, palettes, pattern types, pixel layout (band rows, tile / chip / paver grids) and
 * texture.repeat values match the original inline generator; only surface detail is added.
 * Colour maps are sRGB; normal / roughness maps are linear. Everything is deterministic
 * (seeded PRNG) and every tiling texture wraps seamlessly (periodic noise, wrapped stamps).
 */
(function (root) {
'use strict';

/* ------------------------------------------------------------------ utilities */
function makeRng(seed) {
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
const wrapI = (v, n) => ((v % n) + n) % n;

function makeCanvas(w, h, read) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  let g = null;
  if (read) { try { g = c.getContext('2d', { willReadFrequently: true }); } catch (e) { g = null; } }
  if (!g) g = c.getContext('2d');
  return [c, g];
}
function toCanvas(img) { const [c, g] = makeCanvas(img.width, img.height); g.putImageData(img, 0, 0); return c; }

/* periodic value noise (quintic fade) added into `out` */
function addValueNoise(out, w, h, px, py, amp, rnd) {
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
/* fractal sum; px/py = lattice cells across the canvas for the first octave (integers => seamless) */
function fbm(w, h, px, py, oct, rnd, gain) {
  gain = gain || 0.5;
  // low-frequency fields: evaluate at reduced resolution (>= 6 px per finest cell) and upsample periodically
  let s = 1;
  const mx = px * Math.pow(2, oct - 1), my = py * Math.pow(2, oct - 1);
  while (s < 8 && w % (s * 2) === 0 && w / (s * 2) >= mx * 6 && (h === 1 || (h % (s * 2) === 0 && h / (s * 2) >= my * 6))) s *= 2;
  if (s > 1) {
    const sw = w / s, sh = h === 1 ? 1 : h / s, lo = fbmDirect(sw, sh, px, py, oct, rnd, gain), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = sh === 1 ? 0 : (y + 0.5) / s - 0.5, y0 = Math.floor(fy), ty = fy - y0, r0 = wrapI(y0, sh) * sw, r1 = wrapI(y0 + 1, sh) * sw;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / s - 0.5, x0 = Math.floor(fx), tx = fx - x0, a = wrapI(x0, sw), b = wrapI(x0 + 1, sw);
        const top = lo[r0 + a] + (lo[r0 + b] - lo[r0 + a]) * tx, bot = lo[r1 + a] + (lo[r1 + b] - lo[r1 + a]) * tx;
        out[y * w + x] = top + (bot - top) * ty;
      }
    }
    return out;
  }
  return fbmDirect(w, h, px, py, oct, rnd, gain);
}
function fbmDirect(w, h, px, py, oct, rnd, gain) {
  const out = new Float32Array(w * h);
  let amp = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    if (px > w || (h > 1 && py > h)) break;
    addValueNoise(out, w, h, px, py, amp, rnd);
    n += amp; amp *= gain; px *= 2; py *= 2;
  }
  const k = n ? 1 / n : 1;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}
/* separable box blur, optional wrap */
function boxBlur(src, w, h, r, wrapX, wrapY) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  const ix = x => wrapX ? wrapI(x, w) : clamp(x, 0, w - 1);
  const iy = y => wrapY ? wrapI(y, h) : clamp(y, 0, h - 1);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let k = -r; k <= r; k++) s += src[o + ix(k)];
    for (let x = 0; x < w; x++) { tmp[o + x] = s * inv; s += src[o + ix(x + r + 1)] - src[o + ix(x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[iy(k) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s * inv; s += tmp[iy(y + r + 1) * w + x] - tmp[iy(y - r) * w + x]; }
  }
  return out;
}
/* tangent-space (OpenGL, +Y = +v) normal map from a height field in pixel units, Sobel */
function normalImage(G, H, w, h, depth, wrapX, wrapY) {
  const img = G.createImageData(w, h), d = img.data;
  const xm = new Int32Array(w), xp = new Int32Array(w), ym = new Int32Array(h), yp = new Int32Array(h);
  for (let x = 0; x < w; x++) { xm[x] = x > 0 ? x - 1 : (wrapX ? w - 1 : 0); xp[x] = x < w - 1 ? x + 1 : (wrapX ? 0 : w - 1); }
  for (let y = 0; y < h; y++) { ym[y] = (y > 0 ? y - 1 : (wrapY ? h - 1 : 0)) * w; yp[y] = (y < h - 1 ? y + 1 : (wrapY ? 0 : h - 1)) * w; }
  const s = depth / 8;
  for (let y = 0; y < h; y++) {
    const r0 = ym[y], r1 = y * w, r2 = yp[y];
    for (let x = 0; x < w; x++) {
      const a = xm[x], c = xp[x];
      const tl = H[r0 + a], t = H[r0 + x], tr = H[r0 + c], l = H[r1 + a], r = H[r1 + c], bl = H[r2 + a], b = H[r2 + x], br = H[r2 + c];
      const nx = -((tr + 2 * r + br) - (tl + 2 * l + bl)) * s;
      const ny = ((bl + 2 * b + br) - (tl + 2 * t + tr)) * s;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const j = (r1 + x) << 2;
      d[j] = (nx * inv * 0.5 + 0.5) * 255; d[j + 1] = (ny * inv * 0.5 + 0.5) * 255; d[j + 2] = (inv * 0.5 + 0.5) * 255; d[j + 3] = 255;
    }
  }
  return img;
}
function grayImage(G, F, w, h) {
  const img = G.createImageData(w, h), d = img.data;
  for (let i = 0, j = 0; i < F.length; i++, j += 4) { const v = clamp(F[i], 0, 1) * 255; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
  return img;
}
function meanRGB(d) {
  let r = 0, g = 0, b = 0; const n = d.length >> 2;
  for (let j = 0; j < d.length; j += 4) { r += d[j]; g += d[j + 1]; b += d[j + 2]; }
  return [r / n, g / n, b / n];
}
function shiftMean(d, target) {
  const m = meanRGB(d), dr = target[0] - m[0], dg = target[1] - m[1], db = target[2] - m[2];
  for (let j = 0; j < d.length; j += 4) { d[j] += dr; d[j + 1] += dg; d[j + 2] += db; }
}
/* shift each region's mean colour to its target (ids < 0 or null target are skipped) */
function regionMatch(d, ids, targets) {
  const n = targets.length, s = new Float64Array(n * 4);
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) {
    const id = ids[i]; if (id < 0 || id >= n) continue;
    const o = id * 4; s[o] += d[j]; s[o + 1] += d[j + 1]; s[o + 2] += d[j + 2]; s[o + 3]++;
  }
  const off = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const t = targets[k], c = s[k * 4 + 3];
    if (!t || !c) continue;
    off[k * 3] = t[0] - s[k * 4] / c; off[k * 3 + 1] = t[1] - s[k * 4 + 1] / c; off[k * 3 + 2] = t[2] - s[k * 4 + 2] / c;
  }
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) {
    const id = ids[i]; if (id < 0 || id >= n || !targets[id]) continue;
    d[j] += off[id * 3]; d[j + 1] += off[id * 3 + 1]; d[j + 2] += off[id * 3 + 2];
  }
}
/* visit pixels of a disc around (cx,cy) */
function forDisc(w, h, cx, cy, r, wrapX, wrapY, fn) {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    let yy = y;
    if (wrapY) yy = wrapI(y, h); else if (y < 0 || y >= h) continue;
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      let xx = x;
      if (wrapX) xx = wrapI(x, w); else if (x < 0 || x >= w) continue;
      fn(yy * w + xx, x + 0.5 - cx, dy);
    }
  }
}
/* visit pixels near a tapered segment; fn(i, dist, radius, t) */
function forCapsule(w, h, ax, ay, bx, by, r0, r1, wrapX, fn) {
  const rm = Math.max(r0, r1) + 1;
  const x0 = Math.floor(Math.min(ax, bx) - rm), x1 = Math.ceil(Math.max(ax, bx) + rm);
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - rm)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + rm));
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1e-6;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - ay;
    for (let x = x0; x <= x1; x++) {
      let xx = x;
      if (wrapX) xx = wrapI(x, w); else if (x < 0 || x >= w) continue;
      const px = x + 0.5 - ax;
      const t = clamp((px * vx + py * vy) / L2, 0, 1);
      const dx = px - vx * t, dy = py - vy * t, dist = Math.sqrt(dx * dx + dy * dy);
      const r = r0 + (r1 - r0) * t;
      if (dist < r + 1) fn(y * w + xx, dist, r, t);
    }
  }
}
/* cyclic list of integer widths summing exactly to `total` */
function cyclicWidths(total, wmin, wmax, rnd) {
  const ws = []; let sum = 0;
  while (sum < total) { const v = Math.round(wmin + rnd() * (wmax - wmin)); ws.push(v); sum += v; }
  ws[ws.length - 1] -= sum - total;
  if (ws.length > 1 && ws[ws.length - 1] < wmin * 0.8) { const l = ws.pop(); ws[ws.length - 1] += l; }
  return ws;
}
/* draw a closure at the 9 wrapped offsets (for seamless canvas-API drawing) */
function drawWrapped(w, h, fn) { for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) fn(ox * w, oy * h); }

/* ------------------------------------------------------------------ STUCCO */
function genStucco(S, rnd, G) {
  const w = S, h = S, N = w * h, k = S / 1024;
  const base = hex('#ece2cb'), tan = [205, 190, 155], wht = [255, 252, 240];
  const low = fbm(w, h, 3, 3, 4, rnd, 0.5), mid = fbm(w, h, 12, 12, 4, rnd, 0.55);
  const H = new Float32Array(N), Bn = new Float32Array(N);
  for (let i = 0; i < N; i++) H[i] = 0.45 + 0.3 * low[i];
  // overlapping hand-trowel arcs: each sweep lays a plateau with feathered edges, a lip and fine trowel striations
  for (let s = 0; s < 190; s++) {
    const R = (45 + rnd() * 125) * k, T = R * (0.32 + rnd() * 0.38), cx = rnd() * w, cy = rnd() * h;
    const a0 = rnd() * TAU, sw = 0.6 + rnd() * 1.5, L = 0.25 + rnd() * 0.6, fq = TAU / ((3 + rnd() * 5) * k), ph = rnd() * TAU;
    const rin = R - T / 2, rout = R + T / 2, rin2 = rin * rin, rout2 = rout * rout;
    // bounding box of the annular sector only
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    const addPt = (ang, rr) => { const px = Math.cos(ang) * rr, py = Math.sin(ang) * rr; if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; };
    for (let q = 0; q <= 8; q++) { const ang = a0 + sw * q / 8; addPt(ang, rin); addPt(ang, rout); }
    for (let q = Math.ceil(a0 / (Math.PI / 2)); q * Math.PI / 2 <= a0 + sw; q++) addPt(q * Math.PI / 2, rout);
    const icx = Math.floor(cx), icy = Math.floor(cy);
    const ox0 = Math.floor(bx0) - 1, ox1 = Math.ceil(bx1) + 1, oy0 = Math.floor(by0) - 1, oy1 = Math.ceil(by1) + 1;
    for (let oy = oy0; oy <= oy1; oy++) {
      const dy = icy + oy + 0.5 - cy, dy2 = dy * dy; if (dy2 > rout2) continue;
      const row = wrapI(icy + oy, h) * w;
      for (let ox = ox0; ox <= ox1; ox++) {
        const dx = icx + ox + 0.5 - cx, d2 = dx * dx + dy2; if (d2 < rin2 || d2 > rout2) continue;
        let a = Math.atan2(dy, dx) - a0; a -= TAU * Math.floor(a / TAU); if (a > sw) continue;
        const d = Math.sqrt(d2), t = (d - rin) / T, uu = a / sw;
        const along = Math.min(1, Math.sin(Math.PI * uu) * 2.5);
        const wgt = ss(0, 0.2, t) * (1 - ss(0.8, 1, t)) * along;
        const i = row + wrapI(icx + ox, w);
        const lip = 0.1 * along * Math.exp(-(t - 0.9) * (t - 0.9) * 300);
        H[i] = H[i] * (1 - wgt) + wgt * (L + 0.025 * Math.sin(d * fq + ph)) + lip;
        Bn[i] = Bn[i] * (1 - wgt) + wgt * along * (0.4 + 0.6 * (1 - t));
      }
    }
  }
  // micro pores / air pockets
  const P = new Float32Array(N), nP = Math.round(5200 * k * k);
  for (let p = 0; p < nP; p++) {
    const r = (0.6 + Math.pow(rnd(), 2.5) * 2.4) * k, r2 = r * r, dep = 0.4 + rnd() * 0.6;
    forDisc(w, h, rnd() * w, rnd() * h, r, true, true, (i, dx, dy) => { const q = 1 - (dx * dx + dy * dy) / r2; if (q > 0) { const v = dep * q; if (v > P[i]) P[i] = v; } });
  }
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const g = rnd() - 0.5;
    Hn[i] = (H[i] * 3.2 + mid[i] * 0.8 + g * 0.18 - P[i] * 0.9) * k;
    const m = 0.4 * low[i] + 0.16 * mid[i] + 0.05 * (H[i] - 0.5);
    const f = 1 - 0.1 * P[i] + g * 0.05;
    if (m >= 0) { d[j] = (base[0] + m * (wht[0] - base[0])) * f; d[j + 1] = (base[1] + m * (wht[1] - base[1])) * f; d[j + 2] = (base[2] + m * (wht[2] - base[2])) * f; }
    else { d[j] = (base[0] + m * (base[0] - tan[0])) * f; d[j + 1] = (base[1] + m * (base[1] - tan[1])) * f; d[j + 2] = (base[2] + m * (base[2] - tan[2])) * f; }
    d[j + 3] = 255;
    Rg[i] = 0.95 - 0.13 * Bn[i] + 0.03 * mid[i] + 0.04 * P[i];
  }
  shiftMean(d, base);
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ FLOOR TILE (canvas = 1.2 m, 2x2 tiles) */
function genTile(S, rnd, G) {
  const w = S, h = S, N = w * h, k = S / 1024, T = S / 2, gh = 4 * k, bev = 6 * k;
  const grout = hex('#b9ad97'), veinC = [170, 150, 115];
  const cols = [], ori = [], ph = [], nb = [], ph2 = [], nb2 = [];
  for (let t = 0; t < 4; t++) {
    cols.push(hsl(40, 22, 78 + (rnd() * 6 - 3))); ori.push(rnd() < 0.5 ? 0 : 1);
    ph.push(rnd() * TAU); nb.push(2 + Math.floor(rnd() * 4)); ph2.push(rnd() * TAU); nb2.push(1 + rnd() * 1.5);
  }
  const warp = fbm(w, h, 4, 4, 5, rnd, 0.55), mott = fbm(w, h, 10, 10, 4, rnd, 0.5), fine = fbm(w, h, 96, 96, 2, rnd, 0.5);
  const P = new Float32Array(N), nP = Math.round(420 * k * k);
  for (let p = 0; p < nP; p++) {   // filled travertine voids, elongated along the banding
    const cx = rnd() * w, cy = rnd() * h, tid = (Math.floor(cy / T) % 2) * 2 + (Math.floor(cx / T) % 2);
    const a = (1.5 + rnd() * 5) * k, b = (0.6 + rnd() * 1.4) * k, rx = ori[tid] ? b : a, ry = ori[tid] ? a : b, dep = 0.5 + rnd() * 0.5;
    forDisc(w, h, cx, cy, Math.max(rx, ry), true, true, (i, dx, dy) => { const q = 1 - dx * dx / (rx * rx) - dy * dy / (ry * ry); if (q > 0) { const v = dep * Math.sqrt(q); if (v > P[i]) P[i] = v; } });
  }
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N), ids = new Int32Array(N);
  for (let y = 0; y < h; y++) {
    const ty = y < T ? 0 : 1, ly = y - ty * T;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, tx = x < T ? 0 : 1, lx = x - tx * T, wn = rnd() - 0.5;
      const de = Math.min(lx + 0.5, T - lx - 0.5, ly + 0.5, T - ly - 0.5) - gh;
      if (de > 0) {
        const id = ty * 2 + tx, c = cols[id], crd = (ori[id] ? lx : ly) / T, wv = warp[i];
        const band = Math.sin(TAU * (crd * nb[id] + wv * 0.9) + ph[id]);
        const vs = Math.abs(Math.sin(TAU * (crd * nb2[id] + wv * 2.2 + mott[i] * 0.6) + ph2[id]));
        const vein = 1 - ss(0, 0.05, vs);
        const f = 1 + 0.022 * band + 0.035 * mott[i] + 0.02 * fine[i] + wn * 0.025;
        const vm = 0.16 * vein + 0.18 * P[i];
        d[j] = c[0] * f * (1 - vm) + veinC[0] * vm; d[j + 1] = c[1] * f * (1 - vm) + veinC[1] * vm; d[j + 2] = c[2] * f * (1 - vm) + veinC[2] * vm;
        const e = ss(0, bev, de);
        Hn[i] = (2.6 * (0.45 + 0.55 * Math.sqrt(e)) + 0.15 * wv + 0.05 * fine[i] - 0.5 * P[i]) * k;
        Rg[i] = 0.3 + 0.05 * mott[i] + 0.05 * vein + 0.25 * P[i] + (1 - e) * 0.15;
        ids[i] = id;
      } else {
        const f = 1 + wn * 0.14 + 0.04 * fine[i];
        d[j] = grout[0] * f; d[j + 1] = grout[1] * f; d[j + 2] = grout[2] * f;
        Hn[i] = (0.3 + 0.15 * wn + 0.1 * fine[i]) * k; Rg[i] = 0.9 + wn * 0.05; ids[i] = 4;
      }
      d[j + 3] = 255;
    }
  }
  regionMatch(d, ids, [cols[0], cols[1], cols[2], cols[3], grout]);
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ TUMBLED PAVERS (canvas = 2.4 m, 16 rows) */
function genPaver(S, rnd, G) {
  const w = S, h = S, N = w * h, k = S / 1024, rows = 16, rh = S / rows, jt = 3 * k, rc = 7 * k, bev = 11 * k;
  const pal = ['#c9cbcd', '#dccdb0', '#e8dfcd', '#b4b9bf', '#d2c2a4', '#bfc3c8', '#e3d6bd'].map(hex), joint = hex('#8f8b84');
  const segOf = new Int32Array(rows * w), pav = [];
  for (let r = 0; r < rows; r++) {
    const ws = cyclicWidths(w, 60 * k, 128 * k, rnd); let x0 = Math.floor(rnd() * w);
    for (const pw of ws) {
      const id = pav.length;
      pav.push({ x0: x0, w: pw, c: Math.floor(rnd() * pal.length), alt: Math.floor(rnd() * pal.length), tx: rnd() * 2 - 1, ty: rnd() * 2 - 1, mix: 0.12 + rnd() * 0.2 });
      for (let x = x0; x < x0 + pw; x++) segOf[r * w + wrapI(x, w)] = id;
      x0 += pw;
    }
  }
  const mott = fbm(w, h, 12, 12, 4, rnd, 0.5), fine = fbm(w, h, 128, 128, 2, rnd, 0.5), en = fbm(w, h, 48, 48, 3, rnd, 0.5);
  // chips / pockmarks
  const C = new Float32Array(N), nC = Math.round(900 * k * k);
  for (let p = 0; p < nC; p++) {
    const r = (1 + Math.pow(rnd(), 2) * 4) * k, r2 = r * r, dep = 0.4 + rnd() * 0.8;
    forDisc(w, h, rnd() * w, rnd() * h, r, true, true, (i, dx, dy) => { const q = 1 - (dx * dx + dy * dy) / r2; if (q > 0) { const v = dep * Math.sqrt(q); if (v > C[i]) C[i] = v; } });
  }
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N), ids = new Int32Array(N);
  const jid = pav.length;
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor(y / rh)), ly = y + 0.5 - r * rh;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, wn = rnd() - 0.5, p = pav[segOf[r * w + x]];
      let lx = x - p.x0; if (lx < 0) lx += w; lx += 0.5;
      const qx = Math.abs(lx - p.w / 2) - (p.w / 2 - jt - rc), qy = Math.abs(ly - rh / 2) - (rh / 2 - jt - rc);
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
      const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rc + en[i] * 3.2 * k;
      if (sd < 0) {
        const e = ss(0, bev, -sd), prof = Math.sqrt(e);
        Hn[i] = (1.2 + 3 * prof + 0.5 * (p.tx * (lx / p.w - 0.5) + p.ty * (ly / rh - 0.5)) + 0.35 * mott[i] + 0.15 * fine[i] - 0.9 * C[i]) * k;
        const a = pal[p.c], b = pal[p.alt], m = clamp(0.5 + mott[i] * 1.6, 0, 1) * p.mix;
        const s = rnd(); let fl = s < 0.02 ? -26 : s > 0.985 ? 22 : 0; fl += wn * 14;
        const f = 1 - 0.05 * (1 - e) - 0.07 * C[i];
        d[j] = (a[0] + (b[0] - a[0]) * m) * f + fl; d[j + 1] = (a[1] + (b[1] - a[1]) * m) * f + fl; d[j + 2] = (a[2] + (b[2] - a[2]) * m) * f + fl;
        Rg[i] = 0.8 + 0.06 * fine[i] + 0.05 * (1 - e) + 0.06 * C[i];
        ids[i] = segOf[r * w + x];
      } else {
        const s = rnd(), f = 1 + wn * 0.22 + (s < 0.05 ? -0.12 : s > 0.95 ? 0.12 : 0);
        d[j] = joint[0] * f; d[j + 1] = joint[1] * f; d[j + 2] = joint[2] * f;
        Hn[i] = (0.4 + 0.35 * wn + 0.2 * fine[i]) * k; Rg[i] = 0.96; ids[i] = jid;
      }
      d[j + 3] = 255;
    }
  }
  const targets = pav.map(p => pal[p.c]); targets.push(joint);
  regionMatch(d, ids, targets);
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ SOIL CROSS-SECTION (2 m x 1.1 m, top = ground) */
function genLayer(HH, rnd, G) {
  const h = HH, w = HH >> 1, N = w * h, u = h / 512;
  const B0 = Math.round(14 * u), B1 = Math.round(62 * u), B2 = Math.round(128 * u), B3 = Math.round(196 * u);
  const C = [hex('#d4cbbb'), hex('#a7a29a'), hex('#8b867d'), hex('#c7a874')], S0 = hex('#6e4c31'), S1 = hex('#3e2a1c'), J = hex('#8f8b84');
  const soilAt = y => { const t = clamp((y - B3) / (h - 1 - B3), 0, 1); return [S0[0] + (S1[0] - S0[0]) * t, S0[1] + (S1[1] - S0[1]) * t, S0[2] + (S1[2] - S0[2]) * t]; };
  const wb2 = fbm(w, 1, 5, 1, 4, rnd), wb3 = fbm(w, 1, 4, 1, 4, rnd);
  const yb2 = new Float32Array(w), yb3 = new Float32Array(w);
  for (let x = 0; x < w; x++) { yb2[x] = B2 + wb2[x] * 4 * u; yb3[x] = B3 + wb3[x] * 4 * u; }
  // paver joints seen in section
  const jd = new Float32Array(w).fill(1e9);
  { const pxm = w / 2, ws = cyclicWidths(w, 0.15 * pxm, 0.3 * pxm, rnd); let x = Math.floor(rnd() * w);
    for (const L of ws) { for (let dx = -8; dx <= 8; dx++) { const xx = wrapI(x + dx, w); jd[xx] = Math.min(jd[xx], Math.abs(dx)); } x += L; } }
  const n1 = fbm(w, h, 8, 16, 5, rnd, 0.55), n2 = fbm(w, h, 32, 64, 3, rnd, 0.5);
  const band = new Uint8Array(N), R = new Float32Array(N), Gc = new Float32Array(N), Bc = new Float32Array(N), Hh = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const soil = soilAt(y), yc = y + 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, wn = rnd() - 0.5;
      let b, c, f, ht, rg;
      if (y < B0) b = 0; else if (y < B1) b = 1; else if (yc < yb2[x]) b = 2; else if (yc < yb3[x]) b = 3; else b = 4;
      if (b === 0) {
        const jdd = jd[x], e = ss(1.2 * u, 3.5 * u, jdd);
        c = jdd < 1.2 * u ? J : C[0]; f = 1 + 0.03 * n2[i] + wn * 0.05;
        ht = (e * 1.2 - 1.2) * u + 0.25 * u * n2[i]; rg = jdd < 1.2 * u ? 0.95 : 0.85;
      } else if (b === 1) {
        c = C[1]; f = 1 + 0.05 * n2[i] + 0.03 * n1[i] + wn * 0.07; ht = (0.35 * n2[i] + wn * 0.15) * u; rg = 0.9;
      } else if (b === 2) {
        c = C[2]; f = 0.72 + wn * 0.1; ht = (-1.5 + wn * 0.2) * u; rg = 0.95;
      } else if (b === 3) {
        const s = rnd(), lam = Math.sin(TAU * (3 * x / w) + (y / u) * 0.42 + n1[i] * 5);
        c = C[3]; f = 1 + 0.03 * n1[i] + 0.025 * lam + wn * 0.14 + (s < 0.02 ? -0.2 : s > 0.98 ? 0.15 : 0);
        ht = (wn * 0.35 + 0.3 * n2[i] + 0.12 * lam) * u; rg = 0.98;
      } else {
        c = soil; f = 1 + 0.14 * n1[i] + 0.06 * n2[i] + wn * 0.08; ht = (n1[i] * 3 + n2[i] * 1.2 + wn * 0.3) * u; rg = 1;
      }
      const bd = Math.min(Math.abs(yc - B0), Math.abs(yc - B1), Math.abs(yc - yb2[x]), Math.abs(yc - yb3[x]));
      if (bd < 0.9 * u) { f *= 0.82; ht -= 0.5 * u; }
      R[i] = c[0] * f; Gc[i] = c[1] * f; Bc[i] = c[2] * f; Hh[i] = ht; Rg[i] = rg; band[i] = b;
    }
  }
  // rounded stones with z-buffered height (later/higher stones occlude), light from upper-left, rim occlusion
  function stone(cx, cy, rx, ry, rot, col, hAmp, hBase, bid, shade, lump, rgv) {
    const ca = Math.cos(rot), sa = Math.sin(rot), rm = Math.max(rx, ry) * (1 + lump) + 1, lim = (1 + lump) * (1 + lump);
    const p1 = rnd() * TAU, p2 = rnd() * TAU;
    const x0 = Math.floor(cx - rm), x1 = Math.ceil(cx + rm), y0 = Math.max(0, Math.floor(cy - rm)), y1 = Math.min(h - 1, Math.ceil(cy + rm));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const i = y * w + wrapI(x, w); if (band[i] !== bid) continue;
        const dx = x + 0.5 - cx, lx = (dx * ca + dy * sa) / rx, ly = (-dx * sa + dy * ca) / ry;
        let q = lx * lx + ly * ly; if (q > lim) continue;
        if (lump > 0) { const an = Math.atan2(ly, lx), rad = 1 + lump * (0.6 * Math.sin(3 * an + p1) + 0.4 * Math.sin(5 * an + p2)); q /= rad * rad; }
        if (q >= 1) continue;
        const z = Math.sqrt(1 - q), hv = hBase + hAmp * z;
        if (hv <= Hh[i]) continue;
        const nx = lx * ca - ly * sa, ny = lx * sa + ly * ca;
        const lam = -0.45 * nx - 0.55 * ny + 0.7 * z;
        const sh = 1 + shade * (lam - 0.55) - 0.3 * shade * (1 - z);
        R[i] = col[0] * sh; Gc[i] = col[1] * sh; Bc[i] = col[2] * sh; Hh[i] = hv; Rg[i] = rgv;
      }
    }
  }
  // concrete: coarse + fine aggregate, air voids
  for (let s = 0; s < Math.round(300 * u * u / 4); s++) {
    const r = (1.2 + rnd() * 2.8) * u, v = 115 + rnd() * 100, t = (rnd() - 0.5) * 24;
    stone(rnd() * w, B0 + rnd() * (B1 - B0), r * (0.8 + rnd() * 0.4), r * (0.7 + rnd() * 0.4), rnd() * TAU, [v + t, v - 4, v - 12 - t * 0.5], 0.35 * r, 0, 1, 0.18, 0.15, 0.8);
  }
  for (let s = 0; s < Math.round(500 * u * u / 4); s++) {
    const r = (0.5 + rnd() * 0.8) * u, v = 110 + rnd() * 110;
    stone(rnd() * w, B0 + rnd() * (B1 - B0), r, r, 0, [v, v - 3, v - 9], 0.3 * r, 0, 1, 0.1, 0, 0.85);
  }
  for (let s = 0; s < Math.round(140 * u * u / 4); s++) {
    const r = (0.6 + rnd() * 1.3) * u, r2 = r * r;
    forDisc(w, h, rnd() * w, B0 + 2 + rnd() * (B1 - B0 - 4), r, true, false, (i, dx, dy) => {
      if (band[i] !== 1) return; const q = 1 - (dx * dx + dy * dy) / r2; if (q <= 0) return;
      const f = 1 - 0.5 * Math.sqrt(q); R[i] *= f; Gc[i] *= f; Bc[i] *= f; Hh[i] -= 1.2 * u * Math.sqrt(q); Rg[i] = 1;
    });
  }
  // gravel: dense rounded stones
  for (let s = 0; s < Math.round(900 * u * u / 4); s++) {
    const rx = (2 + rnd() * 3) * u, ry = (1.5 + rnd() * 2.5) * u, v = 80 + rnd() * 110;
    stone(rnd() * w, B1 + rnd() * (B2 + 4 * u - B1), rx, ry, rnd() * TAU, [v, v - 4, v - 10], 0.7 * ry, -1.5 * u, 2, 0.3, 0.12, 0.62 + rnd() * 0.18);
  }
  // soil pebbles, partly embedded
  for (let s = 0; s < 80; s++) {
    const rx = (3 + rnd() * 7) * u, ry = (2 + rnd() * 5) * u, v = 90 + rnd() * 60, cx = rnd() * w, cy = B3 + 8 * u + rnd() * (h - B3 - 12 * u);
    const hb = Hh[clamp(Math.floor(cy), 0, h - 1) * w + wrapI(Math.floor(cx), w)];
    stone(cx, cy, rx, ry, rnd() * TAU, [v, v - 6, v - 14], 0.6 * ry, hb - 0.2 * ry, 4, 0.3, 0.18, 0.8);
  }
  // roots and worm burrows (accumulated, then applied once)
  const RA = new Float32Array(N), RS = new Float32Array(N), RH = new Float32Array(N), BW = new Float32Array(N), BR = new Float32Array(N);
  const rootSeg = (ax, ay, bx, by, r0, r1) => forCapsule(w, h, ax, ay, bx, by, r0, r1, true, (i, dist, r) => {
    if (dist >= r) return; const core = 1 - (dist / r) * (dist / r);
    const a = 0.55 * Math.min(1, core * 2.5); if (a > RA[i]) { RA[i] = a; RS[i] = 0.85 + 0.3 * Math.sqrt(core); }
    const hv = r * 0.8 * Math.sqrt(core); if (hv > RH[i]) RH[i] = hv;
  });
  function rootPath(x, y, r, steps, dxm, dy0, dy1, branches) {
    for (let k = 0; k < steps; k++) {
      const nx = x + (rnd() * 2 - 1) * dxm * u, ny = y + (dy0 + rnd() * (dy1 - dy0)) * u, nr = Math.max(0.3 * u, r * 0.86);
      rootSeg(x, y, nx, ny, r, nr);
      if (branches > 0 && rnd() < 0.3) { rootPath(nx, ny, nr * 0.6, 4, 10, 4, 14, 0); branches--; }
      x = nx; y = ny; r = nr; if (y > h) break;
    }
  }
  for (let i = 0; i < 10; i++) rootPath(rnd() * w, (200 + rnd() * 60) * u, (0.6 + rnd() * 1.0) * u, 8, 14, 6, 22, 3);
  for (let i = 0; i < 45; i++) rootPath(rnd() * w, B3 + rnd() * 160 * u, (0.25 + rnd() * 0.25) * u, 3, 6, 2, 8, 0);
  for (let b = 0; b < 26; b++) {
    let x = rnd() * w, y = B3 + 14 * u + rnd() * (h - B3 - 24 * u), a = rnd() * TAU; const r = (1.2 + rnd() * 1.0) * u, steps = 6 + Math.floor(rnd() * 9);
    for (let k = 0; k < steps; k++) {
      a += (rnd() - 0.5) * 1.2; const nx = x + Math.cos(a) * (3 + rnd() * 3) * u, ny = clamp(y + Math.sin(a) * (3 + rnd() * 3) * u, B3 + 8 * u, h - 4 * u);
      forCapsule(w, h, x, y, nx, ny, r + 1.4 * u, r + 1.4 * u, true, (i, dist) => {
        if (dist < r) { const q = Math.sqrt(1 - (dist / r) * (dist / r)); if (q > BW[i]) BW[i] = q; }
        else if (dist < r + 1.4 * u) { const q = 1 - (dist - r) / (1.4 * u); if (q > BR[i]) BR[i] = q; }
      });
      x = nx; y = ny;
    }
  }
  const rootC = [150, 115, 80];
  for (let i = 0; i < N; i++) {
    const b = band[i]; if (b < 3) continue;
    if (BR[i] > 0 && BW[i] === 0) { const f = 1 + 0.1 * BR[i]; R[i] *= f; Gc[i] *= f; Bc[i] *= f; Hh[i] += 0.3 * u * BR[i]; }
    if (BW[i] > 0) { const f = 1 - 0.35 * BW[i]; R[i] *= f; Gc[i] *= f; Bc[i] *= f; Hh[i] -= 2.2 * u * BW[i]; Rg[i] = 1; }
    if (RA[i] > 0 && b === 4) { const a = RA[i], s = RS[i]; R[i] += (rootC[0] * s - R[i]) * a; Gc[i] += (rootC[1] * s - Gc[i]) * a; Bc[i] += (rootC[2] * s - Bc[i]) * a; Hh[i] += RH[i]; Rg[i] = 0.85; }
  }
  const img = G.createImageData(w, h), d = img.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) { const g = (rnd() - 0.5) * 18; d[j] = R[i] + g; d[j + 1] = Gc[i] + g; d[j + 2] = Bc[i] + g; d[j + 3] = 255; }
  // keep band averages on the original colours
  const ids = new Int32Array(N); for (let i = 0; i < N; i++) ids[i] = band[i] < 4 ? band[i] : -1;
  regionMatch(d, ids, [C[0], C[1], C[2], C[3]]);
  const diff = new Float32Array(h * 3), cnt = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let x = 0; x < w; x++) { const i = y * w + x; if (band[i] !== 4) continue; const j = i << 2; r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
    if (n) { const t = soilAt(y); diff[y * 3] = t[0] - r / n; diff[y * 3 + 1] = t[1] - g / n; diff[y * 3 + 2] = t[2] - b / n; cnt[y] = n; }
  }
  const win = Math.round(12 * u);
  for (let y = 0; y < h; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = Math.max(0, y - win); k <= Math.min(h - 1, y + win); k++) if (cnt[k]) { r += diff[k * 3] * cnt[k]; g += diff[k * 3 + 1] * cnt[k]; b += diff[k * 3 + 2] * cnt[k]; n += cnt[k]; }
    if (!n) continue; r /= n; g /= n; b /= n;
    for (let x = 0; x < w; x++) { const i = y * w + x; if (band[i] !== 4) continue; const j = i << 2; d[j] += r; d[j + 1] += g; d[j + 2] += b; }
  }
  return { color: img, normal: normalImage(G, Hh, w, h, 1, true, false), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ ARCHITECTURAL SHINGLES (canvas = 2.2 m) */
function genShingle(S, rnd, G) {
  // 23 courses so the texture wraps vertically (old: 22px rows of 512 = 23.27 rows, i.e. +1.2% course height)
  const w = S, h = S, N = w * h, u = S / 512, nr = 23, rh = h / nr, base = hex('#24272b');
  const tabOf = new Int32Array(nr * w), tabs = [];
  for (let r = 0; r < nr; r++) {
    const ws = cyclicWidths(w, 22 * u, 46 * u, rnd); let x0 = Math.floor(rnd() * w);
    for (const tw of ws) {
      const v = Math.floor(44 + rnd() * 38);
      tabs.push({ x0: x0, w: tw, v: v, thick: v >= 60 ? 0.8 : 0.25 + rnd() * 0.2 });
      for (let x = x0; x < x0 + tw; x++) tabOf[r * w + wrapI(x, w)] = tabs.length - 1;
      x0 += tw;
    }
  }
  const streak = fbm(w, h, 6, 6, 4, rnd, 0.5);
  const bw = w >> 1, bh = h >> 1, blk = new Float32Array(bw * bh);
  for (let i = 0; i < blk.length; i++) blk[i] = rnd() - 0.5;
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  const hs = u / 2;
  for (let y = 0; y < h; y++) {
    const r = Math.min(nr - 1, Math.floor(y / rh)), lr = (y + 0.5 - r * rh) / rh * 22;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, t = tabs[tabOf[r * w + x]];
      let lx = x - t.x0; if (lx < 0) lx += w; const lxo = (lx + 0.5) / u, two = t.w / u;
      const inTab = lr >= 1 && lr < 21 && lxo >= 1 && lxo <= two - 1;
      let cr, cg, cb;
      if (inTab) { cr = t.v; cg = t.v + 2; cb = t.v + 6; } else { cr = base[0]; cg = base[1]; cb = base[2]; }
      if (lr >= 18) { cr *= 0.6; cg *= 0.6; cb *= 0.6; }
      const wn = rnd() - 0.5, bk = blk[(y >> 1) * bw + (x >> 1)], s = rnd();
      const gr = bk * 16 + wn * 14 + (s < 0.012 ? -22 : s > 0.988 ? 34 : 0);
      const f = 1 + 0.04 * streak[i];
      d[j] = cr * f + gr; d[j + 1] = cg * f + gr; d[j + 2] = cb * f + gr; d[j + 3] = 255;
      let ht;
      if (inTab) ht = 0.6 + 1.6 * (lr / 21) + t.thick; else ht = 0.4 + 0.6 * (lr / 22);
      ht += bk * 0.35 + wn * 0.2;
      Hn[i] = ht * hs;
      Rg[i] = inTab ? 0.84 + wn * 0.12 : 0.9;
    }
  }
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ WEATHERED TEAK */
function genTeak(rnd, G) {
  const w = 512, h = 1024, N = w * h, NL = 180, base = hex('#a08b72'), target = [154, 133, 109];
  const warp = fbm(w, h, 3, 2, 4, rnd, 0.5), fig = fbm(w, h, 6, 3, 4, rnd, 0.5), fine = fbm(w, h, 128, 16, 3, rnd, 0.5), weath = fbm(w, h, 16, 8, 4, rnd, 0.5);
  const la = new Float32Array(NL), lw = new Float32Array(NL), lc = [];
  for (let n = 0; n < NL; n++) { la[n] = 0.12 + rnd() * 0.23; lw[n] = 0.05 + rnd() * 0.09; lc.push([70 + rnd() * 40, 55 + rnd() * 30, 40 + rnd() * 25]); }
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2;
    const gx = x + warp[i] * 40 + fig[i] * 8, sv = gx * NL / w, li = Math.floor(sv), fr = sv - li, idx = wrapI(li, NL);
    const dd = (fr - 0.5) / lw[idx], prof = Math.exp(-0.5 * dd * dd), a = la[idx] * prof, c = lc[idx];
    const wn = rnd() - 0.5, pore = fine[i] < -0.32 ? 0.06 : 0;
    const f = (1 + 0.05 * weath[i] + 0.03 * fine[i] - pore) ;
    d[j] = (base[0] * (1 - a) + c[0] * a) * f + wn * 14; d[j + 1] = (base[1] * (1 - a) + c[1] * a) * f + wn * 14; d[j + 2] = (base[2] * (1 - a) + c[2] * a) * f + wn * 14; d[j + 3] = 255;
    Hn[i] = prof * la[idx] * 4 + fine[i] * 0.4 + wn * 0.1 - pore * 3;
    Rg[i] = 0.74 + 0.08 * prof - 0.04 * weath[i] + 0.05 * pore;
  }
  // weather checks along the grain
  for (let c = 0; c < 26; c++) {
    const x0 = rnd() * w, y0 = Math.floor(rnd() * h), len = 40 + Math.floor(rnd() * 120), wmax = 0.6 + rnd() * 1.0;
    const w0 = warp[y0 * w + Math.floor(x0)];
    for (let k = 0; k < len; k++) {
      const yy = wrapI(y0 + k, h), tp = Math.sin(Math.PI * k / len), wd = wmax * tp;
      const xx = x0 - (warp[yy * w + wrapI(Math.floor(x0), w)] - w0) * 40;
      for (let o = -2; o <= 2; o++) {
        const px = Math.floor(xx) + o, cov = clamp(wd + 0.5 - Math.abs(px + 0.5 - xx), 0, 1); if (cov <= 0) continue;
        const i = yy * w + wrapI(px, w), j = i << 2, f = 1 - 0.45 * cov;
        d[j] *= f; d[j + 1] *= f; d[j + 2] *= f; Hn[i] -= 1.5 * cov; Rg[i] = Math.max(Rg[i], 0.9);
      }
    }
  }
  shiftMean(d, target);
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ CARVED PLAQUE (not tiled) */
function genPlaque(rnd, G) {
  const w = 512, h = 384, N = w * h, cx = 256, cy = 192, base = hex('#4a3a2c'), grooveC = [20, 14, 10], lightC = [130, 105, 80];
  const warp = fbm(w, h, 2, 3, 4, rnd, 0.5), fine = fbm(w, h, 16, 96, 2, rnd, 0.5);
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), wn = rnd() - 0.5;
    // same rings as the original (x2): dark grooves r=40+28n (w10), light beads r=54+28n (w4), r<180
    let gcov = 0, lcov = 0;
    if (r < 186) {
      const gn = Math.round((r - 40) / 28); if (gn >= 0 && gn <= 4) gcov = clamp(5.5 - Math.abs(r - (40 + 28 * gn)), 0, 1);
      const ln = Math.round((r - 54) / 28); if (ln >= 0 && ln <= 4) lcov = clamp(2.5 - Math.abs(r - (54 + 28 * ln)), 0, 1);
    }
    const gy = y + warp[i] * 30, gs = Math.sin(gy * 0.9 + fine[i] * 3);
    const f = 1 + 0.05 * gs + 0.04 * fine[i];
    let cr = base[0] * f, cg = base[1] * f, cb = base[2] * f;
    const ga = 0.75 * gcov; cr += (grooveC[0] - cr) * ga; cg += (grooveC[1] - cg) * ga; cb += (grooveC[2] - cb) * ga;
    const la = 0.6 * lcov; cr += (lightC[0] - cr) * la; cg += (lightC[1] - cg) * la; cb += (lightC[2] - cb) * la;
    d[j] = cr + wn * 24; d[j + 1] = cg + wn * 24; d[j + 2] = cb + wn * 24; d[j + 3] = 255;
    let ht;
    if (r < 30) ht = 0.81 + 0.3 * (1 - (r / 30) * (r / 30));
    else { const bead = 0.5 - 0.5 * Math.cos(TAU * (r - 40) / 28), bl = ss(166, 178, r); ht = bead * (1 - bl) + 0.6 * bl; }
    Hn[i] = ht * 4 + 0.15 * gs + 0.1 * fine[i];
    Rg[i] = 0.78 + 0.12 * gcov - 0.12 * lcov + wn * 0.04;
  }
  return { color: img, normal: normalImage(G, Hn, w, h, 1, false, false), rough: grayImage(G, Rg, w, h) };
}

/* ------------------------------------------------------------------ UPHOLSTERY WEAVE (repeat 4,4) */
function genFabric(rnd, G) {
  const w = 512, h = 512, N = w * h, nT = 128, base = hex('#2c323d'), target = [45, 51, 62];
  const sw = new Float32Array(nT), sf = new Float32Array(nT), rowL = new Float32Array(nT), colD = new Float32Array(nT);
  for (let t = 0; t < nT; t++) { sw[t] = 0.85 + rnd() * 0.3; sf[t] = 0.85 + rnd() * 0.3; rowL[t] = 0.01 + rnd() * 0.03; colD[t] = 0.03 + rnd() * 0.05; }
  const aW = fbm(w, h, 128, 8, 2, rnd, 0.5), aF = fbm(w, h, 8, 128, 2, rnd, 0.5), hz = fbm(w, h, 16, 16, 3, rnd, 0.5);
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const jy = y >> 2, fy = ((y & 3) + 0.5) / 4;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, jj = i << 2, ix = x >> 2, fx = ((x & 3) + 0.5) / 4;
      const hw = 0.5 + 0.5 * Math.cos(Math.PI * ((y + 0.5) / 4 - 0.5 + ix));
      const hf = 0.5 + 0.5 * Math.cos(Math.PI * ((x + 0.5) / 4 - 0.5 + jy + 1));
      const Hw = 0.6 * hw + 0.5 * Math.sin(Math.PI * fx) * (sw[ix] + 0.1 * aW[i]);
      const Hf = 0.6 * hf + 0.5 * Math.sin(Math.PI * fy) * (sf[jy] + 0.1 * aF[i]);
      const top = Math.max(Hw, Hf), ao = 0.85 + 0.15 * top / 1.15, wn = (rnd() - 0.5) * 8;
      let cr, cg, cb;
      if (Hw >= Hf) { const f = (1 - colD[ix] * 0.8 + 0.05 * aW[i]) * ao; cr = base[0] * f; cg = base[1] * f; cb = base[2] * f; }
      else { const a = rowL[jy] * 0.8 + 0.01 * aF[i]; cr = (base[0] + a * (255 - base[0])) * ao; cg = (base[1] + a * (255 - base[1])) * ao; cb = (base[2] + a * (255 - base[2])) * ao; }
      const hf2 = 1 + 0.03 * hz[i];
      d[jj] = cr * hf2 + wn; d[jj + 1] = cg * hf2 + wn; d[jj + 2] = cb * hf2 + wn; d[jj + 3] = 255;
      Hn[i] = top;
    }
  }
  shiftMean(d, target);
  return { color: img, normal: normalImage(G, Hn, w, h, 0.9, true, true) };
}

/* ------------------------------------------------------------------ WICKER (alpha lattice, over-under weave) */
function genWicker(rnd, G) {
  const w = 512, h = 512, N = w * h, P = w / 9, hwO = 9, hwI = 5.5, dark = hex('#7a6d5a'), tan = hex('#c4b6a0');
  const fib = fbm(w, h, 64, 64, 2, rnd, 0.5);
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, a = x - y, b = x + y + 1;
    const ia = Math.floor(a / P), fa = a / P - ia, da = (fa - 0.5) * P / Math.SQRT2;
    const ib = Math.floor(b / P), fb = b / P - ib, db = (fb - 0.5) * P / Math.SQRT2;
    const adA = Math.abs(da), adB = Math.abs(db);
    let best = -1e9, dist = 1e9, sd = 0;
    if (adA < hwO + 0.7) { const pr = Math.sqrt(Math.max(0, 1 - (adA / hwO) * (adA / hwO))); const H = pr * hwO * 0.55 + 2.2 * Math.cos(Math.PI * (b / P - 0.5 + ia)); if (H > best) { best = H; dist = adA; sd = da; } }
    if (adB < hwO + 0.7) { const pr = Math.sqrt(Math.max(0, 1 - (adB / hwO) * (adB / hwO))); const H = pr * hwO * 0.55 - 2.2 * Math.cos(Math.PI * (a / P - 0.5 + ib)); if (H > best) { best = H; dist = adB; sd = db; } }
    if (dist < 1e8) {
      const core = 1 - ss(hwI - 0.8, hwI + 0.8, dist), stri = 1 + 0.045 * Math.sin(sd * 2.7 + fib[i] * 4) + 0.03 * fib[i];
      const ao = 0.82 + 0.18 * clamp((best + 2.2) / (hwO * 0.55 + 4.4), 0, 1), f = stri * ao;
      d[j] = (dark[0] + (tan[0] - dark[0]) * core) * f; d[j + 1] = (dark[1] + (tan[1] - dark[1]) * core) * f; d[j + 2] = (dark[2] + (tan[2] - dark[2]) * core) * f;
      d[j + 3] = clamp(hwO + 0.5 - dist, 0, 1) * 255; Hn[i] = best;
    } else { d[j] = dark[0]; d[j + 1] = dark[1]; d[j + 2] = dark[2]; d[j + 3] = 0; Hn[i] = -3; }
  }
  return { color: img, normal: normalImage(G, Hn, w, h, 1, true, true) };
}

/* ------------------------------------------------------------------ helpers for drawn (canvas-API) patterns */
/* fuzzy re-sampling of a drawn image (pile / hair edges); per-pixel jitter in px */
function fuzzSample(src, w, h, jx, jy, wrap, rnd) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sx = x + Math.round((rnd() - 0.5) * 2 * jx), sy = y + Math.round((rnd() - 0.5) * 2 * jy);
    if (wrap) { sx = wrapI(sx, w); sy = wrapI(sy, h); } else { sx = clamp(sx, 0, w - 1); sy = clamp(sy, 0, h - 1); }
    const j = (y * w + x) << 2, k = (sy * w + sx) << 2;
    out[j] = src[k]; out[j + 1] = src[k + 1]; out[j + 2] = src[k + 2]; out[j + 3] = src[k + 3];
  }
  return out;
}
const lum = (d, j) => 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

/* ------------------------------------------------------------------ TRELLIS RUG (wool pile) */
function genRug(rnd, G) {
  const w = 1024, h = 768, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#6a4f3d'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e6d8bd'; g.lineWidth = 9;
  for (let i = -1; i < 11; i++) for (let j = -1; j < 9; j++) {
    g.beginPath(); g.arc(i * 112, j * 112, 56, 0, 7); g.stroke();
    g.beginPath(); g.arc(i * 112 + 56, j * 112 + 56, 56, 0, 7); g.stroke();
  }
  g.lineWidth = 26; g.strokeStyle = '#6a4f3d'; g.strokeRect(13, 13, 998, 742); g.lineWidth = 8; g.strokeStyle = '#e6d8bd'; g.strokeRect(34, 34, 956, 700);
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const fz = fuzzSample(src, w, h, 1.3, 1.3, false, rnd);
  const pile = fbm(w, h, 256, 192, 2, rnd, 0.5), ab = fbm(w, h, 2, 24, 3, rnd, 0.5), mo = fbm(w, h, 16, 12, 3, rnd, 0.5);
  const lB = 0.299 * 106 + 0.587 * 79 + 0.114 * 61, lC = 0.299 * 230 + 0.587 * 216 + 0.114 * 189;
  const img = g.createImageData(w, h), d = img.data, Hr = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, wn = rnd() - 0.5;
    const knot = 0.97 + 0.03 * Math.cos(TAU * x / 3) * Math.cos(TAU * y / 3);
    const f = knot * (1 + 0.05 * pile[i] + 0.025 * ab[i] + 0.02 * mo[i]);
    d[j] = fz[j] * f + wn * 26; d[j + 1] = fz[j + 1] * f + wn * 26; d[j + 2] = fz[j + 2] * f + wn * 26; d[j + 3] = 255;
    const cream = clamp((lum(fz, j) - lB) / (lC - lB), 0, 1);
    Hr[i] = 0.9 * pile[i] + wn * 0.5 + cream * 0.6 + 0.2 * mo[i];
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, boxBlur(Hr, w, h, 1, false, false), w, h, 1.5, false, false) };
}

/* ------------------------------------------------------------------ FADED VINTAGE RUNNER */
function genVintage(rnd, G) {
  const s = 1.5, w = 768, h = 480, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#9a8f93'; g.fillRect(0, 0, w, h);
  const cols = ['rgba(180,150,160,.35)', 'rgba(110,100,110,.3)', 'rgba(210,200,195,.3)'];
  for (let i = 0; i < 120; i++) {
    const x = rnd() * w, y = rnd() * h, r = (10 + rnd() * 40) * s, gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, cols[Math.floor(rnd() * cols.length)]); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // faint ghost lattice in the same palette (worn-away pattern)
  g.strokeStyle = 'rgba(110,100,110,.10)'; g.lineWidth = 3;
  for (let i = -h; i < w + h; i += 48) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  g.strokeStyle = 'rgba(120,90,100,.6)'; g.lineWidth = 10 * s; g.strokeRect(18 * s, 18 * s, 476 * s, 284 * s);
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const fz = fuzzSample(src, w, h, 1, 1, false, rnd);
  const wear = fbm(w, h, 6, 4, 4, rnd, 0.55), pile = fbm(w, h, 192, 120, 2, rnd, 0.5), ab = fbm(w, h, 2, 16, 3, rnd, 0.5);
  const img = g.createImageData(w, h), d = img.data, Hr = new Float32Array(N), lt = [210, 200, 195];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, wn = rnd() - 0.5;
    const worn = ss(0.05, 0.35, wear[i]), grid = ((x % 3) === 0 || (y % 4) === 0) ? 1 : 0, ga = worn * grid * 0.18;
    const f = 1 + 0.05 * pile[i] + 0.03 * ab[i] - 0.03 * worn;
    let cr = fz[j] * f, cg = fz[j + 1] * f, cb = fz[j + 2] * f;
    cr += (lt[0] - cr) * ga; cg += (lt[1] - cg) * ga; cb += (lt[2] - cb) * ga;
    d[j] = cr + wn * 30; d[j + 1] = cg + wn * 30; d[j + 2] = cb + wn * 30; d[j + 3] = 255;
    Hr[i] = (1 - worn) * (0.8 + 0.8 * pile[i]) + worn * 0.3 * grid + wn * 0.4;
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, boxBlur(Hr, w, h, 1, false, false), w, h, 1.2, false, false) };
}

/* ------------------------------------------------------------------ ZEBRA PRINT (hair) */
function genZebra(rnd, G) {
  const w = 512, h = 512, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#e7dfcf'; g.fillRect(0, 0, w, h); g.fillStyle = '#1d1b19';
  const xs = []; let x = 0; while (x < w) { xs.push(x); x += 36 + rnd() * 24; }
  const sc = w / x;
  for (const x0 of xs) {
    const xx = x0 * sc, sw = 10 + rnd() * 14, p1 = rnd() * TAU, p2 = p1 + (rnd() - 0.5) * 1.2;
    drawWrapped(w, h, (ox) => {
      g.beginPath(); g.moveTo(xx + ox + Math.sin(p1) * 20, 0);
      for (let y = 0; y <= h; y += 16) g.lineTo(xx + ox + Math.sin(TAU * 2 * y / h + p1) * 20, y);
      for (let y = h; y >= 0; y -= 16) g.lineTo(xx + ox + sw + Math.sin(TAU * 2 * y / h + p2) * 20, y);
      g.fill();
    });
  }
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const fz = fuzzSample(src, w, h, 1.6, 0.6, true, rnd);
  const hair = fbm(w, h, 128, 16, 3, rnd, 0.55), mo = fbm(w, h, 8, 8, 3, rnd, 0.5);
  const img = g.createImageData(w, h), d = img.data, Hr = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const wn = rnd() - 0.5, f = 1 + 0.06 * hair[i] + 0.03 * mo[i];
    d[j] = fz[j] * f + wn * 8; d[j + 1] = fz[j + 1] * f + wn * 8; d[j + 2] = fz[j + 2] * f + wn * 8; d[j + 3] = 255;
    Hr[i] = hair[i] * 1.6 + wn * 0.2;
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, Hr, w, h, 1, true, true) };
}

/* ------------------------------------------------------------------ TIGER PRINT (velvet) */
function genTiger(rnd, G) {
  const w = 512, h = 512, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#d9cfc0'; g.fillRect(0, 0, w, h); g.strokeStyle = '#4c4a4c'; g.lineWidth = 8; g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = rnd() * w, y = rnd() * h;
    drawWrapped(w, h, (ox, oy) => { g.beginPath(); g.moveTo(x + ox, y + oy); g.bezierCurveTo(x + ox + 40, y + oy - 60, x + ox + 80, y + oy + 60, x + ox + 140, y + oy - 20); g.stroke(); });
  }
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const fz = fuzzSample(src, w, h, 1, 1, true, rnd);
  const nap = fbm(w, h, 8, 8, 4, rnd, 0.55), fine = fbm(w, h, 128, 128, 2, rnd, 0.5);
  const img = g.createImageData(w, h), d = img.data, Hr = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const wn = rnd() - 0.5, f = 1 + 0.06 * nap[i] + 0.03 * fine[i];
    d[j] = fz[j] * f + wn * 6; d[j + 1] = fz[j + 1] * f + wn * 6; d[j + 2] = fz[j + 2] * f + wn * 6; d[j + 3] = 255;
    Hr[i] = nap[i] * 2 + fine[i] * 0.6 + wn * 0.15;
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, Hr, w, h, 1, true, true) };
}

/* ------------------------------------------------------------------ POLISHED GRANITE */
function genGranite(rnd, G) {
  const w = 512, h = 512, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#2a2119'; g.fillRect(0, 0, w, h);
  const bc = ['rgba(110,78,45,.5)', 'rgba(150,115,62,.4)', 'rgba(10,8,6,.6)', 'rgba(190,160,100,.25)'];
  for (let i = 0; i < 140; i++) {
    const x = rnd() * w, y = rnd() * h, r = 8 + rnd() * 62, col = bc[Math.floor(rnd() * bc.length)];
    drawWrapped(w, h, (ox, oy) => {
      const X = x + ox, Y = y + oy; if (X + r < 0 || X - r > w || Y + r < 0 || Y - r > h) return;
      const gr = g.createRadialGradient(X, Y, 0, X, Y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(X - r, Y - r, 2 * r, 2 * r);
    });
  }
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = `rgba(${200 + rnd() * 40 | 0},${180 + rnd() * 30 | 0},${120 + rnd() * 40 | 0},${(0.3 + rnd() * 0.4).toFixed(3)})`; g.lineWidth = 0.6 + rnd() * 1.8;
    const pts = []; let x = rnd() * w, y = rnd() * h; pts.push([x, y]);
    for (let k = 0; k < 20; k++) { x += -10 + rnd() * 40; y += -14 + rnd() * 28; pts.push([x, y]); }
    drawWrapped(w, h, (ox, oy) => { g.beginPath(); g.moveTo(pts[0][0] + ox, pts[0][1] + oy); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0] + ox, pts[k][1] + oy); g.stroke(); });
  }
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  // crystalline grains (wrapped jittered-grid Worley)
  const nc = 85, cs = w / nc, gx = new Float32Array(nc * nc), gy = new Float32Array(nc * nc), gt = new Uint8Array(nc * nc), gv = new Float32Array(nc * nc);
  for (let k = 0; k < nc * nc; k++) { gx[k] = rnd(); gy[k] = rnd(); const t = rnd(); gt[k] = t < 0.5 ? 0 : t < 0.72 ? 1 : t < 0.88 ? 2 : 3; gv[k] = rnd(); }
  const MIN = [[0, 0, 0], [8, 6, 4], [110, 78, 45], [190, 160, 100]], MA = [0, 0.4, 0.3, 0.25];
  const img = g.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, fx = (x + 0.5) / cs, fy = (y + 0.5) / cs, cx = Math.floor(fx), cy = Math.floor(fy);
    let d1 = 1e9, d2 = 1e9, best = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const kx = cx + ox, ky = cy + oy, k = wrapI(ky, nc) * nc + wrapI(kx, nc);
      const ddx = kx + gx[k] - fx, ddy = ky + gy[k] - fy, dd = ddx * ddx + ddy * ddy;
      if (dd < d1) { d2 = d1; d1 = dd; best = k; } else if (dd < d2) d2 = dd;
    }
    const edge = 1 - ss(0, 0.12, Math.sqrt(d2) - Math.sqrt(d1)), t = gt[best], a = MA[t] * (0.6 + 0.4 * gv[best]), m = MIN[t];
    let cr = src[j], cg = src[j + 1], cb = src[j + 2];
    cr += (m[0] - cr) * a; cg += (m[1] - cg) * a; cb += (m[2] - cb) * a;
    const ef = 1 - 0.12 * edge;
    d[j] = cr * ef + (rnd() - 0.5) * 20; d[j + 1] = cg * ef + (rnd() - 0.5) * 20; d[j + 2] = cb * ef + (rnd() - 0.5) * 20; d[j + 3] = 255;
    Hn[i] = -edge * 0.25 + (t === 3 ? 0.05 : 0);
    Rg[i] = 0.11 + 0.05 * gv[best] + 0.06 * edge + (t === 3 ? -0.03 : 0);
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, Hn, w, h, 1, true, true), rough: grayImage(g, Rg, w, h) };
}

/* ------------------------------------------------------------------ GLASS POOL MOSAIC (canvas = 0.8 m) */
function genPool(rnd, G) {
  const w = 512, h = 512, N = w * h, grout = hex('#c9d3d8');
  const mo = fbm(w, h, 16, 16, 3, rnd, 0.5), fine = fbm(w, h, 128, 128, 2, rnd, 0.5);
  const d = new Uint8ClampedArray(N * 4), Hn = new Float32Array(N), Rg = new Float32Array(N), ids = new Int32Array(N);
  const targets = [grout];
  function groutFill(y0, y1) {
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i << 2, wn = rnd() - 0.5, f = 1 + wn * 0.12 + 0.04 * fine[i];
      d[j] = grout[0] * f; d[j + 1] = grout[1] * f; d[j + 2] = grout[2] * f; d[j + 3] = 255;
      Hn[i] = 0.3 + wn * 0.25 + 0.15 * fine[i]; Rg[i] = 0.82 + wn * 0.06; ids[i] = 0;
    }
  }
  function chip(x0, y0, cw, ch, col) {
    const id = targets.length; targets.push(col);
    const rc = 4, bev = 4, gxv = (rnd() - 0.5) * 2, gyv = (rnd() - 0.5) * 2, tx = (rnd() - 0.5) * 0.5, ty = (rnd() - 0.5) * 0.5;
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) {
      const lx = x + 0.5 - x0, ly = y + 0.5 - y0;
      const qx = Math.abs(lx - cw / 2) - (cw / 2 - rc), qy = Math.abs(ly - ch / 2) - (ch / 2 - rc);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc;
      if (sd >= 0) continue;
      const i = y * w + x, j = i << 2, e = ss(0, bev, -sd), u = lx / cw - 0.5, v = ly / ch - 0.5, s = rnd();
      const f = 1 + 0.1 * (u * gxv + v * gyv) + 0.05 * mo[i] + 0.1 * (1 - e) + (s > 0.993 ? 0.35 : 0) + (rnd() - 0.5) * 0.05;
      d[j] = col[0] * f; d[j + 1] = col[1] * f; d[j + 2] = col[2] * f; d[j + 3] = 255;
      Hn[i] = 0.4 + 2.2 * Math.sqrt(e) + tx * u * 2 + ty * v * 2 + 0.08 * fine[i]; Rg[i] = 0.05 + 0.04 * rnd() + 0.1 * (1 - e); ids[i] = id;
    }
  }
  groutFill(0, h);
  for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 16; cy++) chip(cx * 32 + 2, cy * 32 + 2, 28, 28, hsl(200 + rnd() * 14, 45 + rnd() * 25, 14 + rnd() * 16));
  const make = (dd, ids2, tg) => { const img = G.createImageData(w, h); img.data.set(dd); regionMatch(img.data, ids2, tg); return img; };
  const pool = { color: make(d, ids, targets), normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
  // wall: waterline band (0-52), light row (54-82), then the thin dark course (84-94), regular grid below
  const band = hex('#d6dbdc'), bandId = targets.length; targets.push(band);
  groutFill(0, 98);
  for (let y = 0; y < 52; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, wn = rnd() - 0.5, f = 1 + 0.03 * mo[i] + wn * 0.03;
    d[j] = band[0] * f; d[j + 1] = band[1] * f; d[j + 2] = band[2] * f; d[j + 3] = 255;
    Hn[i] = 0.4 + 2.2 * Math.sqrt(ss(0, 4, 52 - (y + 0.5))) + 0.1 * mo[i]; Rg[i] = 0.14 + 0.04 * fine[i]; ids[i] = bandId;
  }
  for (let cx = 0; cx < 16; cx++) chip(cx * 32 + 2, 54, 28, 28, hsl(205, 30, 55 + rnd() * 15));
  for (let cx = 0; cx < 16; cx++) chip(cx * 32 + 2, 84, 28, 10, hsl(200 + rnd() * 14, 45 + rnd() * 25, 14 + rnd() * 16));
  const wall = { color: make(d, ids, targets), normal: normalImage(G, Hn, w, h, 1, true, true), rough: grayImage(G, Rg, w, h) };
  return { pool, wall };
}

/* ------------------------------------------------------------------ TRAVERTINE COPING (repeat 4,1) */
function genTrav(rnd, G) {
  const w = 512, h = 512, N = w * h, [c, g] = makeCanvas(w, h, true);
  g.fillStyle = '#e0d3bb'; g.fillRect(0, 0, w, h);
  const bc = ['rgba(190,170,130,.3)', 'rgba(255,250,240,.3)'];
  for (let i = 0; i < 60; i++) {
    const x = rnd() * w, y = rnd() * h, r = (5 + rnd() * 25) * 2, col = bc[Math.floor(rnd() * 2)];
    drawWrapped(w, h, (ox, oy) => {
      const X = x + ox, Y = y + oy; if (X + r < 0 || X - r > w || Y + r < 0 || Y - r > h) return;
      const gr = g.createRadialGradient(X, Y, 0, X, Y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(X - r, Y - r, 2 * r, 2 * r);
    });
  }
  const src = g.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const warp = fbm(w, h, 2, 6, 4, rnd, 0.5), mo = fbm(w, h, 8, 16, 4, rnd, 0.5), fine = fbm(w, h, 64, 128, 2, rnd, 0.5);
  const P = new Float32Array(N);
  for (let p = 0; p < 300; p++) {   // pits elongated along the bedding (x)
    const rx = 2 + Math.pow(rnd(), 1.6) * 10, ry = 1 + rnd() * 2.5, dep = 0.6 + rnd() * 0.4;
    forDisc(w, h, rnd() * w, rnd() * h, rx, true, true, (i, dx, dy) => { const q = 1 - dx * dx / (rx * rx) - dy * dy / (ry * ry); if (q > 0) { const v = dep * Math.sqrt(q); if (v > P[i]) P[i] = v; } });
  }
  const img = g.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N), pit = [168, 150, 120];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2, wn = rnd() - 0.5;
    const bd = Math.sin(TAU * 6 * y / h + warp[i] * 6), f = 1 + 0.025 * bd + 0.03 * mo[i] + wn * 0.035, pa = clamp(P[i] * 1.2, 0, 0.75);
    d[j] = src[j] * f * (1 - pa) + pit[0] * pa; d[j + 1] = src[j + 1] * f * (1 - pa) + pit[1] * pa; d[j + 2] = src[j + 2] * f * (1 - pa) + pit[2] * pa; d[j + 3] = 255;
    Hn[i] = 0.25 * bd + 0.3 * mo[i] + 0.1 * fine[i] - 2.4 * P[i] + wn * 0.1;
    Rg[i] = 0.64 + 0.05 * mo[i] + 0.3 * P[i];
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, Hn, w, h, 1, true, true), rough: grayImage(g, Rg, w, h) };
}

/* ------------------------------------------------------------------ NAVY HERRINGBONE GLAZED TILE (canvas = 0.6 m) */
function genHerring(rnd, G) {
  const w = 512, h = 512, N = w * h, [c, g] = makeCanvas(w, h, true), [hc, hg] = makeCanvas(w, h, true);
  g.fillStyle = '#a6a8ab'; g.fillRect(0, 0, w, h); hg.fillStyle = '#000'; hg.fillRect(0, 0, w, h);
  const hbw = 32, hbh = 10, colT = [];
  for (let k = 0; k < 128; k++) colT.push(`hsl(${(218 + rnd() * 12).toFixed(2)},${(18 + rnd() * 12).toFixed(2)}%,${(12 + rnd() * 10).toFixed(2)}%)`);
  g.save(); g.scale(2, 2); hg.save(); hg.scale(2, 2);
  for (let r = -4; r < 14; r++) for (let cc = -4; cc < 14; cc++) {
    const ox = cc * hbw, oy = r * hbw;
    for (let k = 0; k < 2; k++) {
      const col = colT[(wrapI(r, 8) * 8 + wrapI(cc, 8)) * 2 + k];
      for (const [G2, isH] of [[g, false], [hg, true]]) {
        G2.save(); G2.translate(ox + (k ? hbw / 2 : 0), oy + (k ? hbw / 2 : 0)); G2.rotate(k ? -Math.PI / 4 : Math.PI / 4);
        const rx = -hbw * 0.7, ry = -hbh / 2 + 0.8, rw = hbw * 1.4 - 1.6, rh = hbh - 1.6;
        if (isH) { G2.fillStyle = '#fff'; G2.fillRect(rx, ry, rw, rh); G2.strokeStyle = 'rgb(70,70,70)'; G2.lineWidth = 0.75; G2.strokeRect(rx, ry, rw, rh); }
        else { G2.fillStyle = col; G2.fillRect(rx, ry, rw, rh); }
        G2.restore();
      }
    }
  }
  g.restore(); hg.restore();
  const src = g.getImageData(0, 0, w, h).data, hs = hg.getImageData(0, 0, w, h).data, pre = meanRGB(src);
  const raw = new Float32Array(N); for (let i = 0; i < N; i++) raw[i] = hs[i << 2] / 255;
  const bl = boxBlur(boxBlur(raw, w, h, 1, true, true), w, h, 1, true, true);
  const wave = fbm(w, h, 6, 6, 4, rnd, 0.55);
  const img = g.createImageData(w, h), d = img.data, Hn = new Float32Array(N), Rg = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const wn = rnd() - 0.5, t = bl[i], tileM = ss(0.35, 0.75, raw[i]), edge = tileM * (1 - ss(0.55, 0.95, t));
    const f = 1 + tileM * (0.04 * wave[i]) + 0.12 * edge;
    d[j] = src[j] * f + wn * 14; d[j + 1] = src[j + 1] * f + wn * 14; d[j + 2] = src[j + 2] * f + wn * 14; d[j + 3] = 255;
    Hn[i] = t * 2.2 + tileM * 0.6 * wave[i] + (1 - tileM) * wn * 0.2;
    Rg[i] = tileM * (0.1 + 0.04 * wave[i]) + (1 - tileM) * 0.85;
  }
  shiftMean(d, pre);
  return { color: img, normal: normalImage(g, Hn, w, h, 1, true, true), rough: grayImage(g, Rg, w, h) };
}

/* ------------------------------------------------------------------ LATTICE TABLECLOTH (linen) */
function genCloth(rnd, G) {
  const w = 512, h = 512, N = w * h, bg = [241, 237, 228], ln = [142, 138, 134], nT = 128;
  const sl = new Float32Array(nT * 2); for (let k = 0; k < sl.length; k++) sl[k] = 0.85 + rnd() * 0.3;
  const slub = fbm(w, h, 64, 64, 2, rnd, 0.5);
  const img = G.createImageData(w, h), d = img.data, Hn = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = i << 2;
    const m1 = wrapI(x - y, 64), m2 = wrapI(x + y + 1, 64);
    const da = Math.min(m1, 64 - m1) / Math.SQRT2, db = Math.min(m2, 64 - m2) / Math.SQRT2;
    const cov = Math.max(clamp(3.5 - da, 0, 1), clamp(3.5 - db, 0, 1));
    const ix = x >> 2, jy = y >> 2, fx = ((x & 3) + 0.5) / 4, fy = ((y & 3) + 0.5) / 4;
    const Hw = 0.6 * (0.5 + 0.5 * Math.cos(Math.PI * ((y + 0.5) / 4 - 0.5 + ix))) + 0.5 * Math.sin(Math.PI * fx) * sl[ix];
    const Hf = 0.6 * (0.5 + 0.5 * Math.cos(Math.PI * ((x + 0.5) / 4 - 0.5 + jy + 1))) + 0.5 * Math.sin(Math.PI * fy) * sl[nT + jy];
    const top = Math.max(Hw, Hf), f = (0.95 + 0.05 * top / 1.15) * (1 + 0.02 * slub[i]) / 0.975, wn = (rnd() - 0.5) * 8;
    d[j] = (bg[0] + (ln[0] - bg[0]) * cov) * f + wn; d[j + 1] = (bg[1] + (ln[1] - bg[1]) * cov) * f + wn; d[j + 2] = (bg[2] + (ln[2] - bg[2]) * cov) * f + wn; d[j + 3] = 255;
    Hn[i] = top + 0.2 * slub[i];
  }
  return { color: img, normal: normalImage(G, Hn, w, h, 0.6, true, true) };
}

/* ------------------------------------------------------------------ INSECT SCREEN (same look, 4x resolution) */
function genScreen() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = 'rgba(120,114,100,.55)'; g.fillRect(0, 0, 256, 256); g.fillStyle = 'rgba(70,66,58,.45)';
  for (let i = 0; i < 256; i += 32) { g.fillRect(i, 0, 4, 256); g.fillRect(0, i, 256, 4); }
  return c;
}

/* ------------------------------------------------------------------ material suggestions */
// roughness values multiply the roughnessMap (green channel) when one is supplied; maps hold absolute roughness.
const TWEAKS = {
  stucco:  { tex: 'stuccoTex',   roughness: 1.0,  metalness: 0,    normalScale: 1.0, clearBump: true },
  trim:    { tex: 'stuccoTex',   roughness: 0.87, metalness: 0,    normalScale: 0.6 },
  tile:    { tex: 'tileTex',     roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  paver:   { tex: 'paverTex',    roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  layer:   { tex: 'layerTex',    roughness: 1.0,  metalness: 0,    normalScale: 1.2 },
  shingle: { tex: 'shingleTex',  roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  granite: { tex: 'graniteTex',  roughness: 1.0,  metalness: 0.05, normalScale: 0.3 },
  trav:    { tex: 'travTex',     roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  herring: { tex: 'herringTex',  roughness: 1.0,  metalness: 0.1,  normalScale: 0.8 },
  teak:    { tex: 'teakTex',     roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  plaque:  { tex: 'plaqueTex',   roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  fabric:  { tex: 'fabricTex',   roughness: 0.95, metalness: 0,    normalScale: 0.8 },
  black:   { tex: 'fabricTex',   roughness: 0.9,  metalness: 0,    normalScale: 0.8 },
  knit:    { tex: 'fabricTex',   roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  wicker:  { tex: 'wickerTex',   roughness: 0.85, metalness: 0,    normalScale: 1.0 },
  rug:     { tex: 'rugTex',      roughness: 1.0,  metalness: 0,    normalScale: 1.0 },
  vintage: { tex: 'vintageTex',  roughness: 1.0,  metalness: 0,    normalScale: 0.8 },
  zebra:   { tex: 'zebraTex',    roughness: 0.9,  metalness: 0,    normalScale: 0.6 },
  tiger:   { tex: 'tigerTex',    roughness: 0.95, metalness: 0,    normalScale: 0.5 },
  cloth:   { tex: 'clothTex',    roughness: 0.95, metalness: 0,    normalScale: 0.5 },
  screen:  { tex: 'screenTex',   mapOnly: true },
  // the pool surfaces use inline materials (not in M): set these on the 4 pool planes
  poolMos:  { tex: 'poolTex',     roughness: 1.0, metalness: 0, normalScale: 0.8, inline: true },
  poolWall: { tex: 'poolWallTex', roughness: 1.0, metalness: 0, normalScale: 0.8, inline: true }
};

/* ------------------------------------------------------------------ build */
function build(THREE, renderer, opts) {
  opts = opts || {};
  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const t0 = now();
  let aniso = 1;
  try { if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') aniso = renderer.capabilities.getMaxAnisotropy() || 1; } catch (e) { aniso = 1; }
  const big = opts.hiRes ? 2048 : 1024;
  const [, G] = makeCanvas(1, 1, true);

  function mkTex(canvas, rx, ry, srgb) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = aniso;
    if (srgb) { if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding; }
    t.needsUpdate = true; return t;
  }
  function pack(o, rx, ry, ns) {
    const colorCanvas = (o.color && o.color.data) ? toCanvas(o.color) : o.color;
    const r = { map: mkTex(colorCanvas, rx, ry, true) };
    if (o.normal) { r.normalMap = mkTex(toCanvas(o.normal), rx, ry, false); r.normalScale = THREE.Vector2 ? new THREE.Vector2(ns, ns) : { x: ns, y: ns }; }
    if (o.rough) r.roughnessMap = mkTex(toCanvas(o.rough), rx, ry, false);
    return r;
  }
  const out = {}, timings = {};
  function run(key, seed, fn) {
    const ts = now();
    try { fn(makeRng(seed)); } catch (e) { if (typeof console !== 'undefined') console.warn('[LanaiTextures] ' + key + ' failed; keep the original texture.', e); }
    timings[key] = Math.round(now() - ts);
  }
  run('stuccoTex', 11, r => { out.stuccoTex = pack(genStucco(big, r, G), 0.5, 0.5, 1); });
  run('tileTex', 12, r => { out.tileTex = pack(genTile(big, r, G), 8.4 / 1.2, 6.0 / 1.2, 1); });
  run('paverTex', 13, r => { out.paverTex = pack(genPaver(big, r, G), 1, 1, 1); });
  run('layerTex', 14, r => { out.layerTex = pack(genLayer(big, r, G), 1, 1, 1.2); });
  run('shingleTex', 15, r => { out.shingleTex = pack(genShingle(big, r, G), 1, 1, 1); });
  run('teakTex', 16, r => { out.teakTex = pack(genTeak(r, G), 1, 1, 1); });
  run('plaqueTex', 17, r => { out.plaqueTex = pack(genPlaque(r, G), 1, 1, 1); });
  run('fabricTex', 18, r => { out.fabricTex = pack(genFabric(r, G), 4, 4, 0.8); });
  run('wickerTex', 19, r => { out.wickerTex = pack(genWicker(r, G), 6, 2, 1); });
  run('rugTex', 20, r => { out.rugTex = pack(genRug(r, G), 1, 1, 1); });
  run('vintageTex', 21, r => { out.vintageTex = pack(genVintage(r, G), 1, 1, 0.8); });
  run('zebraTex', 22, r => { out.zebraTex = pack(genZebra(r, G), 1, 1, 0.6); });
  run('tigerTex', 23, r => { out.tigerTex = pack(genTiger(r, G), 1, 1, 0.5); });
  run('graniteTex', 24, r => { out.graniteTex = pack(genGranite(r, G), 1, 1, 0.3); });
  run('poolTex', 25, r => { const p = genPool(r, G); out.poolTex = pack(p.pool, 1, 1, 0.8); out.poolWallTex = pack(p.wall, 1, 1, 0.8); });
  run('travTex', 26, r => { out.travTex = pack(genTrav(r, G), 4, 1, 1); });
  run('herringTex', 27, r => { out.herringTex = pack(genHerring(r, G), 3, 6, 0.8); });
  run('clothTex', 28, r => { out.clothTex = pack(genCloth(r, G), 4, 2, 0.5); });
  run('screenTex', 29, () => { out.screenTex = { map: mkTex(genScreen(), 1, 1, true) }; });

  out.materialTweaks = JSON.parse(JSON.stringify(TWEAKS));
  out.timings = timings;
  out.buildMs = Math.round(now() - t0);
  /* Wire maps + tweaks into the existing material dictionary M (only keys that exist). Colours are untouched. */
  out.applyTo = function (M) {
    if (!M) return;
    for (const key in TWEAKS) {
      const tw = TWEAKS[key], m = M[key], t = out[tw.tex];
      if (!m || !t || tw.inline) continue;
      m.map = t.map;
      if (!tw.mapOnly) {
        if (t.normalMap) { m.normalMap = t.normalMap; if (m.normalScale && m.normalScale.set) m.normalScale.set(tw.normalScale, tw.normalScale); }
        if (t.roughnessMap) m.roughnessMap = t.roughnessMap;
        if (tw.roughness !== undefined) m.roughness = tw.roughness;
        if (tw.metalness !== undefined) m.metalness = tw.metalness;
        if (tw.clearBump) m.bumpMap = null;
      }
      m.needsUpdate = true;
    }
    if (M.trimDS && M.trim) { M.trimDS.copy(M.trim); M.trimDS.side = THREE.DoubleSide; M.trimDS.needsUpdate = true; }
  };
  return out;
}

const api = { build: build, materialTweaks: TWEAKS, version: 1 };
if (typeof root !== 'undefined' && root) root.LanaiTextures = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
