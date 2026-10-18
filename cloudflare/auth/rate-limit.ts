import { hmac } from './crypto';
import { HttpError, now, secret } from '../http';
import type { Context } from '../types';

export function clientIP(c: Context): string {
  return c.request.headers.get('CF-Connecting-IP') ?? 'local';
}
async function keyFor(c: Context, scope: string, identity: string): Promise<string> {
  return hmac(`${scope}\0${identity.toLowerCase().trim()}`, secret(c.env, 'SESSION_SECRET'));
}

export async function failureCount(c: Context, scope: string, identity: string): Promise<number> {
  const row = await c.env.DB.prepare('SELECT attempts FROM rate_limits WHERE key_hash=? AND expires_at>?')
    .bind(await keyFor(c, scope, identity), now())
    .first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

export async function clearFailureLimit(c: Context, scope: string, identity: string): Promise<void> {
  await c.env.DB.prepare('DELETE FROM rate_limits WHERE key_hash=?')
    .bind(await keyFor(c, scope, identity))
    .run();
}

/** Reserve before checking a code: concurrent requests share one account budget.
 * Only password-authenticated challenges or existing admin sessions reach this.
 * Neither success, a new challenge, nor recovery resets the fixed window.
 */
export async function reserveTotpAttempt(c: Context, userId: number): Promise<void> {
  await reserveAttempt(c, 'admin-mfa-attempt', String(userId), 10, 300);
}
export interface AttemptReservation {
  keyHash: string;
  expiresAt: number;
  released: boolean;
}
export async function reserveAttempt(
  c: Context,
  scope: string,
  identity: string,
  limit: number,
  seconds: number,
): Promise<AttemptReservation> {
  const key = await keyFor(c, scope, identity);
  const time = now();
  const reserved = await c.env.DB.prepare(
    `INSERT INTO rate_limits(key_hash,attempts,expires_at) VALUES (?,1,?)
 ON CONFLICT(key_hash) DO UPDATE SET
 attempts=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.attempts+1 END,
 expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END
 WHERE rate_limits.expires_at<=? OR rate_limits.attempts<?
 RETURNING attempts,expires_at`,
  )
    .bind(key, time + seconds, time, time, time, limit)
    .first<{ attempts: number; expires_at: number }>();
  if (reserved) return { keyHash: key, expiresAt: reserved.expires_at, released: false };
  const row = await c.env.DB.prepare('SELECT expires_at FROM rate_limits WHERE key_hash=?')
    .bind(key)
    .first<{ expires_at: number }>();
  throw new HttpError(
    429,
    'RATE_LIMIT_EXCEEDED',
    'Muitas tentativas. Aguarde e tente novamente.',
    Math.max(1, (row?.expires_at ?? time + seconds) - time),
  );
}

/** Return only this operation's slot, without clearing other deliveries or a newer window. */
export async function releaseAttempt(c: Context, reservation: AttemptReservation): Promise<void> {
  if (reservation.released) return;
  reservation.released = true;
  await c.env.DB.prepare(
    'UPDATE rate_limits SET attempts=attempts-1 WHERE key_hash=? AND expires_at=? AND attempts>0',
  )
    .bind(reservation.keyHash, reservation.expiresAt)
    .run();
}

export async function rateLimit(
  c: Context,
  scope: string,
  identity: string,
  limit: number,
  seconds: number,
): Promise<void> {
  // Saturated windows are read-only; rejected requests never extend the window.
  await reserveAttempt(c, scope, identity, limit, seconds);
}
