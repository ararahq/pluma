import { describe, expect, it, vi } from "vitest";
import { PostgresWebhookEventStore } from "../../src/server/db/webhook-store.js";
import type { Database } from "../../src/server/db/database.js";

describe("Postgres webhook processing leases", () => {
  it("reclaims only a stale processing event with matching provider identity", async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => ({ rows: [{ lease_token: values[3] }], rowCount: 1 }));
    const store = new PostgresWebhookEventStore({ query } as unknown as Database);
    const providerCreatedAt = new Date("2026-08-23T12:00:00Z");
    const token = await store.claim("evt_1", "customer.subscription.created", providerCreatedAt);

    expect(token).toMatchObject({ kind: "claimed", leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const sql = query.mock.calls[0]![0].replace(/\s+/g, " ");
    expect(sql).toContain("state = 'processing'");
    expect(sql).toContain("lease_expires_at <= now()");
    expect(sql).toContain("event_type = EXCLUDED.event_type");
    expect(sql).toContain("provider_created_at = EXCLUDED.provider_created_at");
  });

  it("distinguishes completed delivery from a busy live lease", async () => {
    const providerCreatedAt = new Date("2026-08-23T12:00:00Z");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ state: "processing", event_type: "customer.subscription.updated", provider_created_at: providerCreatedAt }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ state: "completed", event_type: "customer.subscription.updated", provider_created_at: providerCreatedAt }], rowCount: 1 });
    const store = new PostgresWebhookEventStore({ query } as unknown as Database);
    await expect(store.claim("evt_1", "customer.subscription.updated", providerCreatedAt)).resolves.toEqual({ kind: "busy" });
    await expect(store.claim("evt_1", "customer.subscription.updated", providerCreatedAt)).resolves.toEqual({ kind: "completed" });
  });

  it("guards completion and release with the active lease token", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const store = new PostgresWebhookEventStore({ query } as unknown as Database);
    await store.complete("evt_1", "lease-current");
    await store.release("evt_1", "lease-current");
    expect(query.mock.calls[0]![0]).toContain("lease_token = $2");
    expect(query.mock.calls[1]![0]).toContain("lease_token = $2");
  });
});
