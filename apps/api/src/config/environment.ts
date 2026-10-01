import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().min(1).default('127.0.0.1'),
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
  return result.data;
}
