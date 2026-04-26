#!/usr/bin/env node
// Legacy placeholder icon generator. The shipped extension now uses real
// VoiceIDO brand assets committed under public/icons/ (cropped glyph from
// frontend/visual/Vertical/Color_vertical.png), so this script is no
// longer invoked by `npm run build`. It is preserved as `npm run icons`
// for two scenarios:
//   1. A contributor wants to regenerate quick stand-in icons without
//      access to the brand kit.
//   2. CI smoke tests that need a self-contained icon pipeline.
//
// Running this script will overwrite public/icons/* with the placeholder
// purple-gradient "page+camera" mark — only do that intentionally.

import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pre-computed CRC32 table for PNG chunks (avoids relying on Node 22+ zlib.crc32).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'public', 'icons');

const SIZES = [16, 32, 48, 128, 192, 512];

/**
 * Encode a PNG from raw RGBA pixel data.
 * @param {Uint8Array} rgba - flat RGBA buffer of length 4 * width * height
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Apply filter byte (0 = none) for each row, then deflate.
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(filtered, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Render the brand icon at the given size.
 * @param {number} size
 * @returns {Uint8Array}
 */
function renderIcon(size) {
  const buf = new Uint8Array(size * size * 4);
  const cornerRadius = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded-square mask
      if (!insideRoundedSquare(x + 0.5, y + 0.5, size, cornerRadius)) {
        buf[idx + 3] = 0;
        continue;
      }

      // Vertical purple gradient: #6d28d9 -> #4338ca
      const t = y / size;
      const r = lerp(0x6d, 0x43, t);
      const g = lerp(0x28, 0x38, t);
      const b = lerp(0xd9, 0xca, t);

      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }

  drawCameraGlyph(buf, size);
  return buf;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function insideRoundedSquare(x, y, size, radius) {
  if (x < radius && y < radius) {
    return distance(x, y, radius, radius) <= radius;
  }
  if (x > size - radius && y < radius) {
    return distance(x, y, size - radius, radius) <= radius;
  }
  if (x < radius && y > size - radius) {
    return distance(x, y, radius, size - radius) <= radius;
  }
  if (x > size - radius && y > size - radius) {
    return distance(x, y, size - radius, size - radius) <= radius;
  }
  return true;
}

function distance(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Draw a small white "camera + page" glyph centred in the icon.
 */
function drawCameraGlyph(buf, size) {
  const cx = size / 2;
  const cy = size / 2;

  // Outer page rectangle
  const pageW = size * 0.62;
  const pageH = size * 0.46;
  const pageX = cx - pageW / 2;
  const pageY = cy - pageH / 2 + size * 0.02;
  fillRect(buf, size, pageX, pageY, pageW, pageH, [255, 255, 255, 235]);

  // Inner camera body lens
  const lensR = size * 0.13;
  fillCircle(buf, size, cx, cy + size * 0.02, lensR, [109, 40, 217, 255]);
  fillCircle(buf, size, cx, cy + size * 0.02, lensR * 0.55, [255, 255, 255, 255]);

  // Page horizontal rules to suggest "full page"
  const ruleColor = [109, 40, 217, 200];
  const ruleH = Math.max(1, Math.round(size * 0.018));
  const ruleW = pageW * 0.36;
  fillRect(buf, size, pageX + size * 0.06, pageY + size * 0.07, ruleW, ruleH, ruleColor);
  fillRect(buf, size, pageX + pageW - size * 0.06 - ruleW, pageY + size * 0.07, ruleW, ruleH, ruleColor);
}

function fillRect(buf, size, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(size, Math.ceil(x + w));
  const y1 = Math.min(size, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      blend(buf, (py * size + px) * 4, color);
    }
  }
}

function fillCircle(buf, size, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(size, Math.ceil(cx + r));
  const y1 = Math.min(size, Math.ceil(cy + r));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) {
        blend(buf, (py * size + px) * 4, color);
      }
    }
  }
}

function blend(buf, idx, [r, g, b, a]) {
  const srcA = a / 255;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(renderIcon(size), size, size);
  const path = resolve(outDir, `icon${size}.png`);
  await writeFile(path, png);
  console.log(`[icons] wrote ${path} (${png.length} bytes)`);
}
