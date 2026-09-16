import type { Context, Reading, ReservoirRow, SMWAReading, Snapshot } from './types';
import { body, configInt, HttpError, iso, json, method, now, positiveId, queryInt } from './http';
import { equal } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { requireUser } from './auth/sessions';
import { owned, present } from './db/reservoirs';
import { remoteHistory, remoteSnapshot, validateReading } from './monitorie/cache';

type LocalReading = Omit<Reading, 'timestamp'> & {created_at: number};
type LocalSMWAReading = Omit<SMWAReading, 'timestamp'> & {created_at: number};

const fromLocal = (row: LocalReading): Reading => ({id: row.id, distancia: row.distancia, nivel: row.nivel, volume: row.volume, rssi_wifi: row.rssi_wifi, timestamp: iso(row.created_at)!});
const fromLocalWA = (row: LocalSMWAReading): SMWAReading => ({id: row.id, vazao: row.vazao, consumo_acumulado: row.consumo_acumulado, volume: row.volume, rssi_wifi: row.rssi_wifi, timestamp: iso(row.created_at)!});

async function snapshot(c: Context, row: ReservoirRow): Promise<Snapshot> {
 let result: Snapshot;
 if (row.source !== 'local') result = await remoteSnapshot(c, row);
 else if (row.device_type === 'SM-WA') {
  const reading = await c.env.DB.prepare('SELECT * FROM smwa_readings WHERE reservoir_id=? ORDER BY created_at DESC,reading_id DESC LIMIT 1').bind(row.id).first<LocalSMWAReading>();
  result = {device: present(c,row).device as Snapshot['device'], data: reading ? fromLocalWA(reading) : null};
 } else {
  const reading = await c.env.DB.prepare('SELECT * FROM smwu_readings WHERE reservoir_id=? ORDER BY created_at DESC,reading_id DESC LIMIT 1').bind(row.id).first<LocalReading>();
  result = {device: present(c,row).device as Snapshot['device'], data: reading ? fromLocal(reading) : null};
 }
 // O tempo de cache nunca transforma uma leitura antiga em dispositivo online.
 const age = result.device.last_seen === null ? Infinity : now() - Date.parse(result.device.last_seen) / 1000;
 if (age >= result.device.offline_after_seconds) result.device.status = 'offline';
 return result;
}

function alerts(value: Snapshot, row: ReservoirRow) {
 const data: {type: string; message: string; timestamp: string | null; id: number}[] = [];
 if (value.device.status === 'offline') data.push({type: 'critical', message: 'Dispositivo sem comunicação dentro do limite configurado.', timestamp: value.device.last_seen, id: value.device.id});
 if (row.device_type === 'SM-WU' && value.data && 'nivel' in value.data && typeof value.data.nivel === 'number' && value.data.nivel < 40) {
  data.push({type: value.data.nivel < 20 ? 'critical' : 'warning', message: `Nível ${value.data.nivel < 20 ? 'crítico' : 'baixo'} do reservatório: ${value.data.nivel.toFixed(2)}%.`, timestamp: value.data.timestamp, id: value.data.id});
 }
 return data;
}

export async function telemetryRoute(c: Context, route: string): Promise<Response> {
 if (route === 'ingest') return ingest(c);
 method(c, ['GET']);
 requireUser(c);
 const row = await owned(c, positiveId(c.url.searchParams.get('reservoir_id')));
 if (route === 'history') {
  const hours = queryInt(c, 'hours', 24, 1, 720); const limit = queryInt(c, 'limit', 500, 1, 2000);
  let data: (Reading | SMWAReading)[];
  if (row.source === 'local') {
   if (row.device_type === 'SM-WA') {
    const records = await c.env.DB.prepare('SELECT * FROM smwa_readings WHERE reservoir_id=? AND created_at>=? ORDER BY created_at DESC,reading_id DESC LIMIT ?').bind(row.id, now() - hours * 3600, limit).all<LocalSMWAReading>();
    data = records.results.reverse().map(fromLocalWA);
   } else {
    const records = await c.env.DB.prepare('SELECT * FROM smwu_readings WHERE reservoir_id=? AND created_at>=? ORDER BY created_at DESC,reading_id DESC LIMIT ?').bind(row.id, now() - hours * 3600, limit).all<LocalReading>();
    data = records.results.reverse().map(fromLocal);
   }
  } else data = await remoteHistory(c, row, hours, limit);
  return json({success: true, reservoir_id: row.id, id: row.device_id, device_type: row.device_type, count: data.length, data});
 }
 const value = await snapshot(c, row);
 if (route === 'snapshot') return json({success: true, reservoir: present(c,row), ...value, alerts: alerts(value, row)});
 if (route === 'status') return json({success: true, reservoir_id: row.id, device: value.device});
 if (route === 'alerts') { const data = alerts(value, row); return json({success: true, reservoir_id: row.id, count: data.length, data}); }
 if (route === 'current') {
  if (!value.data) throw new HttpError(404, 'NO_DATA', 'Nenhuma leitura recebida para este reservatório.');
  return json({success: true, reservoir: present(c,row), ...value});
 }
 throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}

async function ingest(c: Context): Promise<Response> {
 method(c, ['POST']);
 if (c.env.INGEST_ENABLED !== 'true') throw new HttpError(503, 'INGEST_DISABLED', 'Ingestão direta desativada.');
 if (c.url.protocol !== 'https:' && c.env.APP_ENV !== 'development') throw new HttpError(400, 'HTTPS_REQUIRED', 'Use HTTPS.');
 await rateLimit(c, 'ingest-ip', clientIP(c), 120, 60);
 const input = await body(c); const normalized: Record<string, unknown> = {};
 const aliases: Record<string,string> = {d:'distancia', distance:'distancia', level:'nivel', volume_litros:'volume', volume_liters:'volume'};
 for (const [key, value] of Object.entries(input)) {
  const canonical = aliases[key.toLowerCase().trim()] ?? key.toLowerCase().trim();
  if (!['id','distancia','nivel','volume','rssi_wifi'].includes(canonical) || Object.hasOwn(normalized,canonical)) throw new HttpError(422, 'INVALID_TELEMETRY', 'Campo desconhecido ou duplicado.');
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()))) throw new HttpError(422,'INVALID_TELEMETRY','Valor numérico inválido.');
  normalized[canonical] = Number(value);
 }
 const id = positiveId(normalized.id);
 const token = c.request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1] ?? c.request.headers.get('X-Device-Token') ?? '';
 let tokens: Record<string, string> = {};
 try { tokens = JSON.parse(c.env.DEVICE_TOKENS ?? '{}'); } catch { /* falhar fechado */ }
 if (!token || typeof tokens[id] !== 'string' || tokens[id].length < 32 || !equal(tokens[id], token)) throw new HttpError(401, 'INVALID_DEVICE_TOKEN', 'Dispositivo não autorizado.');
 const time = now();
 const reading = {...normalized, timestamp: iso(time)!} as unknown as Reading;
 try { validateReading(reading, id); } catch { throw new HttpError(422, 'INVALID_TELEMETRY', 'Leitura fora da faixa permitida.'); }
 const device = await c.env.DB.prepare('SELECT source FROM devices WHERE id=?').bind(id).first<{source: string}>();
 if (device && device.source !== 'local') throw new HttpError(409, 'DEVICE_SOURCE_CONFLICT', 'Dispositivo usa outra fonte de telemetria.');
 await c.env.DB.batch([
  c.env.DB.prepare(`INSERT INTO devices(id,device_code,source,reported_status,last_seen,created_at,updated_at) VALUES (?,?,'local','online',?,?,?)
   ON CONFLICT(id) DO UPDATE SET reported_status='online',last_seen=excluded.last_seen,updated_at=excluded.updated_at WHERE devices.source='local'`)
   .bind(id, `HIDRA-R3B-${String(id).padStart(6,'0')}`, time,time,time),
  c.env.DB.prepare(`INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at)
   SELECT ?, (SELECT id FROM reservoirs WHERE device_id=? AND unlinked_at IS NULL),?,?,?,?,?
   WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND source='local')
   AND NOT EXISTS(SELECT 1 FROM smwu_readings WHERE id=? AND created_at>=? AND distancia=? AND nivel=? AND volume=? LIMIT 1)`)
   .bind(id,id,reading.distancia,reading.nivel,reading.volume,reading.rssi_wifi,time,id,id,time-5,reading.distancia,reading.nivel,reading.volume)
 ]);
 return json({success: true, stored: true, reading_id: id, timestamp: reading.timestamp});
}
