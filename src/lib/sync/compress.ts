/**
 * gzip + base64 for article content.
 *
 * Content is 90% of the sync volume and, at the same time, text that gzip cuts
 * to a fifth. Providers accept text files (a Gist stores text, not binaries),
 * hence base64 on the way out.
 *
 * `CompressionStream` is native in Chrome 80+ and Firefox 113+ - we add no
 * library for this.
 *
 * The functions juggle `ArrayBuffer` rather than `Uint8Array`, because only the
 * former is an unambiguous `BlobPart` - a view could sit on a
 * `SharedArrayBuffer`.
 */

/** How many bytes we take at a time while assembling base64. */
const CHUNK = 0x8000;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  // `String.fromCharCode(...bytes)` over the whole array overflows the argument
  // stack at a few megabytes - hence the chunks.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let total = 0;

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }

  const buffer = new ArrayBuffer(total);
  const result = new Uint8Array(buffer);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return buffer;
}

export async function gzipToBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return toBase64(await collect(stream));
}

export async function gunzipFromBase64(value: string): Promise<string> {
  // Base64 from a file is sometimes wrapped every N characters - whitespace is not data.
  const clean = value.replace(/\s+/g, '');
  const stream = new Blob([fromBase64(clean)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Blob([await collect(stream)]).text();
}
