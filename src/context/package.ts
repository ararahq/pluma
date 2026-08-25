import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, relative, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow"
import { canonicalJson, sha256 } from "./hash.js"
import { ContextError, PLUMA_CONTEXT_LEGACY_VERSION, PLUMA_CONTEXT_VERSION, type Aggregate, type ContextBatch, type ContextColumnStatistics, type ContextIndex, type ContextManifest, type ContextMaterializedAggregate, type ContextRelation, type ContextRow, type IndexDefinition, type MaterializedAggregateDefinition } from "./types.js"

const PACKAGE_MAX_BLOCK_BYTES = 64 * 1024 * 1024

export interface ContextWriterCheckpoint {
  version: 1
  staging: string
  relations: ContextRelation[]
  artifacts: ContextManifest["artifacts"]
  aggregateRuns: Array<[string, string[]]>
}

export class ContextPackageWriter {
  readonly staging: string
  private readonly relations = new Map<string, ContextRelation>()
  private readonly artifacts: ContextManifest["artifacts"] = []
  private readonly aggregateStates = new Map<string, Map<string, MaterializedGroup>>()
  private readonly aggregateRuns = new Map<string, string[]>()
  private committed = false

  constructor(readonly output: string, readonly name: string, private readonly source: ContextManifest["source"], private readonly maxBlockBytes = PACKAGE_MAX_BLOCK_BYTES, private readonly indexDefinitions: IndexDefinition[] = [], private readonly aggregateDefinitions: MaterializedAggregateDefinition[] = [], checkpoint?: ContextWriterCheckpoint) {
    this.staging = checkpoint?.staging ?? `${resolve(output)}.staging-${process.pid}-${Date.now()}`
    if (checkpoint) {
      if (checkpoint.version !== 1 || !existsSync(this.staging)) throw new ContextError("PLUMA_CHECKPOINT_INVALID", "Compile checkpoint staging directory is missing or unsupported")
      for (const relation of checkpoint.relations) this.relations.set(relation.id, structuredClone(relation))
      this.artifacts.push(...structuredClone(checkpoint.artifacts))
      for (const [key, runs] of checkpoint.aggregateRuns) this.aggregateRuns.set(key, [...runs])
      this.verifyCheckpointArtifacts()
    } else {
      mkdirSync(join(this.staging, "blocks"), { recursive: true })
      mkdirSync(join(this.staging, "views"), { recursive: true })
      mkdirSync(join(this.staging, "indexes"), { recursive: true })
      mkdirSync(join(this.staging, "provenance"), { recursive: true })
    }
  }

  checkpoint(): ContextWriterCheckpoint {
    for (const key of this.aggregateStates.keys()) this.flushAggregateRun(key)
    syncDirectory(this.staging)
    return { version: 1, staging: this.staging, relations: structuredClone([...this.relations.values()]), artifacts: structuredClone(this.artifacts), aggregateRuns: structuredClone([...this.aggregateRuns.entries()]) }
  }

  writeBatch(batch: ContextBatch, relationName = batch.relationId): void {
    const table = tableFromArrays(Object.fromEntries(batch.fields.map((field) => [field.id, batch.rows.map((row) => arrowValue(row[field.id]))])))
    const bytes = tableToIPC(table, "file")
    if (bytes.byteLength > Math.min(PACKAGE_MAX_BLOCK_BYTES, this.maxBlockBytes)) {
      if (batch.rows.length < 2) throw new ContextError("PLUMA_BLOCK_LIMIT", `A single row exceeds the ${Math.min(PACKAGE_MAX_BLOCK_BYTES, this.maxBlockBytes)} byte block limit`)
      const middle = Math.floor(batch.rows.length / 2)
      this.writeBatch({ ...batch, rows: batch.rows.slice(0, middle) }, relationName)
      this.writeBatch({ ...batch, rows: batch.rows.slice(middle), rowStart: batch.rowStart + middle }, relationName)
      return
    }
    const hash = sha256(bytes)
    const path = `blocks/${hash}.arrow`
    this.writeArtifact(path, bytes)
    const relation = this.relations.get(batch.relationId) ?? { id: batch.relationId, name: relationName, fields: batch.fields, rowCount: 0, blocks: [] }
    relation.blocks.push({ hash, path, relationId: relation.id, rowStart: batch.rowStart, rowEnd: batch.rowStart + batch.rows.length, bytes: bytes.byteLength, statistics: blockStatistics(batch) })
    relation.rowCount += batch.rows.length
    this.relations.set(relation.id, relation)
    this.updateMaterializedAggregates(batch)
  }

  commit(warnings: string[] = []): ContextManifest {
    const relations = [...this.relations.values()]
    for (const relation of relations) {
      relation.indexes = this.buildIndexes(relation)
      relation.materializedAggregates = this.buildMaterializedAggregates(relation)
    }
    rmSync(join(this.staging, "indexes", ".spill"), { recursive: true, force: true })
    const overview = renderOverview(this.name, relations)
    const schema = renderSchema(relations)
    this.writeArtifact("views/overview.md", Buffer.from(overview))
    this.writeArtifact("views/schema.md", Buffer.from(schema))
    this.writeArtifact("provenance/source.json", Buffer.from(canonicalJson(this.source)))
    const base = {
      format: "pluma-context" as const,
      version: PLUMA_CONTEXT_VERSION,
      id: sha256(`${this.source.sha256}:${this.name}`).slice(0, 24),
      name: this.name,
      createdAt: new Date().toISOString(),
      source: this.source,
      relations,
      artifacts: [...this.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
      warnings,
      compiler: { name: "@ararahq/pluma" as const, version: "0.4.2" },
    }
    const fingerprint = sha256(canonicalJson(base) + base.artifacts.map((artifact) => artifact.sha256).join(""))
    const manifest: ContextManifest = { ...base, fingerprint }
    writeDurable(join(this.staging, "manifest.json"), Buffer.from(canonicalJson(manifest)))
    syncDirectory(this.staging)
    if (existsSync(resolve(this.output))) throw new ContextError("PLUMA_OUTPUT_EXISTS", `Output already exists: ${this.output}`)
    renameSync(this.staging, resolve(this.output))
    syncDirectory(dirname(resolve(this.output)))
    this.committed = true
    return manifest
  }

  abort(): void {
    if (!this.committed) rmSync(this.staging, { recursive: true, force: true })
  }

  private writeArtifact(path: string, bytes: Uint8Array): void {
    const destination = safeJoin(this.staging, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeDurable(destination, bytes)
    this.artifacts.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
  }

  private verifyCheckpointArtifacts(): void {
    for (const artifact of this.artifacts) {
      const path = safeJoin(this.staging, artifact.path)
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || statSync(path).size !== artifact.bytes || fileSha256Sync(path) !== artifact.sha256) throw new ContextError("PLUMA_CHECKPOINT_INVALID", "Compile checkpoint artifact verification failed")
    }
  }

  private buildIndexes(relation: ContextRelation): ContextIndex[] {
    const automatic = relation.fields.filter((field) => !["null", "binary", "json"].includes(field.type)).slice(0, 32).map((field) => ({ columns: [field.id] }))
    const definitions = [...this.indexDefinitions, ...automatic].filter((definition, index, all) => all.findIndex((candidate) => canonicalJson(candidate.columns) === canonicalJson(definition.columns)) === index)
    return definitions.map((definition) => {
      if (!definition.columns.length) throw new ContextError("PLUMA_INDEX_INVALID", "An index requires at least one column")
      for (const column of definition.columns) if (!relation.fields.some((field) => field.id === column)) throw new ContextError("PLUMA_INDEX_INVALID", `Unknown index column: ${column}`)
      const id = `idx_${sha256(canonicalJson(definition.columns)).slice(0, 16)}`
      const entries = blockIndexEntries(relation, definition.columns[0])
      const path = `indexes/${relation.id}/${id}.json`
      const bytes = Buffer.from(canonicalJson({ format: "pluma-block-index", version: 1, relationId: relation.id, columns: definition.columns, entries }))
      this.writeArtifact(path, bytes)
      return { id, columns: definition.columns, path, entries: entries.length, sha256: sha256(bytes), bytes: bytes.byteLength, comparison: "canonical-v1", nulls: "first" }
    })
  }

  private updateMaterializedAggregates(batch: ContextBatch): void {
    for (const definition of this.aggregateDefinitions) {
      const id = aggregateId(definition)
      const groups = this.aggregateStates.get(`${batch.relationId}:${id}`) ?? new Map<string, MaterializedGroup>()
      for (const row of batch.rows) updateMaterializedGroup(groups, definition, row)
      const key = `${batch.relationId}:${id}`
      this.aggregateStates.set(key, groups)
      if (groups.size >= this.aggregateGroupLimit()) this.flushAggregateRun(key)
    }
  }

  private buildMaterializedAggregates(relation: ContextRelation): ContextMaterializedAggregate[] {
    return this.aggregateDefinitions.map((definition) => {
      for (const column of [...definition.groupBy, ...definition.metrics.flatMap((metric) => metric.column ? [metric.column] : [])]) if (!relation.fields.some((field) => field.id === column)) throw new ContextError("PLUMA_AGGREGATE_INVALID", `Unknown aggregate column: ${column}`)
      const id = aggregateId(definition)
      const key = `${relation.id}:${id}`
      this.flushAggregateRun(key)
      const runs = this.aggregateRuns.get(key) ?? []
      const path = `indexes/${relation.id}/${id}.jsonl`
      const offsetsPath = `indexes/${relation.id}/${id}.offsets`
      const generated = join(this.staging, "indexes", `.generated-${id}-${process.pid}`)
      const generatedOffsets = `${generated}.offsets`
      const groups = mergeAggregateRuns(runs, generated, generatedOffsets, definition)
      const artifact = this.writeArtifactFile(path, generated)
      const offsetsArtifact = this.writeArtifactFile(offsetsPath, generatedOffsets)
      return { id, groupBy: definition.groupBy, metrics: definition.metrics, path, offsetsPath, groups, sha256: artifact.sha256, bytes: artifact.bytes, offsetsSha256: offsetsArtifact.sha256, offsetsBytes: offsetsArtifact.bytes }
    })
  }

  private aggregateGroupLimit(): number { return Math.max(1_024, Math.floor(this.maxBlockBytes / 2_048)) }

  private flushAggregateRun(key: string): void {
    const groups = this.aggregateStates.get(key)
    if (!groups?.size) return
    const directory = join(this.staging, "indexes", ".spill")
    mkdirSync(directory, { recursive: true })
    const runs = this.aggregateRuns.get(key) ?? []
    const path = join(directory, `${sha256(key).slice(0, 12)}-${runs.length}.jsonl`)
    const body = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([groupKey, group]) => canonicalJson({ key: groupKey, group })).join("\n") + "\n"
    writeDurable(path, Buffer.from(body))
    runs.push(path); this.aggregateRuns.set(key, runs); groups.clear()
  }

  private writeArtifactFile(path: string, source: string): { sha256: string; bytes: number } {
    const destination = safeJoin(this.staging, path)
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(source, destination)
    const bytes = statSync(destination).size
    const digest = fileSha256Sync(destination)
    this.artifacts.push({ path, sha256: digest, bytes })
    return { sha256: digest, bytes }
  }
}

export class ContextPackageReader {
  readonly root: string
  readonly manifest: ContextManifest

  constructor(path: string, verify = true) {
    this.root = resolve(path)
    this.manifest = JSON.parse(readFileSync(safeJoin(this.root, "manifest.json"), "utf8")) as ContextManifest
    if (this.manifest.format !== "pluma-context" || (this.manifest.version !== PLUMA_CONTEXT_VERSION && this.manifest.version !== PLUMA_CONTEXT_LEGACY_VERSION)) throw new ContextError("PLUMA_FORMAT_UNSUPPORTED", "Unsupported .pluma package")
    if (verify) this.verify()
  }

  verify(): void {
    for (const artifact of this.manifest.artifacts) {
      const path = safeJoin(this.root, artifact.path)
      const linkStats = lstatSync(path)
      const stats = statSync(path)
      if (!stats.isFile() || linkStats.isSymbolicLink()) throw new ContextError("PLUMA_PACKAGE_UNSAFE", `Unsafe artifact: ${artifact.path}`)
      const bytes = readFileSync(path)
      if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new ContextError("PLUMA_CHECKSUM_MISMATCH", `Checksum mismatch: ${artifact.path}`)
    }
    const { fingerprint: _fingerprint, ...base } = this.manifest
    const expected = sha256(canonicalJson(base) + this.manifest.artifacts.map((artifact) => artifact.sha256).join(""))
    if (expected !== this.manifest.fingerprint) throw new ContextError("PLUMA_CHECKSUM_MISMATCH", "Package fingerprint mismatch")
  }

  relation(idOrName?: string): ContextRelation {
    const relations = this.manifest.relations
    if (!idOrName && relations.length === 1) return relations[0]
    const found = relations.find((relation) => relation.id === idOrName || relation.name === idOrName)
    if (!found) throw new ContextError("PLUMA_RELATION_REQUIRED", "A valid relation is required")
    return found
  }

  *rows(relation: ContextRelation, blockHashes?: ReadonlySet<string>): Generator<{ row: ContextRow; blockHash: string }> {
    for (const block of relation.blocks) {
      if (blockHashes && !blockHashes.has(block.hash)) continue
      const table = tableFromIPC(readFileSync(safeJoin(this.root, block.path)))
      for (const item of table.toArray()) yield { row: Object.fromEntries(relation.fields.map((field) => [field.id, normalizeArrowValue((item as Record<string, unknown>)[field.id], field.type)])), blockHash: block.hash }
    }
  }
}

function renderOverview(name: string, relations: ContextRelation[]): string {
  return `# ${name}\n\n${relations.map((relation) => `- ${relation.name}: ${relation.rowCount} rows, ${relation.fields.length} columns`).join("\n")}\n`
}

function renderSchema(relations: ContextRelation[]): string {
  return relations.map((relation) => `## ${relation.name}\n\n${relation.fields.map((field) => `- ${field.id}: ${field.type}${field.nullable ? "?" : ""}`).join("\n")}`).join("\n\n") + "\n"
}

function writeDurable(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes)
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function safeJoin(root: string, child: string): string {
  if (child.includes("\0")) throw new ContextError("PLUMA_PACKAGE_UNSAFE", "NUL in package path")
  const destination = resolve(root, child)
  const rel = relative(resolve(root), destination)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new ContextError("PLUMA_PACKAGE_UNSAFE", `Unsafe package path: ${child}`)
  return destination
}

function arrowValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) return value
  if (typeof value === "bigint") return value
  if (value && typeof value === "object") return JSON.stringify(value)
  return value
}

function normalizeArrowValue(value: unknown, type?: string): ContextRow[string] {
  if (value === undefined || value === null) return null
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (type === "binary" && value instanceof Map) return new Uint8Array([...value.values()].map(Number))
  if (type === "binary" && value && typeof value === "object" && typeof (value as { toArray?: unknown }).toArray === "function") return new Uint8Array((value as { toArray(): unknown[] }).toArray().map(Number))
  if (typeof value === "object" && value && "toJSON" in value && typeof (value as { toJSON?: unknown }).toJSON === "function") return ((value as { toJSON(): unknown }).toJSON()) as ContextRow[string]
  if (type === "json" && typeof value === "string") { try { return JSON.parse(value) as ContextRow[string] } catch { return value } }
  return value as ContextRow[string]
}

function blockStatistics(batch: ContextBatch): Record<string, ContextColumnStatistics> {
  return Object.fromEntries(batch.fields.map((field) => {
    let nullCount = 0
    let minimum: string | number | boolean | undefined
    let maximum: string | number | boolean | undefined
    for (const row of batch.rows) {
      const value = statisticValue(row[field.id])
      if (value === undefined) { nullCount++; continue }
      if (minimum === undefined || compareStatistic(value, minimum) < 0) minimum = value
      if (maximum === undefined || compareStatistic(value, maximum) > 0) maximum = value
    }
    return [field.id, { nullCount, ...(minimum === undefined ? {} : { min: minimum, max: maximum }) }]
  }))
}

function statisticValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined || typeof value === "bigint") return typeof value === "bigint" ? value.toString() : undefined
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Date) return value.toISOString()
  return undefined
}

function compareStatistic(left: string | number | boolean, right: string | number | boolean): number {
  if (typeof left === "number" && typeof right === "number") return left - right
  return String(left).localeCompare(String(right))
}

interface BlockIndexEntry {
  blockHash: string
  min: string | number | boolean
  max: string | number | boolean
  prefixMax: string | number | boolean
}

function blockIndexEntries(relation: ContextRelation, column: string): BlockIndexEntry[] {
  const entries = relation.blocks.flatMap((block) => {
    const statistics = block.statistics?.[column]
    return statistics?.min === undefined || statistics.max === undefined ? [] : [{ blockHash: block.hash, min: statistics.min, max: statistics.max, prefixMax: statistics.max }]
  }).sort((left, right) => compareStatistic(left.min, right.min))
  let prefixMax: string | number | boolean | undefined
  for (const entry of entries) {
    if (prefixMax === undefined || compareStatistic(entry.max, prefixMax) > 0) prefixMax = entry.max
    entry.prefixMax = prefixMax
  }
  return entries
}

interface MaterializedState { count: number; sum: number; min?: number; max?: number }
interface MaterializedGroup { key: ContextRow; states: Record<string, MaterializedState> }

function aggregateId(definition: MaterializedAggregateDefinition): string {
  return `agg_${sha256(canonicalJson(definition)).slice(0, 16)}`
}

function updateMaterializedGroup(groups: Map<string, MaterializedGroup>, definition: MaterializedAggregateDefinition, row: ContextRow): void {
  const key = Object.fromEntries(definition.groupBy.map((column) => [column, row[column] ?? null]))
  const encoded = canonicalJson(key)
  const group = groups.get(encoded) ?? { key, states: Object.fromEntries(definition.metrics.map((metric) => [metric.as, { count: 0, sum: 0 }])) }
  for (const metric of definition.metrics) updateMaterializedState(group.states[metric.as], metric.aggregate, metric.column ? row[metric.column] : 1)
  groups.set(encoded, group)
}

function updateMaterializedState(state: MaterializedState, aggregate: Aggregate, value: unknown): void {
  if (aggregate === "count") { if (value !== null && value !== undefined) state.count++; return }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return
  state.count++; state.sum += numeric
  state.min = state.min === undefined ? numeric : Math.min(state.min, numeric)
  state.max = state.max === undefined ? numeric : Math.max(state.max, numeric)
}

function finishMaterializedGroup(group: MaterializedGroup, definition: MaterializedAggregateDefinition): ContextRow {
  return { ...group.key, ...Object.fromEntries(definition.metrics.map((metric) => [metric.as, finishMaterializedState(group.states[metric.as], metric.aggregate)])) }
}

function finishMaterializedState(state: MaterializedState, aggregate: Aggregate): number | null {
  if (aggregate === "count") return state.count
  if (aggregate === "sum") return state.sum
  if (aggregate === "avg") return state.count ? state.sum / state.count : null
  if (aggregate === "min") return state.min ?? null
  return state.max ?? null
}

interface AggregateRunValue { key: string; group: MaterializedGroup }
interface AggregateHeapItem { value: AggregateRunValue; reader: SyncLineReader }

function mergeAggregateRuns(runs: string[], output: string, offsetsOutput: string, definition: MaterializedAggregateDefinition): number {
  const readers = runs.map((path) => new SyncLineReader(path))
  const heap = new MinHeap<AggregateHeapItem>((left, right) => left.value.key.localeCompare(right.value.key))
  for (const reader of readers) { const value = nextAggregateValue(reader); if (value) heap.push({ value, reader }) }
  const fd = openSync(output, "wx", 0o600)
  const offsetsFd = openSync(offsetsOutput, "wx", 0o600)
  let groups = 0
  let offset = 0n
  try {
    while (heap.size) {
      const item = heap.pop()!
      const merged = item.value.group
      refillAggregateHeap(heap, item.reader)
      while (heap.peek()?.value.key === item.value.key) {
        const duplicate = heap.pop()!
        mergeMaterializedGroup(merged, duplicate.value.group)
        refillAggregateHeap(heap, duplicate.reader)
      }
      const line = Buffer.from(canonicalJson({ key: item.value.key, row: finishMaterializedGroup(merged, definition) }) + "\n")
      const offsetBytes = Buffer.allocUnsafe(8); offsetBytes.writeBigUInt64LE(offset)
      writeSync(offsetsFd, offsetBytes); writeSync(fd, line)
      offset += BigInt(line.byteLength); groups++
    }
    fsyncSync(fd); fsyncSync(offsetsFd)
  } finally { closeSync(fd); closeSync(offsetsFd); for (const reader of readers) reader.close() }
  return groups
}

function refillAggregateHeap(heap: MinHeap<AggregateHeapItem>, reader: SyncLineReader): void {
  const value = nextAggregateValue(reader)
  if (value) heap.push({ value, reader })
}

function nextAggregateValue(reader: SyncLineReader): AggregateRunValue | undefined {
  const line = reader.nextLine()
  return line === undefined ? undefined : JSON.parse(line) as AggregateRunValue
}

function mergeMaterializedGroup(target: MaterializedGroup, source: MaterializedGroup): void {
  for (const [name, state] of Object.entries(source.states)) {
    const current = target.states[name]
    current.count += state.count; current.sum += state.sum
    if (state.min !== undefined) current.min = current.min === undefined ? state.min : Math.min(current.min, state.min)
    if (state.max !== undefined) current.max = current.max === undefined ? state.max : Math.max(current.max, state.max)
  }
}

class SyncLineReader {
  private readonly fd: number
  private readonly decoder = new StringDecoder("utf8")
  private pending = ""
  private ended = false

  constructor(path: string) { this.fd = openSync(path, "r") }

  nextLine(): string | undefined {
    for (;;) {
      const newline = this.pending.indexOf("\n")
      if (newline >= 0) { const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1); return line }
      if (this.ended) { if (!this.pending) return undefined; const line = this.pending; this.pending = ""; return line }
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const bytes = readSync(this.fd, chunk, 0, chunk.byteLength, null)
      if (!bytes) { this.pending += this.decoder.end(); this.ended = true }
      else this.pending += this.decoder.write(chunk.subarray(0, bytes))
    }
  }

  close(): void { closeSync(this.fd) }
}

class MinHeap<T> {
  private readonly items: T[] = []
  constructor(private readonly compare: (left: T, right: T) => number) {}
  get size(): number { return this.items.length }
  peek(): T | undefined { return this.items[0] }
  push(value: T): void { this.items.push(value); this.up(this.items.length - 1) }
  pop(): T | undefined {
    const first = this.items[0]
    const last = this.items.pop()
    if (this.items.length && last !== undefined) { this.items[0] = last; this.down(0) }
    return first
  }
  private up(index: number): void {
    while (index > 0) { const parent = (index - 1) >>> 1; if (this.compare(this.items[parent], this.items[index]) <= 0) return; [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]]; index = parent }
  }
  private down(index: number): void {
    for (;;) { const left = index * 2 + 1; const right = left + 1; let smallest = index; if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left; if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right; if (smallest === index) return; [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]]; index = smallest }
  }
}

function fileSha256Sync(path: string): string {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const bytes = readSync(fd, chunk, 0, chunk.byteLength, null); if (!bytes) break; hash.update(chunk.subarray(0, bytes)) }
  } finally { closeSync(fd) }
  return hash.digest("hex")
}
