import { describe, expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/server/db/postgres-store.js";
import { ReplayCipher } from "../../src/server/security/crypto.js";
import type { Database } from "../../src/server/db/database.js";

describe("Postgres idempotency crash recovery", () => {
  it("casts API-key touch timestamps so PostgreSQL does not infer an interval", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = { query } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });

    await store.touch("key-1", new Date("2026-08-23T12:00:00Z"));

    expect(query.mock.calls[0]?.[0]).toContain("$2::timestamptz - interval '5 minutes'");
  });

  it("prunes finalized operational rows after their documented retention windows", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Array<{ count?: string }>; rowCount: number }> {
        const normalized = sql.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        if (normalized.startsWith("WITH expired AS")) return { rows: [{ count: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });

    await expect(store.cleanupExpired(new Date("2026-08-23T12:00:00Z"))).resolves.toBe(0);

    expect(statements.some((sql) => sql.includes("DELETE FROM pluma_checkout_sessions") && sql.includes("interval '1 day'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM pluma_usage_reservations") && sql.includes("interval '90 days'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM pluma_webhook_events") && sql.includes("interval '180 days'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM pluma_requests")
      && sql.includes("plan IN ('pro', 'scale')")
      && sql.includes("THEN interval '90 days' ELSE interval '30 days'"))).toBe(true);
  });

  it("refunds an expired in-progress reservation before claiming a replacement", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push(normalized);
        if (normalized.includes("FROM pluma_idempotency WHERE")) {
          return { rows: [{ request_hash: "same", state: "in_progress", reservation_id: "old-reservation", encrypted_response: null, expires_at: new Date(0) }], rowCount: 1 };
        }
        if (normalized.includes("FROM pluma_usage_reservations WHERE id = $1 AND account_id = $2 FOR UPDATE")) {
          return { rows: [{
            id: "old-reservation", account_id: "account-1", month: "2026-08-01", operation: "render",
            maximum_units: 200, final_units: null, state: "reserved", expires_at: new Date(0),
          }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT used_units")) return { rows: [{ used_units: "0", reserved_units: "0" }], rowCount: 1 };
        if (normalized.includes("INSERT INTO pluma_usage_reservations")) {
          return { rows: [{
            id: "new-reservation", account_id: "account-1", month: "2026-08-01", operation: "render",
            maximum_units: 200, final_units: null, state: "reserved", expires_at: new Date(Date.now() + 60_000),
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });

    const claim = await store.claim({
      accountId: "account-1", route: "/v1/render", key: "f4d9f58638324b9d9460c89b827ead7f",
      requestHash: "same", maximumUnits: 200, plan: "developer", expiresAt: new Date(Date.now() + 60_000),
    });

    expect(claim.kind).toBe("claimed");
    const refundIndex = queries.findIndex((sql) => sql.includes("SET state = 'refunded'"));
    const replacementIndex = queries.findIndex((sql) => sql.includes("INSERT INTO pluma_usage_reservations"));
    expect(refundIndex).toBeGreaterThan(-1);
    expect(replacementIndex).toBeGreaterThan(refundIndex);
    expect(queries.some((sql) => sql.includes("reserved_units = GREATEST(0, reserved_units - $3)"))).toBe(true);
  });

  it("uses the remaining quota as a partial URL reservation", async () => {
    let reservedOperation: unknown;
    const client = {
      async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("FROM pluma_idempotency WHERE")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT used_units")) return { rows: [{ used_units: "4993", reserved_units: "0" }], rowCount: 1 };
        if (normalized.includes("INSERT INTO pluma_usage_reservations")) {
          reservedOperation = values[2];
          return { rows: [{
            id: "url-reservation", account_id: "account-1", month: "2026-08-01", operation: values[2],
            maximum_units: values[3], final_units: null, state: "reserved", expires_at: values[4],
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });

    const claim = await store.claim({
      accountId: "account-1", route: "/v1/read/url", key: "f4d9f58638324b9d9460c89b827ead7f",
      requestHash: "url-hash", maximumUnits: 50, plan: "developer", expiresAt: new Date(Date.now() + 60_000),
    });

    expect(claim).toMatchObject({ kind: "claimed", reservation: { maximumUnits: 7 } });
    expect(reservedOperation).toBe("read_url");
  });

  it("serializes billing mutations and keeps reconciliation off the provider event cursor", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
        queries.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 1 };
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });
    await store.withBillingMutation("sub-1", async (mutations) => {
      await mutations.applyEvent(
        { accountId: "account-1", plan: "developer", status: "active" },
        new Date("2026-08-23T12:00:00Z"),
        { customerId: "cus-1", subscriptionId: "sub-1", sourceSubscriptionId: "sub-1" },
      );
      await mutations.reconcile(
        { accountId: "account-1", plan: "free", status: "canceled" },
        { customerId: "cus-1", subscriptionId: "sub-1", sourceSubscriptionId: "sub-1" },
      );
    });

    expect(queries[0]).toContain("pg_advisory_xact_lock");
    expect(queries[0]).toContain("pluma_billing_account");
    expect(queries[1]).toContain("provider_updated_at = $5");
    expect(queries[2]).not.toContain("provider_updated_at");
  });

  it("clears terminal subscription IDs and consumes only checkout rows older than the event", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return { rows: [], rowCount: 1 };
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) } as unknown as Database;
    const store = new PostgresStore(database, new ReplayCipher([Buffer.alloc(32, 1).toString("base64")]), {
      quotas: { developer: 5_000, pro: 50_000, scale: 250_000 },
    });
    const eventTime = new Date("2026-08-23T12:00:00Z");
    await store.withBillingMutation("account-1", async (mutations) => {
      await mutations.applyEvent(
        { accountId: "account-1", plan: "free", status: "canceled" },
        eventTime,
        { customerId: "cus-keep", subscriptionId: null, sourceSubscriptionId: "sub-old" },
      );
    });

    const update = calls.find(({ sql }) => sql.startsWith("UPDATE pluma_accounts"));
    expect(update?.sql).toContain("stripe_customer_id = COALESCE($6, stripe_customer_id)");
    expect(update?.sql).toContain("stripe_subscription_id = $7");
    expect(update?.values[5]).toBe("cus-keep");
    expect(update?.values[6]).toBeNull();
    const consume = calls.find(({ sql }) => sql.startsWith("DELETE FROM pluma_checkout_sessions"));
    expect(consume?.sql).toContain("created_at <= $2");
    expect(consume?.values).toEqual(["account-1", eventTime]);
  });
});
