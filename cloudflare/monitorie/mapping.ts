import type { DeviceType, Env, Reading, SMWAReading, TelemetryUnits } from '../types';
import { HttpError } from '../http';
import { timestampMsToIso, type TelemetrySeries } from './protocol';

type InternalField = 'distancia' | 'nivel' | 'volume' | 'rssi_wifi' | 'vazao' | 'consumo_acumulado';
type Rule = { key: string; sourceUnit: string; multiplier: number };
export type MonitorieMapping = {
  type: DeviceType;
  rules: Partial<Record<InternalField, Rule>>;
  keys: string[];
  required: InternalField[];
};

const fields: Record<
  DeviceType,
  {
    required: InternalField[];
    optional: InternalField[];
    variable: keyof Pick<Env, 'MONITORIE_SMWU_MAPPING' | 'MONITORIE_SMWA_MAPPING'>;
  }
> = {
  'SM-WU': {
    required: ['distancia', 'nivel', 'volume', 'rssi_wifi'],
    optional: [],
    variable: 'MONITORIE_SMWU_MAPPING',
  },
  'SM-WA': {
    required: ['vazao', 'consumo_acumulado', 'rssi_wifi'],
    optional: ['volume'],
    variable: 'MONITORIE_SMWA_MAPPING',
  },
};

const unitScale: Record<InternalField, Record<string, number>> = {
  distancia: { mm: 0.1, cm: 1, m: 100 },
  nivel: { '%': 1 },
  volume: { mL: 0.001, cL: 0.01, L: 1, m3: 1000, 'm³': 1000 },
  rssi_wifi: { dBm: 1 },
  vazao: { 'L/min': 60, 'L/h': 1, 'm3/h': 1000, 'm³/h': 1000 },
  consumo_acumulado: { mL: 0.001, cL: 0.01, L: 1, m3: 1000, 'm³': 1000 },
};

const unitsByType: Record<DeviceType, TelemetryUnits> = {
  'SM-WU': { distancia: 'cm', nivel: '%', volume: 'L', rssi_wifi: 'dBm' },
  'SM-WA': { vazao: 'L/h', consumo_acumulado: 'L', volume: 'L', rssi_wifi: 'dBm' },
};

const notConfigured = () =>
  new HttpError(
    503,
    'MONITORIE_NOT_CONFIGURED',
    'Configure as chaves e unidades confirmadas do dispositivo MonitorIE.',
  );
const invalid = () =>
  new HttpError(503, 'MONITORIE_INVALID_DATA', 'A MonitorIE retornou dados inválidos para exibição.');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * O mapping converte unidades confirmadas pelo operador para o contrato interno canônico.
 * Exemplo: {"consumo_acumulado":{"key":"chave_real","unit":"cL"},...}
 */
export function monitorieMapping(env: Env, type: DeviceType): MonitorieMapping {
  const definition = fields[type];
  const encoded = env[definition.variable];
  if (!encoded || encoded.length > 8192) throw notConfigured();
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw notConfigured();
  }
  if (!object(value)) throw notConfigured();
  const allowed = [...definition.required, ...definition.optional];
  if (Object.keys(value).some((field) => !allowed.includes(field as InternalField))) throw notConfigured();
  const rules: Partial<Record<InternalField, Rule>> = Object.create(null);
  for (const field of allowed) {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      if (definition.required.includes(field)) throw notConfigured();
      continue;
    }
    if (
      !object(raw) ||
      Object.keys(raw).some((key) => !['key', 'unit'].includes(key)) ||
      typeof raw.key !== 'string' ||
      !raw.key.trim() ||
      raw.key !== raw.key.trim() ||
      raw.key.length > 255 ||
      /[,\x00-\x1f]/.test(raw.key) ||
      typeof raw.unit !== 'string' ||
      !Object.hasOwn(unitScale[field], raw.unit)
    )
      throw notConfigured();
    rules[field] = { key: raw.key, sourceUnit: raw.unit, multiplier: unitScale[field][raw.unit] };
  }
  const keys = Object.values(rules).map((rule) => rule.key);
  if (new Set(keys).size !== keys.length) throw notConfigured();
  return { type, rules, keys, required: definition.required };
}

export function monitorieUnits(type: DeviceType): TelemetryUnits {
  return { ...unitsByType[type] };
}

function numeric(value: unknown, multiplier: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  const result = parsed * multiplier;
  if (!Number.isFinite(result)) throw invalid();
  return result;
}

/** Somente timestamps com todas as chaves obrigatórias formam uma leitura. */
export function normalizeMonitorieSeries(
  series: TelemetrySeries,
  mapping: MonitorieMapping,
  id: number,
): (Reading | SMWAReading)[] {
  if (Object.keys(series).some((key) => !mapping.keys.includes(key))) throw invalid();
  const rows = new Map<number, Partial<Record<InternalField, number>>>();
  let points = 0;
  for (const [field, rule] of Object.entries(mapping.rules) as [InternalField, Rule][]) {
    const values = series[rule.key];
    if (!Array.isArray(values)) throw invalid();
    for (const point of values) {
      points++;
      const row = rows.get(point.ts) ?? Object.create(null);
      if (Object.hasOwn(row, field)) throw invalid();
      row[field] = numeric(point.value, rule.multiplier);
      rows.set(point.ts, row);
    }
  }
  const complete = [...rows.entries()]
    .filter(([, row]) => mapping.required.every((field) => Object.hasOwn(row, field)))
    .sort(([left], [right]) => left - right)
    .map(([ts, row]): Reading | SMWAReading => {
      if (mapping.type === 'SM-WA')
        return {
          id,
          vazao: row.vazao!,
          consumo_acumulado: row.consumo_acumulado!,
          volume: row.volume ?? null,
          rssi_wifi: row.rssi_wifi!,
          timestamp: timestampMsToIso(ts),
        };
      return {
        id,
        distancia: row.distancia!,
        nivel: row.nivel!,
        volume: row.volume!,
        rssi_wifi: row.rssi_wifi!,
        timestamp: timestampMsToIso(ts),
      };
    });
  if (points > 0 && complete.length === 0) throw invalid();
  return complete;
}
