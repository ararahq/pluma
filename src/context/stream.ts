import { ContextError, type ContextRow, type ResumableRowSource } from "./types.js"

export type RowInput = AsyncIterable<ContextRow> | Iterable<ContextRow> | NodeJS.ReadableStream

export function isResumableRowSource(value: unknown): value is ResumableRowSource {
  if (!value || typeof value !== "object") return false
  const source = value as Partial<ResumableRowSource>
  return typeof source.open === "function" && typeof source.cursor === "function" && typeof source.identity?.snapshot === "string" && typeof source.identity?.fingerprint === "string"
}

export async function* rowsFromInput(input: RowInput): AsyncGenerator<ContextRow> {
  const candidate = input as Partial<AsyncIterable<unknown> & Iterable<unknown>>
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    for await (const value of candidate as AsyncIterable<unknown>) yield validRow(value)
    return
  }
  if (typeof candidate[Symbol.iterator] === "function") {
    for (const value of candidate as Iterable<unknown>) yield validRow(value)
    return
  }
  throw new ContextError("PLUMA_STREAM_UNSUPPORTED", "Rows must be iterable, async iterable, or a Node readable stream")
}

function validRow(value: unknown): ContextRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextError("PLUMA_ROW_INVALID", "Every streamed row must be an object")
  return value as ContextRow
}
