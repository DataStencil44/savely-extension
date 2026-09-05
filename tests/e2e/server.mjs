/**
 * The fixture server for the e2e tests.
 *
 * Saving goes down path A (a content script in the tab), and that needs a real
 * http address - `file://` in Chrome is out of the extension's reach without a
 * separate permission. Hence a dozen lines of static server instead of a
 * dependency.
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
  // No `..` - the server sees the fixtures directory and nothing else.
  const path = normalize(new URL(request.url ?? '/', 'http://localhost').pathname).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = join(ROOT, path === '/' ? 'article.html' : path);

  readFile(file).then(
    (body) => {
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' });
      response.end(body);
    },
    () => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no such file');
    },
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[savely-e2e] fixtures at http://127.0.0.1:${PORT}/`);
});
