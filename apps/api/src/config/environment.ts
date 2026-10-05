import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  WEB_ORIGIN: z
    .url()
    .default('http://localhost:3000')
    .refine((value) => new URL(value).origin === value),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(180),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(180).default(30),
  SESSION_ACTIVITY_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  DATABASE_URL: z
    .url()
    .refine(
      (url) => URL.canParse(url) && ['postgres:', 'postgresql:'].includes(new URL(url).protocol),
    ),
});

export function validateEnvironment(input: Record<string, unknown>) {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    // Nunca incluir valores: DATABASE_URL puede contener credenciales.
    throw new Error(`Configuración inválida. Revisar: ${fields.join(', ')}.`);
  }
  if (
    result.data.NODE_ENV === 'production' &&
    (!input.WEB_ORIGIN || !result.data.WEB_ORIGIN.startsWith('https://'))
  ) {
    throw new Error('Configuración inválida. Revisar WEB_ORIGIN: HTTPS explícito en producción.');
  }
  if (result.data.SESSION_IDLE_DAYS > result.data.SESSION_ABSOLUTE_DAYS) {
    throw new Error('Configuración inválida. SESSION_IDLE_DAYS supera SESSION_ABSOLUTE_DAYS.');
  }
  return result.data;
}
