/* LanaiPost: photographic finishing for the lanai diorama (three.js r128, no dependencies).
 *
 *   POST = LanaiPost.create(CTX);   POST.render(L, dt) every frame instead of renderer.render;  POST.setSize(w, h) on resize.
 *
 * Pipeline (all self-contained; no EffectComposer / example scripts needed):
 *   1. scene  -> sRGB-encoded colour target (4x MSAA on WebGL2, else plain + FXAA in the finish pass),
 *                with a DepthTexture when ambient occlusion is on (desktop only).
 *   2. AO      (desktop): half-res depth-only SSAO (normals rebuilt from depth), two depth-aware blur passes.
 *   3. bloom:  soft-knee bright pass -> dual-filter (Kawase) down/up mip chain.  The chain also carries a
 *              wide blurred luminance in alpha, used for gentle local contrast ("clarity").
 *   4. finish: AO (depth-aware upsample), clarity, bloom (screen blend), filmic S-curve, saturation,
 *              split-tone (cool shadows / warm highlights), vignette, mild sharpening, dither + grain.
 * Anything that throws falls back permanently to renderer.render(scene, camera).
 */
(function () {
  'use strict';

  var VERT = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';

  /* ---------------- shaders ---------------- */

  // bright pass + first downsample (4 bilinear taps = 4x4 texel box); alpha = average luminance (for clarity)
  var PREFILTER_FS = [
    'uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uTh,uKnee;varying vec2 vUv;',
    'vec4 bp(vec2 uv){vec3 c=texture2D(tSrc,uv).rgb;float br=max(c.r,max(c.g,c.b));',
    '  float w=smoothstep(uTh,uTh+uKnee,br);w*=w;float l=dot(c,vec3(0.2126,0.7152,0.0722));return vec4(c*w,l);}',
    'void main(){vec2 o=uTexel;',
    '  vec4 s=bp(vUv+vec2(-o.x,-o.y))+bp(vUv+vec2(o.x,-o.y))+bp(vUv+vec2(-o.x,o.y))+bp(vUv+vec2(o.x,o.y));',
    '  gl_FragColor=s*0.25;}'
  ].join('\n');

  // dual-filter downsample
  var DOWN_FS = [
    'uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;',
    'void main(){vec2 o=uTexel;',
    '  vec4 s=texture2D(tSrc,vUv)*4.0;',
    '  s+=texture2D(tSrc,vUv+vec2(-o.x,-o.y));s+=texture2D(tSrc,vUv+vec2(o.x,-o.y));',
    '  s+=texture2D(tSrc,vUv+vec2(-o.x,o.y));s+=texture2D(tSrc,vUv+vec2(o.x,o.y));',
    '  gl_FragColor=s*0.125;}'
  ].join('\n');

  // dual-filter (tent) upsample of the coarser level, blended as a normalised weighted average with this level
  var UP_FS = [
    'uniform sampler2D tCoarse,tFine;uniform vec2 uTexel;uniform float uMix;varying vec2 vUv;',
    'void main(){vec2 o=uTexel;',
    '  vec4 s=texture2D(tCoarse,vUv+vec2(-2.0*o.x,0.0));s+=texture2D(tCoarse,vUv+vec2(2.0*o.x,0.0));',
    '  s+=texture2D(tCoarse,vUv+vec2(0.0,-2.0*o.y));s+=texture2D(tCoarse,vUv+vec2(0.0,2.0*o.y));',
    '  s+=texture2D(tCoarse,vUv+vec2(-o.x,-o.y))*2.0;s+=texture2D(tCoarse,vUv+vec2(o.x,-o.y))*2.0;',
    '  s+=texture2D(tCoarse,vUv+vec2(-o.x,o.y))*2.0;s+=texture2D(tCoarse,vUv+vec2(o.x,o.y))*2.0;',
    '  s*=1.0/12.0;',
    '  gl_FragColor=mix(texture2D(tFine,vUv),s,uMix);}'
  ].join('\n');

  // depth helpers shared by the AO shaders
  var DEPTH_GLSL = [
    'precision highp sampler2D;',
    'uniform sampler2D tDepth;uniform mat4 uProjInv;uniform float uNear,uFar;uniform vec2 uDepthSize;',
    // snap to depth-texel centres so reconstructed positions match the depth actually fetched (else slanted planes band)
    'vec2 snapUV(vec2 uv){return (floor(uv*uDepthSize)+0.5)/uDepthSize;}',
    'float rawD(vec2 uv){return texture2D(tDepth,uv).x;}',
    'vec3 posAt(vec2 uv,out float d){uv=snapUV(uv);d=rawD(uv);vec4 p=uProjInv*vec4(vec3(uv,d)*2.0-1.0,1.0);return p.xyz/p.w;}',
    'float viewZ(float d){return (uNear*uFar)/((uFar-uNear)*d-uFar);}',
    'vec3 viewPos(vec2 uv,float d){vec4 p=uProjInv*vec4(vec3(uv,d)*2.0-1.0,1.0);return p.xyz/p.w;}'
  ].join('\n');

  // screen-space ambient occlusion from depth only (horizon-style: N.v with a cosine bias and radial falloff)
  var AO_FS = [
    DEPTH_GLSL,
    'uniform vec2 uFullTexel,uTexel;uniform float uRadius,uProjScale,uIntensity,uMaxDist;varying vec2 vUv;',
    '#define NS 12',
    'float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(0.06711056,0.00583715))));}',
    'void main(){',
    '  float d,dd;vec3 P=posAt(vUv,d);float z=-P.z;',
    '  if(d>=0.99999){gl_FragColor=vec4(1.0);return;}',
    '  if(z>uMaxDist){gl_FragColor=vec4(1.0);return;}',
    '  vec2 tx=vec2(uFullTexel.x,0.0),ty=vec2(0.0,uFullTexel.y);',
    '  vec3 Pr=posAt(vUv+tx,dd),Pl=posAt(vUv-tx,dd),Pu=posAt(vUv+ty,dd),Pd=posAt(vUv-ty,dd);',
    // central difference on continuous surfaces (less noise), one-sided at depth edges
    '  float er=abs(Pr.z-P.z),el=abs(P.z-Pl.z),eu=abs(Pu.z-P.z),ed=abs(P.z-Pd.z);',
    '  vec3 dx=abs(er-el)<0.1*min(er,el)+0.002*z?(Pr-Pl)*0.5:(er<el?Pr-P:P-Pl);',
    '  vec3 dy=abs(eu-ed)<0.1*min(eu,ed)+0.002*z?(Pu-Pd)*0.5:(eu<ed?Pu-P:P-Pd);',
    '  vec3 N=normalize(cross(dx,dy));',
    '  float R=uRadius,R2=R*R;',
    '  float rPx=min(R*uProjScale/z,90.0);',
    '  if(rPx<1.5){gl_FragColor=vec4(1.0);return;}',
    '  float ang=ign(gl_FragCoord.xy)*6.2831853;float jit=ign(gl_FragCoord.yx+17.0);',
    '  float sum=0.0;',
    '  for(int i=0;i<NS;i++){',
    '    float fi=(float(i)+jit)/float(NS);',
    '    float a=ang+float(i)*2.3999632;',          // golden-angle spiral
    '    vec2 off=vec2(cos(a),sin(a))*max(fi*fi*rPx,1.0)*uTexel;',
    '    vec2 suv=vUv+off;',
    '    float sd;vec3 Q=posAt(suv,sd);',
    '    if(sd>=0.99999)continue;',
    '    vec3 v=Q-P;float vv=dot(v,v);',
    '    if(vv<z*z*1e-5)continue;',
    '    float ndv=dot(N,v)*inversesqrt(vv+1e-5);',
    '    float fall=clamp(1.0-vv/R2,0.0,1.0);',
    '    sum+=max(ndv-0.15,0.0)*fall;}',
    '  float ao=clamp(1.0-sum*uIntensity/float(NS),0.0,1.0);',
    '  ao=mix(ao,1.0,smoothstep(uMaxDist*0.7,uMaxDist,z));',
    '  gl_FragColor=vec4(ao,ao,ao,1.0);}'
  ].join('\n');

  // separable depth-aware blur of the AO term
  var AOBLUR_FS = [
    DEPTH_GLSL,
    'uniform sampler2D tAO;uniform vec2 uDir;varying vec2 vUv;',
    'void main(){',
    '  float zc=viewZ(rawD(vUv));float s=0.0,ws=0.0;',
    '  for(int i=-4;i<=4;i++){',
    '    vec2 uv=vUv+uDir*float(i);',
    '    float z=viewZ(rawD(uv));',
    '    float w=exp(-float(i*i)*0.08)*exp(-abs(z-zc)/(0.02*abs(zc)+0.01)*2.0);',
    '    s+=texture2D(tAO,uv).r*w;ws+=w;}',
    '  float ao=s/max(ws,1e-4);gl_FragColor=vec4(ao,ao,ao,1.0);}'
  ].join('\n');

  function finishFS(opt) {
    return [
      opt.ao ? '#define USE_AO' : '',
      opt.fxaa ? '#define USE_FXAA' : '',
      opt.ao ? DEPTH_GLSL : '',
      'uniform sampler2D tScene,tBloom,tAO;',
      'uniform vec2 uTexel,uAOTexel,uRes;',
      'uniform float uView,uBloom,uClarity,uContrast,uSat,uSplit,uVig,uGrain,uSharpen,uTime,uAOStr,uAspect;',
      'uniform vec3 uBloomTint;',
      'varying vec2 vUv;',
      'float luma(vec3 c){return dot(c,vec3(0.2126,0.7152,0.0722));}',
      'float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}',
      '#ifdef USE_FXAA',
      'vec3 fxaa(vec2 uv){',
      '  vec2 r=uTexel;vec3 W=vec3(0.299,0.587,0.114);',
      '  vec3 rgbNW=texture2D(tScene,uv+vec2(-1.0,-1.0)*r).rgb,rgbNE=texture2D(tScene,uv+vec2(1.0,-1.0)*r).rgb;',
      '  vec3 rgbSW=texture2D(tScene,uv+vec2(-1.0,1.0)*r).rgb,rgbSE=texture2D(tScene,uv+vec2(1.0,1.0)*r).rgb;',
      '  vec3 rgbM=texture2D(tScene,uv).rgb;',
      '  float lNW=dot(rgbNW,W),lNE=dot(rgbNE,W),lSW=dot(rgbSW,W),lSE=dot(rgbSE,W),lM=dot(rgbM,W);',
      '  float lMin=min(lM,min(min(lNW,lNE),min(lSW,lSE))),lMax=max(lM,max(max(lNW,lNE),max(lSW,lSE)));',
      '  vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),((lNW+lSW)-(lNE+lSE)));',
      '  float red=max((lNW+lNE+lSW+lSE)*(0.25/8.0),1.0/128.0);',
      '  float rcp=1.0/(min(abs(dir.x),abs(dir.y))+red);',
      '  dir=clamp(dir*rcp,vec2(-8.0),vec2(8.0))*r;',
      '  vec3 A=0.5*(texture2D(tScene,uv+dir*(1.0/3.0-0.5)).rgb+texture2D(tScene,uv+dir*(2.0/3.0-0.5)).rgb);',
      '  vec3 B=A*0.5+0.25*(texture2D(tScene,uv+dir*-0.5).rgb+texture2D(tScene,uv+dir*0.5).rgb);',
      '  float lB=dot(B,W);return (lB<lMin||lB>lMax)?A:B;}',
      '#endif',
      '#ifdef USE_AO',
      // depth-aware bilinear upsample of the half-res AO
      'float aoUp(vec2 uv){',
      '  float zc=viewZ(rawD(uv));',
      '  vec2 p=uv/uAOTexel-0.5;vec2 f=fract(p);vec2 b=(floor(p)+0.5)*uAOTexel;',
      '  float s=0.0,ws=0.0;',
      '  for(int j=0;j<2;j++)for(int i=0;i<2;i++){',
      '    vec2 o=vec2(float(i),float(j));vec2 tuv=b+o*uAOTexel;',
      '    float bw=(i==0?1.0-f.x:f.x)*(j==0?1.0-f.y:f.y)+1e-3;',
      '    float z=viewZ(rawD(tuv));',
      '    float w=bw/(abs(z-zc)/(0.015*abs(zc)+0.005)+0.05);',
      '    s+=texture2D(tAO,tuv).r*w;ws+=w;}',
      '  return s/ws;}',
      '#endif',
      'void main(){',
      '  vec2 uv=vUv;',
      '  vec4 src=texture2D(tScene,uv);',
      '#ifdef USE_FXAA',
      '  vec3 c=fxaa(uv);',
      '#else',
      '  vec3 c=src.rgb;',
      '  vec3 nb=texture2D(tScene,uv+vec2(uTexel.x,0.0)).rgb+texture2D(tScene,uv-vec2(uTexel.x,0.0)).rgb',
      '         +texture2D(tScene,uv+vec2(0.0,uTexel.y)).rgb+texture2D(tScene,uv-vec2(0.0,uTexel.y)).rgb;',
      '  vec3 dtl=c-nb*0.25;',
      '  c=clamp(c+clamp(dtl,-0.06,0.06)*uSharpen,0.0,1.0);',
      '#endif',
      '  float l=luma(c);',
      '#ifdef USE_AO',
      '  float ao=aoUp(uv);',
      '  float aoK=uAOStr*(1.0-0.55*smoothstep(0.62,0.98,l));',   // keep bright / emissive areas clean
      '  c*=mix(1.0,ao,aoK);',
      '  l=luma(c);',
      '#endif',
      '  vec4 bl=texture2D(tBloom,uv);',
      // clarity: local contrast against a wide luminance blur, strongest in the midtones
      '  float dl=clamp(l-bl.a,-0.18,0.18);',
      '  float mid=smoothstep(0.02,0.25,l)*(1.0-smoothstep(0.75,1.0,l));',
      '  c*=1.0+uClarity*mid*dl/(l+0.12);',
      // bloom (screen blend so highlights glow without clipping)
      '  vec3 b=clamp(bl.rgb*uBloom*uBloomTint,0.0,1.0);',
      '  c=1.0-(1.0-clamp(c,0.0,1.0))*(1.0-b);',
      // filmic S-curve (pivot 0.5, endpoints fixed)
      '  c=mix(c,c*c*(3.0-2.0*c),uContrast);',
      // saturation
      '  l=luma(c);c=mix(vec3(l),c,uSat);',
      // split tone: cool lifted shadows, warm highlights
      '  float sh=1.0-smoothstep(0.0,0.45,l),hi=smoothstep(0.55,1.0,l);',
      '  c+=vec3(-0.010,0.000,0.016)*sh*uSplit;',
      '  c*=mix(vec3(1.0),vec3(1.012,1.0,0.982),hi*uSplit);',
      // vignette
      '  vec2 q=(uv-0.5)*vec2(uAspect,1.0);float vg=smoothstep(0.35,1.15,length(q)/max(1.0,uAspect*0.75));',
      '  c*=1.0-uVig*vg;',
      // dither + fine grain (triangular, luminance weighted)
      '  vec2 fc=gl_FragCoord.xy;float t=fract(uTime*7.31);',
      '  float n=hash(fc+t*113.0)+hash(fc.yx*1.37+t*71.0)-1.0;',
      '  c+=n*(1.0/255.0+uGrain*(0.35+0.65*sqrt(max(l,0.0)))*(1.0-l*0.6));',
      '  gl_FragColor=vec4(clamp(c,0.0,1.0),max(src.a,max(b.r,max(b.g,b.b))));',
      '#ifdef USE_AO',
      '  if(uView>1.5)gl_FragColor=vec4(vec3(fract(-viewZ(rawD(uv))*10.0)),1.0);',
      '  else if(uView>0.5)gl_FragColor=vec4(vec3(aoUp(uv)),1.0);',
      '#endif',
      '}'
    ].join('\n');
  }

  /* ---------------- module ---------------- */

  function create(CTX) {
    var THREE = CTX.THREE || window.THREE;
    var renderer = CTX.renderer, scene = CTX.scene, camera = CTX.camera, controls = CTX.controls;
    var MOBILE = !!CTX.MOBILE;
    var caps = renderer.capabilities, isGL2 = !!caps.isWebGL2;
    var ext = renderer.extensions;
    function has(n) { try { return !!ext.get(n); } catch (e) { return false; } }

    var opts = {
      msaa: isGL2 && !!THREE.WebGLMultisampleRenderTarget,
      ao: !MOBILE && (isGL2 || has('WEBGL_depth_texture')) && !!THREE.DepthTexture,
      halfFloat: isGL2 ? has('EXT_color_buffer_float') : (has('OES_texture_half_float') && has('EXT_color_buffer_half_float'))
    };
    try { if (window.__lanaiPostOpts) Object.assign(opts, window.__lanaiPostOpts); } catch (e) {}
    opts.fxaa = !opts.msaa;

    var tune = {};   // debug: uniform overrides for the finish pass, e.g. {uAOStr:0, uView:1}
    var broken = false, frameNo = 0, time = 0;
    var W = 1, H = 1;                                     // drawing-buffer pixels
    var bloomLevels = MOBILE ? 5 : 6, bloomStart = MOBILE ? 2 : 1;   // first mip = 1/2^bloomStart
    var bloomWeights = MOBILE ? [1.0, 0.75, 0.55, 0.4, 0.3] : [1.0, 0.8, 0.6, 0.45, 0.35, 0.25];

    var sceneRT = null, aoA = null, aoB = null, down = [], up = [];

    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quadScene = new THREE.Scene();
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false; quadScene.add(quad);

    function mat(fs, uniforms, defines) {
      return new THREE.ShaderMaterial({
        uniforms: uniforms, vertexShader: VERT, fragmentShader: fs, defines: defines || {},
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, transparent: false
      });
    }
    var depthUniforms = function () {
      return { tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uNear: { value: 0.1 }, uFar: { value: 300 }, uDepthSize: { value: new THREE.Vector2(1, 1) } };
    };

    var prefilterMat = mat(PREFILTER_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uTh: { value: 0.9 }, uKnee: { value: 0.1 } });
    var downMat = mat(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    var upMat = mat(UP_FS, { tCoarse: { value: null }, tFine: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } });
    var aoMat = null, aoBlurMat = null, finishMat = null;

    function buildFinish() {
      if (finishMat) finishMat.dispose();
      var u = {
        tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
        uTexel: { value: new THREE.Vector2() }, uAOTexel: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
        uView: { value: 0 }, uBloom: { value: 0.2 }, uBloomTint: { value: new THREE.Color(1, 0.97, 0.92) }, uClarity: { value: 0.3 },
        uContrast: { value: 0.12 }, uSat: { value: 1.05 }, uSplit: { value: 1.0 }, uVig: { value: 0.16 },
        uGrain: { value: 0.012 }, uSharpen: { value: 0.35 }, uTime: { value: 0 }, uAOStr: { value: 0.0 }, uAspect: { value: 1 }
      };
      if (opts.ao) Object.assign(u, depthUniforms());
      finishMat = mat(finishFS(opts), u);
    }
    function buildAO() {
      if (aoMat) { aoMat.dispose(); aoBlurMat.dispose(); aoMat = aoBlurMat = null; }
      if (!opts.ao) return;
      aoMat = mat(AO_FS, Object.assign(depthUniforms(), {
        uFullTexel: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 0.55 }, uProjScale: { value: 300 }, uIntensity: { value: 3.0 }, uMaxDist: { value: 80 }
      }));
      aoBlurMat = mat(AOBLUR_FS, Object.assign(depthUniforms(), { tAO: { value: null }, uDir: { value: new THREE.Vector2() } }));
    }

    function disposeTargets() {
      [sceneRT, aoA, aoB].concat(down, up).forEach(function (t) {
        if (t) { if (t.depthTexture) t.depthTexture.dispose(); t.dispose(); }
      });
      sceneRT = aoA = aoB = null; down = []; up = [];
    }

    function makeTargets() {
      disposeTargets();
      var o = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
        encoding: THREE.sRGBEncoding, depthBuffer: true, stencilBuffer: false };
      sceneRT = opts.msaa ? new THREE.WebGLMultisampleRenderTarget(W, H, o) : new THREE.WebGLRenderTarget(W, H, o);
      if (opts.msaa) sceneRT.samples = 4;
      sceneRT.texture.generateMipmaps = false;
      if (opts.ao) {
        var dt = new THREE.DepthTexture(W, H);
        dt.type = isGL2 ? THREE.FloatType : THREE.UnsignedShortType;   // 32F depth on WebGL2: no stair-stepping on grazing walls
        dt.format = THREE.DepthFormat; dt.minFilter = dt.magFilter = THREE.NearestFilter;
        sceneRT.depthTexture = dt;
        var aw = Math.max(1, W >> 1), ah = Math.max(1, H >> 1);
        var ao = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
        aoA = new THREE.WebGLRenderTarget(aw, ah, ao); aoB = new THREE.WebGLRenderTarget(aw, ah, ao);
        aoA.texture.generateMipmaps = aoB.texture.generateMipmaps = false;
      }
      var bo = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
        type: opts.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false };
      for (var i = 0; i < bloomLevels; i++) {
        var s = 1 << (bloomStart + i);
        var t = new THREE.WebGLRenderTarget(Math.max(1, Math.round(W / s)), Math.max(1, Math.round(H / s)), bo);
        t.texture.generateMipmaps = false; down.push(t);
        if (i < bloomLevels - 1) {
          var u = new THREE.WebGLRenderTarget(t.width, t.height, bo);
          u.texture.generateMipmaps = false; up.push(u);
        }
      }
    }

    function syncSize() {
      var v = new THREE.Vector2(); renderer.getDrawingBufferSize(v);
      var w = Math.max(1, Math.round(v.x)), h = Math.max(1, Math.round(v.y));
      if (w !== W || h !== H || !sceneRT) { W = w; H = h; makeTargets(); }
    }

    function pass(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    }

    function setDepthUniforms(u) {
      u.tDepth.value = sceneRT.depthTexture;
      u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uDepthSize.value.set(W, H);
    }

    var lerp = function (a, b, t) { return a + (b - a) * t; };

    function renderPost(L, dt) {
      syncSize();
      var night = (L && typeof L.night === 'number') ? Math.min(1, Math.max(0, L.night)) : 0;
      time += dt || 0.016;

      /* 1. scene */
      var prevAuto = renderer.autoClear;
      renderer.autoClear = true;
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      /* 2. AO */
      var aoOn = opts.ao && aoMat;
      if (aoOn) {
        var u = aoMat.uniforms; setDepthUniforms(u);
        u.uFullTexel.value.set(1 / W, 1 / H);
        u.uTexel.value.set(1 / aoA.width, 1 / aoA.height);
        u.uProjScale.value = camera.projectionMatrix.elements[5] * aoA.height * 0.5;
        var dist = controls && controls.target ? camera.position.distanceTo(controls.target) : camera.position.length();
        u.uMaxDist.value = dist + 24;
        pass(aoMat, aoA);
        var bu = aoBlurMat.uniforms; setDepthUniforms(bu);
        bu.tAO.value = aoA.texture; bu.uDir.value.set(1 / aoA.width, 0); pass(aoBlurMat, aoB);
        bu.tAO.value = aoB.texture; bu.uDir.value.set(0, 1 / aoA.height); pass(aoBlurMat, aoA);
      }

      /* 3. bloom chain */
      var pu = prefilterMat.uniforms;
      pu.tSrc.value = sceneRT.texture;
      pu.uTexel.value.set(1 / W, 1 / H);
      pu.uTh.value = lerp(0.93, 0.72, night);
      pu.uKnee.value = lerp(0.07, 0.25, night);
      pass(prefilterMat, down[0]);
      for (var i = 1; i < down.length; i++) {
        downMat.uniforms.tSrc.value = down[i - 1].texture;
        downMat.uniforms.uTexel.value.set(0.5 / down[i - 1].width, 0.5 / down[i - 1].height);
        pass(downMat, down[i]);
      }
      // weighted average, coarse to fine
      var acc = bloomWeights[down.length - 1], src = down[down.length - 1];
      for (var j = down.length - 2; j >= 0; j--) {
        var w = bloomWeights[j];
        upMat.uniforms.tCoarse.value = src.texture;
        upMat.uniforms.tFine.value = down[j].texture;
        upMat.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
        upMat.uniforms.uMix.value = acc / (acc + w);
        pass(upMat, up[j]);
        acc += w; src = up[j];
      }

      /* 4. finish to screen */
      var f = finishMat.uniforms;
      f.tScene.value = sceneRT.texture; f.tBloom.value = src.texture;
      f.uTexel.value.set(1 / W, 1 / H); f.uRes.value.set(W, H); f.uAspect.value = W / H;
      f.uBloom.value = lerp(0.6, 1.0, night);
      f.uBloomTint.value.setRGB(1.0, lerp(0.97, 0.9, night), lerp(0.93, 0.78, night));
      f.uClarity.value = lerp(0.36, 0.22, night);
      f.uContrast.value = lerp(0.2, 0.1, night);
      f.uSat.value = lerp(1.06, 1.04, night);
      f.uSplit.value = lerp(1.0, 0.6, night);
      f.uVig.value = lerp(0.14, 0.2, night);
      f.uGrain.value = lerp(0.010, 0.016, night);
      f.uSharpen.value = MOBILE ? 0.15 : 0.22;
      f.uTime.value = time;
      if (opts.ao) {
        setDepthUniforms(f);
        f.tAO.value = aoA.texture; f.uAOTexel.value.set(1 / aoA.width, 1 / aoA.height);
        f.uAOStr.value = lerp(0.85, 0.55, night);
      }
      for (var k in tune) if (f[k]) f[k].value = tune[k];
      pass(finishMat, null);
      renderer.autoClear = prevAuto;
    }

    function program(m) {
      try { var p = renderer.properties.get(m); return p && p.program; } catch (e) { return null; }
    }
    function shadersOK() {
      var list = [prefilterMat, downMat, upMat, finishMat];
      if (opts.ao && aoMat) list.push(aoMat, aoBlurMat);
      for (var i = 0; i < list.length; i++) {
        var p = program(list[i]);
        if (p && p.diagnostics && p.diagnostics.runnable === false) return false;
      }
      return true;
    }

    // downgrade ladder: drop AO, then MSAA, then post entirely
    function downgrade(why) {
      try { console.warn('LanaiPost: ' + why); } catch (e) {}
      if (opts.ao) { opts.ao = false; }
      else if (opts.msaa) { opts.msaa = false; opts.fxaa = true; }
      else { broken = true; return; }
      buildAO(); buildFinish(); disposeTargets(); W = H = 1; syncSize();
    }

    function render(L, dt) {
      if (broken || window.__lanaiPostBypass) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      try {
        renderPost(L, dt);
        if (frameNo < 4) {
          frameNo++;
          var gl = renderer.getContext(), err = gl.getError();
          if (!shadersOK()) downgrade('shader failed to compile');
          else if (err !== 0 && frameNo <= 3) downgrade('GL error 0x' + err.toString(16));
        }
      } catch (e) {
        broken = true;
        try { console.error('LanaiPost disabled', e); } catch (_) {}
        try { renderer.setRenderTarget(null); renderer.render(scene, camera); } catch (_) {}
      }
    }

    function setSize(w, h) {
      if (broken) return;
      try { syncSize(); } catch (e) { broken = true; }
    }

    buildAO(); buildFinish();
    try { syncSize(); } catch (e) { broken = true; }
    // clear any stale GL error so the first-frame check only sees ours
    try { renderer.getContext().getError(); } catch (e) {}

    var api = {
      render: render, setSize: setSize, tune: tune,
      get options() { return { msaa: opts.msaa, ao: opts.ao, fxaa: opts.fxaa, halfFloat: opts.halfFloat, broken: broken }; },
      dispose: function () { disposeTargets(); }
    };
    window.__lanaiPost = api;   // debug handle (set window.__lanaiPostBypass=true to compare against the raw render)
    return api;
  }

  window.LanaiPost = { create: create };
})();
