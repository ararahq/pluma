import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { canonicalJson, sha256 } from "./hash.js"
import { ContextPackageReader } from "./package.js"
import { exportData, exportRows, type ExportFormat, type XlsxExportOptions } from "./export.js"
import { ResourceGuard } from "./resource.js"
import { serializeWithinBudget, tokenCount } from "./token.js"
import { ContextError, type ContextBlock, type ContextField, type ContextIndex, type ContextMaterializedAggregate, type ContextPayload, type ContextRelation, type ContextRow, type QueryExplanation, type QueryFilter, type QueryPlan, type QueryProvenance, type ResourceBudget, type TokenBudget } from "./types.js"

export class PlumaContext {
  readonly package: ContextPackageReader
  private readonly pinned = new Map<string, { value: unknown; bytes: number }>()
  private readonly indexCache = new Map<string, BlockIndexFile>()
  private readonly resourceBudget: ResourceBudget
  private pinnedBytes = 0

  constructor(path: string, options: { resourceBudget?: ResourceBudget } = {}) {
    this.package = new ContextPackageReader(path)
    this.resourceBudget = options.resourceBudget ?? {}
    for (const relation of this.package.manifest.relations) for (const index of relation.indexes ?? []) this.loadIndex(index)
  }

  inspect(options: TokenBudget & { view?: "overview" | "schema" } ): ContextPayload<string> {
    const view = options.view ?? "overview"
    const text = readFileSync(`${this.package.root}/views/${view}.md`, "utf8")
    const base = { data: text, context: { loaded: [view], excluded: [], tokenCost: 0, tokenizer: options.tokenizer, reason: `Requested ${view} view` } }
    const tokens = tokenCount(JSON.stringify(base), options)
    base.context.tokenCost = tokens
    serializeWithinBudget(base, options)
    return base
  }

  sample(options: TokenBudget & { relation?: string; rows?: number }): ContextPayload<ContextRow[]> {
    const relation = this.package.relation(options.relation)
    const result: ContextRow[] = []
    for (const { row } of this.package.rows(relation)) {
      result.push(row)
      if (result.length >= Math.min(options.rows ?? 20, 1_000)) break
    }
    return this.fitPayload(result, options, ["schema", "sample"], "Deterministic head sample")
  }

  query(plan: QueryPlan): QueryResult {
    const relation = this.package.relation(plan.relation)
    validatePlan(plan, relation.fields)
    const guard = new ResourceGuard(this.resourceBudget)
    const explanation = this.explain(plan)
    if (explanation.strategy === "materialized_aggregate") return this.queryMaterialized(plan, relation, explanation, guard)
    const candidates = new Set(explanation.candidateBlocks)
    const inputBlocks = new Set<string>()
    const rows: ContextRow[] = []
    const groups = new Map<string, { key: ContextRow; states: Record<string, AggregateState> }>()
    let rowsScanned = 0
    let rowsMatched = 0
    let materializedBytes = 0
    const groupBy = plan.groupBy ?? []
    const metrics = plan.metrics ?? []
    for (const item of this.package.rows(relation, candidates)) {
      guard.checkpoint()
      rowsScanned++
      inputBlocks.add(item.blockHash)
      if (!matches(item.row, plan)) continue
      rowsMatched++
      if (metrics.length || groupBy.length) {
        const keyValues = Object.fromEntries(groupBy.map((column) => [column, item.row[column] ?? null]))
        const key = canonicalJson(keyValues)
        let group = groups.get(key)
        if (!group) {
          if (groups.size >= 100_000) throw new ContextError("PLUMA_QUERY_CARDINALITY", "Query exceeded the group cardinality limit")
          group = { key: keyValues, states: {} }
          for (const metric of metrics) group.states[metric.as] = createAggregate(metric.aggregate)
          groups.set(key, group)
          materializedBytes += Buffer.byteLength(key) + 256 + metrics.length * 64
          ensureResultBudget(materializedBytes, guard)
        }
        for (const metric of metrics) updateAggregate(group.states[metric.as], metric.aggregate, metric.column ? item.row[metric.column] : 1)
      } else {
        rows.push(project(item.row, plan.select))
        materializedBytes += rowBytes(rows.at(-1)!)
        ensureResultBudget(materializedBytes, guard)
        if (rows.length >= Math.min(plan.limit ?? 10_000, 1_000_000)) break
      }
    }
    if (metrics.length || groupBy.length) {
      for (const group of groups.values()) {
        if (rows.length >= Math.min(plan.limit ?? 10_000, 1_000_000)) break
        rows.push({ ...group.key, ...Object.fromEntries(metrics.map((metric) => [metric.as, finishAggregate(group.states[metric.as], metric.aggregate)])) })
        materializedBytes += rowBytes(rows.at(-1)!)
        ensureResultBudget(materializedBytes, guard)
      }
    }
    const fields = inferResultFields(rows, relation.fields)
    const provenance: QueryProvenance = {
      packageFingerprint: this.package.manifest.fingerprint,
      relationId: relation.id,
      planHash: sha256(canonicalJson(plan)),
      inputBlocks: [...inputBlocks],
      candidateBlocks: explanation.candidateBlocks,
      blocksRead: inputBlocks.size,
      rowsMatched,
      rowsScanned,
      rowsReturned: rows.length,
      strategy: explanation.strategy,
      structureId: explanation.structureId,
      indexEntries: explanation.indexEntries,
      indexPagesRead: explanation.indexPagesRead,
      keyComparisons: explanation.keyComparisons,
    }
    return new QueryResult(rows, fields, provenance)
  }

  explain(plan: QueryPlan): QueryExplanation {
    const relation = this.package.relation(plan.relation)
    validatePlan(plan, relation.fields)
    const aggregate = selectMaterializedAggregate(plan, relation)
    if (aggregate) return { strategy: "materialized_aggregate", relationId: relation.id, structureId: aggregate.id, candidateBlocks: [], estimatedRows: aggregate.groups, reason: "A declared exact materialized aggregate fully covers the plan", indexEntries: aggregate.groups, indexPagesRead: Math.max(1, Math.ceil(Math.log2(aggregate.groups + 1))), keyComparisons: Math.max(1, Math.ceil(Math.log2(aggregate.groups + 1))) }
    const indexed = selectIndex(plan, relation)
    if (indexed) return this.explainIndex(plan, relation, indexed)
    const candidates = relation.blocks.filter((block) => blockMayMatch(block, plan.filter ?? [])).map((block) => block.hash)
    const pruned = candidates.length < relation.blocks.length
    return {
      strategy: pruned ? "pruned_scan" : "full_scan",
      relationId: relation.id,
      candidateBlocks: candidates,
      estimatedRows: estimateRows(relation, new Set(candidates)),
      reason: pruned ? "Block statistics exclude non-matching blocks" : "No compatible index or pruning statistics cover the plan",
    }
  }

  async export(options: { relation?: string; format: ExportFormat; output: string }): Promise<void> {
    const relation = this.package.relation(options.relation)
    const source = this.package.rows(relation)
    await exportRows((async function* () { for (const item of source) yield item.row })(), relation.fields, options.format, options.output)
  }

  queryStream(plan: QueryPlan, options: { resourceBudget?: ResourceBudget } = {}): QueryStreamResult {
    const relation = this.package.relation(plan.relation)
    validatePlan(plan, relation.fields)
    const explanation = this.explain(plan)
    if ((plan.metrics?.length ?? 0) || (plan.groupBy?.length ?? 0)) {
      const result = this.query(plan)
      return QueryStreamResult.fromMaterialized(result)
    }
    const guard = new ResourceGuard({ ...this.resourceBudget, ...options.resourceBudget })
    const candidates = new Set(explanation.candidateBlocks)
    const fields = resultFieldsForPlan(plan, relation.fields)
    const deferred = provenanceDeferred()
    const rows = this.streamSelectedRows(plan, relation, explanation, candidates, guard, deferred.resolve)
    return new QueryStreamResult(rows, fields, deferred.promise)
  }

  async exportQuery(plan: QueryPlan, options: { format: ExportFormat; output: string; resourceBudget?: ResourceBudget; xlsx?: XlsxExportOptions }): Promise<QueryProvenance> {
    const stream = this.queryStream(plan, { resourceBudget: options.resourceBudget })
    await exportData({ rows: stream.rows, fields: stream.fields, format: options.format, output: options.output, resourceBudget: options.resourceBudget, xlsx: options.xlsx })
    return stream.evidence
  }

  pin(id: string, value: unknown): void {
    if (!id || id.length > 128) throw new ContextError("PLUMA_CONTEXT_PIN", "Pin id must be 1 to 128 characters")
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null))
    const previous = this.pinned.get(id)?.bytes ?? 0
    if (this.pinned.size >= 128 && !this.pinned.has(id)) throw new ContextError("PLUMA_CONTEXT_PIN", "At most 128 context values may be pinned")
    if (this.pinnedBytes - previous + bytes > 8 * 1024 * 1024) throw new ContextError("PLUMA_CONTEXT_PIN", "Pinned context exceeds the 8 MiB working-set budget")
    this.pinned.set(id, { value, bytes }); this.pinnedBytes = this.pinnedBytes - previous + bytes
  }
  release(id: string): boolean { const value = this.pinned.get(id); if (!value) return false; this.pinnedBytes -= value.bytes; return this.pinned.delete(id) }
  close(): void { this.pinned.clear(); this.pinnedBytes = 0 }

  private explainIndex(plan: QueryPlan, relation: ContextRelation, index: ContextIndex): QueryExplanation {
    const file = this.loadIndex(index)
    const filter = (plan.filter ?? []).find((item) => item.column === index.columns[0])!
    const selection = selectIndexedBlocks(file.entries, filter)
    return {
      strategy: "index",
      relationId: relation.id,
      structureId: index.id,
      candidateBlocks: selection.blocks,
      estimatedRows: estimateRows(relation, new Set(selection.blocks)),
      reason: `Ordered block index covers ${filter.column} ${filter.op}`,
      indexEntries: file.entries.length,
      indexPagesRead: selection.pagesRead,
      keyComparisons: selection.comparisons,
    }
  }

  private loadIndex(index: ContextIndex): BlockIndexFile {
    const cached = this.indexCache.get(index.id)
    if (cached) return cached
    const path = `${this.package.root}/${index.path}`
    const bytes = readFileSync(path)
    const budget = new ResourceGuard(this.resourceBudget).budget
    if (bytes.byteLength > budget.memoryBytes / 4) throw new ContextError("PLUMA_MEMORY_LIMIT", "Index exceeds the configured in-memory index budget")
    const value = JSON.parse(bytes.toString("utf8")) as BlockIndexFile
    if (value.format !== "pluma-block-index" || value.version !== 1 || !Array.isArray(value.entries)) throw new ContextError("PLUMA_INDEX_INVALID", `Invalid index: ${index.id}`)
    this.indexCache.set(index.id, value)
    return value
  }

  private queryMaterialized(plan: QueryPlan, relation: ContextRelation, explanation: QueryExplanation, guard: ResourceGuard): QueryResult {
    const aggregate = (relation.materializedAggregates ?? []).find((item) => item.id === explanation.structureId)
    if (!aggregate) throw new ContextError("PLUMA_AGGREGATE_INVALID", "Materialized aggregate is missing")
    const limit = Math.min(plan.limit ?? 10_000, 1_000_000)
    const exactKey = materializedLookupKey(plan, aggregate)
    const rows = exactKey === undefined ? readMaterializedRows(this.package.root, aggregate, guard, plan, limit) : readMaterializedKey(this.package.root, aggregate, exactKey)
    const provenance: QueryProvenance = {
      packageFingerprint: this.package.manifest.fingerprint,
      relationId: relation.id,
      planHash: sha256(canonicalJson(plan)),
      inputBlocks: [], candidateBlocks: [], blocksRead: 0,
      rowsMatched: rows.length, rowsScanned: 0, rowsReturned: rows.length,
      strategy: "materialized_aggregate", structureId: aggregate.id,
      indexEntries: aggregate.groups, indexPagesRead: explanation.indexPagesRead, keyComparisons: explanation.keyComparisons,
    }
    return new QueryResult(rows, inferResultFields(rows, relation.fields), provenance)
  }

  private async *streamSelectedRows(plan: QueryPlan, relation: ContextRelation, explanation: QueryExplanation, candidates: ReadonlySet<string>, guard: ResourceGuard, complete: (value: QueryProvenance) => void): AsyncGenerator<ContextRow> {
    const inputBlocks = new Set<string>()
    let rowsScanned = 0
    let rowsMatched = 0
    let rowsReturned = 0
    const limit = Math.min(plan.limit ?? 10_000, 1_000_000)
    try {
      for (const item of this.package.rows(relation, candidates)) {
        guard.checkpoint(); rowsScanned++; inputBlocks.add(item.blockHash)
        if (!matches(item.row, plan)) continue
        rowsMatched++; rowsReturned++
        yield project(item.row, plan.select)
        if (rowsReturned >= limit) break
      }
    } finally {
      complete(provenanceFor(this.package.manifest.fingerprint, plan, relation, explanation, inputBlocks, rowsScanned, rowsMatched, rowsReturned))
    }
  }

  private fitPayload<T>(data: T, budget: TokenBudget, loaded: string[], reason: string): ContextPayload<T> {
    const payload: ContextPayload<T> = { data, context: { loaded, excluded: [], tokenCost: 0, tokenizer: budget.tokenizer, reason } }
    payload.context.tokenCost = tokenCount(JSON.stringify(payload), budget)
    serializeWithinBudget(payload, budget)
    return payload
  }
}

export class QueryResult {
  constructor(readonly rows: ContextRow[], readonly fields: ContextField[], readonly provenance: QueryProvenance) {}
  payload(budget: TokenBudget): ContextPayload<ContextRow[]> {
    let rows = this.rows
    for (;;) {
      const payload: ContextPayload<ContextRow[]> = { data: rows, provenance: this.provenance, context: { loaded: ["query_result"], excluded: rows.length < this.rows.length ? [`${this.rows.length - rows.length} rows omitted`] : [], tokenCost: 0, tokenizer: budget.tokenizer, reason: "Exact structured query result" } }
      payload.context.tokenCost = tokenCount(JSON.stringify(payload), budget)
      try { serializeWithinBudget(payload, budget); return payload } catch (error) {
        if (!(error instanceof ContextError) || error.code !== "PLUMA_TOKEN_BUDGET_EXCEEDED" || rows.length === 0) throw error
        rows = rows.slice(0, Math.floor(rows.length / 2))
      }
    }
  }
  async export(options: { format: ExportFormat; output: string }): Promise<void> { await exportRows(this.rows, this.fields, options.format, options.output) }
}

export class QueryStreamResult {
  constructor(readonly rows: AsyncIterable<ContextRow>, readonly fields: ContextField[], readonly evidence: Promise<QueryProvenance>) {}

  static fromMaterialized(result: QueryResult): QueryStreamResult {
    return new QueryStreamResult((async function* () { yield* result.rows })(), result.fields, Promise.resolve(result.provenance))
  }
}

export function openContext(path: string, options: { resourceBudget?: ResourceBudget } = {}): PlumaContext { return new PlumaContext(path, options) }

function matches(row: ContextRow, plan: QueryPlan): boolean {
  return (plan.filter ?? []).every((filter) => {
    const value = row[filter.column]
    if (filter.op === "eq") return value === filter.value
    if (filter.op === "ne") return value !== filter.value
    if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(value)
    if (filter.op === "gt") return comparable(value) > comparable(filter.value)
    if (filter.op === "gte") return comparable(value) >= comparable(filter.value)
    if (filter.op === "lt") return comparable(value) < comparable(filter.value)
    return comparable(value) <= comparable(filter.value)
  })
}

function comparable(value: unknown): number | string { return typeof value === "number" ? value : String(value ?? "") }
function project(row: ContextRow, select?: string[]): ContextRow { return select?.length ? Object.fromEntries(select.map((key) => [key, row[key] ?? null])) : row }

interface AggregateState { count: number; sum: number; min?: number; max?: number }
function createAggregate(_kind: string): AggregateState { return { count: 0, sum: 0 } }
function updateAggregate(state: AggregateState, kind: string, value: unknown): void {
  if (kind === "count") { if (value !== null && value !== undefined) state.count++; return }
  const numeric = Number(value)
  if (Number.isFinite(numeric)) { state.count++; state.sum += numeric; state.min = state.min === undefined ? numeric : Math.min(state.min, numeric); state.max = state.max === undefined ? numeric : Math.max(state.max, numeric) }
}

function validatePlan(plan: QueryPlan, fields: ContextField[]): void {
  const names = new Set(fields.map((field) => field.id))
  const requireColumn = (column: string) => { if (!names.has(column)) throw new ContextError("PLUMA_QUERY_COLUMN", `Unknown column: ${column}`) }
  if (plan.limit !== undefined && (!Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 1_000_000)) throw new ContextError("PLUMA_QUERY_LIMIT", "limit must be an integer from 1 to 1000000")
  if ((plan.filter?.length ?? 0) > 100) throw new ContextError("PLUMA_QUERY_LIMIT", "A query may contain at most 100 filters")
  if ((plan.groupBy?.length ?? 0) > 32 || (plan.metrics?.length ?? 0) > 64) throw new ContextError("PLUMA_QUERY_LIMIT", "Query grouping or metric limit exceeded")
  for (const column of plan.select ?? []) requireColumn(column)
  for (const filter of plan.filter ?? []) requireColumn(filter.column)
  for (const column of plan.groupBy ?? []) requireColumn(column)
  for (const metric of plan.metrics ?? []) if (metric.column) requireColumn(metric.column)
}
function finishAggregate(state: AggregateState, kind: string): number | null {
  if (kind === "count") return state.count
  if (kind === "sum") return state.sum
  if (kind === "avg") return state.count ? state.sum / state.count : null
  if (kind === "min") return state.min ?? null
  return state.max ?? null
}

function inferResultFields(rows: ContextRow[], source: ContextField[]): ContextField[] {
  const names = rows[0] ? Object.keys(rows[0]) : []
  return names.map((name) => source.find((field) => field.id === name) ?? { id: name, name, type: "float64", nullable: true })
}

interface BlockIndexEntry {
  blockHash: string
  min: string | number | boolean
  max: string | number | boolean
  prefixMax: string | number | boolean
}

interface BlockIndexFile {
  format: "pluma-block-index"
  version: 1
  relationId: string
  columns: string[]
  entries: BlockIndexEntry[]
}

interface MaterializedAggregateRecord { key: string; row: ContextRow }

function selectIndex(plan: QueryPlan, relation: ContextRelation): ContextIndex | undefined {
  return (relation.indexes ?? []).find((index) => (plan.filter ?? []).some((filter) => filter.column === index.columns[0] && filter.op !== "ne" && filter.op !== "in"))
}

function selectMaterializedAggregate(plan: QueryPlan, relation: ContextRelation): ContextMaterializedAggregate | undefined {
  const groupBy = plan.groupBy ?? []
  const metrics = plan.metrics ?? []
  if (!metrics.length && !groupBy.length) return undefined
  const filterColumns = new Set((plan.filter ?? []).map((filter) => filter.column))
  return (relation.materializedAggregates ?? []).find((aggregate) => {
    if (aggregate.groupBy.length !== groupBy.length || aggregate.metrics.length !== metrics.length) return false
    if (!aggregate.groupBy.every((column, index) => column === groupBy[index]) || [...filterColumns].some((column) => !aggregate.groupBy.includes(column))) return false
    return aggregate.metrics.every((metric, index) => canonicalJson(metric) === canonicalJson(metrics[index]))
  })
}

function selectIndexedBlocks(entries: BlockIndexEntry[], filter: QueryFilter): { blocks: string[]; comparisons: number; pagesRead: number } {
  let comparisons = 0
  const compareMin = (entry: BlockIndexEntry) => { comparisons++; return compareIndex(entry.min, statisticComparable(filter.value)!) }
  const value = statisticComparable(filter.value)
  if (value === undefined || !entries.length) return { blocks: entries.map((entry) => entry.blockHash), comparisons, pagesRead: entries.length ? 1 : 0 }
  const upper = upperBound(entries, (entry) => compareMin(entry) <= 0)
  const inspected: BlockIndexEntry[] = []
  if (filter.op === "lt" || filter.op === "lte") {
    const end = filter.op === "lt" ? lowerBound(entries, (entry) => compareMin(entry) >= 0) : upper
    inspected.push(...entries.slice(0, end))
  } else {
    if (filter.op === "gt" || filter.op === "gte") inspected.push(...entries.slice(upper))
    for (let index = upper - 1; index >= 0; index--) {
      comparisons++
      const boundary = compareIndex(entries[index].prefixMax, value)
      if ((filter.op === "gt" && boundary <= 0) || (filter.op !== "gt" && filter.op !== "gte" && boundary < 0) || (filter.op === "gte" && boundary < 0)) break
      inspected.push(entries[index])
    }
  }
  const relevant = inspected.filter((entry) => { comparisons += 2; return intervalMayMatch(entry.min, entry.max, filter) })
  const blocks = [...new Set(relevant.map((entry) => entry.blockHash))]
  const pagesRead = Math.max(1, Math.ceil(Math.log2(entries.length + 1))) + Math.ceil(inspected.length / 128)
  return { blocks, comparisons, pagesRead }
}

function lowerBound<T>(items: T[], predicate: (item: T) => boolean): number {
  let low = 0
  let high = items.length
  while (low < high) { const middle = (low + high) >>> 1; if (predicate(items[middle])) high = middle; else low = middle + 1 }
  return low
}

function upperBound<T>(items: T[], predicate: (item: T) => boolean): number {
  let low = 0
  let high = items.length
  while (low < high) { const middle = (low + high) >>> 1; if (predicate(items[middle])) low = middle + 1; else high = middle }
  return low
}

function blockMayMatch(block: ContextBlock, filters: QueryFilter[]): boolean {
  return filters.every((filter) => {
    const statistics = block.statistics?.[filter.column]
    if (!statistics || statistics.min === undefined || statistics.max === undefined) return true
    if (filter.op === "ne" || filter.op === "in") return true
    return intervalMayMatch(statistics.min, statistics.max, filter)
  })
}

function intervalMayMatch(minimum: string | number | boolean, maximum: string | number | boolean, filter: QueryFilter): boolean {
  const value = statisticComparable(filter.value)
  if (value === undefined) return true
  if (filter.op === "eq") return compareIndex(minimum, value) <= 0 && compareIndex(maximum, value) >= 0
  if (filter.op === "gt") return compareIndex(maximum, value) > 0
  if (filter.op === "gte") return compareIndex(maximum, value) >= 0
  if (filter.op === "lt") return compareIndex(minimum, value) < 0
  if (filter.op === "lte") return compareIndex(minimum, value) <= 0
  return true
}

function statisticComparable(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  return undefined
}

function compareIndex(left: string | number | boolean, right: string | number | boolean): number {
  if (typeof left === "number" && typeof right === "number") return left - right
  return String(left).localeCompare(String(right))
}

function estimateRows(relation: ContextRelation, blocks: ReadonlySet<string>): number {
  return relation.blocks.filter((block) => blocks.has(block.hash)).reduce((total, block) => total + block.rowEnd - block.rowStart, 0)
}

function rowBytes(row: ContextRow): number {
  return Buffer.byteLength(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value))
}

function ensureResultBudget(bytes: number, guard: ResourceGuard): void {
  if (bytes > guard.budget.memoryBytes / 2) throw new ContextError("PLUMA_QUERY_RESULT_LIMIT", "Query result exceeds the configured materialization budget; use exportQuery or queryStream")
}

function materializedLookupKey(plan: QueryPlan, aggregate: ContextMaterializedAggregate): string | undefined {
  const filters = plan.filter ?? []
  if (filters.length !== aggregate.groupBy.length || filters.some((filter) => filter.op !== "eq")) return undefined
  const values = Object.fromEntries(aggregate.groupBy.map((column) => [column, filters.find((filter) => filter.column === column)?.value]))
  if (Object.values(values).some((value) => value === undefined)) return undefined
  return canonicalJson(values)
}

function readMaterializedKey(root: string, aggregate: ContextMaterializedAggregate, key: string): ContextRow[] {
  const offsets = readFileSync(`${root}/${aggregate.offsetsPath}`)
  const dataPath = `${root}/${aggregate.path}`
  const dataSize = statSync(dataPath).size
  const fd = openSync(dataPath, "r")
  let low = 0
  let high = aggregate.groups
  try {
    while (low < high) {
      const middle = (low + high) >>> 1
      const record = readMaterializedRecord(fd, offsets, middle, aggregate.groups, dataSize)
      const comparison = record.key.localeCompare(key)
      if (comparison < 0) low = middle + 1
      else high = middle
    }
    if (low >= aggregate.groups) return []
    const record = readMaterializedRecord(fd, offsets, low, aggregate.groups, dataSize)
    return record.key === key ? [record.row] : []
  } finally { closeSync(fd) }
}

function readMaterializedRows(root: string, aggregate: ContextMaterializedAggregate, guard: ResourceGuard, plan: QueryPlan, limit: number): ContextRow[] {
  if (aggregate.bytes > guard.budget.memoryBytes / 2) throw new ContextError("PLUMA_MEMORY_LIMIT", "Materialized aggregate scan exceeds the query memory budget; use exportQuery")
  const text = readFileSync(`${root}/${aggregate.path}`, "utf8")
  const rows: ContextRow[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    const record = JSON.parse(line) as MaterializedAggregateRecord
    if (matches(record.row, { filter: plan.filter })) rows.push(record.row)
    if (rows.length >= limit) break
  }
  return rows
}

function readMaterializedRecord(fd: number, offsets: Buffer, index: number, groups: number, dataSize: number): MaterializedAggregateRecord {
  const start = Number(offsets.readBigUInt64LE(index * 8))
  const end = index + 1 < groups ? Number(offsets.readBigUInt64LE((index + 1) * 8)) : dataSize
  const bytes = Buffer.allocUnsafe(end - start)
  const read = readSync(fd, bytes, 0, bytes.length, start)
  if (read !== bytes.length) throw new ContextError("PLUMA_AGGREGATE_INVALID", "Materialized aggregate is truncated")
  return JSON.parse(bytes.toString("utf8")) as MaterializedAggregateRecord
}

function resultFieldsForPlan(plan: QueryPlan, source: ContextField[]): ContextField[] {
  if (plan.select?.length) return plan.select.map((id) => source.find((field) => field.id === id)!)
  return source
}

function provenanceFor(packageFingerprint: string, plan: QueryPlan, relation: ContextRelation, explanation: QueryExplanation, inputBlocks: ReadonlySet<string>, rowsScanned: number, rowsMatched: number, rowsReturned: number): QueryProvenance {
  return {
    packageFingerprint,
    relationId: relation.id,
    planHash: sha256(canonicalJson(plan)),
    inputBlocks: [...inputBlocks], candidateBlocks: explanation.candidateBlocks,
    blocksRead: inputBlocks.size, rowsScanned, rowsMatched, rowsReturned,
    strategy: explanation.strategy, structureId: explanation.structureId,
    indexEntries: explanation.indexEntries, indexPagesRead: explanation.indexPagesRead, keyComparisons: explanation.keyComparisons,
  }
}

function provenanceDeferred(): { promise: Promise<QueryProvenance>; resolve: (value: QueryProvenance) => void } {
  let resolve!: (value: QueryProvenance) => void
  const promise = new Promise<QueryProvenance>((accept) => { resolve = accept })
  return { promise, resolve }
}
