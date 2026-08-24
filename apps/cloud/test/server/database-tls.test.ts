import { describe, expect, it } from "vitest";
import { Database } from "../../src/server/db/database.js";

describe("PostgreSQL TLS", () => {
  it("passes hostname verification and an optional private CA to pg", async () => {
    const ca = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";
    const database = new Database({
      databaseUrl: "postgresql://pluma:secret@db.example/pluma",
      databasePoolSize: 1,
      environment: "production",
      databaseTlsMode: "verify-full",
      databaseTlsCa: ca,
    });
    expect(database.pool.options.ssl).toEqual({ rejectUnauthorized: true, ca });
    await database.close();
  });

  it("disables TLS only when the resolved mode explicitly says so", async () => {
    const database = new Database({
      databaseUrl: "postgresql://pluma:secret@localhost/pluma",
      databasePoolSize: 1,
      environment: "development",
      databaseTlsMode: "disable",
    });
    expect(database.pool.options.ssl).toBeUndefined();
    await database.close();
  });
});
