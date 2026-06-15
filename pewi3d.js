/* PEWÏ 3D garment viewer — vanilla web component <pewi-3d>
   Loads Three r137 (+GLTF/DRACO/OrbitControls/DecalGeometry) once and renders a
   recolorable garment with screen-print decals projected onto the real mesh.

   Props (accepted as camelCase properties OR kebab/lower attributes — robust to React):
     model            GLB url
     color            garment hex (#rrggbb)
     frontDesign      design png url (white art on transparent) — "" / none for empty
     backDesign       design png url — "" / none for empty
     frontX frontY frontScale frontRot   front decal transform (world units / deg)
     backX  backY  backScale  backRot    back decal transform
     printMode        'white' (screen ink) | 'dark' (use dark art as-is)
     view             front | back | left | right
     autorotate       '1' to spin
*/
(function () {
  const CDN = 'https://unpkg.com/three@0.137.0';
  let _load = null;
  function inject(src) {
    return new Promise((res, rej) => {
      if ([...document.scripts].some(s => s.src === src)) return res();
      const el = document.createElement('script');
      el.src = src; el.onload = res; el.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(el);
    });
  }
  async function ensureThree() {
    if (window.THREE && THREE.GLTFLoader && THREE.DecalGeometry && THREE.OrbitControls && THREE.DRACOLoader) return;
    if (!_load) _load = (async () => {
      await inject(CDN + '/build/three.min.js');
      await inject(CDN + '/examples/js/loaders/GLTFLoader.js');
      await inject(CDN + '/examples/js/loaders/DRACOLoader.js');
      await inject(CDN + '/examples/js/controls/OrbitControls.js');
      await inject(CDN + '/examples/js/geometries/DecalGeometry.js');
    })();
    await _load;
  }
  const _gltf = {};
  function loadGLTF(url) {
    if (_gltf[url]) return _gltf[url];
    return _gltf[url] = new Promise((res, rej) => {
      const l = new THREE.GLTFLoader();
      const d = new THREE.DRACOLoader();
      d.setDecoderPath(CDN + '/examples/js/libs/draco/');
      l.setDRACOLoader(d);
      l.load(url, res, undefined, rej);
    });
  }
  const _tex = {}, _texReady = {};
  function loadTex(url) {
    if (_tex[url]) return _tex[url];
    return _tex[url] = new Promise(res => {
      new THREE.TextureLoader().load(url, t => { t.anisotropy = 8; t.encoding = THREE.sRGBEncoding; _texReady[url] = t; res(t); }, undefined, () => res(null));
    });
  }
  function texSync(url) {           // returns the texture if already decoded, else kicks off a load and returns null
    if (_texReady[url]) return _texReady[url];
    loadTex(url);
    return null;
  }

  // canonical prop keys; lookup by lowercased-no-dash
  const KEYS = ['model','color','frontDesign','backDesign','frontX','frontY','frontScale','frontRot','backX','backY','backScale','backRot','printMode','view','autorotate','frontAxis','decalDepth','rotY'];
  const NORM = {}; KEYS.forEach(k => NORM[k.toLowerCase()] = k);

  class Pewi3D extends HTMLElement {
    static get observedAttributes() {
      // observe every spelling React might emit
      const a = [];
      KEYS.forEach(k => { a.push(k); a.push(k.toLowerCase()); a.push(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())); });
      return [...new Set(a)];
    }
    constructor() {
      super();
      this._p = {};
      this._decals = { front: null, back: null };
      this._shell = [];
      this._ready = false;
      this._pending = null;
    }
    // define camelCase property setters so React can set properties directly
    _set(key, v) { if (this._p[key] === v) return; this._p[key] = v; this._schedule(key); }
    _schedule(key) {
      // immediate (non-geometry) applies happen live; decal-affecting changes set a need flag
      this._need = this._need || { front: false, back: false };
      if (!this._ready) return;
      if (key === 'model' || key === 'rotY') { this._reloadModel(this._p.model); return; }
      if (key === 'color') this._applyColor();
      else if (key === 'view') this._applyView(false);
      else if (key === 'autorotate') this._applyAutorotate();
      const geom = (key === 'frontAxis' || key === 'decalDepth' || key === 'printMode');
      if (geom || /^front/.test(key)) this._need.front = true;
      if (geom || /^back/.test(key)) this._need.back = true;
      // warm the texture cache so the render-loop pump can build synchronously
      if (this._p.frontDesign) texSync(this._p.frontDesign);
      if (this._p.backDesign) texSync(this._p.backDesign);
    }

    connectedCallback() {
      if (this._init) return; this._init = true;
      this.style.display = 'block'; this.style.position = 'relative';
      this.style.width = this.style.width || '100%'; this.style.height = this.style.height || '100%';
      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;touch-action:none';
      this.appendChild(this._canvas);
      this._spin = document.createElement('div');
      this._spin.textContent = 'Cargando 3D…';
      this._spin.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 11px/1 Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#aab;pointer-events:none';
      this.appendChild(this._spin);
      this.boot();
    }
    disconnectedCallback() { if (this._raf) cancelAnimationFrame(this._raf); if (this._pumpTimer) clearInterval(this._pumpTimer); window.removeEventListener('resize', this._onResize); }

    attributeChangedCallback(name, _o, v) {
      const k = NORM[name.toLowerCase().replace(/-/g, '')];
      if (k) this._set(k, v);
    }

    async boot() {
      try {
        await ensureThree();
        const cv = this._canvas;
        const renderer = this._renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(2, devicePixelRatio));
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.NoToneMapping;
        const scene = this._scene = new THREE.Scene();
        const camera = this._camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
        camera.position.set(0, 0.05, 2.7);
        const controls = this._controls = new THREE.OrbitControls(camera, cv);
        controls.enablePan = false;
        controls.minDistance = 1.25; controls.maxDistance = 4.5;
        controls.autoRotateSpeed = 2.4;
        controls.minPolarAngle = 0.7; controls.maxPolarAngle = 2.2;
        controls.target.set(0, 0, 0);
        controls.addEventListener('start', () => { cv.style.cursor = 'grabbing'; });
        controls.addEventListener('end', () => { cv.style.cursor = 'grab'; });
        scene.add(new THREE.HemisphereLight(0xffffff, 0x6c6c76, 0.82));
        scene.add(new THREE.AmbientLight(0xffffff, 0.16));
        const key = new THREE.DirectionalLight(0xffffff, 1.15); key.position.set(1.6, 2.2, 3.0); scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-2.5, 0.7, 1.0); scene.add(fill);
        const rim = new THREE.DirectionalLight(0xffffff, 0.8); rim.position.set(0, 1.6, -3.0); scene.add(rim);

        const url = this._p.model || this.getAttribute('model');
        await this._loadModel(url);

        this._onResize = () => {
          const w = this.clientWidth || 1, h = this.clientHeight || 1;
          renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', this._onResize); this._onResize();

        this._ready = true;
        this._spin.style.display = 'none';
        this._applyColor();
        this._applyView(true);
        this._applyAutorotate();
        this._need = { front: true, back: true };   // build on first frames
        if (this._p.frontDesign) texSync(this._p.frontDesign);
        if (this._p.backDesign) texSync(this._p.backDesign);
        // decal pump on a timer — keeps building even when rAF is throttled/paused in background
        this._pumpTimer = setInterval(() => this._pumpDecals(), 180);
        this._pumpDecals();

        const tick = () => {
          this._raf = requestAnimationFrame(tick);
          this._pumpDecals();
          renderer.render(scene, camera);
        };
        tick();
      } catch (e) {
        this._spin.textContent = '3D no disponible';
        console.error('pewi3d', e);
      }
    }

    // build/refresh decals synchronously from the render loop — no async races
    _pumpDecals() {
      if (!this._ready || !this._need) return;
      this._scene.updateMatrixWorld(true);   // ensure world matrices are current before raycasting
      ['front', 'back'].forEach(side => {
        if (!this._need[side]) return;
        const url = this._p[side + 'Design'];
        if (!url || url === 'none') { this._removeDecal(side); this._need[side] = false; return; }
        const tex = texSync(url);
        if (!tex) return;            // texture still loading — try again next frame
        let ok = false;
        try { ok = this._buildSync(side, tex); } catch (e) { console.warn('pewi3d decal', e); }
        if (ok) this._need[side] = false;   // keep retrying next frames until a real hit lands
      });
      // render once here too, so decals appear even while rAF is throttled in the background
      this._stepCamera();
      if (this._renderer && this._scene && this._camera) this._renderer.render(this._scene, this._camera);
    }
    _stepCamera() {
      if (this._target) {
        this._camera.position.lerp(this._target, 0.16);
        if (this._camera.position.distanceTo(this._target) < 0.006) this._target = null;
      }
      if (this._controls) this._controls.update();
    }
    _removeDecal(side) {
      if (this._decals[side]) { this._scene.remove(this._decals[side]); this._decals[side].geometry.dispose(); this._decals[side].material.dispose(); this._decals[side] = null; }
    }

    _applyColor() {
      const c = new THREE.Color(this._p.color || '#141416');
      this._shell.forEach(m => { m.material.color.copy(c); m.material.needsUpdate = true; });
    }
    _applyAutorotate() { this._controls.autoRotate = (this._p.autorotate === '1' || this._p.autorotate === 1 || this._p.autorotate === true); }
    _applyView(initial) {
      const v = this._p.view || 'front';
      const dist = this._fitDist || 2.7;
      const cy = this._fitY || 0.05;
      const cx = this._fitX || 0;
      const P = { front:[cx,cy,dist], back:[cx,cy,-dist], left:[cx-dist,cy,0.2], right:[cx+dist,cy,0.2] };
      const p = new THREE.Vector3(...(P[v] || P.front));
      if (this._controls) this._controls.target.set(cx, cy, 0);
      if (initial) { this._camera.position.copy(p); if (this._controls) this._controls.update(); }
      else this._target = p;
    }
    _num(v, d) { const n = parseFloat(v); return isNaN(n) ? d : n; }

    async _loadModel(url) {
      this._loadedUrl = url;
      // remove previous model + decals
      this._removeDecal('front'); this._removeDecal('back');
      if (this._model) { this._scene.remove(this._model); }
      const gltf = await loadGLTF(url);
      if (this._loadedUrl !== url) return;   // a newer model was requested meanwhile
      const model = this._model = gltf.scene.clone(true);
      // orient so the garment's front faces +Z (per-model correction)
      const rotY = this._num(this._p.rotY, 0);
      if (rotY) { model.rotation.y = rotY * Math.PI / 180; model.updateMatrixWorld(true); }
      let box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      model.scale.setScalar(1.55 / Math.max(size.x, size.y, size.z));
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
      model.position.sub(box.getCenter(new THREE.Vector3()));
      model.updateMatrixWorld(true);
      this._shell = [];
      model.traverse(o => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.metalness = 0;
          o.material.roughness = Math.min(1, (o.material.roughness ?? 0.85) + 0.05);
          this._shell.push(o);
        }
      });
      this._scene.add(model);
      // auto-fit: frame the model's full height with margin; target true bbox center
      box = new THREE.Box3().setFromObject(model);
      const sz = box.getSize(new THREE.Vector3());
      const ctr = box.getCenter(new THREE.Vector3());
      const vFov = this._camera.fov * Math.PI / 180;
      const fitH = (sz.y / 2) / Math.tan(vFov / 2);
      const fitW = (sz.x / 2) / Math.tan(vFov / 2) / (this._camera.aspect || 1);
      this._fitDist = Math.max(fitH, fitW) * 1.30 + sz.z * 0.5;
      this._fitY = ctr.y;
      this._fitX = ctr.x;
      if (this._ready) { this._applyColor(); this._applyView(true); this._need = { front: true, back: true }; }
    }

    async _reloadModel(url) {
      const rotY = this._num(this._p.rotY, 0);
      if (!this._ready || (url === this._loadedUrl && rotY === this._loadedRotY)) return;
      this._loadedRotY = rotY;
      this._spin.style.display = 'flex';
      try { await this._loadModel(url); } catch (e) { console.warn('pewi3d model', e); }
      this._spin.style.display = 'none';
    }

    // synchronous decal build — texture is guaranteed loaded by the pump
    _buildSync(side, tex) {
      this._removeDecal(side);
      const aspect = (tex.image && tex.image.width) ? tex.image.width / tex.image.height : 1;
      const fa = this._num(this._p.frontAxis, 1);          // +1: front=+Z, -1: front=-Z
      const front = side === 'front';
      const faceZ = (front ? 1 : -1) * fa;                 // world-Z side this decal lives on
      const x = this._num(this._p[side + 'X'], 0);
      const y = this._num(this._p[side + 'Y'], 0.12);
      const scale = this._num(this._p[side + 'Scale'], 0.34);
      const rot = this._num(this._p[side + 'Rot'], 0) * Math.PI / 180;
      const depth = this._num(this._p.decalDepth, 0.22);   // shallow: only the near panel, never wraps
      const w = scale, h = scale / aspect;

      const origin = new THREE.Vector3(x, y, faceZ * 1.8);
      const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -faceZ), 0, 6);
      const hits = ray.intersectObjects(this._shell, true);
      if (!hits.length) return false;
      const hit = hits[0];
      const mesh = hit.object;
      const pos = hit.point.clone();
      const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
      const dummy = new THREE.Object3D();
      dummy.position.copy(pos);
      dummy.lookAt(pos.clone().add(normal));
      dummy.rotateZ(rot);

      const geo = new THREE.DecalGeometry(mesh, pos, dummy.rotation.clone(), new THREE.Vector3(w, h, depth));
      const dark = this._p.printMode === 'dark';
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, roughness: 0.9, metalness: 0,
        emissive: new THREE.Color(dark ? 0x000000 : 0xffffff),
        emissiveMap: tex, emissiveIntensity: dark ? 0 : 0.22,
        polygonOffset: true, polygonOffsetFactor: -18, polygonOffsetUnits: -18,
        depthTest: true, depthWrite: false
      });
      const decal = new THREE.Mesh(geo, mat);
      decal.renderOrder = 12;
      decal.position.add(normal.clone().multiplyScalar(0.004)); // lift off the surface to beat z-fighting
      this._scene.add(decal);
      this._decals[side] = decal;
      return true;
    }
  }

  // camelCase property accessors → React sets properties on custom elements when present
  KEYS.forEach(k => {
    Object.defineProperty(Pewi3D.prototype, k, {
      get() { return this._p[k]; },
      set(v) { this._set(k, v); },
      configurable: true
    });
  });

  if (!customElements.get('pewi-3d')) customElements.define('pewi-3d', Pewi3D);
})();