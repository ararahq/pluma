import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { StripeBillingProvider } from "../../src/server/billing/stripe.js";

const paidConfig = () => loadConfig({
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_pluma",
  STRIPE_PRICE_DEVELOPER: "price_developer",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_SCALE: "price_scale",
});

function validPrice(id: string) {
  const amounts: Record<string, number> = { price_developer: 1_900, price_pro: 7_900, price_scale: 24_900 };
  return {
    id,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amounts[id],
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
}

describe("Stripe webhook recovery", () => {
  it("deduplicates concurrent checkout creation with a durable attempt", async () => {
    const config = paidConfig();
    const create = vi.fn(async () => ({
      id: "cs_developer", url: "https://checkout.stripe.test/session", expires_at: 1_800_000_000,
    }));
    const stripe = {
      prices: { retrieve: vi.fn(async (id: string) => validPrice(id)) },
      checkout: { sessions: { create } },
    };
    const checkoutSessions = {
      claim: vi.fn().mockResolvedValue({ kind: "claimed", plan: "developer", attemptId: "attempt-1" }),
      complete: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(config, {} as never, {} as never, stripe as never, checkoutSessions as never);
    const input = {
      account: { id: "account-1", userId: "user-1", plan: "free" as const },
      plan: "developer" as const,
      successUrl: "https://pluma.dev/dashboard?checkout=success",
      cancelUrl: "https://pluma.dev/pricing?checkout=cancelled",
    };
    const results = await Promise.all([provider.createCheckout(input), provider.createCheckout(input)]);
    expect(results).toEqual(["https://checkout.stripe.test/session", "https://checkout.stripe.test/session"]);
    expect(create).toHaveBeenCalledOnce();
    expect(checkoutSessions.claim).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![1]).toEqual({ idempotencyKey: "pluma-checkout-v2:attempt-1" });
    expect(checkoutSessions.complete).toHaveBeenCalledOnce();
  });

  it("expires an open checkout before replacing it cross-plan", async () => {
    const config = paidConfig();
    const create = vi.fn(async () => ({
      id: "cs_pro", url: "https://checkout.stripe.test/pro", expires_at: 1_800_000_000,
    }));
    const retrieve = vi.fn(async () => ({ id: "cs_developer", status: "open" }));
    const expire = vi.fn(async () => ({ id: "cs_developer", status: "expired" }));
    const stripe = {
      prices: { retrieve: vi.fn(async (id: string) => validPrice(id)) },
      checkout: { sessions: { create, retrieve, expire } },
    };
    const checkoutSessions = {
      claim: vi.fn(async () => ({ kind: "claimed", plan: "pro", attemptId: "attempt-pro", previousSessionId: "cs_developer" })),
      complete: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(config, {} as never, {} as never, stripe as never, checkoutSessions as never);
    const input = {
      account: { id: "account-1", userId: "user-1", plan: "free" as const },
      plan: "pro" as const,
      successUrl: "https://pluma.dev/dashboard?checkout=success",
      cancelUrl: "https://pluma.dev/pricing?checkout=cancelled",
    };
    await expect(provider.createCheckout(input)).resolves.toBe("https://checkout.stripe.test/pro");
    expect(retrieve).toHaveBeenCalledWith("cs_developer");
    expect(expire).toHaveBeenCalledWith("cs_developer");
    expect(create.mock.calls[0]![0]).toMatchObject({ line_items: [{ price: "price_pro", quantity: 1 }] });
    expect(create.mock.calls[0]![1]).toEqual({ idempotencyKey: "pluma-checkout-v2:attempt-pro" });
  });

  it("refuses replacement when the previous checkout completed before expiration", async () => {
    const config = paidConfig();
    const create = vi.fn();
    const stripe = {
      prices: { retrieve: vi.fn(async (id: string) => validPrice(id)) },
      checkout: { sessions: {
        create,
        retrieve: vi.fn(async () => ({ id: "cs_completed", status: "complete" })),
        expire: vi.fn(),
      } },
    };
    const checkoutSessions = {
      claim: vi.fn(async () => ({ kind: "claimed", plan: "pro", attemptId: "attempt-pro", previousSessionId: "cs_completed" })),
      complete: vi.fn(), release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(config, {} as never, {} as never, stripe as never, checkoutSessions as never);
    await expect(provider.createCheckout({
      account: { id: "account-1", userId: "user-1", plan: "free" },
      plan: "pro", successUrl: "https://pluma.dev/success", cancelUrl: "https://pluma.dev/cancel",
    })).rejects.toMatchObject({ code: "subscription_exists", status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(checkoutSessions.release).toHaveBeenCalledWith("account-1", "attempt-pro", expect.any(Date));
  });

  it("validates and caches all canonical monthly Stripe prices", async () => {
    const retrieve = vi.fn(async (id: string) => validPrice(id));
    const provider = new StripeBillingProvider(
      paidConfig(), {} as never, {} as never, { prices: { retrieve } } as never, {} as never,
    );
    await provider.ready();
    await provider.ready();
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(retrieve).toHaveBeenCalledWith("price_developer");
    expect(retrieve).toHaveBeenCalledWith("price_pro");
    expect(retrieve).toHaveBeenCalledWith("price_scale");
  });

  it("fails closed before checkout when a Stripe price has the wrong amount", async () => {
    const create = vi.fn();
    const stripe = {
      prices: { retrieve: vi.fn(async (id: string) => ({
        ...validPrice(id),
        ...(id === "price_pro" ? { unit_amount: 7_800 } : {}),
      })) },
      checkout: { sessions: { create } },
    };
    const checkoutSessions = { claim: vi.fn(), complete: vi.fn(), release: vi.fn() };
    const provider = new StripeBillingProvider(paidConfig(), {} as never, {} as never, stripe as never, checkoutSessions as never);
    await expect(provider.createCheckout({
      account: { id: "account-1", userId: "user-1", plan: "free" },
      plan: "pro", successUrl: "https://pluma.dev/success", cancelUrl: "https://pluma.dev/cancel",
    })).rejects.toMatchObject({ code: "misconfigured", status: 500 });
    expect(checkoutSessions.claim).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("applies subscription.created from provider metadata without a local subscription id", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      STRIPE_SECRET_KEY: "sk_test_pluma",
      STRIPE_WEBHOOK_SECRET: "whsec_pluma",
      STRIPE_PRICE_DEVELOPER: "price_developer",
    });
    const applyBilling = vi.fn(async () => true);
    const accounts = { applyBilling };
    const events = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, leaseToken: "lease-1" })),
      complete: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const subscription = {
      id: "sub_from_provider",
      customer: "cus_from_provider",
      status: "active",
      metadata: { pluma_account_id: "account-from-metadata" },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const stripe = {
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_created",
          type: "customer.subscription.created",
          created: 1_787_486_400,
          data: { object: subscription },
        })),
      },
      subscriptions: { retrieve: vi.fn(async () => subscription) },
    };

    const provider = new StripeBillingProvider(config, accounts as never, events, stripe as never);
    await provider.processWebhook(Buffer.from("signed payload"), "signature");

    expect(applyBilling).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-from-metadata", plan: "developer", status: "active" }),
      expect.any(Date),
      { customerId: "cus_from_provider", subscriptionId: "sub_from_provider", sourceSubscriptionId: "sub_from_provider" },
    );
    expect(events.complete).toHaveBeenCalledWith("evt_created", "lease-1");
  });

  it("returns a retryable failure while an earlier delivery still owns the lease", async () => {
    const config = loadConfig({ NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_WEBHOOK_SECRET: "whsec_pluma" });
    const stripe = { webhooks: { constructEvent: vi.fn(() => ({ id: "evt_busy", type: "ignored", created: 1, data: { object: {} } })) } };
    const events = { claim: vi.fn(async () => ({ kind: "busy" as const })), complete: vi.fn(), release: vi.fn() };
    const provider = new StripeBillingProvider(config, { applyBilling: vi.fn() } as never, events, stripe as never);
    await expect(provider.processWebhook(Buffer.from("payload"), "signature")).rejects.toMatchObject({
      code: "billing_unavailable",
      status: 503,
      retryAfter: 5,
    });
    expect(events.complete).not.toHaveBeenCalled();
  });

  it("acknowledges only an already completed duplicate", async () => {
    const config = loadConfig({ NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_WEBHOOK_SECRET: "whsec_pluma" });
    const stripe = { webhooks: { constructEvent: vi.fn(() => ({ id: "evt_done", type: "ignored", created: 1, data: { object: {} } })) } };
    const events = { claim: vi.fn(async () => ({ kind: "completed" as const })), complete: vi.fn(), release: vi.fn() };
    const provider = new StripeBillingProvider(config, { applyBilling: vi.fn() } as never, events, stripe as never);
    await expect(provider.processWebhook(Buffer.from("payload"), "signature")).resolves.toBeUndefined();
    expect(events.complete).not.toHaveBeenCalled();
  });

  it("uses canonical Stripe state for same-second out-of-order subscription events", async () => {
    const config = loadConfig({
      NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_WEBHOOK_SECRET: "whsec_pluma",
      STRIPE_PRICE_DEVELOPER: "price_developer",
    });
    const active = {
      id: "sub_same_second", customer: "cus_1", status: "active",
      metadata: { pluma_account_id: "account-1" },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const canonicalCancelled = { ...active, status: "canceled" };
    const constructEvent = vi.fn()
      .mockReturnValueOnce({ id: "evt_old", type: "customer.subscription.updated", created: 1_787_486_400, data: { object: active } })
      .mockReturnValueOnce({ id: "evt_new", type: "customer.subscription.deleted", created: 1_787_486_400, data: { object: canonicalCancelled } });
    const stripe = {
      webhooks: { constructEvent },
      subscriptions: { retrieve: vi.fn(async () => canonicalCancelled) },
    };
    const applyBilling = vi.fn(async () => true);
    let lease = 0;
    const events = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, leaseToken: `lease-${++lease}` })),
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(config, { applyBilling } as never, events, stripe as never);
    await provider.processWebhook(Buffer.from("old"), "signature");
    await provider.processWebhook(Buffer.from("new"), "signature");

    expect(applyBilling).toHaveBeenCalledTimes(2);
    for (const call of applyBilling.mock.calls) expect(call[0]).toMatchObject({ plan: "free", status: "canceled" });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2);
  });

  it("durably serializes concurrent same-second canonical reads and writes", async () => {
    const config = loadConfig({
      NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_WEBHOOK_SECRET: "whsec_pluma",
      STRIPE_PRICE_DEVELOPER: "price_developer",
    });
    const base = {
      id: "sub_concurrent", customer: "cus_1", metadata: { pluma_account_id: "account-1" },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const active = { ...base, status: "active" };
    const canceled = { ...base, status: "canceled" };
    const constructEvent = vi.fn()
      .mockReturnValueOnce({ id: "evt_active", type: "customer.subscription.updated", created: 1_787_486_400, data: { object: active } })
      .mockReturnValueOnce({ id: "evt_canceled", type: "customer.subscription.deleted", created: 1_787_486_400, data: { object: canceled } });
    const trace: string[] = [];
    const retrieve = vi.fn()
      .mockImplementationOnce(async () => { trace.push("retrieve:active"); return active; })
      .mockImplementationOnce(async () => { trace.push("retrieve:canceled"); return canceled; });
    let lane = Promise.resolve();
    const applyEvent = vi.fn(async (state: { status: string }) => { trace.push(`apply:${state.status}`); return true; });
    const accounts = {
      applyBilling: vi.fn(),
      withBillingMutation: vi.fn(async (_subscriptionId: string, work: (mutations: unknown) => Promise<unknown>) => {
        const previous = lane;
        let release!: () => void;
        lane = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await work({ applyEvent, reconcile: vi.fn() });
        } finally {
          release();
        }
      }),
    };
    let lease = 0;
    const events = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, leaseToken: `lease-${++lease}` })),
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(
      config, accounts as never, events, { webhooks: { constructEvent }, subscriptions: { retrieve } } as never,
    );
    await Promise.all([
      provider.processWebhook(Buffer.from("active"), "signature"),
      provider.processWebhook(Buffer.from("canceled"), "signature"),
    ]);

    expect(trace).toEqual(["retrieve:active", "apply:active", "retrieve:canceled", "apply:canceled"]);
    expect(applyEvent.mock.calls.at(-1)?.[0]).toMatchObject({ plan: "free", status: "canceled" });
    expect(accounts.withBillingMutation).toHaveBeenCalledTimes(2);
  });

  it("reconciles canonical state without advancing the provider event cursor", async () => {
    const config = loadConfig({
      NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_PRICE_DEVELOPER: "price_developer",
    });
    const reconcile = vi.fn(async () => true);
    const applyEvent = vi.fn();
    const accounts = {
      applyBilling: vi.fn(),
      withBillingMutation: vi.fn(async (_subscriptionId: string, work: (mutations: unknown) => Promise<unknown>) => work({ applyEvent, reconcile })),
    };
    const subscription = {
      id: "sub_reconcile", customer: "cus_1", status: "active",
      metadata: { pluma_account_id: "account-1" },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const provider = new StripeBillingProvider(
      config, accounts as never, {} as never,
      { subscriptions: { retrieve: vi.fn(async () => subscription) } } as never,
    );
    await provider.reconcile({
      id: "account-1", userId: "user-1", plan: "developer", stripeSubscriptionId: "sub_reconcile",
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", plan: "developer", status: "active" }),
      { customerId: "cus_1", subscriptionId: "sub_reconcile", sourceSubscriptionId: "sub_reconcile" },
    );
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it("keeps active subscriptions exclusive, then clears a terminal subscription for a fresh checkout", async () => {
    const config = { ...paidConfig(), stripeWebhookSecret: "whsec_pluma" };
    let account = {
      id: "account-resubscribe", userId: "user-resubscribe", plan: "free" as const,
      stripeCustomerId: undefined as string | undefined,
      stripeSubscriptionId: undefined as string | undefined,
      subscriptionStatus: undefined as string | undefined,
    };
    let staleCheckoutExists = true;
    const apply = vi.fn(async (state: { plan: "free" | "developer" | "pro" | "scale"; status: string }, identifiers: { customerId?: string; subscriptionId: string | null; sourceSubscriptionId: string }) => {
      account = {
        ...account,
        plan: state.plan,
        stripeCustomerId: identifiers.customerId ?? account.stripeCustomerId,
        stripeSubscriptionId: identifiers.subscriptionId ?? undefined,
        subscriptionStatus: state.status,
      };
      // Mirrors the transactional consumption in PostgresStore.
      staleCheckoutExists = false;
      return true;
    });
    const accounts = {
      applyBilling: vi.fn(),
      withBillingMutation: vi.fn(async (_accountId: string, work: (mutations: unknown) => Promise<unknown>) => work({
        applyEvent: (state: Parameters<typeof apply>[0], _at: Date, identifiers: Parameters<typeof apply>[1]) => apply(state, identifiers),
        reconcile: (state: Parameters<typeof apply>[0], identifiers: Parameters<typeof apply>[1]) => apply(state, identifiers),
      })),
    };
    const subscriptionBase = {
      id: "sub_resubscribe", customer: "cus_preserved", metadata: { pluma_account_id: account.id },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const active = { ...subscriptionBase, status: "active" };
    const canceled = { ...subscriptionBase, status: "canceled" };
    const constructEvent = vi.fn()
      .mockReturnValueOnce({ id: "evt_active", type: "customer.subscription.updated", created: 1_787_486_400, data: { object: active } })
      .mockReturnValueOnce({ id: "evt_canceled", type: "customer.subscription.deleted", created: 1_787_486_401, data: { object: canceled } });
    const retrieveSubscription = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(canceled);
    const create = vi.fn(async () => ({
      id: "cs_fresh", url: "https://checkout.stripe.test/fresh", expires_at: 1_800_000_000,
    }));
    const stripe = {
      webhooks: { constructEvent },
      subscriptions: { retrieve: retrieveSubscription },
      prices: { retrieve: vi.fn(async (id: string) => validPrice(id)) },
      checkout: { sessions: { create } },
    };
    let lease = 0;
    const events = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, leaseToken: `lease-${++lease}` })),
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    };
    const checkoutSessions = {
      claim: vi.fn(async () => {
        expect(staleCheckoutExists).toBe(false);
        return { kind: "claimed", plan: "developer", attemptId: "attempt-fresh" };
      }),
      complete: vi.fn(async () => true), release: vi.fn(async () => undefined),
    };
    const provider = new StripeBillingProvider(config, accounts as never, events, stripe as never, checkoutSessions as never);

    await provider.processWebhook(Buffer.from("active"), "signature");
    expect(account).toMatchObject({ plan: "developer", stripeCustomerId: "cus_preserved", stripeSubscriptionId: "sub_resubscribe" });
    await expect(provider.createCheckout({
      account, plan: "developer", successUrl: "https://pluma.dev/success", cancelUrl: "https://pluma.dev/cancel",
    })).rejects.toMatchObject({ code: "subscription_exists", status: 409 });
    expect(create).not.toHaveBeenCalled();

    await provider.processWebhook(Buffer.from("canceled"), "signature");
    expect(account).toMatchObject({ plan: "free", stripeCustomerId: "cus_preserved", subscriptionStatus: "canceled" });
    expect(account.stripeSubscriptionId).toBeUndefined();
    await expect(provider.createCheckout({
      account, plan: "developer", successUrl: "https://pluma.dev/success", cancelUrl: "https://pluma.dev/cancel",
    })).resolves.toBe("https://checkout.stripe.test/fresh");
    expect(create.mock.calls[0]![0]).toMatchObject({ customer: "cus_preserved", line_items: [{ price: "price_developer", quantity: 1 }] });
  });

  it("clears incomplete_expired during reconciliation while preserving the Stripe customer", async () => {
    const config = loadConfig({
      NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_pluma", STRIPE_PRICE_DEVELOPER: "price_developer",
    });
    const reconcile = vi.fn(async () => true);
    const accounts = {
      applyBilling: vi.fn(),
      withBillingMutation: vi.fn(async (_accountId: string, work: (mutations: unknown) => Promise<unknown>) => work({
        applyEvent: vi.fn(), reconcile,
      })),
    };
    const subscription = {
      id: "sub_expired", customer: "cus_keep", status: "incomplete_expired",
      metadata: { pluma_account_id: "account-expired" },
      items: { data: [{ price: { id: "price_developer" }, current_period_end: 1_790_078_400 }] },
    };
    const provider = new StripeBillingProvider(
      config, accounts as never, {} as never,
      { subscriptions: { retrieve: vi.fn(async () => subscription) } } as never,
    );
    await provider.reconcile({
      id: "account-expired", userId: "user-expired", plan: "free", stripeCustomerId: "cus_keep",
      stripeSubscriptionId: "sub_expired", subscriptionStatus: "incomplete",
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-expired", plan: "free", status: "incomplete_expired" }),
      { customerId: "cus_keep", subscriptionId: null, sourceSubscriptionId: "sub_expired" },
    );
    expect(accounts.withBillingMutation).toHaveBeenCalledWith("account-expired", expect.any(Function));
  });
});
