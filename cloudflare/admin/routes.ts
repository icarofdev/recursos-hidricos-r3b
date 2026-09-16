import type { Context, DeviceType } from '../types';
import { body, HttpError, iso, json, method, now, positiveId, queryInt, string } from '../http';
import { csrf, requireAdmin } from '../auth/sessions';
import { clientIP, rateLimit } from '../auth/rate-limit';
import { randomToken, sha256 } from '../auth/crypto';
import { recordAudit } from './audit';

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
 const admin = requireAdmin(c);
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
   data: results.map(row => ({
    id: row.id,
    device_code: row.device_code,
    device_type: row.device_type,
    source: row.source,
    external_id: row.external_id,
    status: row.reported_status,
    last_seen: iso(row.last_seen),
    created_at: iso(row.created_at),
    owner: row.owner_user_id ? {
     id: row.owner_user_id,
     name: row.owner_name,
     email: row.owner_email,
     reservoir_id: row.reservoir_id,
     reservoir_name: row.reservoir_name,
     linked_at: iso(row.linked_at)
    } : null,
    activation_code: row.has_active_code ? {
     active: true,
     expires_at: iso(row.code_expires_at)
    } : null
   }))
  });
 }

 if (path === '/api/admin/devices' && c.request.method === 'POST') {
  csrf(c);
  const data = await body(c, ['device_type', 'device_code', 'external_id', 'source']);
  const type = string(data, 'device_type', 10).trim().toUpperCase();
  if (type !== 'SM-WU' && type !== 'SM-WA') {
   throw new HttpError(422, 'INVALID_DEVICE_TYPE', 'O tipo de dispositivo deve ser SM-WU ou SM-WA.');
  }

  const code = string(data, 'device_code', 64).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,64}$/.test(code)) {
   throw new HttpError(422, 'INVALID_DEVICE_CODE', 'Identificador de dispositivo inválido (use 3 a 64 caracteres alfanuméricos).');
  }

  const externalId = data.external_id ? string(data, 'external_id', 128).trim() : null;
  const source = data.source ? string(data, 'source', 20).trim().toLowerCase() : 'monitorie';
  if (!['monitorie', 'local', 'mock'].includes(source)) {
   throw new HttpError(422, 'INVALID_SOURCE', 'Fonte de telemetria inválida.');
  }

  const existingCode = await c.env.DB.prepare('SELECT id FROM devices WHERE device_code=?').bind(code).first();
  if (existingCode) {
   throw new HttpError(409, 'DEVICE_CODE_IN_USE', 'Identificador já cadastrado para outro equipamento.');
  }

  if (externalId) {
   const existingExternal = await c.env.DB.prepare('SELECT id FROM devices WHERE source=? AND external_id=?').bind(source, externalId).first();
   if (existingExternal) {
    throw new HttpError(409, 'EXTERNAL_ID_IN_USE', 'External ID da Monitorie já associado a outro equipamento.');
   }
  }

  const time = now();
  const res = await c.env.DB.prepare(`
   INSERT INTO devices (device_code, device_type, source, external_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).bind(code, type, source, externalId, time, time).first<{ id: number }>();

  if (!res) throw new HttpError(500, 'DEVICE_CREATION_FAILED', 'Falha ao registrar o dispositivo.');

  await recordAudit(c, 'device_created', res.id, {
   device_type: type,
   device_code: code,
   external_id: externalId,
   source
  });

  return json({
   success: true,
   device: {
    id: res.id,
    device_code: code,
    device_type: type,
    source,
    external_id: externalId,
    created_at: iso(time)
   }
  }, 201);
 }

 const matchDeviceAction = path.match(/^\/api\/admin\/devices\/(\d+)\/(generate-code|revoke-code|unlink|transfer|update)$/);
 if (matchDeviceAction && c.request.method === 'POST') {
  csrf(c);
  const deviceId = positiveId(matchDeviceAction[1]);
  const action = matchDeviceAction[2];

  const device = await c.env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(deviceId).first<{
   id: number;
   device_code: string;
   device_type: DeviceType;
   source: string;
   external_id: string | null;
   owner_user_id: number | null;
  }>();
  if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Dispositivo não encontrado.');

  const time = now();

  if (action === 'generate-code') {
   if (device.owner_user_id !== null) {
    throw new HttpError(409, 'DEVICE_ALREADY_LINKED', 'Dispositivo já vinculado a um cliente. Para trocar de titular, inicie uma transferência.');
   }

   // Revoga códigos anteriores não utilizados
   await c.env.DB.prepare(`
    UPDATE activation_codes SET revoked_at=?, revoked_by_user_id=?
    WHERE device_id=? AND used_at IS NULL AND revoked_at IS NULL
   `).bind(time, admin.id, deviceId).run();

   // Gera código limpo puro
   const rawToken = randomToken(16).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
   const plainCode = `HIDRA-${rawToken.slice(0, 4)}-${rawToken.slice(4, 8)}-${rawToken.slice(8, 12)}-${rawToken.slice(12, 16)}`;
   const codeHash = await sha256(plainCode);
   const expiresAt = time + 7 * 86400; // 7 dias

   await c.env.DB.batch([
    c.env.DB.prepare(`
     INSERT INTO activation_codes (device_id, code_hash, created_by_user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
    `).bind(deviceId, codeHash, admin.id, expiresAt, time),
    c.env.DB.prepare(`
     UPDATE devices SET pairing_code_hash=?, pairing_expires_at=?, updated_at=? WHERE id=?
    `).bind(codeHash, expiresAt, time, deviceId)
   ]);

   await recordAudit(c, 'code_generated', deviceId, { expires_at: expiresAt });

   // O código puro é retornado EXCLUSIVAMENTE nesta resposta e nunca armazenado
   return json({
    success: true,
    activation_code: plainCode,
    expires_at: iso(expiresAt),
    message: 'Código de ativação gerado com sucesso. Anote-o agora: ele não será exibido novamente.'
   });
  }

  if (action === 'revoke-code') {
   await c.env.DB.batch([
    c.env.DB.prepare(`
     UPDATE activation_codes SET revoked_at=?, revoked_by_user_id=?
     WHERE device_id=? AND used_at IS NULL AND revoked_at IS NULL
    `).bind(time, admin.id, deviceId),
    c.env.DB.prepare(`
     UPDATE devices SET pairing_code_hash=NULL, pairing_expires_at=NULL, updated_at=? WHERE id=?
    `).bind(time, deviceId)
   ]);

   await recordAudit(c, 'code_revoked', deviceId);
   return json({ success: true, message: 'Código de ativação revogado.' });
  }

  if (action === 'unlink') {
   if (!device.owner_user_id) {
    throw new HttpError(400, 'DEVICE_NOT_LINKED', 'O dispositivo não possui proprietário vinculado.');
   }

   const prevOwner = device.owner_user_id;
   await c.env.DB.batch([
    c.env.DB.prepare(`
     UPDATE reservoirs SET unlinked_at=?, updated_at=?
     WHERE device_id=? AND unlinked_at IS NULL
    `).bind(time, time, deviceId),
    c.env.DB.prepare(`
     UPDATE devices SET owner_user_id=NULL, pairing_code_hash=NULL, pairing_expires_at=NULL, updated_at=?
     WHERE id=?
    `).bind(time, deviceId)
   ]);

   await recordAudit(c, 'device_unlinked', deviceId, { previous_owner_id: prevOwner });
   return json({ success: true, message: 'Dispositivo desvinculado com sucesso.' });
  }

  if (action === 'transfer') {
   const prevOwner = device.owner_user_id;
   const statements = [];

   // Desvincula proprietário anterior se houver
   if (prevOwner) {
    statements.push(
     c.env.DB.prepare('UPDATE reservoirs SET unlinked_at=?, updated_at=? WHERE device_id=? AND unlinked_at IS NULL').bind(time, time, deviceId)
    );
   }

   // Revoga códigos pendentes
   statements.push(
    c.env.DB.prepare('UPDATE activation_codes SET revoked_at=?, revoked_by_user_id=? WHERE device_id=? AND used_at IS NULL AND revoked_at IS NULL').bind(time, admin.id, deviceId)
   );

   // Gera novo código para o novo titular
   const rawToken = randomToken(16).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
   const plainCode = `HIDRA-${rawToken.slice(0, 4)}-${rawToken.slice(4, 8)}-${rawToken.slice(8, 12)}-${rawToken.slice(12, 16)}`;
   const codeHash = await sha256(plainCode);
   const expiresAt = time + 7 * 86400;

   statements.push(
    c.env.DB.prepare('INSERT INTO activation_codes (device_id, code_hash, created_by_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(deviceId, codeHash, admin.id, expiresAt, time)
   );
   statements.push(
    c.env.DB.prepare('UPDATE devices SET owner_user_id=NULL, pairing_code_hash=?, pairing_expires_at=?, updated_at=? WHERE id=?').bind(codeHash, expiresAt, time, deviceId)
   );

   await c.env.DB.batch(statements);

   await recordAudit(c, 'transfer_initiated', deviceId, {
    previous_owner_id: prevOwner,
    expires_at: expiresAt
   });

   return json({
    success: true,
    activation_code: plainCode,
    expires_at: iso(expiresAt),
    previous_owner_id: prevOwner,
    message: 'Transferência de titularidade iniciada. Entregue o novo código de ativação ao novo proprietário.'
   });
  }

  if (action === 'update') {
   const data = await body(c, ['device_type', 'device_code', 'external_id', 'confirm_linked_modification']);
   const isLinked = device.owner_user_id !== null;

   const newType = data.device_type ? string(data, 'device_type', 10).trim().toUpperCase() : device.device_type;
   const newCode = data.device_code ? string(data, 'device_code', 64).trim().toUpperCase() : device.device_code;
   const newExternalId = data.external_id !== undefined ? (data.external_id ? string(data, 'external_id', 128).trim() : null) : device.external_id;

   if (newType !== 'SM-WU' && newType !== 'SM-WA') {
    throw new HttpError(422, 'INVALID_DEVICE_TYPE', 'Tipo deve ser SM-WU ou SM-WA.');
   }

   const typeChanged = newType !== device.device_type;
   const externalChanged = newExternalId !== device.external_id;

   if (isLinked && (typeChanged || externalChanged)) {
    if (data.confirm_linked_modification !== true) {
     throw new HttpError(422, 'DEVICE_LINKED_IMMUTABLE', 'Dispositivo vinculado. Alterações de modelo ou external_id exigem confirmação administrativa explícita (confirm_linked_modification: true).');
    }
   }

   if (newCode !== device.device_code) {
    const existing = await c.env.DB.prepare('SELECT id FROM devices WHERE device_code=? AND id<>?').bind(newCode, deviceId).first();
    if (existing) throw new HttpError(409, 'DEVICE_CODE_IN_USE', 'Identificador já em uso.');
   }

   if (newExternalId && newExternalId !== device.external_id) {
    const existing = await c.env.DB.prepare('SELECT id FROM devices WHERE source=? AND external_id=? AND id<>?').bind(device.source, newExternalId, deviceId).first();
    if (existing) throw new HttpError(409, 'EXTERNAL_ID_IN_USE', 'External ID já associado a outro equipamento.');
   }

   await c.env.DB.prepare(`
    UPDATE devices SET device_type=?, device_code=?, external_id=?, updated_at=? WHERE id=?
   `).bind(newType, newCode, newExternalId, time, deviceId).run();

   await recordAudit(c, 'device_updated', deviceId, {
    previous: { device_type: device.device_type, device_code: device.device_code, external_id: device.external_id },
    current: { device_type: newType, device_code: newCode, external_id: newExternalId },
    confirmed_linked_modification: isLinked && (typeChanged || externalChanged)
   });

   return json({ success: true, message: 'Dispositivo atualizado com sucesso.' });
  }
 }

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

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{
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
   data: results.map(row => ({
    id: row.id,
    action: row.action,
    device: row.device_id ? { id: row.device_id, code: row.device_code, type: row.device_type } : null,
    author: row.user_id ? { id: row.user_id, name: row.user_name, email: row.user_email } : null,
    details: row.details ? JSON.parse(row.details) : null,
    ip: row.ip,
    created_at: iso(row.created_at)
   }))
  });
 }

 throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
