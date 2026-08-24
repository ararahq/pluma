import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class Database implements Queryable {
  readonly pool: Pool;

  constructor(config: Pick<AppConfig, "databaseUrl" | "databasePoolSize" | "environment" | "databaseTlsMode" | "databaseTlsCa">) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: config.databaseTlsMode === "verify-full"
        ? { rejectUnauthorized: true, ...(config.databaseTlsCa ? { ca: config.databaseTlsCa } : {}) }
        : undefined,
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
