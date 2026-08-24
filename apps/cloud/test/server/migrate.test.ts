import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/server/db/migrate.js";
import type { Database } from "../../src/server/db/database.js";

describe("database migrations", () => {
  it("takes one transaction advisory lock before checking migration versions", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const database = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
    } as unknown as Database;

    await migrate(database, resolve(import.meta.dirname, "../../migrations"));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements.findIndex((sql) => sql.includes("SELECT EXISTS"))).toBeGreaterThan(0);
  });
});
