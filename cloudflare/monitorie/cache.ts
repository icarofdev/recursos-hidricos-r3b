import type { Context, DeviceType, Reading, ReservoirRow, SMWAReading, Snapshot } from '../types';
import { configInt, HttpError, isLocal, now } from '../http';
import { sha256 } from '../auth/crypto';
import { MonitorieAPI, type MonitorieAdapter, type TelemetryScope } from './adapter';
import { MockMonitorie } from './mock';

function adapter(c: Context, row: ReservoirRow): MonitorieAdapter {
 if (row.source === 'mock') {
  if (!isLocal(c) || c.env.MONITORIE_MODE !== 'mock') throw new HttpError(503, 'MOCK_DISABLED', 'Dados de demonstração indisponíveis neste ambiente.');
  return new MockMonitorie();
 }
 return new MonitorieAPI(c.env);
}
function scope(c: Context, row: ReservoirRow): TelemetryScope {
 return {deviceId: row.device_id, deviceType: row.device_type, externalId: row.external_id ?? '', linkedAt: row.linked_at,
  offlineAfterSeconds: configInt(c.env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400)};
}
async function cached<T>(c: Context, row: ReservoirRow, operation: string, producer: () => Promise<T>): Promise<T> {
 const seconds = configInt(c.env.MONITORIE_CACHE_SECONDS, 60, 15, 3600);
 // O chamador precisa autorizar o reservatório ANTES do cache. Nunca guardar cookies.
 const id = await sha256(JSON.stringify([row.user_id, row.id, row.device_id, row.source, row.external_id, row.linked_at,
  c.env.MONITORIE_MODE, c.env.MONITORIE_BASE_URL, operation]));
 const key = new Request(`${c.url.origin}/__telemetry-cache/${id}`);
 const cache = caches.default;
 const hit = await cache.match(key);
 if (hit) {
  const entry = await hit.json<{data?: T; error?: boolean}>();
  if (entry.error) throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'Telemetria temporariamente indisponível. Tente novamente em instantes.');
  return entry.data!;
 }
 try {
  const data = await producer();
  await cache.put(key, Response.json({data}, {headers: {'Cache-Control': `public, max-age=${seconds}`}}));
  return data;
 } catch (error) {
  // Curto cache negativo evita insistir no provedor durante indisponibilidade.
  await cache.put(key, Response.json({error: true}, {headers: {'Cache-Control': 'public, max-age=15'}}));
  if (error instanceof HttpError) throw error;
  throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'Telemetria temporariamente indisponível. Tente novamente em instantes.');
 }
}
export async function remoteSnapshot(c: Context, row: ReservoirRow): Promise<Snapshot> {
 const target = scope(c, row);
 return cached(c, row, 'snapshot', async () => {
  const result = await adapter(c, row).snapshot(target);
  if (!result || result.device?.id !== row.device_id || !['online', 'offline'].includes(result.device.status)
   || (result.device.last_seen !== null && !Number.isFinite(Date.parse(result.device.last_seen)))) throw invalidData();
  if (result.data) {
   validateReading(result.data, row.device_id, row.device_type);
   if (Date.parse(result.data.timestamp) < row.linked_at * 1000) result.data = null;
  }
  return result;
 });
}
export async function remoteHistory(c: Context, row: ReservoirRow, hours: number, limit: number): Promise<(Reading | SMWAReading)[]> {
 // Janela arredondada estabiliza chave; filtro final aplica o limite exato do pedido.
 const since = now() - hours * 3600;
 const seconds = configInt(c.env.MONITORIE_CACHE_SECONDS, 60, 15, 3600);
 const bucket = Math.floor(since / seconds) * seconds;
 const data = await cached(c, row, `history:${hours}:${limit}:${bucket}`, async () => {
  const records = await adapter(c, row).history(scope(c, row), Math.max(bucket, row.linked_at), limit);
  if (!Array.isArray(records) || records.length > 2000) throw invalidData();
  records.forEach(record => validateReading(record, row.device_id, row.device_type));
  return records;
 });
 return data.filter(record => Date.parse(record.timestamp) >= Math.max(since, row.linked_at) * 1000)
  .sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-limit);
}
export function validateReading(row: Reading | SMWAReading, id: number, deviceType: DeviceType = 'SM-WU'): void {
 if (!row || row.id !== id || !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) > Date.now() + 60000) throw invalidData();
 if (deviceType === 'SM-WA' || 'vazao' in row) {
  const wa = row as SMWAReading;
  for (const val of [wa.vazao, wa.consumo_acumulado]) {
   if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) throw invalidData();
  }
  if (wa.volume !== null && wa.volume !== undefined && (typeof wa.volume !== 'number' || !Number.isFinite(wa.volume) || wa.volume < 0)) throw invalidData();
  if (typeof wa.rssi_wifi !== 'number' || !Number.isFinite(wa.rssi_wifi) || wa.rssi_wifi < -200 || wa.rssi_wifi > 0) throw invalidData();
 } else {
  const wu = row as Reading;
  for (const [field, min, max] of [['distancia',0,1000000], ['nivel',0,100], ['volume',0,1e12], ['rssi_wifi',-200,0]] as const) {
   if (typeof wu[field] !== 'number' || !Number.isFinite(wu[field]) || wu[field] < min || wu[field] > max) throw invalidData();
  }
 }
}
function invalidData() { return new HttpError(503, 'MONITORIE_INVALID_DATA', 'O provedor retornou dados indisponíveis para exibição.'); }
