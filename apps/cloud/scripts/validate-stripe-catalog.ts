import { StripeBillingProvider } from "../src/server/billing/stripe.js";
import { loadConfig } from "../src/server/config.js";
import { validateBillingCatalogAtStartup } from "../src/server/readiness.js";

// This is a release/deployment gate, not a runtime readiness probe. It uses the
// same catalog validator as checkout while deliberately avoiding dependencies
// on PostgreSQL, email, or the document worker.
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
if (!config.stripeSecretKey || !config.stripePrices.developer || !config.stripePrices.pro || !config.stripePrices.scale) {
  throw new Error("STRIPE_SECRET_KEY and all three STRIPE_PRICE_* values are required");
}

const billing = new StripeBillingProvider(config, {} as never, {} as never);
await validateBillingCatalogAtStartup(billing);
process.stdout.write(`${JSON.stringify({ ok: true, catalog: "validated" })}\n`);
