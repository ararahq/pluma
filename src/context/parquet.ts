import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, type SchemaElement } from "hyparquet"
import type { ContextBatch, ContextField, ContextRow, ScalarType } from "./types.js"
import { normalizeValue, safeFieldId } from "./rows.js"
import { DEFAULT_BATCH_ROWS } from "./rows.js"

export async function* readParquetBatches(path: string, batchRows = DEFAULT_BATCH_ROWS): AsyncGenerator<ContextBatch> {
  const file = await asyncBufferFromFile(path)
  const metadata = await parquetMetadataAsync(file)
  const leaves = metadata.schema.filter((element, index) => index > 0 && !element.num_children)
  const used = new Set<string>()
  const fields: ContextField[] = leaves.map((element, index) => ({ id: safeFieldId(element.name, index, used), name: element.name, type: parquetType(element), nullable: element.repetition_type !== "REQUIRED" }))
  let rowStart = 0
  for (const group of metadata.row_groups) {
    const groupEnd = rowStart + Number(group.num_rows)
    while (rowStart < groupEnd) {
      const rowEnd = Math.min(groupEnd, rowStart + batchRows)
      const values = await parquetReadObjects({ file, metadata, rowFormat: "object", rowStart, rowEnd })
      const rows: ContextRow[] = values.map((row) => Object.fromEntries(fields.map((field) => [field.id, normalizeValue(row[field.name])])))
      yield { relationId: "table", fields, rows, rowStart }
      rowStart = rowEnd
    }
  }
}

function parquetType(element: SchemaElement): ScalarType {
  const logical = element.logical_type ? Object.keys(element.logical_type)[0]?.toLowerCase() : ""
  if (logical.includes("string") || element.converted_type === "UTF8") return "utf8"
  if (logical.includes("decimal") || element.converted_type === "DECIMAL") return "decimal"
  if (logical.includes("date") || element.converted_type === "DATE") return "date"
  if (logical.includes("timestamp") || String(element.converted_type).startsWith("TIMESTAMP")) return "timestamp"
  if (element.type === "BOOLEAN") return "boolean"
  if (element.type === "INT32" || element.type === "INT64") return "int64"
  if (element.type === "FLOAT" || element.type === "DOUBLE") return "float64"
  if (element.type === "BYTE_ARRAY" || element.type === "FIXED_LEN_BYTE_ARRAY") return "binary"
  return "json"
}
