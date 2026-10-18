import type { Context } from '../types';
import { body, escapeHTML, HttpError, json, now, string } from '../http';
import { requireUser } from './sessions';
import { randomToken, sha256 } from './crypto';
import { clientIP, rateLimit, releaseAttempt, reserveAttempt } from './rate-limit';
import type { AttemptReservation } from './rate-limit';
import { MailDeliveryError, resetURL, sendEmail } from '../mail';
import { securityEvent } from './security-events';

export async function emailVerification(c: Context, route: string): Promise<Response> {
  const user = requireUser(c);
  await rateLimit(c, 'email-proof-ip', clientIP(c), 20, 900);
  if (route === 'verify-email') {
    await rateLimit(c, 'email-proof-attempt', String(user.id), 10, 900);
    const data = await body(c, ['token']);
    const token = string(data, 'token', 128);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const changed = await c.env.DB.prepare(
      `UPDATE users SET email_verified_at=?,updated_at=? WHERE id=? AND email_verified_at IS NULL
       AND EXISTS(SELECT 1 FROM email_verification_tokens WHERE user_id=users.id AND token_hash=?
       AND used_at IS NULL AND expires_at>?) RETURNING id`,
    )
      .bind(now(), now(), user.id, await sha256(token), now())
      .first();
    if (!changed) throw invalid();
    await securityEvent(c, 'email_verified', 'success', user.id);
    return json({ success: true, message: 'E-mail confirmado. Você já pode receber novos vínculos.' });
  }
  await body(c, []);
  if (user.email_verified_at === null) {
    const reservations = [await reserveAttempt(c, 'email-proof-cooldown', String(user.id), 1, 60)];
    try {
      reservations.push(await reserveAttempt(c, 'email-proof-send', String(user.id), 3, 3600));
    } catch (error) {
      await releaseAttempt(c, reservations[0]);
      throw error;
    }
    c.ctx.waitUntil(
      sendVerification(c, reservations).catch(() => console.warn('EMAIL_VERIFICATION_UNAVAILABLE')),
    );
  }
  return json(
    {
      success: true,
      message: 'Se a conta precisar de confirmação, enviaremos as instruções ao endereço cadastrado.',
    },
    202,
  );
}
async function sendVerification(c: Context, reservations: AttemptReservation[]): Promise<void> {
  const user = requireUser(c),
    token = randomToken(),
    hash = await sha256(token),
    time = now();
  let attemptedDelivery = false;
  try {
    const url = new URL(resetURL(c.env, token));
    url.pathname = '/confirmar-email';
    const inserted = await c.env.DB.prepare(
      'INSERT INTO email_verification_tokens(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND email=? AND email_verified_at IS NULL',
    )
      .bind(hash, time + 1200, time, user.id, user.email)
      .run();
    // The address may have changed since the authenticated request was loaded.
    // The insert condition and email-change trigger bind proof to that exact address.
    if (inserted.meta.changes !== 1) {
      await releaseReservations(c, reservations);
      return;
    }
    attemptedDelivery = true;
    await sendEmail(c.env, {
      to: user.email,
      subject: 'Confirme seu e-mail — Hidra R3B',
      html: `<!doctype html><html lang="pt-BR"><body><h1>Confirme seu e-mail no Hidra R3B</h1><p>Entre na mesma conta que solicitou a confirmação.</p><p><a href="${escapeHTML(url.href)}">Confirmar endereço</a></p><p>Este link expira em 20 minutos e só pode ser usado uma vez. Se você não solicitou esta confirmação, ignore a mensagem.</p></body></html>`,
      text: `Confirme o e-mail da sua conta Hidra R3B. Entre na mesma conta para concluir:\n${url.href}\nEste link expira em 20 minutos e só pode ser usado uma vez. Se você não solicitou, ignore.`,
    });
    // Preserve the last delivered proof if a resend is rejected or uncertain.
    // Only a confirmed delivery supersedes it, while still bound to this address.
    await c.env.DB.prepare(
      'UPDATE email_verification_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL AND rowid<(SELECT rowid FROM email_verification_tokens issued WHERE issued.token_hash=? AND issued.user_id=? AND issued.used_at IS NULL) AND EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND email_verified_at IS NULL)',
    )
      .bind(now(), user.id, hash, user.id, user.id, user.email)
      .run();
  } catch (error) {
    await c.env.DB.prepare('DELETE FROM email_verification_tokens WHERE token_hash=?').bind(hash).run();
    // A timeout can happen after provider acceptance. Preserve its quota because
    // delivery is uncertain; only known rejections or no attempt return slots.
    if (
      !attemptedDelivery ||
      (error instanceof HttpError && error.code === 'MAIL_CONFIGURATION') ||
      (error instanceof MailDeliveryError && error.rejected)
    )
      await releaseReservations(c, reservations);
    throw new Error('verification unavailable');
  }
}
async function releaseReservations(c: Context, reservations: AttemptReservation[]): Promise<void> {
  for (const reservation of reservations) await releaseAttempt(c, reservation);
}
function invalid() {
  return new HttpError(
    422,
    'INVALID_EMAIL_TOKEN',
    'Confirmação inválida, expirada, usada ou pertencente a outra conta.',
  );
}
