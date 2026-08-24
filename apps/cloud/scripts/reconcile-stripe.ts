import { loadConfig } from "../src/server/config.js";
import { Database } from "../src/server/db/database.js";
import { ReplayCipher } from "../src/server/security/crypto.js";
import { PostgresStore } from "../src/server/db/postgres-store.js";
import { PostgresWebhookEventStore } from "../src/server/db/webhook-store.js";
import { StripeBillingProvider } from "../src/server/billing/stripe.js";
import type { Account, Plan } from "../src/server/types.js";

const config = loadConfig();
const database = new Database(config);
const store = new PostgresStore(database, new ReplayCipher(config.idempotencyKeys), config);
const billing = new StripeBillingProvider(config, store, new PostgresWebhookEventStore(database));

try {
  const result = await database.query<{
    id: string; user_id: string; plan: Plan; stripe_customer_id: string | null; stripe_subscription_id: string;
    subscription_status: string | null; provider_updated_at: Date | null; current_period_end: Date | null;
  }>(`SELECT id, user_id, plan, stripe_customer_id, stripe_subscription_id, subscription_status,
      provider_updated_at, current_period_end FROM pluma_accounts WHERE stripe_subscription_id IS NOT NULL ORDER BY id`);
  const accounts: Account[] = result.rows.map((row) => ({
    id: row.id, userId: row.user_id, plan: row.plan,
    stripeCustomerId: row.stripe_customer_id ?? undefined,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status ?? undefined,
    providerUpdatedAt: row.provider_updated_at ?? undefined,
    currentPeriodEnd: row.current_period_end ?? undefined,
  }));
  let reconciled = 0;
  let failed = 0;
  for (let offset = 0; offset < accounts.length; offset += 5) {
    const batch = accounts.slice(offset, offset + 5);
    const outcomes = await Promise.allSettled(batch.map((account) => billing.reconcile(account)));
    reconciled += outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    failed += outcomes.filter((outcome) => outcome.status === "rejected").length;
  }
  process.stdout.write(`${JSON.stringify({ reconciled, failed })}\n`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await database.close();
}
