import type { Context } from '../types';
import { body, HttpError, json, now } from '../http';
import { D1MonitorieGate, MonitorieReadClient } from '../monitorie/protocol';
import { MonitorieAuth } from '../monitorie/auth';
import { auditStatement, guard } from './audit';
import { normalizeMac } from './device-identity';

interface Scan {
  mac: string;
  page: number;
  totalPages: number | null;
  devices: { id: string; type: string }[];
  index: number;
  matches: { id: string; type: string; ts: number }[];
  started: number;
}
const MAX_PAGES = 100;
const MAX_MAC_AGE_MS = 30 * 86400 * 1000;

function matchingMac(value: unknown, mac: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    return normalizeMac(value) === mac;
  } catch {
    return false;
  }
}

/** Each invocation makes at most one provider GET, honoring the global provider gate. */
export async function discoverMonitorie(c: Context, deviceId: number): Promise<Response> {
  await body(c, []);
  const row = await c.env.DB.prepare(
    'SELECT source,mac_address,external_id,device_type FROM devices WHERE id=?',
  )
    .bind(deviceId)
    .first<{ source: string; mac_address: string | null; external_id: string | null; device_type: string }>();
  if (!row) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Dispositivo não encontrado.');
  if (row.source !== 'monitorie' || !row.mac_address)
    throw new HttpError(422, 'MAC_REQUIRED', 'É necessário um equipamento MonitorIE com MAC registrado.');
  if (row.external_id) return json({ success: true, status: 'linked' });

  const key = `monitorie:discovery:${deviceId}`;
  const stored = await c.env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first<{ value: string }>();
  let scan: Scan | null = null;
  if (stored) {
    try {
      scan = JSON.parse(stored.value) as Scan;
    } catch {
      /* Restart corrupt progress. */
    }
  }
  if (!scan || scan.mac !== row.mac_address || scan.started + 86400 < now() || !Array.isArray(scan.devices))
    scan = {
      mac: row.mac_address,
      page: 0,
      totalPages: null,
      devices: [],
      index: 0,
      matches: [],
      started: now(),
    };

  const client = new MonitorieReadClient(new MonitorieAuth(c.env), new D1MonitorieGate(c.env.DB));
  if (scan.totalPages === null || scan.index >= scan.devices.length) {
    if (scan.totalPages !== null && scan.page + 1 >= scan.totalPages) {
      await c.env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
      if (scan.matches.length !== 1)
        return json({
          success: true,
          status: scan.matches.length ? 'ambiguous' : 'unlinked',
          reason: scan.matches.length
            ? 'O MAC apareceu em mais de um dispositivo acessível.'
            : 'O MAC não apareceu na telemetria dos dispositivos acessíveis.',
        });
      const match = scan.matches[0];
      if (match.type !== row.device_type)
        return json({
          success: true,
          status: 'unlinked',
          reason: 'O MAC corresponde a outro modelo na MonitorIE.',
        });
      const id = match.id;
      await c.env.DB.batch([
        guard(
          c,
          'SELECT 1 FROM devices WHERE id=? AND source=? AND mac_address=? AND device_type=? AND external_id IS NULL',
          deviceId,
          'monitorie',
          row.mac_address,
          row.device_type,
        ),
        guard(
          c,
          "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM devices WHERE source='monitorie' AND lower(external_id)=lower(?))",
          id,
        ),
        c.env.DB.prepare(
          'UPDATE devices SET external_id=?,reported_status=?,last_seen=NULL,updated_at=? WHERE id=?',
        ).bind(id, 'offline', now(), deviceId),
        auditStatement(c, 'monitorie_associated_by_mac', deviceId, {
          mac_address: row.mac_address,
          source: 'timeseries.mac',
          observed_at_ms: match.ts,
        }),
      ]);
      return json({
        success: true,
        status: 'linked',
        evidence: 'Telemetria mac idêntica em um único dispositivo acessível do mesmo modelo.',
      });
    }
    if (scan.totalPages !== null) scan.page += 1;
    if (scan.page >= MAX_PAGES)
      throw new HttpError(503, 'MONITORIE_SCAN_LIMIT', 'A lista excede o limite de páginas verificáveis.');
    const listing = await client.devices(scan.page, 100);
    if (listing.totalPages > MAX_PAGES || listing.totalElements > 10000)
      throw new HttpError(
        503,
        'MONITORIE_SCAN_LIMIT',
        'A lista excede o limite de dispositivos verificáveis.',
      );
    scan.totalPages = listing.totalPages;
    scan.devices = listing.data.map((entry) => ({ id: entry.id, type: entry.type }));
    scan.index = 0;
  } else {
    const device = scan.devices[scan.index];
    const point = (await client.latest(device.id, ['mac'])).mac[0];
    if (
      point &&
      point.ts >= Date.now() - MAX_MAC_AGE_MS &&
      matchingMac(point.value, scan.mac) &&
      !scan.matches.some((match) => match.id === device.id)
    )
      scan.matches.push({ id: device.id, type: device.type, ts: point.ts });
    scan.index += 1;
  }
  await c.env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  )
    .bind(key, JSON.stringify(scan), now())
    .run();
  return json({
    success: true,
    status: 'scanning',
    checked: scan.page * 100 + scan.index,
    total: scan.totalPages === null ? null : Math.min(scan.totalPages * 100, 10000),
    next_request_seconds: 70,
  });
}
