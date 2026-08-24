/**
 * PDF object model and a recursive-descent parser over a raw byte buffer.
 * Covers: numbers, literal/hex strings, names, arrays, dictionaries, streams,
 * indirect references, booleans and null. No allocation-heavy tokenizer class —
 * parsing is a set of pure functions operating on {buf, pos} cursors so the
 * same code path serves the xref-stream reader, object streams, and content
 * streams.
 */

export type PdfName = { type: "name"; name: string }
export type PdfRef = { type: "ref"; num: number; gen: number }
export type PdfStream = { type: "stream"; dict: PdfDict; bytes: Uint8Array }
export type PdfDict = { type: "dict"; map: Map<string, PdfValue> }
export type PdfArray = { type: "array"; items: PdfValue[] }

export type PdfValue =
  | number
  | string
  | boolean
  | null
  | PdfName
  | PdfRef
  | PdfDict
  | PdfArray
  | PdfStream

export class PdfParseError extends Error {
  offset: number
  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`)
    this.name = "PdfParseError"
    this.offset = offset
  }
}

export function isName(v: PdfValue | undefined): v is PdfName {
  return !!v && typeof v === "object" && "type" in v && v.type === "name"
}
export function isRef(v: PdfValue | undefined): v is PdfRef {
  return !!v && typeof v === "object" && "type" in v && v.type === "ref"
}
export function isDict(v: PdfValue | undefined): v is PdfDict {
  return !!v && typeof v === "object" && "type" in v && v.type === "dict"
}
export function isArray(v: PdfValue | undefined): v is PdfArray {
  return !!v && typeof v === "object" && "type" in v && v.type === "array"
}
export function isStream(v: PdfValue | undefined): v is PdfStream {
  return !!v && typeof v === "object" && "type" in v && v.type === "stream"
}

export function dictGet(dict: PdfDict | undefined, key: string): PdfValue | undefined {
  return dict?.map.get(key)
}

export function dictGetNum(dict: PdfDict | undefined, key: string): number | undefined {
  const v = dictGet(dict, key)
  return typeof v === "number" ? v : undefined
}

export function dictGetName(dict: PdfDict | undefined, key: string): string | undefined {
  const v = dictGet(dict, key)
  return isName(v) ? v.name : undefined
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITERS = new Set(
  ["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"].map((c) => c.charCodeAt(0)),
)

function isWhitespace(byte: number): boolean {
  return WHITESPACE.has(byte)
}
function isDelimiter(byte: number): boolean {
  return DELIMITERS.has(byte)
}
function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte)
}

export interface Cursor {
  buf: Uint8Array
  pos: number
}

export function skipWhitespaceAndComments(c: Cursor): void {
  while (c.pos < c.buf.length) {
    const byte = c.buf[c.pos]
    if (isWhitespace(byte)) {
      c.pos++
      continue
    }
    if (byte === 0x25 /* % */) {
      while (c.pos < c.buf.length && c.buf[c.pos] !== 0x0a && c.buf[c.pos] !== 0x0d) c.pos++
      continue
    }
    break
  }
}

function peek(c: Cursor): number {
  return c.buf[c.pos]
}

function matchKeyword(c: Cursor, keyword: string): boolean {
  const bytes = c.buf
  if (c.pos + keyword.length > bytes.length) return false
  for (let i = 0; i < keyword.length; i++) {
    if (bytes[c.pos + i] !== keyword.charCodeAt(i)) return false
  }
  const after = c.pos + keyword.length
  if (after < bytes.length && isRegular(bytes[after])) return false
  c.pos = after
  return true
}

/** Parses one PDF object at the cursor. Does not resolve `N G obj` wrappers. */
export function parseValue(c: Cursor): PdfValue {
  skipWhitespaceAndComments(c)
  if (c.pos >= c.buf.length) throw new PdfParseError("Unexpected end of buffer", c.pos)
  const byte = peek(c)

  if (byte === 0x2f /* / */) return parseName(c)
  if (byte === 0x28 /* ( */) return parseLiteralString(c)
  if (byte === 0x5b /* [ */) return parseArray(c)
  if (byte === 0x3c /* < */) {
    if (c.buf[c.pos + 1] === 0x3c) return parseDictOrStream(c)
    return parseHexString(c)
  }
  if (matchKeyword(c, "true")) return true
  if (matchKeyword(c, "false")) return false
  if (matchKeyword(c, "null")) return null
  if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
    return parseNumberOrRef(c)
  }
  throw new PdfParseError(`Unexpected byte 0x${byte.toString(16)}`, c.pos)
}

function parseName(c: Cursor): PdfName {
  c.pos++ // consume '/'
  let out = ""
  while (c.pos < c.buf.length && isRegular(c.buf[c.pos])) {
    const byte = c.buf[c.pos]
    if (byte === 0x23 /* # */ && c.pos + 2 < c.buf.length) {
      const hex = String.fromCharCode(c.buf[c.pos + 1], c.buf[c.pos + 2])
      const code = Number.parseInt(hex, 16)
      if (!Number.isNaN(code)) {
        out += String.fromCharCode(code)
        c.pos += 3
        continue
      }
    }
    out += String.fromCharCode(byte)
    c.pos++
  }
  return { type: "name", name: out }
}

function readRawNumberToken(c: Cursor): string {
  const start = c.pos
  if (c.buf[c.pos] === 0x2b || c.buf[c.pos] === 0x2d) c.pos++
  while (c.pos < c.buf.length && ((c.buf[c.pos] >= 0x30 && c.buf[c.pos] <= 0x39) || c.buf[c.pos] === 0x2e)) {
    c.pos++
  }
  return new TextDecoder("latin1").decode(c.buf.subarray(start, c.pos))
}

function parseNumberOrRef(c: Cursor): number | PdfRef {
  const first = readRawNumberToken(c)
  const firstNum = Number.parseFloat(first)
  const isInt = /^[+-]?\d+$/.test(first)
  if (!isInt) return Number.isNaN(firstNum) ? 0 : firstNum

  const save = c.pos
  skipWhitespaceAndComments(c)
  if (c.pos < c.buf.length && c.buf[c.pos] >= 0x30 && c.buf[c.pos] <= 0x39) {
    const genPos = c.pos
    const second = readRawNumberToken(c)
    if (/^\d+$/.test(second)) {
      const save2 = c.pos
      skipWhitespaceAndComments(c)
      if (matchKeyword(c, "R")) {
        return { type: "ref", num: firstNum, gen: Number.parseInt(second, 10) }
      }
      c.pos = save2
    }
    c.pos = genPos
  }
  c.pos = save
  return firstNum
}

function parseLiteralString(c: Cursor): string {
  c.pos++ // consume '('
  let depth = 1
  const bytes: number[] = []
  while (c.pos < c.buf.length && depth > 0) {
    const byte = c.buf[c.pos]
    if (byte === 0x5c /* backslash */) {
      c.pos++
      const esc = c.buf[c.pos]
      switch (esc) {
        case 0x6e: bytes.push(0x0a); c.pos++; break // \n
        case 0x72: bytes.push(0x0d); c.pos++; break // \r
        case 0x74: bytes.push(0x09); c.pos++; break // \t
        case 0x62: bytes.push(0x08); c.pos++; break // \b
        case 0x66: bytes.push(0x0c); c.pos++; break // \f
        case 0x28: bytes.push(0x28); c.pos++; break
        case 0x29: bytes.push(0x29); c.pos++; break
        case 0x5c: bytes.push(0x5c); c.pos++; break
        case 0x0d:
          c.pos++
          if (c.buf[c.pos] === 0x0a) c.pos++
          break
        case 0x0a:
          c.pos++
          break
        default:
          if (esc >= 0x30 && esc <= 0x37) {
            let octal = ""
            for (let i = 0; i < 3 && c.buf[c.pos] >= 0x30 && c.buf[c.pos] <= 0x37; i++) {
              octal += String.fromCharCode(c.buf[c.pos])
              c.pos++
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff)
          } else {
            bytes.push(esc)
            c.pos++
          }
      }
      continue
    }
    if (byte === 0x28) depth++
    else if (byte === 0x29) {
      depth--
      if (depth === 0) {
        c.pos++
        break
      }
    }
    bytes.push(byte)
    c.pos++
  }
  return bytesToBinaryString(bytes)
}

function bytesToBinaryString(bytes: number[]): string {
  let out = ""
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function parseHexString(c: Cursor): string {
  c.pos++ // consume '<'
  let hex = ""
  while (c.pos < c.buf.length && c.buf[c.pos] !== 0x3e) {
    const byte = c.buf[c.pos]
    if (!isWhitespace(byte)) hex += String.fromCharCode(byte)
    c.pos++
  }
  c.pos++ // consume '>'
  if (hex.length % 2 === 1) hex += "0"
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16) || 0)
  return bytesToBinaryString(bytes)
}

function parseArray(c: Cursor): PdfArray {
  c.pos++ // consume '['
  const items: PdfValue[] = []
  for (;;) {
    skipWhitespaceAndComments(c)
    if (c.pos >= c.buf.length) throw new PdfParseError("Unterminated array", c.pos)
    if (c.buf[c.pos] === 0x5d) {
      c.pos++
      break
    }
    items.push(parseValue(c))
  }
  return { type: "array", items }
}

function parseDictOrStream(c: Cursor): PdfDict | PdfStream {
  c.pos += 2 // consume '<<'
  const map = new Map<string, PdfValue>()
  for (;;) {
    skipWhitespaceAndComments(c)
    if (c.pos >= c.buf.length) throw new PdfParseError("Unterminated dictionary", c.pos)
    if (c.buf[c.pos] === 0x3e && c.buf[c.pos + 1] === 0x3e) {
      c.pos += 2
      break
    }
    if (c.buf[c.pos] !== 0x2f) throw new PdfParseError("Expected name key in dictionary", c.pos)
    const key = parseName(c)
    const value = parseValue(c)
    map.set(key.name, value)
  }
  const dict: PdfDict = { type: "dict", map }

  const save = c.pos
  skipWhitespaceAndComments(c)
  if (matchKeyword(c, "stream")) {
    if (c.buf[c.pos] === 0x0d) c.pos++
    if (c.buf[c.pos] === 0x0a) c.pos++
    const length = map.get("Length")
    let end: number
    if (typeof length === "number") {
      end = c.pos + length
      if (end > c.buf.length || !looksLikeEndstream(c.buf, end)) {
        end = findEndstream(c.buf, c.pos)
      }
    } else {
      end = findEndstream(c.buf, c.pos)
    }
    const bytes = c.buf.subarray(c.pos, Math.max(c.pos, Math.min(end, c.buf.length)))
    c.pos = end
    skipWhitespaceAndComments(c)
    matchKeyword(c, "endstream")
    return { type: "stream", dict, bytes }
  }
  c.pos = save
  return dict
}

function looksLikeEndstream(buf: Uint8Array, at: number): boolean {
  let p = at
  while (p < buf.length && isWhitespace(buf[p])) p++
  const kw = "endstream"
  for (let i = 0; i < kw.length; i++) {
    if (buf[p + i] !== kw.charCodeAt(i)) return false
  }
  return true
}

function findEndstream(buf: Uint8Array, from: number): number {
  const needle = "endstream"
  const first = needle.charCodeAt(0)
  for (let i = from; i < buf.length; i++) {
    if (buf[i] !== first) continue
    let match = true
    for (let j = 1; j < needle.length; j++) {
      if (buf[i + j] !== needle.charCodeAt(j)) {
        match = false
        break
      }
    }
    if (match) {
      let end = i
      if (end > from && buf[end - 1] === 0x0a) end--
      if (end > from && buf[end - 1] === 0x0d) end--
      return end
    }
  }
  return buf.length
}

/** Parses `N G obj ... endobj` at the cursor, returning the value and consuming the wrapper. */
export function parseIndirectObject(c: Cursor): { num: number; gen: number; value: PdfValue } {
  skipWhitespaceAndComments(c)
  const num = Number.parseInt(readRawNumberToken(c), 10)
  skipWhitespaceAndComments(c)
  const gen = Number.parseInt(readRawNumberToken(c), 10)
  skipWhitespaceAndComments(c)
  if (!matchKeyword(c, "obj")) throw new PdfParseError("Expected 'obj' keyword", c.pos)
  const value = parseValue(c)
  skipWhitespaceAndComments(c)
  matchKeyword(c, "endobj")
  return { num, gen, value }
}

export function latin1BytesToString(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

export function stringToLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
