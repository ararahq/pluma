import { NAMED_ENTITIES } from "./entities-data.js"

const NUMERIC_OVERRIDES: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
}

function codePointToString(code: number): string {
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "�"
  const mapped = NUMERIC_OVERRIDES[code]
  if (mapped) return mapped
  try {
    return String.fromCodePoint(code)
  } catch {
    return "�"
  }
}

const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z][a-zA-Z0-9]*;?)/g

/** Decodes HTML entities (the full WHATWG named character reference table,
 * plus decimal/hex numeric references) in a text run. Named lookup is a
 * single greedy match on the longest alphanumeric run, not the spec's full
 * backtracking longest-prefix algorithm — see README for the documented gap. */
export function decodeEntities(input: string): string {
  if (input.indexOf("&") === -1) return input
  return input.replace(ENTITY_PATTERN, (full, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X"
      const digits = body.slice(isHex ? 2 : 1).replace(/;$/, "")
      if (!digits) return full
      const code = parseInt(digits, isHex ? 16 : 10)
      if (Number.isNaN(code)) return full
      return codePointToString(code)
    }
    const resolved = NAMED_ENTITIES[body]
    if (resolved !== undefined) return resolved
    return full
  })
}
