import { rmSync, statSync } from "node:fs"
import { cpus, platform, release, totalmem, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { compileContext, compileRows, openContext } from "../dist/src/index.js"

const rows = Number(process.env.PLUMA_BENCH_ROWS || 100_000)
const formats = (process.env.PLUMA_BENCH_FORMATS || "csv,xlsx,parquet").split(",").filter((value) => ["csv", "xlsx", "parquet"].includes(value))
if (!Number.isSafeInteger(rows) || rows < 1) throw new Error("PLUMA_BENCH_ROWS must be a positive integer")
if (!formats.length) throw new Error("PLUMA_BENCH_FORMATS must include csv, xlsx, or parquet")

const root = join(tmpdir(), `pluma-stream-bench-${randomUUID()}`)
const packagePath = `${root}.pluma`
const fields = [
  { id: "id", name: "id", type: "int64", nullable: false },
  { id: "country", name: "country", type: "utf8", nullable: false },
  { id: "status", name: "status", type: "utf8", nullable: false },
  { id: "amount", name: "amount", type: "float64", nullable: false },
]

try {
  const compileStarted = performance.now()
  const manifest = await compileRows(databaseStream(rows), {
    output: packagePath,
    batchRows: 8_192,
    resourceBudget: { memoryBytes: 128 * 1024 ** 2 },
    relation: { id: "transactions", name: "Transactions", fields },
    indexes: [{ columns: ["id"] }, { columns: ["status"] }],
  }).result()
  const compileMs = performance.now() - compileStarted
  if (manifest.relations[0]?.rowCount !== rows) throw new Error("Stream compile row count mismatch")

  const context = openContext(packagePath, { resourceBudget: { memoryBytes: 128 * 1024 ** 2 } })
  const outputs = []
  try {
    const point = context.query({ filter: [{ column: "id", op: "eq", value: rows - 1 }], select: ["amount"] })
    if (point.rows.length !== 1) throw new Error("Indexed stream package query mismatch")
    for (const format of formats) {
      const output = `${root}.${format}`
      const exportStarted = performance.now()
      await context.export({ format, output })
      const exportMs = performance.now() - exportStarted
      const bytes = statSync(output).size
      const roundtrip = `${root}-${format}.pluma`
      const importStarted = performance.now()
      const imported = await compileContext(output, { output: roundtrip, resourceBudget: { memoryBytes: 128 * 1024 ** 2 } }).result()
      const importMs = performance.now() - importStarted
      const importedRows = imported.relations.reduce((sum, relation) => sum + relation.rowCount, 0)
      if (importedRows !== rows) throw new Error(`${format} round-trip row count mismatch: ${importedRows} !== ${rows}`)
      outputs.push({ format, bytes, exportElapsedMs: rounded(exportMs), exportRowsPerSecond: rounded(rows / (exportMs / 1000)), importElapsedMs: rounded(importMs), importRowsPerSecond: rounded(rows / (importMs / 1000)), roundtripRows: importedRows, correct: true })
      rmSync(output, { force: true }); rmSync(`${output}.pluma-schema.json`, { force: true }); rmSync(roundtrip, { recursive: true, force: true })
    }
  } finally { context.close() }

  process.stdout.write(JSON.stringify({
    format: "pluma-stream-export-benchmark", version: 1, createdAt: new Date().toISOString(),
    hardware: { cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem(), platform: platform(), release: release(), node: process.version },
    input: { kind: "async-iterable-database-simulation", rows },
    compile: { elapsedMs: rounded(compileMs), rowsPerSecond: rounded(rows / (compileMs / 1000)), memoryBudgetBytes: 128 * 1024 ** 2, rowCountCorrect: true },
    indexedPoint: { rowsScanned: pointRowsScanned(packagePath, rows), expectedComplexity: "O(log N + K)" },
    outputs,
    processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
  }) + "\n")
} finally { rmSync(packagePath, { recursive: true, force: true }) }

async function* databaseStream(count) {
  for (let id = 0; id < count; id++) yield { id, country: id % 2 ? "US" : "GB", status: id % 7 ? "paid" : "refund", amount: (id % 10_000) / 100 }
}

function pointRowsScanned(path, count) {
  const context = openContext(path)
  try { return context.query({ filter: [{ column: "id", op: "eq", value: count - 1 }] }).provenance.rowsScanned }
  finally { context.close() }
}

function rounded(value) { return Math.round(value * 100) / 100 }
