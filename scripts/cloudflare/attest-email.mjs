import { localRuntime } from './local-runtime.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const id = Number(args[0]);
const usage =
  'Uso: attest-email.mjs <user-id> --attested [--remote [--env preview]]. Exige prova independente de acesso à caixa postal.';
let remote = false,
  attested = false,
  environment;
for (let index = 1; index < args.length; index++) {
  if (args[index] === '--remote' && !remote) remote = true;
  else if (args[index] === '--attested' && !attested) attested = true;
  else if (args[index] === '--env' && !environment && args[index + 1] === 'preview')
    environment = args[++index];
  else throw new Error(usage);
}
if (
  !/^\d+$/.test(args[0] ?? '') ||
  !Number.isSafeInteger(id) ||
  id < 1 ||
  !attested ||
  (environment && !remote)
)
  throw new Error(usage);

let changed;
if (remote) {
  // IDs are validated safe integers; no user-provided SQL or mailbox data enters
  // the command. The wrapper disables automatic loading of .env/.dev.vars.
  const sql = `UPDATE users SET email_verified_at=unixepoch(),updated_at=unixepoch() WHERE id=${id} AND email_verified_at IS NULL RETURNING id;
INSERT INTO audit_logs(action,user_id,details,created_at) SELECT 'email_attested',${id},json_object('method','operator_mailbox_proof'),unixepoch() WHERE changes()>0;`;
  const cli = fileURLToPath(new URL('./wrangler.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'd1',
      'execute',
      environment ? 'hidra-r3b-preview' : 'hidra-r3b',
      '--remote',
      '--command',
      sql,
      '--json',
      ...(environment ? ['--env', environment] : []),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Falha na atestação remota. Confira autenticação, ambiente e schema.');
  try {
    const results = JSON.parse(result.stdout);
    if (
      !Array.isArray(results) ||
      !Array.isArray(results[0]?.results) ||
      results.some((entry) => entry.success === false)
    )
      throw new Error('invalid response');
    changed = results[0].results.length > 0;
  } catch {
    throw new Error('Resposta inesperada na atestação remota.');
  }
} else {
  const { db, mf } = await localRuntime({ skipDevVars: true });
  try {
    const result = await db.batch([
      db
        .prepare(
          'UPDATE users SET email_verified_at=unixepoch(),updated_at=unixepoch() WHERE id=? AND email_verified_at IS NULL RETURNING id',
        )
        .bind(id),
      db
        .prepare(
          "INSERT INTO audit_logs(action,user_id,details,created_at) SELECT 'email_attested',?,json_object('method','operator_mailbox_proof'),unixepoch() WHERE changes()>0",
        )
        .bind(id),
    ]);
    changed = result[0].results.length > 0;
  } finally {
    await mf.dispose();
  }
}
console.log(changed ? 'Conta selecionada confirmada após atestação externa.' : 'Nenhuma conta alterada.');
