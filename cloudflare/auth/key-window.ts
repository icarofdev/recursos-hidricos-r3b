import { HttpError, now } from '../http';
export function keyId(value: string | undefined): string {
  const id = value ?? 'primary';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
    throw new HttpError(503, 'CONFIGURATION_REQUIRED', 'Serviço ainda não configurado.');
  return id;
}
export function previousKeyActive(until: string | undefined): boolean {
  const deadline = Number(until);
  return (
    /^\d+$/.test(until ?? '') &&
    Number.isSafeInteger(deadline) &&
    deadline > now() &&
    deadline <= now() + 7 * 86400
  );
}
