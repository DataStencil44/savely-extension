import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { ZipError, crc32, createZip, isZip, readZip } from './zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function storedZip(name: string, content: string, method = 0): Uint8Array {
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(content);
  const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
  const crc = crc32(data);

  const local = new Uint8Array(30 + nameBytes.length + body.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, method, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, body.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(body, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, body.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const zip = new Uint8Array(local.length + central.length + end.length);
  zip.set(local, 0);
  zip.set(central, local.length);
  zip.set(end, local.length + central.length);
  return zip;
}

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });

  it('reads back what it wrote, including non-ASCII names and content', async () => {
    const zip = await createZip([
      { name: 'savely-backup.json', data: encoder.encode('{"a":"zażółć"}'.repeat(500)) },
      { name: 'zakładki.html', data: encoder.encode('<p>gęś</p>') },
      { name: 'empty.txt', data: new Uint8Array() },
    ]);

    expect(isZip(zip)).toBe(true);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['savely-backup.json', 'zakładki.html', 'empty.txt']);
    expect(decoder.decode(files.get('zakładki.html'))).toBe('<p>gęś</p>');
    expect(decoder.decode(files.get('savely-backup.json'))).toBe('{"a":"zażółć"}'.repeat(500));
    expect(files.get('empty.txt')?.length).toBe(0);
  });

  it('writes real deflate that other tools can open', async () => {
    const content = 'the same line again\n'.repeat(1000);
    const zip = await createZip([{ name: 'a.txt', data: encoder.encode(content) }]);
    const view = new DataView(zip.buffer);
    const size = view.getUint32(18, true);

    expect(view.getUint16(8, true)).toBe(8);
    expect(size).toBeLessThan(content.length / 10);
    expect(decoder.decode(inflateRawSync(zip.subarray(30 + 5, 30 + 5 + size)))).toBe(content);
  });

  it('reads stored and deflated entries made elsewhere', async () => {
    expect(decoder.decode((await readZip(storedZip('a.txt', 'plain'))).get('a.txt'))).toBe('plain');
    expect(decoder.decode((await readZip(storedZip('b.txt', 'packed', 8))).get('b.txt'))).toBe('packed');
  });

  it('refuses what is not a zip, and a zip that was tampered with', async () => {
    await expect(readZip(encoder.encode('{"not":"a zip"}'))).rejects.toBeInstanceOf(ZipError);

    const zip = storedZip('a.txt', 'plain');
    zip[30 + 5] = 'P'.charCodeAt(0);
    await expect(readZip(zip)).rejects.toThrow('"a.txt" is damaged.');

    const cut = await createZip([{ name: 'a.txt', data: encoder.encode('x'.repeat(5000)) }]);
    await expect(readZip(cut.subarray(0, cut.length - 30))).rejects.toBeInstanceOf(ZipError);
  });
});
