# Pluma capability contract

This matrix is normative for the 0.4 line. “Managed” means Pluma operates storage, workers, retries, retention, and metering; it does not mean the underlying open format is proprietary.

| Capability | Node | CLI | MCP | Cloud |
| --- | --- | --- | --- | --- |
| Markdown → PDF | `renderPdf` | `pluma file.md` | `render_pdf` | `POST /v1/render` |
| PDF/HTML/URL → Markdown | reader APIs | automatic input | reader tools | `/v1/read/*` |
| Scanned PDF OCR | — | — | — | `POST /v1/read/pdf?ocr=auto` or `/ocr` |
| CSV/XLSX/Parquet → `.pluma` | `compileContext` | `context compile` | `pluma_context_compile*` | upload + context job |
| database/row stream → `.pluma` | `compileRows` | `context compile-stream` | local file/stream tools | managed source upload |
| inspect/sample | `inspect`, `sample` | `context inspect` | inspect/sample tools | context query API |
| exact query + evidence | `query`, `explain` | `context explain/query` | query/explain tools | context query API |
| direct query export | `exportQuery` | query `--format -o` | `pluma_context_query_export` | async export job |
| CSV/XLSX/Parquet export | `exportData`, `exportWorkbook` | `context export` | export tools | async export job |
| resumable source cursor | `compileRows` checkpoint | descriptor + checkpoint | — | fenced durable jobs |
| token/resource budget | explicit options | explicit flags | bounded tool schema | plan + worker ceilings |

## Complexity contract

- Ordered point/range selection: `O(log N + K)` candidate selection, then only selected blocks are scanned.
- Declared materialized aggregate lookup: `O(log N + G)` for exact covered groups.
- Uncovered exact global aggregate: explicit `O(N)` full scan.

Every query evidence record distinguishes comparisons, index pages, candidate blocks, blocks read, rows scanned, rows matched, and rows returned.
