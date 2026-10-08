/** Rendering core: renderer, cameras, controls, lights, view orientation, orientation triad. */
import * as THREE from 'three';
import { CadControls } from './CadControls';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'dimetric' | 'trimetric';

/** SolidWorks convention: Y up, front view looks down -Z. */
export const VIEWS: Record<ViewName, { dir: THREE.Vector3; up: THREE.Vector3; label: string }> = {
  front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), label: 'Trước (Front)' },
  back: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), label: 'Sau (Back)' },
  left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), label: 'Trái (Left)' },
  right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), label: 'Phải (Right)' },
  top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), label: 'Trên (Top)' },
  bottom: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), label: 'Dưới (Bottom)' },
  iso: { dir: new THREE.Vector3(1, 1, 1).normalize(), up: new THREE.Vector3(0, 1, 0), label: 'Isometric' },
  dimetric: { dir: new THREE.Vector3(0.94, 0.5, 1.35).normalize(), up: new THREE.Vector3(0, 1, 0), label: 'Dimetric' },
  trimetric: { dir: new THREE.Vector3(0.6, 0.45, 1).normalize(), up: new THREE.Vector3(0, 1, 0), label: 'Trimetric' },
};

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  /** Everything belonging to the active document lives here. */
  readonly modelRoot = new THREE.Group();
  /** Measurement graphics, section caps, gizmos. */
  readonly overlay = new THREE.Group();
  readonly ortho: THREE.OrthographicCamera;
  readonly persp: THREE.PerspectiveCamera;
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  readonly controls: CadControls;
  private pivotMarker: THREE.Points;
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly hemi = new THREE.HemisphereLight(0xf4f7ff, 0x8a8f98, 1.1);
  private needsRender = true;
  private anim: { t0: number; dur: number; from: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number }; to: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number } } | null = null;
  /** Radius of the current model bounding sphere. */
  modelRadius = 100;
  modelCenter = new THREE.Vector3();
  private triadScene = new THREE.Scene();
  private triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private triadLabels: { el: HTMLDivElement; v: THREE.Vector3 }[] = [];
  readonly onBeforeRender: (() => void)[] = [];
  readonly onCameraChange: (() => void)[] = [];
  is2D = false;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'viewport-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'viewport-labels';
    container.appendChild(this.labelRenderer.domElement);

    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.persp = new THREE.PerspectiveCamera(35, 1, 0.1, 1e7);
    this.camera = this.ortho;
    this.camera.position.set(1, 1, 1).multiplyScalar(300);

    this.scene.add(this.modelRoot, this.overlay, this.hemi);
    this.camera.add(this.headlight);
    this.headlight.position.set(0.3, 0.6, 1);
    this.scene.add(this.camera);

    this.controls = new CadControls(this.camera, this.renderer.domElement);
    this.controls.fallbackPivot = () => this.modelCenter.clone();
    this.controls.addEventListener('change', () => {
      this.updatePerspClip();
      this.requestRender();
      for (const f of this.onCameraChange) f();
    });
    // Small marker showing the rotation centre while dragging (like SolidWorks).
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.pivotMarker = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe0301e, size: 9, sizeAttenuation: false, depthTest: false }));
    this.pivotMarker.renderOrder = 100;
    this.pivotMarker.visible = false;
    this.pivotMarker.raycast = () => {};
    this.scene.add(this.pivotMarker);
    this.controls.onPivot = (p) => {
      this.pivotMarker.visible = !!p;
      if (p) this.pivotMarker.position.copy(p);
      this.requestRender();
    };

    this.buildTriad();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  requestRender() {
    this.needsRender = true;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  private updateOrthoFrustum() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const halfH = this.modelRadius * 1.15;
    const aspect = w / h;
    this.ortho.left = -halfH * aspect;
    this.ortho.right = halfH * aspect;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.near = -this.modelRadius * 200;
    this.ortho.far = this.modelRadius * 200;
    this.ortho.updateProjectionMatrix();
  }

  setPerspective(on: boolean) {
    const from = this.camera;
    const to = on ? this.persp : this.ortho;
    if (from === to) return;
    const target = this.controls.target.clone();
    const dir = from.position.clone().sub(target).normalize();
    to.up.copy(from.up);
    if (on) {
      // Match apparent size: visible height of ortho = 2*top/zoom.
      const visH = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const d = visH / 2 / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      to.position.copy(target).addScaledVector(dir, d);
      this.persp.near = Math.max(d / 1000, 0.01);
      this.persp.far = d + this.modelRadius * 100;
      this.persp.updateProjectionMatrix();
    } else {
      const d = from.position.distanceTo(target);
      const visH = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      this.ortho.zoom = (this.ortho.top - this.ortho.bottom) / visH;
      this.ortho.updateProjectionMatrix();
      to.position.copy(target).addScaledVector(dir, this.modelRadius * 4);
    }
    from.remove(this.headlight);
    to.add(this.headlight);
    this.scene.remove(from);
    this.scene.add(to);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.requestRender();
  }

  /** Fit camera to a bounding box. */
  fit(box: THREE.Box3 | null, animate = true) {
    if (!box || box.isEmpty()) {
      box = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(1, 1, 1).normalize();
    this.flyTo(sphere.center, dir, this.camera.up.clone(), r, animate);
  }

  setModelBounds(box: THREE.Box3) {
    const s = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 100) : box.getBoundingSphere(new THREE.Sphere());
    this.modelRadius = Math.max(s.radius, 1e-3);
    this.modelCenter.copy(s.center);
    this.updateOrthoFrustum();
    this.controls.maxDistance = this.modelRadius * 100;
    this.controls.minDistance = this.modelRadius * 1e-4;
    this.controls.maxZoom = 1e5;
    this.controls.minZoom = 0.01;
    this.updatePerspClip();
  }

  setView(name: ViewName, box: THREE.Box3 | null) {
    const v = VIEWS[name];
    this.alignTo(v.dir, v.up, box);
  }

  alignTo(dir: THREE.Vector3, up: THREE.Vector3, box: THREE.Box3 | null) {
    const sphere = box && !box.isEmpty() ? box.getBoundingSphere(new THREE.Sphere()) : new THREE.Sphere(this.controls.target.clone(), this.modelRadius);
    this.flyTo(sphere.center, dir.clone().normalize(), up.clone(), Math.max(sphere.radius, 1e-3), true);
  }

  /** Look along -normal at a point keeping current zoom (SolidWorks "Normal To"). */
  normalTo(normal: THREE.Vector3, point: THREE.Vector3) {
    const dir = normal.clone().normalize();
    let up = this.camera.up.clone();
    if (Math.abs(up.dot(dir)) > 0.99) up = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
    const r = this.camera === this.ortho ? (this.ortho.top / this.ortho.zoom) / 1.15 : this.camera.position.distanceTo(this.controls.target) / 3;
    this.flyTo(point, dir, up, r, true);
  }

  private flyTo(center: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, radius: number, animate: boolean) {
    // Make up orthogonal to dir.
    const upO = up.clone().sub(dir.clone().multiplyScalar(up.dot(dir)));
    if (upO.lengthSq() < 1e-8) upO.set(0, 1, 0).sub(dir.clone().multiplyScalar(dir.y));
    upO.normalize();
    let pos: THREE.Vector3;
    let zoom = this.ortho.zoom;
    if (this.camera === this.ortho) {
      pos = center.clone().addScaledVector(dir, this.modelRadius * 4);
      zoom = (this.modelRadius * 1.15) / (radius * 1.1);
    } else {
      const d = (radius * 1.15) / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2));
      pos = center.clone().addScaledVector(dir, d);
      this.persp.near = Math.max(d / 1000, 0.01);
      this.persp.far = d + this.modelRadius * 100;
      this.persp.updateProjectionMatrix();
    }
    const to = { pos, target: center.clone(), up: upO, zoom };
    if (!animate) {
      this.applyCam(to);
      return;
    }
    this.anim = {
      t0: performance.now(),
      dur: 450,
      from: { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: this.ortho.zoom },
      to,
    };
    this.requestRender();
  }

  private applyCam(s: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number }) {
    this.camera.position.copy(s.pos);
    this.camera.up.copy(s.up);
    this.controls.target.copy(s.target);
    if (this.camera === this.ortho) {
      this.ortho.zoom = s.zoom;
      this.ortho.updateProjectionMatrix();
    }
    this.camera.lookAt(s.target);
    this.controls.update();
    this.requestRender();
    for (const f of this.onCameraChange) f();
  }

  private tick() {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const { from, to } = this.anim;
      // Interpolate the view direction on the sphere to avoid passing through the target.
      const d0 = from.pos.clone().sub(from.target), d1 = to.pos.clone().sub(to.target);
      const len = THREE.MathUtils.lerp(d0.length(), d1.length(), e);
      const q = new THREE.Quaternion().setFromUnitVectors(d0.clone().normalize(), d1.clone().normalize());
      const qi = new THREE.Quaternion().slerp(q, e);
      const dir = d0.clone().normalize().applyQuaternion(qi);
      const target = from.target.clone().lerp(to.target, e);
      const up = from.up.clone().lerp(to.up, e).normalize();
      this.applyCam({ pos: target.clone().addScaledVector(dir, len), target, up, zoom: THREE.MathUtils.lerp(from.zoom, to.zoom, e) });
      if (k >= 1) {
        this.applyCam(to);
        this.anim = null;
      }
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    for (const f of this.onBeforeRender) f();
    const r = this.renderer;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (!this.is2D) this.renderTriad(w, h);
  }

  // ---------- orientation triad ----------
  private buildTriad() {
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xd33f3f, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x3fa548, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x3f6fd3, 'Z'],
    ];
    for (const [v, color, label] of axes) {
      const arrow = new THREE.ArrowHelper(v, new THREE.Vector3(), 1, color, 0.3, 0.16);
      this.triadScene.add(arrow);
      const el = document.createElement('div');
      el.className = 'triad-label';
      el.textContent = label;
      el.style.color = '#' + color.toString(16).padStart(6, '0');
      this.container.appendChild(el);
      this.triadLabels.push({ el, v: v.clone().multiplyScalar(1.3) });
    }
    this.triadScene.add(new THREE.AmbientLight(0xffffff, 1));
  }

  private renderTriad(_w: number, h: number) {
    const size = 90;
    const r = this.renderer;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.triadCam.position.copy(dir.multiplyScalar(4));
    this.triadCam.up.copy(this.camera.up);
    this.triadCam.lookAt(0, 0, 0);
    this.triadCam.updateMatrixWorld();
    r.setScissorTest(true);
    r.setScissor(8, 8, size, size);
    r.setViewport(8, 8, size, size);
    r.clearDepth();
    r.render(this.triadScene, this.triadCam);
    r.setScissorTest(false);
    for (const l of this.triadLabels) {
      const p = l.v.clone().project(this.triadCam);
      l.el.style.left = `${8 + ((p.x + 1) / 2) * size - 5}px`;
      l.el.style.top = `${h - 8 - ((p.y + 1) / 2) * size - 8}px`;
    }
  }

  setTriadVisible(v: boolean) {
    for (const l of this.triadLabels) l.el.style.display = v ? '' : 'none';
  }

  /** Keep perspective near/far planes proportional to the viewing distance. */
  private updatePerspClip() {
    if (this.camera !== this.persp) return;
    const d = this.persp.position.distanceTo(this.controls.target);
    const near = Math.max(d / 2000, 1e-3);
    const far = d + this.modelRadius * 50;
    if (Math.abs(near - this.persp.near) > near * 0.01 || Math.abs(far - this.persp.far) > far * 0.01) {
      this.persp.near = near;
      this.persp.far = far;
      this.persp.updateProjectionMatrix();
    }
  }

  /** World-space size of one screen pixel at the target. */
  pixelSize(): number {
    const h = Math.max(1, this.container.clientHeight);
    if (this.camera === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.camera.position.distanceTo(this.controls.target);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
  }

  set2DMode(on: boolean) {
    this.is2D = on;
    this.controls.lock2D = on;
    this.setTriadVisible(!on);
  }

  /** Render a PNG screenshot with the CSS background gradient composited. */
  screenshot(background: string): string {
    this.needsRender = true;
    this.tick();
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    const [top, bottom] = background.split('|');
    g.addColorStop(0, top);
    g.addColorStop(1, bottom || top);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0);
    return c.toDataURL('image/png');
  }
}
