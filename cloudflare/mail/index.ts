import type { Env } from '../types';
import { escapeHTML, HttpError } from '../http';

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** The only outbound transactional email transport used by the Worker. */
export async function sendEmail(env: Env, message: TransactionalEmail): Promise<void> {
  const from = env.EMAIL_FROM ?? '';
  const validFrom =
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from) ||
    /^[^<>\r\n]+ <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(from);
  if (env.MAIL_MODE !== 'resend' || !env.RESEND_API_KEY || !validFrom)
    throw new HttpError(503, 'MAIL_CONFIGURATION', 'Serviço de e-mail ainda não configurado.');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    // Provider responses may echo message data. Never read or log their body.
    await response.body?.cancel();
    if (!response.ok) {
      console.warn(
        JSON.stringify({ event: 'mail_delivery_failed', provider: 'resend', status: response.status }),
      );
      throw new Error('mail delivery failed');
    }
  } catch {
    throw new HttpError(503, 'MAIL_UNAVAILABLE', 'Serviço de e-mail temporariamente indisponível.');
  }
}

export function resetURL(env: Env, token: string): string {
  let url: URL;
  try {
    url = new URL(env.APP_URL ?? '');
  } catch {
    throw new HttpError(503, 'MAIL_CONFIGURATION', 'Recuperação ainda não configurada.');
  }
  const localFrontend =
    env.APP_ENV === 'development' &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localFrontend) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (!localFrontend && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    (!localFrontend && /^127\./.test(url.hostname))
  )
    throw new HttpError(503, 'MAIL_CONFIGURATION', 'Recuperação ainda não configurada.');
  return `${url.origin}/redefinir-senha?token=${encodeURIComponent(token)}`;
}

export function resetEmail(name: string, url: string): Omit<TransactionalEmail, 'to'> {
  return {
    subject: 'Redefina sua senha — Hidra R3B',
    html: `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f7fa;font-family:Arial,sans-serif;color:#173247"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #dce8ee;border-radius:16px;overflow:hidden"><div style="padding:24px;background:#0b3549;color:#fff"><strong style="font-size:22px">Hidra R3B</strong><br><span>Central de Monitoramento</span></div><div style="padding:28px"><h1 style="font-size:22px;margin:0 0 16px">Redefinição de senha</h1><p>Olá, ${escapeHTML(name)}.</p><p>Recebemos uma solicitação para redefinir a senha da sua conta.</p><p style="margin:28px 0"><a href="${escapeHTML(url)}" style="display:inline-block;background:#087ea4;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">Redefinir minha senha</a></p><p>Este link expira em 20 minutos e pode ser usado uma única vez.</p><p style="color:#587080;font-size:14px">Se você não fez esta solicitação, ignore este e-mail. Sua senha não será alterada.</p></div></div></body></html>`,
    text: `Hidra R3B — Redefinição de senha\n\nOlá, ${name}.\n\nAcesse o link para redefinir sua senha:\n${url}\n\nO link expira em 20 minutos e pode ser usado uma única vez. Se você não fez esta solicitação, ignore este e-mail.`,
  };
}

export async function sendPasswordReset(env: Env, name: string, email: string, url: string): Promise<void> {
  await sendEmail(env, { to: email, ...resetEmail(name, url) });
}
