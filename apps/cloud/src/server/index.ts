import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { Database } from "./db/database.js";
import { ReplayCipher } from "./security/crypto.js";
import { PostgresStore } from "./db/postgres-store.js";
import { ApiKeyService } from "./security/api-keys.js";
import { createBetterAuthProvider } from "./auth.js";
import { ChildDocumentWorker } from "./worker/launcher.js";
import { FairAdmissionScheduler } from "./admission.js";
import { DemoGate } from "./demo.js";
import { PostgresWebhookEventStore } from "./db/webhook-store.js";
import { PostgresCheckoutSessionStore } from "./db/checkout-store.js";
import { StripeBillingProvider, type BillingProvider } from "./billing/stripe.js";
import { createApp } from "./app.js";
import { resolveClientIp } from "./security/proxy.js";
import { createDatabaseReadinessCheck, validateBillingCatalogAtStartup } from "./readiness.js";

const config = loadConfig();
if (config.environment === "production" && config.databaseTlsMode === "disable") {
  logger.warn("database_tls_explicitly_disabled", { warning: "Only acceptable for an isolated local or sidecar PostgreSQL network" });
}
const database = new Database(config);
const replayCipher = new ReplayCipher(config.idempotencyKeys);
const store = new PostgresStore(database, replayCipher, config);
const apiKeys = new ApiKeyService(store, config.apiKeyPepper);
const auth = createBetterAuthProvider(database.pool, config);
const worker = new ChildDocumentWorker(config);
const scheduler = new FairAdmissionScheduler(config.workerConcurrency, config.queueTimeoutMs);
const demoScheduler = new FairAdmissionScheduler(config.demoConcurrency, config.queueTimeoutMs);
const demoGate = new DemoGate();
const cleanupTimer = setInterval(() => {
  void store.cleanupExpired().catch(() => logger.error("retention_cleanup_failed"));
}, 60_000);
cleanupTimer.unref();
let billing: BillingProvider | undefined;
if (config.stripeSecretKey && config.stripeWebhookSecret) {
  billing = new StripeBillingProvider(
    config,
    store,
    new PostgresWebhookEventStore(database),
    undefined,
    new PostgresCheckoutSessionStore(database),
  );
}

await worker.selfTest();
// Billing must fail closed without making the document data plane depend on
// Stripe availability during a restart. Checkout calls billing.ready() again
// before creating a session; this background warm-up only removes latency from
// the healthy path.
void validateBillingCatalogAtStartup(billing).catch((error) => {
  logger.warn("billing_catalog_warm_failed", {
    cause_name: error instanceof Error ? error.name : "unknown",
    cause_site: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : undefined,
  });
});

const app = createApp({
  config, logger, auth, apiKeys, apiKeyStore: store, accounts: store, usage: store,
  idempotency: store, requests: store, replayCipher, worker, scheduler, demoScheduler,
  demoGate, billing,
  ready: createDatabaseReadinessCheck(database),
  clientIp: (context) => {
    const direct = getConnInfo(context).remote.address ?? "unknown";
    return resolveClientIp(direct, context.req.header("x-forwarded-for"), config.trustedProxyHops);
  },
});

const server = serve({
  fetch: app.fetch,
  port: config.port,
  serverOptions: {
    requestTimeout: config.requestTimeoutMs,
    headersTimeout: config.headersTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
  },
}, (info) => {
  logger.info("server_started", { port: info.port, environment: config.environment });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server_shutdown_started", { signal });
  server.close();
  clearInterval(cleanupTimer);
  await Promise.allSettled([scheduler.close(), demoScheduler.close()]);
  await worker.close();
  await database.close();
  logger.info("server_shutdown_completed");
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

export { app, shutdown };
