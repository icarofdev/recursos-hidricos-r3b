import type { Context } from '../types';
import { configInt, now, secret } from '../http';
import { hmac } from './crypto';

export async function securityEvent(
  c: Context,
  eventType: string,
  result: 'success' | 'failure',
  accountId: number | null = null,
  email?: string,
): Promise<void> {
  const accountHash = email
    ? await hmac(`security-account\0${email.trim().toLowerCase()}`, secret(c.env, 'SESSION_SECRET'))
    : null;
  const event = {
    event: 'security',
    account_id: accountId,
    account_hash: accountHash,
    event_type: eventType,
    result,
    request_id: c.requestId,
  };
  console.log(JSON.stringify(event));
  // Successful security transitions are durable; rejected traffic is sampled.
  const failureSample = configInt(c.env.SECURITY_EVENT_FAILURE_SAMPLE_RATE, 20, 1, 10000);
  if (result === 'failure' && crypto.getRandomValues(new Uint32Array(1))[0] % failureSample !== 0) return;
  try {
    await c.env.DB.prepare(
      'INSERT INTO security_events(account_id,account_hash,event_type,result,request_id,created_at) VALUES (?,?,?,?,?,?)',
    )
      .bind(accountId, accountHash, eventType, result, c.requestId, now())
      .run();
  } catch {
    // Authentication must not become unavailable because audit persistence failed.
    console.warn('SECURITY_EVENT_PERSISTENCE_FAILED');
  }
}
