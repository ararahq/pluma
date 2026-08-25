# Pluma Context benchmarks

Run the public 1M and 10M proof workloads:

```bash
npm run build
PLUMA_BENCH_ROWS=1000000 node bench/context.mjs
PLUMA_BENCH_ROWS=10000000 node bench/context.mjs
```

The same harness supports 100M rows, but a 100M result must only be published with the emitted hardware metadata and the unmodified JSON output:

```bash
PLUMA_BENCH_ROWS=100000000 node bench/context.mjs
```

The report separates indexed point/range selection, a covered exact aggregate, and an unavoidable full scan. `processMaxRssBytes` is the operating system high-water mark for the complete process, not a sampled estimate.

Run the complete isolated matrix:

```bash
PLUMA_BENCH_PROFILE=quick npm run bench:suite
PLUMA_BENCH_PROFILE=standard npm run bench:suite
PLUMA_BENCH_PROFILE=giant npm run bench:suite
```

- `quick`: 10 and 10k Context rows, all three export formats at 10k, and a small document round trip.
- `standard`: adds 1M and 10M Context rows, all export formats at 1M, and a 1,000-section document.
- `giant`: adds the 100M Context proof and 10M-row CSV/Parquet streaming round trips.

Each case runs in a fresh process so peak RSS does not leak across workloads. The suite fails on any row-count, query-result, token-budget, or round-trip mismatch and stores the raw JSON plus a generated summary under `docs/benchmarks/`.
