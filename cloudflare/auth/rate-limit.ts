import { hmac } from './crypto';
import { HttpError, now, secret } from '../http';
import type { Context } from '../types';

export function clientIP(c: Context): string {
  return c.request.headers.get('CF-Connecting-IP') ?? 'local';
}
async function keyFor(c: Context, scope: string, identity: string): Promise<string> {
  return hmac(`${scope}\0${identity.toLowerCase().trim()}`, secret(c.env, 'SESSION_SECRET'));
}

/** A short fixed window for account failures. Rejected requests do not extend it. */
export async function checkFailureLimit(
  c: Context,
  scope: string,
  identity: string,
  limit: number,
): Promise<void> {
  const key = await keyFor(c, scope, identity);
  const row = await c.env.DB.prepare('SELECT attempts,expires_at FROM rate_limits WHERE key_hash=?')
    .bind(key)
    .first<{ attempts: number; expires_at: number }>();
  if (row && row.expires_at > now() && row.attempts >= limit)
    throw new HttpError(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Muitas tentativas. Aguarde e tente novamente.',
      row.expires_at - now(),
    );
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
  const key = await keyFor(c, 'admin-mfa-attempt', String(userId));
  const time = now();
  const limit = 10;
  const seconds = 300;
  const reserved = await c.env.DB.prepare(
    `INSERT INTO rate_limits(key_hash,attempts,expires_at) VALUES (?,1,?)
 ON CONFLICT(key_hash) DO UPDATE SET
 attempts=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE rate_limits.attempts+1 END,
 expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END
 WHERE rate_limits.expires_at<=? OR rate_limits.attempts<?
 RETURNING attempts`,
  )
    .bind(key, time + seconds, time, time, time, limit)
    .first();
  if (reserved) return;
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

export async function rateLimit(
  c: Context,
  scope: string,
  identity: string,
  limit: number,
  seconds: number,
): Promise<void> {
  const key = await keyFor(c, scope, identity);
  const time = now();
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits(key_hash, attempts, expires_at) VALUES (?,1,?)
 ON CONFLICT(key_hash) DO UPDATE SET
 attempts=CASE WHEN rate_limits.expires_at<=? THEN 1 ELSE MIN(rate_limits.attempts+1,1000000) END,
 expires_at=CASE WHEN rate_limits.expires_at<=? THEN excluded.expires_at ELSE rate_limits.expires_at END
 RETURNING attempts, expires_at`,
  )
    .bind(key, time + seconds, time, time)
    .first<{ attempts: number; expires_at: number }>();
  if (!row || row.attempts > limit)
    throw new HttpError(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Muitas tentativas. Aguarde e tente novamente.',
      Math.max(1, (row?.expires_at ?? time + seconds) - time),
    );
}
