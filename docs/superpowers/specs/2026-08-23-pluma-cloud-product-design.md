# Pluma Cloud — Product Design

## Decision

Pluma becomes a global, self-serve developer product for TypeScript teams building
AI agents that read source documents and produce client-facing deliverables.

The category statement is **“The document I/O layer for AI agents.”** The concrete
promise is: **PDFs and web pages in, clean Markdown through, production-ready PDFs
out.** The hosted product complements the MIT library; it does not replace or
cripple local usage.

## ICP and job to be done

Initial ICP: teams of 1–10 developers building research, reporting, proposal,
audit, compliance, diligence, or document-automation agents in TypeScript.

Job: turn an external PDF, HTML document, or URL into clean Markdown, let an agent
work on it, and render the result as a branded PDF without operating parsers,
Chromium, fonts, queues, webhooks, storage, idempotency, or environment-specific
binaries.

The product does not claim OCR-grade extraction for scanned or highly visual PDFs
in v1. It returns explicit warnings for those documents. Advanced OCR is a later,
metered operation.

## Product surface

### 1. Open-source core

- `readPdf` and `readPdfPages` for text-layer PDFs.
- `readHtml` and `readUrl` for web content.
- Existing `renderPdf` for Markdown-to-PDF.
- CLI and MCP tools for read and render.
- Typed metadata and warnings instead of silent quality failure.

### 2. Hosted API

- `POST /v1/read/url` accepts JSON `{ "url": "https://…" }` and returns JSON.
- `POST /v1/read/html` accepts a streamed `text/html` body and returns JSON.
- `POST /v1/read/pdf` accepts a streamed `application/pdf` body and returns JSON.
- `POST /v1/render` accepts `application/json` with
  `{ "markdown": string, "brand"?: CloudBrand }` and returns PDF. JSON is limited
  to 512 KiB decoded, Markdown to 500 KiB UTF-8, and serialized brand data to
  16 KiB. Unknown fields or invalid bounded values return `400 invalid_input`
  before quota reservation.
- The round trip intentionally happens in client code: `read → agent → render`.
- API-key authentication, request IDs, consistent JSON errors, size/time limits,
  and per-plan usage enforcement.
- URL ingestion blocks private networks, loopback, link-local addresses, unsafe
  protocols, redirects to private networks, oversized bodies, and long requests.
- Files are processed ephemerally by default; raw document content is not retained.
- Read responses are `{ markdown, meta, warnings, usage }`. Render succeeds with
  `application/pdf`, `Content-Disposition`, `X-Pluma-Request-Id`, and
  `X-Pluma-Units` headers. All successful endpoints return the request ID header.

### 3. Web product

- Conversion-focused English landing page.
- Live playground above the fold: render bounded Markdown or run curated samples
  without first entering an empty dashboard. Arbitrary URLs and PDFs require an
  account and hosted quota.
- Email/password plus optional GitHub sign-in through self-hosted Better Auth.
- Dashboard with one primary action: run the first document operation.
- API-key management, usage meter, recent request metadata, copyable SDK snippets,
  billing state, and upgrade path.
- Documentation for REST, TypeScript, CLI, MCP, privacy, limits, and deployment.

### 4. Billing and packaging

- Open source: free and unlimited locally.
- Developer: US$19/month.
- Pro: US$79/month and visually recommended.
- Scale: US$249/month. It is a higher-capacity single-owner plan; collaboration is
  not implied in v1.
- One value axis: **page units**. One source PDF page read is one unit; one rendered
  PDF page is one unit; HTML/URL input is one unit per started 100 KiB of decoded
  HTML. Failed, timed-out, unsafe, or scanned-without-text jobs are refunded and
  do not count; idempotent replays are never charged twice.
- Stable included quotas are Developer 5,000, Pro 50,000, and Scale 250,000 page
  units per UTC calendar month. Environment overrides may only reduce quotas in
  development/test; checkout and entitlement tests use the canonical values.
- Stripe Checkout, Customer Portal, and signed webhook processing update local
  entitlements. Without Stripe keys, the app remains fully runnable in explicit
  development mode and never fabricates a paid subscription.
- Advanced OCR and overage are outside v1.

## Activation journey

Target TTV is under five minutes:

1. The visitor sees a real input/output playground, not an illustration.
2. They render a curated sample or bounded Markdown anonymously.
3. The product shows clean Markdown or a downloadable PDF.
4. Only then does it ask them to create an account to save an API key and receive
   hosted quota.
5. The dashboard opens on a populated quickstart with a ready-to-copy TypeScript
   snippet and sample request.

Anonymous demo success is a pre-activation event. Activation starts at account
creation and is the first successful authenticated hosted operation. Retained
activation is three successful operations across two distinct days within the
first week. V1 does not fingerprint visitors or persist an identifier that joins
anonymous demo activity to a later account; demo-to-signup measurement therefore
belongs to an explicitly consented analytics deployment, not the core runtime.

## Architecture

The existing root remains the publishable `@ararahq/pluma` package. The repository
uses one root npm lockfile and npm workspaces. A new `apps/cloud` application uses
Hono on Node for the server and a Vite-built React client for marketing, dashboard,
auth, and documentation. This avoids coupling the native compiler to an edge or
framework-specific runtime.

- Runtime: Node.js 22 on glibc Linux in production. The embedded Typst compiler is
  native and is externalized from the server bundle. Core tests may continue to
  run with Bun; cloud build/test uses Node.
- Database: standard Postgres through `pg`; deployable to any provider.
- Auth: Better Auth with its own Postgres tables and secure HTTP-only sessions.
- Billing: Stripe; provider identifiers are stored locally and entitlements are
  derived from verified webhooks.
- Storage: ephemeral response streaming in v1. Postgres stores only users, hashed
  API keys, request metadata, usage, and billing state.
- Deploy: multi-stage Dockerfile plus Docker Compose for local Postgres. The server
  owns a bounded queue and launches each document operation in a killable child
  process with an empty temporary working directory, a minimal environment,
  restricted Node heap, no accepted caller paths, and hard wall-clock/output
  limits. The image runs as a non-root user with a read-only root filesystem and
  no writable location except its per-job temporary directory. No dependency on
  a specific hosting vendor.

The cloud app imports the root package source during development. `npm run build`
builds core first, then client, server, and document worker. Database migrations
are numbered SQL files recorded in a migration table and run explicitly before
server start. `pg.Pool` is bounded; shutdown stops accepting requests, drains the
worker queue, terminates children, and closes the pool. Default document worker
concurrency is two and is configurable.

### Cloud-safe document contract

The hosted renderer is not the unrestricted local renderer:

- raw `typst` fences are rejected;
- `root`, `fontPaths`, theme functions, local image/logo paths, and arbitrary
  filesystem options are never accepted from API callers;
- cloud brand input is a strict allowlisted schema of colors, paper, margins,
  footer text, and bundled-font names with bounded string/number lengths;
- remote images and network access are not supported in v1;
- Markdown, decoded HTML, PDF input, generated Markdown, generated PDF, page count,
  runtime, memory, and output bytes have hard limits;
- parsing/rendering happens only in the killable child process described above.

Production document workers are launched through Linux `bubblewrap` plus
`prlimit`: new user/PID/network/mount namespaces, no network interface, a minimal
read-only bind containing only the worker bundle/native compiler/fonts, an empty
`tmpfs` work directory, and limits for virtual/native memory, CPU seconds, process
count, file size, and open descriptors. `--die-with-parent` and a wall-clock kill
guarantee cleanup; the tmpfs namespace disappears with the process. The server
performs a startup self-test and refuses production traffic if these controls are
unavailable. macOS and non-Linux local development may use an explicitly labeled
unsafe worker mode, never enabled by default in production.

Anonymous demo traffic uses a distinct endpoint, strict 20 KiB Markdown and
three-page output limits, a concurrency pool separate from paid traffic, IP-based
token bucket limits using trusted-proxy configuration, and a daily cap. Curated
samples remain available if the anonymous compute cap is exhausted. Arbitrary
URL/PDF reads always require an account.

Authenticated admission is fair and plan-aware. Developer receives 2 active jobs
and 60 accepted requests/minute, Pro 10 and 300/minute, Scale 30 and 1,000/minute.
Each account has a bounded pending depth proportional to its concurrency, while a
round-robin scheduler prevents one account from monopolizing global workers.
Overflow returns `429` with `Retry-After`; queued work is cancelled on client
disconnect when processing has not started. Monthly quota remains a separate limit.

## Data model

- Better Auth-managed user/session/account tables.
- `pluma_accounts`: one row per auth user, plan and Stripe identifiers.
- `pluma_api_keys`: prefix, peppered HMAC-SHA-256 digest, name, timestamps,
  revocation.
- `pluma_requests`: request ID, account, operation, status, input/output units,
  duration, warning codes, timestamp; never raw document content.
- `pluma_usage_monthly`: account, UTC month, operation/page totals.
- `pluma_usage_reservations`: atomic preflight reservation, maximum units, final
  units, state, and expiry. Reservation and quota check use one row lock so parallel
  requests cannot overspend. Finalization charges actual units; failure/expiry
  refunds the reservation.
- `pluma_idempotency`: `(account_id, route, key)` identity, request hash, state,
  reservation, encrypted response envelope, created/expiry timestamps.
- `pluma_webhook_events`: Stripe event ID for idempotency.
- `pluma_checkout_sessions`: one durable checkout attempt per account, including
  its short lease, Stripe session, plan, URL, and expiration.

All multi-step usage writes run in transactions. API-key secrets are displayed
once and never stored in plaintext.

Authenticated document POSTs require an `Idempotency-Key` with 128 bits or more
of caller entropy. The key is scoped to account and route. The first request
atomically creates its idempotency row and usage reservation. Reuse with a different
request SHA-256 returns `409 idempotency_conflict`; an in-progress duplicate returns
`409 idempotency_in_progress` plus `Retry-After`; a completed duplicate replays the
original status, headers, and body without charging again. Successful response
envelopes are encrypted with AES-256-GCM under a rotation-capable application key
and retained for 15 minutes, then deleted. This short encrypted replay window is
the only v1 exception to ephemeral output retention; raw inputs are never retained.

## Reliability and error contract

Every API error has `error.code`, `error.message`, `request_id`, and an appropriate
HTTP status. Expected codes include invalid input, unauthenticated, quota exceeded,
unsupported PDF, scanned PDF, unsafe URL, upstream timeout, document too large,
and render failure.

The API records failure metadata without storing input. Streamed byte limits are
enforced while reading; CPU deadlines terminate the child process. Stripe webhooks
require raw-body signature verification. Billing endpoints require an authenticated
session and same-origin/CSRF protection.

URL ingestion normalizes URLs, allows only HTTP(S), rejects credentials and caller
forwarding headers, resolves and classifies IPv4, IPv6, and IPv4-mapped addresses,
pins the validated address for the connection, and repeats validation for every
redirect. Loopback, private, link-local, multicast, documentation, and cloud
metadata ranges are blocked. Redirect count, compressed bytes, decoded bytes,
content type, and duration are bounded.

API keys contain at least 256 bits of entropy, have an indexed SHA-256 digest,
optional operation scope, last-used metadata, and immediate revocation. Better
Auth owns password hashing, session cookies, CSRF/origin checks, email verification,
and reset tokens. Production startup fails closed unless email delivery is
configured. Auth routes also receive IP/account rate limits and non-enumerating
responses.

Stripe price IDs are distinct and map explicitly to the three internal plans.
A one-shot release gate and checkout retrieve all three from Stripe and verify
active, licensed, monthly USD prices of $19, $79, and $249. Runtime readiness is
limited to the core database/schema dependency, so Stripe outages isolate billing
without disabling document traffic. Checkout uses a durable per-account attempt:
same-plan retries reuse a valid session, while a cross-plan request expires the
previous open session before creating its replacement. Webhook events are
inserted uniquely before effects; subscription state transitions accept out-of-
order delivery by comparing provider timestamps. `trialing` and `active` grant
quota; `past_due` and terminal states downgrade immediately. A reconciliation
command repairs missed webhooks from Stripe.

## Testing and acceptance

- Existing core tests remain green.
- Read engines have regression tests for real PDFs/HTML and explicit scan warnings.
- Cloud unit tests cover API-key hashing, quota decisions, SSRF checks, usage
  accounting, plan mapping, and error serialization.
- Route tests cover unauthenticated access, valid operations, quota rejection,
  unsafe URL rejection, quota races, API-key revocation, auth brute-force limits,
  CSRF/origin rejection, idempotent replay/hash conflict/concurrent first request,
  per-account fairness and admission limits, and webhook signature/order/
  reconciliation behavior.
- SSRF tests include redirects, encoded IPv4, IPv6, IPv4-mapped IPv6, link-local
  and metadata endpoints, DNS changes, misleading content types, and compressed or
  decoded size overflow.
- Production worker acceptance tests prove the sandbox has no network, cannot read
  an unbound host file, is terminated at CPU/native-memory/process/file limits, and
  leaves no job directory after exit. Production startup must fail when the sandbox
  self-test fails.
- Production build completes with no TypeScript errors.
- Local smoke test: create account, create key, call render API, receive valid PDF,
  see usage increment, revoke key, observe subsequent 401.
- No repository or GitHub publication is part of this implementation.

## Explicitly out of scope

- General file storage, collaboration, teams/roles, SAML, SCIM, enterprise SSO.
- A proprietary LLM, prompt orchestration, vector database, or RAG framework.
- Visual PDF editing, DOCX/PPTX ingestion, advanced OCR, long-term document
  retention, asynchronous batch queues, or regional SLA.
- Deployment or DNS mutation.

## Privacy and retention

Request bodies, document bytes, generated Markdown/PDF, URL query strings, API-key
secrets, and auth credentials are excluded from application logs, APM attributes,
and error reports. The sole output-retention exception is the encrypted 15-minute
idempotency replay envelope described above. URLs are stored only as origin plus
redacted path metadata when needed for debugging. Request metadata is retained for
30 days on Developer and 90 days on Pro/Scale; aggregate monthly usage is retained for billing records.
Final quota reservations are retained for 90 days, completed webhook event IDs
for 180 days, and expired checkout sessions for one additional day. Aggregate
monthly usage and provider billing identifiers remain the billing ledger. Account
deletion is not exposed as a self-serve v1 workflow and must be handled through
the operator's privacy-request process.

## Commercial gates

- TTV is measured from verified account creation to first successful authenticated
  operation. Five international paying customers and median TTV below five minutes in the
  first 30 days after launch.
- Twenty paid logos and US$1,000 MRR within 90 days.
- Stop expanding product surface if fewer than 2% of 500 activated users pay, if
  weekly repeated use is below 30%, or if variable COGS exceeds 20%.
- Weekly repeated use means at least three successful charged operations on two
  distinct UTC days in a rolling seven-day window. Paid conversion and COGS are
  reported by acquisition cohort and plan, never only as an all-user average.
