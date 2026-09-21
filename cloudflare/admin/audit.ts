import type { Context } from '../types';
import { now } from '../http';
/** Always included in the SAME batch as the mutation. No IP/name/email/secrets. */
export function auditStatement(
  c: Context,
  action: string,
  deviceId: number | null,
  details: Record<string, unknown> = {},
  conditional = false,
): D1PreparedStatement {
  return c.env.DB.prepare(
    `INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
 SELECT ?,?,?,?,? ${conditional ? 'WHERE changes()>0' : ''}`,
  ).bind(action, deviceId, c.user?.id ?? null, JSON.stringify(details), now());
}
export function guard(c: Context, sql: string, ...values: unknown[]): D1PreparedStatement {
  return c.env.DB.prepare(`INSERT INTO mutation_guard(value) SELECT 0 WHERE NOT EXISTS(${sql})`).bind(
    ...values,
  );
}
