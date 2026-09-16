import type { Context } from '../types';
import { now } from '../http';
import { clientIP } from '../auth/rate-limit';

export async function recordAudit(
 c: Context,
 action: string,
 deviceId: number | null,
 details?: Record<string, unknown>
): Promise<void> {
 const userId = c.user?.id ?? null;
 const ip = clientIP(c);
 const time = now();
 const detailsStr = details ? JSON.stringify(details) : null;
 await c.env.DB.prepare(
  'INSERT INTO audit_logs (action, device_id, user_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)'
 ).bind(action, deviceId, userId, detailsStr, ip, time).run();
}
