import type { Context } from '../types';
import { configInt, HttpError, now } from '../http';
import { randomToken } from '../auth/crypto';

interface Entry {
  payload: string | null;
  expires_at: number;
  negative_until: number;
}
const busy = () =>
  new HttpError(503, 'MONITORIE_UNAVAILABLE', 'Telemetria temporariamente indisponível. Aguarde.', 60);
/** D1 primary serializes leases across isolates/regions. Never caches credentials. */
export async function cachedTelemetry<T>(c: Context, key: string, producer: () => Promise<T>): Promise<T> {
  const time = now(),
    lease = randomToken();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO telemetry_cache(cache_key,lease_token,lease_until) VALUES (?,?,?)
   ON CONFLICT(cache_key) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
   WHERE expires_at<=? AND negative_until<=? AND lease_until<=? RETURNING cache_key`,
    ).bind(key, lease, time + 30, time, time, time),
    c.env.DB.prepare('SELECT payload,expires_at,negative_until FROM telemetry_cache WHERE cache_key=?').bind(
      key,
    ),
  ]);
  const entry = results[1].results[0] as unknown as Entry;
  if (entry.payload && entry.expires_at > time) return JSON.parse(entry.payload) as T;
  if (!results[0].results.length) throw busy();
  try {
    const data = await producer();
    await c.env.DB.prepare(
      `UPDATE telemetry_cache SET payload=?,expires_at=?,negative_until=0,lease_token=NULL,lease_until=0
   WHERE cache_key=? AND lease_token=?`,
    )
      .bind(JSON.stringify(data), now() + configInt(c.env.MONITORIE_CACHE_SECONDS, 60, 60, 3600), key, lease)
      .run();
    return data;
  } catch (error) {
    // Fencing: an expired producer cannot overwrite a newer successful result.
    await c.env.DB.prepare(
      `UPDATE telemetry_cache SET negative_until=?,lease_token=NULL,lease_until=0
   WHERE cache_key=? AND lease_token=? AND expires_at<=?`,
    )
      .bind(now() + 60, key, lease, now())
      .run();
    if (error instanceof HttpError) throw error;
    throw busy();
  }
}
