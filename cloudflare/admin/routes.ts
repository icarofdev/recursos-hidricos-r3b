import type { Context, DeviceType } from '../types';
import { body, HttpError, iso, json, method, now, positiveId, queryInt, string } from '../http';
import { requireAdmin, requireRecentAdmin } from '../auth/sessions';
import { clientIP, rateLimit } from '../auth/rate-limit';
import { securityEvent } from '../auth/security-events';
import { randomToken, sha256 } from '../auth/crypto';
import { deviceMutation } from './mutations';
import { effectiveStatus } from '../device-status';

interface AdminDeviceRow {
  id: number;
  device_code: string;
  mac_address: string | null;
  device_type: DeviceType;
  source: string;
  external_id: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  owner_email: string | null;
  reservoir_id: number | null;
  reservoir_name: string | null;
  linked_at: number | null;
  reported_status: string;
  last_seen: number | null;
  communication_checked_at: number | null;
  created_at: number;
  updated_at: number;
  has_active_code: number;
  code_expires_at: number | null;
}

export async function adminRoute(c: Context, path: string): Promise<Response> {
  // Usuários comuns e anônimos recebem 404 (impossibilitando descoberta)
  const admin = requireAdmin(c);
  await rateLimit(c, 'admin-action', clientIP(c), 120, 60);

  if (path === '/api/admin/devices' && c.request.method === 'GET') {
    const sql = `
   SELECT d.id, d.device_code, d.mac_address, d.device_type, d.source, d.external_id,
          d.owner_user_id, u.name as owner_name, u.email as owner_email,
          r.id as reservoir_id, r.name as reservoir_name, r.linked_at,
          d.reported_status, d.last_seen, d.communication_checked_at,d.created_at, d.updated_at,
          CASE WHEN ac.id IS NOT NULL THEN 1 ELSE 0 END as has_active_code,
          ac.expires_at as code_expires_at
   FROM devices d
   LEFT JOIN users u ON u.id = d.owner_user_id
   LEFT JOIN reservoirs r ON r.device_id = d.id AND r.unlinked_at IS NULL
   LEFT JOIN activation_codes ac ON ac.device_id = d.id AND ac.code_hash=d.pairing_code_hash AND d.owner_user_id IS NULL AND ac.used_at IS NULL AND ac.revoked_at IS NULL AND ac.expires_at > ?
   GROUP BY d.id
   ORDER BY d.created_at DESC, d.id DESC
  `;
    const { results } = await c.env.DB.prepare(sql).bind(now()).all<AdminDeviceRow>();
    return json({
      success: true,
      count: results.length,
      data: results.map((row) => ({
        id: row.id,
        device_code: row.device_code,
        mac_address: row.mac_address,
        device_type: row.device_type,
        source: row.source,
        external_id: row.external_id,
        status: effectiveStatus(
          c.env,
          row.source,
          row.external_id,
          row.reported_status,
          row.last_seen,
          row.communication_checked_at,
        ),
        last_seen: iso(row.last_seen),
        created_at: iso(row.created_at),
        owner: row.owner_user_id
          ? {
              id: row.owner_user_id,
              name: row.owner_name,
              email: row.owner_email,
              reservoir_id: row.reservoir_id,
              reservoir_name: row.reservoir_name,
              linked_at: iso(row.linked_at),
            }
          : null,
        activation_code: row.has_active_code
          ? {
              active: true,
              expires_at: iso(row.code_expires_at),
            }
          : null,
      })),
    });
  }

  const action =
    c.request.method === 'POST'
      ? path === '/api/admin/devices'
        ? 'device_create'
        : path
            .match(
              /^\/api\/admin\/devices\/\d+\/(generate-code|revoke-code|unlink|transfer|update|rotate-token|revoke-token|delete|monitorie-discover)$/,
            )?.[1]
            ?.replaceAll('-', '_')
      : null;
  if (action) {
    try {
      requireRecentAdmin(c);
      const mutation = await deviceMutation(c, path);
      if (mutation) {
        await securityEvent(c, `admin_${action}`, 'success', admin.id);
        return mutation;
      }
    } catch (error) {
      await securityEvent(c, `admin_${action}`, 'failure', admin.id);
      throw error;
    }
  }

  const mutation = await deviceMutation(c, path);
  if (mutation) return mutation;

  if (path === '/api/admin/audit-logs' && c.request.method === 'GET') {
    const deviceIdParam = c.url.searchParams.get('device_id');
    const limit = queryInt(c, 'limit', 50, 1, 200);

    let sql = `
   SELECT a.id, a.action, a.device_id, a.user_id, a.details, a.ip, a.created_at,
          u.name as user_name, u.email as user_email, d.device_code, d.device_type,
          identity.identity as device_identity
   FROM audit_logs a
   LEFT JOIN users u ON u.id = a.user_id
   LEFT JOIN device_identities identity ON identity.device_id=a.device_id
    AND a.id>=CAST((SELECT value FROM settings WHERE key='audit:identity-first-id') AS INTEGER)
   LEFT JOIN devices d ON d.id=identity.device_id
  `;
    const binds: unknown[] = [];
    if (deviceIdParam) {
      sql += ' WHERE a.device_id=?';
      binds.push(positiveId(deviceIdParam));
    }
    sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?';
    binds.push(limit);

    const { results } = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<{
        id: number;
        action: string;
        device_id: number | null;
        device_code: string | null;
        device_type: DeviceType | null;
        device_identity: string | null;
        user_id: number | null;
        user_name: string | null;
        user_email: string | null;
        details: string | null;
        ip: string | null;
        created_at: number;
      }>();

    return json({
      success: true,
      count: results.length,
      data: results.map((row) => ({
        id: row.id,
        action: row.action,
        device: row.device_id
          ? {
              id: row.device_id,
              identity: row.device_identity,
              code: row.device_code,
              type: row.device_type,
              legacy_identity_unknown: row.device_identity === null,
            }
          : null,
        author: row.user_id ? { id: row.user_id, name: row.user_name, email: row.user_email } : null,
        details: parseAuditDetails(row.details),
        ip: row.ip,
        created_at: iso(row.created_at),
      })),
    });
  }

  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
function parseAuditDetails(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { unavailable: true };
  }
}
