/** Inline SVG icons (24×24, stroke-based). */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  open: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4L22 12H7.2a2 2 0 0 0-1.9 1.4L3 20"/>'),
  folder: svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  samples: svg('<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
  measure: svg('<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>'),
  mass: svg('<path d="M6.5 8h11l2.5 12H4z"/><circle cx="12" cy="5" r="2.2"/>'),
  section: svg('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 12h18" stroke-dasharray="2 2"/><path d="M3 7l9 5 9-5"/>'),
  explode: svg('<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3"/><path d="M3 3h3M3 3v3M21 3h-3M21 3v3M3 21h3M3 21v-3M21 21h-3M21 21v-3"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  export: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  cube: svg('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
  display: svg('<path d="M12 2 3 7v10l9 5 9-5V7z" fill="currentColor" fill-opacity=".25"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
  persp: svg('<path d="M4 6h16l-3 12H7z"/><path d="M12 6v12"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.3M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  assembly: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/>'),
  part: svg('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
  body: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/>'),
  drawing: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 16h18M14 16v4"/><circle cx="9" cy="10" r="3"/>'),
  missing: svg('<path d="M12 2 3 7v10l9 5 9-5V7z" stroke-dasharray="3 2"/><path d="M12 9v4M12 16.5v.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  caret: svg('<path d="m9 6 6 6-6 6"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  pin: svg('<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v7"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  move: svg('<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>'),
  play: svg('<path d="M7 4v16l13-8z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  tree: svg('<path d="M4 4h6v4H4zM14 10h6v4h-6zM14 17h6v4h-6z"/><path d="M7 8v11h7M7 12h7"/>'),
  normal: svg('<path d="M4 18h16"/><path d="M12 18V5M8.5 8.5 12 5l3.5 3.5"/>'),
  check: svg('<path d="M4 12l5 5L20 6"/>'),
  select: svg('<path d="M5 3l14 8-6 2-2 6z"/>'),
  line: svg('<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>'),
  centerline: svg('<path d="M4 19 20 5" stroke-dasharray="4 2 1 2"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx=".5"/>'),
  circle: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>'),
  arc: svg('<path d="M4 17a9 9 0 0 1 16 0"/><circle cx="4" cy="17" r="1.4"/><circle cx="20" cy="17" r="1.4"/>'),
  dimension: svg('<path d="M4 8v10M20 8v10M4 13h16M7 10l-3 3 3 3M17 10l3 3-3 3"/>'),
  relation: svg('<path d="M5 18 18 5"/><path d="M6 6h5M6 6v5"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>'),
  extrude: svg('<path d="M4 15l8 4 8-4-8-4z"/><path d="M4 15V8l8-4 8 4v7"/><path d="M12 11V4"/>'),
  revolve: svg('<ellipse cx="12" cy="12" rx="8" ry="3.5"/><path d="M12 3v18"/><path d="M17 6.5l3 2-3.5 1"/>'),
  cutextrude: svg('<path d="M3 16l9 4 9-4-9-4z"/><path d="M8 14v-5l4-2 4 2v5" stroke-dasharray="2 2"/>'),
  fillet: svg('<path d="M4 20V10a6 6 0 0 1 6-6h10"/><path d="M4 4h4M4 4v4" opacity=".5"/>'),
  chamfer: svg('<path d="M4 20V10l6-6h10"/>'),
  shell: svg('<rect x="3.5" y="5" width="17" height="14" rx="1"/><rect x="7" y="8.5" width="10" height="7" rx=".5"/>'),
  mirror: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7 4 12l5 5z"/><path d="m15 7 5 5-5 5z"/>'),
  newpart: svg('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M12 9v6M9 12h6"/>'),
  iso: svg('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
};

export function icon(name: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = ICONS[name] ?? '';
  return s;
}
