/**
 * Mochi 应用图标生成脚本（node scripts/gen-icon.mjs）
 *
 * 纯 JS 生成 1024×1024 RGBA PNG（零依赖：node:zlib + 手写 PNG 编码），
 * 画面 = 项目内置宠物形象的同款设计（粉白团子 + 高光眼 + 腮红 + 微笑），
 * 保证"安装包图标 ↔ 桌宠形象"视觉一致。
 *
 * 产物：src-tauri/icons/app-icon.png → 交给 `pnpm tauri icon` 生成全尺寸 icns/ico/png。
 * 为什么手写 PNG：图标一次性产物，不值得为它引入 canvas/sharp 依赖。
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;

// ── PNG 编码（RGBA8，filter 0）─────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 画布与绘图原语 ──────────────────────────────────────────────────────
const px = new Uint8ClampedArray(SIZE * SIZE * 4); // 默认全透明
const blend = (x, y, [r, g, b, a]) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  const oa = px[i + 3] / 255;
  const outA = na + oa * (1 - na);
  if (outA === 0) return;
  px[i] = (r * na + px[i] * oa * (1 - na)) / outA;
  px[i + 1] = (g * na + px[i + 1] * oa * (1 - na)) / outA;
  px[i + 2] = (b * na + px[i + 2] * oa * (1 - na)) / outA;
  px[i + 3] = outA * 255;
};
/** 实心椭圆（cx,cy,rx,ry），edge 为抗锯齿过渡像素数 */
const ellipse = (cx, cy, rx, ry, color, edge = 2.5) => {
  for (let y = Math.floor(cy - ry - edge); y <= Math.ceil(cy + ry + edge); y++) {
    for (let x = Math.floor(cx - rx - edge); x <= Math.ceil(cx + rx + edge); x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; // 归一化距离²
      if (d > (1 + edge / Math.min(rx, ry)) ** 2) continue;
      const alpha = d <= 1 ? 255 : Math.round(255 * Math.max(0, 1 - (Math.sqrt(d) - 1) / (edge / Math.min(rx, ry))));
      blend(x, y, [color[0], color[1], color[2], (color[3] ?? 255) * (alpha / 255)]);
    }
  }
};
/** 圆角粗线（贝塞尔曲线路径，用于嘴/刘海弧线） */
const bezierStroke = (p0, p1, p2, width, color, steps = 160) => {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    ellipse(x, y, width / 2, width / 2, color, 1.5);
  }
};

// ── Mochi 主体（与 src/assets/pet/idle.svg 同款配色与比例）──────────
const BODY_TOP = [255, 252, 249];
const BODY_EDGE = [255, 228, 236];
const INK = [74, 63, 63];
const BLUSH = [255, 196, 208];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 团子：上圆下宽的椭圆（中心 512,556，rx 420 ry 436），2.5px 抗锯齿边
    const d = ((x - 512) / 420) ** 2 + ((y - 556) / 436) ** 2;
    if (d > 1.02) continue;
    const alpha = d <= 1 ? 255 : Math.round(255 * Math.max(0, 1 - (Math.sqrt(d) - 1) / 0.006));
    // 径向渐变：中心亮、边缘粉
    const t = Math.min(1, Math.sqrt(((x - 512) / 520) ** 2 + ((y - 380) / 560) ** 2));
    const r = BODY_TOP[0] + (BODY_EDGE[0] - BODY_TOP[0]) * t;
    const g = BODY_TOP[1] + (BODY_EDGE[1] - BODY_TOP[1]) * t;
    const b = BODY_TOP[2] + (BODY_EDGE[2] - BODY_TOP[2]) * t;
    blend(x, y, [r, g, b, alpha]);
  }
}

// 腮红
ellipse(300, 640, 78, 48, [...BLUSH, 217]);
ellipse(724, 640, 78, 48, [...BLUSH, 217]);

// 眼睛：椭圆眼 + 白色高光
ellipse(372, 496, 40, 50, INK);
ellipse(652, 496, 40, 50, INK);
ellipse(388, 478, 14, 14, [255, 255, 255]);
ellipse(668, 478, 14, 14, [255, 255, 255]);

// 微笑：二次贝塞尔（svg M370 585 Q 512 636 654 585 同款弧度）
bezierStroke([370, 585], [512, 640], [654, 585], 22, INK);

// 使用脚本自身位置定位，避免从其他目录执行时把图标落到错误位置。
writeFileSync(new URL("../src-tauri/icons/app-icon.png", import.meta.url), encodePNG(px, SIZE, SIZE));
console.log(`src-tauri/icons/app-icon.png 生成完成（${SIZE}×${SIZE}）`);
