import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Database } from "../src/server/db/database.js";
import { loadDatabaseTlsConfig } from "../src/server/config.js";
import { hmacSha256 } from "../src/server/security/crypto.js";

const baseUrl = new URL(process.env.PLUMA_SMOKE_BASE_URL ?? "http://127.0.0.1:8787");
const databaseUrl = process.env.DATABASE_URL?.trim();
const pepper = process.env.PLUMA_API_KEY_PEPPER?.trim();
if (!databaseUrl || !pepper) throw new Error("DATABASE_URL and PLUMA_API_KEY_PEPPER are required");

const databaseTarget = new URL(databaseUrl);
const databaseName = databaseTarget.pathname.slice(1);
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (!loopback.has(baseUrl.hostname) || !loopback.has(databaseTarget.hostname)) {
  throw new Error("The data-plane smoke may run only against loopback services");
}
if (!databaseName.endsWith("_test") && !databaseName.endsWith("_release")) {
  throw new Error("The data-plane smoke requires an isolated *_test or *_release database");
}

const database = new Database({
  databaseUrl,
  databasePoolSize: 2,
  environment: "test",
  ...loadDatabaseTlsConfig(process.env),
});
const userId = `smoke-${randomUUID()}`;
const email = `${userId}@example.invalid`;
const apiKeyId = randomUUID();
const secret = `pluma_live_${randomBytes(32).toString("base64url")}`;
const prefix = secret.slice(0, "pluma_live_".length + 10);
let accountId: string | undefined;

function idempotencyKey(): string {
  return randomBytes(32).toString("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireStatus(response: Response, status: number, label: string): Promise<void> {
  if (response.status !== status) {
    throw new Error(`${label}: expected ${status}, received ${response.status}: ${await response.text()}`);
  }
}

try {
  await database.transaction(async (client) => {
    await client.query(
      "INSERT INTO pluma_auth_users(id, name, email, email_verified) VALUES ($1, 'Release smoke', $2, true)",
      [userId, email],
    );
    const account = await client.query<{ id: string }>(
      "INSERT INTO pluma_accounts(user_id, plan) VALUES ($1, 'developer') RETURNING id",
      [userId],
    );
    accountId = account.rows[0]!.id;
    await client.query(
      "INSERT INTO pluma_api_keys(id, account_id, prefix, digest, name) VALUES ($1, $2, $3, $4, 'release-smoke')",
      [apiKeyId, accountId, prefix, hmacSha256(secret, pepper)],
    );
  });

  const headers = { Authorization: `Bearer ${secret}` };
  const renderKey = idempotencyKey();
  const renderBody = JSON.stringify({
    markdown: "# Authenticated data-plane smoke\n\nMarkdown to PDF to Markdown.",
    brand: { paper: "letter", primaryColor: "#5b4ee8", footerText: "Pluma release smoke" },
  });
  let response = await fetch(new URL("/v1/render", baseUrl), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": renderKey },
    body: renderBody,
  });
  await requireStatus(response, 200, "authenticated render");
  const pdf = new Uint8Array(await response.arrayBuffer());
  if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") throw new Error("Render did not return PDF bytes");

  response = await fetch(new URL("/v1/render", baseUrl), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": renderKey },
    body: renderBody,
  });
  await requireStatus(response, 200, "idempotent render replay");
  const replay = new Uint8Array(await response.arrayBuffer());
  if (sha256(replay) !== sha256(pdf)) throw new Error("Idempotent replay changed PDF bytes");

  response = await fetch(new URL("/v1/read/pdf", baseUrl), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/pdf", "Idempotency-Key": idempotencyKey() },
    body: pdf,
  });
  await requireStatus(response, 200, "authenticated PDF read");
  const extracted = await response.json() as { markdown?: unknown };
  if (typeof extracted.markdown !== "string" || !extracted.markdown.includes("Authenticated data-plane smoke")) {
    throw new Error("PDF did not round-trip to Markdown");
  }

  const ledger = await database.query<{ used_units: string; reserved_units: string }>(
    "SELECT used_units, reserved_units FROM pluma_usage_monthly WHERE account_id = $1",
    [accountId],
  );
  if (!ledger.rows[0] || Number(ledger.rows[0].used_units) !== 2 || Number(ledger.rows[0].reserved_units) !== 0) {
    throw new Error(`Usage ledger did not settle exactly: ${JSON.stringify(ledger.rows[0])}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, pdfBytes: pdf.byteLength, replaySha256: sha256(replay), usedUnits: 2 })}\n`);
} finally {
  await database.query("DELETE FROM pluma_auth_users WHERE id = $1", [userId]).catch(() => undefined);
  await database.close();
}
