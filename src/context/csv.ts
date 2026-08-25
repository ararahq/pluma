import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { createInterface } from "node:readline"
import type { ContextBatch, ContextField, ContextRow } from "./types.js"
import { DEFAULT_BATCH_ROWS, coerceString, inferFields } from "./rows.js"
import { ContextError } from "./types.js"

export interface CsvReadOptions { delimiter?: string; batchRows?: number; sampleRows?: number; maxColumns?: number; maxCellBytes?: number; maxRecordBytes?: number; maxInputBytes?: number; fields?: ContextField[] }

export async function* readCsvBatches(path: string, options: CsvReadOptions = {}): AsyncGenerator<ContextBatch> {
  const maxInputBytes = options.maxInputBytes ?? 1024 * 1024 * 1024 * 1024
  if (statSync(path).size > maxInputBytes) throw new ContextError("PLUMA_INPUT_LIMIT", `CSV exceeds ${maxInputBytes} bytes`)
  const delimiter = options.delimiter ?? ","
  const iterator = parseCsvRecords(path, delimiter, options)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return
  const headers = first.value
  const sample: string[][] = []
  const sampleRows = options.sampleRows ?? 1_000
  while (sample.length < sampleRows) {
    const item = await iterator.next()
    if (item.done) break
    sample.push(item.value)
  }
  const fields = options.fields ?? readCsvSchemaSidecar(path) ?? inferFields(headers, sample)
  if (fields.length !== headers.length) throw new ContextError("PLUMA_SCHEMA_INVALID", "CSV schema field count does not match the header")
  const rows: ContextRow[] = sample.map((record) => recordToRow(record, fields))
  let rowStart = 0
  const size = options.batchRows ?? DEFAULT_BATCH_ROWS
  for (;;) {
    while (rows.length < size) {
      const item = await iterator.next()
      if (item.done) break
      rows.push(recordToRow(item.value, fields))
    }
    if (rows.length === 0) break
    const batchRows = rows.splice(0, size)
    yield { relationId: "table", fields, rows: batchRows, rowStart }
    rowStart += batchRows.length
  }
}

export function readCsvSchemaSidecar(path: string): ContextField[] | undefined {
  const sidecar = `${path}.pluma-schema.json`
  if (!existsSync(sidecar)) return undefined
  const value = JSON.parse(readFileSync(sidecar, "utf8")) as { format?: unknown; version?: unknown; fields?: unknown }
  if (value.format !== "pluma-tabular-schema" || value.version !== 1 || !Array.isArray(value.fields)) throw new ContextError("PLUMA_SCHEMA_INVALID", "Invalid CSV schema sidecar")
  const fields = value.fields.map(validateField)
  if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new ContextError("PLUMA_SCHEMA_INVALID", "CSV schema field ids must be unique")
  return fields
}

function validateField(value: unknown): ContextField {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextError("PLUMA_SCHEMA_INVALID", "CSV schema field must be an object")
  const field = value as Partial<ContextField>
  const types = new Set(["null", "boolean", "int64", "float64", "decimal", "utf8", "binary", "date", "timestamp", "json"])
  if (typeof field.id !== "string" || !field.id || typeof field.name !== "string" || typeof field.nullable !== "boolean" || typeof field.type !== "string" || !types.has(field.type)) throw new ContextError("PLUMA_SCHEMA_INVALID", "CSV schema contains an invalid field")
  return field as ContextField
}

function recordToRow(record: string[], fields: ContextField[]): ContextRow {
  return Object.fromEntries(fields.map((field, index) => [field.id, coerceString(record[index] ?? "", field)]))
}

async function* parseCsvRecords(path: string, delimiter: string, options: CsvReadOptions): AsyncGenerator<string[]> {
  if ([...delimiter].length !== 1) throw new Error("CSV delimiter must be one character")
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
  const maxColumns = options.maxColumns ?? 10_000
  const maxCellBytes = options.maxCellBytes ?? 16 * 1024 * 1024
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024 * 1024
  let fields: string[] = []
  let field = ""
  let quoted = false
  let recordBytes = 0
  for await (const line of lines) {
    recordBytes += Buffer.byteLength(line) + 1
    if (recordBytes > maxRecordBytes) throw new ContextError("PLUMA_CSV_RECORD_LIMIT", `CSV record exceeds ${maxRecordBytes} bytes`)
    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { field += '"'; index++ }
        else quoted = !quoted
      } else if (char === delimiter && !quoted) {
        fields.push(field); field = ""
        if (fields.length >= maxColumns) throw new ContextError("PLUMA_COLUMN_LIMIT", `CSV exceeds ${maxColumns} columns`)
      } else field += char
      if (Buffer.byteLength(field) > maxCellBytes) throw new ContextError("PLUMA_CELL_LIMIT", `CSV cell exceeds ${maxCellBytes} bytes`)
    }
    if (quoted) { field += "\n"; continue }
    fields.push(field)
    yield fields
    fields = []; field = ""; recordBytes = 0
  }
  if (quoted) throw new ContextError("PLUMA_CSV_UNTERMINATED", "Unterminated quoted CSV field")
}

export function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ""
  let text = value instanceof Date ? value.toISOString() : value instanceof Uint8Array ? Buffer.from(value).toString("base64") : typeof value === "object" ? JSON.stringify(value) : String(value)
  if (/^[\t\r\n\0]*[=+\-@]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
