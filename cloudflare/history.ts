import type { Context, ReservoirRow } from './types';
import { iso, json, now, queryInt } from './http';
import { remoteHistory } from './monitorie/cache';
import { telemetryUnits } from './units';

export async function history(c: Context, row: ReservoirRow): Promise<Response> {
  const hours = queryInt(c, 'hours', 24, 1, 720),
    limit = queryInt(c, 'limit', 500, 1, 2000);
  const end = now(),
    start = Math.max(end - hours * 3600, row.linked_at);
  let data: Record<string, unknown>[];
  let resolution = 0;
  let total = 0;
  if (row.source === 'local') {
    const table = row.device_type === 'SM-WA' ? 'smwa_readings' : 'smwu_readings';
    const stats = await c.env.DB.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ?`,
    )
      .bind(row.id, start, end)
      .first<{ n: number }>();
    total = stats?.n ?? 0;
    const fields =
      row.device_type === 'SM-WA'
        ? ['vazao', 'consumo_acumulado', 'volume', 'rssi_wifi']
        : ['distancia', 'nivel', 'volume', 'rssi_wifi'];
    // All rows in the requested window participate, never just the newest LIMIT.
    resolution = total > limit ? Math.max(1, Math.ceil((end - start + 1) / limit)) : 0;
    const query = resolution
      ? `SELECT id,MIN(created_at) created_at,COUNT(*) sample_count,${fields.map((f) => `AVG(${f}) ${f}`).join(',')}
      FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ? GROUP BY CAST((created_at-?)/? AS INTEGER) ORDER BY created_at`
      : `SELECT * FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at,reading_id`;
    const stmt = c.env.DB.prepare(query);
    const rows = await (
      resolution ? stmt.bind(row.id, start, end, start, resolution) : stmt.bind(row.id, start, end)
    ).all<Record<string, unknown>>();
    data = rows.results.map((r) => ({
      id: r.id,
      ...Object.fromEntries(fields.map((f) => [f, r[f]])),
      timestamp: iso(Number(r.created_at)),
      sample_count: r.sample_count ?? 1,
    }));
  } else {
    data = (await remoteHistory(c, row, hours, limit)).map((r) => ({ ...r }));
    total = data.length;
    resolution = row.source === 'mock' ? Math.max(60, Math.ceil((end - start) / Math.max(1, limit - 1))) : 0;
  }
  const truncated = row.source === 'monitorie' && data.length >= limit;
  return json({
    success: true,
    reservoir_id: row.id,
    id: row.device_id,
    device_type: row.device_type,
    count: data.length,
    data,
    units: telemetryUnits(row.source, row.device_type, c.env),
    meta: {
      requested_window: { start: iso(end - hours * 3600), end: iso(end) },
      effective_window: { start: iso(start), end: iso(end) },
      data_window: { start: data[0]?.timestamp ?? null, end: data.at(-1)?.timestamp ?? null },
      resolution_seconds: resolution,
      aggregation: resolution ? (row.source === 'mock' ? 'simulation' : 'mean') : 'none',
      truncated,
      total_readings: total,
    },
  });
}
