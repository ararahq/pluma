import { createHash } from "node:crypto"

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value === "bigint") return { $pluma: "int64", value: value.toString() }
  if (value instanceof Date) return { $pluma: "timestamp", value: value.toISOString() }
  if (value instanceof Uint8Array) return { $pluma: "binary", value: Buffer.from(value).toString("base64") }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortValue(v)]))
  }
  return value
}
