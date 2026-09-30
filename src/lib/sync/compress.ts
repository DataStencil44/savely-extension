const CHUNK = 0x8000;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

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
  const clean = value.replace(/\s+/g, '');
  const stream = new Blob([fromBase64(clean)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Blob([await collect(stream)]).text();
}
