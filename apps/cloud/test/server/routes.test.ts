import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createApp, type ServerDependencies } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { AppError } from "../../src/server/errors.js";
import { ReplayCipher } from "../../src/server/security/crypto.js";
import { FairAdmissionScheduler } from "../../src/server/admission.js";
import { DemoGate } from "../../src/server/demo.js";
import { readBoundedBody } from "../../src/server/validation.js";
import type { Account, ApiKeyRecord, IdempotencyClaim, StoredResponse } from "../../src/server/types.js";

const account: Account = { id: "4cf3eb31-a536-4534-8c3d-d79a05bb266a", userId: "user-1", plan: "developer" };
const apiKey: ApiKeyRecord = {
  id: "a31e0b79-51ab-4802-8377-35acc48da9c2", accountId: account.id, prefix: "pluma_live_test",
  digest: "digest", name: "Test", scopes: null, createdAt: new Date("2026-08-23T00:00:00Z"),
};

class MemoryIdempotency {
  private row?: { hash: string; state: "in_progress" | "completed"; response?: StoredResponse };
  claims = 0;
  constructor(private readonly cipher: ReplayCipher) {}
  async claim(input: { requestHash: string }): Promise<IdempotencyClaim> {
    this.claims += 1;
    if (this.row?.hash !== undefined && this.row.hash !== input.requestHash) return { kind: "conflict" };
    if (this.row?.state === "completed") return { kind: "replay", response: this.row.response };
    if (this.row?.state === "in_progress") return { kind: "in_progress" };
    this.row = { hash: input.requestHash, state: "in_progress" };
    return {
      kind: "claimed",
      reservation: { id: "73f86faa-4d91-453f-bc21-300ea2fb0e91", accountId: account.id, month: "2026-08-01", maximumUnits: 200, state: "reserved", expiresAt: new Date(Date.now() + 60_000) },
    };
  }
  async complete(_accountId: string, _route: string, _key: string, _reservationId: string, _units: number, encrypted: Uint8Array): Promise<void> {
    this.row = { hash: this.row!.hash, state: "completed", response: this.cipher.decrypt(encrypted) };
  }
  async fail(): Promise<void> { this.row = undefined; }
  decryptReplay(claim: IdempotencyClaim): StoredResponse | undefined { return claim.response; }
}

function dependencies(options: { authenticated?: boolean; unsafeUrl?: boolean; plan?: Account["plan"] } = {}): ServerDependencies & {
  workerRun: ReturnType<typeof vi.fn>;
  idempotencyMemory: MemoryIdempotency;
  bodyRead: ReturnType<typeof vi.fn>;
  fetchHtmlMock: ReturnType<typeof vi.fn>;
} {
  const config = loadConfig({ NODE_ENV: "test", PLUMA_PUBLIC_ORIGIN: "http://localhost", PLUMA_UNSAFE_DEV_WORKER: "true" });
  const selectedAccount = { ...account, plan: options.plan ?? account.plan };
  const cipher = new ReplayCipher([Buffer.alloc(32, 9).toString("base64")]);
  const idempotencyMemory = new MemoryIdempotency(cipher);
  const bodyRead = vi.fn(readBoundedBody);
  const workerRun = vi.fn(async () => ({
    body: Buffer.from("%PDF-test"), contentType: "application/pdf", units: 1, pageCount: 1, warnings: [],
  }));
  const apiKeys = {
    authenticate: vi.fn(async () => {
      if (options.authenticated === false) throw new AppError("unauthenticated", "A valid API key is required", 401);
      return apiKey;
    }),
    issue: vi.fn(async () => ({ record: apiKey, secret: "pluma_live_once" })),
    revoke: vi.fn(async () => undefined),
  };
  const fetchHtmlMock = options.unsafeUrl
    ? vi.fn(async () => { throw new AppError("unsafe_url", "URL resolves to a blocked network", 400); })
    : vi.fn(async () => ({ bytes: Buffer.from("<main>Hello</main>"), finalUrl: new URL("https://example.com/final"), redirects: 0 }));
  return {
    config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: { handler: vi.fn(async () => new Response()), session: vi.fn(async () => ({ userId: "user-1", email: "dev@example.com" })) },
    apiKeys: apiKeys as never,
    apiKeyStore: {
      insert: vi.fn(), findByPrefix: vi.fn(async () => [apiKey]), list: vi.fn(async () => [apiKey]),
      revoke: vi.fn(async () => true), touch: vi.fn(),
    },
    accounts: {
      byId: vi.fn(async () => selectedAccount), byUserId: vi.fn(async () => selectedAccount), ensureForUser: vi.fn(async () => selectedAccount), applyBilling: vi.fn(async () => true),
    },
    usage: {
      reserve: vi.fn(), finalize: vi.fn(), refund: vi.fn(),
      usage: vi.fn(async () => ({ month: "2026-08-01", usedUnits: 7, reservedUnits: 0, includedUnits: 5_000, operationUnits: { render: 7 } })),
    },
    idempotency: idempotencyMemory,
    requests: {
      record: vi.fn(), recent: vi.fn(async () => [{
        request_id: "request-1", operation: "render", status: "succeeded", units: 1,
        duration_ms: 20, created_at: "2026-08-23T00:00:00.000Z",
      }]),
    },
    replayCipher: cipher,
    worker: { run: workerRun, selfTest: vi.fn(), close: vi.fn() },
    scheduler: new FairAdmissionScheduler(2),
    demoScheduler: new FairAdmissionScheduler(1),
    demoGate: new DemoGate(),
    fetchHtml: fetchHtmlMock,
    readBody: bodyRead,
    workerRun,
    idempotencyMemory,
    bodyRead,
    fetchHtmlMock,
  };
}

const headers = {
  Authorization: "Bearer pluma_live_test_secret_with_enough_entropy",
  "Content-Type": "application/json",
  "Idempotency-Key": "f4d9f58638324b9d9460c89b827ead7f",
};

describe("document routes", () => {
  it("rejects unauthenticated requests before reading or processing a document", async () => {
    const deps = dependencies({ authenticated: false });
    const response = await createApp(deps).request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Secret" }) });
    expect(response.status).toBe(401);
    expect(deps.workerRun).not.toHaveBeenCalled();
    expect(deps.bodyRead).not.toHaveBeenCalled();
    expect(deps.idempotencyMemory.claims).toBe(0);
  });

  it("rejects free accounts before reading or reserving a document", async () => {
    const deps = dependencies({ plan: "free" });
    const response = await createApp(deps).request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Free" }) });
    expect(response.status).toBe(429);
    expect(deps.bodyRead).not.toHaveBeenCalled();
    expect(deps.idempotencyMemory.claims).toBe(0);
    expect(deps.workerRun).not.toHaveBeenCalled();
  });

  it("rejects rate-limited accounts before reading or reserving a document", async () => {
    const deps = dependencies();
    for (let request = 0; request < 60; request += 1) deps.scheduler.preflight(account.id, "developer");
    const response = await createApp(deps).request("/v1/read/pdf", { method: "POST", headers: { ...headers, "Content-Type": "application/pdf" }, body: "%PDF-test" });
    expect(response.status).toBe(429);
    expect(deps.bodyRead).not.toHaveBeenCalled();
    expect(deps.idempotencyMemory.claims).toBe(0);
    expect(deps.workerRun).not.toHaveBeenCalled();
  });

  it("replays a completed response without charging or invoking the worker twice", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    const first = await app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Report" }) });
    const second = await app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Report" }) });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("%PDF-test");
    expect(second.headers.get("X-Pluma-Request-Id")).toBe(first.headers.get("X-Pluma-Request-Id"));
    expect(deps.workerRun).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotency conflict when the payload changes", async () => {
    const deps = dependencies();
    const app = createApp(deps);
    await app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# One" }) });
    const conflict = await app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Two" }) });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  it("returns in-progress for a concurrent duplicate", async () => {
    const deps = dependencies();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    deps.workerRun.mockImplementationOnce(async () => {
      await blocked;
      return { body: Buffer.from("%PDF-test"), contentType: "application/pdf", units: 1, pageCount: 1, warnings: [] };
    });
    const app = createApp(deps);
    const first = app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Concurrent" }) });
    while (deps.workerRun.mock.calls.length === 0) await Promise.resolve();
    const duplicate = await app.request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Concurrent" }) });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("Retry-After")).toBe("2");
    release!();
    expect((await first).status).toBe(200);
  });

  it("returns quota rejection without starting a worker", async () => {
    const deps = dependencies();
    deps.idempotencyMemory.claim = vi.fn(async () => { throw new AppError("quota_exceeded", "Monthly page-unit quota exceeded", 429); });
    const response = await createApp(deps).request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Quota" }) });
    expect(response.status).toBe(429);
    expect(deps.workerRun).not.toHaveBeenCalled();
  });

  it("does not fetch a URL when its quota reservation is rejected", async () => {
    const deps = dependencies();
    deps.idempotencyMemory.claim = vi.fn(async () => { throw new AppError("quota_exceeded", "Monthly page-unit quota exceeded", 429); });
    const response = await createApp(deps).request("/v1/read/url", { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/report" }) });
    expect(response.status).toBe(429);
    expect(deps.fetchHtmlMock).not.toHaveBeenCalled();
    expect(deps.workerRun).not.toHaveBeenCalled();
  });

  it("reserves before fetching and refunds an unsafe URL failure", async () => {
    const deps = dependencies({ unsafeUrl: true });
    const response = await createApp(deps).request("/v1/read/url", { method: "POST", headers, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unsafe_url" } });
    expect(deps.idempotencyMemory.claims).toBe(1);
    expect(deps.fetchHtmlMock).toHaveBeenCalledOnce();
  });

  it("preserves the final pinned URL as worker source metadata", async () => {
    const deps = dependencies();
    const response = await createApp(deps).request("/v1/read/url", { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/redirect" }) });
    expect(response.status).toBe(200);
    expect(deps.workerRun).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: "https://example.com/final" }), expect.anything());
  });

  it("marks private API and document responses as non-cacheable", async () => {
    const deps = dependencies();
    const document = await createApp(deps).request("/v1/render", { method: "POST", headers, body: JSON.stringify({ markdown: "# Private" }) });
    const dashboard = await createApp(dependencies()).request("/api/dashboard", { headers: { Cookie: "session=test" } });
    for (const response of [document, dashboard]) {
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Pragma")).toBe("no-cache");
    }
  });
});

describe("dashboard and billing routes", () => {
  it("serves the SPA index for public product routes", async () => {
    const deps = dependencies();
    deps.config.serveClient = true;
    deps.clientRoot = fileURLToPath(new URL("./fixtures/client", import.meta.url));
    const app = createApp(deps);
    for (const path of ["/", "/pricing", "/pricing/", "/docs/rest", "/forgot-password", "/reset-password/"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toContain("Pluma Cloud fixture");
    }
  });

  it("returns the dashboard contract used by the product client", async () => {
    const response = await createApp(dependencies()).request("/api/dashboard", { headers: { Cookie: "session=test" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: { plan: "developer", email: "dev@example.com" },
      usage: { used: 7, limit: 5_000, operationUnits: { render: 7 } },
      apiKeys: [{ createdAt: "2026-08-23T00:00:00.000Z" }],
      recentRequests: [{ id: "request-1", operation: "render" }],
    });
  });

  it("passes the raw webhook body and signature to billing before acknowledging", async () => {
    const deps = dependencies();
    const processWebhook = vi.fn(async () => undefined);
    deps.billing = { createCheckout: vi.fn(), createPortal: vi.fn(), processWebhook, reconcile: vi.fn() };
    const response = await createApp(deps).request("/api/billing/webhook", {
      method: "POST", headers: { "Stripe-Signature": "signed" }, body: "raw.stripe.body",
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(processWebhook.mock.calls[0]![0] as Uint8Array).toString()).toBe("raw.stripe.body");
    expect(processWebhook.mock.calls[0]![1]).toBe("signed");
  });

  it("sends an existing subscriber to the portal instead of creating a duplicate subscription", async () => {
    const deps = dependencies();
    const subscribed = { ...account, stripeCustomerId: "cus_existing", stripeSubscriptionId: "sub_existing", subscriptionStatus: "active" };
    deps.accounts.ensureForUser = vi.fn(async () => subscribed);
    const createCheckout = vi.fn(async () => "https://checkout.stripe.test/new");
    const createPortal = vi.fn(async () => "https://billing.stripe.test/portal");
    deps.billing = { createCheckout, createPortal, processWebhook: vi.fn(), reconcile: vi.fn() };
    const response = await createApp(deps).request("/api/billing/checkout", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: "session=test" },
      body: JSON.stringify({ plan: "scale" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://billing.stripe.test/portal" });
    expect(createPortal).toHaveBeenCalledOnce();
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("rejects session mutations from a foreign origin", async () => {
    const response = await createApp(dependencies()).request("/api/keys", {
      method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Stolen" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("control-plane body limits", () => {
  it("rejects oversized auth bodies by Content-Length before Better Auth", async () => {
    const deps = dependencies();
    const response = await createApp(deps).request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(70 * 1024) },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(deps.auth.handler).not.toHaveBeenCalled();
  });

  it("rejects oversized chunked auth bodies before Better Auth", async () => {
    const deps = dependencies();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(70 * 1024)); controller.close(); },
    });
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await createApp(deps).fetch(request);
    expect(response.status).toBe(413);
    expect(deps.auth.handler).not.toHaveBeenCalled();
  });

  it("keeps bodyless OAuth callbacks available", async () => {
    const deps = dependencies();
    const response = await createApp(deps).request("/api/auth/callback/github?code=test&state=test");
    expect(response.status).toBe(200);
    expect(deps.auth.handler).toHaveBeenCalledOnce();
  });

  it("rejects oversized keys, checkout, and non-empty portal bodies before side effects", async () => {
    const deps = dependencies();
    const createCheckout = vi.fn(async () => "https://checkout.stripe.test/session");
    const createPortal = vi.fn(async () => "https://billing.stripe.test/portal");
    deps.billing = { createCheckout, createPortal, processWebhook: vi.fn(), reconcile: vi.fn() };
    const app = createApp(deps);
    const origin = { Origin: "http://localhost", "Content-Type": "application/json", Cookie: "session=test" };
    const keys = await app.request("/api/keys", { method: "POST", headers: origin, body: JSON.stringify({ name: "x".repeat(9 * 1024) }) });
    const checkout = await app.request("/api/billing/checkout", { method: "POST", headers: origin, body: JSON.stringify({ plan: "developer", padding: "x".repeat(5 * 1024) }) });
    const portal = await app.request("/api/billing/portal", { method: "POST", headers: origin, body: "{}" });
    expect([keys.status, checkout.status, portal.status]).toEqual([413, 413, 413]);
    expect(deps.apiKeys.issue).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
    expect(createPortal).not.toHaveBeenCalled();
  });
});
