import { HttpError } from '../http';
import type { DeviceType } from '../types';

export function normalizeMac(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32)
    throw new HttpError(422, 'INVALID_MAC', 'Informe um MAC address válido.');
  const input = value.trim();
  if (
    !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(input) &&
    !/^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/i.test(input) &&
    !/^[0-9a-f]{12}$/i.test(input)
  )
    throw new HttpError(422, 'INVALID_MAC', 'Informe um MAC address válido.');
  return input.replace(/[:-]/g, '').toUpperCase().match(/.{2}/g)!.join(':');
}

export function codeFromMac(type: DeviceType, mac: string): string {
  return `${type.replace('-', '')}-${mac.replace(/:/g, '')}`;
}
