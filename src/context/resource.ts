import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { ContextError, type ResolvedResourceBudget, type ResourceBudget } from "./types.js"

export const MIB = 1024 * 1024
export const DEFAULT_MEMORY_BYTES = 128 * MIB
export const MIN_MEMORY_BYTES = 16 * MIB
export const DEFAULT_SPILL_BYTES = 4 * 1024 * MIB
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000

export function resolveResourceBudget(input: ResourceBudget = {}): ResolvedResourceBudget {
  const memoryBytes = integerInRange(input.memoryBytes ?? DEFAULT_MEMORY_BYTES, MIN_MEMORY_BYTES, 64 * 1024 * MIB, "memoryBytes")
  const spillBytes = integerInRange(input.spillBytes ?? DEFAULT_SPILL_BYTES, 0, 16 * 1024 * 1024 * MIB, "spillBytes")
  const timeoutMs = integerInRange(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 24 * 60 * 60 * 1_000, "timeoutMs")
  const temporaryDirectory = resolve(input.temporaryDirectory ?? tmpdir())
  return { memoryBytes, spillBytes, timeoutMs, temporaryDirectory, signal: input.signal }
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ContextError("PLUMA_RESOURCE_BUDGET", `${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

export class ResourceGuard {
  readonly budget: ResolvedResourceBudget
  private readonly startedAt = Date.now()

  constructor(input: ResourceBudget = {}) { this.budget = resolveResourceBudget(input) }

  checkpoint(): void {
    if (this.budget.signal?.aborted) throw new ContextError("PLUMA_CANCELLED", "Operation was cancelled")
    if (Date.now() - this.startedAt > this.budget.timeoutMs) throw new ContextError("PLUMA_TIMEOUT", "Operation exceeded its timeout")
  }
}
