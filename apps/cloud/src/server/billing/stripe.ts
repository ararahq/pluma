import Stripe from "stripe";
import { AppError } from "../errors.js";
import { planFromPrice, planGrantsQuota } from "./plans.js";
import type { AccountStore, BillingMutations } from "../store.js";
import type { Account, BillingState, Plan } from "../types.js";
import type { AppConfig } from "../config.js";

export interface CheckoutInput {
  account: Account;
  plan: Exclude<Plan, "free">;
  successUrl: string;
  cancelUrl: string;
}

export type PaidPlan = Exclude<Plan, "free">;

export type CheckoutClaim =
  | { kind: "ready"; url: string }
  | { kind: "subscribed" }
  | { kind: "busy"; plan: PaidPlan }
  | { kind: "claimed"; plan: PaidPlan; attemptId: string; previousSessionId?: string };

export interface CheckoutSessionStore {
  claim(accountId: string, requestedPlan: PaidPlan, now: Date): Promise<CheckoutClaim>;
  complete(input: {
    accountId: string;
    attemptId: string;
    stripeSessionId: string;
    url: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  release(accountId: string, attemptId: string, now: Date): Promise<void>;
}

export interface BillingProvider {
  ready?(): Promise<void>;
  createCheckout(input: CheckoutInput): Promise<string>;
  createPortal(account: Account, returnUrl: string): Promise<string>;
  processWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<void>;
  reconcile(account: Account): Promise<void>;
}

export interface WebhookEventStore {
  claim(eventId: string, eventType: string, providerCreatedAt: Date): Promise<
    { kind: "claimed"; leaseToken: string } | { kind: "completed" } | { kind: "busy" }
  >;
  complete(eventId: string, leaseToken: string): Promise<void>;
  release(eventId: string, leaseToken: string): Promise<void>;
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;
  private catalogValidation?: Promise<void>;
  private catalogValidatedAt = 0;
  private readonly checkoutFlights = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly accounts: AccountStore,
    private readonly events: WebhookEventStore,
    stripe?: Stripe,
    private readonly checkoutSessions?: CheckoutSessionStore,
  ) {
    if (!config.stripeSecretKey) throw new AppError("billing_unavailable", "Billing is not configured", 503);
    if (config.environment === "production" && !accounts.withBillingMutation) {
      throw new AppError("misconfigured", "Durable Stripe billing serialization is not configured", 500);
    }
    this.stripe = stripe ?? new Stripe(config.stripeSecretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  }

  async ready(): Promise<void> {
    if (Date.now() - this.catalogValidatedAt < 5 * 60_000) return;
    if (!this.catalogValidation) {
      const validation = this.validateCatalog().then(() => {
        this.catalogValidatedAt = Date.now();
      });
      this.catalogValidation = validation;
      void validation.then(() => {
        if (this.catalogValidation === validation) this.catalogValidation = undefined;
      }, () => {
        if (this.catalogValidation === validation) this.catalogValidation = undefined;
      });
    }
    return this.catalogValidation;
  }

  async createCheckout(input: CheckoutInput): Promise<string> {
    if (input.account.stripeSubscriptionId) {
      throw new AppError("subscription_exists", "Use the billing portal to change an existing subscription", 409);
    }
    const flightKey = `${input.account.id}:${input.plan}`;
    const current = this.checkoutFlights.get(flightKey);
    if (current) return current;
    const flight = this.createCheckoutDurably(input);
    this.checkoutFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.checkoutFlights.get(flightKey) === flight) this.checkoutFlights.delete(flightKey);
    }
  }

  private async createCheckoutDurably(input: CheckoutInput): Promise<string> {
    await this.ready();
    if (!this.checkoutSessions) throw new AppError("misconfigured", "Durable checkout storage is not configured", 500);

    // A stale creating attempt is recovered with the same attempt id before a
    // new plan is opened. Normally this loop runs once; two passes cover a
    // crash during an earlier cross-plan replacement without creating a second
    // subscription lane at Stripe.
    for (let pass = 0; pass < 3; pass += 1) {
      const claim = await this.checkoutSessions.claim(input.account.id, input.plan, new Date());
      if (claim.kind === "ready") return claim.url;
      if (claim.kind === "subscribed") {
        throw new AppError("subscription_exists", "Use the billing portal to change an existing subscription", 409);
      }
      if (claim.kind === "busy") {
        throw new AppError("billing_unavailable", "A checkout is already being prepared for this account", 503, { retryAfter: 2 });
      }

      try {
        if (claim.previousSessionId) await this.expirePreviousCheckout(claim.previousSessionId);
        const price = this.config.stripePrices[claim.plan];
        if (!price) throw new AppError("misconfigured", `Stripe price for ${claim.plan} is not configured`, 500);
        const session = await this.stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          customer: input.account.stripeCustomerId,
          client_reference_id: input.account.id,
          metadata: { pluma_account_id: input.account.id, pluma_plan: claim.plan },
          subscription_data: { metadata: { pluma_account_id: input.account.id, pluma_plan: claim.plan } },
          allow_promotion_codes: true,
        }, { idempotencyKey: `pluma-checkout-v2:${claim.attemptId}` });
        if (!session.id || !session.url || !session.expires_at) {
          throw new AppError("billing_unavailable", "Stripe did not return a reusable checkout session", 502);
        }
        const saved = await this.checkoutSessions.complete({
          accountId: input.account.id,
          attemptId: claim.attemptId,
          stripeSessionId: session.id,
          url: session.url,
          expiresAt: new Date(session.expires_at * 1_000),
          now: new Date(),
        });
        if (!saved) continue;
        if (claim.plan === input.plan) return session.url;
        // The durable attempt belonged to a request that crashed after talking
        // to Stripe. Recover it first, then replace it with the requested plan.
      } catch (error) {
        await this.checkoutSessions.release(input.account.id, claim.attemptId, new Date());
        throw error;
      }
    }
    throw new AppError("billing_unavailable", "Checkout state changed while the request was being prepared", 503, { retryAfter: 2 });
  }

  async createPortal(account: Account, returnUrl: string): Promise<string> {
    if (!account.stripeCustomerId) throw new AppError("invalid_input", "This account has no Stripe customer", 400);
    const session = await this.stripe.billingPortal.sessions.create({ customer: account.stripeCustomerId, return_url: returnUrl });
    return session.url;
  }

  async processWebhook(rawBody: Uint8Array, signature: string | undefined): Promise<void> {
    if (!signature || !this.config.stripeWebhookSecret) throw new AppError("unauthenticated", "Invalid Stripe webhook signature", 401);
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(Buffer.from(rawBody), signature, this.config.stripeWebhookSecret);
    } catch (cause) {
      throw new AppError("unauthenticated", "Invalid Stripe webhook signature", 401, { cause });
    }
    const claim = await this.events.claim(event.id, event.type, new Date(event.created * 1_000));
    if (claim.kind === "completed") return;
    if (claim.kind === "busy") {
      throw new AppError("billing_unavailable", "Webhook processing is already in progress", 503, { retryAfter: 5 });
    }
    const leaseToken = claim.leaseToken;
    try {
      if (event.type.startsWith("customer.subscription.")) {
        const delivered = event.data.object as Stripe.Subscription;
        const accountMutationKey = typeof delivered.metadata.pluma_account_id === "string"
          ? delivered.metadata.pluma_account_id
          : delivered.id;
        await this.withBillingMutation(accountMutationKey, async (mutations) => {
          // The durable lock spans canonical retrieval and the database write.
          // This is required because Stripe event timestamps have only second
          // precision and two app processes may receive them concurrently.
          const canonical = await this.stripe.subscriptions.retrieve(delivered.id);
          await this.applySubscription(canonical, new Date(event.created * 1_000), mutations.applyEvent);
        });
      }
      await this.events.complete(event.id, leaseToken);
    } catch (error) {
      await this.events.release(event.id, leaseToken);
      throw error;
    }
  }

  async reconcile(account: Account): Promise<void> {
    if (!account.stripeSubscriptionId) return;
    await this.withBillingMutation(account.id, async (mutations) => {
      const subscription = await this.stripe.subscriptions.retrieve(account.stripeSubscriptionId!);
      // Reconciliation repairs canonical state without moving the provider-event
      // cursor into the future and suppressing a legitimate queued webhook.
      await this.applySubscription(subscription, new Date(), (state, _providerUpdatedAt, stripe) => mutations.reconcile(state, stripe));
    });
  }

  private async validateCatalog(): Promise<void> {
    const expected: Readonly<Record<PaidPlan, number>> = { developer: 1_900, pro: 7_900, scale: 24_900 };
    const entries = (Object.entries(expected) as Array<[PaidPlan, number]>).map(([plan, unitAmount]) => {
      const id = this.config.stripePrices[plan];
      if (!id) throw new AppError("misconfigured", `Stripe price for ${plan} is not configured`, 500);
      return { plan, id, unitAmount };
    });
    if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
      throw new AppError("misconfigured", "Stripe price IDs must be distinct for every paid plan", 500);
    }
    let prices: Array<(typeof entries)[number] & { price: Stripe.Price }>;
    try {
      prices = await Promise.all(entries.map(async (entry) => ({
        ...entry,
        price: await this.stripe.prices.retrieve(entry.id),
      })));
    } catch (cause) {
      throw new AppError("billing_unavailable", "Stripe price catalog could not be validated", 503, { cause, retryAfter: 5 });
    }
    for (const { plan, id, unitAmount, price } of prices) {
      const valid = price.id === id
        && price.active
        && price.type === "recurring"
        && price.currency.toLowerCase() === "usd"
        && price.unit_amount === unitAmount
        && price.recurring?.interval === "month"
        && price.recurring.interval_count === 1
        && price.recurring.usage_type === "licensed";
      if (!valid) {
        throw new AppError(
          "misconfigured",
          `Stripe price for ${plan} must be an active USD ${unitAmount} monthly licensed price`,
          500,
        );
      }
    }
  }

  private async expirePreviousCheckout(sessionId: string): Promise<void> {
    let session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") {
      throw new AppError("subscription_exists", "The previous checkout completed; use the billing portal after Stripe confirms it", 409);
    }
    if (session.status !== "open") return;
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
    } catch (cause) {
      // Completion can race the expiration request. Re-read the canonical
      // session and never open another subscription checkout if it won.
      session = await this.stripe.checkout.sessions.retrieve(sessionId);
      if (session.status === "complete") {
        throw new AppError("subscription_exists", "The previous checkout completed; use the billing portal after Stripe confirms it", 409, { cause });
      }
      if (session.status === "open") throw cause;
    }
  }

  private async withBillingMutation<T>(accountId: string, work: (mutations: BillingMutations) => Promise<T>): Promise<T> {
    if (this.accounts.withBillingMutation) return this.accounts.withBillingMutation(accountId, work);
    const fallback: BillingMutations = {
      applyEvent: (state, providerUpdatedAt, stripe) => this.accounts.applyBilling(state, providerUpdatedAt, stripe),
      reconcile: (state, stripe) => this.accounts.applyBilling(state, new Date(0), stripe),
    };
    return work(fallback);
  }

  private async applySubscription(
    subscription: Stripe.Subscription,
    providerUpdatedAt: Date,
    apply: BillingMutations["applyEvent"] = (state, updatedAt, stripe) => this.accounts.applyBilling(state, updatedAt, stripe),
  ): Promise<void> {
    const accountId = typeof subscription.metadata.pluma_account_id === "string" ? subscription.metadata.pluma_account_id : undefined;
    const priceId = subscription.items.data[0]?.price.id;
    if (!accountId || !priceId) throw new AppError("invalid_input", "Stripe subscription is missing Pluma metadata", 400);
    const mappedPlan = planFromPrice(priceId, this.config.stripePrices);
    const periodEndSeconds = subscription.items.data[0]?.current_period_end;
    const currentPeriodEnd = typeof periodEndSeconds === "number" ? new Date(periodEndSeconds * 1_000) : undefined;
    const grantedPlan = planGrantsQuota(subscription.status, new Date(), currentPeriodEnd) ? mappedPlan : "free";
    const state: BillingState = { accountId, plan: grantedPlan, status: subscription.status, currentPeriodEnd };
    const terminal = subscription.status === "canceled" || subscription.status === "incomplete_expired";
    const stripe = {
      customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      subscriptionId: terminal ? null : subscription.id,
      sourceSubscriptionId: subscription.id,
    };
    await apply(state, providerUpdatedAt, stripe);
  }
}
