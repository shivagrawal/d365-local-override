// One-off icon generator, not part of the runtime. Produces the extension's
// PNG icon set with zero dependencies (Node's built-in zlib for PNG's DEFLATE
// requirement), consistent with the rest of this project having none.
//
// Design: a rounded square split diagonally - navy (top-right, "the Dynamics
// resource") and accent orange (bottom-left, "the local override"), divided
// by a thin white seam. Reads clearly at 16px and scales cleanly to 128px.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const NAVY = [0x17, 0x20, 0x33];
const ORANGE = [0xf5, 0x7c, 0x2e];
const SEAM = [0xff, 0xff, 0xff];

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
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function cornerRadius(size) {
  return Math.round(size * 0.2);
}

function insideRoundedSquare(x, y, size, radius) {
  const cx = Math.min(x, size - 1 - x);
  const cy = Math.min(y, size - 1 - y);
  if (cx >= radius || cy >= radius) return true;
  const dx = radius - cx;
  const dy = radius - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function pixelColor(x, y, size) {
  const radius = cornerRadius(size);
  if (!insideRoundedSquare(x, y, size, radius)) return null;

  const seamWidth = Math.max(1, Math.round(size / 24));
  const diagonal = x + y - (size - 1);
  if (Math.abs(diagonal) <= seamWidth) return SEAM;
  return diagonal < 0 ? NAVY : ORANGE;
}

function buildPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const color = pixelColor(x, y, size);
      if (color) {
        raw[offset++] = color[0];
        raw[offset++] = color[1];
        raw[offset++] = color[2];
        raw[offset++] = 255;
      } else {
        offset += 4; // fully transparent (zero-initialized) outside the rounded square
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buildPng(size));
}

console.log(`Wrote icon16/32/48/128.png to ${outDir}`);
