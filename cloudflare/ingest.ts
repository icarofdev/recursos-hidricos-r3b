import type { Context, DeviceType, Reading, SMWAReading } from './types';
import { body, configInt, HttpError, iso, json, method, now, positiveId } from './http';
import { sha256 } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { validateReading } from './monitorie/cache';
import { guard } from './admin/audit';

/** Internal direct-ingestion contract. This is NOT a MonitorIE payload mapping. */
export async function ingest(c: Context): Promise<Response> {
  method(c, ['POST']);
  if (c.env.INGEST_ENABLED !== 'true')
    throw new HttpError(503, 'INGEST_DISABLED', 'Ingestão direta desativada.');
  if (c.url.protocol !== 'https:' && c.env.APP_ENV !== 'development')
    throw new HttpError(400, 'HTTPS_REQUIRED', 'Use HTTPS.');
  await rateLimit(c, 'ingest-ip', clientIP(c), 120, 60);
  const input = await body(c);
  const normalized: Record<string, unknown> = {};
  const aliases: Record<string, string> = {
    d: 'distancia',
    distance: 'distancia',
    level: 'nivel',
    volume_litros: 'volume',
    volume_liters: 'volume',
  };
  for (const [key, value] of Object.entries(input)) {
    const canonical = aliases[key.toLowerCase().trim()] ?? key.toLowerCase().trim();
    if (Object.hasOwn(normalized, canonical)) throw invalid();
    normalized[canonical] = value;
  }
  const id = positiveId(normalized.id);
  const token =
    c.request.headers.get('Authorization')?.match(/^Bearer ([\w-]{43})$/i)?.[1] ??
    c.request.headers.get('X-Device-Token') ??
    '';
  if (c.url.searchParams.has('token') || !/^[\w-]{43}$/.test(token)) throw unauthorized();
  const hash = await sha256(token);
  const device = await c.env.DB.prepare(
    `SELECT d.device_type,d.source FROM devices d JOIN device_credentials cr ON cr.device_id=d.id
 WHERE d.id=? AND cr.token_hash=? AND cr.revoked_at IS NULL`,
  )
    .bind(id, hash)
    .first<{ device_type: DeviceType; source: string }>();
  if (!device) throw unauthorized();
  await rateLimit(c, 'ingest-device', String(id), configInt(c.env.INGEST_DEVICE_LIMIT, 60, 1, 120), 60);
  if (device.source !== 'local')
    throw new HttpError(409, 'DEVICE_SOURCE_CONFLICT', 'Dispositivo usa outra fonte de telemetria.');
  const type = normalized.device_type ?? device.device_type;
  if (type !== device.device_type)
    throw new HttpError(409, 'DEVICE_TYPE_CONFLICT', 'Modelo incompatível com o dispositivo.');
  const fields =
    type === 'SM-WA'
      ? ['vazao', 'consumo_acumulado', 'volume', 'rssi_wifi']
      : ['distancia', 'nivel', 'volume', 'rssi_wifi'];
  if (Object.keys(normalized).some((key) => !['id', 'device_type', 'timestamp', ...fields].includes(key)))
    throw invalid();
  const time = now();
  let timestamp = time;
  if (normalized.timestamp !== undefined) {
    if (
      typeof normalized.timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(normalized.timestamp)
    )
      throw invalid();
    timestamp = Date.parse(normalized.timestamp) / 1000;
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp > time + 60 ||
      timestamp < time - configInt(c.env.READINGS_RETENTION_DAYS, 90, 1, 3650) * 86400
    )
      throw invalid();
  }
  const values = fields.map((field) => {
    const value = normalized[field];
    if (type === 'SM-WA' && field === 'volume' && (value === undefined || value === null)) return null;
    if (
      typeof value !== 'number' &&
      !(typeof value === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()))
    )
      throw invalid();
    const n = Number(value);
    if (!Number.isFinite(n)) throw invalid();
    return n;
  });
  const reading = {
    id,
    ...Object.fromEntries(fields.map((f, i) => [f, values[i]])),
    timestamp: iso(timestamp)!,
  };
  try {
    validateReading(reading as unknown as Reading | SMWAReading, id, type as DeviceType);
  } catch {
    throw invalid();
  }
  const payloadHash = await sha256(JSON.stringify([id, type, normalized.timestamp ?? null, ...values]));
  const suppliedKey = c.request.headers.get('Idempotency-Key');
  if (suppliedKey !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(suppliedKey)) throw invalid();
  // Without event timestamp/key identical payloads stay duplicate for the retention window.
  const eventKey = await sha256(suppliedKey === null ? `payload:${payloadHash}` : `key:${suppliedKey}`);
  const table = type === 'SM-WA' ? 'smwa_readings' : 'smwu_readings';
  const results = await c.env.DB.batch([
    guard(
      c,
      `SELECT 1 FROM devices d JOIN device_credentials cr ON cr.device_id=d.id
   WHERE d.id=? AND d.source='local' AND d.device_type=? AND cr.token_hash=? AND cr.revoked_at IS NULL`,
      id,
      type,
      hash,
    ),
    c.env.DB.prepare(
      `INSERT INTO ${table}(id,reservoir_id,${fields.join(',')},created_at,event_key,payload_hash)
   VALUES (?,(SELECT id FROM reservoirs WHERE device_id=? AND unlinked_at IS NULL),?,?,?,?,?,?,?)
   ON CONFLICT(id,event_key) WHERE event_key IS NOT NULL DO NOTHING RETURNING reading_id,created_at,payload_hash`,
    ).bind(id, id, ...values, timestamp, eventKey, payloadHash),
    c.env.DB.prepare(
      `SELECT reading_id,created_at,payload_hash FROM ${table} WHERE id=? AND event_key=?`,
    ).bind(id, eventKey),
    c.env.DB.prepare(
      `UPDATE devices SET reported_status='online',last_seen=MAX(COALESCE(last_seen,0),?),updated_at=? WHERE id=?
   AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND event_key=? AND payload_hash=?)`,
    ).bind(timestamp, time, id, id, eventKey, payloadHash),
  ]);
  const row = results[2].results[0] as { reading_id: number; created_at: number; payload_hash: string };
  if (row.payload_hash !== payloadHash)
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Chave de idempotência já usada com outra leitura.');
  return json({
    success: true,
    stored: results[1].results.length === 1,
    reading_id: row.reading_id,
    timestamp: iso(row.created_at),
  });
}
function invalid() {
  return new HttpError(422, 'INVALID_TELEMETRY', 'Leitura inválida para o modelo informado.');
}
function unauthorized() {
  return new HttpError(401, 'INVALID_DEVICE_TOKEN', 'Dispositivo não autorizado.');
}
