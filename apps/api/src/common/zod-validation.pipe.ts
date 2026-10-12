import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './app-error';

/** Valida body/query/params con un schema zod y entrega el valor parseado (con defaults). */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Datos inválidos',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }
}

export const zod = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
