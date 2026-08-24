import assert from "node:assert/strict"
import test from "node:test"
import { Pluma, PlumaError } from "../dist/index.js"

test("read URL sends auth and a high-entropy idempotency key", async () => {
  let captured
  const client = new Pluma({
    apiKey: "pluma_test_secret",
    baseUrl: "http://localhost:8787",
    idempotencyKey: () => "a".repeat(32),
    fetch: async (url, init) => {
      captured = { url, init }
      return Response.json({ markdown: "# Result", meta: {}, warnings: [], usage: { units: 1 } }, {
        headers: { "X-Pluma-Request-Id": "req_test", "X-Pluma-Units": "1" },
      })
    },
  })

  const result = await client.read({ url: "https://example.com" })
  assert.equal(captured.url, "http://localhost:8787/v1/read/url")
  assert.equal(captured.init.headers.Authorization, "Bearer pluma_test_secret")
  assert.equal(captured.init.headers["Idempotency-Key"], "a".repeat(32))
  assert.equal(result.markdown, "# Result")
  assert.equal(result.requestId, "req_test")
})

test("render returns bytes and metering headers", async () => {
  const client = new Pluma({
    apiKey: "pluma_test_secret",
    baseUrl: "http://127.0.0.1:8787",
    fetch: async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      headers: { "Content-Type": "application/pdf", "X-Pluma-Request-Id": "req_pdf", "X-Pluma-Units": "2" },
    }),
  })
  const result = await client.render({ markdown: "# Hello" })
  assert.deepEqual([...result.pdf], [0x25, 0x50, 0x44, 0x46])
  assert.equal(result.units, 2)
})

test("structured API errors retain retry and request metadata", async () => {
  const client = new Pluma({
    apiKey: "pluma_test_secret",
    baseUrl: "http://localhost:8787",
    fetch: async () => Response.json({ error: { code: "quota_exceeded", message: "Monthly quota reached" }, request_id: "req_quota" }, {
      status: 429,
      headers: { "Retry-After": "60" },
    }),
  })
  await assert.rejects(client.render({ markdown: "# Hello" }), (error) => {
    assert.ok(error instanceof PlumaError)
    assert.equal(error.code, "quota_exceeded")
    assert.equal(error.requestId, "req_quota")
    assert.equal(error.retryAfter, 60)
    return true
  })
})

test("non-local HTTP base URLs are rejected", () => {
  assert.throws(() => new Pluma({ apiKey: "secret", baseUrl: "http://example.com" }), /HTTPS/)
})

test("errors without Retry-After do not invent a zero-second retry", async () => {
  const client = new Pluma({
    apiKey: "pluma_test_secret",
    baseUrl: "http://localhost:8787",
    fetch: async () => Response.json({ error: { code: "invalid_input", message: "Bad input" } }, { status: 400 }),
  })
  await assert.rejects(client.render({ markdown: "# Hello" }), (error) => {
    assert.ok(error instanceof PlumaError)
    assert.equal(error.retryAfter, undefined)
    return true
  })
})
