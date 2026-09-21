import type { DeviceType, Env, Reading, SMWAReading, Snapshot } from '../types';
import { monitorieMapping, normalizeMonitorieSeries } from './mapping';
import {
  D1MonitorieGate,
  MonitorieReadClient,
  monitorieJwt,
  secondsToTimestampMs,
  type TelemetrySeries,
} from './protocol';

/** Contrato interno do Hidra; o mapping explícito faz a fronteira com as keys da MonitorIE. */
export interface TelemetryScope {
  deviceId: number;
  deviceType: DeviceType;
  externalId: string;
  linkedAt: number;
  offlineAfterSeconds: number;
}

export interface SMWUAdapter {
  snapshot(scope: TelemetryScope): Promise<Snapshot>;
  history(scope: TelemetryScope, since: number, limit: number): Promise<Reading[]>;
}

export interface SMWAAdapter {
  snapshot(scope: TelemetryScope): Promise<Snapshot>;
  history(scope: TelemetryScope, since: number, limit: number): Promise<SMWAReading[]>;
}

export interface MonitorieAdapter {
  snapshot(scope: TelemetryScope): Promise<Snapshot>;
  history(scope: TelemetryScope, since: number, limit: number): Promise<(Reading | SMWAReading)[]>;
}

export interface MonitorieTelemetryClient {
  latest(externalId: string, keys: readonly string[]): Promise<TelemetrySeries>;
  history(
    externalId: string,
    keys: readonly string[],
    startMs: number,
    endMs: number,
    limit: number,
  ): Promise<{ series: TelemetrySeries; possiblyTruncated: boolean }>;
}

function status(scope: TelemetryScope, data: Reading | SMWAReading | null): Snapshot {
  const lastSeen = data?.timestamp ?? null;
  const age = lastSeen === null ? Infinity : Math.floor((Date.now() - Date.parse(lastSeen)) / 1000);
  return {
    device: {
      id: scope.deviceId,
      type: scope.deviceType,
      status: age < scope.offlineAfterSeconds ? 'online' : 'offline',
      last_seen: lastSeen,
      offline_after_seconds: scope.offlineAfterSeconds,
    },
    data,
  };
}

abstract class ModelAdapter {
  constructor(
    protected readonly env: Env,
    protected readonly client: MonitorieTelemetryClient,
    private readonly type: DeviceType,
  ) {}
  protected async current(scope: TelemetryScope): Promise<Snapshot> {
    const mapping = monitorieMapping(this.env, this.type);
    const series = await this.client.latest(scope.externalId, mapping.keys);
    const rows = normalizeMonitorieSeries(series, mapping, scope.deviceId);
    return status(scope, rows.at(-1) ?? null);
  }
  protected async range(
    scope: TelemetryScope,
    since: number,
    limit: number,
  ): Promise<(Reading | SMWAReading)[]> {
    const mapping = monitorieMapping(this.env, this.type);
    const result = await this.client.history(
      scope.externalId,
      mapping.keys,
      secondsToTimestampMs(since),
      Date.now(),
      limit,
    );
    return normalizeMonitorieSeries(result.series, mapping, scope.deviceId);
  }
}

export class MonitorieSMWUAdapter extends ModelAdapter implements SMWUAdapter {
  constructor(env: Env, client: MonitorieTelemetryClient) {
    super(env, client, 'SM-WU');
  }
  async snapshot(scope: TelemetryScope): Promise<Snapshot> {
    return this.current(scope);
  }
  async history(scope: TelemetryScope, since: number, limit: number): Promise<Reading[]> {
    return (await this.range(scope, since, limit)) as Reading[];
  }
}

export class MonitorieSMWAAdapter extends ModelAdapter implements SMWAAdapter {
  constructor(env: Env, client: MonitorieTelemetryClient) {
    super(env, client, 'SM-WA');
  }
  async snapshot(scope: TelemetryScope): Promise<Snapshot> {
    return this.current(scope);
  }
  async history(scope: TelemetryScope, since: number, limit: number): Promise<SMWAReading[]> {
    return (await this.range(scope, since, limit)) as SMWAReading[];
  }
}

export class MonitorieAPI implements MonitorieAdapter {
  private readonly smwu: MonitorieSMWUAdapter;
  private readonly smwa: MonitorieSMWAAdapter;
  constructor(env: Env, client?: MonitorieTelemetryClient) {
    const telemetry =
      client ?? new MonitorieReadClient(async () => monitorieJwt(env), new D1MonitorieGate(env.DB));
    this.smwu = new MonitorieSMWUAdapter(env, telemetry);
    this.smwa = new MonitorieSMWAAdapter(env, telemetry);
  }
  async snapshot(scope: TelemetryScope): Promise<Snapshot> {
    if (scope.deviceType === 'SM-WA') return this.smwa.snapshot(scope);
    return this.smwu.snapshot(scope);
  }
  async history(scope: TelemetryScope, since: number, limit: number): Promise<(Reading | SMWAReading)[]> {
    if (scope.deviceType === 'SM-WA') return this.smwa.history(scope, since, limit);
    return this.smwu.history(scope, since, limit);
  }
}
