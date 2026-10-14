import { build } from 'esbuild';
import { localRuntime } from './local-runtime.mjs';
import { readSecret } from './secret-input.mjs';
if (!process.argv.includes('--local')) throw new Error('A ferramenta opera apenas com --local.');
let env;
try {
  env = JSON.parse(await readSecret('JSON privado com bindings atuais e anteriores de TOTP'));
} catch {
  console.error('Bindings inválidos. O conteúdo privado não foi exibido.');
  process.exit(1);
}
const compiled = await build({
  entryPoints: ['cloudflare/auth/totp-rotation.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { reencryptTotp } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const { db, mf } = await localRuntime({ skipDevVars: true });
try {
  console.log('Registros recriptografados: ' + (await reencryptTotp(db, env)));
} catch {
  console.error('Rotação incompleta. Preserve o backup e a chave anterior; confira a janela de transição.');
  process.exitCode = 1;
} finally {
  await mf.dispose();
}
