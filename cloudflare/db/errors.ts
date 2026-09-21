import { HttpError } from '../http';
export function domainError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (
    /UNIQUE constraint|mutation_guard|CHECK constraint failed: value=1|FOREIGN KEY constraint/i.test(message)
  )
    throw new HttpError(
      409,
      'RESOURCE_CONFLICT',
      'O recurso mudou ou já existe. Atualize e tente novamente.',
    );
  throw error;
}
