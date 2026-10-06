import { createDatabaseClient } from '@maxbio/database';
import { validateEnvironment } from '../../config/environment.js';
import { purgeExpiredCatalogReviews } from './application/catalog-review-retention.js';
const environment = validateEnvironment(process.env);
const client = createDatabaseClient(environment.DATABASE_URL);
try {
  console.log(await purgeExpiredCatalogReviews(client));
} catch {
  console.error(
    'No pudimos limpiar las revisiones vencidas. Verificá la conexión y las migraciones.',
  );
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
