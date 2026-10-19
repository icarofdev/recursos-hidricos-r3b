import type { Context, ReservoirRow } from './types';
import { configInt, HttpError, iso, json, now, queryInt } from './http';
import { assertCurrentAccess } from './db/reservoirs';
import { remoteHistory } from './monitorie/cache';
import { telemetryUnits } from './units';
import { configuredReading } from './reservoir-volume';

export async function history(c: Context, row: ReservoirRow): Promise<Response> {
  const hours = queryInt(c, 'hours', 24, 1, 720),
    limit = queryInt(c, 'limit', 500, 1, 2000);
  const end = Date.now() / 1000,
    start = Math.max(end - hours * 3600, row.linked_at);
  let data: Record<string, unknown>[];
  let resolution = 0;
  let total = 0;
  let possiblyTruncated = false;
  if (row.source === 'local') {
    const table = row.device_type === 'SM-WA' ? 'smwa_readings' : 'smwu_readings';
    const maxSamples = configInt(c.env.HISTORY_MAX_SAMPLES, 10000, 500, 20000);
    const stats = await c.env.DB.prepare(
      `SELECT COUNT(*) n FROM (SELECT 1 FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ? LIMIT ?)`,
    )
      .bind(row.id, start, end, maxSamples + 1)
      .first<{ n: number }>();
    total = stats?.n ?? 0;
    if (total > maxSamples)
      throw new HttpError(
        422,
        'HISTORY_WORK_LIMIT',
        'Reduza a janela do histórico para consultar este volume de leituras.',
      );
    const fields =
      row.device_type === 'SM-WA'
        ? ['vazao', 'consumo_acumulado', 'volume', 'rssi_wifi']
        : ['distancia', 'nivel', 'volume', 'rssi_wifi'];
    // All rows in the requested window participate, never just the newest LIMIT.
    resolution = total > limit ? Math.max(1, Math.ceil((end - start + 1) / limit)) : 0;
    if (row.device_type === 'SM-WU' && row.geometry !== 'reported') {
      // Nonlinear conversion happens per sample BEFORE averaging buckets.
      const buckets = new Map<
        number,
        {
          timestamp: number;
          count: number;
          sums: Record<string, number>;
          counts: Record<string, number>;
          withinTolerance: boolean;
        }
      >();
      data = [];
      let cursorTime = start,
        cursorId = 0;
      for (let pageNumber = 0; pageNumber < Math.ceil(maxSamples / 500) + 1; pageNumber++) {
        const page = await c.env.DB.prepare(
          'SELECT reading_id,id,distancia,nivel,volume,rssi_wifi,created_at,measurement_quality FROM smwu_readings WHERE reservoir_id=? AND created_at BETWEEN ? AND ? AND (created_at>? OR (created_at=? AND reading_id>?)) ORDER BY created_at,reading_id LIMIT 500',
        )
          .bind(row.id, start, end, cursorTime, cursorTime, cursorId)
          .all<Record<string, unknown>>();
        for (const raw of page.results) {
          const converted = configuredReading<Record<string, unknown>>(row, {
            id: Number(raw.id),
            distancia: raw.distancia,
            nivel: raw.nivel,
            volume: raw.volume,
            rssi_wifi: raw.rssi_wifi,
            measurement_quality: raw.measurement_quality,
          });
          if (!resolution)
            data.push({ ...converted, timestamp: iso(Number(raw.created_at)), sample_count: 1 });
          else {
            const key = Math.floor((Number(raw.created_at) - start) / resolution);
            const bucket = buckets.get(key) ?? {
              timestamp: Number(raw.created_at),
              count: 0,
              sums: {},
              counts: {},
              withinTolerance: false,
            };
            bucket.count++;
            if (converted.measurement_quality === 'within_tolerance') bucket.withinTolerance = true;
            for (const field of fields)
              if (typeof converted[field] === 'number') {
                bucket.sums[field] = (bucket.sums[field] ?? 0) + Number(converted[field]);
                bucket.counts[field] = (bucket.counts[field] ?? 0) + 1;
              }
            buckets.set(key, bucket);
          }
        }
        if (page.results.length < 500) break;
        const last = page.results.at(-1)!;
        cursorTime = Number(last.created_at);
        cursorId = Number(last.reading_id);
      }
      if (resolution)
        data = [...buckets.values()].map((bucket) => ({
          id: row.device_id,
          timestamp: iso(bucket.timestamp),
          sample_count: bucket.count,
          ...Object.fromEntries(
            fields.map((field) => [
              field,
              bucket.counts[field] ? bucket.sums[field] / bucket.counts[field] : null,
            ]),
          ),
          measurement_quality:
            bucket.counts.volume === bucket.count
              ? bucket.withinTolerance
                ? 'within_tolerance'
                : 'valid'
              : 'contains_invalid',
          volume_source: 'backend',
        }));
    } else {
      const query = resolution
        ? `SELECT id,MIN(created_at) created_at,COUNT(*) sample_count,${fields.map((f) => `AVG(${f}) ${f}`).join(',')}${row.device_type === 'SM-WU' ? ",CASE WHEN COUNT(volume)<COUNT(*) OR COUNT(nivel)<COUNT(*) THEN 'contains_invalid' ELSE 'reported' END measurement_quality" : ''}
      FROM (SELECT * FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at,reading_id LIMIT ?) GROUP BY CAST((created_at-?)/? AS INTEGER) ORDER BY created_at`
        : `SELECT * FROM ${table} WHERE reservoir_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at,reading_id LIMIT ?`;
      const stmt = c.env.DB.prepare(query);
      const rows = await (
        resolution
          ? stmt.bind(row.id, start, end, maxSamples, start, resolution)
          : stmt.bind(row.id, start, end, maxSamples)
      ).all<Record<string, unknown>>();
      data = rows.results.map((r) => ({
        id: r.id,
        ...Object.fromEntries(fields.map((f) => [f, r[f]])),
        timestamp: iso(Number(r.created_at)),
        sample_count: r.sample_count ?? 1,
        ...(row.device_type === 'SM-WU' ? { measurement_quality: r.measurement_quality } : {}),
      }));
    }
  } else if (row.source === 'monitorie' && row.external_id === null) {
    data = [];
  } else {
    const result = await remoteHistory(c, row, hours, limit);
    possiblyTruncated = result.possiblyTruncated;
    data = result.data.map((r) => ({ ...configuredReading(row, r) }));
    total = data.length;
    resolution = row.source === 'mock' ? Math.max(60, Math.ceil((end - start) / Math.max(1, limit - 1))) : 0;
  }
  await assertCurrentAccess(c, row);
  data = data.filter((record) => Date.parse(String(record.timestamp)) >= Math.round(row.linked_at * 1000));
  const truncated = possiblyTruncated;
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
