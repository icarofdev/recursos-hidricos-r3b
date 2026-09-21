import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Isola o novo fluxo do .env PHP, inclusive ao usar D1 local antes de iniciar dev.
const cli = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, ['--dns-result-order=ipv4first', cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
  },
});
child.on('error', () => {
  console.error('Não foi possível iniciar Wrangler.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
