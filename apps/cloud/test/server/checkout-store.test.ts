import { describe, expect, it, vi } from "vitest";
import { PostgresCheckoutSessionStore } from "../../src/server/db/checkout-store.js";
import type { Database } from "../../src/server/db/database.js";

function databaseWithQueries(results: Array<{ rows: unknown[]; rowCount?: number }>) {
  const query = vi.fn(async () => {
    const next = results.shift();
    if (!next) throw new Error("unexpected query");
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  });
  const database = {
    transaction: async (work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }),
    query,
  } as unknown as Database;
  return { database, query };
}

describe("durable checkout session store", () => {
  const now = new Date("2026-08-23T12:00:00Z");

  it("creates one durable attempt while holding the account lock", async () => {
    const { database, query } = databaseWithQueries([
      { rows: [{ stripe_subscription_id: null }] },
      { rows: [] },
      { rows: [], rowCount: 1 },
    ]);
    const store = new PostgresCheckoutSessionStore(database);
    const claim = await store.claim("account-1", "developer", now);
    expect(claim).toMatchObject({ kind: "claimed", plan: "developer" });
    expect(query.mock.calls[0]![0]).toContain("FOR UPDATE");
    expect(query.mock.calls[2]![0]).toContain("INSERT INTO pluma_checkout_sessions");
  });

  it("reuses a valid checkout for the same plan", async () => {
    const { database, query } = databaseWithQueries([
      { rows: [{ stripe_subscription_id: null }] },
      { rows: [{
        plan: "pro", state: "open", attempt_id: "attempt-1",
        previous_stripe_session_id: null, stripe_session_id: "cs_pro",
        checkout_url: "https://checkout.stripe.test/pro",
        expires_at: new Date("2026-08-24T12:00:00Z"),
        lease_expires_at: new Date("2026-08-24T12:00:00Z"),
      }] },
    ]);
    const store = new PostgresCheckoutSessionStore(database);
    await expect(store.claim("account-1", "pro", now)).resolves.toEqual({
      kind: "ready", url: "https://checkout.stripe.test/pro",
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("atomically replaces a valid session when the requested plan changes", async () => {
    const { database, query } = databaseWithQueries([
      { rows: [{ stripe_subscription_id: null }] },
      { rows: [{
        plan: "developer", state: "open", attempt_id: "attempt-old",
        previous_stripe_session_id: null, stripe_session_id: "cs_developer",
        checkout_url: "https://checkout.stripe.test/developer",
        expires_at: new Date("2026-08-24T12:00:00Z"),
        lease_expires_at: new Date("2026-08-24T12:00:00Z"),
      }] },
      { rows: [], rowCount: 1 },
    ]);
    const store = new PostgresCheckoutSessionStore(database);
    const claim = await store.claim("account-1", "scale", now);
    expect(claim).toMatchObject({ kind: "claimed", plan: "scale", previousSessionId: "cs_developer" });
    expect(query.mock.calls[2]![0]).toContain("state = 'creating'");
  });

  it("does not let concurrent callers create a second Stripe session", async () => {
    const { database, query } = databaseWithQueries([
      { rows: [{ stripe_subscription_id: null }] },
      { rows: [{
        plan: "developer", state: "creating", attempt_id: "attempt-live",
        previous_stripe_session_id: null, stripe_session_id: null, checkout_url: null, expires_at: null,
        lease_expires_at: new Date("2026-08-23T12:01:00Z"),
      }] },
    ]);
    const store = new PostgresCheckoutSessionStore(database);
    await expect(store.claim("account-1", "pro", now)).resolves.toEqual({ kind: "busy", plan: "developer" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("recovers a stale lease with the same durable attempt id", async () => {
    const { database } = databaseWithQueries([
      { rows: [{ stripe_subscription_id: null }] },
      { rows: [{
        plan: "developer", state: "creating", attempt_id: "attempt-recover",
        previous_stripe_session_id: "cs_previous", stripe_session_id: null,
        checkout_url: null, expires_at: null,
        lease_expires_at: new Date("2026-08-23T11:59:00Z"),
      }] },
      { rows: [], rowCount: 1 },
    ]);
    const store = new PostgresCheckoutSessionStore(database);
    await expect(store.claim("account-1", "scale", now)).resolves.toEqual({
      kind: "claimed", plan: "developer", attemptId: "attempt-recover", previousSessionId: "cs_previous",
    });
  });

  it("fails closed when the account already has a subscription", async () => {
    const { database, query } = databaseWithQueries([{ rows: [{ stripe_subscription_id: "sub_active" }] }]);
    const store = new PostgresCheckoutSessionStore(database);
    await expect(store.claim("account-1", "developer", now)).resolves.toEqual({ kind: "subscribed" });
    expect(query).toHaveBeenCalledOnce();
  });
});
