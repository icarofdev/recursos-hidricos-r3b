import { HttpError } from '../http';
export function domainError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('DEVICE_USER_LIMIT'))
    throw new HttpError(
      409,
      'DEVICE_USER_LIMIT',
      'Este dispositivo já tem cinco contas vinculadas. Remova um vínculo para adicionar outra.',
    );
  if (
    /UNIQUE constraint|mutation_guard|CHECK constraint failed: value=1|FOREIGN KEY constraint|MONITORIE_ID_IN_USE/i.test(
      message,
    )
  )
    throw new HttpError(
      409,
      'RESOURCE_CONFLICT',
      'O recurso mudou ou já existe. Atualize e tente novamente.',
    );
  throw error;
}
