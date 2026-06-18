/* PEWÏ — Interactive liquid-paint background  <pew-fluid>
   A full-element WebGL backdrop: flowing marbled ink in the brand palette
   (deep navy + ink) with luminous spray-orange / amber "paint" that bleeds
   from the cursor like pigment in water. Pointer is tracked on window so it
   works even behind page content. Degrades to a static navy gradient if WebGL
   is unavailable.

   Attributes (all optional):
     intensity   0..1 overall paint brightness (default 1)
     calm        '1' = slower, subtler motion (default 0)
*/
(function () {
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

  const FRAG = `
  precision highp float;
  uniform vec2  u_res;
  uniform float u_time;
  uniform float u_intensity;
  uniform float u_calm;
  uniform vec3  u_trail[40];   // xy = pos (0..1, y up), z = age (1..0)

  // -- hash / value noise --
  float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
  float vnoise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
    vec2 u=f*f*(3.-2.*f);
    return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
  }
  float fbm(vec2 p){
    float v=0.0, a=0.5;
    for(int i=0;i<5;i++){ v+=a*vnoise(p); p*=2.02; a*=0.5; }
    return v;
  }

  void main(){
    vec2 uv = gl_FragCoord.xy / u_res;
    float agp = u_res.x / u_res.y;
    vec2 auv = vec2(uv.x*agp, uv.y);          // aspect-correct space
    float t = u_time * (u_calm>0.5 ? 0.35 : 1.0);

    // -- flowing marble domain-warp --
    vec2 q = vec2(fbm(auv*2.4 + vec2(0.0, t*0.08)),
                  fbm(auv*2.4 + vec2(5.2, -t*0.06)));
    vec2 r = vec2(fbm(auv*2.4 + q*1.8 + vec2(1.7, t*0.05)),
                  fbm(auv*2.4 + q*1.8 + vec2(8.3, t*0.04)));
    float marble = fbm(auv*2.4 + r*2.2);

    // base: deep navy, with subtle ink veins from the marble
    vec3 navy = vec3(0.039,0.059,0.18);
    vec3 ink  = vec3(0.015,0.020,0.06);
    vec3 col  = mix(ink, navy, smoothstep(0.30,0.80,marble));
    // faint cool sheen in the ridges
    col += vec3(0.04,0.06,0.12) * pow(smoothstep(0.55,0.95,marble),2.0);

    // -- pigment trail: paint bleeding from the cursor --
    float paint = 0.0;     // total ink coverage
    float heat  = 0.0;     // freshest = hottest (white core)
    vec2 flow = (r - 0.5);                       // local flow direction
    for(int i=0;i<40;i++){
      vec3 tp = u_trail[i];
      if(tp.z <= 0.001) continue;
      vec2 d = auv - vec2(tp.x*agp, tp.y);
      d += flow * (1.0 - tp.z) * 0.22;           // older pigment drifts with the flow
      // liquid edge: warp the radius with the marble field
      float warp = (marble - 0.5) * 0.10 * (1.0 - tp.z*0.5);
      float dist = length(d) + warp;
      float rad  = 0.035 + 0.20 * (1.0 - tp.z);  // spreads as it ages
      float infl = smoothstep(rad, 0.0, dist) * tp.z;
      paint += infl;
      heat  += infl * smoothstep(0.55,1.0,tp.z);
    }
    paint = clamp(paint, 0.0, 1.4);
    heat  = clamp(heat, 0.0, 1.0);

    // monochrome blue ramp: deep blue -> steel blue -> pale ice (subtle, no orange)
    vec3 deep  = vec3(0.10,0.22,0.46);
    vec3 steel = vec3(0.26,0.42,0.66);
    vec3 ice   = vec3(0.55,0.70,0.92);
    vec3 pcol = mix(deep, steel, smoothstep(0.2,0.9,paint));
    pcol = mix(pcol, ice, heat*0.7);

    float cover = clamp(paint*0.42, 0.0, 0.6) * u_intensity;
    col = mix(col, pcol, cover);
    // soft additive glow so fresh strokes shimmer, kept gentle
    col += pcol * heat * 0.16 * u_intensity;

    // gentle vignette to keep edges calm & text readable
    float vig = smoothstep(1.25, 0.35, length(uv-0.5));
    col *= mix(0.80, 1.04, vig);

    // subtle grain (screen-print feel)
    col += (hash(uv*u_res + t)-0.5) * 0.020;

    gl_FragColor = vec4(col, 1.0);
  }`;

  const MAX = 40;

  class PewFluid extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.style.display = 'block';
      this.style.position = 'absolute';
      this.style.inset = '0';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.overflow = 'hidden';
      this._cv = document.createElement('canvas');
      this._cv.style.cssText = 'width:100%;height:100%;display:block';
      this.appendChild(this._cv);
      this._trail = [];               // {x,y,born}
      this._life = (this.getAttribute('calm') === '1') ? 2.8 : 2.0;
      this._mouse = { x: 0.5, y: 0.5, has: false };
      this._last = { x: 0.5, y: 0.5 };
      // Rendimiento: si el usuario pide menos animación, usa el fondo estático.
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.fallback(); return;
      }
      this.boot();
    }
    disconnectedCallback() {
      if (this._raf) cancelAnimationFrame(this._raf);
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('resize', this._onResize);
      if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    }

    boot() {
      const gl = this._cv.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false })
              || this._cv.getContext('experimental-webgl');
      if (!gl) { this.fallback(); return; }
      this._gl = gl;
      const prog = this._program(gl, VERT, FRAG);
      if (!prog) { this.fallback(); return; }
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this._u = {
        res: gl.getUniformLocation(prog, 'u_res'),
        time: gl.getUniformLocation(prog, 'u_time'),
        intensity: gl.getUniformLocation(prog, 'u_intensity'),
        calm: gl.getUniformLocation(prog, 'u_calm'),
        trail: gl.getUniformLocation(prog, 'u_trail')
      };
      this._intensity = parseFloat(this.getAttribute('intensity'));
      if (isNaN(this._intensity)) this._intensity = 1.0;
      this._calm = this.getAttribute('calm') === '1' ? 1.0 : 0.0;
      // Render scale: en móviles bajamos la resolución interna para ahorrar
      // GPU/batería (el shader fbm es costoso por píxel). Escritorio: 62%.
      const mobile = Math.min(window.innerWidth, window.innerHeight) <= 820
        || (navigator.maxTouchPoints || 0) > 0;
      this._scale = mobile ? 0.4 : 0.62;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
      this.resize();

      this._onMove = (e) => this.pointer(e.clientX, e.clientY);
      window.addEventListener('pointermove', this._onMove, { passive: true });

      // Pausa el bucle cuando la pestaña no está visible (ahorro de batería).
      this._onVis = () => {
        if (document.hidden) {
          if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; this._pausedAt = performance.now(); }
        } else if (!this._raf) {
          if (this._pausedAt) { this._t0 += performance.now() - this._pausedAt; this._pausedAt = 0; }
          this._raf = requestAnimationFrame(loop);
        }
      };
      document.addEventListener('visibilitychange', this._onVis);

      this._t0 = performance.now();
      const loop = () => { this._raf = requestAnimationFrame(loop); this.frame(); };
      loop();
    }

    _program(gl, vs, fs) {
      const c = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : (console.warn('pewfluid shader', gl.getShaderInfoLog(s)), null); };
      const v = c(gl.VERTEX_SHADER, vs), f = c(gl.FRAGMENT_SHADER, fs);
      if (!v || !f) return null;
      const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
    }

    resize() {
      const w = Math.max(1, this.clientWidth), h = Math.max(1, this.clientHeight);
      this._W = w; this._H = h;
      const bw = Math.max(2, Math.floor(w * this._scale)), bh = Math.max(2, Math.floor(h * this._scale));
      this._cv.width = bw; this._cv.height = bh;
      if (this._gl) this._gl.viewport(0, 0, bw, bh);
    }

    pointer(cx, cy) {
      const r = this.getBoundingClientRect();
      // accept moves anywhere; map into element space (clamped)
      let x = (cx - r.left) / Math.max(1, r.width);
      let y = 1.0 - (cy - r.top) / Math.max(1, r.height);   // flip: gl y up
      if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return; // ignore far away
      x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
      const dx = x - this._last.x, dy = y - this._last.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.012 && this._trail.length) return;        // throttle by distance
      const now = performance.now();
      // seed a couple of interpolated points for smooth ribbons on fast moves
      const steps = Math.min(4, Math.max(1, Math.floor(dist / 0.05)));
      for (let i = 1; i <= steps; i++) {
        this._trail.push({ x: this._last.x + dx * (i / steps), y: this._last.y + dy * (i / steps), born: now });
      }
      this._last.x = x; this._last.y = y;
      while (this._trail.length > MAX) this._trail.shift();
    }

    frame() {
      const gl = this._gl; if (!gl) return;
      const now = performance.now();
      const time = (now - this._t0) / 1000;
      // build trail uniform (newest last)
      const arr = new Float32Array(MAX * 3);
      const live = [];
      for (const p of this._trail) {
        const age = 1.0 - (now - p.born) / (this._life * 1000);
        if (age > 0) live.push({ x: p.x, y: p.y, a: age });
      }
      this._trail = this._trail.filter(p => (now - p.born) < this._life * 1000);
      const start = Math.max(0, live.length - MAX);
      let n = 0;
      for (let i = start; i < live.length; i++) {
        arr[n*3] = live[i].x; arr[n*3+1] = live[i].y; arr[n*3+2] = live[i].a; n++;
      }
      gl.uniform2f(this._u.res, this._cv.width, this._cv.height);
      gl.uniform1f(this._u.time, time);
      gl.uniform1f(this._u.intensity, this._intensity);
      gl.uniform1f(this._u.calm, this._calm);
      gl.uniform3fv(this._u.trail, arr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    fallback() {
      this.innerHTML = '';
      this.style.background = 'radial-gradient(circle at 30% 25%, #15204a 0%, #0A0F2E 45%, #060814 100%)';
    }
  }
  if (!customElements.get('pew-fluid')) customElements.define('pew-fluid', PewFluid);
})();