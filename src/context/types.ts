export const PLUMA_CONTEXT_VERSION = 2 as const
export const PLUMA_CONTEXT_LEGACY_VERSION = 1 as const
export type PlumaContextVersion = typeof PLUMA_CONTEXT_VERSION | typeof PLUMA_CONTEXT_LEGACY_VERSION

export interface ResourceBudget {
  memoryBytes?: number
  spillBytes?: number
  timeoutMs?: number
  temporaryDirectory?: string
  signal?: AbortSignal
}

export interface ResolvedResourceBudget {
  memoryBytes: number
  spillBytes: number
  timeoutMs: number
  temporaryDirectory: string
  signal?: AbortSignal
}

export type ScalarType =
  | "null"
  | "boolean"
  | "int64"
  | "float64"
  | "decimal"
  | "utf8"
  | "binary"
  | "date"
  | "timestamp"
  | "json"

export interface ContextField {
  id: string
  name: string
  type: ScalarType
  nullable: boolean
  precision?: number
  scale?: number
  timezone?: string
}

export interface ContextRelation {
  id: string
  name: string
  fields: ContextField[]
  rowCount: number
  blocks: ContextBlock[]
  indexes?: ContextIndex[]
  materializedAggregates?: ContextMaterializedAggregate[]
}

export interface ContextBlock {
  hash: string
  path: string
  relationId: string
  rowStart: number
  rowEnd: number
  bytes: number
  statistics?: Record<string, ContextColumnStatistics>
}

export interface ContextColumnStatistics {
  nullCount: number
  min?: string | number | boolean
  max?: string | number | boolean
}

export interface ContextIndex {
  id: string
  columns: string[]
  path: string
  entries: number
  sha256: string
  bytes: number
  comparison: "canonical-v1"
  nulls: "first"
}

export interface ContextMaterializedAggregate {
  id: string
  groupBy: string[]
  metrics: QueryMetric[]
  path: string
  offsetsPath: string
  groups: number
  sha256: string
  bytes: number
  offsetsSha256: string
  offsetsBytes: number
}

export interface ContextManifest {
  format: "pluma-context"
  version: PlumaContextVersion
  id: string
  name: string
  createdAt: string
  source: { kind: string; name: string; sha256: string; bytes: number }
  relations: ContextRelation[]
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
  warnings: string[]
  compiler: { name: "@ararahq/pluma"; version: string }
  fingerprint: string
}

export type ContextValue = null | boolean | number | bigint | string | Date | Uint8Array | Record<string, unknown> | unknown[]
export type ContextRow = Record<string, ContextValue>

export interface ContextBatch {
  relationId: string
  relationName?: string
  fields: ContextField[]
  rows: ContextRow[]
  rowStart: number
}

export type CompileState = "queued" | "discovering" | "compiling" | "finalizing" | "completed" | "failed" | "cancelled"

export interface CompileEvent {
  state: CompileState
  rowsProcessed: number
  bytesProcessed: number
  provisionalSchema?: { provisional: true; relations: Array<{ id: string; name: string; fields: ContextField[] }> }
  warning?: string
}

export interface TokenizerSpec {
  id: "cl100k_base" | "o200k_base"
  version: "1"
}

export interface TokenBudget {
  tokenBudget: number
  tokenizer: TokenizerSpec
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in"
export interface QueryFilter { column: string; op: FilterOperator; value: unknown }
export type Aggregate = "count" | "sum" | "min" | "max" | "avg"
export interface QueryMetric { column?: string; aggregate: Aggregate; as: string }
export interface QueryPlan {
  relation?: string
  select?: string[]
  filter?: QueryFilter[]
  groupBy?: string[]
  metrics?: QueryMetric[]
  limit?: number
}

export interface QueryProvenance {
  packageFingerprint: string
  relationId: string
  planHash: string
  inputBlocks: string[]
  candidateBlocks: string[]
  blocksRead: number
  rowsMatched: number
  rowsScanned: number
  rowsReturned: number
  strategy: QueryStrategy
  structureId?: string
  indexEntries?: number
  indexPagesRead?: number
  keyComparisons?: number
}

export type QueryStrategy = "index" | "materialized_aggregate" | "pruned_scan" | "full_scan"

export interface QueryExplanation {
  strategy: QueryStrategy
  relationId: string
  structureId?: string
  candidateBlocks: string[]
  estimatedRows: number
  reason: string
  indexEntries?: number
  indexPagesRead?: number
  keyComparisons?: number
}

export interface IndexDefinition { columns: string[] }
export interface MaterializedAggregateDefinition { groupBy: string[]; metrics: QueryMetric[] }

export interface StreamSourceIdentity {
  snapshot: string
  fingerprint: string
}

export interface ResumableRowSource {
  identity: StreamSourceIdentity
  open(cursor?: string): AsyncIterable<ContextRow> | Iterable<ContextRow> | NodeJS.ReadableStream
  cursor(row: ContextRow): string
}

export interface ContextPayload<T = unknown> {
  data: T
  provenance?: QueryProvenance
  context: {
    loaded: string[]
    excluded: string[]
    tokenCost: number
    tokenizer: TokenizerSpec
    reason: string
  }
}

export class ContextError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "ContextError"
  }
}
