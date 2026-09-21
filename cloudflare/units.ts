import type { DeviceType, TelemetryUnits } from './types';
/** Local WU contract only; MonitorIE and WA vendor units remain unknown. */
export function telemetryUnits(source: string, type: DeviceType): TelemetryUnits {
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
