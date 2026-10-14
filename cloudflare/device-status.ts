import { configInt, now } from './http';
import type { Env } from './types';
export function effectiveStatus(
  env: Env,
  source: string,
  external: string | null,
  reported: string,
  last: number | null,
  checked: number | null = null,
): 'online' | 'offline' | 'unknown' {
  const threshold = configInt(env.DEVICE_OFFLINE_AFTER_SECONDS, 90, 5, 86400);
  if (source === 'monitorie' && external === null) return 'unknown';
  if (source === 'monitorie' && (checked === null || checked + threshold <= now())) return 'unknown';
  return reported === 'online' && last !== null && last + threshold > now() ? 'online' : 'offline';
}
