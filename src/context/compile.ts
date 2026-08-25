import { createReadStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, extname, resolve } from "node:path"
import { ContextPackageWriter, type ContextWriterCheckpoint } from "./package.js"
import { readCsvBatches } from "./csv.js"
import { readXlsxBatches } from "./xlsx.js"
import { readParquetBatches } from "./parquet.js"
import { batchRows } from "./rows.js"
import { ResourceGuard } from "./resource.js"
import { isResumableRowSource, rowsFromInput, type RowInput } from "./stream.js"
import { ContextError, type CompileEvent, type ContextBatch, type ContextField, type ContextManifest, type ContextRow, type IndexDefinition, type MaterializedAggregateDefinition, type ResourceBudget, type ResumableRowSource } from "./types.js"

export interface CompileOptions {
  output?: string
  batchRows?: number
  signal?: AbortSignal
  resourceBudget?: ResourceBudget
  indexes?: IndexDefinition[]
  materializedAggregates?: MaterializedAggregateDefinition[]
  schema?: ContextField[]
}
export interface CompileRowsOptions extends CompileOptions {
  output: string
  relation: { id: string; name: string; fields: ContextField[] }
  checkpointPath?: string
  checkpointEveryRows?: number
}

interface StreamCompileCheckpoint {
  version: 1
  source: ResumableRowSource["identity"]
  cursor: string
  rowsProcessed: number
  writer: ContextWriterCheckpoint
}

export class ContextCompileJob {
  private readonly eventsQueue: CompileEvent[] = []
  private waiting?: () => void
  private done = false
  private manifest?: ContextManifest
  private failure?: unknown
  private readonly controller = new AbortController()
  private currentEvent: CompileEvent = { state: "queued", rowsProcessed: 0, bytesProcessed: 0 }

  constructor(readonly input: string, readonly output: string, private readonly options: CompileOptions) {
    if (options.signal) options.signal.addEventListener("abort", () => this.controller.abort(), { once: true })
    void this.run()
  }

  async *events(): AsyncGenerator<CompileEvent> {
    while (!this.done || this.eventsQueue.length) {
      if (this.eventsQueue.length) { yield this.eventsQueue.shift()!; continue }
      await new Promise<void>((resolve) => { this.waiting = resolve })
    }
  }

  async inspect(): Promise<CompileEvent> {
    return this.currentEvent
  }

  async cancel(): Promise<void> { this.controller.abort(); while (!this.done) await new Promise((resolve) => setTimeout(resolve, 5)) }

  async result(): Promise<ContextManifest> {
    while (!this.done) await new Promise((resolve) => setTimeout(resolve, 5))
    if (this.failure) throw this.failure
    if (!this.manifest) throw new ContextError("PLUMA_COMPILE_CANCELLED", "Compile job was cancelled")
    return this.manifest
  }

  private emit(event: CompileEvent): void { this.currentEvent = event; this.eventsQueue.push(event); this.waiting?.(); this.waiting = undefined }

  private async run(): Promise<void> {
    let writer: ContextPackageWriter | undefined
    try {
      const guard = new ResourceGuard({ ...this.options.resourceBudget, signal: this.controller.signal })
      this.emit({ state: "discovering", rowsProcessed: 0, bytesProcessed: 0 })
      const before = sourceFileIdentity(this.input)
      const source = { kind: extname(this.input).slice(1).toLowerCase(), name: basename(this.input), sha256: await fileSha256(this.input, this.controller.signal), bytes: before.size }
      writer = new ContextPackageWriter(this.output, basename(this.input), source, Math.floor(guard.budget.memoryBytes / 2), this.options.indexes, this.options.materializedAggregates)
      let rowsProcessed = 0
      let schemaEmitted = false
      this.emit({ state: "compiling", rowsProcessed, bytesProcessed: 0 })
      for await (const batch of batchesFor(this.input, this.options.batchRows, this.options.schema)) {
        guard.checkpoint()
        if (this.controller.signal.aborted) throw new ContextError("PLUMA_COMPILE_CANCELLED", "Compile job was cancelled")
        writer.writeBatch(batch, batch.relationName ?? batch.relationId)
        rowsProcessed += batch.rows.length
        this.emit({ state: "compiling", rowsProcessed, bytesProcessed: 0, ...(schemaEmitted ? {} : { provisionalSchema: { provisional: true as const, relations: [{ id: batch.relationId, name: batch.relationId, fields: batch.fields }] } }) })
        schemaEmitted = true
      }
      const after = sourceFileIdentity(this.input)
      const finalHash = await fileSha256(this.input, this.controller.signal)
      if (!sameFileIdentity(before, after) || finalHash !== source.sha256) throw new ContextError("PLUMA_SOURCE_CHANGED", "Input file changed during compilation")
      this.emit({ state: "finalizing", rowsProcessed, bytesProcessed: before.size })
      this.manifest = writer.commit()
      this.emit({ state: "completed", rowsProcessed, bytesProcessed: before.size })
    } catch (error) {
      writer?.abort()
      if (this.controller.signal.aborted || (error instanceof ContextError && error.code === "PLUMA_COMPILE_CANCELLED")) this.emit({ state: "cancelled", rowsProcessed: 0, bytesProcessed: 0 })
      else { this.failure = error; this.emit({ state: "failed", rowsProcessed: 0, bytesProcessed: 0, warning: error instanceof Error ? error.message : "Compile failed" }) }
    } finally { this.done = true; this.waiting?.() }
  }
}

export class StreamContextCompileJob {
  private readonly eventsQueue: CompileEvent[] = []
  private waiting?: () => void
  private done = false
  private manifest?: ContextManifest
  private failure?: unknown
  private readonly controller = new AbortController()
  private currentEvent: CompileEvent = { state: "queued", rowsProcessed: 0, bytesProcessed: 0 }

  constructor(private readonly source: RowInput | ResumableRowSource, readonly output: string, private readonly options: CompileRowsOptions) {
    options.signal?.addEventListener("abort", () => this.controller.abort(), { once: true })
    void this.run()
  }

  async *events(): AsyncGenerator<CompileEvent> {
    while (!this.done || this.eventsQueue.length) {
      if (this.eventsQueue.length) { yield this.eventsQueue.shift()!; continue }
      await new Promise<void>((resolve) => { this.waiting = resolve })
    }
  }

  async inspect(): Promise<CompileEvent> { return this.currentEvent }
  async cancel(): Promise<void> { this.controller.abort(); while (!this.done) await new Promise((resolve) => setTimeout(resolve, 5)) }
  async result(): Promise<ContextManifest> {
    while (!this.done) await new Promise((resolve) => setTimeout(resolve, 5))
    if (this.failure) throw this.failure
    if (!this.manifest) throw new ContextError("PLUMA_COMPILE_CANCELLED", "Compile job was cancelled")
    return this.manifest
  }

  private emit(event: CompileEvent): void { this.currentEvent = event; this.eventsQueue.push(event); this.waiting?.(); this.waiting = undefined }

  private async run(): Promise<void> {
    let writer: ContextPackageWriter | undefined
    const identity = isResumableRowSource(this.source) ? this.source.identity : undefined
    try {
      const guard = new ResourceGuard({ ...this.options.resourceBudget, signal: this.controller.signal })
      const checkpoint = identity && this.options.checkpointPath ? readStreamCheckpoint(this.options.checkpointPath, identity) : undefined
      const sourceRows = isResumableRowSource(this.source) ? this.source.open(checkpoint?.cursor) : this.source
      const sourceHash = identity?.fingerprint.replace(/^sha256:/, "") ?? createHash("sha256").update(`non-resumable:${Date.now()}`).digest("hex")
      const source = { kind: "row-stream", name: this.options.relation.name, sha256: sourceHash, bytes: 0 }
      writer = new ContextPackageWriter(this.output, this.options.relation.name, source, Math.floor(guard.budget.memoryBytes / 2), this.options.indexes, this.options.materializedAggregates, checkpoint?.writer)
      this.emit({ state: "discovering", rowsProcessed: 0, bytesProcessed: 0 })
      const validated = validateRows(rowsFromInput(sourceRows), this.options.relation.fields)
      let rowsProcessed = checkpoint?.rowsProcessed ?? 0
      let lastCheckpointRows = rowsProcessed
      this.emit({ state: "compiling", rowsProcessed, bytesProcessed: 0 })
      for await (const batch of batchRows(validated, this.options.relation.id, this.options.relation.fields, this.options.batchRows)) {
        guard.checkpoint()
        const resumedBatch = { ...batch, rowStart: batch.rowStart + (checkpoint?.rowsProcessed ?? 0) }
        writer.writeBatch(resumedBatch, this.options.relation.name)
        rowsProcessed += batch.rows.length
        if (identity && this.options.checkpointPath && rowsProcessed - lastCheckpointRows >= (this.options.checkpointEveryRows ?? this.options.batchRows ?? 8_192)) {
          const cursor = (this.source as ResumableRowSource).cursor(batch.rows.at(-1)!)
          writeStreamCheckpoint(this.options.checkpointPath, { version: 1, source: identity, cursor, rowsProcessed, writer: writer.checkpoint() })
          lastCheckpointRows = rowsProcessed
        }
        this.emit({ state: "compiling", rowsProcessed, bytesProcessed: 0 })
      }
      this.emit({ state: "finalizing", rowsProcessed, bytesProcessed: 0 })
      this.manifest = writer.commit(identity ? [] : ["Source stream is non-resumable"])
      if (this.options.checkpointPath) rmSync(this.options.checkpointPath, { force: true })
      this.emit({ state: "completed", rowsProcessed, bytesProcessed: 0 })
    } catch (error) {
      if (!(identity && this.options.checkpointPath && existsSync(this.options.checkpointPath))) writer?.abort()
      if (this.controller.signal.aborted) this.emit({ state: "cancelled", rowsProcessed: 0, bytesProcessed: 0 })
      else { this.failure = error; this.emit({ state: "failed", rowsProcessed: 0, bytesProcessed: 0, warning: error instanceof Error ? error.message : "Compile failed" }) }
    } finally { this.done = true; this.waiting?.() }
  }
}

function readStreamCheckpoint(path: string, identity: ResumableRowSource["identity"]): StreamCompileCheckpoint | undefined {
  if (!existsSync(path)) return undefined
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as StreamCompileCheckpoint
  if (checkpoint.version !== 1 || checkpoint.source.snapshot !== identity.snapshot || checkpoint.source.fingerprint !== identity.fingerprint || !Number.isSafeInteger(checkpoint.rowsProcessed) || checkpoint.rowsProcessed < 0 || typeof checkpoint.cursor !== "string") throw new ContextError("PLUMA_CHECKPOINT_INVALID", "Compile checkpoint does not match the resumable source snapshot")
  return checkpoint
}

function writeStreamCheckpoint(path: string, checkpoint: StreamCompileCheckpoint): void {
  const staging = `${path}.staging-${process.pid}`
  writeFileSync(staging, JSON.stringify(checkpoint) + "\n", { mode: 0o600 })
  renameSync(staging, path)
}

async function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) {
    if (signal.aborted) throw new ContextError("PLUMA_COMPILE_CANCELLED", "Compile job was cancelled")
    hash.update(chunk)
  }
  return hash.digest("hex")
}

export function compileContext(input: string, options: CompileOptions = {}): ContextCompileJob {
  const absolute = resolve(input)
  const output = resolve(options.output ?? `${absolute}.pluma`)
  return new ContextCompileJob(absolute, output, options)
}

export function compileRows(source: RowInput | ResumableRowSource, options: CompileRowsOptions): StreamContextCompileJob {
  return new StreamContextCompileJob(source, resolve(options.output), options)
}

async function* batchesFor(path: string, batchRows?: number, fields?: ContextField[]): AsyncGenerator<ContextBatch> {
  const extension = extname(path).toLowerCase()
  if (extension === ".csv") yield* readCsvBatches(path, { batchRows, fields })
  else if (extension === ".xlsx") yield* readXlsxBatches(path, batchRows)
  else if (extension === ".parquet") yield* readParquetBatches(path)
  else throw new ContextError("PLUMA_FORMAT_UNSUPPORTED", `Unsupported context input: ${extension}`)
}

function sourceFileIdentity(path: string): { size: number; mtimeMs: number; ino: number } {
  const stats = statSync(path)
  return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino }
}

function sameFileIdentity(left: ReturnType<typeof sourceFileIdentity>, right: ReturnType<typeof sourceFileIdentity>): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino
}

async function* validateRows(rows: AsyncIterable<ContextRow>, fields: ContextField[]): AsyncGenerator<ContextRow> {
  const expected = new Set(fields.map((field) => field.id))
  if (expected.size !== fields.length) throw new ContextError("PLUMA_SCHEMA_INVALID", "Relation field ids must be unique")
  for await (const row of rows) {
    const unknown = Object.keys(row).find((key) => !expected.has(key))
    if (unknown) throw new ContextError("PLUMA_ROW_INVALID", `Stream row contains unknown field: ${unknown}`)
    for (const field of fields) if (!field.nullable && (row[field.id] === null || row[field.id] === undefined)) throw new ContextError("PLUMA_ROW_INVALID", `Required field is missing: ${field.id}`)
    yield Object.fromEntries(fields.map((field) => [field.id, row[field.id] ?? null]))
  }
}
