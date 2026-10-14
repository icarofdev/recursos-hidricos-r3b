import { localRuntime } from './local-runtime.mjs';
const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1 || !process.argv.includes('--attested'))
  throw new Error(
    'Uso local: attest-email.mjs <user-id> --attested. Exige prova independente de acesso à caixa postal.',
  );
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
  console.log(
    result[0].results.length
      ? 'Conta selecionada confirmada após atestação externa.'
      : 'Nenhuma conta alterada.',
  );
} finally {
  await mf.dispose();
}
