import { createRequire } from 'node:module';
import { resolve } from 'node:path';
// Database provisioning is test infrastructure, not an application request. The
// production client's 2-second query limit is deliberately unchanged.
const { Client } = createRequire(resolve('../../packages/database/package.json'))('pg') as {
  Client: new (options: {
    connectionString: string;
    statement_timeout: number;
    query_timeout: number;
  }) => {
    connect(): Promise<void>;
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
  };
};
export const testDatabaseManagement = (connectionString: string) =>
  new Client({ connectionString, statement_timeout: 60000, query_timeout: 65000 });
export async function connectedTestDatabaseManagement(connectionString: string) {
  const client = testDatabaseManagement(connectionString);
  await client.connect();
  return client;
}
