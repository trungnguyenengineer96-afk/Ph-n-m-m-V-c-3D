/**
 * SolidWorks-style camera navigation.
 *
 *  - Rotate (left or middle drag): free rotation about the screen axes, pivoting
 *    on the point under the cursor (falls back to the model centre).
 *  - Pan: right drag, Ctrl + middle drag, or Ctrl + left drag.
 *  - Zoom: wheel (towards the cursor), Shift + middle drag, or two-finger pinch.
 *  - Arrow keys: rotate 15° (Shift: 90°); Alt + ←/→ rolls the view.
 *
 * Exposes the small subset of OrbitControls' API the rest of the app uses
 * (target, object, enabled, update(), 'change' events).
 */
import * as THREE from 'three';

export type RotateStyle = 'free' | 'turntable';

type Mode = 'rotate' | 'pan' | 'zoom' | null;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class CadControls extends THREE.EventDispatcher<{ change: object; start: object; end: object }> {
  readonly target = new THREE.Vector3();
  enabled = true;
  /** 2D drawings: rotation disabled, every drag pans. */
  lock2D = false;
  rotateStyle: RotateStyle = 'free';
  /** Degrees of rotation per pixel of drag. */
  rotateSpeed = 0.4;
  invertWheel = false;
  minZoom = 0.01;
  maxZoom = 1e5;
  minDistance = 1e-4;
  maxDistance = 1e9;
  /** Returns the model point under the cursor, used as rotation/zoom pivot. */
  pickPoint: (clientX: number, clientY: number) => THREE.Vector3 | null = () => null;
  /** Rotation pivot when nothing is under the cursor. */
  fallbackPivot: () => THREE.Vector3 = () => this.target.clone();
  /** Called with the active pivot while rotating (null when done). */
  onPivot: (p: THREE.Vector3 | null) => void = () => {};

  private mode: Mode = null;
  private last = new THREE.Vector2();
  private pivot = new THREE.Vector3();
  private pointers = new Map<number, THREE.Vector2>();
  private pinchDist = 0;

  constructor(public object: THREE.OrthographicCamera | THREE.PerspectiveCamera, private dom: HTMLElement) {
    super();
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Re-orient the camera towards the target, keeping its up vector. */
  update() {
    this.object.lookAt(this.target);
    this.object.updateMatrixWorld();
  }

  private changed() {
    this.object.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  // ------------------------------------------------------------ pointer input
  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pointers.set(e.pointerId, new THREE.Vector2(e.clientX, e.clientY));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = a.distanceTo(b);
      this.last.set((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.mode = 'pan';
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    let mode: Mode = null;
    if (e.button === 2) mode = 'pan';
    else if (e.button === 1) mode = ctrl ? 'pan' : e.shiftKey ? 'zoom' : 'rotate';
    else if (e.button === 0) mode = ctrl ? 'pan' : 'rotate';
    if (this.lock2D && mode === 'rotate') mode = 'pan';
    if (!mode) return;
    if (e.button === 1) e.preventDefault(); // no auto-scroll
    this.mode = mode;
    this.last.set(e.clientX, e.clientY);
    if (mode === 'rotate') {
      this.pivot.copy(this.pickPoint(e.clientX, e.clientY) ?? this.fallbackPivot());
    } else if (mode === 'zoom') {
      this.pivot.copy(this.pickPoint(e.clientX, e.clientY) ?? this.target);
    }
    this.dom.setPointerCapture?.(e.pointerId);
    this.dispatchEvent({ type: 'start' });
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (p) p.set(e.clientX, e.clientY);
    // A gizmo may have taken over after pointerdown.
    if (!this.mode || !this.enabled) return;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = new THREE.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
      const d = a.distanceTo(b);
      this.panBy(mid.x - this.last.x, mid.y - this.last.y);
      if (this.pinchDist > 0) this.zoomAt(mid.x, mid.y, d / this.pinchDist);
      this.pinchDist = d;
      this.last.copy(mid);
      return;
    }
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    if (!dx && !dy) return;
    if (this.mode === 'rotate') {
      this.onPivot(this.pivot);
      this.rotateBy(dx * this.rotateSpeed, dy * this.rotateSpeed, this.pivot);
    } else if (this.mode === 'pan') this.panBy(dx, dy);
    else if (this.mode === 'zoom') this.zoomAbout(this.pivot, Math.exp(-dy * 0.01));
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      // Pinch ended with one finger left: continue as rotate from here.
      const [p] = [...this.pointers.values()];
      this.last.copy(p);
      this.mode = this.lock2D ? 'pan' : 'rotate';
      this.pivot.copy(this.fallbackPivot());
      return;
    }
    if (!this.mode) return;
    this.mode = null;
    this.onPivot(null);
    this.dom.releasePointerCapture?.(e.pointerId);
    this.dispatchEvent({ type: 'end' });
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    dy = Math.max(-200, Math.min(200, dy));
    if (this.invertWheel) dy = -dy;
    this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
  };

  // ------------------------------------------------------------ operations
  /**
   * Rotate the view by screen-space angles (degrees) about a world pivot.
   * Positive yaw turns the model to the right, positive pitch tilts it down.
   */
  rotateBy(yawDeg: number, pitchDeg: number, pivot?: THREE.Vector3) {
    const cam = this.object;
    const piv = pivot ?? this.fallbackPivot();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const up = this.rotateStyle === 'turntable' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(-yawDeg));
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, THREE.MathUtils.degToRad(-pitchDeg));
    _q.copy(qYaw).multiply(qPitch);
    this.applyRotation(_q, piv);
  }

  /** Roll about the viewing direction (degrees). */
  rollBy(deg: number) {
    const dir = this.object.getWorldDirection(new THREE.Vector3());
    _q.setFromAxisAngle(dir, THREE.MathUtils.degToRad(deg));
    this.applyRotation(_q, this.target);
  }

  private applyRotation(q: THREE.Quaternion, pivot: THREE.Vector3) {
    const cam = this.object;
    cam.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    cam.quaternion.premultiply(q);
    if (this.rotateStyle === 'turntable') {
      cam.up.set(0, 1, 0);
      // Avoid flipping over the poles.
      const dir = _v.subVectors(this.target, cam.position).normalize();
      if (Math.abs(dir.y) > 0.999) cam.up.set(0, 0, dir.y > 0 ? 1 : -1);
      cam.lookAt(this.target);
    } else cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.changed();
  }

  /** World size of one pixel at the target depth. */
  private worldPerPixel(): number {
    const cam = this.object;
    const h = Math.max(1, this.dom.clientHeight);
    if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
    const d = cam.position.distanceTo(this.target);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
  }

  panBy(dxPx: number, dyPx: number) {
    const cam = this.object;
    const s = this.worldPerPixel();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(-dxPx * s);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).multiplyScalar(dyPx * s);
    const off = right.add(up);
    cam.position.add(off);
    this.target.add(off);
    this.changed();
  }

  /** World point under a screen position on the plane through the target. */
  private pointOnTargetPlane(clientX: number, clientY: number): THREE.Vector3 {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.object);
    const n = this.object.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.target);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
  }

  /** Zoom by factor (>1 = closer) keeping the point under the cursor fixed. */
  zoomAt(clientX: number, clientY: number, factor: number) {
    const p = this.pickPoint(clientX, clientY) ?? this.pointOnTargetPlane(clientX, clientY);
    this.zoomAbout(p, factor);
  }

  zoomAbout(p: THREE.Vector3, factor: number) {
    const cam = this.object;
    if (cam instanceof THREE.OrthographicCamera) {
      const z0 = cam.zoom;
      const z1 = THREE.MathUtils.clamp(z0 * factor, this.minZoom, this.maxZoom);
      const k = z0 / z1; // < 1 when zooming in
      // Move camera and target in the view plane so p stays under the cursor.
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const toP = _v.subVectors(p, this.target);
      toP.sub(dir.clone().multiplyScalar(toP.dot(dir)));
      const shift = toP.multiplyScalar(1 - k);
      cam.position.add(shift);
      this.target.add(shift);
      cam.zoom = z1;
      cam.updateProjectionMatrix();
    } else {
      const d0 = cam.position.distanceTo(this.target);
      const d1 = THREE.MathUtils.clamp(d0 / factor, this.minDistance, this.maxDistance);
      const k = d1 / d0;
      cam.position.sub(p).multiplyScalar(k).add(p);
      this.target.sub(p).multiplyScalar(k).add(p);
    }
    this.changed();
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointercancel', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
  }
}
