// Generates public/samples/demo_flange.dxf: a simple flange drawing (front + side view)
// using basic R12 entities (LINE, CIRCLE, ARC, TEXT). Run: node scripts/make-demo-dxf.mjs
import { writeFileSync } from 'node:fs';

const out = [];
const g = (code, value) => out.push(String(code), String(value));
const line = (x1, y1, x2, y2, layer = 'OUTLINE', color = 7) => {
  g(0, 'LINE'); g(8, layer); g(62, color); g(10, x1); g(20, y1); g(30, 0); g(11, x2); g(21, y2); g(31, 0);
};
const circle = (x, y, r, layer = 'OUTLINE', color = 7) => {
  g(0, 'CIRCLE'); g(8, layer); g(62, color); g(10, x); g(20, y); g(30, 0); g(40, r);
};
const arc = (x, y, r, a0, a1, layer = 'OUTLINE', color = 7) => {
  g(0, 'ARC'); g(8, layer); g(62, color); g(10, x); g(20, y); g(30, 0); g(40, r); g(50, a0); g(51, a1);
};
const text = (x, y, h, s, color = 7, rot = 0) => {
  g(0, 'TEXT'); g(8, 'TEXT'); g(62, color); g(10, x); g(20, y); g(30, 0); g(40, h); g(1, s); if (rot) g(50, rot);
};

g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$INSUNITS'); g(70, 4); g(0, 'ENDSEC');
g(0, 'SECTION'); g(2, 'ENTITIES');

// Front view: flange Ø160, bore Ø60, PCD 120 with 6 holes Ø14, hub Ø90
const cx = 0, cy = 0;
circle(cx, cy, 80);
circle(cx, cy, 45, 'HIDDEN', 8);
circle(cx, cy, 30);
circle(cx, cy, 60, 'CENTER', 1);
for (let i = 0; i < 6; i++) {
  const a = (i * Math.PI) / 3;
  circle(cx + 60 * Math.cos(a), cy + 60 * Math.sin(a), 7);
}
line(-95, 0, 95, 0, 'CENTER', 1);
line(0, -95, 0, 95, 'CENTER', 1);
// keyway
line(-8, 30, -8, 36); line(-8, 36, 8, 36); line(8, 36, 8, 30);

// Side view (section) to the right: thickness 20, hub 40 long
const sx = 160;
line(sx, -80, sx + 20, -80); line(sx + 20, -80, sx + 20, -45); line(sx + 20, -45, sx + 40, -45);
line(sx + 40, -45, sx + 40, 45); line(sx + 40, 45, sx + 20, 45); line(sx + 20, 45, sx + 20, 80);
line(sx + 20, 80, sx, 80); line(sx, 80, sx, -80);
line(sx, -30, sx + 40, -30, 'HIDDEN', 8); line(sx, 30, sx + 40, 30, 'HIDDEN', 8);
line(sx - 10, 0, sx + 50, 0, 'CENTER', 1);
arc(sx + 20, 45, 3, 90, 180);

// Dimensions (drawn as plain geometry + text)
line(-80, -110, 80, -110, 'DIM', 3); line(-80, -105, -80, -115, 'DIM', 3); line(80, -105, 80, -115, 'DIM', 3);
text(-12, -106, 5, '%%c160', 3);
line(sx, -100, sx + 40, -100, 'DIM', 3);
text(sx + 12, -96, 5, '40', 3);
text(-60, 112, 6, 'MẶT BÍCH DN60 — PN16', 5);
text(-60, 103, 4, '6 lỗ %%c14 trên PCD %%c120', 5);

// Title block
const tx = -100, ty = -170;
line(tx, ty, tx + 330, ty, 'FRAME'); line(tx + 330, ty, tx + 330, ty + 40, 'FRAME');
line(tx + 330, ty + 40, tx, ty + 40, 'FRAME'); line(tx, ty + 40, tx, ty, 'FRAME');
line(tx + 200, ty, tx + 200, ty + 40, 'FRAME'); line(tx + 200, ty + 20, tx + 330, ty + 20, 'FRAME');
text(tx + 6, ty + 24, 7, 'FLANGE DN60', 7);
text(tx + 6, ty + 8, 4, 'Vật liệu: Thép C45  —  Tỉ lệ 1:1', 7);
text(tx + 206, ty + 26, 4, 'Bản vẽ số: DEMO-001', 7);
text(tx + 206, ty + 6, 4, 'Đơn vị: mm', 7);

g(0, 'ENDSEC');
g(0, 'EOF');
writeFileSync(new URL('../public/samples/demo_flange.dxf', import.meta.url), out.join('\n') + '\n');
console.log('wrote demo_flange.dxf');
