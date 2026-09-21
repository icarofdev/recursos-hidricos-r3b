import type { Context, ReservoirRow } from '../types';
import { body, configInt, HttpError, isLocal, iso, json, method, now, positiveId, string } from '../http';
import { csrf, requireUser } from '../auth/sessions';
import { sha256 } from '../auth/crypto';
import { clientIP, rateLimit } from '../auth/rate-limit';
import { auditStatement } from '../admin/audit';

const select = `SELECT r.*,d.device_code,d.device_type,d.source,d.external_id,d.last_seen,d.reported_status
 FROM reservoirs r JOIN devices d ON d.id=r.device_id
 WHERE r.user_id=? AND d.owner_user_id=? AND r.unlinked_at IS NULL`;

export async function owned(c: Context, id: number): Promise<ReservoirRow> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(select + ' AND r.id=?')
    .bind(user.id, user.id, id)
    .first<ReservoirRow>();
  if (!row) throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
  return row;
}

export function present(c: Context, row: ReservoirRow) {
  const threshold = configInt(c.env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400);
  return {
    id: row.id,
    name: row.name,
    capacity_liters: row.capacity_liters,
    linked_at: iso(row.linked_at),
    device: {
      id: row.device_id,
      code: row.device_code,
      type: row.device_type,
      status:
        row.reported_status === 'online' && row.last_seen !== null && row.last_seen + threshold > now()
          ? 'online'
          : 'offline',
      last_seen: iso(row.last_seen),
      offline_after_seconds: threshold,
    },
  };
}

export async function reservoirsRoute(c: Context, path: string): Promise<Response> {
  const user = requireUser(c);
  if (path === '/api/reservoirs') {
    method(c, ['GET']);
    const { results } = await c.env.DB.prepare(select + ' ORDER BY r.created_at,r.id')
      .bind(user.id, user.id)
      .all<ReservoirRow>();
    return json({ success: true, count: results.length, data: results.map((row) => present(c, row)) });
  }
  method(c, ['POST']);
  csrf(c);
  if (path === '/api/reservoirs/capacity') {
    const data = await body(c, ['reservoir_id', 'capacity_liters']);
    const id = positiveId(data.reservoir_id);
    const capacity = data.capacity_liters;
    if (
      capacity !== null &&
      (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0 || capacity > 1e12)
    )
      throw new HttpError(
        422,
        'INVALID_CAPACITY',
        'Informe uma capacidade positiva de até 1 trilhão de litros, ou null.',
      );
    const row = await owned(c, id);
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE reservoirs SET capacity_liters=?,updated_at=? WHERE id=? AND user_id=? AND unlinked_at IS NULL',
      ).bind(capacity, now(), id, user.id),
      auditStatement(
        c,
        'capacity_updated',
        row.device_id,
        { reservoir_id: id, capacity_liters: capacity },
        true,
      ),
    ]);
    return json({ success: true, data: present(c, await owned(c, id)) });
  }
  if (path === '/api/reservoirs/rename') {
    const data = await body(c, ['reservoir_id', 'name']);
    const id = positiveId(data.reservoir_id);
    const name = reservoirName(string(data, 'name', 120));
    await owned(c, id);
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE reservoirs SET name=?,updated_at=? WHERE id=? AND user_id=? AND unlinked_at IS NULL',
      ).bind(name, now(), id, user.id),
      auditStatement(c, 'reservoir_renamed', null, { reservoir_id: id }, true),
    ]);
    return json({ success: true, data: present(c, await owned(c, id)) });
  }
  if (path === '/api/devices/unlink') {
    const data = await body(c, ['reservoir_id', 'confirmation']);
    const id = positiveId(data.reservoir_id);
    if (data.confirmation !== true)
      throw new HttpError(422, 'INVALID_UNLINK_REQUEST', 'Confirme a desvinculação.');
    const row = await owned(c, id);
    const time = now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE reservoirs SET unlinked_at=?,updated_at=? WHERE id=? AND user_id=? AND unlinked_at IS NULL RETURNING id',
      ).bind(time, time, id, user.id),
      auditStatement(c, 'device_unlinked', row.device_id, { reservoir_id: id }, true),
    ]);
    const result = results[0].results[0];
    if (!result) throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');

    return json({ success: true });
  }
  if (path === '/api/devices/validate-pairing' || path === '/api/devices/connect') {
    await rateLimit(c, 'pairing', clientIP(c), isLocal(c) ? 100 : 10, 600);
    const connect = path.endsWith('/connect');
    const data = await body(c, connect ? ['pairing_code', 'reservoir_name'] : ['pairing_code']);
    const code = string(data, 'pairing_code', 96).trim().toUpperCase();
    const hash = await sha256(code);
    if (!connect) {
      const device = await c.env.DB.prepare(
        'SELECT device_code,device_type,reported_status,last_seen FROM devices WHERE pairing_code_hash=? AND owner_user_id IS NULL AND pairing_expires_at>?',
      )
        .bind(hash, now())
        .first<{
          device_code: string;
          device_type: string;
          reported_status: string;
          last_seen: number | null;
        }>();
      if (!device) throw pairingError();
      const threshold = configInt(c.env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400);
      return json({
        success: true,
        data: {
          device_code: device.device_code,
          device_type: device.device_type,
          status:
            device.last_seen && device.reported_status === 'online' && device.last_seen + threshold > now()
              ? 'online'
              : 'offline',
          last_seen: iso(device.last_seen),
        },
      });
    }
    const name = reservoirName(string(data, 'reservoir_name', 120));
    const time = now();
    // INSERT SELECT + índice único + trigger impedem dois proprietários simultâneos.
    const result = await c.env.DB.prepare(
      `INSERT INTO reservoirs(user_id,device_id,name,linked_at,created_at,updated_at)
   SELECT ?,id,?,?,?,? FROM devices WHERE pairing_code_hash=? AND owner_user_id IS NULL AND pairing_expires_at>?
   RETURNING id, device_id`,
    )
      .bind(user.id, name, time, time, time, hash, time)
      .first<{ id: number; device_id: number }>();
    if (!result) throw pairingError();

    return json({ success: true, data: present(c, await owned(c, result.id)) }, 201);
  }
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
function reservoirName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if ([...normalized].length < 1 || [...normalized].length > 60)
    throw new HttpError(422, 'INVALID_RESERVOIR_NAME', 'Use um nome de 1 a 60 caracteres.');
  return normalized;
}
function pairingError() {
  return new HttpError(422, 'INVALID_PAIRING_CODE', 'Código de ativação inválido, expirado ou já utilizado.');
}
