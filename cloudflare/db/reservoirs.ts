import type { Context, ReservoirRow } from '../types';
import { body, configInt, HttpError, isLocal, iso, json, method, now, positiveId, string } from '../http';
import { csrf, requireUser } from '../auth/sessions';
import { randomToken, sha256 } from '../auth/crypto';
import { clientIP, rateLimit } from '../auth/rate-limit';
import { auditStatement } from '../admin/audit';
import { normalizeMac } from '../admin/device-identity';
import { guard } from '../admin/audit';
import { validateConfiguration } from '../reservoir-volume';
import { effectiveStatus } from '../device-status';

const select = `SELECT r.*,r.linked_at owner_linked_at,MAX(r.linked_at_ms,du.access_started_ms) access_linked_at_ms,d.ownership_generation,du.user_id access_user_id,du.access_generation,d.device_code,d.mac_address,d.device_type,d.source,d.external_id,d.last_seen,d.communication_checked_at,d.reported_status,
 CASE WHEN du.user_id=r.user_id THEN r.linked_at ELSE MAX(r.linked_at,du.linked_at) END access_linked_at,(SELECT COUNT(*) FROM device_users WHERE device_id=d.id) user_count
 FROM reservoirs r JOIN devices d ON d.id=r.device_id
 JOIN device_users du ON du.device_id=d.id
 WHERE du.user_id=? AND d.owner_user_id=r.user_id AND r.unlinked_at IS NULL
 AND (du.user_id=r.user_id OR EXISTS(SELECT 1 FROM users proof WHERE proof.id=du.user_id AND proof.email_verified_at IS NOT NULL))`;

export async function owned(c: Context, id: number, manage = false): Promise<ReservoirRow> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(select + ' AND r.id=?')
    .bind(user.id, id)
    .first<ReservoirRow>();
  if (!row) throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
  if (manage && row.user_id !== user.id)
    throw new HttpError(
      403,
      'OWNER_REQUIRED',
      'Somente o proprietário pode alterar este reservatório ou gerenciar usuários.',
    );
  row.linked_at = row.access_linked_at_ms / 1000;
  return row;
}

export function present(c: Context, row: ReservoirRow) {
  const threshold = configInt(c.env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400);
  const visibleLastSeen =
    row.last_seen !== null && Math.round(row.last_seen * 1000) < row.access_linked_at_ms
      ? null
      : row.last_seen;
  const visibleChecked =
    row.communication_checked_at !== null &&
    Math.round(row.communication_checked_at * 1000) < row.access_linked_at_ms
      ? null
      : row.communication_checked_at;
  return {
    id: row.id,
    name: row.name,
    capacity_liters: row.capacity_liters,
    installation_type: row.installation_type,
    geometry: row.geometry,
    measurement_config: row.measurement_config ? JSON.parse(row.measurement_config) : null,
    can_manage: row.user_id === c.user?.id && !c.session?.read_only,
    user_count: row.user_count,
    user_limit: 5,
    linked_at: iso(row.access_linked_at_ms / 1000),
    device: {
      id: row.device_id,
      code: row.mac_address ?? row.device_code,
      type: row.device_type,
      request_interval_seconds: row.source === 'monitorie' ? 70 : 0,
      telemetry_linked: row.source !== 'monitorie' || row.external_id !== null,
      status:
        row.source === 'monitorie' && visibleLastSeen === null
          ? 'unknown'
          : effectiveStatus(
              c.env,
              row.source,
              row.external_id,
              row.reported_status,
              visibleLastSeen,
              visibleChecked,
            ),
      last_seen: row.source === 'monitorie' && row.external_id === null ? null : iso(visibleLastSeen),
      offline_after_seconds: threshold,
    },
  };
}

export async function reservoirsRoute(c: Context, path: string): Promise<Response> {
  const user = requireUser(c);
  if (path === '/api/reservoirs') {
    method(c, ['GET']);
    const { results } = await c.env.DB.prepare(select + ' ORDER BY r.created_at,r.id')
      .bind(user.id)
      .all<ReservoirRow>();
    return json({ success: true, count: results.length, data: results.map((row) => present(c, row)) });
  }
  if (path === '/api/devices/users') {
    method(c, ['GET']);
    const row = await owned(c, positiveId(c.url.searchParams.get('reservoir_id')));
    const { results } = await c.env.DB.prepare(
      'SELECT u.id,u.name,u.email,du.linked_at FROM device_users du JOIN users u ON u.id=du.user_id WHERE du.device_id=? ORDER BY du.linked_at,u.id',
    )
      .bind(row.device_id)
      .all<{ id: number; name: string; email: string; linked_at: number }>();
    return json({
      success: true,
      limit: 5,
      data: results.map((member) => ({
        ...member,
        email:
          !c.session?.read_only && (row.user_id === user.id || member.id === user.id) ? member.email : null,
        is_owner: member.id === row.user_id,
        linked_at: iso(member.linked_at),
      })),
    });
  }
  method(c, ['POST']);
  csrf(c);
  if (path === '/api/devices/users/add' || path === '/api/devices/users/remove') {
    await rateLimit(c, 'device-users', String(user.id), 30, 60);
    const add = path.endsWith('/add');
    const data = await body(c, add ? ['reservoir_id', 'email'] : ['reservoir_id', 'user_id']);
    const row = await owned(c, positiveId(data.reservoir_id), true);
    const target = add
      ? (
          await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND email_verified_at IS NOT NULL')
            .bind(string(data, 'email', 254).trim().toLowerCase())
            .first<{ id: number }>()
        )?.id
      : positiveId(data.user_id);
    if (add && user.email_verified_at === null)
      throw new HttpError(
        403,
        'EMAIL_VERIFICATION_REQUIRED',
        'Confirme seu e-mail antes de compartilhar dispositivos.',
      );
    if (!target)
      return json(
        {
          success: true,
          message:
            'Se a conta estiver apta, o vínculo estará disponível. A pessoa deve confirmar seu e-mail para receber novos acessos.',
        },
        202,
      );
    if (!add && target === row.user_id)
      throw new HttpError(
        422,
        'OWNER_LINK_REQUIRED',
        'Use a desvinculação do dispositivo para remover o proprietário.',
      );
    const result = await c.env.DB.batch([
      ownerGuard(c, row),
      add
        ? c.env.DB.prepare(
            'INSERT INTO device_users(device_id,user_id,linked_at,access_generation,access_started_ms) SELECT ?,id,?,?,? FROM users WHERE id=? AND email_verified_at IS NOT NULL RETURNING user_id',
          ).bind(row.device_id, now(), randomToken(16), Date.now(), target)
        : c.env.DB.prepare('DELETE FROM device_users WHERE device_id=? AND user_id=? RETURNING user_id').bind(
            row.device_id,
            target,
          ),
      auditStatement(
        c,
        add ? 'device_user_added' : 'device_user_removed',
        row.device_id,
        { associated_user_id: target },
        true,
      ),
    ]);
    if (!result[1].results.length) throw new HttpError(404, 'USER_LINK_NOT_FOUND', 'Vínculo não encontrado.');
    return json(
      add
        ? {
            success: true,
            message:
              'Se a conta estiver apta, o vínculo estará disponível. A pessoa deve confirmar seu e-mail para receber novos acessos.',
          }
        : { success: true },
      add ? 202 : 200,
    );
  }
  if (path === '/api/reservoirs/configuration') {
    const data = await body(c, [
      'reservoir_id',
      'installation_type',
      'geometry',
      'capacity_liters',
      'measurement_config',
    ]);
    const row = await owned(c, positiveId(data.reservoir_id), true);
    if (!['elevated', 'building', 'underground', 'custom'].includes(String(data.installation_type)))
      throw new HttpError(422, 'INVALID_INSTALLATION', 'Selecione um tipo de instalação.');
    const capacity = data.capacity_liters;
    if (
      capacity !== null &&
      (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0 || capacity > 1e12)
    )
      throw new HttpError(422, 'INVALID_CAPACITY', 'Informe uma capacidade positiva.');
    const geometry = string(data, 'geometry', 32);
    const config = validateConfiguration(geometry, capacity, data.measurement_config);
    if (row.device_type !== 'SM-WU')
      throw new HttpError(422, 'INVALID_DEVICE_TYPE', 'Configuração de volume exige sensor de nível SM-WU.');
    await c.env.DB.batch([
      ownerGuard(c, row, true),
      c.env.DB.prepare(
        'UPDATE reservoirs SET installation_type=?,geometry=?,capacity_liters=?,measurement_config=?,updated_at=? WHERE id=?',
      ).bind(
        data.installation_type,
        geometry,
        capacity,
        config ? JSON.stringify(config) : null,
        now(),
        row.id,
      ),
      auditStatement(c, 'reservoir_configured', row.device_id, { reservoir_id: row.id, geometry }, true),
    ]);
    return json({ success: true, data: present(c, await owned(c, row.id)) });
  }
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
    const row = await owned(c, id, true);
    validateConfiguration(
      row.geometry,
      capacity,
      row.measurement_config ? JSON.parse(row.measurement_config) : null,
    );
    await c.env.DB.batch([
      ownerGuard(c, row, true),
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
    const row = await owned(c, id, true);
    await c.env.DB.batch([
      ownerGuard(c, row),
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
    if (row.user_id !== user.id) {
      const results = await c.env.DB.batch([
        guard(
          c,
          'SELECT 1 FROM reservoirs r JOIN devices d ON d.id=r.device_id WHERE r.id=? AND r.device_id=? AND r.unlinked_at IS NULL AND r.user_id<>? AND d.owner_user_id=r.user_id AND d.owner_user_id<>?',
          id,
          row.device_id,
          user.id,
          user.id,
        ),
        c.env.DB.prepare('DELETE FROM device_users WHERE device_id=? AND user_id=? RETURNING user_id').bind(
          row.device_id,
          user.id,
        ),
        auditStatement(c, 'device_user_left', row.device_id, undefined, true),
      ]);
      if (!results[1].results.length)
        throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
      return json({ success: true });
    }
    const results = await c.env.DB.batch([
      ownerGuard(c, row),
      c.env.DB.prepare(
        'UPDATE reservoirs SET unlinked_at=?,updated_at=? WHERE id=? AND user_id=? AND unlinked_at IS NULL RETURNING id',
      ).bind(time, time, id, user.id),
      c.env.DB.prepare(
        "UPDATE devices SET reported_status='offline',last_seen=NULL,communication_checked_at=NULL,updated_at=? WHERE id=?",
      ).bind(time, row.device_id),
      auditStatement(c, 'device_unlinked', row.device_id, { reservoir_id: id }, true),
    ]);
    const result = results[1].results[0];
    if (!result) throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');

    return json({ success: true });
  }
  if (path === '/api/devices/validate-pairing' || path === '/api/devices/connect') {
    await rateLimit(c, 'pairing', clientIP(c), isLocal(c) ? 100 : 10, 600);
    const connect = path.endsWith('/connect');
    const data = await body(
      c,
      connect ? ['pairing_code', 'mac_address', 'reservoir_name'] : ['pairing_code', 'mac_address'],
    );
    const code = string(data, 'pairing_code', 96).trim().toUpperCase();
    const mac =
      data.mac_address === undefined || data.mac_address === '' ? null : normalizeMac(data.mac_address);
    const hash = await sha256(code);
    if (!connect) {
      const device = await c.env.DB.prepare(
        `SELECT device_code,mac_address,device_type,source,external_id,reported_status,last_seen,communication_checked_at,ownership_generation,first_claim_at FROM devices WHERE pairing_code_hash=? AND owner_user_id IS NULL AND pairing_expires_at>? AND (mac_address=? OR (mac_address IS NULL AND ? IS NULL))
         AND EXISTS(SELECT 1 FROM activation_codes ac WHERE ac.device_id=devices.id AND ac.code_hash=devices.pairing_code_hash AND ac.used_at IS NULL AND ac.revoked_at IS NULL AND ac.expires_at>unixepoch())`,
      )
        .bind(hash, now(), mac, mac)
        .first<{
          device_code: string;
          mac_address: string | null;
          device_type: string;
          source: string;
          external_id: string | null;
          reported_status: string;
          last_seen: number | null;
          communication_checked_at: number | null;
          ownership_generation: number;
          first_claim_at: number | null;
        }>();
      if (!device) throw pairingError();
      const priorOwnership = device.ownership_generation > 0 || device.first_claim_at !== null;
      const visibleLastSeen = priorOwnership ? null : device.last_seen;
      const visibleChecked = priorOwnership ? null : device.communication_checked_at;
      const visibleReported = priorOwnership ? 'offline' : device.reported_status;
      return json({
        success: true,
        data: {
          device_code: device.mac_address ?? device.device_code,
          device_type: device.device_type,
          telemetry_linked: device.source !== 'monitorie' || device.external_id !== null,
          status: effectiveStatus(
            c.env,
            device.source,
            device.external_id,
            visibleReported,
            visibleLastSeen,
            visibleChecked,
          ),
          last_seen:
            device.source === 'monitorie' && device.external_id === null ? null : iso(visibleLastSeen),
        },
      });
    }
    const name = reservoirName(string(data, 'reservoir_name', 120));
    const time = now();
    // INSERT SELECT + índice único + trigger impedem dois proprietários simultâneos.
    const result = await c.env.DB.prepare(
      `INSERT INTO reservoirs(user_id,device_id,name,linked_at,created_at,updated_at,linked_at_ms)
   SELECT ?,id,?,?,?,?,? FROM devices WHERE pairing_code_hash=? AND owner_user_id IS NULL AND pairing_expires_at>? AND (mac_address=? OR (mac_address IS NULL AND ? IS NULL))
   AND EXISTS(SELECT 1 FROM activation_codes ac WHERE ac.device_id=devices.id AND ac.code_hash=devices.pairing_code_hash AND ac.used_at IS NULL AND ac.revoked_at IS NULL AND ac.expires_at>unixepoch())
   RETURNING id, device_id`,
    )
      .bind(user.id, name, time, time, time, Date.now(), hash, time, mac, mac)
      .first<{ id: number; device_id: number }>();
    if (!result) throw pairingError();
    await c.env.DB.prepare('UPDATE devices SET communication_checked_at=NULL WHERE id=?')
      .bind(result.device_id)
      .run();

    return json({ success: true, data: present(c, await owned(c, result.id)) }, 201);
  }
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
function ownerGuard(c: Context, row: ReservoirRow, configuration = false) {
  return guard(
    c,
    'SELECT 1 FROM reservoirs r JOIN devices d ON d.id=r.device_id WHERE r.id=? AND r.user_id=? AND d.owner_user_id=r.user_id AND r.unlinked_at IS NULL' +
      (configuration ? ' AND r.configuration_version=?' : ''),
    row.id,
    requireUser(c).id,
    ...(configuration ? [row.configuration_version] : []),
  );
}
function reservoirName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if ([...normalized].length < 1 || [...normalized].length > 60)
    throw new HttpError(422, 'INVALID_RESERVOIR_NAME', 'Use um nome de 1 a 60 caracteres.');
  return normalized;
}
function pairingError() {
  return new HttpError(
    422,
    'INVALID_PAIRING_CODE',
    'MAC ou código de ativação inválido, expirado ou já utilizado.',
  );
}
/** Check again after asynchronous integration work, including hits on stored cache. */
export async function assertCurrentAccess(c: Context, row: ReservoirRow): Promise<void> {
  const current = await owned(c, row.id);
  if (
    current.access_generation !== row.access_generation ||
    current.ownership_generation !== row.ownership_generation
  )
    throw new HttpError(404, 'RESERVOIR_NOT_FOUND', 'Reservatório não encontrado.');
}
