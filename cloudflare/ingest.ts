import type { Context, DeviceType, Reading, SMWAReading } from './types';
import { body, configInt, HttpError, iso, json, method, now, positiveId } from './http';
import { randomToken, sha256 } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { validateReading } from './monitorie/cache';
import { guard } from './admin/audit';
import { calculateVolume } from './reservoir-volume';
import type { ReservoirRow } from './types';

/** Internal direct-ingestion contract. This is NOT a MonitorIE payload mapping. */
export async function ingest(c: Context): Promise<Response> {
  method(c, ['POST']);
  if (c.env.INGEST_ENABLED !== 'true')
    throw new HttpError(503, 'INGEST_DISABLED', 'Ingestão direta desativada.');
  if (c.url.protocol !== 'https:' && c.env.APP_ENV !== 'development')
    throw new HttpError(400, 'HTTPS_REQUIRED', 'Use HTTPS.');
  await rateLimit(c, 'ingest-ip', clientIP(c), 120, 60);
  const input = await body(c);
  const normalized: Record<string, unknown> = Object.create(null);
  const aliases: Record<string, string> = {
    d: 'distancia',
    distance: 'distancia',
    level: 'nivel',
    volume_litros: 'volume',
    volume_liters: 'volume',
  };
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase().trim();
    const canonical = Object.hasOwn(aliases, name) ? aliases[name] : name;
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
    `SELECT d.device_type,d.source,d.ownership_generation FROM devices d JOIN device_credentials cr ON cr.device_id=d.id
 WHERE d.id=? AND cr.token_hash=? AND cr.revoked_at IS NULL AND cr.ownership_generation=d.ownership_generation`,
  )
    .bind(id, hash)
    .first<{ device_type: DeviceType; source: string; ownership_generation: number }>();
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
  const config = await c.env.DB.prepare(
    'SELECT id,geometry,measurement_config,capacity_liters,linked_at,linked_at_ms,updated_at FROM reservoirs WHERE device_id=? AND unlinked_at IS NULL',
  )
    .bind(id)
    .first<ReservoirRow>();
  let quality = 'reported';
  if (type === 'SM-WU') {
    if (config && config.geometry !== 'reported') {
      const distance = normalized.distancia;
      if (
        typeof distance !== 'number' &&
        !(typeof distance === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(distance.trim()))
      )
        throw invalid();
      const calculated = calculateVolume(config, Number(distance));
      normalized.nivel = calculated.nivel;
      normalized.volume = calculated.volume;
      quality = calculated.measurement_quality;
    }
  }
  const time = now();
  let timestamp = Date.now() / 1000;
  if (normalized.timestamp !== undefined) {
    if (
      typeof normalized.timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(normalized.timestamp)
    )
      throw invalid();
    timestamp = Date.parse(normalized.timestamp) / 1000;
    if (
      !Number.isSafeInteger(Math.round(timestamp * 1000)) ||
      timestamp > time + 60 ||
      timestamp < time - configInt(c.env.READINGS_RETENTION_DAYS, 90, 1, 3650) * 86400
    )
      throw invalid();
  }
  if (config && Math.round(timestamp * 1000) < config.linked_at_ms)
    throw new HttpError(422, 'EVENT_BEFORE_LINK', 'A leitura é anterior ao vínculo atual.');
  const values = fields.map((field) => {
    const value = normalized[field];
    if (type === 'SM-WA' && field === 'volume' && (value === undefined || value === null)) return null;
    if (type === 'SM-WU' && quality !== 'reported' && value === null && ['nivel', 'volume'].includes(field))
      return null;
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
    measurement_quality: quality,
  };
  try {
    validateReading(reading as unknown as Reading | SMWAReading, id, type as DeviceType);
  } catch {
    throw invalid();
  }
  const payloadHash = await sha256(
    JSON.stringify([
      id,
      device.ownership_generation,
      type,
      normalized.timestamp === undefined ? null : Math.round(timestamp * 1000),
      ...values,
    ]),
  );
  const suppliedKey = c.request.headers.get('Idempotency-Key');
  if (suppliedKey !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(suppliedKey)) throw invalid();
  // Without an event identity there is no evidence of retransmission: equal values are new measurements.
  const eventKey = await sha256(
    `${device.ownership_generation}:` +
      (suppliedKey !== null
        ? `key:${suppliedKey}`
        : normalized.timestamp !== undefined
          ? `payload:${payloadHash}`
          : `event:${randomToken()}`),
  );
  const table = type === 'SM-WA' ? 'smwa_readings' : 'smwu_readings';
  const results = await c.env.DB.batch([
    guard(
      c,
      `SELECT 1 FROM devices d JOIN device_credentials cr ON cr.device_id=d.id
   WHERE d.id=? AND d.source='local' AND d.device_type=? AND cr.token_hash=? AND cr.revoked_at IS NULL
   AND cr.ownership_generation=d.ownership_generation AND d.ownership_generation=?`,
      id,
      type,
      hash,
      device.ownership_generation,
    ),
    ...(config
      ? [
          guard(
            c,
            'SELECT 1 FROM reservoirs WHERE id=? AND device_id=? AND unlinked_at IS NULL AND linked_at_ms<=? AND updated_at=? AND geometry=? AND capacity_liters IS ? AND measurement_config IS ?',
            config.id,
            id,
            Math.round(timestamp * 1000),
            config.updated_at,
            config.geometry,
            config.capacity_liters,
            config.measurement_config,
          ),
        ]
      : [
          guard(
            c,
            'SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM reservoirs WHERE device_id=? AND unlinked_at IS NULL)',
            id,
          ),
        ]),
    c.env.DB.prepare(
      `INSERT INTO ${table}(id,reservoir_id,${fields.join(',')},created_at,event_key,payload_hash${type === 'SM-WU' ? ',measurement_quality' : ''})
   VALUES (?,(SELECT id FROM reservoirs WHERE device_id=? AND unlinked_at IS NULL),${Array(
     fields.length + 3 + Number(type === 'SM-WU'),
   )
     .fill('?')
     .join(',')})
   ON CONFLICT(id,event_key) WHERE event_key IS NOT NULL DO NOTHING RETURNING reading_id,created_at,payload_hash`,
    ).bind(id, id, ...values, timestamp, eventKey, payloadHash, ...(type === 'SM-WU' ? [quality] : [])),
    c.env.DB.prepare(
      `SELECT reading_id,created_at,payload_hash FROM ${table} WHERE id=? AND event_key=?`,
    ).bind(id, eventKey),
    c.env.DB.prepare(
      `UPDATE devices SET reported_status='online',last_seen=MAX(COALESCE(last_seen,0),?),updated_at=? WHERE id=?
   AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND event_key=? AND payload_hash=?)`,
    ).bind(Math.min(timestamp, Date.now() / 1000), time, id, id, eventKey, payloadHash),
  ]);
  const row = results[3].results[0] as { reading_id: number; created_at: number; payload_hash: string };
  if (row.payload_hash !== payloadHash)
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Chave de idempotência já usada com outra leitura.');
  return json({
    success: true,
    stored: results[2].results.length === 1,
    reading_id: row.reading_id,
    timestamp: iso(row.created_at),
    measurement_quality: quality,
  });
}
function invalid() {
  return new HttpError(422, 'INVALID_TELEMETRY', 'Leitura inválida para o modelo informado.');
}
function unauthorized() {
  return new HttpError(401, 'INVALID_DEVICE_TOKEN', 'Dispositivo não autorizado.');
}
