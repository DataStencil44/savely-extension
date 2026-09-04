/**
 * gzip + base64 dla treści artykułów.
 *
 * Treść to 90% objętości synchronizacji i jednocześnie tekst, który gzip tnie
 * do jednej piątej. Providery przyjmują pliki tekstowe (Gist trzyma tekst,
 * nie binaria), stąd base64 na wyjściu.
 *
 * `CompressionStream` jest natywne w Chrome 80+ i Firefoksie 113+ - żadnej
 * biblioteki do tego nie dokładamy.
 *
 * Funkcje żonglują `ArrayBuffer`, a nie `Uint8Array`, bo tylko ten pierwszy
 * jest bezspornym `BlobPart` - widok mógłby siedzieć na `SharedArrayBuffer`.
 */

/** Ile bajtów bierzemy naraz przy składaniu base64. */
const CHUNK = 0x8000;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  // `String.fromCharCode(...bytes)` na całości przepełnia stos argumentów przy
  // kilku megabajtach - stąd porcje.
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
  // Base64 z pliku bywa łamane co N znaków - białe znaki nie są danymi.
  const clean = value.replace(/\s+/g, '');
  const stream = new Blob([fromBase64(clean)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Blob([await collect(stream)]).text();
}
