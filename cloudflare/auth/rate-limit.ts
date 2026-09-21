import { hmac } from './crypto';
import { HttpError, now, secret } from '../http';
import type { Context } from '../types';

export function clientIP(c: Context): string {
  return c.request.headers.get('CF-Connecting-IP') ?? 'local';
}
export async function rateLimit(
  c: Context,
  scope: string,
  identity: string,
  limit: number,
  seconds: number,
): Promise<void> {
  const key = await hmac(`${scope}\0${identity.toLowerCase().trim()}`, secret(c.env, 'SESSION_SECRET'));
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
