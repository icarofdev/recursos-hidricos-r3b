import { build } from 'esbuild';
import { readFile, readdir, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { cp } from 'node:fs/promises';
import { configuration } from './config.mjs';
const config = configuration(process.argv.includes('--production'));
const output = path.resolve('dist');
if (path.dirname(output) !== process.cwd()) throw new Error('Diretório de saída inválido');

// 1. Preparar diretórios
await rm('dist', { recursive: true, force: true });
await mkdir('dist/frontend/static/css', { recursive: true });
await mkdir('dist/frontend/static/js/vendor', { recursive: true });
await mkdir('dist/worker', { recursive: true });

// 2. Copiar assets estáticos para dist/frontend
const staticAssets = [
  'static/css/theme.css',
  'static/css/auth.css',
  'static/css/dashboard.css',
  'static/css/admin.css',
  'static/js/theme.js',
  'static/js/auth.js',
  'static/js/dashboard.js',
  'static/js/admin.js',
  'static/js/vendor/chart.umd.min.js',
];
for (const file of staticAssets) {
  const content = await readFile(file, 'utf8');
  if (/xkeysib-[A-Za-z0-9-]+/.test(content)) throw new Error(`Credencial detectada em ${file}`);
  if (file.endsWith('.js') && !file.includes('/vendor/'))
    await build({
      entryPoints: [file],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      outfile: `dist/frontend/${file}`,
    });
  else await copyFile(file, `dist/frontend/${file}`);
}

// 3. Injetar config.js no frontend
await writeFile(
  'dist/frontend/static/js/config.js',
  `window.__API_BASE__ = ${JSON.stringify(config.api)};\n`,
);

// 4. Copiar páginas HTML para dist/frontend (assegurando ausência de placeholders)
const htmlPages = [
  { src: 'web/index.html', dest: 'dist/frontend/index.html' },
  { src: 'web/login.html', dest: 'dist/frontend/login.html' },
  { src: 'web/register.html', dest: 'dist/frontend/register.html' },
  { src: 'web/register.html', dest: 'dist/frontend/cadastro.html' },
  { src: 'web/forgot-password.html', dest: 'dist/frontend/forgot-password.html' },
  { src: 'web/forgot-password.html', dest: 'dist/frontend/esqueci-senha.html' },
  { src: 'web/reset-password.html', dest: 'dist/frontend/reset-password.html' },
  { src: 'web/reset-password.html', dest: 'dist/frontend/redefinir-senha.html' },
  { src: 'web/admin.html', dest: 'dist/frontend/admin.html' },
];
for (const { src, dest } of htmlPages) {
  let content = await readFile(src, 'utf8');
  content = content
    .replace(/\{\{csrf\}\}/g, '')
    .replace(/\{\{token\}\}/g, '')
    .replace(/\{\{next\}\}/g, '')
    .replace(/\{\{year\}\}/g, '2026')
    .replace(/\{\{initial\}\}/g, '—')
    .replace(/\{\{name\}\}/g, 'Carregando…')
    .replace(/\{\{email\}\}/g, '')
    .replace(/\{\{demoHidden\}\}/g, 'hidden');
  await writeFile(dest, content);
}
await writeFile(
  'dist/frontend/404.html',
  '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Não encontrado</title><p>Página não encontrada.</p><a href="/">Voltar</a></html>',
);

// Vercel Build Output API is authoritative and carries environment-specific CSP.
const vercelConfig = {
  version: 3,
  routes: [
    { src: '/(.*)', headers: config.headers, continue: true },
    ...Object.entries(config.pages).map(([src, dest]) => ({
      src: src === '/' ? '^/$' : `^${src}/?$`,
      dest: `/${dest}`,
    })),
    { handle: 'filesystem' },
    { src: '/(.*)', status: 404, dest: '/404.html' },
  ],
};
await writeFile(
  'dist/frontend/hosting.json',
  JSON.stringify({ headers: config.headers, pages: config.pages }, null, 2),
);
const vercelOutput = path.resolve('.vercel/output');
if (!vercelOutput.startsWith(path.resolve('.vercel') + path.sep)) throw new Error('Diretório inválido');
await rm(vercelOutput, { recursive: true, force: true });
await mkdir(vercelOutput, { recursive: true });
await cp('dist/frontend', `${vercelOutput}/static`, { recursive: true });
await writeFile(`${vercelOutput}/config.json`, JSON.stringify(vercelConfig, null, 2));

// 6. Build do Worker (sem HTML, sem ASSETS)
await build({
  entryPoints: ['cloudflare/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/worker/index.js',
  sourcemap: false,
  legalComments: 'none',
});

// 7. Auditoria de segurança rigorosa em dist/frontend
for (const entry of await readdir('dist/frontend', { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const parentDir = entry.parentPath || entry.path || 'dist/frontend';
  const rel = path.relative('dist/frontend', path.join(parentDir, entry.name)).split(path.sep).join('/');
  if (/\.php$|\.env|\.dev\.vars|\.sql$|tests|migrations/.test(rel)) {
    throw new Error(`Arquivo proibido em dist/frontend: ${rel}`);
  }
  const text = await readFile(`dist/frontend/${rel}`, 'utf8');
  if (/xkeysib-[A-Za-z0-9-]+/.test(text)) throw new Error(`Credencial encontrada em ${rel}`);
  if (/<\?php/.test(text)) throw new Error(`PHP detectado em ${rel}`);
}

console.log('Build híbrido pronto: dist/frontend (Vercel) e dist/worker (Cloudflare Workers).');
