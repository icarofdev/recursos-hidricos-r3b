import type { Context } from '../types';
import { now } from '../http';

/** Limpeza limitada por hora, acionada por tráfego; não precisa de cron/processo. */
export async function maintenance(c: Context): Promise<void> {
 const time = now();
 const claim = await c.env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES ('maintenance','',?)
 ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at WHERE settings.updated_at<? RETURNING key`)
  .bind(time,time-3600).first();
 if (!claim) return;
 await c.env.DB.batch([
  c.env.DB.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 500)').bind(time),
  c.env.DB.prepare('DELETE FROM rate_limits WHERE key_hash IN (SELECT key_hash FROM rate_limits WHERE expires_at<=? LIMIT 500)').bind(time),
  c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE token_hash IN (SELECT token_hash FROM password_reset_tokens WHERE expires_at<=? LIMIT 500)').bind(time)
 ]);
}
