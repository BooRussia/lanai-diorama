/* Lanai diorama: INTERIOR materials (floor tile, ceiling, furniture, props, outdoor kitchen).
   window.LanaiMaterialsInt.apply(CTX) is called once after the scene is built (after LanaiMaterialsExt).
   - Only materials / textures / UVs of interior meshes change; geometry, positions and lights are untouched.
   - Shared M.* materials are never edited: interior meshes get their own materials.
   - Textures are procedural (deterministic) and generated progressively after apply() returns, one per
     macrotask, into placeholder textures that the materials already reference (no shader recompiles,
     no long blocking start-up). Resolution is halved on CTX.MOBILE. */
window.LanaiMaterialsInt = (function () {
  'use strict';

  /* ---------- deterministic randomness + tileable noise ---------- */
  function rng(seed) {
    let s = seed >>> 0;
    return function () { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hash2(i, j, s) {
    let n = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16; return (n >>> 0) / 4294967296;
  }
  function vnoise(x, y, p, s) {   /* periodic value noise, period p lattice cells */
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const a = hash2(x0, y0, s), b = hash2(x1, y0, s), c = hash2(x0, y1, s), d = hash2(x1, y1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  /* tileable fbm field N x N; F(x, y) samples it bilinearly with wrap (x, y in field pixels) */
  function makeField(N, base, oct, seed) {
    const f = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0, a = 0.5, tot = 0, p = base;
      for (let o = 0; o < oct; o++) { v += a * vnoise(x / N * p, y / N * p, p, seed + o * 17); tot += a; a *= 0.5; p *= 2; }
      f[y * N + x] = v / tot;
    }
    let lo = 1, hi = 0; for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
    for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo);
    const F = function (x, y) {
      x = ((x % N) + N) % N; y = ((y % N) + N) % N;
      const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, x1 = (xi + 1) % N, y1 = (yi + 1) % N;
      const a = f[yi * N + xi], b = f[yi * N + x1], c = f[y1 * N + xi], d = f[y1 * N + x1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    F.N = N; return F;
  }

  function apply(CTX) {
    const t0 = performance.now();
    try { run(CTX); } catch (e) { console.error('[int] materials_int failed', e); }
    try { console.log('[int] materials_int setup ' + (performance.now() - t0).toFixed(0) + ' ms'); } catch (e) { }
  }

  function run(CTX) {
    const THREE = CTX.THREE, scene = CTX.scene, M = CTX.M, MOB = !!CTX.MOBILE, D = CTX.dims;
    const caps = CTX.renderer.capabilities;
    const ANISO = Math.min(MOB ? 4 : 8, caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1);
    const Q = MOB ? 0.5 : 1;
    const sz = n => Math.max(16, Math.round(n * Q));
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const lerp = (a, b, t) => a + (b - a) * t;
    const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const hex = h => { const c = new THREE.Color(h); return [c.r * 255, c.g * 255, c.b * 255]; };
    const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    let NF = null, NL = null;
    /* tileable sample: integer multipliers mx,my keep the result seamless over a w x h canvas */
    const S = (F, x, y, w, h, mx, my, ox, oy) => F(x / w * F.N * Math.max(1, Math.round(mx)) + (ox || 0), y / h * F.N * Math.max(1, Math.round(my)) + (oy || 0));

    function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d', { willReadFrequently: true })]; }
    function paint(w, h, fn, alpha) {
      const [c, g] = cv(w, h); const im = g.createImageData(w, h), d = im.data; const out = [0, 0, 0, 255];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        out[3] = 255; fn(x, y, out); const i = (y * w + x) * 4;
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = alpha ? out[3] : 255;
      }
      g.putImageData(im, 0, 0); return c;
    }
    function normalMap(H, w, h, k) {
      const [c, g] = cv(w, h); const im = g.createImageData(w, h), d = im.data;
      for (let y = 0; y < h; y++) {
        const yu = (y - 1 + h) % h, yd = (y + 1) % h;
        for (let x = 0; x < w; x++) {
          const xl = (x - 1 + w) % w, xr = (x + 1) % w;
          const nx = -(H[y * w + xr] - H[y * w + xl]) * k, ny = (H[yd * w + x] - H[yu * w + x]) * k;
          const il = 1 / Math.sqrt(nx * nx + ny * ny + 1), i = (y * w + x) * 4;
          d[i] = (nx * il * 0.5 + 0.5) * 255; d[i + 1] = (ny * il * 0.5 + 0.5) * 255; d[i + 2] = (il * 0.5 + 0.5) * 255; d[i + 3] = 255;
        }
      }
      g.putImageData(im, 0, 0); return c;
    }
    function grey(w, h, A, scale, off) { return paint(w, h, (x, y, o) => { const v = clamp(A[y * w + x] * scale + (off || 0), 0, 255); o[0] = o[1] = o[2] = v; }); }
    function canvasHeight(c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, H = new Float32Array(c.width * c.height); for (let i = 0; i < H.length; i++) H[i] = d[i * 4] / 255; return H; }
    function blur(H, w, h, r) {
      const T = new Float32Array(H.length), n = 2 * r + 1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += H[y * w + ((x + k + w) % w)]; T[y * w + x] = s / n; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += T[((y + k + h) % h) * w + x]; H[y * w + x] = s / n; }
      return H;
    }

    /* ---------- texture slots: placeholders now, real canvases later ---------- */
    function Slot(srgb, placeholder) {
      const [c, g] = cv(4, 4); g.fillStyle = placeholder; g.fillRect(0, 0, 4, 4);
      this.srgb = srgb; this.ph = c; this.list = [];
    }
    Slot.prototype.tex = function (rx, ry, rot) {
      const t = new THREE.CanvasTexture(this.ph); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx || 1, ry || 1);
      if (rot) { t.rotation = rot; t.center.set(0.5, 0.5); }
      if (this.srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = ANISO; this.list.push(t); return t;
    };
    Slot.prototype.fill = function (canvas) { this.list.forEach(t => { t.image = canvas; t.needsUpdate = true; }); };
    const NRM = '#8080ff';
    const slots = (mapPh, extra) => { const o = { map: new Slot(true, mapPh), normal: new Slot(false, NRM) }; if (extra) o.rough = new Slot(false, extra); return o; };

    /* ---------- UV helper (UVs only; vertex positions untouched) ----------
       world-scale box UVs; u runs along the longest in-face axis (wood grain / brushing); scale = metres per tile */
    const R = rng(90210);
    function boxUV(mesh, scale, grainAxis, jitter) {
      const g = mesh.geometry; if (!g || !g.attributes || !g.attributes.uv || !g.attributes.normal) return;
      if (g.userData && g.userData.intUV) return;
      g.computeBoundingBox(); const bb = g.boundingBox, ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
      const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
      const ou = jitter ? R() * 7 : 0, ov = jitter ? R() * 7 : 0;
      const gAx = grainAxis !== undefined ? grainAxis : (ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2);
      for (let i = 0; i < p.count; i++) {
        const an = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
        const a = an[0] > an[1] && an[0] > an[2] ? 0 : an[1] > an[2] ? 1 : 2;
        const ax = [0, 1, 2].filter(k => k !== a);
        let ua, va;
        if (ax.indexOf(gAx) >= 0) { ua = gAx; va = ax[0] === gAx ? ax[1] : ax[0]; }
        else { ua = ext[ax[0]] >= ext[ax[1]] ? ax[0] : ax[1]; va = ua === ax[0] ? ax[1] : ax[0]; }
        const pv = [p.getX(i), p.getY(i), p.getZ(i)];
        uv.setXY(i, pv[ua] / scale + ou, pv[va] / scale + ov);
      }
      uv.needsUpdate = true; g.userData = g.userData || {}; g.userData.intUV = true;
    }

    /* ======================================================================
       TEXTURE GENERATORS (each fills its slots)
       ====================================================================== */

    /* floor: large honed beige porcelain tile, 0.5 m; canvas = 2 m (4x4 tiles) */
    function genFloor(T) {
      const W = sz(1024), tiles = 4, tp = W / tiles, gw = 1.2 * Q + 0.4, bev = 2.4 * Q + 0.8;
      const base = [], cols = [hex('#d8c6a8'), hex('#dccbae'), hex('#d3c1a2'), hex('#dac9ab'), hex('#d5c4a5')];
      for (let i = 0; i < tiles * tiles; i++) base.push({ c: cols[Math.floor(R() * cols.length)], v: (R() - 0.5) * 10, ox: R() * 999, oy: R() * 999, h: (R() - 0.5) * 0.06 });
      const grout = hex('#bfb19a');
      const H = new Float32Array(W * W), RG = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => {
        const tx = (x / tp) | 0, ty = (y / tp) | 0, lx = x - tx * tp, ly = y - ty * tp;
        const T0 = base[ty * tiles + tx];
        const ed = Math.min(lx, ly, tp - 1 - lx, tp - 1 - ly);
        const c1 = S(NF, x, y, W, W, 2, 2, T0.ox, T0.oy);
        const band = S(NL, x, y, W, W, 1, 6, T0.oy, T0.ox);
        const fine = S(NF, x, y, W, W, 12, 12, T0.oy, T0.ox);
        let v = T0.v + (c1 - 0.5) * 16 + (band - 0.5) * 8 + (fine - 0.5) * 7;
        const pore = hash2(x, y, 5) > 0.997;
        if (pore) v -= 22;
        let r = T0.c[0] + v, g2 = T0.c[1] + v, b = T0.c[2] + v * 1.1;
        let h = 0.6 + T0.h + (fine - 0.5) * 0.03 + (pore ? -0.12 : 0), rough = 0.4 + (fine - 0.5) * 0.1 + (c1 - 0.5) * 0.08;
        if (ed < gw) { r = grout[0] + (fine - 0.5) * 12; g2 = grout[1] + (fine - 0.5) * 12; b = grout[2] + (fine - 0.5) * 12; h = 0.25; rough = 0.95; }
        else if (ed < gw + bev) { const e = (ed - gw) / bev; h = 0.25 + (0.35 + T0.h) * Math.sqrt(e); r -= (1 - e) * 8; g2 -= (1 - e) * 8; b -= (1 - e) * 8; }
        const i = y * W + x; H[i] = h; RG[i] = rough;
        o[0] = clamp(r, 0, 255); o[1] = clamp(g2, 0, 255); o[2] = clamp(b, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 1.6 * Q + 0.6)); T.rough.fill(grey(W, W, RG, 255));
    }

    /* woven fabric detail: near-white modulation + weave/slub/wrinkle normal; canvas = 0.5 m */
    function genFabric(T, opt) {
      const W = sz(512), per = 4, seed = opt.seed;
      const H = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => {
        const over = (((x / 2) | 0) + ((y / 2) | 0)) & 1;
        const fx = (x % per) / per, fy = (y % per) / per;
        const th = over ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI);
        /* thread slubs: thin streaks at thread scale (not a plaid) */
        const sl = ((over ? S(NF, x, y, W, W, 2, 96, seed * 13, 0) : S(NF, x, y, W, W, 96, 2, 0, seed * 7)) - 0.5) * opt.slub * 2;
        /* soft, domain-warped creases (warp keeps them off the noise lattice axes) */
        const wx = (S(NF, x, y, W, W, 1, 1, seed * 3, 0) - 0.5) * NL.N * 0.9, wy = (S(NF, x, y, W, W, 1, 1, 0, seed * 11) - 0.5) * NL.N * 0.9;
        const rn = S(NL, x, y, W, W, 1, 1, seed * 5 + wx, 9 + wy);
        const cr = Math.pow(1 - Math.abs(rn * 2 - 1), 10);
        const mott = S(NL, x, y, W, W, 2, 2, seed + wy, 3 + wx);
        H[y * W + x] = th * 0.3 + sl * 0.35 + cr * opt.wrinkle + mott * 0.1;
        const v = 238 + (th - 0.5) * 16 * opt.contrast + sl * 22 + (mott - 0.5) * 18 - cr * opt.wrinkle * 18 + (hash2(x, y, seed) - 0.5) * 8;
        o[0] = o[1] = o[2] = clamp(v, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, opt.nk * (MOB ? 0.7 : 1)));
    }

    /* chunky cable knit; canvas = 0.25 m (per-pixel, no canvas drawing) */
    function genKnit(T) {
      const W = sz(256), cols = 16, cw = W / cols, rows = 20, rh = W / rows, P = W / 2;
      const H = new Float32Array(W * W);
      const lobe = (dx, dy, rx, ry, a) => { const c = Math.cos(a), s = Math.sin(a); const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry; const d = u * u + v * v; return d < 1 ? Math.sqrt(1 - d) : 0; };
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const c = (x / cw) | 0, m8 = c % 8; let h = 0;
        if (m8 >= 3 && m8 <= 6) {
          const x0 = (c - m8 + 3) * cw, x1 = x0 + 4 * cw, mid = (x0 + x1) / 2, amp = (x1 - x0) * 0.24;
          for (let s = 0; s < 2; s++) {
            const ph = y / P * Math.PI * 2 + s * Math.PI, xs = mid + Math.sin(ph) * amp, front = Math.cos(ph) * (s ? 1 : -1);
            const dx = Math.abs(x - xs) / (cw * 1.15);
            if (dx < 1) { const seg = 0.65 + 0.35 * Math.abs(Math.sin(y / (rh * 0.9) * Math.PI)); const v = Math.sqrt(1 - dx * dx) * seg * (front > 0 ? 1 : 0.75); if (v > h) h = v; }
          }
          if (Math.abs(x - x0) < 1.5 || Math.abs(x - x1) < 1.5) h *= 0.3;
        } else {
          const lx = x - c * cw - cw / 2;
          for (let k = -1; k <= 1; k++) {
            const ly = (y % rh) - rh / 2 + k * rh;
            h = Math.max(h, lobe(lx + cw * 0.22, ly, cw * 0.3, rh * 0.62, -0.5), lobe(lx - cw * 0.22, ly, cw * 0.3, rh * 0.62, 0.5));
          }
        }
        H[y * W + x] = h;
      }
      const base = hex('#ebe3d5');
      const col = paint(W, W, (x, y, o) => { const h = H[y * W + x]; const v = 0.6 + 0.45 * h + (hash2(x, y, 3) - 0.5) * 0.05; o[0] = clamp(base[0] * v, 0, 255); o[1] = clamp(base[1] * v, 0, 255); o[2] = clamp(base[2] * v, 0, 255); });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 2.5 * Q + 0.8));
    }

    /* tiger-print pillow fabric (cream ground, charcoal leaping tigers) */
    function genTiger(T) {
      const W = sz(512); const [c, g] = cv(W, W); g.fillStyle = '#ddd3c2'; g.fillRect(0, 0, W, W);
      const ink = 'rgba(62,60,62,0.92)', s = W / 512;
      const tiger = (x, y, sc, flip) => {
        g.save(); g.translate(x, y); g.scale(flip ? -sc : sc, sc); g.fillStyle = ink; g.strokeStyle = ink; g.lineCap = 'round';
        g.beginPath(); g.ellipse(0, 0, 34, 11, -0.15, 0, 7); g.fill(); g.beginPath(); g.ellipse(36, -9, 10, 8, 0, 0, 7); g.fill();
        g.lineWidth = 6; g.beginPath(); [[-24, 6, -40, 22], [-14, 8, -22, 26], [16, 6, 34, 22], [24, 4, 44, 14]].forEach(l => { g.moveTo(l[0], l[1]); g.lineTo(l[2], l[3]); }); g.stroke();
        g.lineWidth = 4; g.beginPath(); g.moveTo(-32, -4); g.quadraticCurveTo(-56, -18, -50, -34); g.stroke();
        g.fillStyle = '#ddd3c2'; g.beginPath(); for (let i = -24; i < 26; i += 9) { g.moveTo(i + 2.2, -2); g.ellipse(i, -2, 2.2, 8, 0.25, 0, 7); } g.fill(); g.restore();
      };
      for (let j = 0; j < 4; j++) for (let i = 0; i < 3; i++) {
        const x = (i + (j % 2) * 0.5) * W / 3 + W / 9, y = j * W / 4 + W / 8;
        [[0, 0], [W, 0], [-W, 0], [0, W], [0, -W]].forEach(([dx, dy]) => tiger(x + dx, y + dy, s * 1.15, (i + j) % 2));
      }
      T.map.fill(c);
    }

    /* rattan lattice with alpha cut-outs (open diamonds, wrapped strands); per-pixel */
    function genWicker(T) {
      const W = sz(512), sp = W / 3, tw = W * 0.075, r = tw / 2;
      const H = new Float32Array(W * W);
      const cA = hex('#9e8f79'), cB = hex('#7b6e5e'), cC = hex('#bcae98');
      const col = paint(W, W, (x, y, o) => {
        const d1 = ((x - y) % sp + sp) % sp, d2 = ((x + y) % sp + sp) % sp;
        const t1 = Math.min(d1, sp - d1) * 0.7071, t2 = Math.min(d2, sp - d2) * 0.7071;   /* distance to strand centre */
        let h = 0;
        const hA = t1 < r ? Math.sqrt(1 - (t1 / r) * (t1 / r)) : 0, hB = t2 < r ? Math.sqrt(1 - (t2 / r) * (t2 / r)) : 0;
        if (hA > 0 || hB > 0) {
          const ci = Math.floor((x - y) / sp + 0.5), cj = Math.floor((x + y) / sp + 0.5);
          const aTop = ((ci + cj) & 1) === 0;                       /* over / under alternates */
          let onA;
          if (hA > 0 && hB > 0) { onA = aTop; h = aTop ? hA : hB; }
          else if (hA > 0) { onA = true; h = hA * 0.92; } else { onA = false; h = hB * 0.92; }
          const along = onA ? (x + y) * 0.7071 : (x - y) * 0.7071, rib = Math.abs(Math.sin(along / (tw * 0.3) * Math.PI));
          h *= 0.75 + 0.25 * rib;
        }
        const i = y * W + x; H[i] = h;
        const n = S(NF, x, y, W, W, 2, 2), f = hash2(x, y, 9);
        let c3 = mix3(cB, cA, clamp(n * 1.2, 0, 1)); c3 = mix3(c3, cC, clamp((f - 0.6) * 2, 0, 1) * 0.4);
        const sh = 0.5 + 0.62 * h;
        o[0] = clamp(c3[0] * sh, 0, 255); o[1] = clamp(c3[1] * sh, 0, 255); o[2] = clamp(c3[2] * sh, 0, 255); o[3] = h > 0.05 ? 255 : 0;
      }, true);
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 2.4 * Q + 0.6));
    }
    function genWrap(T) {
      const w = sz(256), h = sz(32), cA = hex('#ae9f88'), H = new Float32Array(w * h);
      const col = paint(w, h, (x, y, o) => {
        const s = (x % 8) / 8, prof = Math.sin(s * Math.PI), around = Math.sin(y / h * Math.PI);
        H[y * w + x] = prof * 0.7 + around * 0.3; const v = 0.62 + 0.38 * prof + (hash2(x >> 3, 0, 4) - 0.5) * 0.14;
        o[0] = cA[0] * v; o[1] = cA[1] * v; o[2] = cA[2] * v;
      });
      T.map.fill(col); T.normal.fill(normalMap(H, w, h, 2));
    }

    /* wood, grain along u; canvas = 1.0 m x 0.25 m */
    function genWood(T, tint, rings) {
      const w = sz(1024), h = sz(256);
      const H = new Float32Array(w * h);
      const c0 = hex(tint[0]), c1 = hex(tint[1]), c2 = hex(tint[2]);
      const checks = []; for (let i = 0; i < 26; i++) checks.push([R() * w, R() * h, (20 + R() * 100) * Q, 0.6 + R() * 0.8]);
      const col = paint(w, h, (x, y, o) => {
        const warpN = S(NF, x, y, w, h, 1, 1);
        const yy = y + (warpN - 0.5) * h * 0.9 + Math.sin(x / w * Math.PI * 4 + y * 0.02) * 5 * Q;
        const ring = ((yy / (h / rings)) % 1 + 1) % 1; const late = Math.pow(Math.abs(Math.sin(ring * Math.PI)), 6);
        const fib = S(NF, x, y, w, h, 1, 16, 31, 0);
        const fine = hash2(x >> 2, y, 11);
        const patch = S(NL, x, y, w, h, 2, 1, 5, 0);
        let c3 = mix3(c0, c1, clamp((patch - 0.35) * 1.6, 0, 1) * 0.65);
        c3 = mix3(c3, c2, clamp(late * 0.55 + (fib - 0.5) * 0.5 + 0.12, 0, 1));
        let hh = 0.6 - late * 0.25 + (fib - 0.5) * 0.25 + (fine - 0.5) * 0.05;
        for (let i = 0; i < checks.length; i++) {
          const ch = checks[i], dx = Math.abs(((x - ch[0] + w * 1.5) % w) - w / 2), dy = Math.abs(y - ch[1]);
          if (dx < ch[2] && dy < ch[3] * Q + 0.4) { const e = 1 - dx / ch[2]; c3 = mix3(c3, [48, 40, 34], 0.6 * e); hh -= 0.4 * e; }
        }
        H[y * w + x] = hh; const v = 1 + (fine - 0.5) * 0.08;
        o[0] = clamp(c3[0] * v, 0, 255); o[1] = clamp(c3[1] * v, 0, 255); o[2] = clamp(c3[2] * v, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, w, h, 2.2 * Q + 0.5));
    }

    /* zebra print upholstery; canvas = 1 m */
    function genZebra(T) {
      const W = sz(512), cream = hex('#e2d8c5'), ink = hex('#2b2622');
      const col = paint(W, W, (x, y, o) => {
        const wn = S(NF, x, y, W, W, 1, 1), wn2 = S(NF, x, y, W, W, 3, 2, 50, 0);
        const ph = x / W * Math.PI * 2 * 11 + (wn - 0.5) * 10 + (wn2 - 0.5) * 3 + Math.sin(y / W * Math.PI * 4) * 1.2;
        const t = sstep(0.05, 0.3, Math.sin(ph) + (wn2 - 0.5) * 0.5);
        const c3 = mix3(cream, ink, t), v = 1 + (hash2(x, y, 2) - 0.5) * 0.08;
        o[0] = clamp(c3[0] * v, 0, 255); o[1] = clamp(c3[1] * v, 0, 255); o[2] = clamp(c3[2] * v, 0, 255);
      });
      T.map.fill(col);
    }

    /* brushed stainless; streaks along u; canvas = 0.5 m */
    function genSteel(T) {
      const W = sz(512), rows = new Float32Array(W);
      for (let y = 0; y < W; y++) rows[y] = (hash2(0, y, 77) - 0.5) * 0.7 + (hash2(0, y >> 1, 78) - 0.5) * 0.4;
      const H = new Float32Array(W * W), RG = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => {
        const along = S(NF, x, y, W, W, 1, 32) - 0.5;
        const scratch = hash2(x >> 5, y, 79) > 0.988 ? 1 : 0;
        const big = S(NL, x, y, W, W, 1, 1) - 0.5;
        const i = y * W + x;
        H[i] = rows[y] * 0.55 + along * 0.45 + scratch * 0.3;
        RG[i] = clamp(0.3 + rows[y] * 0.06 + along * 0.1 + big * 0.08 - scratch * 0.05, 0.05, 1);
        const v = 212 + rows[y] * 4 + along * 4 + big * 6 + scratch * 3;
        o[0] = clamp(v, 0, 255); o[1] = clamp(v + 1, 0, 255); o[2] = clamp(v + 2, 0, 255);
      });
      T.map.fill(col); T.rough.fill(grey(W, W, RG, 255)); T.normal.fill(normalMap(H, W, W, 0.7));
    }

    /* dark granite with flowing gold-brown bands and thin cream veins; canvas = 1 m */
    function genGranite(T) {
      const W = sz(512), RG = new Float32Array(W * W);
      const blk = hex('#0e0b09'), dbr = hex('#241a13'), brn = hex('#4e3824'), gold = hex('#86704f'), crm = hex('#cdbc9a');
      const col = paint(W, W, (x, y, o) => {
        const qx = S(NL, x, y, W, W, 1, 1), qy = S(NL, x, y, W, W, 1, 1, 21, 13);
        const rx = S(NF, x, y, W, W, 1, 1, qx * 90, qy * 50), ry = S(NF, x, y, W, W, 1, 1, 77 + qy * 70, 31 + qx * 40);
        const t = S(NL, x, y, W, W, 1, 1, rx * 40, ry * 30) * 0.7 + S(NF, x, y, W, W, 1, 1, rx * 90, ry * 60) * 0.3;
        const band = sstep(0.42, 0.62, t) * (1 - sstep(0.78, 0.95, t));
        const goldA = Math.exp(-Math.pow((t - 0.6) / 0.05, 2)) * sstep(0.35, 0.6, ry);
        let c3 = mix3(blk, dbr, sstep(0.25, 0.5, t)); c3 = mix3(c3, brn, band * 0.8); c3 = mix3(c3, gold, goldA * 0.6);
        const vv = Math.abs(((rx * 5 + ry * 3) % 1) - 0.5), vein = sstep(0.02, 0.0, vv) * sstep(0.45, 0.7, qy);
        c3 = mix3(c3, crm, vein * 0.8);
        const sp = hash2(x, y, 41); if (sp > 0.993) c3 = mix3(c3, gold, 0.5); else if (sp < 0.01) c3 = mix3(c3, blk, 0.7);
        RG[y * W + x] = 0.09 + (1 - band) * 0.04 + (sp > 0.993 ? 0.06 : 0);
        o[0] = c3[0]; o[1] = c3[1]; o[2] = c3[2];
      });
      T.map.fill(col); T.rough.fill(grey(W, W, RG, 255));
    }

    /* carved wood plaque: rosette + acanthus scrolls (height drawn once, then shaded) */
    function genPlaque(T) {
      const w = sz(512), h = sz(384), s = w / 512;
      const [hc, hg] = cv(w, h); hg.fillStyle = '#4a4a4a'; hg.fillRect(0, 0, w, h);
      [[16, 22], [44, 7]].forEach(([i, lw]) => { hg.strokeStyle = '#d8d8d8'; hg.lineWidth = lw * s; hg.strokeRect(i * s, i * s, w - 2 * i * s, h - 2 * i * s); });
      const blob = (x, y, rx, ry, a) => { hg.save(); hg.translate(x, y); hg.rotate(a); hg.scale(1, ry / rx); const g = hg.createRadialGradient(0, 0, 0, 0, 0, rx); g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#9a9a9a'); g.addColorStop(1, 'rgba(74,74,74,0)'); hg.fillStyle = g; hg.fillRect(-rx, -rx, 2 * rx, 2 * rx); hg.restore(); };
      const cx = w / 2, cy = h / 2;
      for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; blob(cx + Math.cos(a) * 46 * s, cy + Math.sin(a) * 46 * s, 30 * s, 12 * s, a); }
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.2; blob(cx + Math.cos(a) * 22 * s, cy + Math.sin(a) * 22 * s, 16 * s, 8 * s, a); }
      blob(cx, cy, 16 * s, 16 * s, 0);
      [-1, 1].forEach(sd => { for (let k = 0; k < 2; k++) { const ox = cx + sd * (120 + k * 70) * s, oy = cy + (k ? 40 : -40) * s; for (let j = 0; j < 12; j++) { const a = j / 12 * Math.PI * 1.7, r = (48 - j * 3) * s; blob(ox + sd * Math.cos(a) * r, oy + Math.sin(a) * r * 0.8, (13 - j * 0.5) * s, 6 * s, a + Math.PI / 2); } } });
      const H = blur(canvasHeight(hc), w, h, Math.max(1, Math.round(2 * s)));
      const low = hex('#221913'), mid = hex('#4a3b2e'), hi = hex('#7b6651');
      const col = paint(w, h, (x, y, o) => {
        const hh = H[y * w + x], n = S(NF, x, y, w, h, 2, 4), f = hash2(x, y, 6);
        const c3 = hh < 0.5 ? mix3(low, mid, hh / 0.5) : mix3(mid, hi, (hh - 0.5) / 0.5);
        const v = 0.85 + n * 0.3 + (f - 0.5) * 0.1; o[0] = clamp(c3[0] * v, 0, 255); o[1] = clamp(c3[1] * v, 0, 255); o[2] = clamp(c3[2] * v, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, w, h, 7 * s));
    }

    /* seating rug: Moroccan trellis, wool pile; canvas = whole rug (3.0 x 2.7 m) */
    function genRug(T) {
      const w = sz(1024), h = Math.round(w * 2.7 / 3.0);
      const ground = hex('#6c5747'), groundB = hex('#5f4c3e'), line = hex('#d6c8ae'), bord = hex('#4e3e33');
      const cell = w / 9.2, lw = cell * 0.075, bx = w * 0.035, bx2 = w * 0.06;
      const H = new Float32Array(w * h);
      const col = paint(w, h, (x, y, o) => {
        const e = Math.min(x, w - 1 - x, y, h - 1 - y);
        let c3, hh;
        const pile = S(NF, x, y, w, h, 12, 12), tuft = hash2(x, y, 21), ab = S(NL, x, y, w, h, 1, 3);
        if (e < bx) { c3 = bord; hh = 0.5; }
        else if (e < bx + lw * 1.2) { c3 = line; hh = 0.6; }
        else if (e < bx2) { c3 = ground; hh = 0.5; }
        else {
          const u = (x - w / 2) / cell, v = (y - h / 2) / cell;
          const f1 = Math.abs(Math.hypot(u - Math.round(u), v - Math.round(v)) - 0.5);
          const u2 = u - 0.5, v2 = v - 0.5, f2 = Math.abs(Math.hypot(u2 - Math.round(u2), v2 - Math.round(v2)) - 0.5);
          const d = Math.min(f1, f2) * cell, t = sstep(lw * 0.5 + 1.2, lw * 0.5 - 0.6, d);
          c3 = mix3(mix3(ground, groundB, ab), line, t); hh = 0.5 + 0.1 * t;
          if (e < bx2 + lw) c3 = mix3(c3, line, sstep(bx2 + lw, bx2 + lw * 0.4, e));
        }
        const v2 = 0.86 + pile * 0.22 + (tuft - 0.5) * 0.16;
        H[y * w + x] = hh + (pile - 0.5) * 0.3 + (tuft - 0.5) * 0.25;
        o[0] = clamp(c3[0] * v2, 0, 255); o[1] = clamp(c3[1] * v2, 0, 255); o[2] = clamp(c3[2] * v2, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, w, h, 1.5));
    }

    /* kitchen runner: faded vintage Persian (0.9 x 1.7 m) */
    function genRunner(T) {
      const w = sz(384), h = Math.round(w * 1.7 / 0.9), s = w / 384;
      const [c, g] = cv(w, h);
      g.fillStyle = '#8e7178'; g.fillRect(0, 0, w, h);
      const band = (i, col, lw) => { g.strokeStyle = col; g.lineWidth = lw * s; g.strokeRect(i * s, i * s, w - 2 * i * s, h - 2 * i * s); };
      band(8, '#5b4652', 16); band(24, '#c9b9b0', 6); band(38, '#6e7a86', 22); band(52, '#c9b9b0', 4);
      g.fillStyle = '#b88e88'; g.beginPath();
      for (let y = 30; y < h / s - 30; y += 14) [38, 384 - 38].forEach(x => { g.moveTo(x * s + 4 * s, y * s); g.arc(x * s, y * s, 4 * s, 0, 7); });
      for (let x = 30; x < 384 - 30; x += 14) [38, h / s - 38].forEach(y => { g.moveTo(x * s + 4 * s, y * s); g.arc(x * s, y * s, 4 * s, 0, 7); });
      g.fill();
      const cx = w / 2, cy = h / 2;
      const lozenge = (cx, cy, rx, ry, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(cx, cy - ry); g.lineTo(cx + rx, cy); g.lineTo(cx, cy + ry); g.lineTo(cx - rx, cy); g.closePath(); g.fill(); };
      lozenge(cx, cy, 120 * s, 230 * s, '#727c88'); lozenge(cx, cy, 96 * s, 190 * s, '#a8838a'); lozenge(cx, cy, 52 * s, 100 * s, '#d2c3b6'); lozenge(cx, cy, 26 * s, 52 * s, '#5b4652');
      [-1, 1].forEach(sd => lozenge(cx, cy + sd * 270 * s, 30 * s, 40 * s, '#727c88'));
      g.fillStyle = '#727c88'; g.beginPath(); [[70, 70], [384 - 70, 70], [70, h / s - 70], [384 - 70, h / s - 70]].forEach(([x, y]) => { g.moveTo(x * s + 30 * s, y * s); g.arc(x * s, y * s, 30 * s, 0, 7); }); g.fill();
      ['#c9a7a6', '#5b4652', '#7d8996', '#d6c7b8'].forEach(cl => { g.fillStyle = cl; g.beginPath(); for (let i = 0; i < 30; i++) { const x = (66 + R() * 252) * s, y = (66 + R() * (h / s - 132)) * s, r = (2 + R() * 3) * s; g.moveTo(x + r, y); g.arc(x, y, r, 0, 7); } g.fill(); });
      const d = g.getImageData(0, 0, w, h); const a = d.data;
      const H = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, fade = S(NF, x, y, w, h, 1, 2), wear = S(NF, x, y, w, h, 2, 2, 40, 0), pile = hash2(x, y, 23);
        const ft = 0.35 + fade * 0.35, warp = sstep(0.62, 0.8, wear) * 0.55;
        for (let ch = 0; ch < 3; ch++) { let v = a[i + ch]; v = lerp(v, [196, 184, 180][ch], ft); v = lerp(v, [226, 218, 205][ch], warp); a[i + ch] = clamp(v * (0.9 + pile * 0.18), 0, 255); }
        H[y * w + x] = pile * 0.3 - warp * 0.4 + (y % 3 === 0 ? 0.1 : 0);
      }
      g.putImageData(d, 0, 0);
      T.map.fill(c); T.normal.fill(normalMap(H, w, h, 1.1));
    }

    /* block-print tablecloth; canvas = 0.4 m */
    function genCloth(T) {
      const W = sz(512), s = W / 512; const [c, g] = cv(W, W);
      g.fillStyle = '#efeadf'; g.fillRect(0, 0, W, W);
      const n = 8, st = W / n, pts = [];
      for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) pts.push([(i + (j % 2 ? 0.5 : 0)) * st + st / 2 + (hash2(i + 9, j + 9, 3) - 0.5) * 3 * s, j * st + st / 2 + (hash2(i + 9, j + 9, 4) - 0.5) * 3 * s]);
      g.fillStyle = '#6f8a74'; g.beginPath(); pts.forEach(([x, y]) => { [-1, 1].forEach(a => { g.moveTo(x + a * 9 * s + 6 * s, y + 10 * s); g.ellipse(x + a * 9 * s, y + 10 * s, 6 * s, 2.6 * s, a * 0.6, 0, 7); }); }); g.fill();
      g.strokeStyle = '#6f8a74'; g.lineWidth = 1.6 * s; g.beginPath(); pts.forEach(([x, y]) => { g.moveTo(x, y); g.lineTo(x, y + 14 * s); }); g.stroke();
      g.fillStyle = '#34497a'; g.beginPath(); pts.forEach(([x, y]) => { for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, px = x + Math.cos(a) * 6 * s, py = y + Math.sin(a) * 6 * s; g.moveTo(px + 4.4 * s, py); g.ellipse(px, py, 4.4 * s, 2.8 * s, a, 0, 7); } }); g.fill();
      g.fillStyle = '#b4565c'; g.beginPath(); pts.forEach(([x, y]) => { g.moveTo(x + 3.2 * s, y); g.arc(x, y, 3.2 * s, 0, 7); }); g.fill();
      g.fillStyle = '#9aa7c2'; g.beginPath(); pts.forEach(([x, y]) => { g.moveTo(x + st / 2 + 2 * s, y + st / 2); g.arc(x + st / 2, y + st / 2, 2 * s, 0, 7); }); g.fill();
      const d = g.getImageData(0, 0, W, W), a = d.data;
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, n2 = S(NF, x, y, W, W, 3, 3), wv = (((x >> 1) + (y >> 1)) & 1); const f = 0.94 + n2 * 0.08 + wv * 0.025; for (let ch = 0; ch < 3; ch++) { const v = a[i + ch]; a[i + ch] = clamp(v < 200 ? lerp(v, 239, 0.1 + n2 * 0.2) * f : v * f, 0, 255); } }
      g.putImageData(d, 0, 0); T.map.fill(c);
    }

    /* metal mottling (oil-rubbed bronze / forged iron) */
    function genMottle(T, c1, c2, hl) {
      const W = sz(256), A = hex(c1), B = hex(c2), C = hex(hl), H = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => {
        const n = S(NF, x, y, W, W, 1, 1), f = S(NF, x, y, W, W, 4, 4, 9, 0);
        let c3 = mix3(A, B, n); c3 = mix3(c3, C, sstep(0.66, 0.86, f) * 0.5);
        H[y * W + x] = n * 0.4 + f * 0.6; o[0] = c3[0]; o[1] = c3[1]; o[2] = c3[2];
      });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 1.4));
    }
    /* smooth painted plaster (ceiling, kitchen base) */
    function genPlaster(T) {
      const W = sz(256), H = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => {
        const n = S(NF, x, y, W, W, 1, 1), f = S(NF, x, y, W, W, 6, 6);
        H[y * W + x] = n * 0.3 + f * 0.7; o[0] = o[1] = o[2] = clamp(246 + (n - 0.5) * 9 + (f - 0.5) * 5, 0, 255);
      });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 0.9));
    }
    /* ceramic glaze micro-variation */
    function genGlaze(T) {
      const W = sz(128), H = new Float32Array(W * W);
      const col = paint(W, W, (x, y, o) => { const n = S(NF, x, y, W, W, 2, 2), f = hash2(x, y, 12); H[y * W + x] = n; o[0] = o[1] = o[2] = 244 + (n - 0.5) * 14 + (f > 0.995 ? -28 : 0); });
      T.map.fill(col); T.normal.fill(normalMap(H, W, W, 0.6));
    }
    /* candle emissive gradient: brighter toward the top (v = 1) */
    function waxGlow() {
      const [c, g] = cv(8, 64); const gr = g.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.25, '#9a8a78'); gr.addColorStop(1, '#2a2420'); g.fillStyle = gr; g.fillRect(0, 0, 8, 64);
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
    }

    /* ======================================================================
       SLOTS + MATERIALS (built now; textures stream in afterwards)
       ====================================================================== */
    const T = {
      floor: slots('#dccfb8', '#6b6b6b'), weave: slots('#e2e2e2'), linen: slots('#e2e2e2'), knit: slots('#e3dccf'),
      tiger: slots('#cfc6b6'), wicker: slots('#a39580'), wrap: slots('#ae9f88'), teak: slots('#988b7b'), walnut: slots('#5e412e'),
      zebra: slots('#9b9288'), steel: slots('#cdd0d2', '#4d4d4d'), granite: slots('#2a2018', '#1a1a1a'), plaque: slots('#46382c'),
      rug: slots('#7d6858'), runner: slots('#a28f90'), cloth: slots('#e1ddd5'), bronze: slots('#3c2e24'), iron: slots('#262422'),
      plaster: slots('#f5f5f5'), glaze: slots('#f3f3f3')
    };
    const phys = o => {
      Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
      if (!MOB) return new THREE.MeshPhysicalMaterial(o);
      const q = Object.assign({}, o); delete q.clearcoat; delete q.clearcoatRoughness; delete q.sheen; return new THREE.MeshStandardMaterial(q);
    };
    const std = o => new THREE.MeshStandardMaterial(o);
    const v2 = (a, b) => new THREE.Vector2(a, b === undefined ? a : b);
    const MI = {};

    MI.tile = phys({ map: T.floor.map.tex(4.2, 3), normalMap: T.floor.normal.tex(4.2, 3), normalScale: v2(0.55), roughnessMap: T.floor.rough.tex(4.2, 3), roughness: 1, metalness: 0, envMapIntensity: 0.9, clearcoat: 0.1, clearcoatRoughness: 0.3 });
    [MI.tile.map, MI.tile.normalMap, MI.tile.roughnessMap].forEach(t => t.offset.set(0.15, 0.15));

    const fab = (color, sheen, S2, rep, ns, rough) => phys({ color, map: S2.map.tex(rep, rep), normalMap: S2.normal.tex(rep, rep), normalScale: v2(ns), roughness: rough || 0.92, metalness: 0, sheen: sheen ? new THREE.Color(sheen) : undefined, envMapIntensity: 0.45 });
    MI.sofa = fab('#565a61', '#55585e', T.weave, 2, 0.65);
    MI.sofa.envMapIntensity = 0.3;
    MI.cushion = fab('#303236', '#45484e', T.weave, 2, 0.55);
    MI.tan = fab('#b9a284', '#cdbba2', T.linen, 2.5, 0.6);
    MI.cream = fab('#e4d9c7', '#efe7da', T.linen, 2.5, 0.6);
    MI.white = fab('#efebe3', '#f8f5ef', T.linen, 2.5, 0.5);
    MI.linen = fab('#e8e0d0', '#f3ede2', T.linen, 2, 0.6);
    MI.knit = phys({ map: T.knit.map.tex(4, 4), normalMap: T.knit.normal.tex(4, 4), normalScale: v2(1), roughness: 1, sheen: new THREE.Color('#e5ddd0'), envMapIntensity: 0.4 });
    MI.tiger = phys({ map: T.tiger.map.tex(2.2, 2.2), normalMap: T.linen.normal.tex(2.2, 2.2), normalScale: v2(0.5), roughness: 0.92, sheen: new THREE.Color('#e3dccf'), envMapIntensity: 0.4 });

    const wkMap = T.wicker.map.tex(8, 2);
    MI.wicker = std({ map: wkMap, normalMap: T.wicker.normal.tex(8, 2), normalScale: v2(0.9), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, envMapIntensity: 0.6 });
    MI.wickerDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: wkMap, alphaTest: 0.5 });
    MI.rim = std({ map: T.wrap.map.tex(30, 1), normalMap: T.wrap.normal.tex(30, 1), roughness: 0.75, envMapIntensity: 0.6 });

    MI.teak = std({ map: T.teak.map.tex(1, 4), normalMap: T.teak.normal.tex(1, 4), normalScale: v2(0.7), roughness: 0.86, metalness: 0, envMapIntensity: 0.55 });
    MI.walnut = std({ map: T.walnut.map.tex(2, 2), normalMap: T.walnut.normal.tex(2, 2), normalScale: v2(0.4), roughness: 0.45, envMapIntensity: 0.8 });
    MI.carved = std({ color: '#b9ab9b', map: T.walnut.map.tex(1, 1), normalMap: T.walnut.normal.tex(1, 1), normalScale: v2(1.2), roughness: 0.7, envMapIntensity: 0.6 });
    MI.zebra = phys({ map: T.zebra.map.tex(1, 1), normalMap: T.weave.normal.tex(2, 2), normalScale: v2(0.4), roughness: 0.9, sheen: new THREE.Color('#b3ab9e'), envMapIntensity: 0.4 });

    MI.steel = phys({ color: '#c3c7ca', map: T.steel.map.tex(1, 1), roughnessMap: T.steel.rough.tex(1, 1), roughness: 1, metalness: 1, normalMap: T.steel.normal.tex(1, 1), normalScale: v2(0.08), envMapIntensity: 1.3 });
    MI.steelLid = phys({ color: '#c3c7ca', map: T.steel.map.tex(1.5, 1.85, Math.PI / 2), roughnessMap: T.steel.rough.tex(1.5, 1.85, Math.PI / 2), roughness: 1, metalness: 1, normalMap: T.steel.normal.tex(1.5, 1.85, Math.PI / 2), normalScale: v2(0.08), envMapIntensity: 1.3 });
    MI.knob = phys({ color: '#1b1c1e', roughness: 0.28, metalness: 0.6, envMapIntensity: 1.3, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    MI.ovenGlass = phys({ color: '#07080a', roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.0 });
    MI.granite = phys({ map: T.granite.map.tex(1, 1), roughnessMap: T.granite.rough.tex(1, 1), roughness: 1, metalness: 0, envMapIntensity: 0.9, clearcoat: 0.25, clearcoatRoughness: 0.06 });
    MI.plaque = std({ map: T.plaque.map.tex(1, 1), normalMap: T.plaque.normal.tex(1, 1), normalScale: v2(1.4), roughness: 0.82, envMapIntensity: 0.5 });
    MI.cabinet = std({ color: '#ece3d0', map: T.plaster.map.tex(2, 2), normalMap: T.plaster.normal.tex(2, 2), normalScale: v2(0.4), roughness: 0.85, envMapIntensity: 0.6 });
    MI.ceiling = std({ color: '#efe7d6', map: T.plaster.map.tex(8, 6), normalMap: T.plaster.normal.tex(8, 6), normalScale: v2(0.25), roughness: 0.93, envMapIntensity: 0.5 });

    MI.rug = std({ map: T.rug.map.tex(1, 1), normalMap: T.rug.normal.tex(1, 1), normalScale: v2(0.9), roughness: 1, envMapIntensity: 0.3 });
    MI.runner = std({ map: T.runner.map.tex(1, 1), normalMap: T.runner.normal.tex(1, 1), normalScale: v2(0.8), roughness: 1, envMapIntensity: 0.3 });
    MI.cloth = phys({ map: T.cloth.map.tex(1, 1), normalMap: T.linen.normal.tex(0.8, 0.8), normalScale: v2(0.45), roughness: 0.9, sheen: new THREE.Color('#ece7de'), envMapIntensity: 0.4 });

    const gm = () => T.glaze.map.tex(1, 1), gn = () => T.glaze.normal.tex(1, 1);
    MI.ceramicWhite = phys({ color: '#f1ede5', map: gm(), normalMap: gn(), normalScale: v2(0.3), roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 1.0 });
    MI.ceramicMatte = phys({ color: '#ece7de', map: gm(), normalMap: gn(), normalScale: v2(0.5), roughness: 0.62, envMapIntensity: 0.7 });
    MI.teal = phys({ color: '#1f5852', map: gm(), normalMap: gn(), normalScale: v2(0.4), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.7 });
    MI.sideTable = phys({ color: '#efebe4', map: gm(), normalMap: gn(), normalScale: v2(0.25), roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.15, envMapIntensity: 1.0 });
    MI.candle = phys({ color: '#f4ecdc', roughness: 0.55, emissive: new THREE.Color('#ffb36b'), emissiveMap: waxGlow(), emissiveIntensity: 0.1, sheen: new THREE.Color('#fff2dc'), envMapIntensity: 0.5 });
    MI.bronze = std({ map: T.bronze.map.tex(2, 2), normalMap: T.bronze.normal.tex(2, 2), normalScale: v2(0.25), roughness: 0.42, metalness: 0.78, envMapIntensity: 1.2 });
    MI.iron = std({ map: T.iron.map.tex(2, 2), normalMap: T.iron.normal.tex(2, 2), normalScale: v2(0.6), roughness: 0.58, metalness: 0.6, envMapIntensity: 1.0 });
    MI.pole = phys({ color: '#d9cfbf', roughness: 0.38, metalness: 0.2, clearcoat: 0.3, clearcoatRoughness: 0.3, envMapIntensity: 0.9 });
    MI.willow = std({ color: '#4a3326', roughness: 0.7, envMapIntensity: 0.5 });
    MI.catkin = phys({ color: '#d2cdc4', roughness: 1, sheen: new THREE.Color('#ffffff'), envMapIntensity: 0.4 });
    const shMap = T.linen.map.tex(3, 3);
    MI.shade = std({ color: '#c3ad91', map: shMap, normalMap: T.linen.normal.tex(3, 3), normalScale: v2(0.4), roughness: 1, side: THREE.DoubleSide, emissive: new THREE.Color('#ffb46a'), emissiveMap: shMap, emissiveIntensity: 0.15, envMapIntensity: 0.3 });

    /* author colours above are sRGB swatches: convert to the linear working space so dark fabrics stay dark
       (the base page's M.* hexes are linear-as-written; ours are matched to the photos instead) */
    Object.keys(MI).forEach(k => { const m = MI[k]; if (!m || k === 'ceiling' || k === 'wickerDepth' || (m.userData && m.userData.lin)) return; m.userData.lin = true;
      if (m.color) m.color.convertSRGBToLinear(); if (m.sheen && m.sheen.isColor) m.sheen.convertSRGBToLinear(); });

    /* ---------- interior reflection environment ----------
       Metals and dark polished stone inside the lanai reflect a warm cream room with bright openings,
       not the open (lavender at dusk) sky. One small PMREM, built once; its strength follows daylight. */
    const roomEnvMats = [MI.steel, MI.steelLid, MI.knob, MI.ovenGlass, MI.granite, MI.bronze, MI.iron, MI.pole];
    let roomEnv = null;
    try {
      const es = new THREE.Scene(), bm = (c, k) => { const m = new THREE.MeshBasicMaterial({ color: c, side: THREE.BackSide }); m.color.convertSRGBToLinear().multiplyScalar(k); return m; };
      const room = new THREE.Mesh(new THREE.BoxGeometry(8, 3.7, 6), [bm('#d8ccb4', 0.75), bm('#d8ccb4', 0.75), bm('#efe6d4', 0.55), bm('#cdb99a', 0.5), bm('#d8ccb4', 0.75), bm('#d8ccb4', 0.7)]);
      room.position.y = 0.6; es.add(room);
      const win = (w, h, x, y, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color('#f3efe8').multiplyScalar(3.2), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.y = ry; es.add(m); };
      [-2.5, 0.3, 2.65].forEach(x => win(x === -2.5 ? 2.6 : 1.7, 2.4, x, 0.4, 2.98, 0));       /* arched openings to the pool */
      [-0.95, 1.4].forEach(z => win(1.7, 2.4, 3.98, 0.4, -z, Math.PI / 2));
      const charcoal = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color('#2c2e33').convertSRGBToLinear().multiplyScalar(0.6) }));
      charcoal.position.set(1.8, -0.9, 1.2); es.add(charcoal);
      const pm = new THREE.PMREMGenerator(CTX.renderer);
      roomEnv = pm.fromScene(es, 0.03).texture; pm.dispose();
      roomEnvMats.forEach(m => { if (m) { m.envMap = roomEnv; m.userData.intEnv = m.envMapIntensity; } });
    } catch (e) { console.error('[int] room env', e); roomEnv = null; }

    /* ======================================================================
       ASSIGN (interior items only: item groups inside the room bounds)
       ====================================================================== */
    const inRoom = (x, z) => x > D.RX0 - 0.01 && x < D.RX1 + 0.01 && z > D.RZ0 - 0.01 && z < D.RZ1 + 0.01;
    const items = scene.children.filter(o => o.isGroup && o.userData && o.userData.item && inRoom(o.position.x, o.position.z));
    const byName = n => items.filter(g => g.name.indexOf(n) === 0);
    const hexOf = m => (m && m.color) ? '#' + m.color.getHexString() : '';
    const meshes = g => { const a = []; g.traverse(o => { if (o.isMesh) a.push(o); }); return a; };
    const set = (o, m) => { if (m && o && !Array.isArray(o.material)) o.material = m; };
    const each = (name, fn) => byName(name).forEach(g => meshes(g).forEach(o => { try { fn(o, o.material, o.geometry && o.geometry.type); } catch (e) { console.error('[int] assign ' + name, e); } }));
    const glow = [], candles = [];

    /* floor slab: swap only the tile slot of its multi-material */
    scene.children.forEach(o => { if (o.isMesh && Array.isArray(o.material) && o.material.indexOf(M.tile) >= 0) o.material = o.material.map(m => m === M.tile ? MI.tile : m); });
    /* ceiling plane in the roof lid (its inline material is unique to the interior) */
    if (CTX.roof) CTX.roof.children.forEach(o => {
      if (o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry' && Math.abs(o.position.y - D.CEIL) < 0.01) {
        if (o.material && o.material.color) MI.ceiling.color.copy(o.material.color);
        o.material = MI.ceiling;
      }
    });

    const sofaMap = new Map([[M.fabric, MI.sofa], [M.tan, MI.tan], [M.cream, MI.cream], [M.white, MI.white], [M.knit, MI.knit], [M.tiger, MI.tiger]]);
    each('Sectional', (o, m) => set(o, sofaMap.get(m)));
    each('Wicker chair', (o, m, gt) => {
      if (m === M.wicker) { o.material = MI.wicker; o.customDepthMaterial = MI.wickerDepth; }
      else if (m === M.black) set(o, MI.cushion);
      else if (m === M.bronze) set(o, MI.bronze);
      else if (gt === 'TorusGeometry') set(o, MI.rim);
    });
    each('Garden stool', o => set(o, MI.teal));
    each('Teak coffee table', (o, m, gt) => {
      if (m === M.teak) { o.material = MI.teak; if (gt === 'BoxGeometry') boxUV(o, 1.0, undefined, true); }
      else if (m === M.candle) { set(o, MI.candle); candles.push(o); }
      else if (m === M.ceramic) set(o, MI.ceramicWhite);
      else if (m === M.willow) set(o, MI.willow);
      else if (m === M.catkin) set(o, MI.catkin);
      else if (gt === 'CylinderGeometry' && hexOf(m) === '#7a4d2e') set(o, MI.walnut);
    });
    each('Zebra bench', (o, m) => { if (m === M.zebra) set(o, MI.zebra); else if (m === M.iron) set(o, MI.iron); });
    each('Side table', (o, m, gt) => {
      if (m === M.white) set(o, MI.sideTable);
      else if (gt === 'CylinderGeometry') set(o, MI.ceramicWhite);
      else if (gt === 'SphereGeometry') set(o, MI.ceramicMatte);
    });
    ['Floor lamp', 'Table lamp'].forEach(n => each(n, (o, m) => { if (m === M.shade) { o.material = MI.shade; glow.push(o); } else if (m === M.pole) set(o, MI.pole); }));
    each('Seating rug', o => set(o, MI.rug));
    each('Kitchen runner', o => set(o, MI.runner));
    each('Dining table', (o, m) => {
      if (m === M.teak) { o.material = MI.teak; boxUV(o, 1.0, undefined, true); }
      else if (m === M.cloth) { set(o, MI.cloth); boxUV(o, 0.4, 0, false); }
      else if (m === M.ceramic) set(o, MI.ceramicMatte);
      else if (m === M.candle) { set(o, MI.candle); candles.push(o); }
    });
    each('Dining chair', (o, m) => { if (m === M.linen) set(o, MI.linen); });
    each('Chandelier', (o, m) => { if (m === M.iron) set(o, MI.iron); });
    each('Ceiling fan', (o, m) => { if (m === M.bronze) set(o, MI.bronze); });
    each('Outdoor kitchen', (o, m, gt) => {
      if (m === M.steel) { if (gt === 'CylinderGeometry') o.material = MI.steelLid; else { o.material = MI.steel; if (gt === 'BoxGeometry') boxUV(o, 0.5, undefined, true); } }
      else if (m === M.steelDark) set(o, MI.knob);
      else if (m === M.granite) { o.material = MI.granite; if (gt === 'BoxGeometry') boxUV(o, 1.0, 0, true); }
      else if (m === M.plaque) set(o, MI.plaque);
      else if (m === M.trim) set(o, MI.cabinet);
      else if (hexOf(m) === '#0d0e10') set(o, MI.ovenGlass);
      else if (hexOf(m) === '#6a4d36') set(o, MI.carved);
    });
    /* pussy willow pieces anywhere inside the room */
    scene.traverse(o => { if (o.isMesh && (o.material === M.willow || o.material === M.catkin)) { const p = new THREE.Vector3(); o.getWorldPosition(p); if (inRoom(p.x, p.z)) o.material = o.material === M.willow ? MI.willow : MI.catkin; } });

    /* evening glow: shades + candles track the night factor (uniform-only changes, no recompiles) */
    const nightN = () => {
      try { const L = window.__lanai && window.__lanai.L; if (L && L.night !== undefined) return clamp(L.night, 0, 1); } catch (e) { }
      return clamp((M.shade.emissiveIntensity - 0.2) / 0.8, 0, 1);
    };
    const upShade = () => { MI.shade.emissiveIntensity = 0.04 + nightN() * 0.95; };
    const upCandle = () => { MI.candle.emissiveIntensity = 0.05 + nightN() * 0.5; };
    glow.forEach(o => { o.onBeforeRender = upShade; });
    if (roomEnv) {
      let lastF = -1;
      const upEnv = () => { const f = 0.22 + 0.78 * (1 - nightN()); if (Math.abs(f - lastF) < 0.005) return; lastF = f; roomEnvMats.forEach(m => { if (m) m.envMapIntensity = m.userData.intEnv * f; }); };
      scene.traverse(o => { if (o.isMesh && roomEnvMats.indexOf(o.material) >= 0 && !o.onBeforeRender.__int) { const prev = o.onBeforeRender; const fn = function () { upEnv(); }; fn.__int = true; if (prev && prev !== THREE.Object3D.prototype.onBeforeRender) { o.onBeforeRender = function (a, b, c, d, e, f2) { prev.call(this, a, b, c, d, e, f2); upEnv(); }; o.onBeforeRender.__int = true; } else o.onBeforeRender = fn; } });
    }
    candles.forEach(o => { o.onBeforeRender = upCandle; });
    CTX.interiorMaterials = MI;

    /* ======================================================================
       PROGRESSIVE TEXTURE GENERATION (one job per macrotask)
       ====================================================================== */
    const jobs = [
      ['fields', () => { NF = makeField(MOB ? 128 : 256, 4, 5, 7); NL = makeField(64, 2, 4, 31); }],
      ['floor', () => genFloor(T.floor)],
      ['weave', () => genFabric(T.weave, { seed: 3, slub: 0.25, wrinkle: 0.35, contrast: 1.0, nk: 2.6 })],
      ['linen', () => genFabric(T.linen, { seed: 9, slub: 0.4, wrinkle: 0.3, contrast: 0.7, nk: 2.2 })],
      ['granite', () => genGranite(T.granite)],
      ['steel', () => genSteel(T.steel)],
      ['rug', () => genRug(T.rug)],
      ['teak', () => genWood(T.teak, ['#9d9384', '#a88c6e', '#6d6155'], 9)],
      ['wicker', () => genWicker(T.wicker)],
      ['wrap', () => genWrap(T.wrap)],
      ['knit', () => genKnit(T.knit)],
      ['tiger', () => genTiger(T.tiger)],
      ['zebra', () => genZebra(T.zebra)],
      ['cloth', () => genCloth(T.cloth)],
      ['plaque', () => genPlaque(T.plaque)],
      ['runner', () => genRunner(T.runner)],
      ['walnut', () => genWood(T.walnut, ['#6e4a33', '#7d5537', '#3e281b'], 14)],
      ['bronze', () => genMottle(T.bronze, '#33271f', '#4a3626', '#8a5f3c')],
      ['iron', () => genMottle(T.iron, '#1f1d1b', '#2e2b27', '#4d463e')],
      ['plaster', () => genPlaster(T.plaster)],
      ['glaze', () => genGlaze(T.glaze)]
    ];
    const tim = []; let ji = 0; const tAll = performance.now();
    const step = () => {
      if (ji >= jobs.length) { try { console.log('[int] textures ' + (performance.now() - tAll).toFixed(0) + ' ms: ' + tim.join(' ')); } catch (e) { } CTX.interiorReady = true; return; }
      const job = jobs[ji++], a = performance.now();
      try { job[1](); } catch (e) { console.error('[int] texture ' + job[0], e); }
      tim.push(job[0] + ':' + (performance.now() - a).toFixed(0));
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  return { apply: apply };
})();
