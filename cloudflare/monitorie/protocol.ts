import type { Env } from '../types';
import { HttpError } from '../http';

// Swagger oficial consultado em 21/09/2026: MonitorIE / ThingsBoard 3.6.4 PE.
// O destino e os caminhos são fixos; nenhuma rota aceita URL fornecida pelo navegador.
export const MONITORIE_ORIGIN = 'https://monitorie.com.br';
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

export interface TelemetryPoint {
  ts: number;
  value: unknown;
}
export type TelemetrySeries = Record<string, TelemetryPoint[]>;
export type Transport = (request: Request) => Promise<Response>;
export interface RequestGate {
  // Deve coordenar todas as instâncias do Worker; cache regional não basta.
  reserve(): Promise<void>;
  defer(seconds: number): Promise<void>;
}
export interface MonitorieDevice {
  id: string;
  name: string;
  label: string | null;
  type: string;
}
export interface MonitorieDevicePage {
  data: MonitorieDevice[];
  page: number;
  totalPages: number;
  totalElements: number;
  hasNext: boolean;
}

const invalid = () => new HttpError(503, 'MONITORIE_INVALID_DATA', 'Resposta inválida da MonitorIE.');
const notConfigured = () =>
  new HttpError(503, 'MONITORIE_NOT_CONFIGURED', 'A integração MonitorIE ainda não foi configurada.');
const badInput = () =>
  new HttpError(503, 'MONITORIE_NOT_CONFIGURED', 'Confirme os identificadores e variáveis da MonitorIE.');
const timeout = () =>
  new HttpError(
    504,
    'MONITORIE_TIMEOUT',
    'A MonitorIE demorou para responder. Tente novamente em instantes.',
  );

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function base64UrlJson(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw notConfigured();
  try {
    const base64 = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw notConfigured();
  }
}

/** Lê o JWT somente do binding secreto do Worker e valida sua expiração sem registrar o valor. */
export function monitorieJwt(env: Pick<Env, 'MONITORIE_MODE' | 'MONITORIE_JWT'>, time = Date.now()): string {
  if (env.MONITORIE_MODE !== 'live' || !env.MONITORIE_JWT) throw notConfigured();
  const token = env.MONITORIE_JWT.trim();
  const parts = token.split('.');
  if (token !== env.MONITORIE_JWT || parts.length !== 3 || parts.some((part) => !part)) throw notConfigured();
  const claims = base64UrlJson(parts[1]);
  if (!object(claims) || !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= 0) throw notConfigured();
  if (Number(claims.exp) * 1000 <= time + 30000)
    throw new HttpError(
      503,
      'MONITORIE_TOKEN_EXPIRED',
      'O JWT da integração MonitorIE expirou. Atualize o secret MONITORIE_JWT.',
    );
  return token;
}

function deviceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw badInput();
  return value;
}
function keysParam(keys: readonly string[]): string {
  if (
    keys.length < 1 ||
    keys.length > 32 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 255 || /[,\x00-\x1f]/.test(key))
  )
    throw badInput();
  return keys.join(',');
}
export function timestampMsToIso(ts: number): string {
  if (!Number.isSafeInteger(ts) || ts < 0 || ts > 8640000000000000) throw invalid();
  return new Date(ts).toISOString();
}
export function secondsToTimestampMs(seconds: number): number {
  const ts = seconds * 1000;
  timestampMsToIso(ts);
  return ts;
}

async function requestJson(
  path: string,
  init: RequestInit,
  gate: RequestGate,
  transport: Transport,
  timeoutMilliseconds: number,
  maxBytes = MAX_BYTES,
): Promise<unknown> {
  await gate.reserve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await transport(
      new Request(MONITORIE_ORIGIN + path, { ...init, redirect: 'manual', signal: controller.signal }),
    );
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const raw =
        header && /^\d+$/.test(header)
          ? Number(header)
          : header
            ? Math.ceil((Date.parse(header) - Date.now()) / 1000)
            : 60;
      const delay = Number.isFinite(raw) ? Math.max(60, raw) : 60;
      await gate.defer(delay);
      throw new HttpError(503, 'MONITORIE_RATE_LIMITED', 'Limite de consultas da MonitorIE. Aguarde.', delay);
    }
    if (response.status === 401)
      throw new HttpError(
        503,
        'MONITORIE_TOKEN_REJECTED',
        'O JWT da integração MonitorIE foi rejeitado. Atualize o secret MONITORIE_JWT.',
      );
    if (response.status === 403)
      throw new HttpError(
        503,
        'MONITORIE_ACCESS_DENIED',
        'A integração não tem permissão para consultar este recurso da MonitorIE.',
      );
    if (response.status === 404)
      throw new HttpError(
        503,
        'MONITORIE_DEVICE_NOT_FOUND',
        'O dispositivo não foi encontrado ou não está acessível na MonitorIE.',
      );
    if (!response.ok || response.status >= 300)
      throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'MonitorIE temporariamente indisponível.');
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw invalid();
    if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) throw invalid();
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw invalid();
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) throw timeout();
    // Nunca propagar corpo, URL, JWT ou mensagens do provedor/transport.
    throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'MonitorIE temporariamente indisponível.');
  } finally {
    clearTimeout(timer);
  }
}

/** Lê somente recursos documentados no Swagger. Não contém endpoint de escrita nem renovação automática. */
export class MonitorieReadClient {
  #accessToken: () => Promise<string>;
  #gate: RequestGate;
  #transport: Transport;
  #timeoutMilliseconds: number;
  constructor(
    accessToken: () => Promise<string>,
    gate: RequestGate,
    transport: Transport = (request) => fetch(request),
    timeoutMilliseconds = DEFAULT_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 30000)
      throw badInput();
    this.#accessToken = accessToken;
    this.#gate = gate;
    this.#transport = transport;
    this.#timeoutMilliseconds = timeoutMilliseconds;
  }
  async #get(path: string): Promise<unknown> {
    const token = await this.#accessToken();
    if (!token || /\s/.test(token)) throw notConfigured();
    return requestJson(
      path,
      { method: 'GET', headers: { 'X-Authorization': `Bearer ${token}`, Accept: 'application/json' } },
      this.#gate,
      this.#transport,
      this.#timeoutMilliseconds,
    );
  }
  async devices(page = 0, pageSize = 100): Promise<MonitorieDevicePage> {
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      throw badInput();
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortProperty: 'name',
      sortOrder: 'ASC',
    });
    const value = await this.#get(`/api/user/devices?${query}`);
    if (
      !object(value) ||
      !Array.isArray(value.data) ||
      value.data.length > pageSize ||
      !Number.isInteger(value.totalPages) ||
      Number(value.totalPages) < 0 ||
      !Number.isInteger(value.totalElements) ||
      Number(value.totalElements) < 0 ||
      typeof value.hasNext !== 'boolean'
    )
      throw invalid();
    const data = value.data.map((entry): MonitorieDevice => {
      if (
        !object(entry) ||
        !object(entry.id) ||
        typeof entry.id.id !== 'string' ||
        typeof entry.name !== 'string' ||
        entry.name.length > 255 ||
        (entry.label !== null && entry.label !== undefined && typeof entry.label !== 'string') ||
        typeof entry.type !== 'string' ||
        entry.type.length > 255
      )
        throw invalid();
      return {
        id: deviceId(entry.id.id),
        name: entry.name,
        label: typeof entry.label === 'string' ? entry.label : null,
        type: entry.type,
      };
    });
    return {
      data,
      page,
      totalPages: Number(value.totalPages),
      totalElements: Number(value.totalElements),
      hasNext: value.hasNext,
    };
  }
  async keys(externalId: string): Promise<string[]> {
    const data = await this.#get(`/api/plugins/telemetry/DEVICE/${deviceId(externalId)}/keys/timeseries`);
    if (
      !Array.isArray(data) ||
      data.length > 1000 ||
      data.some((key) => typeof key !== 'string' || !key || key.length > 255 || /[,\x00-\x1f]/.test(key))
    )
      throw invalid();
    return data;
  }
  async latest(externalId: string, keys: readonly string[]): Promise<TelemetrySeries> {
    const path = `/api/plugins/telemetry/DEVICE/${deviceId(externalId)}/values/timeseries`;
    const query = new URLSearchParams({ keys: keysParam(keys), useStrictDataTypes: 'true' });
    return this.#series(await this.#get(`${path}?${query}`), keys, 1);
  }
  async history(
    externalId: string,
    keys: readonly string[],
    startMs: number,
    endMs: number,
    limit: number,
  ): Promise<{ series: TelemetrySeries; possiblyTruncated: boolean }> {
    timestampMsToIso(startMs);
    timestampMsToIso(endMs);
    if (startMs > endMs || !Number.isInteger(limit) || limit < 1 || limit > 2000) throw badInput();
    const path = `/api/plugins/telemetry/DEVICE/${deviceId(externalId)}/values/timeseries`;
    const query = new URLSearchParams({
      keys: keysParam(keys),
      startTs: String(startMs),
      endTs: String(endMs),
      limit: String(limit),
      agg: 'NONE',
      orderBy: 'ASC',
      useStrictDataTypes: 'true',
    });
    const series = this.#series(await this.#get(`${path}?${query}`), keys, limit);
    for (const points of Object.values(series)) {
      if (points.some((point) => point.ts < startMs || point.ts > endMs)) throw invalid();
      points.sort((a, b) => a.ts - b.ts);
    }
    // O endpoint não oferece cursor; atingir o limite significa histórico possivelmente incompleto.
    return { series, possiblyTruncated: Object.values(series).some((points) => points.length === limit) };
  }
  #series(data: unknown, keys: readonly string[], limit: number): TelemetrySeries {
    if (!object(data) || Object.keys(data).some((key) => !keys.includes(key))) throw invalid();
    const result: TelemetrySeries = Object.create(null);
    for (const key of keys) {
      const points = Object.hasOwn(data, key) ? data[key] : [];
      if (!Array.isArray(points) || points.length > limit) throw invalid();
      result[key] = points.map((point) => {
        if (!object(point) || typeof point.ts !== 'number' || !Object.hasOwn(point, 'value')) throw invalid();
        timestampMsToIso(point.ts);
        if (point.ts > Date.now() + 60000) throw invalid();
        return { ts: point.ts, value: point.value };
      });
    }
    return result;
  }
}

/** Trava global conservadora: uma chamada/60s para esta integração, inclusive entre regiões.
 * Usa o D1 primário (sem read replica). Somente instanciar com o DB do ambiente correto.
 * Reserva 10s adicionais para o timeout da chamada; não persiste nenhuma credencial.
 */
export class D1MonitorieGate implements RequestGate {
  constructor(private readonly db: D1Database) {}
  async reserve(): Promise<void> {
    const result = await this.db
      .prepare(
        `INSERT INTO settings(key,value,updated_at)
   VALUES ('monitorie:next-request-ms', CAST((unixepoch('now') + 70) * 1000 AS TEXT), unixepoch('now'))
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
   WHERE CAST(settings.value AS INTEGER) <= unixepoch('now') * 1000`,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new HttpError(503, 'MONITORIE_RATE_LIMITED', 'Aguarde o intervalo de consulta da MonitorIE.', 70);
  }
  async defer(seconds: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE settings SET value=CAST(MAX(CAST(value AS INTEGER),
   (unixepoch('now') + ?) * 1000) AS TEXT) WHERE key='monitorie:next-request-ms'`,
      )
      .bind(Math.ceil(Math.max(70, seconds)))
      .run();
  }
}
