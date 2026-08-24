# Deploying Pluma Cloud

Pluma Cloud is a vendor-neutral Node 22 application backed by PostgreSQL. The
production image serves the API and web client and launches every document job
inside a short-lived Linux `bubblewrap` + `prlimit` sandbox.

## Local product stack

```bash
docker compose up -d postgres
docker compose --profile app up --build
```

The `app` profile waits for Postgres, applies every pending numbered migration, then starts the
Cloud process at `http://localhost:8787`. Local Compose explicitly uses the
unsafe development worker. Never copy that flag to production.

## Production prerequisites

- A glibc Linux container runtime that supports user, PID, mount, and network
  namespaces.
- PostgreSQL 17 or a compatible managed PostgreSQL service.
- An HTTPS origin routed to port 8787.
- A transactional-email HTTPS endpoint for verification and password reset.
- Stripe products/prices for Developer, Pro, and Scale, plus a signed webhook at
  `/api/billing/webhook`.

Build the image from the repository root:

```bash
docker build -t pluma-cloud:0.1.0 .
```

Docker's default seccomp profile can block the unprivileged namespace syscalls
used by `bubblewrap`. The release workflow tests the supported container contract:
a non-root, read-only container with every capability dropped, `no-new-privileges`,
an ephemeral `/tmp`, and an explicit seccomp exception for the nested sandbox.
Use the same boundary on a Docker host:

```bash
docker run --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=unconfined \
  --env-file ./pluma-production.env \
  -p 8787:8787 pluma-cloud:0.1.0
```

Do not replace this with `--privileged` or add `SYS_ADMIN`. On Kubernetes, the
equivalent workload must remain non-root/read-only with all capabilities dropped
and must allow the user-namespace operations required by bubblewrap. Confirm the
startup sandbox probe and a real render before routing traffic.

Generate independent secrets; do not reuse them:

```bash
openssl rand -base64 32 # BETTER_AUTH_SECRET
openssl rand -base64 32 # PLUMA_API_KEY_PEPPER
openssl rand -base64 32 # PLUMA_IDEMPOTENCY_KEYS
```

Copy every production variable from `apps/cloud/.env.example`. Production
startup fails closed when the HTTPS origin, auth/email secrets, Stripe webhook,
or any plan price is missing. Rotate replay keys by prepending the new base64
key to `PLUMA_IDEMPOTENCY_KEYS` and retaining the previous key for at least 15
minutes.

Production PostgreSQL connections default to hostname-verifying TLS using the
container's public CA bundle (`PLUMA_DATABASE_TLS_MODE=verify-full`). For a
private database CA, set `PLUMA_DATABASE_TLS_CA_BASE64` to the base64-encoded
PEM certificate. Keep TLS options out of `DATABASE_URL`; Pluma rejects URL-level
SSL parameters so they cannot override certificate verification. An explicit
`PLUMA_DATABASE_TLS_MODE=disable` is supported only for an isolated loopback or
sidecar PostgreSQL network and emits a production warning; never use it across
an untrusted network.

Run migrations before the application:

```bash
npm --workspace @pluma/cloud run migrate:prod
node apps/cloud/dist/server/index.js
```

The migration command needs only `DATABASE_URL` plus the optional pool and TLS
settings (`PLUMA_DATABASE_POOL_SIZE`, `PLUMA_DATABASE_TLS_MODE`, and
`PLUMA_DATABASE_TLS_CA_BASE64`); keep application, email, replay, and Stripe
secrets out of the one-shot migration job.

The image exposes two probes:

- `GET /health` — process liveness.
- `GET /ready` — PostgreSQL connectivity and required migration readiness. It
  deliberately does not call Stripe, so a transient provider outage cannot take
  document APIs out of service.

At startup, production also renders a real PDF inside the sandbox and verifies
that the child cannot read an unbound host file or access the network. The
server refuses traffic if that test fails. Stripe catalog validation is warmed
asynchronously so a provider outage during restart cannot take document traffic
offline. Checkout validates all three prices as distinct, active, licensed
monthly USD prices for exactly $19, $79, and $249, refreshes the cached result
periodically, and fails closed while Stripe or the catalog is unavailable. Run
`npm --workspace @pluma/cloud run validate:stripe:prod` as a one-shot deployment
gate; the release workflow does this before starting the production image.

## Capacity boundary

Pluma Cloud v1 supports exactly one application replica. Its fair queue, account
rate windows, active-job counters, and anonymous-demo daily cap are process-local.
Running multiple replicas would multiply published limits and weaken fairness.
Horizontal scaling requires a shared admission queue and distributed limiter
before adding replicas.

Start with `PLUMA_WORKER_CONCURRENCY=2`. Each active job is a separate native
process with CPU, virtual-memory, output, process, and file-descriptor limits.
Load-test representative PDFs and Markdown before increasing concurrency; keep
the container read-only and preserve `/tmp` as the only writable tmpfs.

## Operations

- Keep the migration job separate and successful before routing traffic.
- Alert on `/ready`, worker self-test failure, HTTP 5xx, queue 429s, Stripe
  webhook failures, and quota reconciliation errors.
- After a webhook outage, run
  `npm --workspace @pluma/cloud run reconcile:stripe:prod`.
- Back up Postgres. Raw document bodies are not stored; request metadata is
  cleaned after 30 days on Developer and 90 days on Pro/Scale. Expired checkout
  sessions are removed after one day, finalized quota reservations after 90 days,
  and completed webhook deduplication records after 180 days. Monthly aggregate
  usage remains the billing ledger.
- Use the Stripe Customer Portal for existing subscribers. The application will
  not create a second Checkout subscription for an account that already has one.
- Abandoned same-plan checkouts reuse their still-valid Stripe session. Switching
  plans expires the previous open session first; a durable database attempt and
  Stripe idempotency key prevent concurrent requests or process crashes from
  creating two subscription lanes.

Publishing packages, configuring DNS, creating Stripe prices, and deploying the
image are deliberately external release actions and are not performed by the
repository build.

## Release workflow secrets

Before creating a GitHub release, configure an npm automation token and a Stripe
test-mode catalog whose amounts match the public plans:

- `NPM_TOKEN`
- `PLUMA_RELEASE_STRIPE_SECRET_KEY`
- `PLUMA_RELEASE_STRIPE_PRICE_DEVELOPER` — $19 USD/month
- `PLUMA_RELEASE_STRIPE_PRICE_PRO` — $79 USD/month
- `PLUMA_RELEASE_STRIPE_PRICE_SCALE` — $249 USD/month

The release job fails before publication if these are missing. It migrates a real
Postgres 17 service, validates the live Stripe catalog as a separate gate, boots
the built image in production mode, waits for schema readiness, runs the
bubblewrap startup probes, serves trailing-
slash SPA routes, and renders a PDF through the HTTP demo endpoint.
