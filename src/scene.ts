import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Label, SiteData } from './data';

// Scene units are kilometres: x east, y up, z south, origin at the model centre.
export const EXAGGERATION = 1.7;
const BASE_ELEV = 440; // metres that sit at y = 0
const SKIRT_DEPTH = 0.45; // the model's base, like the edge of a printed piece

const km = (m: number) => m / 1000;
const yOf = (elev: number) => km(elev - BASE_ELEV) * EXAGGERATION;

export interface View {
  target: [number, number, number];
  position: [number, number, number];
}

export interface Hover {
  zone: string;
  elevation: number;
  clientX: number;
  clientY: number;
}

interface Tween {
  fromP: THREE.Vector3;
  fromT: THREE.Vector3;
  toP: THREE.Vector3;
  toT: THREE.Vector3;
  start: number;
  ms: number;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

function terrainGeometry(data: SiteData, step: number): THREE.BufferGeometry {
  const { width: W, height: H, metresPerPx: mpp } = data.meta;
  const nx = Math.floor((W - 1) / step) + 1;
  const ny = Math.floor((H - 1) / step) + 1;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const px = i * step;
      const py = j * step;
      const k = j * nx + i;
      pos[k * 3] = km((px + 0.5 - W / 2) * mpp);
      pos[k * 3 + 1] = yOf(data.dem[py * W + px]);
      pos[k * 3 + 2] = km((py + 0.5 - H / 2) * mpp);
      uv[k * 2] = (px + 0.5) / W;
      uv[k * 2 + 1] = 1 - (py + 0.5) / H;
    }
  }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      index.set([a, c, b, b, c, d], n);
      n += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/** Vertical walls around the terrain's edge, down to the base. */
function skirtGeometry(terrain: THREE.BufferGeometry, nx: number, ny: number): THREE.BufferGeometry {
  const p = terrain.getAttribute('position') as THREE.BufferAttribute;
  const ring: number[] = [];
  for (let i = 0; i < nx - 1; i++) ring.push((ny - 1) * nx + i); // south, eastward
  for (let j = ny - 1; j > 0; j--) ring.push(j * nx + nx - 1); // east, northward
  for (let i = nx - 1; i > 0; i--) ring.push(i); // north, westward
  for (let j = 0; j < ny - 1; j++) ring.push(j * nx); // west, southward
  const out: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
    const bx = p.getX(b), by = p.getY(b), bz = p.getZ(b);
    // (direction of travel) × up points outward, so these face out of the model.
    out.push(ax, -SKIRT_DEPTH, az, bx, -SKIRT_DEPTH, bz, bx, by, bz);
    out.push(ax, -SKIRT_DEPTH, az, bx, by, bz, ax, ay, az);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

export class RiverScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 400);
  readonly controls: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly labelRenderer = new CSS2DRenderer();
  private readonly uniforms = {
    planMap: { value: null as THREE.Texture | null },
    hlMap: { value: null as THREE.Texture | null },
    uMix: { value: 1 },
    uHl: { value: 0 },
    uTime: { value: 0 },
  };
  private mixTarget = 1;
  private hlTarget = 0;
  private tween: Tween | null = null;
  private proxy!: THREE.Mesh;
  private hlTexture!: THREE.DataTexture;
  private hlData!: Uint8Array;
  private labels: { obj: CSS2DObject; el: HTMLElement; label: Label }[] = [];
  private framing = { left: 0, bottom: 0 };
  private lastHover = 0;
  private exploring = false;
  onHover: (h: Hover | null) => void = () => {};
  onUserMove: () => void = () => {};

  private constructor(canvas: HTMLCanvasElement, labelLayer: HTMLElement, private readonly data: SiteData) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    // Neutral keeps the map's colours close to their sRGB values; ACES greys them out.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.labelRenderer.domElement.className = 'label-layer';
    labelLayer.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.38;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 70;
    this.controls.zoomSpeed = 0.8;
    this.controls.enableZoom = false;
    this.controls.addEventListener('start', () => {
      this.tween = null;
      this.onUserMove();
    });
    // The wheel scrolls the story; pinch (ctrl+wheel on trackpads) or explore mode zooms.
    canvas.addEventListener('wheel', (e) => (this.controls.enableZoom = this.exploring || e.ctrlKey || e.metaKey), {
      capture: true,
      passive: true,
    });
    this.setExploring(false);
  }

  static async create(canvas: HTMLCanvasElement, labelLayer: HTMLElement, data: SiteData): Promise<RiverScene> {
    const s = new RiverScene(canvas, labelLayer, data);
    await s.build();
    s.resize();
    addEventListener('resize', () => s.resize());
    canvas.addEventListener('pointermove', (e) => s.hover(e));
    canvas.addEventListener('pointerleave', () => s.onHover(null));
    s.renderer.setAnimationLoop((t) => s.frame(t));
    return s;
  }

  private async build(): Promise<void> {
    const { data } = this;
    const loader = new THREE.TextureLoader();
    const [today, plan] = await Promise.all([loader.loadAsync(data.todayUrl), loader.loadAsync(data.planUrl)]);
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    for (const t of [today, plan]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
    }
    this.uniforms.planMap.value = plan;

    const { ids, width: zw, height: zh } = data.zones;
    this.hlData = new Uint8Array(ids.length);
    this.hlTexture = new THREE.DataTexture(this.hlData, zw, zh, THREE.RedFormat, THREE.UnsignedByteType);
    this.hlTexture.unpackAlignment = 1;
    this.hlTexture.magFilter = THREE.LinearFilter;
    this.hlTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.hlTexture.generateMipmaps = true;
    this.hlTexture.needsUpdate = true;
    this.uniforms.hlMap.value = this.hlTexture;

    const step = coarse ? 3 : 2;
    const geo = terrainGeometry(data, step);
    const material = new THREE.MeshStandardMaterial({ map: today, roughness: 0.93, metalness: 0 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D planMap;
uniform sampler2D hlMap;
uniform float uMix;
uniform float uHl;
uniform float uTime;`,
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
  vec4 todayColour = texture2D( map, vMapUv );
  vec4 planColour = texture2D( planMap, vMapUv );
  vec4 sampledDiffuseColor = mix( todayColour, planColour, uMix );
  float lit = texture2D( hlMap, vMapUv ).r;
  float dim = uHl * ( 1.0 - lit );
  float grey = dot( sampledDiffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, vec3( grey ) * 0.8 + 0.14, dim * 0.72 );
  sampledDiffuseColor.rgb *= 1.0 + uHl * lit * 0.14 * ( 0.5 + 0.5 * sin( uTime * 2.2 ) );
  diffuseColor *= sampledDiffuseColor;
#endif`,
        );
    };
    const terrain = new THREE.Mesh(geo, material);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.scene.add(terrain);

    const nx = Math.floor((data.meta.width - 1) / step) + 1;
    const ny = Math.floor((data.meta.height - 1) / step) + 1;
    const skirt = new THREE.Mesh(
      skirtGeometry(geo, nx, ny),
      new THREE.MeshStandardMaterial({ color: 0x7a644f, roughness: 0.97 }),
    );
    skirt.receiveShadow = true;
    this.scene.add(skirt);

    this.proxy = new THREE.Mesh(terrainGeometry(data, 8));

    this.scene.add(new THREE.HemisphereLight(0xe3ecf2, 0x6a5a46, 1.25));
    const sun = new THREE.DirectionalLight(0xfff2e2, 2.6);
    sun.position.set(-18, 20, -12); // north-west, the cartographer's light
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 2048 : 4096, coarse ? 2048 : 4096);
    const sc = sun.shadow.camera;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 80;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);

    this.applyFog();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyFog());
    this.buildLabels();

    this.camera.position.set(6, 15.5, 29);
    this.controls.target.set(0.3, 0.1, 0.4);
  }

  private applyFog(): void {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    this.scene.fog = new THREE.Fog(dark ? 0x1d2a2b : 0xe4ebe9, 45, 120);
  }

  private buildLabels(): void {
    for (const label of this.data.labels) {
      const el = document.createElement('div');
      el.className = `label label--${label.kind}`;
      const obj = new CSS2DObject(el);
      const lift = label.kind === 'peak' ? 0.06 : 0.03;
      obj.position.set(km(label.x), yOf(label.ground) + lift, km(label.z));
      obj.center.set(0.5, label.kind === 'peak' ? 1 : 0.5);
      this.scene.add(obj);
      this.labels.push({ obj, el, label });
    }
  }

  setLanguage(lang: 'en' | 'ru', metre: string): void {
    for (const { el, label } of this.labels) {
      el.replaceChildren();
      const name = document.createElement('span');
      name.className = 'label__name';
      name.textContent = label.name[lang];
      el.append(name);
      if (label.kind === 'peak' && label.ele) {
        const ele = document.createElement('span');
        ele.className = 'label__ele';
        ele.textContent = `${label.ele.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB')} ${metre}`;
        el.append(ele);
      }
    }
  }

  /** Blend between today (0) and the River City plan (1). */
  setMix(target: number): void {
    this.mixTarget = target;
  }

  get mix(): number {
    return this.mixTarget;
  }

  /** Lift the named zones and quieten everything else; null clears it. */
  highlight(keys: string[] | null): void {
    if (!keys || keys.length === 0) {
      this.hlTarget = 0;
      return;
    }
    const wanted = new Set<number>();
    for (const [id, z] of Object.entries(this.data.meta.zones)) if (keys.includes(z.key)) wanted.add(Number(id));
    const { ids, width: w, height: h } = this.data.zones;
    // DataTexture rows run bottom-up; the zone image runs top-down (north first).
    for (let y = 0; y < h; y++) {
      const src = y * w;
      const dst = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) this.hlData[dst + x] = wanted.has(ids[src + x]) ? 255 : 0;
    }
    this.hlTexture.needsUpdate = true;
    this.hlTarget = 1;
  }

  flyTo(view: View, ms = 2400): void {
    const aspect = innerWidth / innerHeight;
    const t = new THREE.Vector3(...view.target);
    const p = new THREE.Vector3(...view.position);
    if (aspect < 1) p.sub(t).multiplyScalar(1.55).add(t); // portrait screens need to stand further back
    this.tween = {
      fromP: this.camera.position.clone(),
      fromT: this.controls.target.clone(),
      toP: p,
      toT: t,
      start: performance.now(),
      ms: reducedMotion ? 1 : ms,
    };
  }

  /** Keep the subject clear of the story card: shift the projection centre. */
  setFraming(left: number, bottom: number): void {
    this.framing = { left, bottom };
    this.resize();
  }

  setExploring(on: boolean): void {
    this.exploring = on;
    this.controls.enableZoom = on;
    // On touch screens the canvas must let the page scroll until the visitor asks to explore.
    this.controls.enabled = on || !coarse;
    this.renderer.domElement.style.touchAction = on || !coarse ? 'none' : 'pan-y';
  }

  zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    const len = THREE.MathUtils.clamp(offset.length(), this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(len));
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    const { left, bottom } = this.exploring ? { left: 0, bottom: 0 } : this.framing;
    const fullW = w + left;
    const fullH = h + bottom;
    this.camera.aspect = fullW / fullH;
    if (left || bottom) this.camera.setViewOffset(fullW, fullH, 0, bottom, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  refreshFraming(): void {
    this.resize();
  }

  private hover(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const now = performance.now();
    if (now - this.lastHover < 40) return;
    this.lastHover = now;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.proxy)[0];
    if (!hit) {
      this.onHover(null);
      return;
    }
    const { meta, dem, zones } = this.data;
    const px = THREE.MathUtils.clamp((hit.point.x * 1000) / meta.metresPerPx + meta.width / 2 - 0.5, 0, meta.width - 1);
    const py = THREE.MathUtils.clamp((hit.point.z * 1000) / meta.metresPerPx + meta.height / 2 - 0.5, 0, meta.height - 1);
    const elevation = dem[Math.round(py) * meta.width + Math.round(px)];
    const zx = Math.min(zones.width - 1, Math.floor(((hit.point.x * 1000) / meta.texture.metresPerPx + meta.texture.width / 2) / 2));
    const zy = Math.min(zones.height - 1, Math.floor(((hit.point.z * 1000) / meta.texture.metresPerPx + meta.texture.height / 2) / 2));
    const id = zones.ids[Math.max(0, zy) * zones.width + Math.max(0, zx)];
    this.onHover({ zone: meta.zones[id]?.key ?? 'terrain', elevation, clientX: e.clientX, clientY: e.clientY });
  }

  private prev = 0;

  private frame(time: number): void {
    const dt = Math.min(0.1, (time - this.prev) / 1000 || 0);
    this.prev = time;
    const ease = 1 - Math.exp(-dt * 3.2);
    this.uniforms.uMix.value += (this.mixTarget - this.uniforms.uMix.value) * ease;
    this.uniforms.uHl.value += (this.hlTarget - this.uniforms.uHl.value) * ease;
    this.uniforms.uTime.value = time / 1000;

    if (this.tween) {
      const tw = this.tween;
      const t = Math.min(1, (performance.now() - tw.start) / tw.ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lift = Math.sin(Math.PI * t) * tw.fromP.distanceTo(tw.toP) * 0.1;
      this.camera.position.lerpVectors(tw.fromP, tw.toP, e);
      this.camera.position.y += lift;
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (t >= 1) this.tween = null;
    }
    this.controls.update();

    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const { el, label } of this.labels) {
      const hide = (label.kind === 'village' && dist > 20) || (label.kind === 'peak' && dist > 48);
      el.classList.toggle('label--hidden', hide);
    }
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}
