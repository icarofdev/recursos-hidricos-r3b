import type { Context, Env } from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export const now = () => Math.floor(Date.now() / 1000);
export const iso = (value: number | null) => (value === null ? null : new Date(value * 1000).toISOString());
export const json = (value: unknown, status = 200) => Response.json(value, { status });
export function configInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
export function isLocal(c: Pick<Context, 'env' | 'url'>): boolean {
  return c.env.APP_ENV === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(c.url.hostname);
}
export function secret(env: Env, name: 'SESSION_SECRET' | 'PASSWORD_PEPPER'): string {
  const value = env[name];
  if (!value || value.length < 32)
    throw new HttpError(503, 'CONFIGURATION_REQUIRED', 'Serviço ainda não configurado.');
  return value;
}
export function method(c: Context, allowed: string[]): void {
  if (!allowed.includes(c.request.method))
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
}
export function exactOrigin(value: string, local = false): string | null {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      /[\\\x00-\x20\x7f]/.test(value)
    )
      return null;
    if (
      url.protocol !== 'https:' &&
      !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function isAllowedOrigin(c: Context, origin: string | null): boolean {
  if (!origin) return true;
  if (origin === c.url.origin) return true;
  return (c.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((x) => x.trim())
    .some((x) => x && exactOrigin(x, isLocal(c)) === x && x === origin);
}
export function frontendOrigin(c: Context): string {
  const origin = exactOrigin(c.env.APP_URL ?? '', isLocal(c));
  if (!origin || origin === c.url.origin)
    throw new HttpError(503, 'INVALID_FRONTEND_ORIGIN', 'Configure a origem do frontend separada da API.');
  return origin;
}
export function isCrossSite(c: Context): boolean {
  if (!c.env.APP_URL) return false;
  try {
    const appOrigin = new URL(c.env.APP_URL).origin;
    return appOrigin !== c.url.origin;
  } catch {
    return false;
  }
}
export function sameOrigin(c: Context): void {
  const origin = c.request.headers.get('Origin');
  if (origin) {
    if (!isAllowedOrigin(c, origin)) throw new HttpError(403, 'INVALID_ORIGIN', 'Origem não permitida.');
    return;
  }
  const site = c.request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') throw new HttpError(403, 'INVALID_ORIGIN', 'Origem não permitida.');
}
export async function body(c: Context, allowed?: string[]): Promise<Record<string, unknown>> {
  if (c.request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie application/json.');
  const reader = c.request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'JSON inválido.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Conteúdo maior que o permitido.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'JSON inválido.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new HttpError(400, 'INVALID_JSON', 'Envie um objeto JSON.');
  if (allowed && Object.keys(data).some((key) => !allowed.includes(key)))
    throw new HttpError(422, 'UNKNOWN_FIELD', 'Campo não reconhecido.');
  return data;
}
export function string(data: Record<string, unknown>, field: string, max: number): string {
  const value = data[field];
  if (typeof value !== 'string' || [...value].length > max)
    throw new HttpError(422, 'INVALID_FIELD', `O campo ${field} é inválido.`);
  return value;
}
export function positiveId(value: unknown): number {
  if (
    !['number', 'string'].includes(typeof value) ||
    !/^[1-9][0-9]*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new HttpError(422, 'INVALID_ID', 'Identificador inválido.');
  return Number(value);
}
export function queryInt(c: Context, key: string, fallback: number, min: number, max: number): number {
  const text = c.url.searchParams.get(key);
  if (text === null) return fallback;
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(422, 'INVALID_QUERY', 'Parâmetro fora da faixa permitida.');
  return n;
}
export function safePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\x00-\x20]/.test(value)
  )
    return '/';
  const parsed = new URL(value, 'https://app.invalid');
  return parsed.origin === 'https://app.invalid' ? parsed.pathname + parsed.search + parsed.hash : '/';
}
export function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
export function secureResponse(response: Response, c: Context): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Request-ID', c.requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (c.url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  const origin = c.request.headers.get('Origin');
  if (origin && isAllowedOrigin(c, origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.append('Vary', 'Origin');
  }
  for (const cookie of c.cookies) headers.append('Set-Cookie', cookie);
  return new Response(c.request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers,
  });
}
