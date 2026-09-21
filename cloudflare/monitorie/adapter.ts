import type { DeviceType, Env, Reading, SMWAReading, Snapshot } from '../types';
import { HttpError } from '../http';

/** Contrato INTERNO do Hidra. Não é uma suposição sobre o protocolo da Monitorie. */
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

export class MonitorieSMWUAdapter implements SMWUAdapter {
  constructor(private readonly env: Env) {}
  async snapshot(_scope: TelemetryScope): Promise<Snapshot> {
    return this.unavailable();
  }
  async history(_scope: TelemetryScope, _since: number, _limit: number): Promise<Reading[]> {
    return this.unavailable();
  }
  private unavailable(): never {
    void this.env;
    throw new HttpError(
      503,
      'MONITORIE_NOT_CONFIGURED',
      'A conexão com a Monitorie para SM-WU ainda não foi configurada. Sua conta continua disponível.',
    );
  }
}

export class MonitorieSMWAAdapter implements SMWAAdapter {
  constructor(private readonly env: Env) {}
  async snapshot(_scope: TelemetryScope): Promise<Snapshot> {
    return this.unavailable();
  }
  async history(_scope: TelemetryScope, _since: number, _limit: number): Promise<SMWAReading[]> {
    return this.unavailable();
  }
  private unavailable(): never {
    void this.env;
    throw new HttpError(
      503,
      'MONITORIE_NOT_CONFIGURED',
      'A conexão com a Monitorie para SM-WA ainda não foi configurada. Sua conta continua disponível.',
    );
  }
}

/** Implementar somente após receber a especificação oficial da IE Tecnologias. */
export class MonitorieAPI implements MonitorieAdapter {
  private readonly smwu: MonitorieSMWUAdapter;
  private readonly smwa: MonitorieSMWAAdapter;
  constructor(private readonly env: Env) {
    this.smwu = new MonitorieSMWUAdapter(env);
    this.smwa = new MonitorieSMWAAdapter(env);
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
