# Pluma Cloud — Implementation Plan

## Constraints

- Work only inside `/Users/micaelmarques/git/arara/pluma`.
- Preserve `.claude/` and both external feature worktrees unchanged.
- Do not push, publish, deploy, or mutate GitHub.
- Keep the root `@ararahq/pluma` package publishable.
- Use one npm lockfile and Node 22 for cloud code.

## Phase 1 — Core document I/O

1. Transfer the staged read-engine source and integration changes from
   `/Users/micaelmarques/git/arara/.wt-pluma-read` into the main worktree while
   leaving corpus-only fixtures out of the product package.
2. Reconcile `package.json`, `src/index.ts`, `src/mcp.ts`, `bin/pluma.ts`, README,
   license notices, and core tests.
3. Add cloud-safe render validation and page-unit helpers without changing the
   unrestricted local API.
4. Run core typecheck, tests, build, and focused real-document regressions.

## Phase 2 — Cloud foundation

1. Add `apps/cloud` npm workspace with Hono, React/Vite, Better Auth, Postgres,
   Stripe, server/client/worker build boundaries, and Vitest.
2. Add typed configuration with production fail-closed checks.
3. Add numbered SQL migrations for accounts, API keys, request metadata, usage,
   reservations, idempotency, and Stripe events.
4. Implement auth integration, email delivery contract, API-key creation/list/
   revocation, plan definitions, and dashboard session protection.

## Phase 3 — Hosted operations and safety

1. Implement structured errors, request IDs, strict request schemas, byte limits,
   API-key auth/scopes, and safe cloud brand validation.
2. Implement atomic quota reservation/finalization/refund and idempotent encrypted
   response replay.
3. Implement per-account token buckets, concurrency, fair queue admission, and
   cancellation.
4. Implement URL SSRF defenses with pinned resolution and redirect revalidation.
5. Implement render/PDF/HTML/URL worker protocol and Linux bubblewrap/prlimit
   launcher with explicit unsafe local development mode.
6. Add `/v1/read/url`, `/v1/read/html`, `/v1/read/pdf`, `/v1/render`, and the
   separately limited anonymous demo endpoint.

## Phase 4 — Revenue product experience

1. Build the English landing page around the concrete round-trip promise and a
   working Markdown playground.
2. Build sign-up/sign-in, populated dashboard quickstart, API-key management,
   usage meter, request history, and copyable TypeScript/cURL snippets.
3. Build pricing with Developer US$19, recommended Pro US$79, Scale US$249.
4. Implement Stripe checkout, customer portal, verified webhooks, entitlement
   lifecycle, and reconciliation command.
5. Add REST/SDK/CLI/MCP docs, privacy/security/limits pages, `.env.example`, and
   local Docker/Postgres setup.

## Phase 5 — Verification

1. Unit-test security and business-critical modules: brand validation, API keys,
   quotas, idempotency, rate limits, fair admission, SSRF, billing transitions,
   error contract, and privacy redaction.
2. Route-test authentication, successful operations, invalid content, unsafe URLs,
   quota races, revocation, webhook failure/order, and demo limits.
3. Run lint/typecheck/test/build for core and cloud.
4. Start local Postgres/product, execute the documented account→key→render→usage→
   revoke smoke path, and inspect the UI at desktop/mobile sizes.
5. Review the complete diff for accidental secrets, generated artifacts, unrelated
   files, and remaining product-blocking placeholders.
