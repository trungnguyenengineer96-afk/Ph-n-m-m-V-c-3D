/**
 * Feature regeneration with replicad (OpenCascade). Runs in a worker in the
 * app and directly in tests; setOC() must have been called first.
 */
import { draw, drawCircle, EdgeFinder, FaceFinder, Plane, type Drawing, type Shape3D } from 'replicad';
import type { BodyData, FaceInfo, Vec3 } from '../core/types';
import { chainSegments, mergeCoCircularArcs } from '../core/geometry';
import { findProfiles, type Loop, type Region } from './profiles';
import type { Feature, FeatureStatus, PlaneDef, SketchFeature } from './types';

export interface RegenResult {
  shape: Shape3D | null;
  status: FeatureStatus[];
}

/** Edge/face references are points taken from the display mesh (float32), so match within 0.01 mm. */
const REF_TOL = 0.01;

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function planeOf(def: PlaneDef): Plane {
  return new Plane(def.origin, def.xDir, def.normal);
}

/** Sketch (u, v) → world coordinates. */
export function toWorld(def: PlaneDef, u: number, v: number): Vec3 {
  const y = cross(def.normal, def.xDir);
  return [0, 1, 2].map((k) => def.origin[k] + def.xDir[k] * u + y[k] * v) as Vec3;
}

function loopDrawing(l: Loop): Drawing {
  if (l.circle) return drawCircle(l.circle.r).translate(l.circle.c[0], l.circle.c[1]);
  let pen = draw(l.segs[0].a);
  for (const s of l.segs) pen = s.kind === 'line' ? pen.lineTo(s.b) : pen.threePointsArcTo(s.b, s.mid);
  return pen.close();
}

function regionDrawing(r: Region): Drawing {
  let d = loopDrawing(r.outer);
  for (const h of r.holes) d = d.cut(loopDrawing(h));
  return d;
}

export function sketchDrawing(f: SketchFeature): Drawing {
  const prof = findProfiles(f.sketch);
  if (!prof.regions.length) throw new Error(prof.errors[0] ?? 'Sketch không có biên dạng kín');
  let d = regionDrawing(prof.regions[0]);
  for (const r of prof.regions.slice(1)) d = d.fuse(regionDrawing(r));
  return d;
}

function solidOf(x: unknown): Shape3D {
  return x as Shape3D;
}

export function regenerate(features: Feature[], upTo = Infinity): RegenResult {
  let shape: Shape3D | null = null;
  const status: FeatureStatus[] = [];
  const sketches = new Map<string, SketchFeature>();
  const bigLength = () => {
    if (!shape) return 10000;
    const b = shape.boundingBox;
    return Math.max(1000, b.width + b.height + b.depth) * 4;
  };
  features.forEach((f, idx) => {
    if (idx >= upTo) return;
    if (f.suppressed) {
      status.push({ id: f.id, ok: true });
      if (f.type === 'sketch') sketches.set(f.id, f);
      return;
    }
    try {
      switch (f.type) {
        case 'sketch':
          sketches.set(f.id, f);
          break;
        case 'extrude': {
          const sk = sketches.get(f.sketchId);
          if (!sk) throw new Error('Không tìm thấy sketch');
          const drawing = sketchDrawing(sk);
          let depth = f.end === 'throughAll' ? bigLength() : f.depth;
          if (!(depth > 0)) throw new Error('Chiều sâu phải > 0');
          let plane = sk.plane;
          const n = sk.plane.normal;
          let sign = f.reverse ? -1 : 1;
          if (f.cut && f.end !== 'midPlane') sign = -sign; // cuts go into the material by default
          if (f.end === 'midPlane') {
            plane = { ...plane, origin: plane.origin.map((o, k) => o - (n[k] * depth) / 2) as Vec3 };
          } else if (sign < 0) {
            plane = { ...plane, origin: plane.origin.map((o, k) => o - n[k] * depth) as Vec3 };
          }
          if (f.end === 'throughAll' && f.cut) {
            // Through all: cover both sides of the sketch plane.
            plane = { ...sk.plane, origin: sk.plane.origin.map((o, k) => o - n[k] * depth) as Vec3 };
            depth *= 2;
          }
          const tool = solidOf((drawing.sketchOnPlane(planeOf(plane)) as unknown as { extrude: (d: number) => Shape3D }).extrude(depth));
          shape = combine(shape, tool, f.cut);
          break;
        }
        case 'revolve': {
          const sk = sketches.get(f.sketchId);
          if (!sk) throw new Error('Không tìm thấy sketch');
          const axis = sk.sketch.entities.find((e) => e.type === 'line' && (f.axisId ? e.id === f.axisId : e.construction));
          if (!axis || axis.type !== 'line') throw new Error('Cần một đường tâm (centerline) làm trục xoay');
          const p = (id: string) => sk.sketch.points.find((q) => q.id === id)!;
          const a = p(axis.p1), b = p(axis.p2);
          const wa = toWorld(sk.plane, a.x, a.y), wb = toWorld(sk.plane, b.x, b.y);
          const dir: Vec3 = [wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2]];
          const drawing = sketchDrawing(sk);
          const sketch = drawing.sketchOnPlane(planeOf(sk.plane)) as unknown as { revolve: (axis: Vec3, o: { origin: Vec3; angle: number }) => Shape3D };
          const tool = sketch.revolve(dir, { origin: wa, angle: Math.max(0.1, Math.min(360, f.angle)) });
          shape = combine(shape, tool, f.cut);
          break;
        }
        case 'fillet':
        case 'chamfer': {
          if (!shape) throw new Error('Chưa có khối để bo/vát');
          if (!f.edges.length) throw new Error('Chưa chọn cạnh');
          if (!(f.size > 0)) throw new Error('Kích thước phải > 0');
          const filter = (e: EdgeFinder) => e.either(f.edges.map((p) => (x: EdgeFinder) => x.near(p, REF_TOL)));
          const cur: Shape3D = shape;
          shape = f.type === 'fillet' ? cur.fillet(f.size, filter) : cur.chamfer(f.size, filter);
          break;
        }
        case 'shell': {
          if (!shape) throw new Error('Chưa có khối để làm vỏ');
          if (!(f.thickness > 0)) throw new Error('Độ dày phải > 0');
          if (!f.faces.length) throw new Error('Chưa chọn mặt để mở');
          const cur: Shape3D = shape;
          shape = cur.shell(f.thickness, (ff: FaceFinder) => ff.either(f.faces.map((p) => (x: FaceFinder) => x.near(p, REF_TOL))));
          break;
        }
        case 'mirror': {
          if (!shape) throw new Error('Chưa có khối để đối xứng');
          const n = { front: [0, 0, 1], top: [0, 1, 0], right: [1, 0, 0] }[f.plane] as Vec3;
          const cur: Shape3D = shape;
          shape = cur.fuse(cur.clone().mirror(n, [0, 0, 0]) as Shape3D);
          break;
        }
      }
      status.push({ id: f.id, ok: true });
    } catch (e) {
      status.push({ id: f.id, ok: false, error: errorText(e) });
    }
  });
  return { shape, status };
}

function combine(base: Shape3D | null, tool: Shape3D, cut: boolean): Shape3D {
  if (cut) {
    if (!base) throw new Error('Không có khối để cắt');
    return base.cut(tool);
  }
  return base ? base.fuse(tool) : tool;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'number') return 'Lỗi hình học OpenCascade — kiểm tra kích thước / biên dạng';
  return String(e);
}

/** Tessellate a shape into the viewer's BodyData. */
export function shapeToBody(shape: Shape3D, name: string, tolerance = 0.02, angularTolerance = 0.2): BodyData {
  const m = shape.mesh({ tolerance, angularTolerance });
  const positions = new Float32Array(m.vertices);
  const normals = new Float32Array(m.normals);
  const indices = new Uint32Array(m.triangles);
  const faces: FaceInfo[] = m.faceGroups.map((g) => ({ triStart: g.start / 3, triCount: g.count / 3, sourceId: g.faceId }));
  const em = shape.meshEdges({ tolerance, angularTolerance });
  const edges = em.edgeGroups.flatMap((g) => {
    const seg: number[] = [];
    // lines holds consecutive segment endpoint pairs (xyz each); start/count are in points.
    for (let i = g.start; i < g.start + g.count; i += 2) seg.push(...em.lines.slice(i * 3, i * 3 + 6));
    return chainSegments(seg).map((c) => ({ points: c.points, closed: c.closed, sourceId: g.edgeId }));
  });
  return { name, positions, normals, indices, faces, edges: mergeCoCircularArcs(edges, 1e-3) };
}
