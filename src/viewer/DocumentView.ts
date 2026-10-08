/** Builds and owns the three.js objects of one loaded document. */
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { BodyData, ImageData2, LoadedModel, ModelNode, TextItem } from '../core/types';
import { bodiesDiagonal } from '../core/geometry';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type DisplayMode = 'shaded-edges' | 'shaded' | 'hlr' | 'wireframe' | 'transparent';

export interface BodyMeshData {
  body: BodyData;
  bodyIndex: number;
  node: ModelNode;
  /** Sorted triangle starts of faces, for faceIndex → face lookup. */
  faceStarts: Int32Array;
  edgeLines: THREE.LineSegments | null;
  shadedMaterial: THREE.MeshStandardMaterial;
  hidden: boolean;
}

export type BodyMesh = THREE.Mesh & { userData: { cad: BodyMeshData } };

const DEFAULT_COLOR = new THREE.Color(0.72, 0.75, 0.8);
const EDGE_COLOR = 0x1a1d22;

export class DocumentView {
  readonly root = new THREE.Group();
  readonly meshes: BodyMesh[] = [];
  readonly nodeObjects = new Map<ModelNode, THREE.Object3D>();
  readonly objectNodes = new Map<THREE.Object3D, ModelNode>();
  readonly edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
  readonly hlrMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  /** Lines-only bodies (drawings) are rendered with their own materials. */
  readonly lineObjects: THREE.LineSegments[] = [];
  readonly sheetObjects: THREE.Mesh[] = [];
  readonly textObjects: THREE.Mesh[] = [];
  displayMode: DisplayMode = 'shaded-edges';
  /** Absolute tolerance used for geometric classification (mm). */
  readonly tolerance: number;
  readonly diagonal: number;

  constructor(readonly model: LoadedModel) {
    this.root.name = model.name;
    this.diagonal = bodiesDiagonal(model.bodies);
    this.tolerance = Math.max(1e-4, this.diagonal * 2e-5);
    const build = (node: ModelNode, parent: THREE.Object3D) => {
      const g = new THREE.Group();
      g.name = node.name;
      if (node.matrix) {
        g.matrix.fromArray(node.matrix);
        g.matrix.decompose(g.position, g.quaternion, g.scale);
      }
      parent.add(g);
      this.nodeObjects.set(node, g);
      this.objectNodes.set(g, node);
      for (const bi of node.bodies) {
        const body = model.bodies[bi];
        if (!body) continue;
        if (body.linesOnly) this.buildLines(body, g);
        else this.buildMesh(body, bi, node, g);
      }
      for (const c of node.children) build(c, g);
    };
    build(model.root, this.root);
    if (model.sheets?.length && !model.bodies.some((b) => b.positions.length || b.linesOnly)) this.buildSheets(model.sheets);
    this.root.updateMatrixWorld(true);
  }

  private buildMesh(body: BodyData, bodyIndex: number, node: ModelNode, parent: THREE.Object3D) {
    let geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(body.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(body.indices, 1));
    const hasFaceColors = body.faces.some((f) => f.color);
    if (body.normals && body.normals.length === body.positions.length) {
      geom.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
    } else {
      // Flat shading for plain meshes: unshare vertices so normals stay per triangle.
      geom = geom.toNonIndexed();
      geom.computeVertexNormals();
    }
    if (hasFaceColors) {
      // Per-face colours need unshared vertices too.
      if (geom.index) geom = geom.toNonIndexed();
      const base = body.color ? new THREE.Color(...body.color) : DEFAULT_COLOR;
      const n = geom.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([base.r, base.g, base.b], i * 3);
      for (const f of body.faces)
        if (f.color) for (let t = f.triStart; t < f.triStart + f.triCount; t++) for (let k = 0; k < 3; k++) col.set(f.color, (t * 3 + k) * 3);
      geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    geom.computeBoundsTree({ indirect: true } as never);

    const color = body.color ? new THREE.Color(body.color[0], body.color[1], body.color[2]) : DEFAULT_COLOR.clone();
    const mat = new THREE.MeshStandardMaterial({
      color: hasFaceColors ? 0xffffff : color,
      vertexColors: hasFaceColors,
      metalness: 0.15,
      roughness: 0.55,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geom, mat) as unknown as BodyMesh;
    mesh.name = body.name;
    mesh.renderOrder = 10;

    let edgeLines: THREE.LineSegments | null = null;
    if (body.edges.length) {
      let nseg = 0;
      for (const e of body.edges) nseg += e.points.length / 3 - 1 + (e.closed ? 1 : 0);
      const arr = new Float32Array(nseg * 6);
      let o = 0;
      for (const e of body.edges) {
        const p = e.points, n = p.length / 3;
        const segs = n - 1 + (e.closed ? 1 : 0);
        for (let i = 0; i < segs; i++) {
          const a = i, b = (i + 1) % n;
          arr[o++] = p[a * 3]; arr[o++] = p[a * 3 + 1]; arr[o++] = p[a * 3 + 2];
          arr[o++] = p[b * 3]; arr[o++] = p[b * 3 + 1]; arr[o++] = p[b * 3 + 2];
        }
      }
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      edgeLines = new THREE.LineSegments(eg, this.edgeMaterial);
      edgeLines.renderOrder = 11;
      edgeLines.raycast = () => {}; // edges are picked in screen space
      mesh.add(edgeLines);
    }
    const faceStarts = Int32Array.from(body.faces.map((f) => f.triStart));
    mesh.userData.cad = { body, bodyIndex, node, faceStarts, edgeLines, shadedMaterial: mat, hidden: false };
    parent.add(mesh);
    this.meshes.push(mesh);
  }

  /** Drawings: one LineSegments per body with per-edge colours, plus text meshes. */
  private buildLines(body: BodyData, parent: THREE.Object3D) {
    let nseg = 0;
    for (const e of body.edges) nseg += e.points.length / 3 - 1 + (e.closed ? 1 : 0);
    const pos = new Float32Array(nseg * 6);
    const col = new Float32Array(nseg * 6);
    let o = 0;
    body.edges.forEach((e, ei) => {
      const c = body.edgeColors?.[ei] ?? [0.1, 0.1, 0.1];
      const p = e.points, n = p.length / 3;
      const segs = n - 1 + (e.closed ? 1 : 0);
      for (let i = 0; i < segs; i++) {
        const a = i, b = (i + 1) % n;
        pos.set([p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], o);
        col.set([...c, ...c], o);
        o += 6;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingBox();
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    lines.userData.cadLines = body;
    lines.raycast = () => {};
    parent.add(lines);
    this.lineObjects.push(lines);
    for (const t of body.texts || []) {
      const m = makeTextMesh(t);
      if (m) {
        parent.add(m);
        this.textObjects.push(m);
      }
    }
  }

  private buildSheets(sheets: ImageData2[]) {
    // One sheet is shown at a time (see setSheet), all centred on the origin.
    sheets.forEach((s) => {
      const tex = imageTexture(s);
      if (!tex) return;
      const { w, h } = tex.userData as { w: number; h: number };
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      mesh.name = s.name;
      mesh.visible = this.sheetObjects.length === 0;
      this.root.add(mesh);
      this.sheetObjects.push(mesh);
    });
  }

  activeSheet = 0;
  setSheet(i: number) {
    this.activeSheet = Math.max(0, Math.min(this.sheetObjects.length - 1, i));
    this.sheetObjects.forEach((m, k) => (m.visible = k === this.activeSheet));
  }

  get is2D() {
    return !!this.model.is2D || (this.sheetObjects.length > 0 && this.meshes.length === 0);
  }

  bounds(onlyVisible = true): THREE.Box3 {
    const box = new THREE.Box3();
    this.root.updateMatrixWorld(true);
    for (const m of this.meshes) {
      if (onlyVisible && !this.isEffectivelyVisible(m)) continue;
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      box.union(b);
    }
    for (const o of [...this.lineObjects, ...this.sheetObjects.filter((m) => m.visible)]) {
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox!.clone().applyMatrix4(o.matrixWorld));
    }
    return box;
  }

  isEffectivelyVisible(o: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = o;
    while (cur && cur !== this.root) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  setDisplayMode(mode: DisplayMode) {
    this.displayMode = mode;
    for (const m of this.meshes) {
      const cad = m.userData.cad;
      const shaded = cad.shadedMaterial;
      shaded.transparent = mode === 'transparent';
      shaded.opacity = mode === 'transparent' ? 0.35 : 1;
      shaded.depthWrite = mode !== 'transparent';
      shaded.needsUpdate = true;
      m.material = mode === 'hlr' ? this.hlrMaterial : shaded;
      // In wireframe the mesh stays in the scene (for picking) but draws nothing.
      (m.material as THREE.Material).visible = mode !== 'wireframe';
      if (cad.edgeLines) cad.edgeLines.visible = mode !== 'shaded';
    }
  }

  /** Apply clipping planes to every material owned by this document. */
  setClipping(planes: THREE.Plane[]) {
    const list = planes.length ? planes : null;
    const mats = new Set<THREE.Material>([this.edgeMaterial, this.hlrMaterial]);
    for (const m of this.meshes) mats.add(m.userData.cad.shadedMaterial);
    for (const l of this.lineObjects) mats.add(l.material as THREE.Material);
    for (const mat of mats) {
      mat.clippingPlanes = list;
      mat.needsUpdate = true;
    }
  }

  /** Meshes belonging to a node subtree. */
  meshesOf(node: ModelNode): BodyMesh[] {
    const obj = this.nodeObjects.get(node);
    if (!obj) return [];
    const out: BodyMesh[] = [];
    obj.traverse((o) => {
      if ((o as BodyMesh).userData?.cad) out.push(o as BodyMesh);
    });
    return out;
  }

  setNodeVisible(node: ModelNode, visible: boolean) {
    const obj = this.nodeObjects.get(node);
    if (obj) obj.visible = visible;
  }

  /** Tint the meshes of selected components. */
  setComponentHighlight(nodes: ModelNode[]) {
    for (const m of this.meshes) m.userData.cad.shadedMaterial.emissive.setHex(0x000000);
    for (const n of nodes) for (const m of this.meshesOf(n)) m.userData.cad.shadedMaterial.emissive.setHex(0x1d4f91);
  }

  faceIndexOfTriangle(mesh: BodyMesh, tri: number): number {
    const fs = mesh.userData.cad.faceStarts;
    let lo = 0, hi = fs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fs[mid] <= tri) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) {
        m.geometry.disposeBoundsTree?.();
        m.geometry.dispose();
      }
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => {
        (x as THREE.MeshBasicMaterial).map?.dispose();
        x.dispose();
      });
    });
    this.edgeMaterial.dispose();
    this.hlrMaterial.dispose();
  }
}

export function imageTexture(s: ImageData2): THREE.Texture | null {
  let tex: THREE.Texture;
  if (s.rgba && s.width && s.height) {
    // DataTexture rows are bottom-up; decoded RGBA is top-down.
    const flipped = new Uint8Array(s.rgba.length);
    const row = s.width * 4;
    for (let y = 0; y < s.height; y++) flipped.set(s.rgba.subarray(y * row, (y + 1) * row), (s.height - 1 - y) * row);
    tex = new THREE.DataTexture(flipped, s.width, s.height, THREE.RGBAFormat);
    tex.userData = { w: s.width, h: s.height };
  } else if (s.png) {
    const blob = new Blob([s.png as BlobPart], { type: 'image/png' });
    const img = new Image();
    const url = URL.createObjectURL(blob);
    tex = new THREE.Texture(img);
    // Size is read from the PNG IHDR so geometry can be built synchronously.
    const dv = new DataView(s.png.buffer, s.png.byteOffset, s.png.byteLength);
    tex.userData = { w: dv.getUint32(16), h: dv.getUint32(20) };
    img.onload = () => {
      tex.needsUpdate = true;
      URL.revokeObjectURL(url);
      window.dispatchEvent(new Event('cad-texture-loaded'));
    };
    img.src = url;
  } else return null;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeTextMesh(t: TextItem): THREE.Mesh | null {
  const lines = t.text.split('\n').filter((l) => l.length);
  if (!lines.length || t.height <= 0) return null;
  const px = 48;
  const lineH = px * 1.4;
  // Room above the cap height for Vietnamese stacked diacritics (Ấ, Ỗ…).
  const pad = px * 0.45;
  const font = `${px}px "Segoe UI", Roboto, Arial, sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  canvas.width = Math.ceil(w + 8);
  canvas.height = Math.ceil(pad + lines.length * lineH);
  ctx.font = font;
  const c = t.color ?? [0.1, 0.1, 0.1];
  ctx.fillStyle = `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
  ctx.textBaseline = 'alphabetic';
  const baseline0 = pad + px * 0.95;
  lines.forEach((l, i) => ctx.fillText(l, 2, baseline0 + i * lineH));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // CAD text height is the cap height (~0.72 em).
  const scale = t.height / (px * 0.72);
  const W = canvas.width * scale, H = canvas.height * scale;
  const geom = new THREE.PlaneGeometry(W, H);
  // Anchor: baseline-left of the first line (TEXT) or top-left (MTEXT).
  const anchorY = t.anchor === 'top' ? pad * scale : baseline0 * scale;
  // Plane spans y ∈ [-H/2, H/2] with canvas row 0 at the top; move the anchor to the origin.
  geom.translate(W / 2 - 2 * scale, anchorY - H / 2, 0);
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  mesh.position.set(t.position[0], t.position[1], t.position[2]);
  mesh.rotation.z = t.rotation;
  mesh.raycast = () => {};
  return mesh;
}
