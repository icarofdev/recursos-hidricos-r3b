import type { Env } from '../types';
import { HttpError } from '../http';
import { equal, randomToken, sha256 } from './crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bytes = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const base64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const configured = (env.TOTP_ENCRYPTION_KEY ?? '').trim();
  const encoded =
    (configured.startsWith('"') && configured.endsWith('"')) ||
    (configured.startsWith("'") && configured.endsWith("'"))
      ? configured.slice(1, -1)
      : configured;
  let raw: Uint8Array;
  try {
    if (/^[a-fA-F0-9]{64}$/.test(encoded))
      raw = Uint8Array.from(encoded.match(/../g)!, (pair) => Number.parseInt(pair, 16));
    else if (/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/.test(encoded)) raw = bytes(encoded);
    else throw new Error('format');
  } catch {
    throw new HttpError(503, 'CONFIGURATION_REQUIRED', 'Serviço ainda não configurado.');
  }
  if (raw.length !== 32) throw new HttpError(503, 'CONFIGURATION_REQUIRED', 'Serviço ainda não configurado.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function requireTotpKey(env: Env): Promise<void> {
  await encryptionKey(env);
}

export function newTotpSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0,
    buffer = 0,
    result = '';
  for (const n of raw) {
    buffer = (buffer << 8) | n;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  return result;
}
export async function encryptTotp(env: Env, userId: number, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`admin-totp:${userId}`) },
    await encryptionKey(env),
    new TextEncoder().encode(secret),
  );
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decryptTotp(env: Env, userId: number, stored: string): Promise<string> {
  try {
    const [version, iv, value] = stored.split('.');
    if (version !== 'v1' || !iv || !value) throw new Error('ciphertext');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: new TextEncoder().encode(`admin-totp:${userId}`) },
      await encryptionKey(env),
      bytes(value),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new HttpError(503, 'TOTP_UNAVAILABLE', 'Autenticador temporariamente indisponível.');
  }
}
function decodeSecret(secret: string): Uint8Array {
  let bits = 0,
    buffer = 0;
  const result: number[] = [];
  for (const char of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((buffer >>> bits) & 255);
    }
  }
  return new Uint8Array(result);
}
export async function verifyTotp(secret: string, code: string, lastUsedStep = -1): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const current = Math.floor(Date.now() / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastUsedStep) continue;
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setUint32(4, step);
    const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
    const offset = hash[19] & 15;
    const expected =
      (((hash[offset] & 127) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3]) %
      1000000;
    if (equal(code, String(expected).padStart(6, '0'))) return step;
  }
  return null;
}
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomToken(18));
}
export async function recoveryHash(userId: number, code: string): Promise<string> {
  return sha256(`admin-recovery:${userId}:${code}`);
}
