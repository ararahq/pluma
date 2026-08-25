# Pluma Complete Product v1 — implementation plan

**Source contract:** `docs/superpowers/specs/2026-08-25-pluma-complete-product-v1-design.md`

## Release 1 — OSS format and resource contracts

1. Add normative v2 manifest, query, evidence, workbook, resource-budget, and error schemas.
2. Preserve a real v1 compatibility fixture and reader path.
3. Add strict scalar validation and canonical typed values.
4. Add one `ResourceBudget` implementation for compile, query, and export.
5. Add atomic output staging and cleanup for all export formats.
6. Add `compileRows` for iterable, async iterable, Node readable, and resumable source factories.

## Release 2 — indexed exact execution

1. Record block statistics during compile.
2. Build bounded/spillable ordered indexes and materialized aggregates.
3. Add `explain`, indexed candidate selection, predicate pruning, and full evidence.
4. Add `queryStream` and `exportQuery` without result materialization.
5. Add correctness parity tests against forced full scans and logarithmic-selection instrumentation.

## Release 3 — heavy export product

1. Add CSV type sidecars and XLSX hidden schema metadata.
2. Add professional XLSX styles, widths, panes, filters, named relations, and rollover.
3. Add bounded temporary spill and checkpoints for compile/query/export.
4. Add cancellation, disk quota, interruption, and semantic round-trip tests.

## Release 4 — Cloud OCR and recovery

1. Add per-page OCR provider contract, eligibility, provenance, timeout/retry, and partial-page persistence.
2. Add account-scoped storage and idempotent per-page billing ledger.
3. Add lease fencing, heartbeats, stage checkpoints, and stale-worker commit rejection.
4. Add Cloud endpoints/jobs and SDK/dashboard onboarding for context, export, and OCR.

## Release 5 — proof and distribution

1. Generate the surface capability matrix and keep CLI/Node/MCP/Cloud schemas aligned.
2. Publish security corpus, 1M/10M benchmarks, and configurable 100M harness.
3. Enforce OSS/Cloud repository boundary and dependency integrity in CI.
4. Verify builds, tests, audits, package contents, production smoke, rollback, and public documentation.
5. Prepare the OSS/npm and private Cloud releases without committing unrelated user work.
