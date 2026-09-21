import { HttpError, secret } from '../http';
import type { Env } from '../types';

const encoder = new TextEncoder();
export function randomToken(bytes = 32): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export async function hmac(value: string, key: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)));
}
export function equal(a: string, b: string): boolean {
  const first = encoder.encode(a);
  const second = encoder.encode(b);
  return first.byteLength === second.byteLength && crypto.subtle.timingSafeEqual(first, second);
}
export function validatePassword(value: string, confirmation: string): void {
  if (
    encoder.encode(value).length < 10 ||
    encoder.encode(value).length > 128 ||
    !/[A-Za-z]/.test(value) ||
    !/[0-9]/.test(value)
  )
    throw new HttpError(422, 'WEAK_PASSWORD', 'Use uma senha de 10 a 128 caracteres, com letras e números.');
  if (!equal(value, confirmation))
    throw new HttpError(422, 'PASSWORD_MISMATCH', 'A confirmação da senha não corresponde.');
}
// PBKDF2 nativo, no teto de 100.000 iterações suportado pelos Workers.
// Pepper obrigatório fora do D1 protege também contra vazamento isolado do banco.
// Não reduzir o custo para contornar limites de CPU: validar CPU no lançamento.
const ITERATIONS = 100_000;
async function derive(password: string, salt: string, env: Env): Promise<string> {
  const peppered = await hmac(password, secret(env, 'PASSWORD_PEPPER'));
  const key = await crypto.subtle.importKey('raw', encoder.encode(peppered), 'PBKDF2', false, ['deriveBits']);
  return hex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: ITERATIONS },
      key,
      256,
    ),
  );
}
export async function hashPassword(password: string, env: Env): Promise<string> {
  const salt = randomToken(16);
  return `pbkdf2-sha256-pepper$v1$${ITERATIONS}$${salt}$${await derive(password, salt, env)}`;
}
export async function verifyPassword(
  password: string,
  stored: string | undefined,
  env: Env,
): Promise<boolean> {
  const parts = stored?.split('$') ?? [];
  const valid =
    parts.length === 5 &&
    parts[0] === 'pbkdf2-sha256-pepper' &&
    parts[1] === 'v1' &&
    parts[2] === String(ITERATIONS) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[3]) &&
    /^[a-f0-9]{64}$/.test(parts[4]);
  const result = await derive(password, valid ? parts[3] : 'dummy-salt-for-timing00', env);
  return valid && equal(result, parts[4]);
}
