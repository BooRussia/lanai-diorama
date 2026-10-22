/* LanaiLighting: architectural-render lighting pass for the lanai diorama (three r128).
   create(CTX) runs once after the scene and the material modules; update(L,t,dt) runs every
   frame after the page's applyLight(L) and before rendering, and overrides the light values.

   What it does
   - Physically based light units (inverse-square falloff) so the soffit cans throw real
     scallops down the stucco and lamps make pools of light instead of flat washes.
   - A small "loggia GI" shader patch on lit standard materials: sky light (hemisphere + IBL)
     is occluded under the roof and the eaves, sunlit-courtyard bounce leaks in through the
     glass, and lamp bounce fills the room warmly after dark. Uniform driven, no extra lights.
   - Light budget is fixed at create time (no recompiles later): the table lamp and the two
     ceiling point lights are removed (the latter replaced by two downward cans), and one
     underwater pool light is added. Exterior decorative point lights are dropped on phones.
   - Sun shadow frustum fitted to the island, tighter bias, roof spots moved out of the roof
     group so removing the roof no longer changes the light count. */
(function () {
  'use strict';
  var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  var sstep = function (a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function create(CTX) {
    var THREE = CTX.THREE, scene = CTX.scene, renderer = CTX.renderer, M = CTX.M || {};
    var sun = CTX.sun, hemi = CTX.hemi, roof = CTX.roof, MOBILE = !!CTX.MOBILE;
    var D = CTX.dims || {};
    var PI = Math.PI;
    var Y0 = D.Y0 !== undefined ? D.Y0 : 0.06, WH = D.WH || 3.75, TH = D.TH || 0.3;
    var CEIL = D.CEIL || (Y0 + WH - 0.1), SOFFIT = D.SOFFIT || (Y0 + WH + 0.003);
    var RX0 = D.RX0 !== undefined ? D.RX0 : -4.2, RX1 = D.RX1 !== undefined ? D.RX1 : 4.2;
    var RZ0 = D.RZ0 !== undefined ? D.RZ0 : -3.5, RZ1 = D.RZ1 !== undefined ? D.RZ1 : 2.5;
    var WZ1 = D.WZ1 !== undefined ? D.WZ1 : -2.8;
    var POOL = CTX.POOL || { x0: -0.4, x1: 6.3, z0: 4.6, z1: 7.2, y: -0.9 };
    var GC = D.GC || { cx: 0, cz: 1.6, r: 10.6 };
    var LX0 = RX0 + TH, LX1 = RX1 - TH, LZ0 = RZ0 + TH, LZ1 = RZ1 - TH;
    var EAVE_X1 = 4.9, EAVE_Z1 = 3.2;
    var f = function (v) { v = +v; return (Math.round(v * 1000) / 1000).toFixed(3); };
    var TMP = new THREE.Vector3();

    /* ---------------------------------------------------------------- units */
    // Inverse-square falloff for the practical lights. Sun / hemisphere intensities are
    // multiplied by PI in update() so the daylight balance from the sky module is preserved.
    renderer.physicallyCorrectLights = true;

    /* ------------------------------------------------------ shared uniforms */
    var U = {
      uLgRoof: { value: 1 },             // 1 = roof on (sky occluded under it)
      uLgIblD: { value: 1 },             // global scale of diffuse IBL (sky fill)
      uLgIblS: { value: 1 },             // global scale of specular IBL
      uLgHemi: { value: 1 },             // extra scale of hemisphere fill
      uLgBounce: { value: new THREE.Color(0, 0, 0) }, // sunlit-courtyard bounce into the loggia
      uLgGlow: { value: new THREE.Color(0, 0, 0) },   // warm lamp bounce inside the loggia
      uLgEaveB: { value: new THREE.Color(0, 0, 0) }   // can-light bounce on the facade under the eaves
    };

    var VERT_DECL = 'varying vec3 vLgW;\n';
    var VERT_BODY = '\n{vec4 _lgw=vec4(transformed,1.0);\n#ifdef USE_INSTANCING\n_lgw=instanceMatrix*_lgw;\n#endif\nvLgW=(modelMatrix*_lgw).xyz;}\n';
    var FRAG_DECL = [
      'varying vec3 vLgW;',
      'uniform float uLgRoof,uLgIblD,uLgIblS,uLgHemi;',
      'uniform vec3 uLgBounce,uLgGlow,uLgEaveB;',
      'float lgBox(vec3 p,vec3 lo,vec3 hi,float s){vec3 a=smoothstep(lo-s,lo+s,p)*(1.0-smoothstep(hi-s,hi+s,p));return a.x*a.y*a.z;}'
    ].join('\n') + '\n';
    var FRAG_BODY = [
      '{',
      ' vec3 _wn=inverseTransformDirection(geometry.normal,viewMatrix);',
      ' vec3 _p=vLgW;',
      /* inside the roofed loggia (inner wall faces count as inside) */
      ' float _in=lgBox(_p,vec3(' + f(LX0 - 0.06) + ',-0.4,' + f(LZ0 - 0.06) + '),vec3(' + f(LX1 + 0.06) + ',' + f(CEIL + 0.06) + ',' + f(LZ1 + 0.06) + '),0.05)*uLgRoof;',
      ' float _dF=max(' + f(LZ1) + '-_p.z,0.0),_dS=max(' + f(LX1) + '-_p.x,0.0);',
      ' float _ef=exp(-_dF/1.5),_es=exp(-_dS/1.5);',
      ' float _open=_ef*(0.6+0.4*_wn.z)+0.75*_es*(0.6+0.4*_wn.x);',
      ' float _occ=mix(1.0,clamp(0.26+0.74*_open,0.0,1.0),_in);',
      /* exterior faces under the deep eave (front and right side of the loggia) */
      ' float _ev=max(lgBox(_p,vec3(' + f(RX0 - 0.3) + ',-0.2,' + f(RZ1 - 0.04) + '),vec3(' + f(EAVE_X1) + ',' + f(SOFFIT + 0.03) + ',' + f(EAVE_Z1) + '),0.03),',
      '   lgBox(_p,vec3(' + f(RX1 - 0.04) + ',-0.2,' + f(WZ1 + 0.6) + '),vec3(' + f(EAVE_X1) + ',' + f(SOFFIT + 0.03) + ',' + f(EAVE_Z1) + '),0.03))*(1.0-_in)*uLgRoof;',
      ' float _eh=smoothstep(' + f(Y0 + 0.4) + ',' + f(SOFFIT) + ',_p.y);',
      ' _occ*=1.0-_ev*0.5*_eh*(1.0-max(-_wn.y,0.0));',
      ' irradiance*=_occ*uLgHemi;',
      ' iblIrradiance*=_occ*uLgIblD;',
      ' radiance*=mix(1.0,_occ*_occ,_in)*mix(1.0,_occ,1.0-_in)*uLgIblS;',
      /* glossy things indoors reflect the warm room instead of the sky */
      ' radiance+=(uLgGlow+uLgBounce*0.45)*0.22*_in*(1.0-_occ);',
      /* light bounced off the sunlit courtyard through the glass: lights ceilings and outward faces */
      ' float _up=max(-_wn.y,0.0);',
      ' float _bw=_ef*(0.35+0.65*_up+0.35*max(_wn.z,0.0))+0.7*_es*(0.35+0.65*_up+0.35*max(_wn.x,0.0));',
      ' irradiance+=uLgBounce*_bw*_in;',
      /* warm inter-reflection from the lamps after dark; strongest on ceiling and upper walls */
      ' float _gy=0.55+0.45*_up+0.25*smoothstep(0.8,3.4,_p.y);',
      ' irradiance+=uLgGlow*_in*_gy;',
      /* soffit cans bouncing off the pavers back up onto the eave and the wall top */
      ' irradiance+=uLgEaveB*_ev*(0.4+0.6*_up+0.4*_eh);',
      '}'
    ].join('\n') + '\n';

    var patched = [], DISref = null;
    function patchMaterial(m) {
      if (!m || !m.isMeshStandardMaterial || m.userData.lgPatched) return;
      if (m.transparent) return; // glass / water / screens keep their own look
      m.userData.lgPatched = true;
      var prev = m.onBeforeCompile;
      var prevKey = '';
      try { prevKey = m.customProgramCacheKey ? String(m.customProgramCacheKey()) : ''; } catch (e) { prevKey = ''; }
      m.onBeforeCompile = function (sh, r) {
        if (typeof prev === 'function') { try { prev.call(this, sh, r); } catch (e) { console.warn('LT prev hook', e); } }
        if (sh.uniforms.uDis && !DISref) DISref = sh.uniforms.uDis;
        if (sh.fragmentShader.indexOf('#include <lights_fragment_end>') < 0) return;
        for (var k in U) sh.uniforms[k] = U[k];
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + VERT_DECL)
          .replace('#include <project_vertex>', '#include <project_vertex>' + VERT_BODY);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
          .replace('#include <lights_fragment_end>', FRAG_BODY + '#include <lights_fragment_end>');
      };
      m.customProgramCacheKey = function () { return prevKey + '|lanaiLGI1'; };
      m.needsUpdate = true;
      patched.push(m);
    }

    /* ---------------------------------------------- single-sided shadow casters */
    // Open planes / shells cast no shadow in r128 unless rendered double-sided into the map.
    var castSet = new Set();
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(function (m) {
        patchMaterial(m);
        if (o.castShadow && m && m.side === THREE.FrontSide && o.geometry &&
          /^(BufferGeometry|PlaneGeometry|PlaneBufferGeometry|ShapeGeometry|ShapeBufferGeometry)$/.test(o.geometry.type) && !castSet.has(m)) {
          castSet.add(m); m.shadowSide = THREE.DoubleSide;
        }
      });
    });

    /* ------------------------------------------------------------- the sun */
    var SH = { cx: GC.cx || 0, cz: GC.cz || 1.6, r: Math.max(9, (GC.r || 10.6) + 0.9) };
    sun.target.position.set(SH.cx, 2.0, SH.cz); sun.target.updateMatrixWorld();
    var sc = sun.shadow.camera;
    sc.left = -SH.r; sc.right = SH.r; sc.top = SH.r; sc.bottom = -SH.r;
    sc.near = 40 - SH.r - 6; sc.far = 40 + SH.r + 4; sc.updateProjectionMatrix();
    sun.shadow.bias = -0.00025; sun.shadow.normalBias = MOBILE ? 0.02 : 0.014;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    /* ------------------------------------------------------- practical lights */
    var spots = (CTX.spots || []).slice(), lamps = (CTX.lampLights || []).slice();
    var ceilHalos = [];
    var holder = new THREE.Group(); holder.name = 'lanai-lighting'; scene.add(holder);
    // keep halos of lights we remove, parked at the light's position
    function retire(l) {
      l.updateMatrixWorld(true);
      var p = l.getWorldPosition(new THREE.Vector3());
      var kids = l.children.slice();
      if (kids.length) { var g = new THREE.Group(); g.position.copy(p); holder.add(g); kids.forEach(function (k) { g.add(k); }); if (p.y > CEIL - 0.5) ceilHalos.push(g); }
      if (l.parent) l.parent.remove(l);
    }
    // soffit cans: out of the roof group (no light-count change when the roof is removed)
    var soffit = [], roofSpots = [];
    spots.forEach(function (s) {
      var inRoof = false; for (var q = s.parent; q; q = q.parent) if (q === roof) inRoof = true;
      if (inRoof) { scene.attach(s); scene.attach(s.target); roofSpots.push(s); }
      s.updateMatrixWorld(true);
      var p = s.getWorldPosition(new THREE.Vector3());
      // aim almost straight down, a touch away from the wall: crisp scallop that grazes the stucco
      var side = p.x > RX1 + 0.1 && p.z < RZ1;
      var tx = p.x + (side ? 0.12 : 0), tz = p.z + (side ? 0 : 0.12);
      s.target.position.set(tx, 0, tz); if (s.target.parent) s.target.parent.worldToLocal(s.target.position);
      s.target.updateMatrixWorld(true);
      s.angle = 0.6; s.penumbra = 0.55; s.decay = 2; s.distance = 9;
      s.color.set('#ffd29c');
      s.castShadow = false;
      soffit.push({ l: s, roof: inRoof, wing: p.z < RZ0 + 1.2 });
    });

    var cls = { floor: [], chand: [], ext: [] }, removed = 0;
    lamps.forEach(function (l) {
      l.updateMatrixWorld(true);
      var p = l.getWorldPosition(new THREE.Vector3());
      var inside = p.x > LX0 - 0.1 && p.x < LX1 + 0.1 && p.z > LZ0 - 0.1 && p.z < LZ1 + 0.1;
      l.decay = 2; l.castShadow = false;
      if (inside && p.y > CEIL - 0.5) { retire(l); removed++; return; }           // ceiling fill points
      if (inside && p.y < Y0 + 1.2 && l.distance && l.distance <= 3) { retire(l); removed++; return; } // table lamp
      if (inside && Math.abs(p.y - (CEIL - 0.95)) < 0.3) { l.distance = 7; l.color.set('#ffc488'); cls.chand.push(l); return; }
      if (inside) { l.distance = 7; l.color.set('#ffc68c'); cls.floor.push(l); return; }
      if (MOBILE) { retire(l); removed++; return; }
      l.distance = 4.5; l.color.set('#ffcf94'); cls.ext.push(l);
    });
    // interior downlights (stand-ins for the six ceiling cans), aimed straight down
    var downs = [[1.75, -0.75], [-1.55, -1.1]].map(function (xz) {
      var s = new THREE.SpotLight('#ffd6a6', 0, 9, 1.05, 0.7, 2);
      s.position.set(xz[0], CEIL - 0.04, xz[1]); s.target.position.set(xz[0], 0, xz[1]);
      holder.add(s); holder.add(s.target); return s;
    });
    // underwater pool light in the far (camera-side) wall, shining back toward the house
    var px = (POOL.x0 + POOL.x1) / 2, pz1 = POOL.z1, pz0 = POOL.z0;
    var poolL = new THREE.SpotLight('#7fe0ff', 0, 4.2, 1.05, 0.8, 2);
    poolL.position.set(px, -0.55, pz1 - 0.12); poolL.target.position.set(px, POOL.y + 0.1, pz0 + 0.3);
    holder.add(poolL); holder.add(poolL.target);

    /* -------------------------------------------- halos and the pool surface */
    var haloMat = null, spotHalos = [];
    soffit.forEach(function (s) { s.l.children.forEach(function (k) { if (k.isSprite) { haloMat = haloMat || k.material; if (s.roof) spotHalos.push(k); } }); });
    if (!haloMat) scene.traverse(function (o) { if (!haloMat && o.isSprite && o.material && o.material.blending === THREE.AdditiveBlending) haloMat = o.material; });
    var poolSurf = null;
    scene.traverse(function (o) { if (!poolSurf && o.isMesh && o.material && o.material.uniforms && o.material.uniforms.tRefl && o.material.uniforms.uDeep) poolSurf = o; });
    var deepDay = poolSurf ? poolSurf.material.uniforms.uDeep.value.clone() : null;
    var deepNight = new THREE.Color('#1386a8');

    /* ------------------------------------------------------- per-frame state */
    var kc = new THREE.Color(), warmC = new THREE.Color(1.0, 0.6, 0.3), moonTint = new THREE.Color('#8fb0ff');
    var glowC = new THREE.Color('#ffa85e'), creamC = new THREE.Color('#ffe2b8'), tmpC = new THREE.Color();
    var warned = 0;
    // glass reflections are balanced against the lit interior at dusk (multiplier on the material's own value)
    var glassMats = [M.glass, M.glassClear].filter(function (m) { return m && m.envMapIntensity !== undefined; });
    var glassBase = glassMats.map(function (m) { return m.envMapIntensity; });
    var emBase = {};
    ['can', 'bulb', 'shade', 'candle'].forEach(function (k) { if (M[k]) emBase[k] = M[k].emissiveIntensity; });

    function update(L, t, dt) {
      if (!L) return;
      try {
        /* --- where is the sun? (sky module gives the moon as the key at night) --- */
        var kI = L.keyIntensity || 0, kCol = L.keyColor;
        var isMoon = kCol && (kCol.b > kCol.r + 0.05);
        var night = clamp(L.night || 0, 0, 1);
        var e;
        if (!isMoon && kI > 0.002) e = 0.48 * Math.pow(kI / 2.2, 1 / 0.6) - 0.03;
        else e = night >= 0.999 ? -0.2 : lerp(0.1, -0.08, night);
        var day = sstep(-0.04, 0.12, e);             // 0 at night .. 1 in daylight
        var dusk = 1 - sstep(0.12, 0.3, e);          // practical lights on (architectural dusk)
        var gold = isMoon ? 0 : (1 - sstep(0.1, 0.45, e)) * sstep(-0.03, 0.03, e);
        var roofF = 1;
        if (DISref) roofF = 1 - clamp(DISref.value, 0, 1);
        if (!roof.visible) roofF = 0;

        /* --- key light --- */
        kc.copy(kCol);
        if (isMoon) {
          kc.lerp(moonTint, 0.3);
          sun.intensity = kI * PI * 1.5;
        } else {
          kc.lerp(warmC, 0.45 * gold);
          var noonK = sstep(0.3, 0.8, e);
          sun.intensity = kI * PI * (1.0 + 0.3 * gold) * lerp(1.0, 0.9, noonK);
        }
        sun.color.copy(kc);

        /* --- sky fill: keep it soft so lit stucco never clips and shadows stay readable --- */
        var hI = L.hemiIntensity || 0;
        hemi.intensity = hI * PI * lerp(lerp(0.95, 0.72, day), 0.55, gold * 0.5) * lerp(1, 0.85, dusk * day);
        if (night > 0.5) hemi.color.lerp(moonTint, 0.25 * night);
        U.uLgIblD.value = lerp(lerp(0.7, 0.62, day), 0.55, gold * 0.6) * lerp(1, 0.85, dusk * day);
        U.uLgIblS.value = lerp(1.05, 0.9, day);
        U.uLgHemi.value = 1;
        U.uLgRoof.value = roofF;
        renderer.toneMappingExposure = (L.exposure || 1) * lerp(lerp(1.02, 0.78, day), 0.93, gold);

        /* --- loggia bounce: sunlit pavers into the room --- */
        var sunUp = isMoon ? 0 : Math.max(0, L.sunDir ? L.sunDir.y : 0);
        var bk = kI * PI * sunUp * 0.34 * 0.55;
        U.uLgBounce.value.copy(kc).multiplyScalar(bk);
        // plus a little of the sky itself reflected off the pavers
        tmpC.copy(L.hemiSky || kc).multiplyScalar(hI * PI * 0.12 * day);
        U.uLgBounce.value.add(tmpC);

        /* --- practical lights --- */
        var on = dusk;                              // master dimmer for the house lights
        var lampK = on * (MOBILE ? 1.1 : 1.0);
        soffit.forEach(function (s) {
          var k = s.roof ? roofF : 1;
          s.l.intensity = (s.wing ? 10 : 28) * on * k;
        });
        cls.floor.forEach(function (l) { l.intensity = 8.0 * lampK; });
        cls.chand.forEach(function (l) { l.intensity = 6.0 * lampK; });
        cls.ext.forEach(function (l) { l.intensity = 2.2 * on; });
        downs.forEach(function (s) { s.intensity = 24 * lampK * roofF; });
        poolL.intensity = 9 * sstep(0.1, 0.0, e) * (isMoon || e < 0.1 ? 1 : 0);
        U.uLgGlow.value.copy(glowC).multiplyScalar(PI * 0.3 * lampK * (0.45 + 0.55 * roofF));
        // daytime inter-reflection between the cream walls, floor and ceiling
        U.uLgGlow.value.add(tmpC.copy(creamC).multiplyScalar(kI * PI * sunUp * 0.11));
        U.uLgEaveB.value.copy(glowC).multiplyScalar(PI * 0.2 * on);

        /* --- fixture glow (emissive only) --- */
        if (M.can) M.can.emissiveIntensity = 0.25 + 3.2 * on;
        if (M.bulb) M.bulb.emissiveIntensity = 0.3 + 3.4 * on;
        if (M.shade) M.shade.emissiveIntensity = 0.15 + 1.6 * on;
        if (M.candle) M.candle.emissiveIntensity = 0.1 + 0.7 * on;
        if (haloMat) haloMat.opacity = 0.75 * on;
        var gk = lerp(1, 0.45, on * day);
        glassMats.forEach(function (m, i) { m.envMapIntensity = glassBase[i] * gk; });
        spotHalos.forEach(function (h) { h.visible = roofF > 0.5; });
        ceilHalos.forEach(function (h) { h.visible = roofF > 0.5; });
        if (poolSurf && deepDay) poolSurf.material.uniforms.uDeep.value.copy(deepDay).lerp(deepNight, sstep(0.08, -0.05, e) * 0.85);
      } catch (err) {
        if (warned++ < 3) console.warn('LT update', err);
      }
    }

    try { console.log('LT ready: patched=' + patched.length + ' removed=' + removed + ' spots=' + soffit.length + ' floor=' + cls.floor.length + ' chand=' + cls.chand.length + ' ext=' + cls.ext.length); } catch (e) { }
    return { update: update, uniforms: U };
  }

  window.LanaiLighting = {
    create: function (CTX) {
      try { return create(CTX); }
      catch (err) {
        console.error('LanaiLighting.create failed', err);
        try { CTX.renderer.physicallyCorrectLights = false; } catch (e) { }
        return { update: function () { } };
      }
    }
  };
})();
