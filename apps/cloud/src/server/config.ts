import { AppError } from "./errors.js";
import type { Plan } from "./types.js";

const CANONICAL_QUOTAS: Readonly<Record<Exclude<Plan, "free">, number>> = {
  developer: 5_000,
  pro: 50_000,
  scale: 250_000,
};

const DEFAULTS = {
  port: 8_787,
  workerConcurrency: 2,
  demoConcurrency: 1,
  workerTimeoutMs: 20_000,
  maxUrlRedirects: 3,
  maxUrlCompressedBytes: 2 * 1024 * 1024,
  maxUrlDecodedBytes: 5 * 1024 * 1024,
  idempotencyTtlSeconds: 15 * 60,
  databasePoolSize: 10,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
} as const;

export interface AppConfig {
  environment: "development" | "test" | "production";
  port: number;
  publicOrigin: string;
  databaseUrl: string;
  databasePoolSize: number;
  databaseTlsMode: "disable" | "verify-full";
  databaseTlsCa?: string;
  apiKeyPepper: string;
  idempotencyKeys: string[];
  workerEntry: string;
  workerConcurrency: number;
  demoConcurrency: number;
  workerTimeoutMs: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  unsafeDevWorker: boolean;
  serveClient: boolean;
  trustedProxyHops: number;
  maxUrlRedirects: number;
  maxUrlCompressedBytes: number;
  maxUrlDecodedBytes: number;
  idempotencyTtlSeconds: number;
  quotas: Record<Exclude<Plan, "free">, number>;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePrices: Partial<Record<Exclude<Plan, "free">, string>>;
  betterAuthSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  emailDeliveryUrl?: string;
  emailDeliveryToken?: string;
}

function required(env: NodeJS.ProcessEnv, key: string, production: boolean): string {
  const value = env[key]?.trim();
  if (value) return value;
  if (!production) return `development-${key.toLowerCase()}`;
  throw new AppError("misconfigured", `Missing required environment variable: ${key}`, 500);
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError("misconfigured", `${key} must be an integer between ${min} and ${max}`, 500);
  }
  return value;
}

function quota(env: NodeJS.ProcessEnv, plan: Exclude<Plan, "free">, production: boolean): number {
  const canonical = CANONICAL_QUOTAS[plan];
  const value = integer(env, `PLUMA_QUOTA_${plan.toUpperCase()}`, canonical, 1, canonical);
  if (production && value !== canonical) {
    throw new AppError("misconfigured", `Production quota for ${plan} must be ${canonical}`, 500);
  }
  return value;
}

function publicOrigin(env: NodeJS.ProcessEnv, production: boolean): string {
  const raw = env.PLUMA_PUBLIC_ORIGIN?.trim() || (production ? "" : "http://localhost:5173");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new AppError("misconfigured", "PLUMA_PUBLIC_ORIGIN must be an absolute origin", 500); }
  if ((production && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new AppError("misconfigured", "PLUMA_PUBLIC_ORIGIN must be a clean HTTPS origin in production", 500);
  }
  return parsed.origin;
}

export function loadDatabaseTlsConfig(env: NodeJS.ProcessEnv = process.env): Pick<AppConfig, "databaseTlsMode" | "databaseTlsCa"> {
  const production = env.NODE_ENV === "production";
  const rawMode = env.PLUMA_DATABASE_TLS_MODE?.trim() || (production ? "verify-full" : "disable");
  if (rawMode !== "disable" && rawMode !== "verify-full") {
    throw new AppError("misconfigured", "PLUMA_DATABASE_TLS_MODE must be disable or verify-full", 500);
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new AppError("misconfigured", "DATABASE_URL must be a valid PostgreSQL URL", 500); }
    const conflicting = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"].find((name) => parsed.searchParams.has(name));
    if (conflicting) {
      throw new AppError("misconfigured", `DATABASE_URL must not set ${conflicting}; use PLUMA_DATABASE_TLS_*`, 500);
    }
  }
  const encodedCa = env.PLUMA_DATABASE_TLS_CA_BASE64?.trim();
  let databaseTlsCa: string | undefined;
  if (encodedCa) {
    databaseTlsCa = Buffer.from(encodedCa, "base64").toString("utf8");
    if (!databaseTlsCa.includes("-----BEGIN CERTIFICATE-----")) {
      throw new AppError("misconfigured", "PLUMA_DATABASE_TLS_CA_BASE64 must contain a base64-encoded PEM CA certificate", 500);
    }
  }
  return { databaseTlsMode: rawMode, databaseTlsCa };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const production = environment === "production";
  const unsafeDevWorker = env.PLUMA_UNSAFE_DEV_WORKER === "true";
  if (production && unsafeDevWorker) {
    throw new AppError("misconfigured", "Unsafe document workers cannot run in production", 500);
  }

  const idempotencyKeys = required(env, "PLUMA_IDEMPOTENCY_KEYS", production).split(",").map((key) => key.trim()).filter(Boolean);
  if (production && idempotencyKeys.some((key) => Buffer.from(key, "base64").byteLength !== 32)) {
    throw new AppError("misconfigured", "Every idempotency key must be 32 bytes encoded as base64", 500);
  }
  const idempotencyTtlSeconds = DEFAULTS.idempotencyTtlSeconds;
  const queueTimeoutMs = integer(env, "PLUMA_QUEUE_TIMEOUT_MS", 60_000, 100, idempotencyTtlSeconds * 1_000 - 1);
  const requestTimeoutMs = integer(env, "PLUMA_REQUEST_TIMEOUT_MS", DEFAULTS.requestTimeoutMs, 1_000, 120_000);
  const headersTimeoutMs = integer(env, "PLUMA_HEADERS_TIMEOUT_MS", DEFAULTS.headersTimeoutMs, 1_000, requestTimeoutMs);

  const emailDeliveryUrl = env.PLUMA_EMAIL_DELIVERY_URL?.trim();
  const emailDeliveryToken = env.PLUMA_EMAIL_DELIVERY_TOKEN?.trim();
  if (production && (!emailDeliveryUrl || !emailDeliveryToken || !emailDeliveryUrl.startsWith("https://"))) {
    throw new AppError("misconfigured", "HTTPS email delivery and its server-side token are required in production", 500);
  }
  const stripePrices = {
    developer: env.STRIPE_PRICE_DEVELOPER?.trim(),
    pro: env.STRIPE_PRICE_PRO?.trim(),
    scale: env.STRIPE_PRICE_SCALE?.trim(),
  };
  const configuredStripePrices = Object.values(stripePrices).filter((value): value is string => Boolean(value));
  if (new Set(configuredStripePrices).size !== configuredStripePrices.length) {
    throw new AppError("misconfigured", "Stripe price IDs must be distinct for every paid plan", 500);
  }
  if (production && (!env.STRIPE_SECRET_KEY?.trim() || !env.STRIPE_WEBHOOK_SECRET?.trim() || Object.values(stripePrices).some((value) => !value))) {
    throw new AppError("misconfigured", "Stripe secret, webhook secret, and all paid price IDs are required in production", 500);
  }
  const apiKeyPepper = required(env, "PLUMA_API_KEY_PEPPER", production);
  const betterAuthSecret = env.BETTER_AUTH_SECRET?.trim();
  if (production && (Buffer.byteLength(apiKeyPepper) < 32 || !betterAuthSecret || Buffer.byteLength(betterAuthSecret) < 32 || Buffer.byteLength(emailDeliveryToken ?? "") < 24)) {
    throw new AppError("misconfigured", "Authentication and delivery secrets do not meet production entropy requirements", 500);
  }
  const tls = loadDatabaseTlsConfig(env);

  return {
    environment,
    port: integer(env, "PORT", DEFAULTS.port, 1, 65_535),
    publicOrigin: publicOrigin(env, production),
    databaseUrl: required(env, "DATABASE_URL", production),
    databasePoolSize: integer(env, "PLUMA_DATABASE_POOL_SIZE", DEFAULTS.databasePoolSize, 1, 50),
    ...tls,
    apiKeyPepper,
    idempotencyKeys,
    workerEntry: env.PLUMA_WORKER_ENTRY?.trim() || new URL(import.meta.url.endsWith(".ts") ? "./worker/entry.ts" : "./worker/entry.js", import.meta.url).pathname,
    workerConcurrency: integer(env, "PLUMA_WORKER_CONCURRENCY", DEFAULTS.workerConcurrency, 1, 64),
    demoConcurrency: integer(env, "PLUMA_DEMO_CONCURRENCY", DEFAULTS.demoConcurrency, 1, 4),
    workerTimeoutMs: integer(env, "PLUMA_WORKER_TIMEOUT_MS", DEFAULTS.workerTimeoutMs, 1_000, 120_000),
    queueTimeoutMs,
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs: integer(env, "PLUMA_KEEP_ALIVE_TIMEOUT_MS", DEFAULTS.keepAliveTimeoutMs, 1_000, headersTimeoutMs),
    unsafeDevWorker,
    serveClient: production || env.PLUMA_SERVE_CLIENT === "true",
    trustedProxyHops: integer(env, "PLUMA_TRUSTED_PROXY_HOPS", 0, 0, 10),
    maxUrlRedirects: integer(env, "PLUMA_URL_REDIRECTS", DEFAULTS.maxUrlRedirects, 0, 5),
    maxUrlCompressedBytes: DEFAULTS.maxUrlCompressedBytes,
    maxUrlDecodedBytes: DEFAULTS.maxUrlDecodedBytes,
    idempotencyTtlSeconds,
    quotas: {
      developer: quota(env, "developer", production),
      pro: quota(env, "pro", production),
      scale: quota(env, "scale", production),
    },
    stripeSecretKey: env.STRIPE_SECRET_KEY?.trim(),
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim(),
    stripePrices,
    betterAuthSecret,
    githubClientId: env.GITHUB_CLIENT_ID?.trim(),
    githubClientSecret: env.GITHUB_CLIENT_SECRET?.trim(),
    emailDeliveryUrl,
    emailDeliveryToken,
  };
}

export { CANONICAL_QUOTAS };
