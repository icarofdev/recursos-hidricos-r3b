import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./wrangler.mjs', import.meta.url));

const args = process.argv.slice(2);
const command = args[0];
const email = args[1]?.toLowerCase().trim();
const isRemote = args.includes('--remote');

if (command !== 'set-admin' || !email) {
  console.log('Uso: node scripts/cloudflare/admin.mjs set-admin <email> [--remote]');
  process.exit(1);
}

const cleanEmail = email.replace(/'/g, "''");
const sql = `UPDATE users SET role='admin' WHERE lower(email)='${cleanEmail}' RETURNING id, email, role;`;
const wranglerArgs = ['d1', 'execute', 'hidra-r3b', '--command', sql, '--json'];
if (isRemote) wranglerArgs.push('--remote');

const child = spawn(process.execPath, [cli, ...wranglerArgs], {
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' }
});

let stdout = '';
let stderr = '';

child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

child.on('exit', code => {
  if (code !== 0) {
    if (stderr.trim()) console.error(stderr);
    else if (stdout.trim()) console.error(stdout);
    process.exit(code ?? 1);
  }

  try {
    const jsonStart = stdout.indexOf('[');
    const jsonEnd = stdout.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error('Falha ao processar resposta do banco D1:\n' + stdout);
      process.exit(1);
    }

    const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
    const results = parsed[0]?.results ?? [];

    if (results.length === 0) {
      console.error(`Erro: Usuário com e-mail "${email}" não foi encontrado no banco de dados.`);
      process.exit(1);
    }

    const updated = results[0];
    console.log(`Usuário ${updated.email} promovido a admin com sucesso (ID: ${updated.id}, role: ${updated.role}).`);
    process.exit(0);
  } catch (err) {
    console.error('Erro ao interpretar resultado do D1:', err.message);
    process.exit(1);
  }
});
