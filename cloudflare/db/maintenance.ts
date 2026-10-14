import type { Context } from '../types';
import { configInt, now } from '../http';

/** Bounded primary-D1 cleanup; each cycle reports whether expired data remains. */
export async function maintenance(c: Context): Promise<void> {
  const time = now(),
    days = configInt(c.env.READINGS_RETENTION_DAYS, 90, 1, 3650),
    auditDays = configInt(c.env.AUDIT_RETENTION_DAYS, 180, 30, 3650);
  const batch = configInt(c.env.RETENTION_BATCH_SIZE, 2000, 1, 5000),
    rounds = configInt(c.env.RETENTION_MAX_BATCHES, 2, 1, 3);
  const claim = await c.env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES('maintenance','',?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at WHERE settings.updated_at<? RETURNING key",
  )
    .bind(time, time - 60)
    .first();
  if (!claim) return;
  await c.env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES('audit_retention_days',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(String(auditDays), time)
    .run();
  const rules: [string, string, string, number[]][] = [
    ['smwu_readings', 'reading_id', 'created_at<?', [time - days * 86400]],
    ['smwa_readings', 'reading_id', 'created_at<?', [time - days * 86400]],
    ['audit_logs', 'id', 'created_at<?', [time - auditDays * 86400]],
    ['security_events', 'id', 'created_at<?', [time - auditDays * 86400]],
    ['endpoint_requests', 'rowid', 'window_start<?', [time - 7 * 86400]],
    ['telemetry_cache', 'cache_key', 'MAX(expires_at,lease_until,negative_until)<?', [time - 1800]],
    [
      'sessions',
      'token_hash',
      'expires_at<=? OR last_seen+CASE WHEN user_id IS NULL THEN 3600 WHEN remember=1 THEN 2592000 ELSE 7200 END<=?',
      [time, time],
    ],
    ['rate_limits', 'key_hash', 'expires_at<=?', [time]],
    ['password_reset_tokens', 'token_hash', 'expires_at<=?', [time]],
    ['email_verification_tokens', 'token_hash', 'expires_at<=? OR used_at IS NOT NULL', [time]],
    ['admin_totp_challenges', 'challenge_hash', 'expires_at<=? OR consumed_at IS NOT NULL', [time]],
    [
      'activation_codes',
      'id',
      'expires_at<? OR used_at<? OR revoked_at<?',
      [time - 7 * 86400, time - 7 * 86400, time - 7 * 86400],
    ],
    ['admin_totp_recovery', 'code_hash', 'used_at<?', [time - 7 * 86400]],
    ['monitorie_queue', 'device_id', 'expires_at<=?', [time]],
  ];
  let deleted = 0;
  for (let round = 0; round < rounds; round++) {
    const results = await c.env.DB.batch(
      rules.map(([table, key, where, args]) =>
        c.env.DB.prepare(
          'DELETE FROM ' +
            table +
            ' WHERE ' +
            key +
            ' IN(SELECT ' +
            key +
            ' FROM ' +
            table +
            ' WHERE ' +
            where +
            ' LIMIT ?)',
        ).bind(...args, batch),
      ),
    );
    deleted += results.reduce((sum, result) => sum + result.meta.changes, 0);
    if (results.every((result) => result.meta.changes < batch)) break;
  }
  await c.env.DB.prepare(
    "DELETE FROM settings WHERE key IN(SELECT key FROM settings WHERE key LIKE 'monitorie:discovery:%' AND updated_at<? LIMIT ?)",
  )
    .bind(time - 86400, batch)
    .run();
  const backlog = await c.env.DB.batch(
    rules.map(([table, , where, args]) =>
      c.env.DB.prepare('SELECT 1 remaining FROM ' + table + ' WHERE ' + where + ' LIMIT 1').bind(...args),
    ),
  );
  const tables = rules.filter((_, index) => backlog[index].results.length > 0).map(([table]) => table);
  const discoveries = await c.env.DB.prepare(
    "SELECT 1 remaining FROM settings WHERE key LIKE 'monitorie:discovery:%' AND updated_at<? LIMIT 1",
  )
    .bind(time - 86400)
    .first();
  if (discoveries) tables.push('monitorie_discoveries');
  const remaining = tables.length > 0;
  await c.env.DB.prepare("UPDATE settings SET value=? WHERE key='maintenance'")
    .bind(JSON.stringify({ deleted, backlog: remaining, tables }))
    .run();
  console.log(JSON.stringify({ event: 'maintenance', deleted, backlog: remaining, tables }));
}
