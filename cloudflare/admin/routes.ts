import type { Context, DeviceType } from '../types';
import { body, HttpError, iso, json, method, now, positiveId, queryInt, string } from '../http';
import { csrf, requireAdmin } from '../auth/sessions';
import { clientIP, rateLimit } from '../auth/rate-limit';
import { randomToken, sha256 } from '../auth/crypto';
import { deviceMutation } from './mutations';

interface AdminDeviceRow {
  id: number;
  device_code: string;
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
  created_at: number;
  updated_at: number;
  has_active_code: number;
  code_expires_at: number | null;
}

export async function adminRoute(c: Context, path: string): Promise<Response> {
  // Usuários comuns e anônimos recebem 404 (impossibilitando descoberta)
  requireAdmin(c);
  await rateLimit(c, 'admin-action', clientIP(c), 120, 60);

  if (path === '/api/admin/devices' && c.request.method === 'GET') {
    const sql = `
   SELECT d.id, d.device_code, d.device_type, d.source, d.external_id,
          d.owner_user_id, u.name as owner_name, u.email as owner_email,
          r.id as reservoir_id, r.name as reservoir_name, r.linked_at,
          d.reported_status, d.last_seen, d.created_at, d.updated_at,
          CASE WHEN ac.id IS NOT NULL THEN 1 ELSE 0 END as has_active_code,
          ac.expires_at as code_expires_at
   FROM devices d
   LEFT JOIN users u ON u.id = d.owner_user_id
   LEFT JOIN reservoirs r ON r.device_id = d.id AND r.unlinked_at IS NULL
   LEFT JOIN activation_codes ac ON ac.device_id = d.id AND ac.used_at IS NULL AND ac.revoked_at IS NULL AND ac.expires_at > ?
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
        device_type: row.device_type,
        source: row.source,
        external_id: row.external_id,
        status: row.reported_status,
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

  const mutation = await deviceMutation(c, path);
  if (mutation) return mutation;

  if (path === '/api/admin/audit-logs' && c.request.method === 'GET') {
    const deviceIdParam = c.url.searchParams.get('device_id');
    const limit = queryInt(c, 'limit', 50, 1, 200);

    let sql = `
   SELECT a.id, a.action, a.device_id, a.user_id, a.details, a.ip, a.created_at,
          u.name as user_name, u.email as user_email, d.device_code, d.device_type
   FROM audit_logs a
   LEFT JOIN users u ON u.id = a.user_id
   LEFT JOIN devices d ON d.id = a.device_id
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
        device: row.device_id ? { id: row.device_id, code: row.device_code, type: row.device_type } : null,
        author: row.user_id ? { id: row.user_id, name: row.user_name, email: row.user_email } : null,
        details: row.details ? JSON.parse(row.details) : null,
        ip: row.ip,
        created_at: iso(row.created_at),
      })),
    });
  }

  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
