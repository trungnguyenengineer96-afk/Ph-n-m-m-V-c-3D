/**
 * Parametric part model: an ordered list of features (SolidWorks FeatureManager).
 * Everything here is plain JSON so documents can be saved (.cvpart) and sent
 * to the geometry worker. Lengths in mm, angles in degrees.
 */
import type { Vec3 } from '../core/types';

// ---------------------------------------------------------------- planes
export type StdPlane = 'front' | 'top' | 'right';

/** A sketch plane: origin, x direction and normal (y = normal × x). */
export interface PlaneDef {
  origin: Vec3;
  xDir: Vec3;
  normal: Vec3;
  /** Standard plane name or a label such as "Mặt trên Boss-Extrude1". */
  label: string;
}

/** SolidWorks conventions: Front = XY (+Z), Top = XZ (+Y), Right = YZ (+X). */
export const STD_PLANES: Record<StdPlane, PlaneDef> = {
  front: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: 'Mặt trước (Front Plane)' },
  top: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 1, 0], label: 'Mặt trên (Top Plane)' },
  right: { origin: [0, 0, 0], xDir: [0, 0, -1], normal: [1, 0, 0], label: 'Mặt phải (Right Plane)' },
};

// ---------------------------------------------------------------- sketch
export interface SkPoint {
  id: string;
  x: number;
  y: number;
  fixed?: boolean;
}

export type SkEntity =
  | { id: string; type: 'line'; p1: string; p2: string; construction?: boolean }
  | { id: string; type: 'circle'; c: string; r: number; construction?: boolean }
  /** Counter-clockwise arc from p1 to p2 around c. */
  | { id: string; type: 'arc'; c: string; p1: string; p2: string; r: number; construction?: boolean };

export type SkConstraintType =
  | 'coincident' // p, p
  | 'horizontal' // line | p, p
  | 'vertical' // line | p, p
  | 'parallel' // line, line
  | 'perpendicular' // line, line
  | 'equal' // line, line | curve, curve
  | 'tangent' // line|curve, curve
  | 'fix' // p
  | 'onEntity' // p, line|curve
  | 'midpoint' // p, line
  | 'concentric' // curve, curve
  // driving dimensions (value)
  | 'distance' // p, p | p, line | line(length)
  | 'hdistance' // p, p
  | 'vdistance' // p, p
  | 'radius' // curve
  | 'diameter' // curve
  | 'angle'; // line, line

export interface SkConstraint {
  id: string;
  type: SkConstraintType;
  refs: string[];
  value?: number;
  /** Dimension label position in sketch coordinates. */
  label?: [number, number];
}

export interface SketchData {
  points: SkPoint[];
  entities: SkEntity[];
  constraints: SkConstraint[];
}

export const emptySketch = (): SketchData => ({
  points: [{ id: 'O', x: 0, y: 0, fixed: true }],
  entities: [],
  constraints: [],
});

// ---------------------------------------------------------------- features
export type EndCondition = 'blind' | 'throughAll' | 'midPlane';

export interface SketchFeature {
  id: string;
  type: 'sketch';
  name: string;
  plane: PlaneDef;
  sketch: SketchData;
  suppressed?: boolean;
}

export interface ExtrudeFeature {
  id: string;
  type: 'extrude';
  name: string;
  sketchId: string;
  cut: boolean;
  end: EndCondition;
  depth: number;
  reverse: boolean;
  suppressed?: boolean;
}

export interface RevolveFeature {
  id: string;
  type: 'revolve';
  name: string;
  sketchId: string;
  cut: boolean;
  /** Construction line of the sketch used as axis (first centerline if empty). */
  axisId?: string;
  angle: number;
  suppressed?: boolean;
}

/** Edges/faces are referenced by a point lying on them (world, mm). */
export interface FilletFeature {
  id: string;
  type: 'fillet' | 'chamfer';
  name: string;
  size: number;
  edges: Vec3[];
  suppressed?: boolean;
}

export interface ShellFeature {
  id: string;
  type: 'shell';
  name: string;
  thickness: number;
  faces: Vec3[];
  suppressed?: boolean;
}

export interface MirrorFeature {
  id: string;
  type: 'mirror';
  name: string;
  plane: StdPlane;
  suppressed?: boolean;
}

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature | ShellFeature | MirrorFeature;

export interface PartDocument {
  format: 'cadviewer-part';
  version: 1;
  name: string;
  features: Feature[];
}

export interface FeatureStatus {
  id: string;
  ok: boolean;
  error?: string;
}

export const FEATURE_LABEL: Record<Feature['type'], string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  shell: 'Shell',
  mirror: 'Mirror',
};

export function featureTitle(f: Feature): string {
  if (f.type === 'extrude') return f.cut ? 'Cắt Extrude (Cut-Extrude)' : 'Đùn khối (Boss-Extrude)';
  if (f.type === 'revolve') return f.cut ? 'Cắt xoay (Cut-Revolve)' : 'Xoay khối (Revolve)';
  return FEATURE_LABEL[f.type];
}
