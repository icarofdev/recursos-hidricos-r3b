import type { MonitorieAdapter, TelemetryScope } from './adapter';
import type { Reading, SMWAReading, Snapshot } from '../types';

function reading(scope: TelemetryScope, time: number): Reading | SMWAReading {
  if (scope.deviceType === 'SM-WA')
    return {
      id: scope.deviceId,
      vazao: 1,
      consumo_acumulado: 100,
      volume: null,
      rssi_wifi: -58,
      timestamp: new Date(time * 1000).toISOString(),
    };
  const level = Math.round((65 + 14 * Math.sin(time / 3600)) * 100) / 100;
  return {
    id: scope.deviceId,
    distancia: 100 - level,
    nivel: level,
    volume: level * 20,
    rssi_wifi: -58,
    timestamp: new Date(time * 1000).toISOString(),
  };
}
export class MockMonitorie implements MonitorieAdapter {
  async snapshot(scope: TelemetryScope): Promise<Snapshot> {
    const time = Date.now() / 1000;
    return {
      simulated: true,
      device: {
        id: scope.deviceId,
        type: scope.deviceType || 'SM-WU',
        status: 'online',
        last_seen: new Date(time * 1000).toISOString(),
        offline_after_seconds: scope.offlineAfterSeconds,
      },
      data: reading(scope, time),
    };
  }
  async history(scope: TelemetryScope, since: number, limit: number): Promise<(Reading | SMWAReading)[]> {
    const end = Date.now() / 1000;
    const start = Math.max(since, scope.linkedAt);
    const step = Math.max(60, Math.ceil((end - start) / Math.max(1, limit - 1)));
    const data = [];
    for (let time = end; time >= start && data.length < limit; time -= step) data.push(reading(scope, time));
    return data.reverse();
  }
  async historyWithMetadata(scope: TelemetryScope, since: number, limit: number) {
    return { data: await this.history(scope, since, limit), possiblyTruncated: false };
  }
}
