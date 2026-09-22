import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ACCOUNT_ID = '4fe6e9730d2d6b2ad1d85ba8fa84fd04';
const SCRIPT_NAME = 'hidra-r3b';

async function getOAuthToken() {
  const p = join(homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');
  const content = await readFile(p, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('oauth_token')) {
      const match = trimmed.match(/oauth_token\s*=\s*["']?([^"'\s]+)["']?/);
      if (match) return match[1];
    }
  }
  throw new Error('OAuth token não encontrado no Wrangler. Faça login com wrangler login.');
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const secretName = process.argv[2] || 'MONITORIE_JWT';
  console.log(
    `Atualizando segredo "${secretName}" no Worker "${SCRIPT_NAME}" (com timeout estendido de 2 min)...`,
  );

  const token = await getOAuthToken();
  const value = await prompt(`Cole o valor de ${secretName}: `);

  if (!value) {
    console.error('Nenhum valor fornecido.');
    process.exit(1);
  }

  console.log('Enviando para a Cloudflare API...');
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/secrets`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: secretName,
      text: value,
      type: 'secret_text',
    }),
    signal: AbortSignal.timeout(120000), // 2 minutos
  });

  const data = await res.json();
  if (data.success) {
    console.log(`Sucesso! Segredo "${secretName}" atualizado e ativado na Cloudflare.`);
  } else {
    console.error('Falha ao salvar segredo:', JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
