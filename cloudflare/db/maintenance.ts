import type { Context } from '../types';
import { configInt, now } from '../http';

/** Bounded primary-D1 cleanup; each cycle reports whether expired data remains. */
export async function maintenance(c: Context): Promise<void> {
  const time = now(),
    days = configInt(c.env.READINGS_RETENTION_DAYS, 90, 1, 3650),
    auditDays = configInt(c.env.AUDIT_RETENTION_DAYS, 180, 30, 3650);
  const batch = configInt(c.env.RETENTION_BATCH_SIZE, 2000, 1, 5000),
    rounds = configInt(c.env.RETENTION_MAX_BATCHES, 2, 1, 3);
  const token = crypto.randomUUID();
  const claim = await c.env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) SELECT 'maintenance:lease',?,? WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key='maintenance' AND updated_at>?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE settings.updated_at<=? RETURNING key",
  )
    .bind(token, time + 60, time - 60, time)
    .first();
  if (!claim) return;
  // Every mutation shares a transaction with renewal and checks the lease token.
  // A delayed execution cannot delete data or overwrite a newer cycle's report.
  const fence = "EXISTS(SELECT 1 FROM settings WHERE key='maintenance:lease' AND value=? AND updated_at>?)";
  const ownedBatch = async (statements: (at: number) => D1PreparedStatement[]) => {
    const at = now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE settings SET updated_at=? WHERE key='maintenance:lease' AND value=? AND updated_at>?",
      ).bind(at + 60, token, at),
      ...statements(at),
    ]);
    return results[0].meta.changes === 1 ? results.slice(1) : null;
  };
  try {
    if (
      !(await ownedBatch((at) => [
        c.env.DB.prepare(
          "INSERT INTO settings(key,value,updated_at) SELECT 'maintenance','',? WHERE " +
            fence +
            ' ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at',
        ).bind(time, token, at),
        c.env.DB.prepare(
          "INSERT INTO settings(key,value,updated_at) SELECT 'audit_retention_days',?,? WHERE " +
            fence +
            ' ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
        ).bind(String(auditDays), time, token, at),
      ]))
    )
      return;
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
    // Count each SQL statement conservatively, including lease operations and
    // the final report/release. This leaves room to finish within 50 statements
    // even if a provider accounts for every statement inside a batch separately.
    const fixedStatements = 10;
    const boundedRounds = Math.min(rounds, Math.floor((50 - fixedStatements) / (rules.length + 1)));
    let deleted = 0;
    for (let round = 0; round < boundedRounds; round++) {
      const results = await ownedBatch((at) =>
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
              ' LIMIT ?) AND ' +
              fence,
          ).bind(...args, batch, token, at),
        ),
      );
      if (!results) return;
      deleted += results.reduce((sum, result) => sum + result.meta.changes, 0);
      if (results.every((result) => result.meta.changes < batch)) break;
    }
    if (
      !(await ownedBatch((at) => [
        c.env.DB.prepare(
          "DELETE FROM settings WHERE key IN(SELECT key FROM settings WHERE key LIKE 'monitorie:discovery:%' AND updated_at<? LIMIT ?) AND " +
            fence,
        ).bind(time - 86400, batch, token, at),
      ]))
    )
      return;
    // The names and predicates are the fixed local allowlist above. One bounded
    // flag per table preserves all backlog categories without 15 D1 queries.
    const backlog = await c.env.DB.prepare(
      'SELECT ' +
        rules
          .map(([table, , where]) => `EXISTS(SELECT 1 FROM ${table} WHERE ${where} LIMIT 1) AS ${table}`)
          .concat(
            "EXISTS(SELECT 1 FROM settings WHERE key LIKE 'monitorie:discovery:%' AND updated_at<? LIMIT 1) AS monitorie_discoveries",
          )
          .join(','),
    )
      .bind(...rules.flatMap(([, , , args]) => args), time - 86400)
      .first<Record<string, number>>();
    const tables = Object.entries(backlog ?? {})
      .filter(([, remaining]) => remaining === 1)
      .map(([table]) => table);
    const remaining = tables.length > 0;
    if (
      !(await ownedBatch((at) => [
        c.env.DB.prepare("UPDATE settings SET value=? WHERE key='maintenance' AND " + fence).bind(
          JSON.stringify({ deleted, backlog: remaining, tables }),
          token,
          at,
        ),
      ]))
    )
      return;
    console.log(JSON.stringify({ event: 'maintenance', deleted, backlog: remaining, tables }));
  } finally {
    await c.env.DB.prepare("DELETE FROM settings WHERE key='maintenance:lease' AND value=?")
      .bind(token)
      .run();
  }
}
