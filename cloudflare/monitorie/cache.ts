import { cachedTelemetry } from './single-flight';
import type { Context, DeviceType, Reading, ReservoirRow, SMWAReading, Snapshot } from '../types';
import { configInt, HttpError, isLocal, now } from '../http';
import { sha256 } from '../auth/crypto';
import { MonitorieAPI, type MonitorieAdapter, type TelemetryHistory, type TelemetryScope } from './adapter';
import { MockMonitorie } from './mock';
import { MonitorieAuth } from './auth';
import { D1MonitorieGate, MonitorieReadClient } from './protocol';

function adapter(c: Context, row: ReservoirRow): MonitorieAdapter {
  if (row.source === 'mock') {
    if (!isLocal(c) || c.env.MONITORIE_MODE !== 'mock')
      throw new HttpError(503, 'MOCK_DISABLED', 'Dados de demonstração indisponíveis neste ambiente.');
    return new MockMonitorie();
  }
  return new MonitorieAPI(
    c.env,
    new MonitorieReadClient(new MonitorieAuth(c.env), new D1MonitorieGate(c.env.DB, row.device_id)),
  );
}
function scope(c: Context, row: ReservoirRow): TelemetryScope {
  return {
    deviceId: row.device_id,
    deviceType: row.device_type,
    externalId: row.external_id ?? '',
    linkedAt: row.linked_at_ms / 1000,
    offlineAfterSeconds: configInt(c.env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400),
  };
}
async function cached<T>(
  c: Context,
  row: ReservoirRow,
  operation: string,
  producer: () => Promise<T>,
): Promise<T> {
  const id = await sha256(
    JSON.stringify([
      row.user_id,
      row.id,
      row.device_id,
      row.device_type,
      row.source,
      row.external_id,
      row.linked_at_ms,
      row.ownership_generation,
      c.env.MONITORIE_MODE,
      c.env.MONITORIE_SMWU_MAPPING,
      c.env.MONITORIE_SMWA_MAPPING,
      c.env.DEVICE_OFFLINE_AFTER_SECONDS,
      operation,
    ]),
  );
  // Cache belongs to the current ownership, not an individual member. Every
  // response still applies that member's access boundary and rechecks access.
  return cachedTelemetry(c, id, producer, { device_id: row.device_id, access_user_id: null });
}

export async function remoteSnapshot(c: Context, row: ReservoirRow): Promise<Snapshot> {
  const target = scope(c, row);
  const result = await cached(c, row, 'snapshot', async () => {
    const result = await adapter(c, row).snapshot(target);
    if (
      !result ||
      result.device?.id !== row.device_id ||
      !['online', 'offline'].includes(result.device.status) ||
      (result.device.last_seen !== null && !Number.isFinite(Date.parse(result.device.last_seen)))
    )
      throw invalidData();
    if (result.data) {
      validateReading(result.data, row.device_id, row.device_type);
    }
    const observed = result.device.last_seen ? Date.parse(result.device.last_seen) / 1000 : null;
    const allowed = observed !== null && Math.round(observed * 1000) >= row.linked_at_ms;
    await c.env.DB.prepare(
      'UPDATE devices SET reported_status=?,last_seen=CASE WHEN ? IS NULL THEN last_seen ELSE MAX(COALESCE(last_seen,0),?) END,communication_checked_at=? WHERE id=? AND ownership_generation=? AND external_id IS ?',
    )
      .bind(
        result.device.status === 'online' ? 'online' : 'offline',
        allowed ? observed : null,
        allowed ? observed : null,
        now(),
        row.device_id,
        row.ownership_generation,
        row.external_id,
      )
      .run();
    return result;
  });
  // Also filter cache hits. Durable device generation survives account erasure.
  if (result.data && Date.parse(result.data.timestamp) < Math.round(row.linked_at * 1000)) result.data = null;
  if (result.device.last_seen && Date.parse(result.device.last_seen) < Math.round(row.linked_at * 1000)) {
    result.device.last_seen = null;
    result.device.status = 'unknown';
  }
  return result;
}
export async function remoteHistory(
  c: Context,
  row: ReservoirRow,
  hours: number,
  limit: number,
): Promise<TelemetryHistory> {
  // Janela arredondada estabiliza chave; filtro final aplica o limite exato do pedido.
  const since = now() - hours * 3600;
  const normalizedHours = [1, 6, 12, 24, 72, 168, 720].find((value) => value >= hours)!;
  const seconds = configInt(c.env.MONITORIE_CACHE_SECONDS, 60, 60, 3600);
  const bucket = Math.floor((now() - normalizedHours * 3600) / seconds) * seconds;
  const result = await cached(c, row, `history:v2:${normalizedHours}:2000:${bucket}`, async () => {
    const result = await adapter(c, row).historyWithMetadata(
      scope(c, row),
      Math.max(bucket, row.linked_at_ms / 1000),
      2000,
    );
    if (
      !Array.isArray(result.data) ||
      result.data.length > 2000 ||
      typeof result.possiblyTruncated !== 'boolean'
    )
      throw invalidData();
    result.data.forEach((record) => validateReading(record, row.device_id, row.device_type));
    return result;
  });
  const data = result.data
    .filter((record) => Date.parse(record.timestamp) >= Math.max(since, row.linked_at) * 1000)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return { data: data.slice(-limit), possiblyTruncated: result.possiblyTruncated || data.length > limit };
}
export function validateReading(
  row: Reading | SMWAReading,
  id: number,
  deviceType: DeviceType = 'SM-WU',
): void {
  if (
    !row ||
    row.id !== id ||
    !Number.isFinite(Date.parse(row.timestamp)) ||
    Date.parse(row.timestamp) > Date.now() + 60000
  )
    throw invalidData();
  if (deviceType === 'SM-WA') {
    const wa = row as SMWAReading;
    for (const val of [wa.vazao, wa.consumo_acumulado]) {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) throw invalidData();
    }
    if (
      wa.volume !== null &&
      wa.volume !== undefined &&
      (typeof wa.volume !== 'number' || !Number.isFinite(wa.volume) || wa.volume < 0)
    )
      throw invalidData();
    if (
      typeof wa.rssi_wifi !== 'number' ||
      !Number.isFinite(wa.rssi_wifi) ||
      wa.rssi_wifi < -200 ||
      wa.rssi_wifi > 0
    )
      throw invalidData();
  } else {
    const wu = row as Reading;
    for (const [field, min, max] of [
      ['distancia', 0, 1000000],
      ['nivel', 0, 100],
      ['volume', 0, 1e12],
      ['rssi_wifi', -200, 0],
    ] as const) {
      if (
        wu[field] === null &&
        ['nivel', 'volume'].includes(field) &&
        ['out_of_range', 'configuration_missing', 'missing'].includes(wu.measurement_quality ?? '')
      )
        continue;
      if (
        typeof wu[field] !== 'number' ||
        !Number.isFinite(wu[field]) ||
        wu[field]! < min ||
        wu[field]! > max
      )
        throw invalidData();
    }
  }
}
function invalidData() {
  return new HttpError(
    503,
    'MONITORIE_INVALID_DATA',
    'O provedor retornou dados indisponíveis para exibição.',
  );
}
