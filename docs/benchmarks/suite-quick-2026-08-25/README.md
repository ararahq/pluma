# Pluma benchmark suite — quick

Generated: 2026-08-25T16:51:46.041Z

Every row below is backed by an unmodified JSON file in this directory. Peak RSS is the operating-system high-water mark of an isolated child process.

| Case | Rows / input | Compile or render | Peak RSS | Correct |
| --- | ---: | ---: | ---: | :---: |
| context-tiny-10 | 10 | 63.22 ms | 403.6 MiB | yes |
| context-small-10000 | 10000 | 88.37 ms | 603.8 MiB | yes |
| stream-formats-small-10000 | 10000 | 74.26 ms | 200.0 MiB | yes |
| documents-small-10 | 10 | 30.43 ms | 182.7 MiB | yes |

## Scope

The suite measures CSV package compilation, indexed/range/materialized/full-scan queries, fixed-token payloads, AsyncIterable/database-style input, CSV/XLSX/Parquet export and re-import, Markdown→PDF, PDF→Markdown, and HTML→Markdown. Unit and security suites separately cover cancellation, checkpoints, tamper detection, resource limits, spreadsheet injection, malformed files, and unsafe hosted input.
