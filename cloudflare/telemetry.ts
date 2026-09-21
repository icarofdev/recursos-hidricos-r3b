import { ingest } from './ingest';
import { history } from './history';
import { telemetryUnits } from './units';
import type { Context, Reading, ReservoirRow, SMWAReading, Snapshot } from './types';
import { body, configInt, HttpError, iso, json, method, now, positiveId, queryInt } from './http';
import { equal } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { requireUser } from './auth/sessions';
import { owned, present } from './db/reservoirs';
import { remoteHistory, remoteSnapshot, validateReading } from './monitorie/cache';

type LocalReading = Omit<Reading, 'timestamp'> & { created_at: number };
type LocalSMWAReading = Omit<SMWAReading, 'timestamp'> & { created_at: number };

const fromLocal = (row: LocalReading): Reading => ({
  id: row.id,
  distancia: row.distancia,
  nivel: row.nivel,
  volume: row.volume,
  rssi_wifi: row.rssi_wifi,
  timestamp: iso(row.created_at)!,
});
const fromLocalWA = (row: LocalSMWAReading): SMWAReading => ({
  id: row.id,
  vazao: row.vazao,
  consumo_acumulado: row.consumo_acumulado,
  volume: row.volume,
  rssi_wifi: row.rssi_wifi,
  timestamp: iso(row.created_at)!,
});

async function snapshot(c: Context, row: ReservoirRow): Promise<Snapshot> {
  let result: Snapshot;
  if (row.source !== 'local') result = await remoteSnapshot(c, row);
  else if (row.device_type === 'SM-WA') {
    const reading = await c.env.DB.prepare(
      'SELECT * FROM smwa_readings WHERE reservoir_id=? ORDER BY created_at DESC,reading_id DESC LIMIT 1',
    )
      .bind(row.id)
      .first<LocalSMWAReading>();
    result = {
      device: present(c, row).device as Snapshot['device'],
      data: reading ? fromLocalWA(reading) : null,
    };
  } else {
    const reading = await c.env.DB.prepare(
      'SELECT * FROM smwu_readings WHERE reservoir_id=? ORDER BY created_at DESC,reading_id DESC LIMIT 1',
    )
      .bind(row.id)
      .first<LocalReading>();
    result = {
      device: present(c, row).device as Snapshot['device'],
      data: reading ? fromLocal(reading) : null,
    };
  }
  // O tempo de cache nunca transforma uma leitura antiga em dispositivo online.
  const age =
    result.device.last_seen === null ? Infinity : now() - Date.parse(result.device.last_seen) / 1000;
  if (age >= result.device.offline_after_seconds) result.device.status = 'offline';
  result.units = telemetryUnits(row.source, row.device_type);
  return result;
}

function alerts(value: Snapshot, row: ReservoirRow) {
  const data: { type: string; message: string; timestamp: string | null; id: number }[] = [];
  if (value.device.status === 'offline')
    data.push({
      type: 'critical',
      message: 'Dispositivo sem comunicação dentro do limite configurado.',
      timestamp: value.device.last_seen,
      id: value.device.id,
    });
  if (
    row.device_type === 'SM-WU' &&
    value.data &&
    'nivel' in value.data &&
    typeof value.data.nivel === 'number' &&
    value.data.nivel < 40
  ) {
    data.push({
      type: value.data.nivel < 20 ? 'critical' : 'warning',
      message: `Nível ${value.data.nivel < 20 ? 'crítico' : 'baixo'} do reservatório: ${value.data.nivel.toFixed(2)}%.`,
      timestamp: value.data.timestamp,
      id: value.data.id,
    });
  }
  return data;
}

export async function telemetryRoute(c: Context, route: string): Promise<Response> {
  if (route === 'ingest') return ingest(c);
  method(c, ['GET']);
  requireUser(c);
  const row = await owned(c, positiveId(c.url.searchParams.get('reservoir_id')));
  if (route === 'history') return history(c, row);
  const value = await snapshot(c, row);
  if (route === 'snapshot')
    return json({ success: true, reservoir: present(c, row), ...value, alerts: alerts(value, row) });
  if (route === 'status') return json({ success: true, reservoir_id: row.id, device: value.device });
  if (route === 'alerts') {
    const data = alerts(value, row);
    return json({ success: true, reservoir_id: row.id, count: data.length, data });
  }
  if (route === 'current') {
    if (!value.data) throw new HttpError(404, 'NO_DATA', 'Nenhuma leitura recebida para este reservatório.');
    return json({ success: true, reservoir: present(c, row), ...value });
  }
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
