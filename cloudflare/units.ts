import type { DeviceType, Env, TelemetryUnits } from './types';
import { monitorieUnits } from './monitorie/mapping';

export function telemetryUnits(source: string, type: DeviceType, env?: Env): TelemetryUnits {
  if (source === 'monitorie' && env?.MONITORIE_MODE === 'live') return monitorieUnits(type);
  if (source === 'monitorie')
    return {
      distancia: null,
      nivel: null,
      volume: null,
      rssi_wifi: null,
      vazao: null,
      consumo_acumulado: null,
    };
  return type === 'SM-WU'
    ? { distancia: 'cm', nivel: '%', volume: 'L', rssi_wifi: 'dBm' }
    : { vazao: null, consumo_acumulado: null, volume: null, rssi_wifi: 'dBm' };
}
