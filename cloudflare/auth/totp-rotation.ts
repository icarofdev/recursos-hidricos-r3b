import type { Env } from '../types';
import { decryptTotp, encryptTotp, totpNeedsUpgrade, requireTotpKey } from './totp';
/** Operator-only migration helper. Does not generate keys or weaken login checks. */
export async function reencryptTotp(db: D1Database, env: Env): Promise<number> {
  await requireTotpKey(env);
  let changed = 0,
    cursor = 0;
  for (;;) {
    const rows = await db
      .prepare('SELECT user_id,secret_encrypted FROM admin_totp WHERE user_id>? ORDER BY user_id LIMIT 20')
      .bind(cursor)
      .all<{ user_id: number; secret_encrypted: string }>();
    if (!rows.results.length) break;
    const statements = [];
    for (const row of rows.results)
      if (totpNeedsUpgrade(env, row.secret_encrypted))
        statements.push(
          db
            .prepare('UPDATE admin_totp SET secret_encrypted=? WHERE user_id=? AND secret_encrypted=?')
            .bind(
              await encryptTotp(env, row.user_id, await decryptTotp(env, row.user_id, row.secret_encrypted)),
              row.user_id,
              row.secret_encrypted,
            ),
        );
    if (statements.length) {
      const results = await db.batch(statements);
      changed += results.reduce((sum, result) => sum + result.meta.changes, 0);
    }
    cursor = rows.results.at(-1)!.user_id;
  }
  return changed;
}
