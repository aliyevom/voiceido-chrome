/**
 * Minimal ZIP (store-only) builder. PNGs and text don't benefit much from
 * Deflate here, and avoiding a compression library keeps the extension
 * dependency-free. CRC-32 matches the ZIP APPNOTE spec.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date:
      ((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  if (entries.length === 0) throw new Error('ZIP has no files.');
  const { time, date } = dosDateTime(now);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const push = (dest: Uint8Array[], part: Uint8Array): void => {
    dest.push(part);
  };

  for (const entry of entries) {
    const name = enc.encode(entry.name.replace(/\\/g, '/'));
    const data = entry.data;
    const crc = crc32(data);
    const local = [
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ];
    const localSize = local.reduce((s, p) => s + p.length, 0);
    for (const part of local) chunks.push(part);

    const dir = [
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ];
    for (const part of dir) push(central, part);
    offset += localSize;
  }

  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ];

  const total =
    chunks.reduce((s, p) => s + p.length, 0) + centralSize + end.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...chunks, ...central, ...end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
