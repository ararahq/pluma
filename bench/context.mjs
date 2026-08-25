import { createWriteStream, readdirSync, rmSync, statSync } from "node:fs"
import { once } from "node:events"
import { cpus, platform, release, totalmem, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { compileContext, openContext } from "../dist/src/index.js"

const rows = Number(process.env.PLUMA_BENCH_ROWS || 1_000_000)
if (!Number.isSafeInteger(rows) || rows < 1) throw new Error("PLUMA_BENCH_ROWS must be a positive integer")
const root = join(tmpdir(), `pluma-context-bench-${randomUUID()}`)
const source = `${root}.csv`
const output = `${root}.pluma`

try {
  await writeDataset(source, rows)
  const inputBytes = statSync(source).size
  const metrics = [{ column: "amount", aggregate: "sum", as: "total" }]
  const compileStarted = performance.now()
  const manifest = await compileContext(source, {
    output,
    indexes: [{ columns: ["id"] }, { columns: ["status"] }],
    materializedAggregates: [{ groupBy: ["country"], metrics }],
  }).result()
  const compiledMs = performance.now() - compileStarted
  const context = openContext(output)
  try {
    const point = timedQuery(context, { filter: [{ column: "id", op: "eq", value: rows - 1 }], select: ["amount"] }, (result) => result.rows.length === 1 && result.rows[0].amount === ((rows - 1) % 10000) / 100)
    const rangeRows = Math.min(rows, 1_000)
    const range = timedQuery(context, { filter: [{ column: "id", op: "gte", value: Math.max(0, rows - rangeRows) }], select: ["amount"], limit: rangeRows }, (result) => result.rows.length === rangeRows)
    const covered = timedQuery(context, { groupBy: ["country"], metrics }, (result) => Math.abs(result.rows.reduce((sum, row) => sum + Number(row.total), 0) - expectedAmount(rows)) < 0.001)
    const fullScan = timedQuery(context, { filter: [{ column: "status", op: "ne", value: "missing" }], metrics: [{ aggregate: "count", as: "rows" }] }, (result) => Number(result.rows[0]?.rows) === rows)
    const payloadStarted = performance.now()
    const payload = context.query({ filter: [{ column: "id", op: "gte", value: Math.max(0, rows - 100) }], limit: 100 }).payload({ tokenBudget: 2_000, tokenizer: { id: "o200k_base", version: "1" } })
    const tokenBudget = { elapsedMs: rounded(performance.now() - payloadStarted), tokenCost: payload.context.tokenCost, withinBudget: payload.context.tokenCost <= 2_000, rowsReturned: payload.data.length }

    const report = {
      format: "pluma-context-benchmark", version: 3, createdAt: new Date().toISOString(),
      hardware: { cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem(), platform: platform(), release: release(), node: process.version },
      input: { rows, bytes: inputBytes },
      package: { bytes: directoryBytes(output), ratioToInput: rounded(directoryBytes(output) / inputBytes), fingerprint: manifest.fingerprint },
      compile: { elapsedMs: rounded(compiledMs), rowsPerSecond: rounded(rows / (compiledMs / 1000)), bytesPerSecond: rounded(inputBytes / (compiledMs / 1000)), blocks: manifest.relations[0].blocks.length, rowCountCorrect: manifest.relations[0].rowCount === rows },
      queries: { point, range, covered, fullScan, tokenBudget },
      processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    }
    if (![point, range, covered, fullScan].every((query) => query.correct) || !tokenBudget.withinBudget || !report.compile.rowCountCorrect) throw new Error("Benchmark correctness assertion failed")
    process.stdout.write(JSON.stringify(report) + "\n")
  } finally { context.close() }
} finally {
  rmSync(source, { force: true }); rmSync(output, { recursive: true, force: true })
}

async function writeDataset(path, count) {
  const stream = createWriteStream(path)
  stream.write("id,country,status,amount\n")
  for (let index = 0; index < count; index++) {
    if (!stream.write(`${index},${index % 2 ? "US" : "GB"},${index % 7 ? "paid" : "refund"},${(index % 10000) / 100}\n`)) await once(stream, "drain")
  }
  stream.end(); await once(stream, "close")
}

function timedQuery(context, plan, verify) {
  const explanation = context.explain(plan)
  const started = performance.now()
  const result = context.query(plan)
  return {
    elapsedMs: rounded(performance.now() - started), strategy: result.provenance.strategy,
    blocks: context.package.manifest.relations[0].blocks.length,
    candidateBlocks: result.provenance.candidateBlocks.length, blocksRead: result.provenance.blocksRead,
    rowsScanned: result.provenance.rowsScanned, rowsMatched: result.provenance.rowsMatched,
    rowsReturned: result.provenance.rowsReturned, correct: verify(result), indexEntries: explanation.indexEntries ?? 0,
    indexPagesRead: explanation.indexPagesRead ?? 0, keyComparisons: explanation.keyComparisons ?? 0,
  }
}

function rounded(value) { return Math.round(value * 100) / 100 }
function expectedAmount(count) { const cycles = Math.floor(count / 10000); const remainder = count % 10000; return cycles * 499950 + (remainder * (remainder - 1) / 2) / 100 }
function directoryBytes(path) { return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? directoryBytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0) }
