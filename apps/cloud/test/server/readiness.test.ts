import { describe, expect, it, vi } from "vitest";
import { REQUIRED_SCHEMA_VERSION } from "../../src/server/db/migrate.js";
import { createDatabaseReadinessCheck, validateBillingCatalogAtStartup } from "../../src/server/readiness.js";

describe("billing validation and runtime readiness", () => {
  it("validates the billing catalog for warm-up and release gates", async () => {
    const ready = vi.fn(async () => undefined);

    await validateBillingCatalogAtStartup({ ready });

    expect(ready).toHaveBeenCalledOnce();
  });

  it("lets the one-shot release gate fail closed when catalog validation fails", async () => {
    const outage = new Error("Stripe unavailable");

    await expect(validateBillingCatalogAtStartup({
      ready: vi.fn(async () => { throw outage; }),
    })).rejects.toBe(outage);
  });

  it("checks only PostgreSQL schema readiness at runtime", async () => {
    const query = vi.fn(async () => ({ rows: [{ version: REQUIRED_SCHEMA_VERSION }], rowCount: 1 }));
    const check = createDatabaseReadinessCheck({ query });

    await expect(check()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      "SELECT version FROM pluma_schema_migrations WHERE version = $1",
      [REQUIRED_SCHEMA_VERSION],
    );
  });

  it("fails runtime readiness when the required migration is missing", async () => {
    const check = createDatabaseReadinessCheck({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    });

    await expect(check()).rejects.toThrow("Required database migration is not applied");
  });
});
