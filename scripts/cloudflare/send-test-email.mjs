import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function loadVars() {
  try {
    const content = await readFile(resolve(process.cwd(), '.dev.vars'), 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

const vars = await loadVars();
const apiKey = vars.BREVO_API_KEY || process.env.BREVO_API_KEY;
const senderEmail = vars.BREVO_SENDER_EMAIL || process.env.BREVO_SENDER_EMAIL;
const senderName = vars.BREVO_SENDER_NAME || process.env.BREVO_SENDER_NAME || 'Recursos Hídricos';

if (!apiKey) {
  console.error('Erro: BREVO_API_KEY não encontrada em .dev.vars');
  process.exit(1);
}
if (!senderEmail) {
  console.error('Erro: BREVO_SENDER_EMAIL não encontrado em .dev.vars');
  process.exit(1);
}

const recipientEmail = process.argv[2] || senderEmail;
const recipientName = process.argv[3] || 'Administrador';

console.log('Disparando e-mail de teste real via Brevo API:');
console.log(`- Remetente: ${senderName} <${senderEmail}>`);
console.log(`- Destinatário: ${recipientName} <${recipientEmail}>`);

const payload = {
  sender: { name: senderName, email: senderEmail },
  to: [{ name: recipientName, email: recipientEmail }],
  subject: 'Teste de Entrega — Hidra R3B',
  htmlContent: `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f7fa;font-family:Arial,sans-serif;color:#173247">
<div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #dce8ee;border-radius:16px;overflow:hidden">
<div style="padding:24px;background:#0b3549;color:#fff"><strong style="font-size:22px">Hidra R3B</strong><br><span>Central de Monitoramento</span></div>
<div style="padding:28px">
<h1 style="font-size:22px;margin:0 0 16px">Teste de Conexão e Entrega Brevo</h1>
<p>Olá, ${recipientName}!</p>
<p>Este é um e-mail de teste real enviado pelo sistema <strong>Hidra R3B</strong> utilizando a API transacional da Brevo.</p>
<div style="margin:20px 0;padding:16px;background:#e8f4f8;border-left:4px solid #087ea4;border-radius:4px">
  <p style="margin:0;font-size:14px;color:#0b3549"><strong>Status:</strong> A chave de API e o remetente foram validados com sucesso.</p>
  <p style="margin:8px 0 0;font-size:13px;color:#587080">Horário do disparo: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
</div>
<p style="color:#587080;font-size:14px">Se você recebeu esta mensagem na sua caixa de entrada, a integração com a Brevo está 100% operacional.</p>
</div></div></body></html>`,
  textContent: `Hidra R3B — Teste de Conexão e Entrega Brevo\n\nOlá, ${recipientName}!\nEste é um e-mail de teste real enviado pelo sistema Hidra R3B.\nSe você recebeu esta mensagem, a integração com a Brevo está operacional.\n\nHorário do disparo: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
};

try {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`Falha no envio (HTTP ${response.status}):`, body);
    process.exit(1);
  }

  console.log(`E-mail enviado com sucesso! (HTTP ${response.status})`);
  console.log('Resposta Brevo:', body);
} catch (error) {
  console.error('Erro de conexão ao enviar e-mail:', error);
  if (error.cause) console.error('Causa:', error.cause);
  process.exit(1);
}
