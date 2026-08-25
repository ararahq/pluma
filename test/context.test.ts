import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { compileContext, compileRows, exportData, exportWorkbook, openContext } from "../src/index.js"
import { canonicalJson, sha256 } from "../src/context/hash.js"

const directories: string[] = []
function fixture(): string { const path = mkdtempSync(join(tmpdir(), "pluma-context-")); directories.push(path); return path }
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }) })

describe("Pluma Context", () => {
  test("compiles CSV into an integrity-checked package and queries exact aggregates", async () => {
    const root = fixture()
    const input = join(root, "transactions.csv")
    const output = join(root, "transactions.pluma")
    writeFileSync(input, "id,status,amount\n1,paid,10.5\n2,refunded,7\n3,refunded,3\n")
    const job = compileContext(input, { output, batchRows: 2 })
    const events = []
    for await (const event of job.events()) events.push(event.state)
    const manifest = await job.result()
    expect(events).toContain("compiling")
    expect(events.at(-1)).toBe("completed")
    expect(manifest.relations[0].rowCount).toBe(3)

    const context = openContext(output)
    const result = context.query({ filter: [{ column: "status", op: "eq", value: "refunded" }], metrics: [{ column: "amount", aggregate: "sum", as: "total" }] })
    expect(result.rows).toEqual([{ total: 10 }])
    expect(result.provenance.rowsScanned).toBe(3)
    expect(result.provenance.inputBlocks.length).toBe(2)

    const payload = result.payload({ tokenBudget: 512, tokenizer: { id: "o200k_base", version: "1" } })
    expect(payload.context.tokenCost).toBeLessThanOrEqual(512)
  })

  test("streams exports to CSV, XLSX, and Parquet that can be re-imported", async () => {
    const root = fixture()
    const input = join(root, "source.csv")
    const packagePath = join(root, "source.pluma")
    writeFileSync(input, "name,value\nalpha,1\nbeta,2\n")
    await compileContext(input, { output: packagePath }).result()
    const context = openContext(packagePath)

    const csv = join(root, "out.csv")
    const xlsx = join(root, "out.xlsx")
    const parquet = join(root, "out.parquet")
    await context.export({ format: "csv", output: csv })
    await context.export({ format: "xlsx", output: xlsx })
    await context.export({ format: "parquet", output: parquet })
    expect(readFileSync(csv, "utf8")).toContain("alpha,1")

    const xlsxManifest = await compileContext(xlsx, { output: join(root, "xlsx.pluma") }).result()
    const parquetManifest = await compileContext(parquet, { output: join(root, "parquet.pluma") }).result()
    expect(xlsxManifest.relations[0].rowCount).toBe(2)
    expect(xlsxManifest.relations[0].fields.find((field) => field.name === "value")?.type).toBe("int64")
    expect(parquetManifest.relations[0].rowCount).toBe(2)
  })

  test("keeps integer-looking float64 values numeric in Parquet", async () => {
    const root = fixture()
    const parquet = join(root, "float64.parquet")
    const fields = [
      { id: "id", name: "id", type: "int64" as const, nullable: false },
      { id: "amount", name: "amount", type: "float64" as const, nullable: false },
    ]
    await exportData({ rows: [{ id: 1, amount: 0 }, { id: 2, amount: 1.5 }], fields, format: "parquet", output: parquet })
    const manifest = await compileContext(parquet, { output: join(root, "float64.pluma") }).result()
    expect(manifest.relations[0].rowCount).toBe(2)
    expect(manifest.relations[0].fields.find((field) => field.id === "amount")?.type).toBe("float64")
  })

  test("parses multiline CSV records once and enforces exact query columns", async () => {
    const root = fixture()
    const input = join(root, "multiline.csv")
    const output = join(root, "multiline.pluma")
    writeFileSync(input, 'id,note\n1,"first line\nsecond, line"\n2,plain\n')
    await compileContext(input, { output, batchRows: 1 }).result()
    const context = openContext(output)
    expect(context.query({ select: ["note"], limit: 1 }).rows).toEqual([{ note: "first line\nsecond, line" }])
    expect(() => context.query({ select: ["does_not_exist"] })).toThrow("Unknown column")
  })

  test("bounds the pinned working set", async () => {
    const root = fixture()
    const input = join(root, "source.csv")
    const output = join(root, "source.pluma")
    writeFileSync(input, "a\n1\n")
    await compileContext(input, { output }).result()
    const context = openContext(output)
    expect(() => context.pin("too-large", "x".repeat(9 * 1024 * 1024))).toThrow("8 MiB")
  })

  test("rejects a payload below the minimum token budget", async () => {
    const root = fixture()
    const input = join(root, "source.csv")
    const output = join(root, "source.pluma")
    writeFileSync(input, "a\n1\n")
    await compileContext(input, { output }).result()
    expect(() => openContext(output).inspect({ tokenBudget: 1, tokenizer: { id: "cl100k_base", version: "1" } })).toThrow("at least 256")
  })

  test("compiles AsyncIterable and Node readable rows without collecting the source", async () => {
    const root = fixture()
    const fields = [
      { id: "id", name: "id", type: "int64" as const, nullable: false },
      { id: "name", name: "name", type: "utf8" as const, nullable: false },
    ]
    async function* source() { yield { id: 1, name: "alpha" }; yield { id: 2, name: "beta" } }
    const asyncPackage = join(root, "async.pluma")
    await compileRows(source(), { output: asyncPackage, relation: { id: "items", name: "Items", fields } }).result()
    expect(openContext(asyncPackage).query({ select: ["name"] }).rows).toEqual([{ name: "alpha" }, { name: "beta" }])

    const readablePackage = join(root, "readable.pluma")
    await compileRows(Readable.from([{ id: 3, name: "gamma" }], { objectMode: true }), { output: readablePackage, relation: { id: "items", name: "Items", fields } }).result()
    expect(openContext(readablePackage).query({ select: ["name"] }).rows).toEqual([{ name: "gamma" }])
  })

  test("fails closed on streamed schema violations and writes typed CSV sidecars", async () => {
    const root = fixture()
    const fields = [{ id: "id", name: "id", type: "int64" as const, nullable: false }]
    const invalid = compileRows([{ id: 1, surprise: "no" }], { output: join(root, "invalid.pluma"), relation: { id: "items", name: "Items", fields } })
    await expect(invalid.result()).rejects.toThrow("unknown field")

    const output = join(root, "typed.csv")
    await exportData({ rows: [{ id: 1 }], fields, format: "csv", output })
    expect(JSON.parse(readFileSync(`${output}.pluma-schema.json`, "utf8")).fields).toEqual(fields)
  })

  test("rejects impossible memory budgets before doing work", async () => {
    const root = fixture()
    await expect(exportData({ rows: [], fields: [], format: "csv", output: join(root, "out.csv"), resourceBudget: { memoryBytes: 1 } })).rejects.toThrow("memoryBytes")
  })

  test("uses an ordered index with logarithmic selection and exact full-scan parity", async () => {
    const root = fixture()
    const input = join(root, "indexed.csv")
    const output = join(root, "indexed.pluma")
    writeFileSync(input, "id,value\n" + Array.from({ length: 256 }, (_, index) => `${index},${index * 2}`).join("\n") + "\n")
    await compileContext(input, { output, batchRows: 8, indexes: [{ columns: ["id"] }] }).result()
    const context = openContext(output)
    const plan = { filter: [{ column: "id", op: "eq" as const, value: 201 }], select: ["value"] }
    const explanation = context.explain(plan)
    const result = context.query(plan)
    expect(explanation.strategy).toBe("index")
    expect(explanation.candidateBlocks.length).toBeLessThan(32)
    expect(explanation.keyComparisons).toBeLessThan(32)
    expect(result.rows).toEqual([{ value: 402 }])
    expect(result.provenance.rowsScanned).toBeLessThan(256)
  })

  test("serves declared exact aggregates without scanning source rows", async () => {
    const root = fixture()
    const input = join(root, "aggregated.csv")
    const output = join(root, "aggregated.pluma")
    writeFileSync(input, "status,amount\npaid,10\nrefunded,3\nrefunded,7\n")
    const metrics = [{ column: "amount", aggregate: "sum" as const, as: "total" }]
    await compileContext(input, { output, materializedAggregates: [{ groupBy: ["status"], metrics }] }).result()
    const context = openContext(output)
    const plan = { groupBy: ["status"], metrics, filter: [{ column: "status", op: "eq" as const, value: "refunded" }] }
    expect(context.explain(plan).strategy).toBe("materialized_aggregate")
    const result = context.query(plan)
    expect(result.rows).toEqual([{ status: "refunded", total: 10 }])
    expect(result.provenance.rowsScanned).toBe(0)
  })

  test("streams a query directly into an artifact and returns complete evidence", async () => {
    const root = fixture()
    const input = join(root, "query.csv")
    const contextPath = join(root, "query.pluma")
    const output = join(root, "selected.csv")
    writeFileSync(input, "id,status\n1,paid\n2,refunded\n3,refunded\n")
    await compileContext(input, { output: contextPath, batchRows: 1, indexes: [{ columns: ["id"] }] }).result()
    const context = openContext(contextPath)
    const evidence = await context.exportQuery({ filter: [{ column: "id", op: "gte", value: 2 }] }, { format: "csv", output })
    expect(readFileSync(output, "utf8")).toContain("2,refunded")
    expect(evidence.rowsReturned).toBe(2)
    expect(evidence.rowsScanned).toBeLessThan(3)
    expect(evidence.strategy).toBe("index")
  })

  test("spills high-cardinality materialized aggregates and merges exact groups", async () => {
    const root = fixture()
    const fields = [
      { id: "group", name: "group", type: "utf8" as const, nullable: false },
      { id: "amount", name: "amount", type: "int64" as const, nullable: false },
    ]
    async function* rows() { for (let index = 0; index < 10_000; index++) yield { group: `g-${index}`, amount: 1 } }
    const metrics = [{ column: "amount", aggregate: "sum" as const, as: "total" }]
    const output = join(root, "spill.pluma")
    await compileRows(rows(), { output, relation: { id: "items", name: "Items", fields }, materializedAggregates: [{ groupBy: ["group"], metrics }], resourceBudget: { memoryBytes: 16 * 1024 * 1024 } }).result()
    const context = openContext(output)
    const result = context.query({ groupBy: ["group"], metrics, filter: [{ column: "group", op: "eq", value: "g-9999" }] })
    expect(result.rows).toEqual([{ group: "g-9999", total: 1 }])
    expect(result.provenance.strategy).toBe("materialized_aggregate")
  })

  test("round-trips explicit scalar types through CSV sidecar and embedded XLSX schema", async () => {
    const root = fixture()
    const fields = [
      { id: "id", name: "id", type: "int64" as const, nullable: false },
      { id: "amount", name: "amount", type: "decimal" as const, nullable: false, precision: 20, scale: 4 },
      { id: "payload", name: "payload", type: "json" as const, nullable: false },
      { id: "bytes", name: "bytes", type: "binary" as const, nullable: false },
    ]
    const rows = [{ id: 9_007_199_254_740_993n, amount: "1234567890123456.1234", payload: { ok: true }, bytes: new Uint8Array([1, 2, 3]) }]
    for (const format of ["csv", "xlsx"] as const) {
      const exported = join(root, `typed.${format}`)
      await exportData({ rows, fields, format, output: exported })
      const manifest = await compileContext(exported, { output: join(root, `${format}.pluma`) }).result()
      expect(manifest.relations[0].fields).toEqual(fields)
      const value = openContext(join(root, `${format}.pluma`)).query({}).rows[0]
      expect(String(value.id)).toBe("9007199254740993")
      expect(value.amount).toBe("1234567890123456.1234")
      expect(value.payload).toEqual({ ok: true })
      expect([...value.bytes as Uint8Array]).toEqual([1, 2, 3])
    }
  })

  test("streams multiple named workbook relations with formats and embedded schemas", async () => {
    const root = fixture()
    const output = join(root, "workbook.xlsx")
    const fields = [{ id: "amount", name: "Amount", type: "decimal" as const, nullable: false, precision: 12, scale: 2 }]
    await exportWorkbook({
      output,
      relations: [
        { name: "Transactions", fields, rows: [{ amount: "12.50" }], xlsx: { sheetName: "Transactions", numberFormats: { amount: "0.00" }, freezeHeader: true, autoFilter: true } },
        { name: "Refunds", fields, rows: [{ amount: "2.25" }], xlsx: { sheetName: "Refunds", numberFormats: { amount: "0.00" } } },
      ],
    })
    const manifest = await compileContext(output, { output: join(root, "workbook.pluma") }).result()
    expect(manifest.relations.map((relation) => relation.name)).toEqual(["Transactions", "Refunds"])
    expect(manifest.relations.every((relation) => relation.fields[0]?.type === "decimal")).toBe(true)
  })

  test("keeps the frozen v1 manifest contract readable", async () => {
    const root = fixture()
    const input = join(root, "legacy.csv")
    const output = join(root, "legacy.pluma")
    writeFileSync(input, "id,name\n1,legacy\n")
    await compileContext(input, { output }).result()
    const manifestPath = join(output, "manifest.json")
    const current = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { fingerprint: string; artifacts: Array<{ sha256: string }> }
    const { fingerprint: _ignored, ...base } = { ...current, version: 1 }
    const fingerprint = sha256(canonicalJson(base) + base.artifacts.map((artifact) => artifact.sha256).join(""))
    writeFileSync(manifestPath, canonicalJson({ ...base, fingerprint }))
    const legacy = openContext(output)
    expect(legacy.package.manifest.version).toBe(1)
    expect(legacy.query({}).rows).toEqual([{ id: 1, name: "legacy" }])
  })

  test("resumes a database-style source from a durable cursor checkpoint", async () => {
    const root = fixture()
    const output = join(root, "resumed.pluma")
    const checkpointPath = join(root, "compile.checkpoint.json")
    let fail = true
    const source = {
      identity: { snapshot: "tx-snapshot-1", fingerprint: `sha256:${"a".repeat(64)}` },
      open: async function* (cursor?: string) {
        const start = Number(cursor ?? 0) + 1
        for (let id = start; id <= 5; id++) {
          if (fail && id === 3) throw new Error("database disconnected")
          yield { id, value: `row-${id}` }
        }
      },
      cursor: (row: { id?: unknown }) => String(row.id),
    }
    const options = { output, checkpointPath, checkpointEveryRows: 1, batchRows: 1, relation: { id: "rows", name: "Rows", fields: [{ id: "id", name: "id", type: "int64" as const, nullable: false }, { id: "value", name: "value", type: "utf8" as const, nullable: false }] } }
    await expect(compileRows(source, options).result()).rejects.toThrow("database disconnected")
    expect(JSON.parse(readFileSync(checkpointPath, "utf8")).cursor).toBe("2")
    fail = false
    const manifest = await compileRows(source, options).result()
    expect(manifest.relations[0].rowCount).toBe(5)
    expect(openContext(output).query({}).rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5])
  })
})
