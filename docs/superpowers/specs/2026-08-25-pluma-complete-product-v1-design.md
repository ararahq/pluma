# Pluma Complete Product v1

**Status:** approved product contract
**Commercial definition:** Pluma is the context and export engine for datasets too large for AI.
**Promise:** import, understand, query, verify, and export large datasets within explicit memory and token budgets.

## 1. Product, not format

The user buys the complete workflow:

```text
CSV / XLSX / Parquet / row stream
  -> progressive compile
  -> open .pluma context
  -> exact structured execution
  -> reproducible evidence
  -> CSV / XLSX / Parquet artifact
```

The `.pluma` package is the open, portable mechanism behind this workflow. It is not the headline. Markdown-to-PDF remains the open-source document wedge and can render a separately authored Markdown report; v1 does not claim a generic dataset-to-PDF export.

The first ICP is a backend or AI-product team whose application receives customer datasets that do not fit safely in its heap or an LLM context window.

## 2. Product layers

### Pluma Docs — OSS

- Markdown to branded PDF without Chromium or an external rendering service.
- PDF, HTML, and URL text-layer readers.
- CLI, Node API, MCP, schemas, and local execution.

### Pluma Context — OSS

- Open `.pluma` manifest, integrity checks, Arrow blocks, human-readable views, and provenance.
- CSV, XLSX, Parquet, `AsyncIterable` and Node stream ingestion.
- Exact structured queries, explicit indexes, predicate pruning, execution plans, token budgets, and bounded working sets.
- CSV, XLSX, and Parquet exports with backpressure.
- CLI, Node API, and MCP contracts with equivalent capabilities.

### Pluma Cloud — paid

- Managed upload, storage, compilation, querying, export, retries, isolation, signed downloads, retention, metering, and audit metadata.
- Paid OCR for scanned PDFs, with provider isolation, explicit page limits, timeouts, and provenance that identifies OCR output.
- Production jobs recover after worker loss without double charging. A job may restart a safe stage when a target format cannot be appended safely; the external operation remains idempotent.

### Repository and license boundary

- `ararahq/pluma` is the public MIT source of Docs, Context, normative schemas/specification, CLI, Node API, MCP, local tests, public benchmarks, and compatibility fixtures. It contains no Cloud server, billing, account/auth, managed storage, private deployment, provider credential, or proprietary OCR orchestration code.
- `ararahq/pluma-cloud` is private and contains the web application, auth, billing, metering, managed jobs/storage, OCR provider adapters, operational infrastructure, private runbooks, and the Cloud SDK. It may import the public package and generated public schemas; the public repository may never import or vendor Cloud code.
- Cloud locks `@ararahq/pluma` by exact version and lockfile integrity. Its release records both the Cloud commit/digest and OSS package version/integrity. Schema generation originates only in OSS; Cloud consumes versioned published artifacts.
- CI fails if the public repository contains forbidden Cloud paths/imports/secrets, if Cloud duplicates normative engine code instead of depending on OSS, or if a Cloud release uses an unapproved/unverified OSS integrity. Licensing notices and package provenance are generated and checked at release.

## 3. Required public workflows

### Stream to export

```ts
await pluma.export({
  rows: database.stream("SELECT * FROM transactions"),
  schema,
  format: "xlsx",
  output: "transactions.xlsx",
  resourceBudget: { memoryBytes: 128 * 1024 * 1024, spillBytes: 4 * 1024 ** 3, timeoutMs: 600_000 },
  xlsx: { sheetName: "Transactions", freezeHeader: true, autoFilter: true },
})
```

The API accepts `AsyncIterable<Record<string, unknown>>`, iterable rows, and Node readable streams without materializing the complete source.

### Compile and query

```ts
const job = pluma.compile("transactions.parquet", {
  output: "transactions.pluma",
  indexes: [{ columns: ["status", "created_at"] }],
  resourceBudget: { memoryBytes: 128 * 1024 * 1024, spillBytes: 4 * 1024 ** 3, timeoutMs: 600_000 },
})
await job.result()

const context = pluma.open("transactions.pluma", {
  resourceBudget: { memoryBytes: 128 * 1024 * 1024, spillBytes: 4 * 1024 ** 3, timeoutMs: 600_000 },
})

const result = context.query({
  filter: [{ column: "status", op: "eq", value: "refunded" }],
  groupBy: ["country"],
  metrics: [{ column: "amount", aggregate: "sum", as: "total" }],
})

result.payload({ tokenBudget: 8_000, tokenizer: { id: "o200k_base", version: "1" } })
```

### Row stream to `.pluma`

```ts
const source = {
  identity: { snapshot: "db-snapshot-2026-08-25", fingerprint: "sha256:..." },
  open: (cursor?: string) => database.stream("SELECT * FROM transactions WHERE id > ? ORDER BY id", [cursor ?? "0"]),
  cursor: (row: { id: string }) => row.id,
}

const job = pluma.compileRows(source, {
  output: "transactions.pluma",
  relation: { id: "transactions", name: "Transactions", fields: schema },
  indexes: [{ columns: ["status", "created_at"] }],
  materializedAggregates: [{ groupBy: ["status"], metrics: [{ column: "amount", aggregate: "sum", as: "total" }] }],
  resourceBudget: { memoryBytes: 128 * 1024 * 1024, spillBytes: 4 * 1024 ** 3, timeoutMs: 600_000 },
})
await job.result()
```

`compileRows` accepts `AsyncIterable<Record<string, unknown>>`, iterable rows, Node readable streams, or the resumable source factory above. It never collects the complete source, applies backpressure, and requires an explicit schema so a late value cannot silently change the relation contract. A bare stream is non-resumable; a resumable source supplies a stable snapshot identity, a cursor extractor, and a factory that can reopen from a checkpoint.

### Explain and streaming query export

```ts
const explanation = context.explain(plan)
const evidence = await context.exportQuery(plan, {
  format: "parquet",
  output: "refunds.parquet",
  signal,
  resourceBudget,
})
```

`explain` reports strategy, selected index/materialized aggregate, estimated candidates, index pages, and whether a scan is unavoidable. `exportQuery` executes directly into a backpressured sink and returns complete evidence without collecting `QueryResult.rows`; `queryStream(plan, { signal, resourceBudget })` is the lower-level `AsyncIterable` contract. CLI exposes the same path as `pluma context query ... --format ... -o ...` and reads row streams as NDJSON from stdin. MCP and Cloud use versioned query/export schemas and asynchronous jobs rather than attempting to serialize a JavaScript stream.

Natural-language `ask()` is not part of the deterministic engine. An LLM or agent creates a schema-validated `QueryPlan`; Pluma executes it exactly. SDK helpers may orchestrate an LLM later, but the execution contract cannot depend on model output.

## 4. Exactness and complexity

- Every result includes package fingerprint, normalized plan hash, candidate blocks, blocks read, rows scanned, rows matched, and rows returned.
- Block statistics and explicit indexes may prune work. Indexed point/range lookup targets `O(log N + K)`, where `N` is the number of ordered entries in the selected index and `K` is the number of matching entries plus selected blocks. Evidence separately reports index pages read, key comparisons, candidate blocks, rows scanned, and returned rows, so logarithmic selection cannot be confused with downstream scanning.
- The compiler can create exact materialized aggregates for declared dimensions and metrics. Queries fully covered by one of these structures target `O(log N + G)`, where `G` is the number of returned groups, and must report that structure in the execution evidence.
- Exact global aggregates that are not covered by a declared materialized aggregate remain `O(N)` because their semantics require every relevant row. The planner must expose this before execution as `strategy: "full_scan"`; Pluma must never disguise it as logarithmic work.
- The public benchmark suite must separately prove indexed point lookup, indexed range lookup, covered aggregation, pruned scan, and unavoidable full scan. Point and range workloads keep `K` and selectivity controlled while `N` grows; the release gate requires the first three task classes to exhibit logarithmic index-page/comparison growth.
- `context.explain(plan)` chooses and reports `index`, `materialized_aggregate`, `pruned_scan`, or `full_scan` before execution, including the selected structure and the reason a scan is unavoidable.
- Existing `.pluma` version 1 packages are frozen as compatibility fixtures and remain readable. The normative indexed package is version 2. A v1 package has no normative indexes and correctly falls back to a scan. Missing or incompatible v2 statistics/indexes also cause a correct full scan, never an approximate result.

## 5. Resource and memory contract

- Every compile, open/query, and export operation accepts the same `ResourceBudget`: `memoryBytes`, `spillBytes`, `timeoutMs`, optional `temporaryDirectory`, and `signal`. Defaults, platform minimums, Cloud plan maximums, and stable resource errors are documented. Compilation and full-relation export operate in bounded batches and honor stream backpressure.
- One decoded batch, result buffers, pinned values, index pages, encoder state, and operator state count toward `memoryBytes`.
- `memoryBytes` has a documented minimum that can hold the engine's smallest legal batch and operator state. Compilation targets blocks below both the package maximum and the configured working-set budget. A package block larger than the runtime budget is decoded through bounded Arrow record batches or rejected before query execution; it may not bypass the budget.
- Hash aggregation, sort, distinct, join-like internal operators, XLSX shared state, and materialized-index construction have explicit per-operator quotas. Spillable operators use an account/job-scoped temporary directory with bounded disk quota, checksummed runs, deterministic merge, cancellation cleanup, and no cross-job filenames. Non-spillable operators fail closed with a stable resource error.
- Oversized blocks are split at compile time. Oversized single rows fail with a stable error that reports the required minimum budget without echoing row contents.
- Queries that would materialize more than the result budget must use streaming export or fail with a stable resource error; they cannot silently exceed the budget.
- Cloud workers enforce both the engine budget and an OS/process ceiling.

## 6. XLSX and the Apache POI boundary

V1 competes with Apache POI for high-volume tabular generation, not the entire Office object model.

Required:

- streaming rows and automatic sheet rollover;
- types, dates, number formats, widths, header style, frozen panes, filters, and safe formulas-as-data;
- multiple named tables/relations;
- atomic destination publication;
- deterministic output and round-trip tests;
- no workbook-sized in-memory row collection.

Charts, macros, arbitrary drawing objects, formula evaluation, and pixel-perfect editing of an existing workbook are explicitly outside v1. Marketing may say “a lightweight alternative to POI for data-heavy exports,” not “complete POI replacement.”

The Node API accepts `relations: [{ name, fields, rows, xlsx: { sheetName, tableName, widths } }]`; CLI uses a versioned workbook JSON descriptor plus NDJSON/file sources. Each relation maps to one or more sheets when rollover is necessary, repeating the header and preserving a deterministic suffix. Widths are explicit or derived from a bounded prefix sample. Determinism means semantic equality and stable relation/sheet ordering; ZIP timestamps or compression bytes need not be identical.

## 7. OCR boundary

- OCR is Cloud-only and paid.
- Text-layer PDFs continue through the local deterministic reader.
- OCR eligibility is decided per page. With `ocr: "auto"`, pages with a usable text layer stay deterministic while image-only or unusable-text pages go through OCR; `ocr: "always"` is explicit for every page. A mixed PDF therefore preserves native text where available and OCRs only the pages that require it.
- Raw documents and OCR output follow the documented retention policy, are account-scoped, and never enter logs.
- Provider failures are bounded, retryable, and do not consume successful-operation credits.
- Output identifies pages processed, provider, warnings, and that text came from OCR. Layout reconstruction is best-effort and must not be described as pixel-perfect.
- A usable text layer has a documented minimum count of printable Unicode characters plus a maximum replacement/control-character ratio after normalization. The decision and measurements appear in provenance.
- Metering is per successfully committed OCR page and keyed by account, source fingerprint, page number, OCR options, and provider model version. Retries deduplicate against that key. Partial provider failure preserves successful page artifacts for retry but does not publish a final document; only committed successful pages are charged, and a later retry cannot charge them twice.

## 8. Normative format and data semantics

- `schema/context-manifest-v2.json`, `schema/query-plan-v1.json`, and the public `.pluma` v2 specification are normative. Version 1 is frozen by real compatibility fixtures. Unknown required versions fail closed; readers may ignore only extension fields explicitly marked forward-compatible.
- Field identity is the stable `id`, not the display name. Duplicate display names are allowed; duplicate field IDs are not.
- Null is distinct from empty string, zero, `false`, NaN, and missing. Missing source fields become null only when the field is nullable; otherwise compilation fails.
- Integers outside JavaScript's safe range remain `int64`/decimal values without conversion through `number`. Decimal precision and scale are preserved. NaN and infinities have an explicit encoding and are rejected for operations that do not define them.
- Timestamps preserve an instant plus declared timezone semantics; dates remain calendar dates and are not shifted by the host timezone.
- `count(*)`, `count(column)`, `sum`, `avg`, `min`, and `max` have SQL-compatible null behavior documented in the query schema. Numeric overflow fails deterministically; it never wraps or silently loses precision.
- CSV export writes a required `<file>.pluma-schema.json` sidecar unless explicitly disabled; import consumes an explicit schema or a matching validated sidecar, otherwise it is declared inference-only and not type-exact. XLSX embeds a hidden `_pluma_schema` sheet with versioned schema and relation fingerprints; if absent, import is inference-only. Parquet uses native/logical types plus Pluma metadata. Type-exact round trip means identical field IDs, nullability, logical types, decimal precision/scale, timezone semantics, and canonical values. Disabling or losing metadata is surfaced in provenance and cannot pass the exact round-trip gate.
- Every index and materialized aggregate records relation fingerprint, columns, collation/comparison rules, null ordering, operator semantics, and compiler version. A mismatch makes it ineligible, never approximately reusable.

## 9. Untrusted-format security

- XLSX ZIP entry count, total expanded bytes, expansion ratio, XML depth/text/attribute sizes, worksheet dimensions, shared strings, relationships, and media are bounded before allocation. DTD/external entities and external relationships are disabled. Archive paths are normalized and traversal, absolute paths, devices, hard links, and symlinks are rejected.
- Parquet footer size, metadata, nesting, columns, row groups, page sizes, decompressed allocation, and compression ratio are bounded. Arrow buffers, vectors, offsets, and record-batch sizes are validated before allocation.
- CSV row bytes, field bytes, columns, and total input bytes have budgets. Temporary and final artifacts are account/job scoped, created without following links, quota checked, and atomically published. Cloud never trusts a client filename as a storage key.
- Security-limit failures use stable codes and do not include raw cell, row, or document contents in logs or error messages. Corpus tests include ZIP bombs, traversal, entity expansion, malformed offsets, oversized footers/pages, decompression bombs, and symlink races.

## 10. Recovery and publication

- File compilation records identity before reading and verifies size, mtime, inode/file ID where available, plus the final content hash before commit; mutation during reading aborts publication. Package commit and final artifact publication are atomic.
- Row streams require caller-provided `sourceIdentity` containing a stable snapshot/fingerprint and optional resumable cursor contract. A non-replayable stream without it is explicitly non-resumable and restarts from the caller. Database docs show snapshot/transaction semantics; Pluma never invents reproducibility for a live query.
- Cloud claims jobs with leases. A stale lease makes the job eligible for recovery.
- Every lease has a monotonically increasing fencing token and heartbeat deadline. Stage checkpoints record immutable input fingerprint, source cursor, fencing token, stage, completed block/artifact hashes, and output contract. A stale worker cannot commit after a newer fence.
- Retrying a completed stage verifies and reuses its artifacts. Formats that cannot safely append restart only their export stage.
- Billing uses an idempotent ledger keyed by account, operation, source fingerprint, stage/artifact, and billing version. Recovery cannot double charge.
- CLI cancellation cleans staging files. Cloud cleanup removes abandoned staging objects by lifecycle.

## 11. Surface parity and proof gates

The repository publishes a generated capability matrix for Node, CLI, MCP, Cloud API, and Cloud SDK. JavaScript streams are Node-only; CLI streaming uses stdin/stdout NDJSON and MCP/Cloud use asynchronous job resources. Query plan, evidence, resource error, manifest, and workbook schemas are generated from the normative contracts and shared by every applicable surface.

The product is not complete until all apply:

1. `AsyncIterable`, iterable, and Node stream ingestion compile to `.pluma`, and the same source forms export to CSV, XLSX, and Parquet without whole-source materialization.
2. Indexed queries prove pruning while returning the same answer as a full scan.
3. Memory-limit tests fail closed and production workers enforce the configured ceiling.
4. 1M and 10M public benchmarks report input size, throughput, elapsed time, peak RSS, blocks, candidate blocks, rows scanned, and tokens returned.
5. A configurable 100M benchmark harness exists and is documented; a result is published only when executed on named hardware.
6. Compile/query/export, interruption recovery, tamper detection, spreadsheet injection, and format round trips have automated tests.
7. OCR is tested with text-layer, scanned, mixed, provider-failure, and oversized fixtures.
8. CLI, Node, MCP, Cloud SDK, docs, pricing, and the live dashboard tell the same truth.
9. The OSS source on GitHub exactly corresponds to the published npm package.
10. Cloud is deployed from a private repository with automatic, immutable releases and rollback.
11. Normative schemas validate every package and query fixture; cross-format semantic round trips cover the type matrix above.
12. Memory tests cover decoded blocks, aggregation spill, sort spill, index construction, XLSX export, cancellation cleanup, and disk-quota exhaustion under named byte ceilings.
13. The v1 compatibility corpus opens and produces its recorded semantic answers under the v2 reader.
14. Untrusted-format corpus tests prove the security limits above without exceeding named process memory/disk ceilings.
15. Query streaming/export cancellation, backpressure, full evidence, and parity across Node, CLI, MCP, and Cloud jobs are tested.

## 12. Release boundary

The complete v1 is the union of the existing document engine and this context/export contract. It does not include natural-language chat, business-user dashboards, distributed SQL, arbitrary Office editing, SAML/SCIM, or multi-cloud connectors. Those are independent product trains after the proof gates above.
