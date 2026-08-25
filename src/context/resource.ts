import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
  private memoryUsed = 0
  private spillUsed = 0

  constructor(input: ResourceBudget = {}) { this.budget = resolveResourceBudget(input) }

  checkpoint(): void {
    if (this.budget.signal?.aborted) throw new ContextError("PLUMA_CANCELLED", "Operation was cancelled")
    if (Date.now() - this.startedAt > this.budget.timeoutMs) throw new ContextError("PLUMA_TIMEOUT", "Operation exceeded its timeout")
  }

  reserveMemory(bytes: number): () => void {
    const value = checkedBytes(bytes)
    if (this.memoryUsed + value > this.budget.memoryBytes) throw new ContextError("PLUMA_MEMORY_LIMIT", `Operation requires more than the ${this.budget.memoryBytes} byte memory budget`)
    this.memoryUsed += value
    let released = false
    return () => { if (!released) { this.memoryUsed -= value; released = true } }
  }

  accountSpill(bytes: number): void {
    const value = checkedBytes(bytes)
    if (this.spillUsed + value > this.budget.spillBytes) throw new ContextError("PLUMA_SPILL_LIMIT", `Operation requires more than the ${this.budget.spillBytes} byte spill budget`)
    this.spillUsed += value
  }

  createTemporaryDirectory(prefix = "pluma-"): string {
    mkdirSync(this.budget.temporaryDirectory, { recursive: true })
    return mkdtempSync(resolve(this.budget.temporaryDirectory, prefix))
  }
}

export function withTemporaryDirectory<T>(guard: ResourceGuard, operation: (path: string) => T): T {
  const path = guard.createTemporaryDirectory()
  try { return operation(path) } finally { rmSync(path, { recursive: true, force: true }) }
}

async function checkedAsync<T>(operation: () => Promise<T>, cleanup: () => void): Promise<T> {
  try { return await operation() } finally { cleanup() }
}

export async function withTemporaryDirectoryAsync<T>(guard: ResourceGuard, operation: (path: string) => Promise<T>): Promise<T> {
  const path = guard.createTemporaryDirectory()
  return checkedAsync(() => operation(path), () => rmSync(path, { recursive: true, force: true }))
}

function checkedBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ContextError("PLUMA_RESOURCE_BUDGET", "Resource byte count must be a non-negative integer")
  return bytes
}
