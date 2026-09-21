// Conversão mecânica única do HTML existente; nunca executa PHP.
// Não participa de build/dev. Templates resultantes são fontes independentes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const replacements = new Map([
  ['<?= $escape(auth_csrf_token()) ?>', '{{csrf}}'],
  ['<?= $escape(strtoupper($initial)) ?>', '{{initial}}'],
  ["<?= $escape($currentUser['name']) ?>", '{{name}}'],
  ["<?= $escape($currentUser['email']) ?>", '{{email}}'],
  ['<?= $escape($next) ?>', '{{next}}'],
  ['<?= $escape($token) ?>', '{{token}}'],
  ["<?= date('Y') ?>", '{{year}}'],
]);
await mkdir('web', { recursive: true });
for (const name of ['index', 'login', 'register', 'forgot-password', 'reset-password']) {
  let content = await readFile(`${name}.php`, 'utf8');
  content = content.slice(content.indexOf('?>') + 2).trimStart();
  for (const [from, to] of replacements) content = content.replaceAll(from, to);
  content = content.replace(/(\/api\/[a-z/-]+)\.php/g, '$1');
  if (content.includes('<?')) throw new Error(`PHP restante: ${name}`);
  if (name === 'index') {
    content = content
      .replace('a cada 5 segundos', 'a cada 60 segundos')
      .replace(
        '<option value="5000">',
        '<option value="60000">A cada 1 minuto</option><option value="300000">A cada 5 minutos</option><option value="5000">',
      )
      .replace(
        '<a class="skip-link"',
        '<div class="demo-banner" {{demoHidden}}>Demonstração local — os dados de telemetria são simulados.</div>\n    <a class="skip-link"',
      );
  }
  await writeFile(`web/${name}.html`, content);
}
