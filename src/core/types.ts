/**
 * Neutral in-memory model shared by every loader. Lengths are millimetres.
 *
 * A model is a tree of nodes (assembly → sub-assembly → part). Each node
 * references bodies by index; a body is one triangle mesh made of B-rep
 * faces (contiguous triangle ranges) plus B-rep edges (polylines).
 */

export type Vec3 = [number, number, number];

export type SurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';

export interface SurfaceInfo {
  kind: SurfaceKind;
  /** Plane normal or rotation axis (unit). */
  axis?: Vec3;
  /** Point on the plane or on the axis. */
  origin?: Vec3;
  radius?: number;
  /** Cone half angle (radians). */
  halfAngle?: number;
  /** True when the values come from the source file rather than a mesh fit. */
  exact?: boolean;
}

export interface FaceInfo {
  /** First triangle (index into the body's triangle list). */
  triStart: number;
  triCount: number;
  /** Optional per-face colour (0..1). */
  color?: Vec3;
  /** Surface hint stored in the source file, if any. */
  surface?: SurfaceInfo;
  /** Identifier from the source B-rep (Parasolid node id etc.). */
  sourceId?: number;
}

export type EdgeKind = 'line' | 'circle' | 'arc' | 'curve';

export interface EdgeInfo {
  /** Ordered polyline points, xyz flattened. */
  points: Float32Array;
  closed: boolean;
  /** Filled lazily by analyseEdge(). */
  kind?: EdgeKind;
  length?: number;
  center?: Vec3;
  radius?: number;
  normal?: Vec3;
  /** Source B-rep edge id if known. */
  sourceId?: number;
}

export interface BodyData {
  name: string;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  color?: Vec3;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** Drawing-only bodies have no triangles, just edges (DXF). */
  linesOnly?: boolean;
  /** Text labels for 2D drawings. */
  texts?: TextItem[];
  /** Per-edge colours for drawings (rgb 0..1), parallel to edges. */
  edgeColors?: Vec3[];
}

export interface TextItem {
  text: string;
  position: Vec3;
  height: number;
  rotation: number; // radians
  color?: Vec3;
  /** 'baseline' (TEXT, default) or 'top' (MTEXT top-left attachment). */
  anchor?: 'baseline' | 'top';
}

export interface ModelNode {
  name: string;
  bodies: number[];
  children: ModelNode[];
  /** 4x4 column-major local transform (three.js order). Identity if absent. */
  matrix?: number[];
  /** Component referenced by an assembly file but not available (no geometry). */
  missing?: boolean;
  /** Component inserted from a separately opened file. */
  linked?: boolean;
  note?: string;
}

export interface ImageData2 {
  name: string;
  /** Encoded PNG bytes, or raw RGBA when width/height are set. */
  png?: Uint8Array;
  rgba?: Uint8ClampedArray;
  width?: number;
  height?: number;
}

export interface FileInfo {
  format: string;
  fileName: string;
  fileSize: number;
  properties: Record<string, string>;
  streams?: { name: string; size: number }[];
  previews: ImageData2[];
  references: string[];
  warnings: string[];
}

export type DocumentKind = 'part' | 'assembly' | 'drawing';

export interface LoadedModel {
  kind: DocumentKind;
  name: string;
  root: ModelNode;
  bodies: BodyData[];
  info: FileInfo;
  /** For drawings: show raster sheets instead of / in addition to vectors. */
  sheets?: ImageData2[];
  /** True when the model lies in the XY plane and should be viewed in 2D. */
  is2D?: boolean;
}
