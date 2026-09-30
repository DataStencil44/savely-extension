import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

const BACKGROUND = [43, 42, 41];
const BLUE = [44, 94, 215];
const VIOLET = [66, 67, 162];

function colorAt(x, y) {
  if (x < 85 || x > 425 || y < 55 || y > 440) return BACKGROUND;
  const side = (x - 425) * (440 - 55) - (y - 55) * (85 - 425);
  if (side < 0) return BLUE;
  return (y - 247.5) * (425 - 255) <= (x - 255) * (440 - 247.5) ? VIOLET : BACKGROUND;
}

function renderRgba(size) {
  const steps = 4;
  const scale = 512 / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < steps; sy += 1) {
        for (let sx = 0; sx < steps; sx += 1) {
          const color = colorAt((x + (sx + 0.5) / steps) * scale, (y + (sy + 0.5) / steps) * scale);
          for (let channel = 0; channel < 3; channel += 1) sum[channel] += color[channel];
        }
      }
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(sum[channel] / (steps * steps));
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, renderRgba(size)));
  console.log(`[savely] ${file}`);
}
