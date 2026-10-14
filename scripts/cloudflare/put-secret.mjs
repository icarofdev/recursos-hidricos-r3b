import { spawn } from 'node:child_process';
import { readSecret } from './secret-input.mjs';
const name = process.argv[2];
if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name ?? '')) throw new Error('Informe o nome do binding secreto.');
const value = await readSecret('Valor de ' + name);
const child = spawn(process.execPath, ['scripts/cloudflare/wrangler.mjs', 'secret', 'put', name], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdin.end(value + '\n');
// Provider output can contain request data. Do not forward it.
child.stdout.resume();
child.stderr.resume();
child.on('error', () => {
  console.error('Não foi possível iniciar o comando.');
  process.exitCode = 1;
});
child.on('close', (code) => {
  console.log(
    code === 0
      ? 'Binding secreto atualizado.'
      : 'Falha ao atualizar o binding. Confira autenticação e configuração.',
  );
  process.exitCode = code === 0 ? 0 : 1;
});
