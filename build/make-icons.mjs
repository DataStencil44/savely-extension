/**
 * Generator ikon rozszerzenia -> src/public/icons/icon-{16,32,48,128}.png
 *
 * Ikony sa wymagane nie tylko dla estetyki: `notifications.create` w Chrome
 * odmawia bez `iconUrl`, wiec bez pliku nie byloby komunikatow o bledach.
 *
 * Skrypt jest jednorazowy (wynik jest w repo) - odpalamy go tylko, gdy zmienia
 * sie ksztalt albo kolor: `node build/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

const ACCENT = [37, 99, 235];
const GLYPH = [255, 255, 255];

/** Zaokraglony kwadrat na calym plotnie. */
function inRoundedSquare(x, y, size) {
  const r = size * 0.22;
  const min = r;
  const max = size - r;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Zakladka: prostokat z wcieciem w ksztalcie V u dolu. */
function inBookmark(x, y, size) {
  const x0 = size * 0.33;
  const x1 = size * 0.67;
  const y0 = size * 0.2;
  const y1 = size * 0.8;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;

  const notchTop = size * 0.6;
  if (y <= notchTop) return true;

  const halfWidth = (x1 - x0) / 2;
  const progress = (y - notchTop) / (y1 - notchTop);
  return Math.abs(x - (x0 + halfWidth)) > halfWidth * progress;
}

/** Pokrycie piksela liczone przez nadprobkowanie 4x4 - tanie wygladzanie. */
function coverage(px, py, size, predicate) {
  const steps = 4;
  let hits = 0;
  for (let sy = 0; sy < steps; sy += 1) {
    for (let sx = 0; sx < steps; sx += 1) {
      const x = px + (sx + 0.5) / steps;
      const y = py + (sy + 0.5) / steps;
      if (predicate(x, y, size)) hits += 1;
    }
  }
  return hits / (steps * steps);
}

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const background = coverage(x, y, size, inRoundedSquare);
      const glyph = coverage(x, y, size, inBookmark) * background;
      const alpha = background;

      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        // Glyph na tle akcentu; oba juz przemnozone przez wlasne pokrycie.
        const value = ACCENT[channel] * (1 - glyph) + GLYPH[channel] * glyph;
        pixels[offset + channel] = Math.round(value);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
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
  header[8] = 8; // bit depth
  header[9] = 6; // truecolor + alpha
  // 10-12: compression, filter, interlace = 0

  // Kazdy wiersz poprzedzony bajtem filtra (0 = brak).
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
