import type { Context } from '../types';
import { HttpError, json, now } from '../http';
import { randomToken, sha256 } from '../auth/crypto';
import { auditStatement, guard } from './audit';

export async function credentialAction(c: Context, deviceId: number, revoke: boolean): Promise<Response> {
  const token = randomToken();
  const hash = await sha256(token);
  const time = now();
  await c.env.DB.batch([
    guard(c, "SELECT 1 FROM devices WHERE id=? AND source='local'", deviceId),
    revoke
      ? c.env.DB.prepare('UPDATE device_credentials SET revoked_at=?,updated_at=? WHERE device_id=?').bind(
          time,
          time,
          deviceId,
        )
      : c.env.DB.prepare(
          `INSERT INTO device_credentials(device_id,token_hash,created_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash,version=version+1,revoked_at=NULL,updated_at=excluded.updated_at`,
        ).bind(deviceId, hash, time, time),
    auditStatement(c, revoke ? 'credential_revoked' : 'credential_rotated', deviceId),
  ]);
  return json({
    success: true,
    ...(revoke ? {} : { device_token: token }),
    message: revoke ? 'Credencial revogada.' : 'Guarde a credencial: ela é exibida uma única vez.',
  });
}
