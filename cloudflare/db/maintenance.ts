import type { Context } from '../types';
import { configInt, now } from '../http';

/** Limpeza limitada por hora, acionada por tráfego; não precisa de cron/processo. */
export async function maintenance(c: Context): Promise<void> {
  const time = now();
  const days = configInt(c.env.READINGS_RETENTION_DAYS, 90, 1, 3650);
  const auditDays = configInt(c.env.AUDIT_RETENTION_DAYS, 180, 30, 3650);
  const batch = configInt(c.env.RETENTION_BATCH_SIZE, 500, 1, 5000);
  const claim = await c.env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES ('maintenance','',?)
 ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at WHERE settings.updated_at<? RETURNING key`,
  )
    .bind(time, time - 600)
    .first();
  if (!claim) return;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES ('audit_retention_days',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(String(auditDays), time),
    ...['smwu_readings', 'smwa_readings'].map((table) =>
      c.env.DB.prepare(
        `DELETE FROM ${table} WHERE reading_id IN (SELECT reading_id FROM ${table} WHERE created_at<? ORDER BY created_at LIMIT ?)`,
      ).bind(time - days * 86400, batch),
    ),
    c.env.DB.prepare(
      'DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at<? ORDER BY created_at LIMIT ?)',
    ).bind(time - auditDays * 86400, batch),
    c.env.DB.prepare(
      'DELETE FROM telemetry_cache WHERE cache_key IN (SELECT cache_key FROM telemetry_cache WHERE MAX(expires_at,lease_until,negative_until)<? LIMIT ?)',
    ).bind(time - 86400, batch),
    c.env.DB.prepare(
      'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 500)',
    ).bind(time),
    c.env.DB.prepare(
      'DELETE FROM rate_limits WHERE key_hash IN (SELECT key_hash FROM rate_limits WHERE expires_at<=? LIMIT 500)',
    ).bind(time),
    c.env.DB.prepare(
      'DELETE FROM password_reset_tokens WHERE token_hash IN (SELECT token_hash FROM password_reset_tokens WHERE expires_at<=? LIMIT 500)',
    ).bind(time),
  ]);
}
