/* AniKuoshi icon generator — pure Node (zlib), no deps.
   Draws the 空 brand mark on a rounded-square gradient. */
import zlib from "zlib";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "public", "icons");
fs.mkdirSync(OUT, { recursive: true });

// ---- minimal PNG encoder ----
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- draw helpers ----
const lerp = (a, b, t) => a + (b - a) * t;
const C1 = [124, 92, 255]; // #7c5cff violet
const C2 = [77, 214, 255]; // #4dd6ff cyan

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const glyphScale = size / 512;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // background: diagonal gradient
      const t = (x / size + y / size) / 2;
      let r = lerp(C1[0], C2[0], t), g = lerp(C1[1], C2[1], t), b = lerp(C1[2], C2[2], t);

      // rounded-corner mask
      const pad = size * 0.02;
      const rad = size * 0.225;
      const qx = Math.max(pad + rad - x, x - (size - pad - rad), 0);
      const qy = Math.max(pad + rad - y, y - (size - pad - rad), 0);
      const d = Math.hypot(qx, qy);
      const aa = Math.min(255, Math.max(0, (rad - d) * 3));
      if (aa <= 0) { rgba[i + 3] = 0; continue; }

      // glyph 空 — segment strokes in 512-space
      const gx = (x - cx) / glyphScale, gy = (y - cy) / glyphScale;
      const dist = (px, py, x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1;
        const L2 = dx * dx + dy * dy || 1;
        let tt = ((px - x1) * dx + (py - y1) * dy) / L2;
        tt = Math.max(0, Math.min(1, tt));
        return Math.hypot(px - (x1 + tt * dx), py - (y1 + tt * dy));
      };
      const on = 4.4;
      const strokes = [
        [-118, -104, 0, -152, on], [0, -152, 118, -104, on],        // roof
        [-92, -58, -92, 116, on], [92, -58, 92, 116, on],           // box sides
        [-92, 116, 92, 116, on],                                     // box bottom
        [-54, -20, 54, -20, on * 0.85],                              // inner top
        [0, -52, 0, 82, on * 0.85],                                  // inner vertical
        [-54, 48, 54, 48, on * 0.85],                                // inner bottom
      ];
      let minD = Infinity;
      for (const [x1, y1, x2, y2, w] of strokes) {
        minD = Math.min(minD, dist(gx, gy, x1, y1, x2, y2) - w);
      }
      const inkA = Math.min(255, Math.max(0, -minD * 2.4)); // soft AA ink
      if (inkA > 0) { r = lerp(r, 255, inkA / 255); g = lerp(g, 255, inkA / 255); b = lerp(b, 255, inkA / 255); }

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(Math.min(255, aa));
    }
  }
  return encodePNG(size, size, rgba);
}

for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512], ["apple-touch-icon.png", 180], ["favicon-32.png", 32]]) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log("wrote", name, size);
}
console.log("icons done");
