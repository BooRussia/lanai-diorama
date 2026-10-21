/* =============================================================================
 * LanaiSky — sky, celestial motion, clouds and floating-island base
 * for the lanai diorama (three.js r128, global THREE, no modules).
 *
 *   const sky = LanaiSky.create({ THREE, scene, renderer, camera, board, soilTopColor, soilBottomColor });
 *   // every frame:
 *   const L = sky.update(hours, dt, elapsedSeconds);
 *   // L = { sunDir, keyColor, keyIntensity, hemiSky, hemiGround, hemiIntensity,
 *   //       exposure, night, envIntensity }
 *
 * Conventions
 * - Sun orbit is a great circle through +x (sunrise) and a noon point that is
 *   58 deg high over +z (the pool/front side); it sets at -x and continues under
 *   the island. Stars, Milky Way and moon ride the same rotation.
 * - `hours` is used *continuously* for rotation (25h = 1h + one full turn), so
 *   an overshooting spring makes the whole sky visibly swing around the island.
 * - Sky colours are art-directed as *display* sRGB colours and inverted through
 *   the ACES Filmic curve (at the exposure this module returns), so what you see
 *   on screen is the palette below, regardless of the tone mapper's toe.
 * - Returned colours (keyColor, hemi*) follow the host's convention: hex values
 *   used as-is (no sRGB->linear conversion), like `new THREE.Color('#fff3e2')`.
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */

  // mulberry32 seeded PRNG: same world on every load
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // deterministic 3D value noise (integer hash, no tables)
  function hash3(x, y, z) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + 0x5bd1e995) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const l = (a, b, t) => a + (b - a) * t;
    const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
    const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
    const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
    const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
    return l(l(l(c000, c100, fx), l(c010, c110, fx), fy), l(l(c001, c101, fx), l(c011, c111, fx), fy), fz);
  }
  function fbm(x, y, z, oct) {
    let a = 0.5, s = 0, n = 0;
    for (let i = 0; i < (oct || 4); i++) {
      s += a * vnoise(x, y, z); n += a;
      x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.2; a *= 0.5;
    }
    return s / n; // 0..1
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ======================================================================== */
  function create(opts) {
    const THREE = opts.THREE || window.THREE;
    const scene = opts.scene, renderer = opts.renderer, camera = opts.camera;
    const B = Object.assign({ x0: -7.6, x1: 7.6, z0: -4.6, z1: 7.2, top: 0, bottom: -1.1 }, opts.board || {});
    const SOIL_TOP = opts.soilTopColor || '#6e4c31';
    const SOIL_BOT = opts.soilBottomColor || '#3e2a1c';

    const root = new THREE.Group();
    root.name = 'LanaiSky';
    scene.add(root);
    const noRaycast = function () {};          // sky objects never intercept picking
    const disposables = [];                     // geometries / materials / textures
    const track = (o) => { disposables.push(o); return o; };

    /* ------------------------------------------- display-referred colours */
    // ACES Filmic (three r128 flavour) and its inverse, used to turn a desired
    // on-screen sRGB colour into the scene-linear radiance that produces it.
    const ACES_IN = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777);
    const ACES_OUT = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
    const ACES_IN_INV = new THREE.Matrix3().copy(ACES_IN).invert();
    const ACES_OUT_INV = new THREE.Matrix3().copy(ACES_OUT).invert();
    function rrtInv(y) {
      y = clamp(y, 0, 0.985);
      const a = 1 - 0.983729 * y, b = 0.0245786 - 0.4329510 * y, c = -(0.000090537 + 0.238081 * y);
      return (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
    }
    const _v = new THREE.Vector3();
    // display sRGB THREE.Color (stored as sRGB components) -> scene-linear Color (in place into out)
    function displayToScene(srgbColor, exposure, out) {
      const lin = out.copy(srgbColor).convertSRGBToLinear();
      _v.set(lin.r, lin.g, lin.b).applyMatrix3(ACES_OUT_INV);
      _v.set(rrtInv(_v.x), rrtInv(_v.y), rrtInv(_v.z)).applyMatrix3(ACES_IN_INV).multiplyScalar(0.6 / exposure);
      return out.setRGB(Math.max(0, _v.x), Math.max(0, _v.y), Math.max(0, _v.z));
    }

    // piecewise-linear table over sun elevation e = sin(altitude)
    function makeTable(rows) {
      return rows.map((r) => {
        const o = { e: r.e };
        for (const k in r) if (k !== 'e') o[k] = typeof r[k] === 'string' ? new THREE.Color(r[k]) : r[k];
        return o;
      });
    }
    function sampleTable(tab, e, key, out) {
      let i = 0;
      while (i < tab.length - 2 && e > tab[i + 1].e) i++;
      const a = tab[i], b = tab[i + 1];
      const t = clamp((e - a.e) / (b.e - a.e), 0, 1);
      if (out) return out.copy(a[key]).lerp(b[key], t);
      return lerp(a[key], b[key], t);
    }

    // Sky palette (display sRGB) keyed by sun elevation.
    const SKY = makeTable([
      { e: -1.00, zen: '#03060f', mid: '#050a1a', hor: '#081025', horSun: '#081025', aby: '#010208', glow: '#000000', glowAmt: 0.0, midAmt: 0.0 },
      { e: -0.30, zen: '#060c22', mid: '#0a1430', hor: '#101a3a', horSun: '#121c40', aby: '#02050f', glow: '#203060', glowAmt: 0.0, midAmt: 0.2 },
      { e: -0.16, zen: '#0b1638', mid: '#1e2656', hor: '#2c2f62', horSun: '#4a3868', aby: '#050a1e', glow: '#804068', glowAmt: 0.15, midAmt: 0.55 },
      { e: -0.07, zen: '#17265a', mid: '#4e4488', hor: '#8a5e8a', horSun: '#e0705a', aby: '#0b0f30', glow: '#ff6a3a', glowAmt: 0.55, midAmt: 0.8 },
      { e: -0.01, zen: '#243a78', mid: '#8a6aa8', hor: '#e08a8c', horSun: '#ff9a52', aby: '#141a46', glow: '#ff8c40', glowAmt: 0.8, midAmt: 0.75 },
      { e: 0.06, zen: '#33579e', mid: '#9a8cbe', hor: '#f0b49c', horSun: '#ffbf72', aby: '#1a2c60', glow: '#ffae5a', glowAmt: 0.7, midAmt: 0.5 },
      { e: 0.16, zen: '#386eb8', mid: '#8eaee0', hor: '#e6d8d0', horSun: '#f6dcb0', aby: '#1d3c7a', glow: '#ffdcaa', glowAmt: 0.45, midAmt: 0.3 },
      { e: 0.35, zen: '#2e6bc2', mid: '#78a6e2', hor: '#cfe1f2', horSun: '#e2ecf6', aby: '#1d4284', glow: '#fff0d8', glowAmt: 0.35, midAmt: 0.2 },
      { e: 1.00, zen: '#2963bb', mid: '#6c9ee0', hor: '#c4daf0', horSun: '#d6e6f4', aby: '#1b3f80', glow: '#fff6ea', glowAmt: 0.3, midAmt: 0.15 },
    ]);
    // Lighting palette (host convention: hex used as-is)
    const LIGHT = makeTable([
      { e: -1.00, key: '#ff7a3a', hemiSky: '#34477a', hemiGround: '#161a26', hemiI: 0.08 },
      { e: -0.15, key: '#ff7a3a', hemiSky: '#3c4a86', hemiGround: '#1c1e2e', hemiI: 0.10 },
      { e: -0.05, key: '#ff7a3a', hemiSky: '#7a74b0', hemiGround: '#3e3442', hemiI: 0.16 },
      { e: 0.02, key: '#ff9050', hemiSky: '#c9a6b8', hemiGround: '#5e4c44', hemiI: 0.26 },
      { e: 0.12, key: '#ffb878', hemiSky: '#d8d4e0', hemiGround: '#74644e', hemiI: 0.36 },
      { e: 0.25, key: '#ffdcb4', hemiSky: '#dce4f0', hemiGround: '#82725a', hemiI: 0.42 },
      { e: 0.45, key: '#fff1de', hemiSky: '#dfe9f5', hemiGround: '#8a7a60', hemiI: 0.45 },
      { e: 1.00, key: '#fff6ea', hemiSky: '#dfe9f5', hemiGround: '#8a7a60', hemiI: 0.45 },
    ]);
    // Cloud palette (display sRGB): lit side / shadow side / opacity
    const CLOUD = makeTable([
      { e: -1.00, lit: '#56668c', shade: '#222a44', op: 0.42 },
      { e: -0.15, lit: '#666a9a', shade: '#282a4e', op: 0.55 },
      { e: -0.05, lit: '#f08c96', shade: '#5e4c7c', op: 0.85 },
      { e: 0.02, lit: '#ffb88a', shade: '#b0849e', op: 0.95 },
      { e: 0.12, lit: '#ffe2bc', shade: '#c4aab8', op: 1.0 },
      { e: 0.35, lit: '#ffffff', shade: '#b4c0d6', op: 1.0 },
      { e: 1.00, lit: '#ffffff', shade: '#b8c4d8', op: 1.0 },
    ]);
    const MOON_KEY = new THREE.Color('#9db4ea');

    /* ------------------------------------------------- celestial geometry */
    const TILT = THREE.MathUtils.degToRad(32);                 // noon sun 58 deg high, toward +z
    const NOON = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));
    const EAST = new THREE.Vector3(-1, 0, 0);   // sunrise on the left of the default view, matching the clockwise dial
    const AXIS = new THREE.Vector3().crossVectors(EAST, NOON).normalize(); // rotating NOON about AXIS by -90deg gives EAST
    const MOON0 = NOON.clone().negate().addScaledVector(AXIS, 0.22).normalize(); // roughly opposite the sun
    // hours -> orbital angle. Warped so elevation crosses 0 at 6:30 and 19:30
    // with noon at 12:00; f(h+24) = f(h) + 2pi, monotonic, continuous for any real h.
    const W = (2 * Math.PI) / 24, WA = -0.0738, WB = -0.2347;
    const phaseOf = (h) => { const x = W * (h - 12); return x + WA * Math.sin(x) + WB * (1 - Math.cos(x)); };

    const skyQuat = new THREE.Quaternion();
    const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
    const starRotInv = new THREE.Matrix3();
    const _m4 = new THREE.Matrix4();

    /* ================================================== SKY DOME (shader) */
    const SKY_VERT = /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // rotation-only view transform: the sky is infinitely far away
        vec4 vp = viewMatrix * vec4(vDir, 0.0);
        gl_Position = projectionMatrix * vec4(vp.xyz, 1.0);
        gl_Position.z = gl_Position.w * 0.99999;   // pin to the far plane
      }`;
    const SKY_FRAG = /* glsl */`
      varying vec3 vDir;
      uniform vec3 uSunDir, uMoonDir;
      uniform vec3 uZenith, uMid, uHorizon, uHorizonSun, uAbyss, uGlow, uSunCol, uMoonCol;
      uniform float uMidAmt, uGlowAmt, uNight, uMW, uMoonVis, uExposure, uSunR, uMoonR;
      uniform mat3 uStarRotInv;

      float h1(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vn(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h1(i), h1(i + vec3(1,0,0)), f.x), mix(h1(i + vec3(0,1,0)), h1(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h1(i + vec3(0,0,1)), h1(i + vec3(1,0,1)), f.x), mix(h1(i + vec3(0,1,1)), h1(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.96875; }

      // own ACES copy: the env (PMREM) pass renders without tone mapping
      vec3 skyACES(vec3 c) {
        const mat3 IM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
        const mat3 OM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
        c *= uExposure / 0.6; c = IM * c;
        vec3 a = c * (c + 0.0245786) - 0.000090537; vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
        return clamp(OM * (a / b), 0.0, 1.0);
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;

        // which side of the sky is the sun on (azimuthally)?
        vec2 dh = d.xz; float dl = length(dh); dh = dl > 1e-4 ? dh / dl : vec2(1.0, 0.0);
        vec2 sh = uSunDir.xz; float sl = length(sh); sh = sl > 1e-4 ? sh / sl : vec2(1.0, 0.0);
        float side = dot(dh, sh) * 0.5 + 0.5; side *= side;

        // gradient above the horizon (below it, 'up' clamps to the horizon line colour)
        float up = max(h, 0.0);
        vec3 hor = mix(uHorizon, uHorizonSun, side);
        vec3 col = mix(uZenith, hor, pow(1.0 - up, 4.0));
        float midW = exp(-pow((up - 0.17) / 0.17, 2.0)) * uMidAmt * (0.5 + 0.5 * side);
        col = mix(col, uMid, midW);

        // floating in space: below the horizon fade into a deeper 'abyss' tone
        float dn = max(-h, 0.0);
        col = mix(col, uAbyss, smoothstep(0.0, 0.55, pow(dn, 0.75)));

        // Mie-like forward glow around the sun, hugging the horizon at dusk
        float sd = dot(d, uSunDir);
        float sdp = max(sd, 0.0);
        float mie = 0.30 * pow(sdp, 5.0) + 0.55 * pow(sdp, 32.0) + 1.0 * pow(sdp, 300.0);
        float horizonHug = 0.6 + 0.8 * exp(-abs(h) * 6.0);
        col += uGlow * uGlowAmt * mie * horizonHug;

        // sun disc + bloom halo (visible all around: we float in space)
        float ang = acos(clamp(sd, -1.0, 1.0));
        float disc = 1.0 - smoothstep(uSunR * 0.82, uSunR, ang);
        float halo = 0.10 * exp(-ang * 9.0) + 0.35 * exp(-ang * 40.0);
      #ifdef ENV_PASS
        col += uSunCol * (disc * 0.25 + halo * 0.5);
      #else
        col += uSunCol * (disc + halo);
      #endif

        // moon disc with soft maria, plus a cool halo
        float md = dot(d, uMoonDir);
        float mang = acos(clamp(md, -1.0, 1.0));
        float mdisc = 1.0 - smoothstep(uMoonR * 0.85, uMoonR, mang);
        vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.03)));
        vec3 mb = cross(uMoonDir, mt);
        vec2 mq = vec2(dot(d, mt), dot(d, mb)) / uMoonR;
        float maria = fbm(vec3(mq * 2.2, 4.0));
        vec3 moonSurf = uMoonCol * (0.72 + 0.45 * smoothstep(0.35, 0.7, maria));
        col = mix(col, max(col, moonSurf), mdisc * uMoonVis);
        col += uMoonCol * (0.05 * exp(-mang * 12.0) + 0.10 * exp(-mang * 45.0)) * uMoonVis * uNight;

      #ifndef ENV_PASS
        // Milky Way: soft noisy band fixed to the rotating star sphere
        if (uMW > 0.001) {
          vec3 ls = uStarRotInv * d;
          const vec3 MWN = vec3(0.30, 0.55, 0.78);    // band normal (star frame), ~unit
          const vec3 MWC = vec3(0.92, -0.38, 0.0);    // galactic-centre direction (in band)
          float bd = dot(ls, normalize(MWN));
          float band = exp(-bd * bd / 0.022);
          float core = pow(max(dot(ls, MWC) * 0.5 + 0.5, 0.0), 3.0);
          float n1 = fbm(ls * 3.5);
          float n2 = fbm(ls * 9.0 + 11.0);
          float glowB = band * (0.35 + 0.9 * smoothstep(0.35, 0.8, n1)) * (0.6 + 0.5 * n2);
          float dust = smoothstep(0.45, 0.75, fbm(ls * 6.0 + 7.0)) * exp(-bd * bd / 0.004);
          vec3 mwCol = mix(vec3(0.55, 0.62, 0.95), vec3(1.0, 0.86, 0.70), core);
          col += mwCol * glowB * (1.0 - 0.75 * dust) * (0.35 + 0.9 * core) * 0.055 * uMW;
        }
      #endif

      #ifdef ENV_PASS
        // reflections: tone-map ourselves, then use gamma-space values as radiance
        // (matches the host's original vertex-colour environment brightness)
        gl_FragColor = vec4(pow(skyACES(col), vec3(1.0 / 2.2)), 1.0);
        #include <encodings_fragment>   // PMREM target is RGBE-encoded
      #else
        // tiny dither against gradient banding
        float dth = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        col += col * dth * 0.012 + dth * 0.0006;
        gl_FragColor = vec4(max(col, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      #endif
      }`;

    const skyU = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uZenith: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uHorizonSun: { value: new THREE.Color() },
      uAbyss: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uSunCol: { value: new THREE.Color() },
      uMoonCol: { value: new THREE.Color() },
      uMidAmt: { value: 0 }, uGlowAmt: { value: 0 }, uNight: { value: 0 }, uMW: { value: 0 },
      uMoonVis: { value: 1 }, uExposure: { value: 1 },
      uSunR: { value: 0.034 }, uMoonR: { value: 0.026 },
      uStarRotInv: { value: starRotInv },
    };
    const skyGeo = track(new THREE.SphereGeometry(400, 64, 32));
    const skyMat = track(new THREE.ShaderMaterial({
      uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    }));
    const dome = new THREE.Mesh(skyGeo, skyMat);
    dome.name = 'skyDome';
    dome.renderOrder = -1000;        // first in the opaque pass
    dome.frustumCulled = false;
    dome.raycast = noRaycast;
    root.add(dome);

    /* ============================================================ STARS */
    const starRng = makeRng(0x5ea51de);
    const N_UNI = 4200, N_BAND = 2600, N_STARS = N_UNI + N_BAND;
    const sPos = new Float32Array(N_STARS * 3), sCol = new Float32Array(N_STARS * 3);
    const sSize = new Float32Array(N_STARS), sPh = new Float32Array(N_STARS);
    const MWN = new THREE.Vector3(0.30, 0.55, 0.78).normalize();
    const starTint = [new THREE.Color('#9bb2ff'), new THREE.Color('#cad8ff'), new THREE.Color('#ffffff'),
      new THREE.Color('#fff2dc'), new THREE.Color('#ffd9a8'), new THREE.Color('#ffbf86')];
    const tmpC = new THREE.Color(), tv = new THREE.Vector3();
    for (let i = 0; i < N_STARS; i++) {
      // uniform direction on sphere
      let z = starRng() * 2 - 1, a = starRng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      tv.set(r * Math.cos(a), z, r * Math.sin(a));
      if (i >= N_UNI) {
        // concentrate toward the Milky Way plane (project, then re-inflate a little)
        const off = (starRng() + starRng() + starRng() - 1.5) * 0.16;
        tv.addScaledVector(MWN, -tv.dot(MWN) + off).normalize();
      }
      sPos[i * 3] = tv.x; sPos[i * 3 + 1] = tv.y; sPos[i * 3 + 2] = tv.z;
      // magnitude distribution: many faint, few bright
      const m = Math.pow(starRng(), 7.0);
      sSize[i] = 1.1 + m * 4.6 + (i >= N_UNI ? -0.15 : 0);
      // colour temperature
      const tIdx = clamp(Math.floor((starRng() * 0.6 + starRng() * 0.4) * starTint.length), 0, starTint.length - 1);
      tmpC.copy(starTint[tIdx]);
      const bright = 0.45 + 0.55 * Math.pow(starRng(), 0.5) + m * 0.6;
      sCol[i * 3] = tmpC.r * bright; sCol[i * 3 + 1] = tmpC.g * bright; sCol[i * 3 + 2] = tmpC.b * bright;
      sPh[i] = starRng();
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(sPh, 1));
    const starU = { uTime: { value: 0 }, uVis: { value: 0 }, uPR: { value: 1 } };
    const starMat = track(new THREE.ShaderMaterial({
      uniforms: starU,
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aPhase;
        uniform float uTime, uVis, uPR;
        varying vec3 vColor; varying float vA;
        void main() {
          vec3 d = normalize(mat3(modelMatrix) * position);
          vec4 vp = viewMatrix * vec4(d, 0.0);
          gl_Position = projectionMatrix * vec4(vp.xyz, 1.0);
          gl_Position.z = gl_Position.w * 0.99999;
          // gentle twinkle: two incommensurate sines, stronger on small stars
          float tw = sin(uTime * (1.1 + aPhase * 2.9) + aPhase * 40.0) * sin(uTime * (0.43 + aPhase) + aPhase * 17.0);
          vA = uVis * (0.78 + 0.22 * tw * (1.6 - min(aSize, 4.0) * 0.3));
          vColor = aColor;
          gl_PointSize = aSize * uPR;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vA;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          float a = smoothstep(1.0, 0.0, r); a = a * a * (0.55 + 0.45 * smoothstep(0.5, 0.0, r));
          gl_FragColor = vec4(vColor, a * vA);
          #include <tonemapping_fragment>
          #include <encodings_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    }));
    const stars = new THREE.Points(starGeo, starMat);
    stars.name = 'stars';
    stars.frustumCulled = false;
    stars.renderOrder = -999;          // first in the transparent pass (before clouds)
    stars.raycast = noRaycast;
    root.add(stars);

    /* ========================================================= CLOUDS */
    // puff atlas: 2x2 cells of soft, lumpy white blobs (alpha only matters)
    function makePuffAtlas() {
      const S = 256, C = 128;
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const g = cv.getContext('2d');
      const rng = makeRng(0xc10d);
      for (let cell = 0; cell < 4; cell++) {
        const ox = (cell % 2) * C, oy = Math.floor(cell / 2) * C;
        const tmp = document.createElement('canvas'); tmp.width = tmp.height = C;
        const t = tmp.getContext('2d');
        for (let k = 0; k < 26; k++) {
          const ang = rng() * Math.PI * 2, dist = Math.pow(rng(), 0.7) * C * 0.22;
          const x = C / 2 + Math.cos(ang) * dist, y = C / 2 + Math.sin(ang) * dist * 0.85;
          const r = C * (0.12 + rng() * 0.18);
          const gr = t.createRadialGradient(x, y, 0, x, y, r);
          const a0 = 0.30 + rng() * 0.35;
          gr.addColorStop(0, `rgba(255,255,255,${a0})`);
          gr.addColorStop(0.55, `rgba(255,255,255,${a0 * 0.55})`);
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          t.fillStyle = gr; t.fillRect(0, 0, C, C);
        }
        // soft circular mask so quads never show edges
        t.globalCompositeOperation = 'destination-in';
        const m = t.createRadialGradient(C / 2, C / 2, C * 0.18, C / 2, C / 2, C * 0.49);
        m.addColorStop(0, 'rgba(255,255,255,1)'); m.addColorStop(1, 'rgba(255,255,255,0)');
        t.fillStyle = m; t.fillRect(0, 0, C, C);
        g.drawImage(tmp, ox, oy);
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const puffTex = track(makePuffAtlas());
    const cloudU = {
      uMap: { value: puffTex },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLit: { value: new THREE.Color(1, 1, 1) },
      uShade: { value: new THREE.Color(0.7, 0.75, 0.85) },
      uOpacity: { value: 1 },
      uFocus: { value: new THREE.Vector3(0, 1.5, 1.3) },
    };
    const cloudMat = track(new THREE.ShaderMaterial({
      uniforms: cloudU,
      vertexShader: /* glsl */`
        attribute vec2 corner;      // -1..1 quad corner
        attribute vec4 aPuff;       // size, atlas cell, rotation, height in cloud (-1..1)
        attribute vec3 aOff;        // puff offset from cloud centre (local), for shading normal
        uniform vec3 uFocus;
        varying vec2 vUv; varying vec2 vQ; varying vec3 vPuffN; varying float vH; varying float vFade;
        varying vec3 vRight; varying vec3 vUp; varying vec3 vBack;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float c = cos(aPuff.z), s = sin(aPuff.z);
          vec2 q = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
          mv.xy += q * aPuff.x;
          gl_Position = projectionMatrix * mv;
          float cell = aPuff.y;
          vUv = (corner * 0.5 + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0)) * 0.5;
          vQ = q;
          vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vBack  = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          vPuffN = mat3(modelMatrix) * (aOff + vec3(0.0, 0.8, 0.0));
          vH = aPuff.w;
          // fade when the camera is inside / very near, and when the cloud sits
          // between the camera and the diorama
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          float dCam = -mv.z;
          float near = smoothstep(2.0, 9.0, dCam);
          vec3 toF = uFocus - cameraPosition; float dF = length(toF);
          vec3 toP = wp - cameraPosition;
          float ahead = smoothstep(0.0, 6.0, dF - length(toP));               // cloud is closer than the house
          float cosA = dot(normalize(toP), toF / dF);
          float inView = smoothstep(0.86, 0.965, cosA);                        // and near the line of sight
          vFade = near * (1.0 - 0.93 * ahead * inView);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uLightDir, uLit, uShade; uniform float uOpacity;
        varying vec2 vUv; varying vec2 vQ; varying vec3 vPuffN; varying float vH; varying float vFade;
        varying vec3 vRight; varying vec3 vUp; varying vec3 vBack;
        void main() {
          float a = texture2D(uMap, vUv).a;
          if (a < 0.004) discard;
          // fake sphere normal of the puff, blended with the puff's position in the cloud
          float r2 = min(dot(vQ, vQ), 1.0);
          vec3 nq = vec3(vQ, sqrt(1.0 - r2) + 0.25);
          vec3 n = normalize(normalize(nq.x * vRight + nq.y * vUp + nq.z * vBack) + normalize(vPuffN) * 0.9);
          float ndl = dot(n, uLightDir);
          float lit = smoothstep(-0.45, 0.85, ndl);
          lit *= mix(0.62, 1.0, smoothstep(-1.0, 0.4, vH));           // flatter, darker bases
          // silver lining when looking toward the light through thin edges
          float back = pow(max(dot(-vBack, uLightDir), 0.0), 6.0) * (1.0 - a) * 1.4;
          vec3 col = mix(uShade, uLit, lit) + uLit * back;
          gl_FragColor = vec4(col, a * uOpacity * vFade);
          #include <tonemapping_fragment>
          #include <encodings_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: true, fog: false,
    }));

    const clouds = [];
    (function buildClouds() {
      const rng = makeRng(0xc0ffee);
      const N = 15;
      for (let ci = 0; ci < N; ci++) {
        // tiers: high (above roof), mid (behind the house), low (below the board)
        const tier = ci % 3;
        const wid = 5 + rng() * 7, hgt = 1.8 + rng() * 2.4, dep = 2.5 + rng() * 3.5;
        const reach = wid * 0.5 + 3.2;                       // horizontal half-extent incl. puff radius
        let r, y;
        if (tier === 0) { y = 10 + rng() * 9; r = Math.max(14 + reach, 20 + rng() * 34); }
        else if (tier === 1) { y = 1 + rng() * 7; r = Math.max(14 + reach, 24 + rng() * 32); }
        else { y = -8 - rng() * 10; r = Math.max(14 + reach, 18 + rng() * 30); }
        const nP = 13 + Math.floor(rng() * 7);
        const pos = [], corner = [], puff = [], off = [];
        for (let p = 0; p < nP; p++) {
          const u = (p / (nP - 1)) * 2 - 1 + (rng() - 0.5) * 0.3;
          const x = u * wid * 0.5;
          const dome = 1 - u * u;
          const py = hgt * (0.1 + 0.8 * dome * Math.sqrt(rng())) * (p % 3 === 0 ? 0.35 : 1);   // some puffs fill the flat base
          const pz = (rng() - 0.5) * dep * (0.4 + 0.6 * dome);
          const size = (1.2 + rng() * 1.1) * (0.6 + 0.5 * dome) * (wid / 9 + 0.45);
          const cell = Math.floor(rng() * 4), rot = rng() * Math.PI * 2;
          const hN = clamp((py / hgt) * 2 - 1, -1, 1);
          for (let k = 0; k < 4; k++) {
            pos.push(x, py, pz);
            off.push(x / (wid * 0.5), (py - hgt * 0.4) / hgt, pz / (dep * 0.5 + 0.01));
            corner.push(k === 0 || k === 3 ? -1 : 1, k < 2 ? -1 : 1);
            puff.push(size, cell, rot, hN);
          }
        }
        const g = track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
        g.setAttribute('aPuff', new THREE.Float32BufferAttribute(puff, 4));
        g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 3));
        const idx = new Uint16Array(nP * 6);
        const ia = new THREE.BufferAttribute(idx, 1); ia.setUsage(THREE.DynamicDrawUsage);
        g.setIndex(ia);
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, hgt * 0.5, 0), wid * 0.5 + 6);
        const mesh = new THREE.Mesh(g, cloudMat);
        mesh.name = 'cloud' + ci;
        mesh.raycast = noRaycast;
        const c = {
          mesh, nP, idx, ia, order: new Array(nP).fill(0).map((_, i) => i), depth: new Float32Array(nP),
          centers: pos.filter((_, i) => i % 12 < 3), // first vertex of each puff (x,y,z)
          r, y0: y - hgt * 0.4, a0: rng() * Math.PI * 2,
          w: (0.004 + rng() * 0.006) * (rng() < 0.5 ? -1 : 1),     // slow orbit, rad/s
          bobA: 0.25 + rng() * 0.45, bobW: 0.15 + rng() * 0.2, bobP: rng() * 6.28,
          spin: rng() * Math.PI * 2,
        };
        clouds.push(c);
        root.add(mesh);
      }
    })();
    const _cw = new THREE.Vector3();
    function sortCloud(c, camPos) {
      const m = c.mesh.matrixWorld.elements;
      for (let p = 0; p < c.nP; p++) {
        const x = c.centers[p * 3], y = c.centers[p * 3 + 1], z = c.centers[p * 3 + 2];
        _cw.set(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        c.depth[p] = _cw.distanceToSquared(camPos);
      }
      c.order.sort((a, b) => c.depth[b] - c.depth[a]);   // far to near
      for (let k = 0; k < c.nP; k++) {
        const b = c.order[k] * 4, o = k * 6;
        c.idx[o] = b; c.idx[o + 1] = b + 1; c.idx[o + 2] = b + 2;
        c.idx[o + 3] = b; c.idx[o + 4] = b + 2; c.idx[o + 5] = b + 3;
      }
      c.ia.needsUpdate = true;
    }

    /* ================================================ FLOATING ISLAND */
    const linCol = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    const soilTopL = linCol(SOIL_TOP), soilBotL = linCol(SOIL_BOT);
    // strata, top to bottom (display sRGB -> linear, as vertex colours are linear in r128)
    const G = opts.ground && opts.ground.rim ? opts.ground : null;   // round, torn-edge ground disc
    const STRATA = [
      ...(G ? [
        { y: G.top + 0.02, c: linCol('#4a4a26') },                    // turf and roots
        { y: G.top - 0.14, c: soilTopL },                             // dark topsoil
        { y: -0.65, c: soilTopL.clone().lerp(soilBotL, 0.5) },
      ] : []),
      { y: B.bottom, c: soilBotL },
      { y: -1.45, c: soilBotL.clone().lerp(soilTopL, 0.45) },
      { y: -1.75, c: soilBotL.clone().multiplyScalar(0.85) },
      { y: -1.95, c: linCol('#4b4038') },
      { y: -2.15, c: linCol('#b48f62') },
      { y: -2.55, c: linCol('#a27c52') },
      { y: -2.85, c: linCol('#c09a6a') },
      { y: -3.05, c: linCol('#8c5a3a') },
      { y: -3.45, c: linCol('#857f78') },
      { y: -4.30, c: linCol('#77726b') },
      { y: -4.85, c: linCol('#c2a27a') },
      { y: -5.35, c: linCol('#a98a64') },
      { y: -5.6, c: linCol('#6c675f') },
      { y: -7.0, c: linCol('#5f5a54') },
      { y: -7.3, c: linCol('#7a5236') },
      { y: -8.1, c: linCol('#4a4541') },
      { y: -20, c: linCol('#3c3835') },
    ];
    function strataColor(y, out) {
      // stepped bands with short blends (crisp sedimentary layers)
      let i = 0;
      while (i < STRATA.length - 2 && y < STRATA[i + 1].y) i++;
      const a = STRATA[i], b = STRATA[i + 1];
      const span = a.y - b.y;
      const t = clamp((a.y - y) / span, 0, 1);
      const blend = smoothstep(0.72, 1.0, t);   // hold colour, blend in the last 28%
      return out.copy(a.c).lerp(b.c, blend);
    }

    // detail map (greyscale grain, pebbles, faint strata lines, cracks) used as map + bump
    function makeRockTexture() {
      const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
      const g = cv.getContext('2d'), rng = makeRng(0x70c4);
      g.fillStyle = 'rgb(214,214,214)'; g.fillRect(0, 0, S, S);
      const wrapDraw = (fn) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy); };
      for (let i = 0; i < 260; i++) {
        const x = rng() * S, y = rng() * S, r = 10 + rng() * 60, v = 150 + rng() * 105 | 0;
        wrapDraw((dx, dy) => {
          const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          gr.addColorStop(0, `rgba(${v},${v},${v},0.35)`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
          g.fillStyle = gr; g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
        });
      }
      for (let i = 0; i < 40; i++) {   // horizontal sediment lines
        const y = rng() * S, v = 150 + rng() * 80 | 0;
        g.strokeStyle = `rgba(${v},${v},${v},${0.15 + rng() * 0.25})`; g.lineWidth = 0.6 + rng() * 2.2;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= S; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 2.5 + (rng() - 0.5) * 2);
        g.stroke();
      }
      for (let i = 0; i < 900; i++) {  // pebbles
        const x = rng() * S, y = rng() * S, v = 120 + rng() * 135 | 0;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath(); g.ellipse(x, y, 1 + rng() * 4.5, 0.8 + rng() * 3, rng() * 3, 0, 7); g.fill();
      }
      g.strokeStyle = 'rgba(70,70,70,0.45)';
      for (let i = 0; i < 26; i++) {   // cracks
        let x = rng() * S, y = rng() * S; g.lineWidth = 0.6 + rng();
        g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 7; k++) { x += (rng() - 0.5) * 34; y += 6 + rng() * 22; g.lineTo(x, y); }
        g.stroke();
      }
      const d = g.getImageData(0, 0, S, S), a = d.data;
      for (let i = 0; i < a.length; i += 4) { const n = (rng() - 0.5) * 26; a[i] += n; a[i + 1] += n; a[i + 2] += n; }
      g.putImageData(d, 0, 0);
      // mean linear value, so vertex colours can be divided by it (lip == board soil)
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) { const v = a[i] / 255; sum += v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      rockTexMean = sum / (a.length / 4);
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return t;
    }
    let rockTexMean = 1;
    const rockTex = track(makeRockTexture());
    const texComp = 1 / rockTexMean;

    const islandGroup = new THREE.Group(); islandGroup.name = 'floatingIsland';
    root.add(islandGroup);

    // --- island profile -----------------------------------------------------
    const CX = G ? G.cx : (B.x0 + B.x1) / 2, CZ = G ? G.cz : (B.z0 + B.z1) / 2;
    const HX = G ? G.r : (B.x1 - B.x0) / 2, HZ = G ? G.r : (B.z1 - B.z0) / 2;
    const TOPY = G ? G.top : B.bottom, DEPTH = G ? 10.0 : 9.0;   // tip near y = -10.1
    const LIP = 0.03;                                        // first ~0.27 m drop straight down, flush with the board
    // perimeter samples placed per edge so the 4 corners are hit exactly
    const NX = 36, NZ = 28, M = G ? G.rim.length : 2 * (NX + NZ);
    const perim = [];                                        // {x,z} relative to centre, s = arc fraction
    if (G) (function () {
      // follow the host's torn rim exactly (clockwise seen from above)
      const pts = G.rim.map(([x, z]) => [x - CX, z - CZ]);
      let acc = 0, P = 0;
      for (let i = 0; i < pts.length; i++) { const [x, z] = pts[i], [nx, nz] = pts[(i + 1) % pts.length]; P += Math.hypot(nx - x, nz - z); }
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i], L = Math.hypot(x, z);
        perim.push({ x, z, dx: x / L, dz: z / L, L, Ls: G.r * 0.97, s: acc / P });
        const [nx, nz] = pts[(i + 1) % pts.length]; acc += Math.hypot(nx - x, nz - z);
      }
    })(); else (function () {
      const pts = [];
      for (let i = 0; i < NX; i++) pts.push([-HX + (2 * HX * i) / NX, HZ]);          // front edge (+z), -x -> +x
      for (let i = 0; i < NZ; i++) pts.push([HX, HZ - (2 * HZ * i) / NZ]);           // east edge, +z -> -z
      for (let i = 0; i < NX; i++) pts.push([HX - (2 * HX * i) / NX, -HZ]);          // back edge
      for (let i = 0; i < NZ; i++) pts.push([-HX, -HZ + (2 * HZ * i) / NZ]);         // west edge
      let acc = 0; const P = 4 * (HX + HZ);
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        const th = Math.atan2(z, x), L = Math.hypot(x, z);
        // rounded target shape: superellipse at the same angle
        const n = 2.6, c = Math.cos(th), s = Math.sin(th);
        const Ls = Math.pow(Math.pow(Math.abs(c / (HX * 0.98)), n) + Math.pow(Math.abs(s / (HZ * 0.98)), n), -1 / n);
        perim.push({ x, z, dx: x / L, dz: z / L, L, Ls, s: acc / P });
        const [nx, nz] = pts[(i + 1) % pts.length]; acc += Math.hypot(nx - x, nz - z);
      }
    })();

    const K = 52;                                            // rings top -> tip
    // shape function: radius scale vs depth fraction u (0 top, 1 tip)
    function taper(u) { return Math.pow(1 - u, 1.22) * (1 + 0.5 * u); }
    function ledge(u, dx, dz) {
      const g = (u * 5.2 + 0.35 * fbm(dx * 1.3 + 5, u * 2, dz * 1.3, 3)) % 1;
      return { k: 1 - 0.065 * smoothstep(0.1, 1.0, g), g };
    }
    // Returns world position of island surface at perimeter index i (wraps), depth t in [0,1]
    function islandPoint(i, t, out) {
      const p = perim[((i % M) + M) % M];
      const y0 = TOPY - t * DEPTH;
      if (t <= LIP) return out.set(CX + p.x, y0, CZ + p.z);
      const u = (t - LIP) / (1 - LIP);
      const L = lerp(p.L, p.Ls, smoothstep(0.0, 0.42, u));
      const amp = smoothstep(0.0, 0.1, u);
      const n1 = fbm(p.dx * 1.6 + 3.1, y0 * 0.42, p.dz * 1.6 - 2.3, 4) - 0.5;
      const n2 = vnoise(p.dx * 6.5 + 11, y0 * 1.6, p.dz * 6.5) - 0.5;
      const lg = ledge(u, p.dx, p.dz);
      let R = L * taper(u) * (u > 0.02 ? lg.k : 1) * (1 + amp * (n1 * 0.42 + n2 * 0.1));
      R = Math.max(R, 0);
      // centre drifts a little so the tip is not dead centre
      const cx = CX + 0.9 * u * u, cz = CZ - 0.6 * u * u;
      const yj = y0 + amp * (vnoise(p.dx * 4 + 1, y0 * 0.9, p.dz * 4) - 0.5) * 0.22;
      return out.set(cx + p.dx * R, yj, cz + p.dz * R);
    }
    const ringT = (k) => (k === 0 ? 0 : k === 1 ? LIP : LIP + (1 - LIP) * Math.pow((k - 1) / (K - 1), 1.08));

    (function buildCone() {
      const cols = M + 1, rows = K + 1;
      const pos = new Float32Array(cols * rows * 3), col = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
      const P = new THREE.Vector3(), c = new THREE.Color();
      const uRep = Math.round((G ? 2 * Math.PI * G.r : 4 * (HX + HZ)) / 2.6);    // integer repeats: no texture seam
      for (let k = 0; k < rows; k++) {
        const t = ringT(k), u = Math.max(0, (t - LIP) / (1 - LIP));
        for (let j = 0; j < cols; j++) {
          const i = j % M, p = perim[i];
          if (k === rows - 1) {                     // single jagged tip
            P.set(CX + 0.9 + p.dx * 0.06, TOPY - DEPTH - 0.35, CZ - 0.6 + p.dz * 0.06);
          } else islandPoint(i, t, P);
          const o = (k * cols + j) * 3;
          pos[o] = P.x; pos[o + 1] = P.y; pos[o + 2] = P.z;
          // strata colour with wobbly boundaries + mottling + ledge AO
          const yc = P.y + (fbm(p.dx * 2.2, P.y * 0.6, p.dz * 2.2 + 4, 3) - 0.5) * 0.45 * smoothstep(0, 0.05, u);
          strataColor(yc, c);
          const mott = 0.86 + 0.28 * fbm(p.dx * 5 + 9, P.y * 1.4, p.dz * 5, 3);
          const lg = u > 0.02 ? ledge(u, p.dx, p.dz).g : 0;
          const ao = 1 - 0.28 * smoothstep(0.75, 1.0, lg) - 0.18 * smoothstep(0.75, 1.0, u);
          c.multiplyScalar(mott * ao);
          if (t <= LIP && !G) c.copy(soilBotL);     // flush lip matches the board's soil cut exactly
          c.multiplyScalar(texComp);
          col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
          const ou = (k * cols + j) * 2;
          uv[ou] = (j === M ? 1 : p.s) * uRep; uv[ou + 1] = P.y / 2.6;
        }
      }
      const idx = [];
      for (let k = 0; k < rows - 1; k++) for (let j = 0; j < M; j++) {
        const a = k * cols + j, b = a + 1, c2 = a + cols, d = c2 + 1;
        // perimeter runs clockwise seen from above -> this winding faces outward
        idx.push(a, c2, b, b, c2, d);
      }
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // weld normals across the u-seam (column 0 == column M)
      const n = g.attributes.normal;
      for (let k = 0; k < rows; k++) {
        const a = k * cols, b = k * cols + M;
        const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
        const l = Math.hypot(x, y, z) || 1;
        n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
      }
      // the lip must shade like the board's vertical sides: force horizontal normals on ring 0/1
      for (let k = 0; k <= 1; k++) for (let j = 0; j < cols; j++) {
        const p = perim[j % M], a = k * cols + j;
        const ax = Math.abs(p.x) >= HX - 1e-6, az = Math.abs(p.z) >= HZ - 1e-6;
        let nx = G ? p.dx : ax ? Math.sign(p.x) : 0, nz = G ? p.dz : az ? Math.sign(p.z) : 0;
        const l = Math.hypot(nx, nz) || 1; n.setXYZ(a, nx / l, 0, nz / l);
      }
      const mat = track(new THREE.MeshStandardMaterial({
        vertexColors: true, map: rockTex, bumpMap: rockTex, bumpScale: 0.035, roughness: 0.95, metalness: 0.0,
      }));
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'islandCone';
      mesh.castShadow = true; mesh.receiveShadow = true;
      islandGroup.add(mesh);
    })();

    // --- helpers for merged details ------------------------------------------
    function mergeGeos(list) {
      let nV = 0, nI = 0;
      for (const g of list) { nV += g.attributes.position.count; nI += g.index ? g.index.count : g.attributes.position.count; }
      const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), col = new Float32Array(nV * 3);
      const idx = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
      let vo = 0, io = 0;
      for (const g of list) {
        const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv, c = g.attributes.color;
        pos.set(p.array, vo * 3); if (n) nor.set(n.array, vo * 3);
        if (t) uv.set(t.array, vo * 2);
        if (c) col.set(c.array, vo * 3); else col.fill(1, vo * 3, (vo + p.count) * 3);
        if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
        else for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
        vo += p.count;
        g.dispose();
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.setIndex(new THREE.BufferAttribute(idx, 1));
      return track(out);
    }
    function paint(g, color) {
      const n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = color.r; a[i * 3 + 1] = color.g; a[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    }
    // lumpy rock: icosahedron, jittered by a function of the original vertex position
    // (duplicated vertices of the non-indexed polyhedron move together), flat normals
    function rockGeo(rng, detail, lump) {
      const g = new THREE.IcosahedronGeometry(1, detail);
      const p = g.attributes.position, sd = Math.floor(rng() * 1000);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const k = 1 + (vnoise(x * 1.7 + sd, y * 1.7, z * 1.7) - 0.5) * lump;
        p.setXYZ(i, x * k, y * k, z * k);
      }
      g.computeVertexNormals();
      return g;
    }
    const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _e = new THREE.Euler();

    // --- protruding rocks + hanging stalactites (one draw call) --------------
    (function buildRocks() {
      const rng = makeRng(0x40c45);
      const list = [], P = new THREE.Vector3(), c = new THREE.Color();
      for (let r = 0; r < 44; r++) {
        const t = 0.16 + Math.pow(rng(), 0.9) * 0.7;
        const i = Math.floor(rng() * M);
        islandPoint(i, t, P);
        const p = perim[i];
        const sz = (0.25 + rng() * 0.6) * (1.05 - t * 0.5);
        const g = rockGeo(rng, rng() < 0.5 ? 0 : 1, 0.7);
        _s.set(sz * (0.8 + rng() * 0.9), sz * (0.5 + rng() * 0.7), sz * (0.8 + rng() * 0.9));
        _q.setFromEuler(_e.set(rng() * 3, rng() * 3, rng() * 3));
        // sit partly embedded, poking outward
        const out = sz * (0.05 + rng() * 0.25);
        _m.compose(new THREE.Vector3(P.x + p.dx * out, P.y - sz * 0.1, P.z + p.dz * out), _q, _s);
        g.applyMatrix4(_m);
        strataColor(P.y, c).multiplyScalar((0.78 + rng() * 0.35) * texComp);
        list.push(paint(g, c));
      }
      // stalactite spikes under the lower half, pointing down
      for (let s = 0; s < 16; s++) {
        const t = 0.55 + rng() * 0.36;
        const i = Math.floor(rng() * M);
        islandPoint(i, t, P);
        const p = perim[i];
        const h = 0.9 + rng() * 2.2, r0 = 0.22 + rng() * 0.45;
        const g = new THREE.ConeGeometry(r0, h, 5 + Math.floor(rng() * 3), 3);
        const pa = g.attributes.position;
        for (let v = 0; v < pa.count; v++) {
          const x = pa.getX(v), y = pa.getY(v), z = pa.getZ(v);
          const k = 1 + (vnoise(x * 3 + s, y * 2, z * 3) - 0.5) * 0.6;
          pa.setXYZ(v, x * k, y, z * k);
        }
        g.rotateX(Math.PI);                                  // apex down
        g.rotateZ((rng() - 0.5) * 0.35); g.rotateX((rng() - 0.5) * 0.35);
        const ng = g.toNonIndexed(); g.dispose(); ng.computeVertexNormals();
        ng.translate(P.x - p.dx * r0 * 0.4, P.y - h * 0.42, P.z - p.dz * r0 * 0.4);
        strataColor(P.y - h * 0.3, c).multiplyScalar((0.8 + rng() * 0.25) * texComp);
        list.push(paint(ng, c));
      }
      const g = mergeGeos(list);
      const mat = track(new THREE.MeshStandardMaterial({ vertexColors: true, map: rockTex, roughness: 0.92, flatShading: true }));
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'islandRocks';
      mesh.castShadow = false; mesh.receiveShadow = true;
      islandGroup.add(mesh);
    })();

    // --- dangling roots and vines (merged tubes) -----------------------------
    (function buildRoots() {
      const rng = makeRng(0x2007);
      const roots = [], vines = [], leaves = [];
      const P = new THREE.Vector3();
      const rootCol = linCol('#4a3524'), rootCol2 = linCol('#5e4430');
      const vineCol = linCol('#3f5f2a'), leafA = linCol('#5f8f3a'), leafB = linCol('#7aa648');

      function hangingCurve(i, t, len, wander) {
        islandPoint(i, t, P);
        const p = perim[i];
        // tangent along the edge for sideways sway
        const tx = -p.dz, tz = p.dx;
        const pts = [new THREE.Vector3(P.x - p.dx * 0.12, P.y + 0.02, P.z - p.dz * 0.12)];
        let x = P.x + p.dx * 0.1, y = P.y - 0.05, z = P.z + p.dz * 0.1;
        pts.push(new THREE.Vector3(x, y, z));
        const n = 5;
        for (let k = 1; k <= n; k++) {
          const f = k / n;
          const outw = 0.1 * (1 - f) + 0.03;
          const side = (rng() - 0.5) * wander;
          x += p.dx * outw + tx * side; z += p.dz * outw + tz * side; y -= len / n;
          pts.push(new THREE.Vector3(x, y, z));
        }
        return new THREE.CatmullRomCurve3(pts);
      }
      function taperTube(curve, r, segs, radial) {
        const g = new THREE.TubeGeometry(curve, segs, r, radial, false);
        const p = g.attributes.position, C = new THREE.Vector3(), V = new THREE.Vector3();
        for (let i = 0; i <= segs; i++) {
          curve.getPointAt(i / segs, C);
          const k = 1 - 0.85 * Math.pow(i / segs, 1.3);
          for (let j = 0; j <= radial; j++) {
            const vi = i * (radial + 1) + j;
            V.fromBufferAttribute(p, vi).sub(C).multiplyScalar(k).add(C);
            p.setXYZ(vi, V.x, V.y, V.z);
          }
        }
        g.computeVertexNormals();
        return g;
      }
      for (let r = 0; r < 18; r++) {
        const i = Math.floor(rng() * M);
        const curve = hangingCurve(i, LIP + 0.005 + rng() * 0.04, 0.9 + rng() * 2.4, 0.25);
        const g = taperTube(curve, 0.03 + rng() * 0.035, 18, 5);
        roots.push(paint(g, rng() < 0.5 ? rootCol : rootCol2));
        // a thinner side rootlet
        if (rng() < 0.6) {
          const a = curve.getPointAt(0.35), b = curve.getPointAt(0.6);
          const side = new THREE.CatmullRomCurve3([a, b.clone().add(new THREE.Vector3((rng() - 0.5) * 0.5, -0.3, (rng() - 0.5) * 0.5)),
            b.clone().add(new THREE.Vector3((rng() - 0.5) * 0.7, -0.9 - rng() * 0.6, (rng() - 0.5) * 0.7))]);
          roots.push(paint(taperTube(side, 0.014, 10, 4), rootCol));
        }
      }
      const leafGeo = (w, h) => { const g = new THREE.PlaneGeometry(w, h); g.translate(0, h * 0.5, 0); return g; };
      for (let v = 0; v < 8; v++) {
        const i = Math.floor(rng() * M);
        const len = 1.6 + rng() * 2.6;
        const curve = hangingCurve(i, LIP + 0.004 + rng() * 0.02, len, 0.4);
        vines.push(paint(taperTube(curve, 0.016, 24, 4), vineCol));
        const nL = Math.floor(len / 0.16);
        for (let l = 0; l < nL; l++) {
          const f = 0.06 + (l / nL) * 0.92;
          const at = curve.getPointAt(f);
          const s = 0.07 + 0.05 * (1 - f) + rng() * 0.03;
          const g = leafGeo(s * 0.8, s * 1.2);
          _q.setFromEuler(_e.set(rng() * 6.28, rng() * 6.28, rng() * 6.28));
          _m.compose(at, _q, _s.set(1, 1, 1)); g.applyMatrix4(_m);
          leaves.push(paint(g, rng() < 0.5 ? leafA : leafB));
        }
      }
      const rootMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
      const rootMesh = new THREE.Mesh(mergeGeos(roots.concat(vines)), rootMat);
      rootMesh.name = 'islandRoots';
      const leafMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
      const leafMesh = new THREE.Mesh(mergeGeos(leaves), leafMat);
      leafMesh.name = 'islandLeaves';
      for (const m of [rootMesh, leafMesh]) { m.castShadow = false; m.receiveShadow = true; m.raycast = noRaycast; islandGroup.add(m); }
    })();

    // --- tiny floating rock islets orbiting below ----------------------------
    const islets = [];
    const isletPivot = new THREE.Group(); isletPivot.position.set(CX, 0, CZ); islandGroup.add(isletPivot);
    (function buildIslets() {
      const rng = makeRng(0x151e7);
      const moss = linCol('#5f8a3c'), moss2 = linCol('#729a44');
      const isletMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, map: rockTex, roughness: 0.92, flatShading: true }));
      const c = new THREE.Color();
      for (let k = 0; k < 5; k++) {
        const size = 0.45 + rng() * 0.75;
        const g0 = new THREE.CylinderGeometry(1, 0.08, 1.6, 7, 3);
        const p = g0.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          const jt = vnoise(x * 2.1 + k * 7, y * 2.1, z * 2.1);
          const kx = 1 + (jt - 0.5) * 0.5;
          p.setXYZ(i, x * kx, y < 0.79 ? y + (jt - 0.5) * 0.25 : y, z * kx);
        }
        const g = g0.toNonIndexed(); g0.dispose(); g.computeVertexNormals();
        const n = g.attributes.normal, pp = g.attributes.position, col = new Float32Array(pp.count * 3);
        for (let i = 0; i < pp.count; i++) {
          const yy = pp.getY(i);
          if (n.getY(i) > 0.7 && yy > 0.6) c.copy(rng() < 0.5 ? moss : moss2).multiplyScalar(texComp);   // mossy cap
          else strataColor(-1.4 - (0.8 - yy) * 3.2, c).multiplyScalar((0.85 + rng() * 0.2) * texComp);
          col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.scale(size, size, size);
        track(g);
        const mesh = new THREE.Mesh(g, isletMat);
        mesh.name = 'islet' + k;
        mesh.castShadow = false; mesh.receiveShadow = true;
        const holder = new THREE.Group(); holder.add(mesh); isletPivot.add(holder);
        islets.push({
          holder, mesh, r: 8.5 + rng() * 4.5, a: (k / 5) * Math.PI * 2 + rng() * 0.6,
          y: -4.2 - rng() * 6.5, w: 0.02 + rng() * 0.025, bob: rng() * 6.28, spin: (rng() - 0.5) * 0.3,
        });
      }
    })();

    /* ====================================================== ENVIRONMENT */
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envMat = track(new THREE.ShaderMaterial({
      uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      defines: { ENV_PASS: 1 }, side: THREE.BackSide, depthWrite: false, depthTest: false,
    }));
    envScene.add(new THREE.Mesh(skyGeo, envMat));
    let envRT = null, lastEnvH = NaN, lastEnvT = -1e9;
    function regenEnv(hours, now) {
      const rt = pmrem.fromScene(envScene, 0.04, 0.1, 100);
      scene.environment = rt.texture;
      if (envRT) envRT.dispose();
      envRT = rt; lastEnvH = hours; lastEnvT = now;
    }

    /* ============================================================ UPDATE */
    const result = {
      sunDir: new THREE.Vector3(0, 1, 0), keyColor: new THREE.Color(), keyIntensity: 2.2,
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiIntensity: 0.4,
      exposure: 1.1, night: 0, envIntensity: 1,
    };
    const tmpA = new THREE.Color(), cloudLight = new THREE.Vector3();
    const sunColDisplay = new THREE.Color();
    let clock = 0;

    function update(hours, dt, elapsedSeconds) {
      hours = Number.isFinite(hours) ? hours : 12;
      dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      clock += dt;
      const now = Number.isFinite(elapsedSeconds) ? elapsedSeconds : clock;

      // --- celestial rotation (continuous) -------------------------------
      skyQuat.setFromAxisAngle(AXIS, phaseOf(hours));
      sunDir.copy(NOON).applyQuaternion(skyQuat);
      moonDir.copy(MOON0).applyQuaternion(skyQuat);
      stars.quaternion.copy(skyQuat);
      starRotInv.setFromMatrix4(_m4.makeRotationFromQuaternion(skyQuat)).transpose();
      const e = sunDir.y, me = moonDir.y;

      // --- lighting for the host -----------------------------------------
      const sunI = 2.2 * Math.pow(clamp((e + 0.03) / 0.48, 0, 1), 0.6);
      const moonI = 0.25 * smoothstep(0.0, 0.3, me) * (1 - smoothstep(-0.12, 0.0, e));
      if (sunI >= moonI) {
        result.sunDir.copy(sunDir);
        sampleTable(LIGHT, e, 'key', result.keyColor);
        result.keyIntensity = sunI;
      } else {
        result.sunDir.copy(moonDir);
        result.keyColor.copy(MOON_KEY);
        result.keyIntensity = moonI;
      }
      sampleTable(LIGHT, e, 'hemiSky', result.hemiSky);
      sampleTable(LIGHT, e, 'hemiGround', result.hemiGround);
      result.hemiIntensity = sampleTable(LIGHT, e, 'hemiI');
      const dayK = smoothstep(-0.15, 0.35, e);
      result.exposure = lerp(0.85, 1.1, dayK);
      result.night = 1 - smoothstep(-0.08, 0.1, e);
      result.envIntensity = lerp(0.7, 1.0, smoothstep(-0.2, 0.2, e));
      const exp = result.exposure;

      // --- sky uniforms ----------------------------------------------------
      skyU.uSunDir.value.copy(sunDir);
      skyU.uMoonDir.value.copy(moonDir);
      displayToScene(sampleTable(SKY, e, 'zen', tmpA), exp, skyU.uZenith.value);
      displayToScene(sampleTable(SKY, e, 'mid', tmpA), exp, skyU.uMid.value);
      displayToScene(sampleTable(SKY, e, 'hor', tmpA), exp, skyU.uHorizon.value);
      displayToScene(sampleTable(SKY, e, 'horSun', tmpA), exp, skyU.uHorizonSun.value);
      displayToScene(sampleTable(SKY, e, 'aby', tmpA), exp, skyU.uAbyss.value);
      skyU.uGlow.value.copy(sampleTable(SKY, e, 'glow', tmpA)).convertSRGBToLinear().multiplyScalar(2.2 / exp);
      skyU.uGlowAmt.value = sampleTable(SKY, e, 'glowAmt');
      skyU.uMidAmt.value = sampleTable(SKY, e, 'midAmt');
      // sun disc: warm near/under the horizon, white-gold in open space
      sunColDisplay.copy(sampleTable(LIGHT, Math.abs(e) < 0.25 ? e : 0.6, 'key', tmpA));
      skyU.uSunCol.value.copy(sunColDisplay).convertSRGBToLinear().multiplyScalar(e > -0.15 ? 9.0 : 6.0);
      skyU.uMoonCol.value.setRGB(0.86, 0.9, 1.0).multiplyScalar(1.15 / exp);
      skyU.uNight.value = result.night;
      skyU.uMW.value = 1 - smoothstep(-0.2, -0.05, e);
      skyU.uMoonVis.value = 0.45 + 0.55 * result.night;
      skyU.uExposure.value = exp;

      // --- stars ----------------------------------------------------------
      starU.uTime.value = now;
      starU.uVis.value = 1 - smoothstep(-0.14, 0.02, e);
      starU.uPR.value = renderer.getPixelRatio();

      // --- clouds ---------------------------------------------------------
      cloudLight.copy(e > -0.1 ? sunDir : moonDir);
      cloudU.uLightDir.value.copy(cloudLight);
      displayToScene(sampleTable(CLOUD, e, 'lit', tmpA), exp, cloudU.uLit.value);
      displayToScene(sampleTable(CLOUD, e, 'shade', tmpA), exp, cloudU.uShade.value);
      cloudU.uOpacity.value = sampleTable(CLOUD, e, 'op');
      const camPos = camera.getWorldPosition(tv);
      for (const c of clouds) {
        const a = c.a0 + now * c.w;
        c.mesh.position.set(Math.cos(a) * c.r, c.y0 + Math.sin(now * c.bobW + c.bobP) * c.bobA, Math.sin(a) * c.r);
        c.mesh.rotation.y = c.spin - a;            // keep the long axis roughly tangential
        c.mesh.updateMatrixWorld();
        sortCloud(c, camPos);
      }

      // --- islets -----------------------------------------------------------
      for (const s of islets) {
        const a = s.a + now * s.w;
        s.holder.position.set(Math.cos(a) * s.r, s.y + Math.sin(now * 0.5 + s.bob) * 0.35, Math.sin(a) * s.r);
        s.mesh.rotation.set(Math.sin(now * 0.3 + s.bob) * 0.08, now * s.spin, Math.cos(now * 0.27 + s.bob) * 0.08);
      }

      // --- environment reflections (throttled) -----------------------------
      const dh = Math.abs(hours - lastEnvH);
      if (!envRT || (dh > 0.15 && now - lastEnvT > 0.4) || (dh > 0.004 && now - lastEnvT > 1.2)) regenEnv(hours, now);

      return result;
    }

    function dispose() {
      scene.remove(root);
      if (scene.environment === (envRT && envRT.texture)) scene.environment = null;
      if (envRT) envRT.dispose();
      pmrem.dispose();
      for (const d of disposables) if (d && d.dispose) d.dispose();
      disposables.length = 0;
    }

    update(12, 0, 0);   // initialise uniforms + environment
    return { update, dispose, group: root, island: islandGroup };
  }

  window.LanaiSky = { create };
})();
