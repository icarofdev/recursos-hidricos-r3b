import type { Context, ReservoirRow } from '../types';
import { configInt, HttpError, now } from '../http';
import { randomToken } from '../auth/crypto';

interface Entry {
  payload: string | null;
  expires_at: number;
  negative_until: number;
  fetched_at: number;
}
const busy = () =>
  new HttpError(503, 'MONITORIE_UNAVAILABLE', 'Telemetria temporariamente indisponível. Aguarde.', 60);
/** D1 primary serializes leases across isolates/regions. Never caches credentials. */
export async function cachedTelemetry<T>(
  c: Context,
  key: string,
  producer: () => Promise<T>,
  scope?: ReservoirRow,
): Promise<T> {
  const time = now(),
    lease = randomToken();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO telemetry_cache(cache_key,lease_token,lease_until,device_id,access_user_id) VALUES (?,?,?,?,?)
   ON CONFLICT(cache_key) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
   WHERE expires_at<=? AND negative_until<=? AND lease_until<=? RETURNING cache_key`,
    ).bind(key, lease, time + 30, scope?.device_id ?? null, scope?.access_user_id ?? null, time, time, time),
    c.env.DB.prepare(
      'SELECT payload,expires_at,negative_until,fetched_at FROM telemetry_cache WHERE cache_key=?',
    ).bind(key),
  ]);
  const entry = results[1].results[0] as unknown as Entry;
  const stored = (status: 'ok' | 'busy' | 'unavailable') => {
    if (!entry.payload || entry.fetched_at + 1800 <= now()) return null;
    try {
      return metadata(JSON.parse(entry.payload) as T, entry.fetched_at, status);
    } catch {
      return null;
    }
  };
  if (entry.payload && entry.expires_at > time) {
    const hit = stored('ok');
    if (hit !== null) return hit;
  }
  if (!results[0].results.length) {
    const stale = stored(entry.negative_until > time ? 'unavailable' : 'busy');
    if (stale !== null) return stale;
    throw busy();
  }
  try {
    const data = await producer();
    await c.env.DB.prepare(
      `UPDATE telemetry_cache SET payload=?,expires_at=?,fetched_at=?,negative_until=0,lease_token=NULL,lease_until=0
   WHERE cache_key=? AND lease_token=?`,
    )
      .bind(
        JSON.stringify(data),
        now() + configInt(c.env.MONITORIE_CACHE_SECONDS, 60, 60, 3600),
        now(),
        key,
        lease,
      )
      .run();
    return metadata(data, now(), 'ok');
  } catch (error) {
    const contention =
      error instanceof HttpError && ['MONITORIE_RATE_LIMITED', 'MONITORIE_AUTH_BUSY'].includes(error.code);
    // Contention belongs to the shared integration, never to a device's negative cache.
    await c.env.DB.prepare(
      `UPDATE telemetry_cache SET negative_until=?,lease_token=NULL,lease_until=0
   WHERE cache_key=? AND lease_token=? AND expires_at<=?`,
    )
      .bind(contention ? 0 : now() + 60, key, lease, now())
      .run();
    const stale = stored(contention ? 'busy' : 'unavailable');
    if (stale !== null) return stale;
    if (error instanceof HttpError) throw error;
    throw busy();
  }
}
function metadata<T>(data: T, fetched: number, integration: 'ok' | 'busy' | 'unavailable'): T {
  if (data && typeof data === 'object' && 'device' in data) {
    const device = data.device as Record<string, unknown>;
    return {
      ...data,
      device: {
        ...device,
        cache_fetched_at: new Date(fetched * 1000).toISOString(),
        communication_checked_at: new Date(fetched * 1000).toISOString(),
        cache_age_seconds: Math.max(0, now() - fetched),
        integration_status: integration,
      },
    };
  }
  return data;
}
