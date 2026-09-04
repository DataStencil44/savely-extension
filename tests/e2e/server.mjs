/**
 * Serwer fixture'ow dla testow e2e.
 *
 * Zapis idzie sciezka A (content script w karcie), a ta wymaga prawdziwego
 * adresu http - `file://` w Chrome jest poza zasiegiem rozszerzenia bez
 * osobnej zgody. Stad kilkanascie linii statycznego serwera zamiast
 * zaleznosci.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((request, response) => {
  // Bez `..` - serwer widzi wylacznie katalog fixture'ow.
  const path = normalize(new URL(request.url ?? '/', 'http://localhost').pathname).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = join(ROOT, path === '/' ? 'artykul.html' : path);

  readFile(file).then(
    (body) => {
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' });
      response.end(body);
    },
    () => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('nie ma takiego pliku');
    },
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[savely-e2e] fixtures na http://127.0.0.1:${PORT}/`);
});
