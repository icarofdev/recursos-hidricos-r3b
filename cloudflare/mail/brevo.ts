import type { Env } from '../types';
import { escapeHTML, HttpError } from '../http';

export function resetURL(env: Env, token: string): string {
 let url: URL;
 try { url = new URL(env.APP_URL ?? ''); } catch { throw new HttpError(503, 'MAIL_CONFIGURATION', 'Recuperação ainda não configurada.'); }
 if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname))
  throw new HttpError(503, 'MAIL_CONFIGURATION', 'Recuperação ainda não configurada.');
 return `${url.origin}/redefinir-senha?token=${encodeURIComponent(token)}`;
}
export function resetEmail(name: string, url: string) {
 return {
  subject: 'Redefina sua senha — Hidra R3B',
  htmlContent: `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f7fa;font-family:Arial,sans-serif;color:#173247"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #dce8ee;border-radius:16px;overflow:hidden"><div style="padding:24px;background:#0b3549;color:#fff"><strong style="font-size:22px">Hidra R3B</strong><br><span>Central de Monitoramento</span></div><div style="padding:28px"><h1 style="font-size:22px;margin:0 0 16px">Redefinição de senha</h1><p>Olá, ${escapeHTML(name)}.</p><p>Recebemos uma solicitação para redefinir a senha da sua conta.</p><p style="margin:28px 0"><a href="${escapeHTML(url)}" style="display:inline-block;background:#087ea4;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">Redefinir minha senha</a></p><p>Este link expira em 20 minutos e pode ser usado uma única vez.</p><p style="color:#587080;font-size:14px">Se você não fez esta solicitação, ignore este e-mail. Sua senha não será alterada.</p></div></div></body></html>`,
  textContent: `Hidra R3B — Redefinição de senha\n\nOlá, ${name}.\n\nAcesse o link para redefinir sua senha:\n${url}\n\nO link expira em 20 minutos e pode ser usado uma única vez. Se você não fez esta solicitação, ignore este e-mail.`
 };
}
export async function sendPasswordReset(env: Env, name: string, email: string, url: string): Promise<void> {
 if (env.MAIL_MODE !== 'brevo' || !env.BREVO_API_KEY || !env.BREVO_SENDER_NAME || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.BREVO_SENDER_EMAIL ?? ''))
  throw new HttpError(503, 'MAIL_CONFIGURATION', 'Recuperação ainda não configurada.');
 try {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
   method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(6000),
   headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'api-key': env.BREVO_API_KEY },
   body: JSON.stringify({ sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ name, email }], ...resetEmail(name, url) })
  });
  // Não ler/logar respostas do provedor: podem conter dados da mensagem.
  await response.body?.cancel();
  if (!response.ok) throw new Error('mail failed');
 } catch { throw new HttpError(503, 'MAIL_UNAVAILABLE', 'Serviço de e-mail temporariamente indisponível.'); }
}
