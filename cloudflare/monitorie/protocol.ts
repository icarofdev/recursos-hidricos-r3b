import { HttpError } from '../http';

// Contrato público consultado em 17/09/2026: MonitorIE, ThingsBoard 3.6.4PE.
// Sem ligação ao dashboard até confirmar IDs, keys, unidades e renovação.
const ORIGIN = 'https://monitorie.com.br';
const MAX_BYTES = 1024 * 1024;
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
const invalid = () => new HttpError(503, 'MONITORIE_INVALID_DATA', 'Resposta inválida da MonitorIE.');
const badInput = () =>
  new HttpError(503, 'MONITORIE_NOT_CONFIGURED', 'Confirme os identificadores e variáveis da MonitorIE.');
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  maxBytes = MAX_BYTES,
): Promise<unknown> {
  await gate.reserve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await transport(
      new Request(ORIGIN + path, { ...init, redirect: 'error', signal: controller.signal }),
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
    if (response.status === 401 || response.status === 403)
      throw new HttpError(
        503,
        'MONITORIE_ACCESS_DENIED',
        'Acesso à MonitorIE indisponível. Verifique a autorização.',
      );
    if (!response.ok || response.status >= 300)
      throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'MonitorIE temporariamente indisponível.');
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
    // Nunca propagar corpo, URL, senha, JWT ou mensagens do provedor/transport.
    throw new HttpError(503, 'MONITORIE_UNAVAILABLE', 'MonitorIE temporariamente indisponível.');
  } finally {
    clearTimeout(timer);
  }
}

/** Par mantido somente no backend; não retornar em nenhuma rota HTTP do Hidra. */
export async function loginMonitorie(
  credentials: { username: string; password: string },
  gate: RequestGate,
  transport: Transport = (request) => fetch(request),
): Promise<{ token: string; refreshToken: string }> {
  if (!credentials.username || !credentials.password) throw badInput();
  const data = await requestJson(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    },
    gate,
    transport,
    32768,
  );
  if (
    !object(data) ||
    typeof data.token !== 'string' ||
    !data.token ||
    typeof data.refreshToken !== 'string' ||
    !data.refreshToken
  )
    throw invalid();
  return { token: data.token, refreshToken: data.refreshToken };
}

/** Lê somente DEVICE e keys explicitamente provisionadas. Nenhum endpoint de escrita. */
export class MonitorieReadClient {
  #accessToken: () => Promise<string>;
  #gate: RequestGate;
  #transport: Transport;
  constructor(
    accessToken: () => Promise<string>,
    gate: RequestGate,
    transport: Transport = (request) => fetch(request),
  ) {
    this.#accessToken = accessToken;
    this.#gate = gate;
    this.#transport = transport;
  }
  async #get(path: string): Promise<unknown> {
    const token = await this.#accessToken();
    if (!token || /\s/.test(token)) throw badInput();
    return requestJson(
      path,
      { method: 'GET', headers: { 'X-Authorization': `Bearer ${token}`, Accept: 'application/json' } },
      this.#gate,
      this.#transport,
    );
  }
  async keys(externalId: string): Promise<string[]> {
    const data = await this.#get(`/api/plugins/telemetry/DEVICE/${deviceId(externalId)}/keys/timeseries`);
    if (
      !Array.isArray(data) ||
      data.length > 1000 ||
      data.some((key) => typeof key !== 'string' || key.length > 255)
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
    // Sem cursor no contrato deste endpoint. Nunca declarar histórico completo ao atingir limit.
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
