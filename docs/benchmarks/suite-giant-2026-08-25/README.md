# Pluma benchmark suite — giant

Generated: 2026-08-25T17:06:11.391Z

Every row below is backed by an unmodified JSON file in this directory. Peak RSS is the operating-system high-water mark of an isolated child process.

| Case | Rows / input | Compile or render | Peak RSS | Correct |
| --- | ---: | ---: | ---: | :---: |
| context-tiny-10 | 10 | 59.86 ms | 400.9 MiB | yes |
| context-small-10000 | 10000 | 91.45 ms | 604.8 MiB | yes |
| context-medium-1000000 | 1000000 | 2649.15 ms | 559.2 MiB | yes |
| context-large-10000000 | 10000000 | 23960.43 ms | 656.6 MiB | yes |
| context-giant-100000000 | 100000000 | 261911.86 ms | 550.4 MiB | yes |
| stream-formats-small-10000 | 10000 | 118.7 ms | 199.6 MiB | yes |
| stream-formats-medium-1000000 | 1000000 | 1984.41 ms | 500.3 MiB | yes |
| stream-formats-large-10000000 | 10000000 | 14622.44 ms | 483.4 MiB | yes |
| documents-small-10 | 10 | 26.45 ms | 183.6 MiB | yes |
| documents-large-1000 | 1000 | 420.82 ms | 468.1 MiB | yes |

## Scope

The suite measures CSV package compilation, indexed/range/materialized/full-scan queries, fixed-token payloads, AsyncIterable/database-style input, CSV/XLSX/Parquet export and re-import, Markdown→PDF, PDF→Markdown, and HTML→Markdown. Unit and security suites separately cover cancellation, checkpoints, tamper detection, resource limits, spreadsheet injection, malformed files, and unsafe hosted input.
