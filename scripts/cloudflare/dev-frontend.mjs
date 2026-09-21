import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
export async function frontendServer(port = 8788) {
  const root = resolve('dist/frontend');
  const config = JSON.parse(await readFile(resolve(root, 'hosting.json'), 'utf8'));
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, config.pages[pathname] || '.' + pathname);
      if (!file.startsWith(root + sep) || pathname.includes('\\')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const bytes = await readFile(file);
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
      };
      res.writeHead(200, {
        ...config.headers,
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('Não encontrado');
    }
  });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).on('error', reject));
  return server;
}
if (process.argv[1]?.endsWith('dev-frontend.mjs')) {
  await frontendServer();
  console.log('Frontend local: http://127.0.0.1:8788');
}
