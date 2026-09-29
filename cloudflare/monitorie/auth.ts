import type { Env } from '../types';
import { HttpError, secret } from '../http';
import { MONITORIE_ORIGIN, monitorieJwt, type Transport } from './protocol';

const ACCESS_LIFETIME_MS = 20 * 60 * 1000;
const RENEW_MARGIN_MS = 2 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_BYTES = 16_384;
const LEASE_SECONDS = 30;
const WAIT_MS = 20_000;
const encoder = new TextEncoder();

type TokenPair = {
  token: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
};
type CacheRow = {
  sealed: string | null;
  nonce: string | null;
  force_refresh: number;
  lease_until: number;
  retry_after: number;
};

const unavailable = () =>
  new HttpError(503, 'MONITORIE_AUTH_UNAVAILABLE', 'Autenticação da MonitorIE temporariamente indisponível.');
const notConfigured = () =>
  new HttpError(503, 'MONITORIE_NOT_CONFIGURED', 'A autenticação da MonitorIE ainda não foi configurada.');
const invalidResponse = () =>
  new HttpError(
    503,
    'MONITORIE_AUTH_INVALID_DATA',
    'A MonitorIE retornou uma resposta de autenticação inválida.',
  );
const busy = () =>
  new HttpError(503, 'MONITORIE_AUTH_BUSY', 'Autenticação da MonitorIE em andamento. Tente novamente.', 2);

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidResponse();
  const raw = atob(
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function jwtExpiry(token: string): number | null {
  try {
    const claims = JSON.parse(new TextDecoder().decode(unbase64url(token.split('.')[1])));
    return Number.isSafeInteger(claims?.exp) && claims.exp > 0 ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8192 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}
function credentials(env: Env): { username: string; password: string } | null {
  const username = env.MONITORIE_USERNAME;
  const password = env.MONITORIE_PASSWORD;
  if (!username && !password) return null;
  if (
    !username ||
    !password ||
    username.length > 320 ||
    password.length > 512 ||
    !username.trim() ||
    !password ||
    username !== username.trim()
  )
    throw notConfigured();
  return { username, password };
}
/** Only checks server bindings; never returns a token or credential to the caller. */
export async function monitorieAuthConfigured(env: Env): Promise<boolean> {
  if (env.MONITORIE_MODE !== 'live') return false;
  try {
    if (credentials(env)) {
      secret(env, 'SESSION_SECRET');
      await env.DB.prepare('SELECT id FROM monitorie_auth_cache LIMIT 1').first();
      return true;
    }
    monitorieJwt(env);
    return true;
  } catch {
    return false;
  }
}

/** D1 holds only AES-GCM ciphertext. SESSION_SECRET derives a separate cache key by HKDF. */
export class MonitorieAuth {
  private readonly transport: Transport;
  private keyPromise: Promise<CryptoKey> | null = null;
  private lastCipher: string | null = null;
  private lastToken: string | null = null;

  constructor(
    private readonly env: Env,
    transport: Transport = (request) => fetch(request),
    private readonly time: () => number = () => Date.now(),
  ) {
    this.transport = transport;
  }

  private async key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const root = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret(this.env, 'SESSION_SECRET')),
        'HKDF',
        false,
        ['deriveKey'],
      );
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('hidra-monitorie-auth-v1'),
          info: encoder.encode('encrypted-token-pair'),
        },
        root,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    return this.keyPromise;
  }
  private aad(): Uint8Array {
    return encoder.encode(
      `monitorie-token-pair-v1\0${this.env.MONITORIE_USERNAME}\0${this.env.MONITORIE_PASSWORD}`,
    );
  }
  private async open(row: CacheRow | null): Promise<TokenPair | null> {
    if (!row?.sealed || !row.nonce || row.sealed.length > 32_768) return null;
    try {
      const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unbase64url(row.nonce), additionalData: this.aad() },
        await this.key(),
        unbase64url(row.sealed),
      );
      const pair = JSON.parse(new TextDecoder().decode(bytes));
      if (
        !validToken(pair?.token) ||
        !validToken(pair?.refreshToken) ||
        !Number.isSafeInteger(pair?.accessExpiresAt) ||
        (pair.refreshExpiresAt !== null && !Number.isSafeInteger(pair.refreshExpiresAt))
      )
        return null;
      return pair;
    } catch {
      // A rotated SESSION_SECRET or credential pair invalidates only this encrypted cache.
      return null;
    }
  }
  private async seal(pair: TokenPair): Promise<{ sealed: string; nonce: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.aad() },
      await this.key(),
      encoder.encode(JSON.stringify(pair)),
    );
    return { sealed: base64url(new Uint8Array(encrypted)), nonce: base64url(iv) };
  }
  private async state(): Promise<CacheRow | null> {
    return this.env.DB.prepare(
      'SELECT sealed,nonce,force_refresh,lease_until,retry_after FROM monitorie_auth_cache WHERE id=1',
    ).first<CacheRow>();
  }
  private async post(
    path: '/api/auth/login' | '/api/auth/token',
    payload: object,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      const response = await this.transport(
        new Request(MONITORIE_ORIGIN + path, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      if (path === '/api/auth/token' && [400, 401, 403, 404].includes(response.status)) return null;
      if (path === '/api/auth/login' && [400, 401, 403].includes(response.status))
        throw new HttpError(
          503,
          'MONITORIE_LOGIN_REJECTED',
          'Credenciais da integração MonitorIE rejeitadas.',
        );
      if (!response.ok || response.status >= 300) throw unavailable();
      if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json'))
        throw invalidResponse();
      const length = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(length) && length > MAX_AUTH_BYTES) throw invalidResponse();
      const reader = response.body?.getReader();
      if (!reader) throw invalidResponse();
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          count += part.value.byteLength;
          if (count > MAX_AUTH_BYTES) throw invalidResponse();
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  private pair(value: Record<string, unknown>, previousRefresh?: string): TokenPair {
    if (
      !validToken(value.token) ||
      (value.refreshToken !== undefined && !validToken(value.refreshToken)) ||
      (!previousRefresh && !validToken(value.refreshToken))
    )
      throw invalidResponse();
    const token = value.token;
    const refreshToken = (value.refreshToken ?? previousRefresh) as string;
    const time = this.time();
    const accessExpiresAt = Math.min(
      jwtExpiry(token) ?? time + ACCESS_LIFETIME_MS,
      time + ACCESS_LIFETIME_MS,
    );
    if (accessExpiresAt <= time + 10_000) throw invalidResponse();
    return { token, refreshToken, accessExpiresAt, refreshExpiresAt: jwtExpiry(refreshToken) };
  }
  private async renew(previous: TokenPair | null): Promise<TokenPair> {
    if (
      previous &&
      (previous.refreshExpiresAt === null || previous.refreshExpiresAt > this.time() + RENEW_MARGIN_MS)
    ) {
      const result = await this.post('/api/auth/token', { refreshToken: previous.refreshToken });
      if (result) return this.pair(result, previous.refreshToken);
    }
    const config = credentials(this.env);
    if (!config) throw notConfigured();
    const login = await this.post('/api/auth/login', config);
    if (!login) throw invalidResponse();
    return this.pair(login);
  }

  async get(): Promise<string> {
    if (this.env.MONITORIE_MODE !== 'live') throw notConfigured();
    if (!credentials(this.env)) return monitorieJwt(this.env, this.time());
    secret(this.env, 'SESSION_SECRET');
    const deadline = this.time() + WAIT_MS;
    while (true) {
      const row = await this.state();
      const cached = await this.open(row);
      if (cached && !row?.force_refresh && cached.accessExpiresAt > this.time() + RENEW_MARGIN_MS) {
        this.lastCipher = row!.sealed;
        this.lastToken = cached.token;
        return cached.token;
      }
      const seconds = Math.floor(this.time() / 1000);
      if (row?.retry_after && row.retry_after > seconds) throw busy();
      const lease = base64url(crypto.getRandomValues(new Uint8Array(24)));
      const claim = await this.env.DB.prepare(
        `INSERT INTO monitorie_auth_cache(id,lease_token,lease_until,updated_at)
         VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET
         lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
         WHERE monitorie_auth_cache.lease_until<=? AND monitorie_auth_cache.retry_after<=? RETURNING id`,
      )
        .bind(lease, seconds + LEASE_SECONDS, seconds, seconds, seconds)
        .first();
      if (claim) {
        try {
          const latest = await this.state();
          const latestPair = await this.open(latest);
          if (
            latestPair &&
            !latest?.force_refresh &&
            latestPair.accessExpiresAt > this.time() + RENEW_MARGIN_MS
          ) {
            await this.env.DB.prepare(
              'UPDATE monitorie_auth_cache SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?',
            )
              .bind(lease)
              .run();
            this.lastCipher = latest!.sealed;
            this.lastToken = latestPair.token;
            return latestPair.token;
          }
          const renewed = await this.renew(latestPair);
          const sealed = await this.seal(renewed);
          const update = await this.env.DB.prepare(
            `UPDATE monitorie_auth_cache SET sealed=?,nonce=?,force_refresh=0,lease_token=NULL,
             lease_until=0,retry_after=0,updated_at=? WHERE id=1 AND lease_token=?`,
          )
            .bind(sealed.sealed, sealed.nonce, Math.floor(this.time() / 1000), lease)
            .run();
          if (update.meta.changes !== 1) throw busy();
          this.lastCipher = sealed.sealed;
          this.lastToken = renewed.token;
          return renewed.token;
        } catch (error) {
          await this.env.DB.prepare(
            `UPDATE monitorie_auth_cache SET lease_token=NULL,lease_until=0,retry_after=?
             WHERE id=1 AND lease_token=?`,
          )
            .bind(Math.floor(this.time() / 1000) + 10, lease)
            .run();
          if (error instanceof HttpError) throw error;
          throw unavailable();
        }
      }
      if (this.time() >= deadline) throw busy();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** A rejected access token is refreshed on the next rate-gated telemetry request. */
  async rejected(token: string): Promise<void> {
    if (!this.lastCipher || token !== this.lastToken) return;
    await this.env.DB.prepare('UPDATE monitorie_auth_cache SET force_refresh=1 WHERE id=1 AND sealed=?')
      .bind(this.lastCipher)
      .run();
  }
}
