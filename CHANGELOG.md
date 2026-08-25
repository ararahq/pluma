# Changelog

## 0.4.2 — 2026-08-25

- Preserve declared scalar types during Parquet export, including integer-looking `float64` and decimal values.
- Add isolated quick, standard, and giant benchmark suites with correctness assertions, fixed-token checks, database-style streams, round-trip exports, document I/O, and reproducible raw reports through 100 million rows.

## 0.4.1 — 2026-08-25

- Bundle the XLSX engine with a guarded compatibility patch for `uuid@11.1.1`, so consumers receive an audited dependency tree without requiring project-level overrides.

## 0.4.0 — 2026-08-25

- Added the versioned `.pluma` v2 context package with strict typed relations, checksums, provenance, LLM-readable views, and v1 reader compatibility.
- Added bounded iterable, async iterable, Node stream, CSV, XLSX, and Parquet compilation and streaming CSV/XLSX/Parquet exports.
- Added ordered block indexes, predicate pruning, materialized exact aggregates, `explain`, evidence, `queryStream`, and `exportQuery`.
- Added token and resource budgets, spillable aggregate construction, typed CSV/XLSX round trips, and spreadsheet-injection protection.
- Added matching CLI and MCP surfaces plus reproducible 1M/10M benchmark reports and a configurable 100M harness.

## 0.3.0 — 2026-08-25

- Added the open `.pluma` package, bounded CSV/XLSX/Parquet compiler, integrity verification, exact structured queries, block provenance, and exact tokenizer budgets.
- Added streaming CSV/XLSX/Parquet exports, local CLI commands, and synchronous plus durable MCP context tools.
- Added managed direct uploads, durable compile/export jobs, isolated context workers, encrypted account-scoped storage, and the Context workbench.
- Kept the Markdown-to-PDF engine, readers, and local runtime under MIT.

## 0.2.0 — 2026-08-24

- Strengthened the Markdown-to-PDF engine, CLI, branding contract, hosted-safe
  renderer, and machine-readable output for customer-facing document workflows.
- Added PDF, HTML, and public-URL to Markdown APIs with structured metadata,
  warnings, strict resource budgets, and SSRF-safe URL fetching.
- Added read/render commands to the CLI and a safe-by-default MCP server.
- Added `renderPdfCloudSafe` for untrusted hosted workloads.
- Added the Pluma Cloud application: REST API, typed TypeScript SDK, Better Auth,
  Postgres quotas/idempotency, Stripe billing, dashboard, docs, and anonymous
  playground.
- Added isolated Linux workers, Docker/Compose packaging, migration and Stripe
  reconciliation commands, readiness checks, retention cleanup, third-party
  notices, and release validation across all workspaces.

## 0.1.1

- Published the original local Markdown-to-PDF library and CLI.
