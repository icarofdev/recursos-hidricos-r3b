import type { Context, DeviceType } from '../types';
import { body, HttpError, iso, isLocal, json, now, positiveId, string } from '../http';
import { csrf, requireAdmin } from '../auth/sessions';
import { randomToken, sha256 } from '../auth/crypto';
import { auditStatement, guard } from './audit';
import { credentialAction } from './credentials';

export async function deviceMutation(c: Context, path: string): Promise<Response | null> {
  if (c.request.method !== 'POST') return null;
  csrf(c);
  const admin = requireAdmin(c);
  const time = now();
  if (path === '/api/admin/devices') {
    const data = await body(c, ['device_type', 'device_code', 'external_id', 'source']);
    const type = string(data, 'device_type', 10).trim().toUpperCase();
    validateType(type);
    const code = string(data, 'device_code', 64).trim().toUpperCase();
    validateCode(code);
    const external = data.external_id ? string(data, 'external_id', 128).trim() : null;
    const source = data.source ? string(data, 'source', 20).trim() : 'monitorie';
    if (!['monitorie', 'local', 'mock'].includes(source) || (source === 'mock' && !isLocal(c)))
      throw new HttpError(422, 'INVALID_SOURCE', 'Fonte indisponível neste ambiente.');
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO devices(device_code,device_type,source,external_id,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id',
      ).bind(code, type, source, external, time, time),
      c.env.DB.prepare(
        `INSERT INTO audit_logs(action,device_id,user_id,details,created_at)
    SELECT 'device_created',id,?,?,? FROM devices WHERE device_code=?`,
      ).bind(admin.id, JSON.stringify({ device_type: type, source }), time, code),
    ]);
    const id = (results[0].results[0] as { id: number }).id;
    return json(
      {
        success: true,
        device: {
          id,
          device_code: code,
          device_type: type,
          source,
          external_id: external,
          created_at: iso(time),
        },
      },
      201,
    );
  }
  const match = path.match(
    /^\/api\/admin\/devices\/(\d+)\/(generate-code|revoke-code|unlink|transfer|update|rotate-token|revoke-token|delete)$/,
  );
  if (!match) return null;
  const deviceId = positiveId(match[1]),
    action = match[2];
  if (action === 'rotate-token' || action === 'revoke-token') {
    await body(c, []);
    return credentialAction(c, deviceId, action === 'revoke-token');
  }
  const device = await c.env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(deviceId).first<{
    device_type: DeviceType;
    device_code: string;
    external_id: string | null;
    owner_user_id: number | null;
    source: string;
  }>();
  if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Dispositivo não encontrado.');
  const statements = [
    guard(
      c,
      'SELECT 1 FROM devices WHERE id=? AND owner_user_id IS ? AND device_type=? AND external_id IS ? AND device_code=?',
      deviceId,
      device.owner_user_id,
      device.device_type,
      device.external_id,
      device.device_code,
    ),
  ];
  if (action === 'update') {
    const data = await body(c, ['device_type', 'device_code', 'external_id', 'confirm_linked_modification']);
    const type = data.device_type ? string(data, 'device_type', 10).trim().toUpperCase() : device.device_type;
    validateType(type);
    const code = data.device_code ? string(data, 'device_code', 64).trim().toUpperCase() : device.device_code;
    validateCode(code);
    const external =
      data.external_id === undefined
        ? device.external_id
        : data.external_id
          ? string(data, 'external_id', 128).trim()
          : null;
    if (
      device.owner_user_id !== null &&
      (type !== device.device_type || external !== device.external_id) &&
      data.confirm_linked_modification !== true
    )
      throw new HttpError(
        422,
        'DEVICE_LINKED_IMMUTABLE',
        'Confirme explicitamente a alteração do equipamento vinculado.',
      );
    statements.push(
      c.env.DB.prepare(
        'UPDATE devices SET device_type=?,device_code=?,external_id=?,updated_at=? WHERE id=?',
      ).bind(type, code, external, time, deviceId),
      auditStatement(c, 'device_updated', deviceId, { device_type: type }),
    );
  } else if (action === 'delete') {
    const data = await body(c, ['confirmation']);
    if (data.confirmation !== true) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Confirme a exclusão.');
    statements.push(
      c.env.DB.prepare('DELETE FROM devices WHERE id=?').bind(deviceId),
      auditStatement(c, 'device_deleted', deviceId),
    );
  } else {
    await body(c, []);
    if (action === 'generate-code' && device.owner_user_id !== null)
      throw new HttpError(409, 'DEVICE_ALREADY_LINKED', 'Dispositivo já vinculado.');
    if (action === 'unlink' && device.owner_user_id === null)
      throw new HttpError(409, 'DEVICE_NOT_LINKED', 'Dispositivo já desvinculado.');
    if (action === 'unlink' || action === 'transfer')
      statements.push(
        c.env.DB.prepare(
          'UPDATE reservoirs SET unlinked_at=?,updated_at=? WHERE device_id=? AND unlinked_at IS NULL',
        ).bind(time, time, deviceId),
      );
    statements.push(
      c.env.DB.prepare(
        'UPDATE activation_codes SET revoked_at=?,revoked_by_user_id=? WHERE device_id=? AND used_at IS NULL AND revoked_at IS NULL',
      ).bind(time, admin.id, deviceId),
    );
    if (action === 'generate-code' || action === 'transfer') {
      // 128 bits encoded as hex; never trim or uppercase a base64 token.
      const raw = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
      const code = 'HIDRA-' + raw.match(/.{8}/g)!.join('-'),
        hash = await sha256(code),
        expires = time + 7 * 86400;
      statements.push(
        c.env.DB.prepare(
          'INSERT INTO activation_codes(device_id,code_hash,created_by_user_id,expires_at,created_at,is_transfer) VALUES (?,?,?,?,?,?)',
        ).bind(deviceId, hash, admin.id, expires, time, Number(action === 'transfer')),
        c.env.DB.prepare(
          'UPDATE devices SET pairing_code_hash=?,pairing_expires_at=?,updated_at=? WHERE id=?',
        ).bind(hash, expires, time, deviceId),
        auditStatement(c, action === 'transfer' ? 'transfer_initiated' : 'code_generated', deviceId, {
          expires_at: expires,
        }),
      );
      await c.env.DB.batch(statements);
      return json({
        success: true,
        activation_code: code,
        expires_at: iso(expires),
        previous_owner_id: device.owner_user_id,
      });
    }
    statements.push(
      c.env.DB.prepare(
        'UPDATE devices SET pairing_code_hash=NULL,pairing_expires_at=NULL,updated_at=? WHERE id=?',
      ).bind(time, deviceId),
      auditStatement(c, action === 'unlink' ? 'device_unlinked' : 'code_revoked', deviceId),
    );
  }
  await c.env.DB.batch(statements);
  return json({ success: true });
}
function validateType(type: string): void {
  if (type !== 'SM-WU' && type !== 'SM-WA')
    throw new HttpError(422, 'INVALID_DEVICE_TYPE', 'Use SM-WU ou SM-WA.');
}
function validateCode(code: string): void {
  if (!/^[A-Z0-9_-]{3,64}$/.test(code))
    throw new HttpError(422, 'INVALID_DEVICE_CODE', 'Identificador inválido.');
}
