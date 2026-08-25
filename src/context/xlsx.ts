import { existsSync, readFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { ContextError, type ContextBatch, type ContextField, type ContextRow, type ScalarType } from "./types.js"
import { DEFAULT_BATCH_ROWS, normalizeValue, safeFieldId } from "./rows.js"

export async function* readXlsxBatches(path: string, batchSize = DEFAULT_BATCH_ROWS): AsyncGenerator<ContextBatch> {
  const sidecarSchemas = readWorkbookSidecar(path)
  const embedded = sidecarSchemas ?? await readEmbeddedXlsxSchemas(path)
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(path, { worksheets: "emit", sharedStrings: "cache", styles: "ignore", hyperlinks: "ignore" })
  let sheetIndex = 0
  let physicalSheetIndex = 0
  const relationIds = new Set<string>()
  for await (const worksheet of workbook) {
    physicalSheetIndex++
    if ((worksheet as unknown as { name?: string }).name === "_pluma_schema" || (sidecarSchemas && physicalSheetIndex === 1)) {
      for await (const _row of worksheet) { break }
      continue
    }
    sheetIndex++
    const worksheetName = String((worksheet as unknown as { name?: string }).name ?? `Sheet ${sheetIndex}`)
    const relationSchema = schemaForSheet(embedded, worksheetName) ?? embedded.relations[sheetIndex - 1]
    const relationId = relationSchema ? stableRelationId(relationSchema.name, relationIds) : `sheet_${sheetIndex}`
    let fields: ContextField[] | undefined
    let headers: unknown[] | undefined
    let buffered: unknown[][] = []
    let rows: ContextRow[] = []
    let rowStart = 0
    for await (const row of worksheet) {
      const values = Array.from({ length: row.cellCount }, (_, index) => cellValue(row.getCell(index + 1).value))
      if (!headers) {
        headers = values
        if (headers.length > 10_000) throw new ContextError("PLUMA_COLUMN_LIMIT", "XLSX exceeds 10000 columns")
        if (relationSchema) {
          if (relationSchema.fields.length !== headers.length) throw new ContextError("PLUMA_SCHEMA_INVALID", `Embedded XLSX schema has ${relationSchema.fields.length} fields but sheet ${worksheetName} has ${headers.length} columns`)
          fields = relationSchema.fields
        }
        continue
      }
      if (!fields) {
        buffered.push(values)
        if (buffered.length < 1_000) continue
        fields = xlsxFields(headers, buffered)
        rows.push(...buffered.map((record) => xlsxRow(record, fields!)))
        buffered = []
      } else rows.push(xlsxRow(values, fields))
      while (fields && rows.length >= batchSize) {
        const batch = rows.splice(0, batchSize)
        yield { relationId, relationName: relationSchema?.name ?? worksheetName, fields, rows: batch, rowStart }
        rowStart += batch.length
      }
    }
    if (!fields && headers) {
      fields = xlsxFields(headers, buffered)
      rows = buffered.map((record) => xlsxRow(record, fields!))
    }
    if (fields && rows.length) yield { relationId, relationName: relationSchema?.name ?? worksheetName, fields, rows, rowStart }
  }
}

interface EmbeddedWorkbookSchemas { legacy?: ContextField[]; relations: Array<{ name: string; sheetName: string; fields: ContextField[] }> }

function readWorkbookSidecar(path: string): EmbeddedWorkbookSchemas | undefined {
  const sidecar = `${path}.pluma-schema.json`
  if (!existsSync(sidecar)) return undefined
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as { format?: unknown; version?: unknown; fields?: unknown; relations?: unknown }
  if (parsed.version !== 1) throw new ContextError("PLUMA_SCHEMA_INVALID", "Unsupported XLSX schema sidecar")
  if (parsed.format === "pluma-tabular-schema" && Array.isArray(parsed.fields)) return { legacy: validateEmbeddedFields(parsed.fields), relations: [] }
  if (parsed.format === "pluma-workbook-schema" && Array.isArray(parsed.relations)) {
    const relations = parsed.relations.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextError("PLUMA_SCHEMA_INVALID", "Invalid workbook relation sidecar")
      const item = value as { name?: unknown; sheetName?: unknown; fields?: unknown }
      if (typeof item.name !== "string" || typeof item.sheetName !== "string" || !Array.isArray(item.fields)) throw new ContextError("PLUMA_SCHEMA_INVALID", "Invalid workbook relation sidecar")
      return { name: item.name, sheetName: item.sheetName, fields: validateEmbeddedFields(item.fields) }
    })
    return { relations }
  }
  throw new ContextError("PLUMA_SCHEMA_INVALID", "Invalid XLSX schema sidecar")
}

async function readEmbeddedXlsxSchemas(path: string): Promise<EmbeddedWorkbookSchemas> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(path, { worksheets: "emit", sharedStrings: "cache", styles: "ignore", hyperlinks: "ignore" })
  const result: EmbeddedWorkbookSchemas = { relations: [] }
  for await (const worksheet of workbook) {
    const metadata = (worksheet as unknown as { name?: string }).name === "_pluma_schema"
    for await (const row of worksheet) {
      if (!metadata) continue
      const parsed = parseEmbeddedSchema(cellValue(row.getCell(1).value))
      if (Array.isArray(parsed)) result.legacy = parsed
      else result.relations.push(parsed)
    }
  }
  return result
}

function parseEmbeddedSchema(value: unknown): ContextField[] | { name: string; sheetName: string; fields: ContextField[] } {
  if (typeof value !== "string") throw new ContextError("PLUMA_SCHEMA_INVALID", "Embedded XLSX schema is not text")
  const parsed = JSON.parse(value) as { format?: unknown; version?: unknown; fields?: unknown }
  if ((parsed.format !== "pluma-tabular-schema" && parsed.format !== "pluma-tabular-relation") || parsed.version !== 1 || !Array.isArray(parsed.fields)) throw new ContextError("PLUMA_SCHEMA_INVALID", "Embedded XLSX schema is invalid")
  const fields = validateEmbeddedFields(parsed.fields)
  if (parsed.format === "pluma-tabular-schema") return fields
  const relation = parsed as typeof parsed & { name?: unknown; sheetName?: unknown }
  if (typeof relation.name !== "string" || !relation.name || typeof relation.sheetName !== "string" || !relation.sheetName) throw new ContextError("PLUMA_SCHEMA_INVALID", "Embedded XLSX relation identity is invalid")
  return { name: relation.name, sheetName: relation.sheetName, fields }
}

function validateEmbeddedFields(value: unknown[]): ContextField[] {
  const fields = value as ContextField[]
  if (fields.some((field) => !field || typeof field.id !== "string" || typeof field.name !== "string" || typeof field.type !== "string" || typeof field.nullable !== "boolean")) throw new ContextError("PLUMA_SCHEMA_INVALID", "Embedded XLSX schema contains an invalid field")
  return fields
}

function schemaForSheet(schemas: EmbeddedWorkbookSchemas, sheetName: string): { name: string; fields: ContextField[] } | undefined {
  const relation = schemas.relations.find((item) => sheetName === item.sheetName || sheetName.startsWith(`${item.sheetName} `))
  return relation ? { name: relation.name, fields: relation.fields } : schemas.legacy ? { name: sheetName, fields: schemas.legacy } : undefined
}

function stableRelationId(name: string, used: Set<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "relation"
  let id = base; let suffix = 2
  while (used.has(id)) id = `${base}_${suffix++}`
  used.add(id)
  return id
}

function xlsxFields(headers: unknown[], rows: unknown[][]): ContextField[] {
  const used = new Set<string>()
  return headers.map((value, index) => {
    const column = rows.map((row) => normalizeValue(row[index])).filter((item) => item !== null)
    return { id: safeFieldId(String(value ?? ""), index, used), name: String(value ?? `Column ${index + 1}`), type: inferType(column), nullable: column.length < rows.length }
  })
}

function xlsxRow(values: unknown[], fields: ContextField[]): ContextRow {
  return Object.fromEntries(fields.map((field, index) => [field.id, typedXlsxValue(values[index], field)]))
}

function typedXlsxValue(value: unknown, field: ContextField): ContextRow[string] {
  const normalized = normalizeValue(value)
  if (normalized === null) return null
  if (field.type === "int64" && typeof normalized === "string" && /^[-+]?\d+$/.test(normalized)) {
    const integer = BigInt(normalized)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(normalized) : integer
  }
  if (field.type === "binary" && typeof normalized === "string") return new Uint8Array(Buffer.from(normalized, "base64"))
  if (field.type === "json" && typeof normalized === "string") { try { return JSON.parse(normalized) as ContextRow[string] } catch { throw new ContextError("PLUMA_SCHEMA_INVALID", `Invalid JSON value for field ${field.id}`) } }
  return normalized
}

function inferType(values: unknown[]): ScalarType {
  if (!values.length) return "null"
  if (values.every((value) => typeof value === "boolean")) return "boolean"
  if (values.every((value) => typeof value === "number" && Number.isInteger(value))) return "int64"
  if (values.every((value) => typeof value === "number")) return "float64"
  if (values.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))) return "timestamp"
  if (values.every((value) => typeof value === "string")) return "utf8"
  if (values.every((value) => value instanceof Uint8Array)) return "binary"
  return "json"
}

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString()
    if ("formula" in value) return `=${value.formula}`
    if ("richText" in value) return value.richText.map((part) => part.text).join("")
    if ("text" in value) return value.text
    if ("error" in value) return { error: value.error }
  }
  return value
}
