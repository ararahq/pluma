# Pluma benchmark suite — standard

Generated: 2026-08-25T16:53:24.489Z

Every row below is backed by an unmodified JSON file in this directory. Peak RSS is the operating-system high-water mark of an isolated child process.

| Case | Rows / input | Compile or render | Peak RSS | Correct |
| --- | ---: | ---: | ---: | :---: |
| context-tiny-10 | 10 | 62.86 ms | 404.1 MiB | yes |
| context-small-10000 | 10000 | 88.57 ms | 602.7 MiB | yes |
| context-medium-1000000 | 1000000 | 2576.59 ms | 559.9 MiB | yes |
| context-large-10000000 | 10000000 | 25537.33 ms | 708.0 MiB | yes |
| stream-formats-small-10000 | 10000 | 84.4 ms | 200.4 MiB | yes |
| stream-formats-medium-1000000 | 1000000 | 1586.83 ms | 640.8 MiB | yes |
| documents-small-10 | 10 | 22.47 ms | 182.0 MiB | yes |
| documents-large-1000 | 1000 | 383.86 ms | 461.4 MiB | yes |

## Scope

The suite measures CSV package compilation, indexed/range/materialized/full-scan queries, fixed-token payloads, AsyncIterable/database-style input, CSV/XLSX/Parquet export and re-import, Markdown→PDF, PDF→Markdown, and HTML→Markdown. Unit and security suites separately cover cancellation, checkpoints, tamper detection, resource limits, spreadsheet injection, malformed files, and unsafe hosted input.
