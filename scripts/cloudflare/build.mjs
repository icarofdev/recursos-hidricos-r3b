import {build} from 'esbuild';
import {readFile, readdir, mkdir, copyFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';

// 1. Preparar diretórios
await rm('dist', {recursive: true, force: true});
await mkdir('dist/frontend/static/css', {recursive: true});
await mkdir('dist/frontend/static/js/vendor', {recursive: true});
await mkdir('dist/worker', {recursive: true});

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
  'static/js/vendor/chart.umd.min.js'
];
for (const file of staticAssets) {
  const content = await readFile(file, 'utf8');
  if (/xkeysib-[A-Za-z0-9-]+/.test(content)) throw new Error(`Credencial detectada em ${file}`);
  await copyFile(file, `dist/frontend/${file}`);
}

// 3. Injetar config.js no frontend
const defaultApiUrl = 'https://hidra-r3b.hidra-r3b-cloudflare.workers.dev';
const publicApiUrl = process.env.PUBLIC_API_URL !== undefined
  ? process.env.PUBLIC_API_URL.trim()
  : (process.env.API_URL || defaultApiUrl).trim();
await writeFile('dist/frontend/static/js/config.js', `window.__API_BASE__ = ${JSON.stringify(publicApiUrl)};\n`);

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
  { src: 'web/admin.html', dest: 'dist/frontend/admin.html' }
];
for (const {src, dest} of htmlPages) {
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
await writeFile('dist/frontend/404.html', '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Não encontrado</title><p>Página não encontrada.</p><a href="/">Voltar</a></html>');

// 5. Configuração da Vercel
const vercelConfig = {
  cleanUrls: true,
  rewrites: [
    { source: '/', destination: '/index.html' },
    { source: '/login', destination: '/login.html' },
    { source: '/cadastro', destination: '/register.html' },
    { source: '/esqueci-senha', destination: '/forgot-password.html' },
    { source: '/redefinir-senha', destination: '/reset-password.html' },
    { source: '/admin', destination: '/admin.html' }
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' }
      ]
    },
    {
      source: '/static/(.*)',
      headers: [
        { key: 'Cache-Control', value: 'public, max-age=3600' }
      ]
    }
  ]
};
await writeFile('dist/frontend/vercel.json', JSON.stringify(vercelConfig, null, 2));

// 6. Build do Worker (sem HTML, sem ASSETS)
await build({
  entryPoints: ['cloudflare/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/worker/index.js',
  sourcemap: false,
  legalComments: 'none'
});
await copyFile('dist/worker/index.js', 'dist/worker.js');
await copyFile('dist/worker/index.js', 'dist/_worker.js');

// 7. Auditoria de segurança rigorosa em dist/frontend
for (const entry of await readdir('dist/frontend', {recursive: true, withFileTypes: true})) {
  if (!entry.isFile()) continue;
  const rel = path.relative('dist/frontend', path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
  if (/\.php$|\.env|\.dev\.vars|\.sql$|tests|migrations/.test(rel)) {
    throw new Error(`Arquivo proibido em dist/frontend: ${rel}`);
  }
  const text = await readFile(`dist/frontend/${rel}`, 'utf8');
  if (/xkeysib-[A-Za-z0-9-]+/.test(text)) throw new Error(`Credencial encontrada em ${rel}`);
  if (/<\?php/.test(text)) throw new Error(`PHP detectado em ${rel}`);
}

console.log('Build híbrido pronto: dist/frontend (Vercel) e dist/worker (Cloudflare Workers).');

