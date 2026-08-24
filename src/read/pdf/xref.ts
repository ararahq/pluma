/**
 * Cross-reference resolution: classic xref tables, xref streams, object
 * streams (/ObjStm), /Prev chains for incremental updates, and a linear
 * "N G obj" scan fallback for corrupted files. Produces a flat object table
 * plus the merged trailer, then resolves indirect references and decrypts
 * strings/streams lazily on first access.
 */
import {
  dictGet,
  dictGetName,
  dictGetNum,
  isArray,
  isDict,
  isRef,
  isStream,
  parseIndirectObject,
  parseValue,
  skipWhitespaceAndComments,
  type Cursor,
  type PdfDict,
  type PdfValue,
} from "./objects.js"
import { decodeStream, PdfStreamLimitError } from "./filters.js"
import { decryptBytes, decryptString, firstDocId, PdfEncryptedError, readDocCrypto, type DocCrypto } from "./crypto.js"

export class PdfLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfLimitError"
  }
}

interface XrefEntry {
  kind: "offset" | "compressed"
  offset?: number
  streamNum?: number
  indexInStream?: number
}

export interface PdfDocument {
  buf: Uint8Array
  trailer: PdfDict
  crypto?: DocCrypto
  warnings: string[]
  getObject(num: number): PdfValue | undefined
  getStreamBytes(num: number): Uint8Array
}

const MAX_PREV_CHAIN = 64
const MAX_XREF_ENTRIES = 500_000
const MAX_OBJECT_STREAM_OBJECTS = 100_000
const MAX_CACHED_STREAM_BYTES = 256 * 1024 * 1024

/**
 * Counts calls to `openPdfDocument` (full xref/object-stream parse). Exists
 * solely so tests can assert an architectural guarantee — e.g. that
 * `readPdfPages` parses a document exactly once no matter how many pages it
 * streams — without needing to mock the module. Not part of the public API.
 */
export let openPdfDocumentCallCount = 0
export function resetOpenPdfDocumentCallCountForTests(): void {
  openPdfDocumentCallCount = 0
}

export function openPdfDocument(buf: Uint8Array, warnings: string[]): PdfDocument {
  openPdfDocumentCallCount++
  const entries = new Map<number, XrefEntry>()
  let trailer: PdfDict = { type: "dict", map: new Map() }

  try {
    trailer = loadXrefChain(buf, entries, warnings)
  } catch (error) {
    if (error instanceof PdfLimitError || error instanceof PdfStreamLimitError) throw error
    warnings.push(`xref chain unreadable, falling back to linear scan: ${(error as Error).message}`)
  }

  if (entries.size === 0 || !dictGet(trailer, "Root")) {
    trailer = linearScanFallback(buf, entries, trailer, warnings)
  }

  const cache = new Map<number, PdfValue>()
  const streamCache = new Map<number, Uint8Array>()
  const objStmCache = new Map<number, Map<number, PdfValue>>()
  const resolvingObjects = new Set<number>()
  const loadingObjectStreams = new Set<number>()
  let cachedStreamBytes = 0

  let crypto: DocCrypto | undefined
  const encryptRef = dictGet(trailer, "Encrypt")
  const encryptDictRaw = isRef(encryptRef) ? rawFetch(encryptRef.num) : isDict(encryptRef) ? encryptRef : undefined
  if (encryptDictRaw) {
    const filter = dictGetName(encryptDictRaw, "Filter")
    if (filter && filter !== "Standard") {
      throw new PdfEncryptedError(
        `Unsupported security handler "${filter}" — only the Standard handler with an empty user password is supported`,
      )
    }
    try {
      crypto = readDocCrypto(encryptDictRaw, firstDocId(dictGet(trailer, "ID")))
    } catch (error) {
      if (error instanceof PdfEncryptedError) throw error
      throw new PdfEncryptedError(`Encryption setup failed: ${(error as Error).message}`)
    }
  }
  const encryptObjNum = isRef(encryptRef) ? encryptRef.num : undefined

  function rawFetch(num: number): PdfDict | undefined {
    const entry = entries.get(num)
    if (!entry || entry.kind !== "offset" || entry.offset === undefined) return undefined
    try {
      const parsed = parseIndirectObject({ buf, pos: entry.offset })
      return isDict(parsed.value) ? parsed.value : isStream(parsed.value) ? parsed.value.dict : undefined
    } catch {
      return undefined
    }
  }

  function getObject(num: number): PdfValue | undefined {
    if (cache.has(num)) return cache.get(num)
    if (!Number.isSafeInteger(num) || num < 0) return undefined
    if (resolvingObjects.has(num)) {
      warnings.push(`Object reference cycle detected at object ${num}`)
      return undefined
    }
    const entry = entries.get(num)
    if (!entry) return undefined
    resolvingObjects.add(num)

    try {
      if (entry.kind === "offset" && entry.offset !== undefined) {
        let value: PdfValue
        try {
          const parsed = parseIndirectObject({ buf, pos: entry.offset })
          value = parsed.value
        } catch (error) {
          warnings.push(`Object ${num} failed to parse: ${(error as Error).message}`)
          return undefined
        }
        if (crypto && num !== encryptObjNum) value = decryptValue(value, num, 0, crypto)
        cache.set(num, value)
        return value
      }

      if (entry.kind === "compressed" && entry.streamNum !== undefined) {
        const objects = loadObjectStream(entry.streamNum)
        const value = objects.get(num)
        if (value !== undefined) cache.set(num, value)
        return value
      }
      return undefined
    } finally {
      resolvingObjects.delete(num)
    }
  }

  function loadObjectStream(streamNum: number): Map<number, PdfValue> {
    const cached = objStmCache.get(streamNum)
    if (cached) return cached
    const result = new Map<number, PdfValue>()
    if (loadingObjectStreams.has(streamNum)) {
      warnings.push(`Object stream cycle detected at object ${streamNum}`)
      return result
    }
    loadingObjectStreams.add(streamNum)
    try {
      const streamValue = getObject(streamNum)
      if (!isStream(streamValue)) {
        objStmCache.set(streamNum, result)
        return result
      }
      const decoded = decodeStream(streamValue.bytes, streamValue.dict)
      const n = dictGetNum(streamValue.dict, "N") ?? 0
      const first = dictGetNum(streamValue.dict, "First") ?? 0
      if (!Number.isSafeInteger(n) || n < 0 || n > MAX_OBJECT_STREAM_OBJECTS) {
        throw new PdfLimitError(`Object stream ${streamNum} has invalid /N (${n})`)
      }
      if (!Number.isSafeInteger(first) || first < 0 || first > decoded.length) {
        throw new PdfLimitError(`Object stream ${streamNum} has invalid /First (${first})`)
      }
      const headerCursor: Cursor = { buf: decoded, pos: 0 }
      const offsets: { num: number; offset: number }[] = []
      for (let i = 0; i < n; i++) {
        skipWhitespaceAndComments(headerCursor)
        const objNum = readRequiredInt(headerCursor, `object stream ${streamNum} object number`)
        skipWhitespaceAndComments(headerCursor)
        const offset = readRequiredInt(headerCursor, `object stream ${streamNum} offset`)
        if (first + offset < first || first + offset >= decoded.length) {
          throw new PdfLimitError(`Object stream ${streamNum} contains an out-of-range object offset`)
        }
        offsets.push({ num: objNum, offset })
      }
      for (const { num: objNum, offset } of offsets) {
        try {
          const value = parseValue({ buf: decoded, pos: first + offset })
          result.set(objNum, value)
        } catch (error) {
          warnings.push(`Object stream ${streamNum} entry ${objNum} failed: ${(error as Error).message}`)
        }
      }
      objStmCache.set(streamNum, result)
      return result
    } finally {
      loadingObjectStreams.delete(streamNum)
    }
  }

  function getStreamBytes(num: number): Uint8Array {
    const cached = streamCache.get(num)
    if (cached) return cached
    const value = getObject(num)
    if (!isStream(value)) return new Uint8Array(0)
    const decoded = decodeStream(value.bytes, value.dict)
    if (cachedStreamBytes > MAX_CACHED_STREAM_BYTES - decoded.length) {
      throw new PdfLimitError(`Decoded stream cache exceeds byte budget (${MAX_CACHED_STREAM_BYTES})`)
    }
    cachedStreamBytes += decoded.length
    streamCache.set(num, decoded)
    return decoded
  }

  return { buf, trailer, crypto, warnings, getObject, getStreamBytes }
}

function readInt(c: Cursor): number {
  const start = c.pos
  while (c.pos < c.buf.length && c.buf[c.pos] >= 0x30 && c.buf[c.pos] <= 0x39) c.pos++
  const text = new TextDecoder("latin1").decode(c.buf.subarray(start, c.pos))
  return Number.parseInt(text, 10) || 0
}

function readRequiredInt(c: Cursor, label: string): number {
  const start = c.pos
  const value = readInt(c)
  if (c.pos === start || !Number.isSafeInteger(value) || value < 0) {
    throw new PdfLimitError(`Invalid ${label}`)
  }
  return value
}

function decryptValue(value: PdfValue, num: number, gen: number, crypto: DocCrypto): PdfValue {
  if (typeof value === "string") return decryptString(crypto, num, gen, value)
  if (isStream(value)) {
    const lengthName = dictGetName(value.dict, "Type")
    if (lengthName === "XRef") return value // xref streams are never encrypted
    return {
      type: "stream",
      dict: decryptValue(value.dict, num, gen, crypto) as PdfDict,
      bytes: decryptBytes(crypto, num, gen, value.bytes),
    }
  }
  if (isDict(value)) {
    const map = new Map<string, PdfValue>()
    for (const [k, v] of value.map) map.set(k, decryptValue(v, num, gen, crypto))
    return { type: "dict", map }
  }
  if (isArray(value)) {
    return { type: "array", items: value.items.map((v) => decryptValue(v, num, gen, crypto)) }
  }
  return value
}

function findStartxrefOffsets(buf: Uint8Array): number[] {
  const tailStart = Math.max(0, buf.length - 2048)
  const text = latin1(buf.subarray(tailStart))
  const matches = [...text.matchAll(/startxref\s+(\d+)/g)]
  return matches.map((m) => Number.parseInt(m[1], 10)).filter((n) => n >= 0 && n < buf.length)
}

function latin1(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

function loadXrefChain(buf: Uint8Array, entries: Map<number, XrefEntry>, warnings: string[]): PdfDict {
  const startOffsets = findStartxrefOffsets(buf)
  if (startOffsets.length === 0) throw new Error("No startxref found")

  let trailer: PdfDict = { type: "dict", map: new Map() }
  const visited = new Set<number>()
  let offset: number | undefined = startOffsets[startOffsets.length - 1]
  let hops = 0

  while (offset !== undefined && !visited.has(offset) && hops < MAX_PREV_CHAIN) {
    visited.add(offset)
    hops++
    const sectionTrailer = parseXrefSection(buf, offset, entries, warnings)
    for (const [k, v] of sectionTrailer.map) {
      if (!trailer.map.has(k)) trailer.map.set(k, v)
    }
    const prev = dictGetNum(sectionTrailer, "Prev")
    const xrefStm = dictGetNum(sectionTrailer, "XRefStm")
    if (xrefStm !== undefined && !visited.has(xrefStm)) {
      visited.add(xrefStm)
      const streamTrailer = parseXrefSection(buf, xrefStm, entries, warnings)
      for (const [k, v] of streamTrailer.map) if (!trailer.map.has(k)) trailer.map.set(k, v)
    }
    offset = prev
  }
  return trailer
}

function parseXrefSection(
  buf: Uint8Array,
  offset: number,
  entries: Map<number, XrefEntry>,
  warnings: string[],
): PdfDict {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buf.length) {
    throw new PdfLimitError(`Invalid xref offset (${offset})`)
  }
  const c: Cursor = { buf, pos: offset }
  skipWhitespaceAndComments(c)
  const isTable = matchesKeyword(buf, c.pos, "xref")
  if (isTable) {
    c.pos += 4
    return parseXrefTable(c, entries)
  }
  const parsed = parseIndirectObject(c)
  if (!isStream(parsed.value)) throw new Error(`Expected xref stream at offset ${offset}`)
  return parseXrefStream(parsed.value, entries, warnings)
}

function matchesKeyword(buf: Uint8Array, pos: number, keyword: string): boolean {
  for (let i = 0; i < keyword.length; i++) if (buf[pos + i] !== keyword.charCodeAt(i)) return false
  return true
}

function parseXrefTable(c: Cursor, entries: Map<number, XrefEntry>): PdfDict {
  for (;;) {
    skipWhitespaceAndComments(c)
    if (matchesKeyword(c.buf, c.pos, "trailer")) {
      c.pos += 7
      const trailer = parseValue(c)
      return isDict(trailer) ? trailer : { type: "dict", map: new Map() }
    }
    if (c.buf[c.pos] < 0x30 || c.buf[c.pos] > 0x39) break
    const start = readRequiredInt(c, "xref subsection start")
    skipWhitespaceAndComments(c)
    const count = readRequiredInt(c, "xref subsection count")
    if (count > MAX_XREF_ENTRIES - entries.size) {
      throw new PdfLimitError(`Xref table exceeds entry budget (${MAX_XREF_ENTRIES})`)
    }
    for (let i = 0; i < count; i++) {
      skipWhitespaceAndComments(c)
      const entryStart = c.pos
      if (entryStart + 20 > c.buf.length) throw new Error("Truncated xref table")
      const line = latin1(c.buf.subarray(entryStart, entryStart + 20))
      const match = line.match(/^(\d{10}) (\d{5}) ([nf])/)
      c.pos = entryStart + 20
      if (!match) continue
      const objNum = start + i
      if (entries.has(objNum)) continue
      if (match[3] === "n") entries.set(objNum, { kind: "offset", offset: Number.parseInt(match[1], 10) })
    }
  }
  return { type: "dict", map: new Map() }
}

function parseXrefStream(
  stream: { dict: PdfDict; bytes: Uint8Array },
  entries: Map<number, XrefEntry>,
  warnings: string[],
): PdfDict {
  const decoded = decodeStream(stream.bytes, stream.dict)
  const wField = dictGet(stream.dict, "W")
  if (!isArray(wField) || wField.items.length < 3) {
    warnings.push("Xref stream missing /W")
    return stream.dict
  }
  const w = wField.items.map((v) => (typeof v === "number" ? v : 0)) as [number, number, number]
  if (w.some((width) => !Number.isSafeInteger(width) || width < 0 || width > 6)) {
    throw new PdfLimitError(`Xref stream has invalid /W widths (${w.join(" ")})`)
  }
  const size = dictGetNum(stream.dict, "Size") ?? 0
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_XREF_ENTRIES) {
    throw new PdfLimitError(`Xref stream has invalid /Size (${size})`)
  }
  const indexField = dictGet(stream.dict, "Index")
  if (isArray(indexField) && indexField.items.length % 2 !== 0) {
    throw new PdfLimitError("Xref stream /Index must contain start/count pairs")
  }
  const ranges: [number, number][] = isArray(indexField)
    ? chunk(indexField.items.map((v) => (typeof v === "number" ? v : 0)), 2)
    : [[0, size]]

  const entryWidth = w[0] + w[1] + w[2]
  if (entryWidth <= 0) throw new PdfLimitError("Xref stream entry width must be positive")
  let requestedEntries = 0
  for (const [start, count] of ranges) {
    if (
      !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(count) || count < 0 ||
      count > MAX_XREF_ENTRIES - requestedEntries
    ) {
      throw new PdfLimitError("Xref stream /Index exceeds entry budget")
    }
    requestedEntries += count
  }
  if (requestedEntries > MAX_XREF_ENTRIES - entries.size) {
    throw new PdfLimitError(`Xref stream exceeds entry budget (${MAX_XREF_ENTRIES})`)
  }
  let pos = 0
  for (const [start, count] of ranges) {
    for (let i = 0; i < count; i++) {
      if (pos + entryWidth > decoded.length) break
      const type = w[0] === 0 ? 1 : readBE(decoded, pos, w[0])
      const field2 = readBE(decoded, pos + w[0], w[1])
      const field3 = readBE(decoded, pos + w[0] + w[1], w[2])
      pos += entryWidth
      const objNum = start + i
      if (entries.has(objNum)) continue
      if (type === 1) entries.set(objNum, { kind: "offset", offset: field2 })
      else if (type === 2) entries.set(objNum, { kind: "compressed", streamNum: field2, indexInStream: field3 })
    }
  }
  return stream.dict
}

function chunk(items: number[], size: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < items.length; i += size) out.push([items[i], items[i + 1]])
  return out
}

function readBE(buf: Uint8Array, offset: number, width: number): number {
  let value = 0
  for (let i = 0; i < width; i++) value = value * 256 + buf[offset + i]
  return value
}

/** Recovery path for files with a broken/missing xref: scan for `N G obj` and rebuild the table. */
function linearScanFallback(
  buf: Uint8Array,
  entries: Map<number, XrefEntry>,
  existingTrailer: PdfDict,
  warnings: string[],
): PdfDict {
  warnings.push("Rebuilding xref table via linear scan (corrupted or missing xref)")
  const objRegex = /(\d+)\s+(\d+)\s+obj\b/g
  const text = latin1(buf)
  let match: RegExpExecArray | null
  while ((match = objRegex.exec(text))) {
    if (entries.size >= MAX_XREF_ENTRIES) {
      throw new PdfLimitError(`Linear xref scan exceeds entry budget (${MAX_XREF_ENTRIES})`)
    }
    const num = Number.parseInt(match[1], 10)
    entries.set(num, { kind: "offset", offset: match.index })
  }

  let trailer = existingTrailer
  const trailerRegex = /trailer\s*<</g
  let trailerMatch: RegExpExecArray | null
  while ((trailerMatch = trailerRegex.exec(text))) {
    try {
      const c: Cursor = { buf, pos: trailerMatch.index + "trailer".length }
      skipWhitespaceAndComments(c)
      const parsed = parseValue(c)
      if (isDict(parsed)) {
        for (const [k, v] of parsed.map) trailer.map.set(k, v)
      }
    } catch {
      continue
    }
  }

  if (!dictGet(trailer, "Root")) {
    for (const [num] of entries) {
      try {
        const parsed = parseIndirectObject({ buf, pos: entries.get(num)!.offset! })
        if (isDict(parsed.value) && dictGetName(parsed.value, "Type") === "Catalog") {
          trailer = { type: "dict", map: new Map([["Root", { type: "ref", num, gen: 0 }]]) }
          break
        }
      } catch {
        continue
      }
    }
  }
  return trailer
}
