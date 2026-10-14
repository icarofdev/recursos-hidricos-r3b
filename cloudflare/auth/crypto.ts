import { HttpError, secret } from '../http';
import type { Env } from '../types';
import { isCommonPassword } from './common-passwords';
import { keyId, previousKeyActive } from './key-window';

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
    [...value].length < 8 ||
    encoder.encode(value).length > 128 ||
    !/[A-Z]/.test(value) ||
    !/[a-z]/.test(value) ||
    !/[0-9]/.test(value) ||
    !/[^A-Za-z0-9]/.test(value)
  )
    throw new HttpError(
      422,
      'WEAK_PASSWORD',
      'A senha deve conter no mínimo 8 caracteres, incluindo letras maiúsculas, minúsculas, números e caracteres especiais.',
    );
  if (isCommonPassword(value)) throw new HttpError(422, 'COMMON_PASSWORD', 'Escolha uma senha menos comum.');
  if (!equal(value, confirmation))
    throw new HttpError(422, 'PASSWORD_MISMATCH', 'A confirmação da senha não corresponde.');
}
// PBKDF2 nativo, no teto de 100.000 iterações suportado pelos Workers.
// Pepper obrigatório fora do D1 protege também contra vazamento isolado do banco.
// Não reduzir o custo para contornar limites de CPU: validar CPU no lançamento.
const ITERATIONS = 100_000;
async function derive(password: string, salt: string, env: Env, previous = false): Promise<string> {
  const pepper = previous ? env.PASSWORD_PEPPER_PREVIOUS : secret(env, 'PASSWORD_PEPPER');
  if (!pepper || pepper.length < 32)
    throw new HttpError(503, 'CONFIGURATION_REQUIRED', 'Serviço ainda não configurado.');
  const peppered = await hmac(password, pepper);
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
  return `pbkdf2-sha256-pepper$v2$${keyId(env.PASSWORD_PEPPER_ID)}$${ITERATIONS}$${salt}$${await derive(password, salt, env)}`;
}
export async function verifyPassword(
  password: string,
  stored: string | undefined,
  env: Env,
): Promise<boolean> {
  let parts = stored?.split('$') ?? [];
  const versioned = parts[1] === 'v2' && parts.length === 6;
  const id = versioned ? parts[2] : null;
  if (versioned) parts = [parts[0], 'v1', ...parts.slice(3)];
  const previous =
    id !== null &&
    id !== keyId(env.PASSWORD_PEPPER_ID) &&
    id === env.PASSWORD_PEPPER_PREVIOUS_ID &&
    previousKeyActive(env.PASSWORD_PEPPER_PREVIOUS_UNTIL);
  const valid =
    parts.length === 5 &&
    parts[0] === 'pbkdf2-sha256-pepper' &&
    parts[1] === 'v1' &&
    parts[2] === String(ITERATIONS) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[3]) &&
    /^[a-f0-9]{64}$/.test(parts[4]);
  const recognized = id === null || id === keyId(env.PASSWORD_PEPPER_ID) || previous;
  const result = await derive(password, valid ? parts[3] : 'dummy-salt-for-timing00', env, previous);
  if (valid && recognized && equal(result, parts[4])) return true;
  if (
    valid &&
    id === null &&
    env.PASSWORD_PEPPER_PREVIOUS &&
    previousKeyActive(env.PASSWORD_PEPPER_PREVIOUS_UNTIL)
  )
    return equal(await derive(password, parts[3], env, true), parts[4]);
  return false;
}
export function passwordNeedsUpgrade(stored: string, env: Env): boolean {
  return !stored.startsWith(`pbkdf2-sha256-pepper$v2$${keyId(env.PASSWORD_PEPPER_ID)}$`);
}
