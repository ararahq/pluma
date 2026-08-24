import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { REQUIRED_SCHEMA_VERSION } from "../../src/server/db/migrate.js";

describe("server configuration", () => {
  it("defaults the product server to port 8787", () => {
    expect(loadConfig({ NODE_ENV: "test" }).port).toBe(8787);
  });
  it("keeps queue and ingress deadlines bounded", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PLUMA_QUEUE_TIMEOUT_MS: "60000",
      PLUMA_REQUEST_TIMEOUT_MS: "30000",
      PLUMA_HEADERS_TIMEOUT_MS: "15000",
      PLUMA_KEEP_ALIVE_TIMEOUT_MS: "5000",
    });
    expect(config.queueTimeoutMs).toBeLessThan(config.idempotencyTtlSeconds * 1_000);
    expect(config.keepAliveTimeoutMs).toBeLessThanOrEqual(config.headersTimeoutMs);
    expect(config.headersTimeoutMs).toBeLessThanOrEqual(config.requestTimeoutMs);
  });

  it("chooses a TypeScript worker only for a source config module", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.workerEntry).toMatch(/\/worker\/entry\.ts$/);
  });

  it("rejects a queue deadline that could outlive idempotency", () => {
    expect(() => loadConfig({ NODE_ENV: "test", PLUMA_QUEUE_TIMEOUT_MS: "900000" })).toThrow(/PLUMA_QUEUE_TIMEOUT_MS/);
  });

  it("requires the latest operational migration for readiness", () => {
    expect(REQUIRED_SCHEMA_VERSION).toBe("004_operational_retention");
  });

  it("rejects duplicate Stripe price IDs before the server starts", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      STRIPE_PRICE_DEVELOPER: "price_duplicate",
      STRIPE_PRICE_PRO: "price_duplicate",
    })).toThrow(/must be distinct/);
  });

  it("defaults production PostgreSQL to verify-full and accepts a private CA", () => {
    const ca = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";
    const config = loadConfig({
      NODE_ENV: "production", PLUMA_PUBLIC_ORIGIN: "https://pluma.example",
      DATABASE_URL: "postgresql://pluma:secret@db.example/pluma",
      PLUMA_API_KEY_PEPPER: "p".repeat(32), PLUMA_IDEMPOTENCY_KEYS: Buffer.alloc(32, 1).toString("base64"),
      BETTER_AUTH_SECRET: "a".repeat(32), PLUMA_EMAIL_DELIVERY_URL: "https://mail.example/send", PLUMA_EMAIL_DELIVERY_TOKEN: "e".repeat(24),
      PLUMA_DATABASE_TLS_CA_BASE64: Buffer.from(ca).toString("base64"),
      STRIPE_SECRET_KEY: "sk_live_test", STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PRICE_DEVELOPER: "price_dev", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_SCALE: "price_scale",
    });
    expect(config.databaseTlsMode).toBe("verify-full");
    expect(config.databaseTlsCa).toBe(ca);
  });

  it("allows only explicit production TLS disable and rejects URL overrides", () => {
    const base = {
      NODE_ENV: "production", PLUMA_PUBLIC_ORIGIN: "https://pluma.example",
      DATABASE_URL: "postgresql://pluma:secret@db.example/pluma",
      PLUMA_API_KEY_PEPPER: "p".repeat(32), PLUMA_IDEMPOTENCY_KEYS: Buffer.alloc(32, 1).toString("base64"),
      BETTER_AUTH_SECRET: "a".repeat(32), PLUMA_EMAIL_DELIVERY_URL: "https://mail.example/send", PLUMA_EMAIL_DELIVERY_TOKEN: "e".repeat(24),
      STRIPE_SECRET_KEY: "sk_live_test", STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PRICE_DEVELOPER: "price_dev", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_SCALE: "price_scale",
    };
    expect(loadConfig({ ...base, PLUMA_DATABASE_TLS_MODE: "disable" }).databaseTlsMode).toBe("disable");
    expect(() => loadConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}?sslmode=no-verify` })).toThrow(/must not set sslmode/);
  });
});
