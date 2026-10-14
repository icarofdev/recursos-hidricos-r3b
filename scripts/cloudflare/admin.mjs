import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];
const email = args[1]?.toLowerCase().trim();
const isRemote = args.includes('--remote');

if (command !== 'set-admin' || !email) {
  console.log('Uso: node scripts/cloudflare/admin.mjs set-admin <email> [--remote]');
  process.exit(1);
}

if (!isRemote) {
  const { localRuntime } = await import('./local-runtime.mjs');
  const { mf, db } = await localRuntime({ skipDevVars: true });
  try {
    const results = await db.batch([
      db
        .prepare(
          "UPDATE users SET role='admin' WHERE lower(email)=? AND email_verified_at IS NOT NULL RETURNING id, role",
        )
        .bind(email),
      db
        .prepare(
          "INSERT INTO audit_logs(action,device_id,user_id,details,created_at) SELECT 'admin_promoted',NULL,id,json_object('method','cli_bootstrap'),unixepoch() FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL",
        )
        .bind(email),
    ]);
    const updated = results[0].results[0];
    if (!updated) {
      console.error('Conta ausente ou e-mail não confirmado. Confirme a titularidade antes de promover.');
      console.error('Cadastre-se primeiro em http://127.0.0.1:8788/cadastro e execute o comando novamente.');
      process.exitCode = 1;
    } else {
      console.log(
        `Usuário confirmado promovido a admin com sucesso no banco local (ID: ${updated.id}, role: ${updated.role}).`,
      );
    }
  } finally {
    await mf.dispose();
  }
} else {
  const cli = fileURLToPath(new URL('./wrangler.mjs', import.meta.url));
  const cleanEmail = email.replace(/'/g, "''");
  const sql = `UPDATE users SET role='admin' WHERE lower(email)='${cleanEmail}' AND email_verified_at IS NOT NULL RETURNING id, role;
INSERT INTO audit_logs(action, device_id, user_id, details, created_at)
SELECT 'admin_promoted', NULL, id, json_object('method', 'cli_bootstrap'), unixepoch()
FROM users WHERE lower(email)='${cleanEmail}' AND email_verified_at IS NOT NULL;`;
  const wranglerArgs = ['d1', 'execute', 'hidra-r3b', '--command', sql, '--json', '--remote'];

  const child = spawn(process.execPath, [cli, ...wranglerArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' },
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error('Falha na promoção. Confira autenticação, schema e confirmação do e-mail.');
      process.exit(code ?? 1);
    }

    try {
      const jsonStart = stdout.indexOf('[');
      const jsonEnd = stdout.lastIndexOf(']');
      if (jsonStart === -1 || jsonEnd === -1) {
        console.error('Resposta inesperada do banco.');
        process.exit(1);
      }

      const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
      const results = parsed[0]?.results ?? [];

      if (results.length === 0) {
        console.error('Conta ausente ou e-mail não confirmado. Confirme a titularidade antes de promover.');
        process.exit(1);
      }

      const updated = results[0];
      console.log(
        `Usuário confirmado promovido a admin com sucesso no D1 remoto (ID: ${updated.id}, role: ${updated.role}).`,
      );
      process.exit(0);
    } catch {
      console.error('Erro ao interpretar resultado do D1.');
      process.exit(1);
    }
  });
}
