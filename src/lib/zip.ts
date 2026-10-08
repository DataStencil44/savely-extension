export class ZipError extends Error {
  override readonly name = 'ZipError';
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_COMMENT = 0xffff;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const ZIP64_MARK = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });
  const reader = source.pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

export async function createZip(entries: readonly ZipEntry[], when = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressed = await transform(entry.data, new CompressionStream('deflate-raw'));
    const crc = crc32(entry.data);

    const local = new Uint8Array(LOCAL_HEADER + name.length + compressed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIGNATURE, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, DEFLATED, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, LOCAL_HEADER);
    local.set(compressed, LOCAL_HEADER + name.length);

    const central = new Uint8Array(CENTRAL_HEADER + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIGNATURE, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, DEFLATED, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, CENTRAL_HEADER);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(END_RECORD);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const result = new Uint8Array(offset + centralSize + END_RECORD);
  let position = 0;
  for (const part of [...locals, ...centrals, end]) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

function findEnd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - END_RECORD - MAX_COMMENT);
  for (let at = view.byteLength - END_RECORD; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at;
  }
  throw new ZipError('this is not a ZIP file.');
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === ZIP64_MARK) throw new ZipError('ZIP64 archives are not supported.');

  const files = new Map<string, Uint8Array>();
  try {
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipError('the archive is damaged.');

      const flags = view.getUint16(at + 8, true);
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const compressedSize = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localAt = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength));
      at += CENTRAL_HEADER + nameLength + extraLength + commentLength;

      if (name.endsWith('/')) continue;
      if ((flags & ENCRYPTED_FLAG) !== 0) throw new ZipError('encrypted archives are not supported.');
      if (compressedSize === ZIP64_MARK || size === ZIP64_MARK) {
        throw new ZipError('ZIP64 archives are not supported.');
      }
      if (view.getUint32(localAt, true) !== LOCAL_SIGNATURE) throw new ZipError('the archive is damaged.');

      const start =
        localAt + LOCAL_HEADER + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      const raw = bytes.subarray(start, start + compressedSize);
      if (raw.length !== compressedSize) throw new ZipError('the archive is cut short.');

      let data: Uint8Array;
      if (method === STORED) data = raw;
      else if (method === DEFLATED) data = await transform(raw, new DecompressionStream('deflate-raw'));
      else throw new ZipError(`"${name}" uses a compression method that is not supported.`);

      if (data.length !== size || crc32(data) !== crc) throw new ZipError(`"${name}" is damaged.`);
      files.set(name, data);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('the archive is damaged.');
  }
  return files;
}
