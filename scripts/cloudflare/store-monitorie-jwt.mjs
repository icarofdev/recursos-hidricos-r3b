import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

function jwt(value) {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('A entrada não contém um JWT válido.');
  return token;
}

async function store(value) {
  const token = jwt(value);
  let text = '';
  try {
    text = await readFile('.dev.vars', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const line = `MONITORIE_JWT=${token}`;
  const lines = text ? text.split(/\r?\n/) : [];
  const index = lines.findIndex((current) => current.trimStart().startsWith('MONITORIE_JWT='));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  await writeFile('.dev.vars', `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
}

async function input(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > 32768) throw new Error('Entrada maior que o limite aceito.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv.includes('--server')) {
  const origin = 'http://127.0.0.1:8790';
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>JWT local Monitor IE</title><h1>Configuração local</h1><form method="post"><label>JWT <input name="jwt" type="password" required autocomplete="off"></label><button type="submit">Salvar localmente</button></form></html>',
        );
        return;
      }
      if (
        request.method !== 'POST' ||
        request.url !== '/' ||
        request.headers.origin !== origin ||
        !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
      ) {
        response.writeHead(403, headers).end('Requisição recusada.');
        return;
      }
      const body = new URLSearchParams(await input(request));
      await store(body.get('jwt') ?? '');
      response.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('MONITORIE_JWT salvo em .dev.vars. Esta janela pode ser fechada.');
      setTimeout(() => server.close(), 100);
    } catch {
      response.writeHead(422, headers).end('JWT inválido.');
    }
  });
  server.listen(8790, '127.0.0.1', () => console.log(`${origin}/`));
} else {
  await store(await input(process.stdin));
  console.log('MONITORIE_JWT salvo em .dev.vars (ignorado pelo Git).');
}
