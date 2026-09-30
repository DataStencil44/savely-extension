import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer((request, response) => {
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
