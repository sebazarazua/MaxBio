import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient } from './generated/prisma/client.js';
export { MembershipRole } from './generated/prisma/enums.js';

// La API es dueña del ciclo de vida; no hay singleton global compartido con la web.
export function createDatabaseClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 2_000,
      query_timeout: 2_500,
    }),
  });
}
