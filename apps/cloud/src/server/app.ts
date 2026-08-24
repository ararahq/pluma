import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import type { AppConfig } from "./config.js";
import { AppError, errorBody, toAppError } from "./errors.js";
import type { SafeLogger } from "./logger.js";
import type { AccountStore, IdempotencyStore, RequestMetadataStore, UsageStore } from "./store.js";
import type { ApiKeyStore, ApiKeyService } from "./security/api-keys.js";
import type { AuthProvider } from "./auth.js";
import type { BillingProvider } from "./billing/stripe.js";
import type { DocumentWorker } from "./worker/launcher.js";
import type { Account, DocumentResult, Operation, RequestPrincipal, SessionIdentity, StoredResponse } from "./types.js";
import { BODY_LIMITS, parseRenderInput, parseUrlInput, readBoundedBody, validateHtml, validatePdf } from "./validation.js";
import type { CloudBrand } from "./validation.js";
import { fetchPinnedHtml } from "./security/pinned-http.js";
import { ReplayCipher, sha256, validateIdempotencyKey } from "./security/crypto.js";
import { FairAdmissionScheduler } from "./admission.js";
import type { AdmissionPermit } from "./admission.js";
import { DemoGate } from "./demo.js";

interface Variables {
  requestId: string;
  session: SessionIdentity;
  account: Account;
}

type AppContext = Context<{ Variables: Variables }>;

export interface ServerDependencies {
  config: AppConfig;
  logger: SafeLogger;
  auth: AuthProvider;
  apiKeys: ApiKeyService;
  apiKeyStore: ApiKeyStore;
  accounts: AccountStore;
  usage: UsageStore;
  idempotency: IdempotencyStore;
  requests: RequestMetadataStore;
  replayCipher: ReplayCipher;
  worker: DocumentWorker;
  scheduler: FairAdmissionScheduler;
  demoScheduler: FairAdmissionScheduler;
  demoGate: DemoGate;
  billing?: BillingProvider;
  clientIp?: (context: AppContext) => string;
  fetchHtml?: typeof fetchPinnedHtml;
  readBody?: typeof readBoundedBody;
  clientRoot?: string;
  ready?: () => Promise<void>;
}

const MAX_UNITS: Record<Exclude<Operation, "read_url" | "read_html" | "demo_render">, number> = {
  render: 200,
  read_pdf: 500,
};

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function storedResponse(response: Response, body: Uint8Array): StoredResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, headers, body };
}

function replay(response: StoredResponse): Response {
  return new Response(toArrayBuffer(response.body), { status: response.status, headers: response.headers });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function securityHeaders(config: AppConfig): MiddlewareHandler<{ Variables: Variables }> {
  return async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    context.header("Referrer-Policy", "strict-origin-when-cross-origin");
    context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    context.header("Cross-Origin-Resource-Policy", "same-site");
    context.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (config.environment === "production") context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  };
}

function requireOrigin(config: AppConfig, context: AppContext): void {
  const origin = context.req.header("origin");
  if (origin !== config.publicOrigin) throw new AppError("forbidden", "Invalid request origin", 403);
}

function requireContentType(context: AppContext, expected: string): void {
  const actual = context.req.header("content-type")?.toLowerCase() ?? "";
  if (!actual.startsWith(expected)) throw new AppError("invalid_input", `Content-Type must be ${expected}`, 415);
}

function normalizedAuthRequest(context: AppContext, dependencies: ServerDependencies): Request {
  const headers = new Headers(context.req.raw.headers);
  for (const name of ["forwarded", "x-forwarded-for", "x-real-ip", "x-client-ip", "cf-connecting-ip", "true-client-ip"]) headers.delete(name);
  const clientIp = dependencies.clientIp?.(context);
  if (clientIp && clientIp !== "unknown") headers.set("x-forwarded-for", clientIp);
  return new Request(context.req.raw, { headers });
}

async function sessionAccount(context: AppContext, dependencies: ServerDependencies): Promise<Account> {
  const session = await dependencies.auth.session(context.req.raw.headers);
  if (!session) throw new AppError("unauthenticated", "Sign in is required", 401);
  const account = await dependencies.accounts.ensureForUser(session.userId);
  context.set("session", session);
  context.set("account", account);
  return account;
}

async function apiPrincipal(context: AppContext, dependencies: ServerDependencies, operation: Operation): Promise<RequestPrincipal> {
  const key = await dependencies.apiKeys.authenticate(context.req.header("authorization"), operation);
  const account = await dependencies.accounts.byId(key.accountId);
  if (!account) throw new AppError("unauthenticated", "API key account no longer exists", 401);
  return { account, apiKey: key };
}

async function apiPreflight(context: AppContext, dependencies: ServerDependencies, operation: Operation): Promise<{
  principal: RequestPrincipal;
  idempotencyKey: string;
  permit: AdmissionPermit;
}> {
  const principal = await apiPrincipal(context, dependencies, operation);
  const permit = dependencies.scheduler.preflight(principal.account.id, principal.account.plan);
  const idempotencyKey = validateIdempotencyKey(context.req.header("idempotency-key"));
  return { principal, idempotencyKey, permit };
}

function requestBody(dependencies: ServerDependencies, request: Request, maximumBytes: number): Promise<Uint8Array> {
  return (dependencies.readBody ?? readBoundedBody)(request, maximumBytes);
}

function parseJson(bytes: Uint8Array, message = "Request body must be valid JSON"): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new AppError("invalid_input", message, 400); }
}

function limitedBody(maxSize: number): MiddlewareHandler<{ Variables: Variables }> {
  return bodyLimit({
    maxSize,
    onError: () => { throw new AppError("document_too_large", "Request body exceeds the endpoint limit", 413); },
  });
}

function idempotencyFailure(claim: Awaited<ReturnType<IdempotencyStore["claim"]>>): never {
  if (claim.kind === "conflict") throw new AppError("idempotency_conflict", "Idempotency-Key was already used with a different request", 409);
  throw new AppError("idempotency_in_progress", "An identical request is still in progress", 409, { retryAfter: 2 });
}

interface DocumentExecution {
  operation: Operation;
  route: string;
  input?: Uint8Array;
  requestHashBytes?: Uint8Array;
  maximumUnits: number;
  brand?: CloudBrand;
  jsonOutput: boolean;
  principal?: RequestPrincipal;
  idempotencyKey?: string;
  sourceUrl?: string;
  permit: AdmissionPermit;
  run?: (reservationMaximumUnits: number) => Promise<DocumentResult>;
}

async function executeDocument(context: AppContext, dependencies: ServerDependencies, execution: DocumentExecution): Promise<Response> {
  const startedAt = Date.now();
  const principal = execution.principal ?? await apiPrincipal(context, dependencies, execution.operation);
  const key = execution.idempotencyKey ?? validateIdempotencyKey(context.req.header("idempotency-key"));
  const expiresAt = new Date(Date.now() + dependencies.config.idempotencyTtlSeconds * 1_000);
  const claim = await dependencies.idempotency.claim({
    accountId: principal.account.id,
    route: execution.route,
    key,
    requestHash: sha256(execution.requestHashBytes ?? execution.input ?? new Uint8Array()),
    maximumUnits: execution.maximumUnits,
    plan: principal.account.plan,
    expiresAt,
  });
  if (claim.kind === "replay" && claim.response) return replay(claim.response);
  if (claim.kind !== "claimed" || !claim.reservation) return idempotencyFailure(claim);
  const reservation = claim.reservation;
  let result: DocumentResult;
  let response: Response;
  try {
    result = await dependencies.scheduler.submit(
      principal.account.id,
      principal.account.plan,
      () => execution.run ? execution.run(reservation.maximumUnits) : dependencies.worker.run({
        version: 1,
        requestId: context.get("requestId"),
        operation: execution.operation === "render" ? "render" : execution.operation === "read_pdf" ? "read_pdf" : "read_html",
        inputBase64: Buffer.from(execution.input!).toString("base64"),
        sourceUrl: execution.sourceUrl,
        brand: execution.brand,
        limits: { maxOutputBytes: 25 * 1024 * 1024, maxPages: reservation.maximumUnits },
      }, context.req.raw.signal),
      context.req.raw.signal,
      execution.permit,
    );
    response = documentResponse(result, execution.jsonOutput, context.get("requestId"));
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const encrypted = dependencies.replayCipher.encrypt(storedResponse(response, body));
    await dependencies.idempotency.complete(principal.account.id, execution.route, key, reservation.id, result.units, encrypted);
  } catch (error) {
    await Promise.resolve(dependencies.idempotency.fail(principal.account.id, execution.route, key, reservation.id)).catch(() => undefined);
    await Promise.resolve(dependencies.requests.record({
      requestId: context.get("requestId"), accountId: principal.account.id, operation: execution.operation,
      status: "failed", units: 0, durationMs: Date.now() - startedAt, warningCodes: [],
    })).catch(() => undefined);
    throw error;
  }
  await Promise.resolve(dependencies.requests.record({
    requestId: context.get("requestId"), accountId: principal.account.id, operation: execution.operation,
    status: "succeeded", units: result.units, durationMs: Date.now() - startedAt, warningCodes: result.warnings,
  })).catch(() => dependencies.logger.warn("request_metadata_write_failed", { request_id: context.get("requestId") }));
  return response;
}

function documentResponse(result: DocumentResult, jsonOutput: boolean, requestId: string): Response {
  const headers = { "X-Pluma-Request-Id": requestId, "X-Pluma-Units": String(result.units) };
  if (!jsonOutput) {
    return new Response(toArrayBuffer(result.body), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pluma-${requestId}.pdf"` },
    });
  }
  return jsonResponse({
    markdown: Buffer.from(result.body).toString("utf8"),
    meta: result.meta ?? {},
    warnings: result.warnings,
    usage: { units: result.units },
  }, 200, headers);
}

export function createApp(dependencies: ServerDependencies): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>({ strict: false });
  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    context.set("requestId", requestId);
    context.header("X-Pluma-Request-Id", requestId);
    await next();
  });
  app.use("*", securityHeaders(dependencies.config));
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
  });
  app.use("/v1/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
    context.header("Pragma", "no-cache");
  });
  app.use("/api/auth/*", limitedBody(64 * 1024));
  app.use("/api/keys", limitedBody(8 * 1024));
  app.use("/api/billing/checkout", limitedBody(4 * 1024));
  app.use("/api/billing/portal", limitedBody(0));
  app.use("/api/*", limitedBody(1024 * 1024));
  app.onError((unknownError, context) => {
    const error = toAppError(unknownError);
    const requestId = context.get("requestId") || randomUUID();
    dependencies.logger.error("request_failed", {
      request_id: requestId,
      code: error.code,
      status: error.status,
      cause_name: unknownError instanceof Error ? unknownError.name : "unknown",
      cause_site: unknownError instanceof Error ? unknownError.stack?.split("\n")[1]?.trim() : undefined,
    });
    const headers: Record<string, string> = { "X-Pluma-Request-Id": requestId };
    if (error.retryAfter) headers["Retry-After"] = String(error.retryAfter);
    return jsonResponse(errorBody(error, requestId), error.status, headers);
  });

  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/ready", async (context) => {
    await dependencies.ready?.();
    return context.json({ ok: true });
  });
  app.all("/api/auth/*", (context) => dependencies.auth.handler(normalizedAuthRequest(context, dependencies)));

  app.post("/api/demo/render", async (context) => {
    requireContentType(context, "application/json");
    dependencies.demoGate.admit(dependencies.clientIp?.(context) ?? "unknown");
    const bytes = await requestBody(dependencies, context.req.raw, 24 * 1024);
    const input = parseRenderInput(bytes, true);
    const result = await dependencies.demoScheduler.submit(
      `demo:${dependencies.clientIp?.(context) ?? "unknown"}`,
      "developer",
      () => dependencies.worker.run({
        version: 1, requestId: context.get("requestId"), operation: "render",
        inputBase64: Buffer.from(input.markdown).toString("base64"), brand: input.brand,
        limits: { maxOutputBytes: 2 * 1024 * 1024, maxPages: 3 },
      }, context.req.raw.signal),
      context.req.raw.signal,
    );
    return documentResponse(result, false, context.get("requestId"));
  });

  app.post("/v1/render", async (context) => {
    const preflight = await apiPreflight(context, dependencies, "render");
    requireContentType(context, "application/json");
    const bytes = await requestBody(dependencies, context.req.raw, BODY_LIMITS.json);
    const input = parseRenderInput(bytes);
    return executeDocument(context, dependencies, {
      operation: "render", route: "/v1/render", input: Buffer.from(input.markdown), maximumUnits: MAX_UNITS.render,
      requestHashBytes: bytes, brand: input.brand, jsonOutput: false, ...preflight,
    });
  });

  app.post("/v1/read/html", async (context) => {
    const preflight = await apiPreflight(context, dependencies, "read_html");
    requireContentType(context, "text/html");
    const bytes = validateHtml(await requestBody(dependencies, context.req.raw, BODY_LIMITS.html));
    return executeDocument(context, dependencies, {
      operation: "read_html", route: "/v1/read/html", input: bytes,
      maximumUnits: Math.max(1, Math.ceil(bytes.byteLength / (100 * 1024))), jsonOutput: true, ...preflight,
    });
  });

  app.post("/v1/read/pdf", async (context) => {
    const preflight = await apiPreflight(context, dependencies, "read_pdf");
    requireContentType(context, "application/pdf");
    const bytes = validatePdf(await requestBody(dependencies, context.req.raw, BODY_LIMITS.pdf));
    return executeDocument(context, dependencies, {
      operation: "read_pdf", route: "/v1/read/pdf", input: bytes, maximumUnits: MAX_UNITS.read_pdf, jsonOutput: true, ...preflight,
    });
  });

  app.post("/v1/read/url", async (context) => {
    const preflight = await apiPreflight(context, dependencies, "read_url");
    requireContentType(context, "application/json");
    const raw = await requestBody(dependencies, context.req.raw, 4 * 1024);
    const input = parseUrlInput(raw);
    return executeDocument(context, dependencies, {
      operation: "read_url", route: "/v1/read/url", requestHashBytes: raw,
      maximumUnits: Math.max(1, Math.ceil(dependencies.config.maxUrlDecodedBytes / (100 * 1024))), jsonOutput: true, ...preflight,
      run: async (reservationMaximumUnits) => {
        const fetched = await (dependencies.fetchHtml ?? fetchPinnedHtml)(input.url, {
          redirects: dependencies.config.maxUrlRedirects,
          compressedBytes: dependencies.config.maxUrlCompressedBytes,
          decodedBytes: Math.min(dependencies.config.maxUrlDecodedBytes, reservationMaximumUnits * 100 * 1024),
          timeoutMs: 10_000,
          signal: context.req.raw.signal,
        });
        return dependencies.worker.run({
          version: 1, requestId: context.get("requestId"), operation: "read_html",
          inputBase64: Buffer.from(fetched.bytes).toString("base64"), sourceUrl: fetched.finalUrl.href,
          limits: { maxOutputBytes: 25 * 1024 * 1024, maxPages: reservationMaximumUnits },
        }, context.req.raw.signal);
      },
    });
  });

  app.get("/api/account", async (context) => {
    const account = await sessionAccount(context, dependencies);
    const usage = await dependencies.usage.usage(account.id, account.plan, new Date());
    return context.json({ account: { id: account.id, plan: account.plan, subscription_status: account.subscriptionStatus }, usage });
  });

  app.get("/api/dashboard", async (context) => {
    const account = await sessionAccount(context, dependencies);
    const [usage, keys, recent] = await Promise.all([
      dependencies.usage.usage(account.id, account.plan, new Date()),
      dependencies.apiKeyStore.list(account.id),
      dependencies.requests.recent(account.id, 20),
    ]);
    const reset = new Date();
    reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
    reset.setUTCHours(0, 0, 0, 0);
    return context.json({
      account: {
        plan: account.plan === "free" ? "open-source" : account.plan,
        email: context.get("session").email,
        billingStatus: account.subscriptionStatus ?? "none",
      },
      usage: {
        plan: account.plan === "free" ? "open-source" : account.plan,
        used: usage.usedUnits,
        limit: usage.includedUnits,
        resetsAt: reset.toISOString(),
        operationUnits: usage.operationUnits,
      },
      apiKeys: keys.map((key) => ({
        id: key.id, prefix: key.prefix, name: key.name, scopes: key.scopes ?? undefined,
        createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
      })),
      recentRequests: recent.map((request) => ({
        id: request.request_id,
        operation: request.operation,
        status: request.status,
        units: request.units,
        durationMs: request.duration_ms,
        createdAt: request.created_at,
      })),
    });
  });

  app.get("/api/keys", async (context) => {
    const account = await sessionAccount(context, dependencies);
    const keys = await dependencies.apiKeyStore.list(account.id);
    return context.json({ data: keys.map((key) => ({ id: key.id, prefix: key.prefix, name: key.name, scopes: key.scopes, created_at: key.createdAt, last_used_at: key.lastUsedAt, revoked_at: key.revokedAt })) });
  });

  app.post("/api/keys", async (context) => {
    requireOrigin(dependencies.config, context);
    const account = await sessionAccount(context, dependencies);
    const body = parseJson(await requestBody(dependencies, context.req.raw, 8 * 1024));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AppError("invalid_input", "Request body must be an object", 400);
    const keyInput = body as Record<string, unknown>;
    if (Object.keys(keyInput).some((key) => key !== "name")) throw new AppError("invalid_input", "Unknown API key field", 400);
    const name = keyInput.name;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) throw new AppError("invalid_input", "name must be between 1 and 80 characters", 400);
    const issued = await dependencies.apiKeys.issue(account.id, name.trim());
    return context.json({
      key: {
        id: issued.record.id, prefix: issued.record.prefix, name: issued.record.name,
        scopes: issued.record.scopes ?? undefined, createdAt: issued.record.createdAt.toISOString(),
        lastUsedAt: null, revokedAt: null,
      },
      secret: issued.secret,
    }, 201);
  });

  app.delete("/api/keys/:id", async (context) => {
    requireOrigin(dependencies.config, context);
    const account = await sessionAccount(context, dependencies);
    await dependencies.apiKeys.revoke(account.id, context.req.param("id"));
    return new Response(null, { status: 204 });
  });

  app.get("/api/usage", async (context) => {
    const account = await sessionAccount(context, dependencies);
    const [usage, recent] = await Promise.all([
      dependencies.usage.usage(account.id, account.plan, new Date()),
      dependencies.requests.recent(account.id, 20),
    ]);
    return context.json({ usage, recent });
  });

  app.post("/api/billing/checkout", async (context) => {
    requireOrigin(dependencies.config, context);
    const account = await sessionAccount(context, dependencies);
    if (!dependencies.billing) throw new AppError("billing_unavailable", "Billing is not configured", 503);
    const body = parseJson(await requestBody(dependencies, context.req.raw, 4 * 1024));
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "plan")) {
      throw new AppError("invalid_input", "Checkout body must contain only plan", 400);
    }
    const plan = (body as Record<string, unknown>).plan;
    if (plan !== "developer" && plan !== "pro" && plan !== "scale") throw new AppError("invalid_input", "plan must be developer, pro, or scale", 400);
    if (account.stripeSubscriptionId) {
      const url = await dependencies.billing.createPortal(account, `${dependencies.config.publicOrigin}/pricing`);
      return context.json({ url });
    }
    const url = await dependencies.billing.createCheckout({
      account, plan,
      successUrl: `${dependencies.config.publicOrigin}/dashboard?checkout=success`,
      cancelUrl: `${dependencies.config.publicOrigin}/pricing?checkout=cancelled`,
    });
    return context.json({ url });
  });

  app.post("/api/billing/portal", async (context) => {
    requireOrigin(dependencies.config, context);
    await requestBody(dependencies, context.req.raw, 0);
    const account = await sessionAccount(context, dependencies);
    if (!dependencies.billing) throw new AppError("billing_unavailable", "Billing is not configured", 503);
    const url = await dependencies.billing.createPortal(account, `${dependencies.config.publicOrigin}/dashboard`);
    return context.json({ url });
  });

  app.post("/api/billing/webhook", async (context) => {
    if (!dependencies.billing) throw new AppError("billing_unavailable", "Billing is not configured", 503);
    const rawBody = await requestBody(dependencies, context.req.raw, 1024 * 1024);
    await dependencies.billing.processWebhook(rawBody, context.req.header("stripe-signature"));
    return context.json({ received: true });
  });

  if (dependencies.config.serveClient) {
    const clientRoot = dependencies.clientRoot ?? fileURLToPath(new URL("../../dist/client", import.meta.url));
    app.use("/assets/*", serveStatic({ root: clientRoot }));
    for (const path of [
      "/", "/pricing", "/docs", "/docs/rest", "/docs/typescript", "/docs/cli", "/docs/mcp", "/docs/privacy", "/docs/limits", "/docs/deployment",
      "/sign-in", "/sign-up", "/forgot-password", "/reset-password",
      "/dashboard", "/dashboard/keys", "/dashboard/usage", "/dashboard/billing",
    ]) {
      app.get(path, serveStatic({ root: clientRoot, path: "index.html" }));
    }
  }

  app.notFound((context) => jsonResponse(errorBody(new AppError("not_found", "Route not found", 404), context.get("requestId")), 404));
  return app;
}
