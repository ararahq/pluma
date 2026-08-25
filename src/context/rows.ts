import { ContextError, type ContextBatch, type ContextField, type ContextRow, type ContextValue, type ScalarType } from "./types.js"

export const DEFAULT_BATCH_ROWS = 8_192

export function safeFieldId(name: string, index: number, used: Set<string>): string {
  const base = name.trim().normalize("NFKC").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "") || `column_${index + 1}`
  let id = base
  let suffix = 2
  while (used.has(id)) id = `${base}_${suffix++}`
  used.add(id)
  return id
}

export function inferFields(headers: string[], sample: string[][]): ContextField[] {
  const used = new Set<string>()
  return headers.map((name, index) => {
    const values = sample.map((row) => row[index] ?? "")
    const nonEmpty = values.filter((value) => value !== "")
    return {
      id: safeFieldId(name, index, used),
      name: name || `Column ${index + 1}`,
      type: inferStrings(nonEmpty),
      nullable: nonEmpty.length !== values.length,
    }
  })
}

function inferStrings(values: string[]): ScalarType {
  if (values.length === 0) return "utf8"
  if (values.every((v) => /^(true|false)$/i.test(v))) return "boolean"
  if (values.every((v) => /^[-+]?\d+$/.test(v) && Number.isSafeInteger(Number(v)))) return "int64"
  if (values.every((v) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v))) return "float64"
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return "date"
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)))) return "timestamp"
  return "utf8"
}

export function coerceString(value: string, field: ContextField): ContextValue {
  if (value === "") return null
  if (field.type === "boolean") return value.toLowerCase() === "true"
  if (field.type === "int64") {
    const integer = BigInt(value)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : integer
  }
  if (field.type === "float64") return Number(value)
  if (field.type === "binary") return new Uint8Array(Buffer.from(value, "base64"))
  if (field.type === "json") {
    try { return JSON.parse(value) as ContextValue } catch { throw new ContextError("PLUMA_SCHEMA_INVALID", `Invalid JSON value for field ${field.id}`) }
  }
  if (field.type === "date" || field.type === "timestamp") return value
  return value
}

export function rowsFromArrays(values: unknown[][], fields: ContextField[]): ContextRow[] {
  return values.map((valuesRow) => Object.fromEntries(fields.map((field, index) => [field.id, normalizeValue(valuesRow[index])])))
}

export function normalizeValue(value: unknown): ContextValue {
  if (value === undefined || value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value
  if (value instanceof Date || value instanceof Uint8Array) return value
  if (typeof value === "object") return value as Record<string, unknown>
  return String(value)
}

export async function* batchRows(source: AsyncIterable<ContextRow>, relationId: string, fields: ContextField[], size = DEFAULT_BATCH_ROWS): AsyncGenerator<ContextBatch> {
  let rows: ContextRow[] = []
  let rowStart = 0
  for await (const row of source) {
    rows.push(row)
    if (rows.length >= size) {
      yield { relationId, fields, rows, rowStart }
      rowStart += rows.length
      rows = []
    }
  }
  if (rows.length) yield { relationId, fields, rows, rowStart }
}
