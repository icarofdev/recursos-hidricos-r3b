import { HttpError } from './http';
import type { ReservoirRow } from './types';

export interface MeasurementConfig {
  empty_distance_cm: number;
  full_distance_cm: number;
  sensor_min_cm: number;
  tolerance_cm: number;
  diameter_cm?: number;
  points?: { height_cm: number; liters: number }[];
}
const invalid = () =>
  new HttpError(
    422,
    'INVALID_GEOMETRY',
    'Confira capacidade, distâncias e medidas/calibração do reservatório.',
  );

export function validateConfiguration(
  geometry: string,
  capacity: unknown,
  input: unknown,
): MeasurementConfig | null {
  if (!['reported', 'uniform', 'horizontal_cylinder', 'calibration'].includes(geometry)) throw invalid();
  if (geometry === 'reported') {
    if (input !== null) throw invalid();
    return null;
  }
  if (
    typeof capacity !== 'number' ||
    !Number.isFinite(capacity) ||
    capacity <= 0 ||
    capacity > 1e12 ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    throw invalid();
  const config = input as MeasurementConfig;
  if (
    Object.keys(config).some(
      (key) =>
        ![
          'empty_distance_cm',
          'full_distance_cm',
          'sensor_min_cm',
          'tolerance_cm',
          'diameter_cm',
          'points',
        ].includes(key),
    )
  )
    throw invalid();
  for (const key of ['empty_distance_cm', 'full_distance_cm', 'sensor_min_cm', 'tolerance_cm'] as const) {
    if (
      typeof config[key] !== 'number' ||
      !Number.isFinite(config[key]) ||
      config[key] < 0 ||
      config[key] > 1e6
    )
      throw invalid();
  }
  const height = config.empty_distance_cm - config.full_distance_cm;
  if (height <= 0 || config.full_distance_cm < config.sensor_min_cm || config.tolerance_cm > height * 0.05)
    throw invalid();
  if (geometry === 'horizontal_cylinder') {
    if (
      typeof config.diameter_cm !== 'number' ||
      !Number.isFinite(config.diameter_cm) ||
      config.diameter_cm < height ||
      config.diameter_cm > 1e6 ||
      config.points !== undefined
    )
      throw invalid();
  } else if (config.diameter_cm !== undefined) throw invalid();
  if (geometry === 'calibration') {
    if (!Array.isArray(config.points) || config.points.length < 2 || config.points.length > 100)
      throw invalid();
    let previousHeight = -1,
      previousVolume = -1;
    for (const point of config.points) {
      if (
        !point ||
        Object.keys(point).some((key) => !['height_cm', 'liters'].includes(key)) ||
        typeof point.height_cm !== 'number' ||
        typeof point.liters !== 'number' ||
        !Number.isFinite(point.height_cm) ||
        !Number.isFinite(point.liters) ||
        point.height_cm <= previousHeight ||
        point.liters <= previousVolume ||
        point.height_cm > height ||
        point.liters > capacity
      )
        throw invalid();
      previousHeight = point.height_cm;
      previousVolume = point.liters;
    }
    const first = config.points[0],
      last = config.points.at(-1)!;
    if (first.height_cm !== 0 || first.liters !== 0 || last.height_cm !== height || last.liters !== capacity)
      throw invalid();
  } else if (config.points !== undefined) throw invalid();
  return config;
}

function segment(height: number, diameter: number): number {
  const radius = diameter / 2;
  const h = Math.min(diameter, Math.max(0, height));
  return (
    radius * radius * Math.acos((radius - h) / radius) -
    (radius - h) * Math.sqrt(Math.max(0, 2 * radius * h - h * h))
  );
}

/** Only this backend module converts a configured distance to volume, for snapshot and history. */
export function calculateVolume(
  row: Pick<ReservoirRow, 'geometry' | 'measurement_config' | 'capacity_liters'>,
  distance: unknown,
) {
  const unavailable = (quality: string) => ({
    volume: null,
    nivel: null,
    measurement_quality: quality,
    volume_source: 'backend',
  });
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return unavailable('missing');
  let config: MeasurementConfig | null;
  try {
    config = validateConfiguration(
      row.geometry,
      row.capacity_liters,
      row.measurement_config ? JSON.parse(row.measurement_config) : null,
    );
  } catch {
    return unavailable('configuration_missing');
  }
  if (!config || !row.capacity_liters) return unavailable('configuration_missing');
  const height = config.empty_distance_cm - config.full_distance_cm;
  if (
    distance < config.sensor_min_cm ||
    distance < config.full_distance_cm - config.tolerance_cm ||
    distance > config.empty_distance_cm + config.tolerance_cm
  )
    return unavailable('out_of_range');
  const waterHeight = Math.min(height, Math.max(0, config.empty_distance_cm - distance));
  let volume = (row.capacity_liters * waterHeight) / height;
  if (row.geometry === 'horizontal_cylinder')
    volume =
      (row.capacity_liters * segment(waterHeight, config.diameter_cm!)) /
      segment(height, config.diameter_cm!);
  if (row.geometry === 'calibration') {
    const points = config.points!;
    const index = points.findIndex((point) => point.height_cm >= waterHeight);
    if (index === 0) volume = points[0].liters;
    else {
      const left = points[index - 1],
        right = points[index];
      volume =
        left.liters +
        ((right.liters - left.liters) * (waterHeight - left.height_cm)) / (right.height_cm - left.height_cm);
    }
  }
  volume = Math.min(row.capacity_liters, Math.max(0, volume));
  return {
    volume,
    nivel: (volume / row.capacity_liters) * 100,
    water_height_cm: waterHeight,
    measurement_quality: 'valid',
    volume_source: 'backend',
  };
}

export function configuredReading<T extends { distancia?: unknown; volume?: unknown; nivel?: unknown }>(
  row: ReservoirRow,
  reading: T,
): T {
  if (row.device_type !== 'SM-WU') return reading;
  if (row.geometry === 'reported')
    return { ...reading, measurement_quality: 'reported', volume_source: 'monitorie_or_device' };
  return { ...reading, ...calculateVolume(row, reading.distancia) } as T;
}
