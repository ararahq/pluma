import { once } from "node:events"
import { createWriteStream, existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import ExcelJS from "exceljs"
import { fileWriter, parquetWriteRows } from "hyparquet-writer"
import { escapeCsv } from "./csv.js"
import { ResourceGuard } from "./resource.js"
import { rowsFromInput, type RowInput } from "./stream.js"
import type { ContextField, ContextRow, ResourceBudget } from "./types.js"

export type ExportFormat = "csv" | "xlsx" | "parquet"

export interface XlsxExportOptions {
  sheetName?: string
  freezeHeader?: boolean
  autoFilter?: boolean
  widths?: Record<string, number>
  headerStyle?: { background?: string; color?: string; bold?: boolean }
  numberFormats?: Record<string, string>
  tableName?: string
}

export interface WorkbookRelation {
  name: string
  fields: ContextField[]
  rows: RowInput
  xlsx?: XlsxExportOptions
}

export interface ExportWorkbookOptions {
  relations: WorkbookRelation[]
  output: string
  resourceBudget?: ResourceBudget
}

export interface ExportRowsOptions {
  rows: RowInput
  fields: ContextField[]
  format: ExportFormat
  output: string
  resourceBudget?: ResourceBudget
  xlsx?: XlsxExportOptions
  csv?: { schemaSidecar?: boolean }
}

export async function exportRows(rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[], format: ExportFormat, output: string, resourceBudget?: ResourceBudget): Promise<void> {
  return exportData({ rows, fields, format, output, resourceBudget })
}

export async function exportData(options: ExportRowsOptions): Promise<void> {
  const guard = new ResourceGuard(options.resourceBudget)
  const staging = `${options.output}.staging-${process.pid}-${Date.now()}`
  try {
    const rows = guardedRows(rowsFromInput(options.rows), guard)
    if (options.format === "csv") await exportCsv(rows, options.fields, staging)
    else if (options.format === "xlsx") await exportXlsx(rows, options.fields, staging, options.xlsx)
    else await exportParquet(rows, options.fields, staging)
    guard.checkpoint()
    renameSync(staging, options.output)
    if (options.format === "csv" && options.csv?.schemaSidecar !== false) writeSchemaSidecar(options.output, options.fields)
    if (options.format === "xlsx") writeMetadataSidecar(options.output, { format: "pluma-tabular-schema", version: 1, fields: options.fields })
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true })
    throw error
  }
}

export async function exportWorkbook(options: ExportWorkbookOptions): Promise<void> {
  if (!options.relations.length) throw new Error("A workbook requires at least one relation")
  const guard = new ResourceGuard(options.resourceBudget)
  const staging = `${options.output}.staging-${process.pid}-${Date.now()}`
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: staging, useStyles: true, useSharedStrings: false })
  try {
    const metadata = workbook.addWorksheet("_pluma_schema", { state: "veryHidden" })
    for (const relation of options.relations) metadata.addRow([JSON.stringify({ format: "pluma-tabular-relation", version: 1, name: relation.name, sheetName: safeSheetName(relation.xlsx?.sheetName ?? relation.name), tableName: relation.xlsx?.tableName, fields: relation.fields })]).commit()
    metadata.commit()
    for (const relation of options.relations) await appendWorkbookRelation(workbook, guardedRows(rowsFromInput(relation.rows), guard), relation.fields, { sheetName: relation.name, ...relation.xlsx })
    await workbook.commit()
    guard.checkpoint()
    renameSync(staging, options.output)
    writeMetadataSidecar(options.output, { format: "pluma-workbook-schema", version: 1, relations: options.relations.map((relation) => ({ name: relation.name, sheetName: safeSheetName(relation.xlsx?.sheetName ?? relation.name), fields: relation.fields })) })
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true })
    throw error
  }
}

async function exportCsv(rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[], output: string): Promise<void> {
  const stream = createWriteStream(output, { encoding: "utf8" })
  try {
    await write(stream, fields.map((field) => escapeCsv(field.name)).join(",") + "\n")
    for await (const row of rows) await write(stream, fields.map((field) => escapeCsv(row[field.id])).join(",") + "\n")
    stream.end()
    await once(stream, "finish")
  } catch (error) { stream.destroy(); throw error }
}

async function write(stream: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain")
}

async function exportXlsx(rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[], output: string, options: XlsxExportOptions = {}): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: output, useStyles: true, useSharedStrings: false })
  const metadata = workbook.addWorksheet("_pluma_schema", { state: "veryHidden" })
  metadata.addRow([JSON.stringify({ format: "pluma-tabular-schema", version: 1, fields })]).commit()
  metadata.commit()
  await appendWorkbookRelation(workbook, rows, fields, options)
  await workbook.commit()
}

async function appendWorkbookRelation(workbook: ExcelJS.stream.xlsx.WorkbookWriter, rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[], options: XlsxExportOptions): Promise<void> {
  let sheetIndex = 1
  let sheet = createSheet(workbook, fields, sheetIndex, options)
  let rowCount = 1
  for await (const row of rows) {
    if (rowCount >= 1_048_576) {
      sheet.commit()
      sheet = createSheet(workbook, fields, ++sheetIndex, options)
      rowCount = 1
    }
    sheet.addRow(fields.map((field) => safeSpreadsheetValue(row[field.id]))).commit()
    rowCount++
  }
  sheet.commit()
}

async function exportParquet(rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[], output: string): Promise<void> {
  await parquetWriteRows({
    writer: fileWriter(output),
    rows: normalizeRows(rows, fields),
    columns: fields.map((field) => ({ name: field.id, type: parquetType(field), nullable: field.nullable })),
    rowGroupSize: 128_000,
    statistics: true,
  })
}

async function* normalizeRows(rows: AsyncIterable<ContextRow> | Iterable<ContextRow>, fields: ContextField[]): AsyncGenerator<Record<string, unknown>> {
  for await (const row of rows) yield Object.fromEntries(fields.map((field) => [field.id, parquetValue(row[field.id], field)]))
}

function parquetType(field: ContextField): "BOOLEAN" | "INT64" | "DOUBLE" | "STRING" | "TIMESTAMP" | "JSON" {
  if (field.type === "boolean") return "BOOLEAN"
  if (field.type === "int64") return "INT64"
  if (field.type === "float64" || field.type === "decimal") return "DOUBLE"
  if (field.type === "timestamp" || field.type === "date") return "TIMESTAMP"
  if (field.type === "json") return "JSON"
  return "STRING"
}

function parquetValue(value: unknown, field: ContextField): unknown {
  if (field.type === "int64" && typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if ((field.type === "float64" || field.type === "decimal") && typeof value === "bigint") return Number(value)
  if (value instanceof Date) return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (value && typeof value === "object") return JSON.stringify(value)
  return value
}

function safeSpreadsheetValue(value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  let normalized = typeof value === "object" ? JSON.stringify(value) : value
  if (typeof normalized === "bigint") normalized = normalized.toString()
  if (typeof normalized === "string" && /^[\t\r\n\0]*[=+\-@]/.test(normalized)) return `'${normalized}`
  return normalized as ExcelJS.CellValue
}

function createSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, fields: ContextField[], index: number, options: XlsxExportOptions): ReturnType<ExcelJS.stream.xlsx.WorkbookWriter["addWorksheet"]> {
  const baseName = safeSheetName(options.sheetName ?? "Export")
  const sheet = workbook.addWorksheet(index === 1 ? baseName : safeSheetName(`${baseName} ${index}`), { views: options.freezeHeader === false ? undefined : [{ state: "frozen", ySplit: 1 }] })
  const header = sheet.addRow(fields.map((field) => field.name))
  const background = normalizeArgb(options.headerStyle?.background ?? "15213F")
  const color = normalizeArgb(options.headerStyle?.color ?? "FFFFFF")
  header.eachCell((cell) => { cell.font = { bold: options.headerStyle?.bold ?? true, color: { argb: color } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: background } } })
  header.commit()
  if (options.autoFilter !== false && fields.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fields.length } }
  fields.forEach((field, fieldIndex) => { sheet.getColumn(fieldIndex + 1).width = Math.min(255, Math.max(1, options.widths?.[field.id] ?? Math.min(48, Math.max(12, field.name.length + 2)))) })
  fields.forEach((field, fieldIndex) => { const format = options.numberFormats?.[field.id]; if (format) sheet.getColumn(fieldIndex + 1).numFmt = format })
  return sheet
}

function safeSheetName(value: string): string {
  const normalized = value.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31)
  return normalized || "Export"
}

function normalizeArgb(value: string): string {
  const normalized = value.replace(/^#/, "").toUpperCase()
  return normalized.length === 6 ? `FF${normalized}` : normalized
}

async function* guardedRows(rows: AsyncIterable<ContextRow>, guard: ResourceGuard): AsyncGenerator<ContextRow> {
  for await (const row of rows) { guard.checkpoint(); yield row }
}

function writeSchemaSidecar(output: string, fields: ContextField[]): void {
  writeMetadataSidecar(output, { format: "pluma-tabular-schema", version: 1, fields })
}

function writeMetadataSidecar(output: string, value: unknown): void {
  const path = `${output}.pluma-schema.json`
  const staging = `${path}.staging-${process.pid}-${Date.now()}`
  writeFileSync(staging, JSON.stringify(value) + "\n", { mode: 0o600 })
  renameSync(staging, path)
}
