/**
 * Font model: resolves a /Font resource dictionary into something the
 * content-stream interpreter can use to turn string bytes into Unicode text
 * plus per-glyph advance widths (needed to detect word gaps). Handles simple
 * fonts (Type1/TrueType/Type3, 1 byte per char, /Encoding + /Differences,
 * /Widths) and composite fonts (Type0/CID, Identity-H 2-byte codes,
 * /DescendantFonts /W widths, /CIDToGIDMap). ToUnicode CMaps (bfchar/bfrange)
 * take priority over encoding-based fallback when present.
 */
import {
  dictGet,
  dictGetName,
  dictGetNum,
  isArray,
  isDict,
  isName,
  isRef,
  isStream,
  type PdfDict,
  type PdfValue,
} from "../objects.js"
import { decodeStream, PdfStreamLimitError } from "../filters.js"
import { decodeByte, glyphNameToUnicode, type EncodingName } from "./encodings.js"

export interface DecodedGlyph {
  text: string
  width: number // in text-space units (1/1000 em), before font size scaling
}

export interface PdfFont {
  isCID: boolean
  defaultWidth: number
  bold: boolean
  italic: boolean
  approxSizeHint: number
  /** Splits a PDF string into codes (1 or 2 bytes depending on font) and decodes each to text+width. */
  decode(bytes: string): DecodedGlyph[]
}

type Resolver = (value: PdfValue) => PdfValue | undefined
const MAX_FONT_MAP_ENTRIES = 65_536
const MAX_CMAP_BYTES = 8 * 1024 * 1024

export function loadFont(fontDict: PdfDict, resolve: Resolver): PdfFont {
  const subtype = dictGetName(fontDict, "Subtype")
  if (subtype === "Type0") return loadType0Font(fontDict, resolve)
  return loadSimpleFont(fontDict, resolve)
}

function resolveValue(value: PdfValue | undefined, resolve: Resolver): PdfValue | undefined {
  if (value === undefined) return undefined
  return isRef(value) ? resolve(value) : value
}

function loadSimpleFont(fontDict: PdfDict, resolve: Resolver): PdfFont {
  const firstChar = dictGetNum(fontDict, "FirstChar") ?? 0
  const widthsRaw = resolveValue(dictGet(fontDict, "Widths"), resolve)
  const widths: number[] = isArray(widthsRaw)
    ? widthsRaw.items.map((v) => (typeof v === "number" ? v : (resolveValue(v, resolve) as number) || 0))
    : []

  const descriptor = resolveValue(dictGet(fontDict, "FontDescriptor"), resolve)
  const descDict = isDict(descriptor) ? descriptor : undefined
  const missingWidth = dictGetNum(descDict, "MissingWidth") ?? 0
  const flags = dictGetNum(descDict, "Flags") ?? 0
  const italicAngle = dictGetNum(descDict, "ItalicAngle") ?? 0
  const baseFont = dictGetName(fontDict, "BaseFont") ?? ""

  const { table: glyphMap, byteMap } = buildEncodingTables(fontDict, resolve)
  const toUnicode = loadToUnicode(fontDict, resolve)

  const bold = (flags & (1 << 18)) !== 0 || /bold/i.test(baseFont)
  const italic = (flags & (1 << 6)) !== 0 || italicAngle !== 0 || /italic|oblique/i.test(baseFont)

  return {
    isCID: false,
    defaultWidth: missingWidth,
    bold,
    italic,
    approxSizeHint: 1,
    decode(bytes: string): DecodedGlyph[] {
      const out: DecodedGlyph[] = []
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes.charCodeAt(i) & 0xff
        const width = widths[code - firstChar] ?? missingWidth ?? 500
        let text: string
        if (toUnicode?.has(code)) {
          text = toUnicode.get(code)!
        } else if (byteMap?.[code] !== undefined) {
          text = String.fromCodePoint(glyphNameToUnicode(byteMap[code]))
        } else if (glyphMap) {
          text = String.fromCodePoint(decodeByte(glyphMap, code))
        } else {
          text = String.fromCodePoint(decodeByte("StandardEncoding", code))
        }
        out.push({ text, width })
      }
      return out
    },
  }
}

function loadType0Font(fontDict: PdfDict, resolve: Resolver): PdfFont {
  const descendantsRaw = resolveValue(dictGet(fontDict, "DescendantFonts"), resolve)
  const descendant = isArray(descendantsRaw)
    ? (resolveValue(descendantsRaw.items[0], resolve) as PdfDict | undefined)
    : undefined
  const defaultWidth = dictGetNum(descendant, "DW") ?? 1000
  const widthMap = parseCidWidths(resolveValue(dictGet(descendant, "W"), resolve), resolve)
  const toUnicode = loadToUnicode(fontDict, resolve)
  const encodingName = dictGetName(fontDict, "Encoding") ?? "Identity-H"
  const isIdentity = encodingName.startsWith("Identity")

  const descriptor = resolveValue(dictGet(descendant, "FontDescriptor"), resolve)
  const flags = dictGetNum(isDict(descriptor) ? descriptor : undefined, "Flags") ?? 0
  const baseFont = dictGetName(fontDict, "BaseFont") ?? ""

  return {
    isCID: true,
    defaultWidth,
    bold: (flags & (1 << 18)) !== 0 || /bold/i.test(baseFont),
    italic: (flags & (1 << 6)) !== 0 || /italic|oblique/i.test(baseFont),
    approxSizeHint: 1,
    decode(bytes: string): DecodedGlyph[] {
      const out: DecodedGlyph[] = []
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = ((bytes.charCodeAt(i) & 0xff) << 8) | (bytes.charCodeAt(i + 1) & 0xff)
        const width = widthMap.get(code) ?? defaultWidth
        let text: string
        if (toUnicode?.has(code)) text = toUnicode.get(code)!
        else if (isIdentity) text = String.fromCodePoint(code === 0 ? 0x20 : code)
        else text = "�"
        out.push({ text, width })
      }
      if (bytes.length % 2 === 1) out.push({ text: "", width: 0 })
      return out
    },
  }
}

function parseCidWidths(value: PdfValue | undefined, resolve: Resolver): Map<number, number> {
  const map = new Map<number, number>()
  if (!isArray(value)) return map
  const items = value.items
  let i = 0
  while (i < items.length) {
    const first = resolveValue(items[i], resolve)
    const next = resolveValue(items[i + 1], resolve)
    if (typeof first !== "number") {
      i++
      continue
    }
    if (isArray(next)) {
      for (let offset = 0; offset < next.items.length; offset++) {
        const cid = first + offset
        if (cid < 0 || cid > 0xffff) continue
        const width = next.items[offset]
        if (typeof width === "number") setBoundedMap(map, cid, width)
      }
      i += 2
    } else if (typeof next === "number") {
      const width = resolveValue(items[i + 2], resolve)
      if (typeof width === "number" && Number.isSafeInteger(first) && Number.isSafeInteger(next)) {
        const start = Math.max(0, first)
        const end = Math.min(0xffff, next)
        for (let cid = start; cid <= end; cid++) setBoundedMap(map, cid, width)
      }
      i += 3
    } else {
      i++
    }
  }
  return map
}

function buildEncodingTables(
  fontDict: PdfDict,
  resolve: Resolver,
): { table?: EncodingName; byteMap?: Record<number, string> } {
  const encoding = resolveValue(dictGet(fontDict, "Encoding"), resolve)
  if (isName(encoding)) {
    if (encoding.name === "WinAnsiEncoding" || encoding.name === "MacRomanEncoding" || encoding.name === "StandardEncoding") {
      return { table: encoding.name as EncodingName }
    }
    return {}
  }
  if (isDict(encoding)) {
    const base = dictGetName(encoding, "BaseEncoding") as EncodingName | undefined
    const differences = resolveValue(dictGet(encoding, "Differences"), resolve)
    const byteMap: Record<number, string> = {}
    if (isArray(differences)) {
      let code = 0
      for (const item of differences.items) {
        if (typeof item === "number") code = item
        else if (isName(item)) {
          byteMap[code] = item.name
          code++
        }
      }
    }
    return { table: base, byteMap: Object.keys(byteMap).length ? byteMap : undefined }
  }
  return {}
}

function loadToUnicode(fontDict: PdfDict, resolve: Resolver): Map<number, string> | undefined {
  const stream = resolveValue(dictGet(fontDict, "ToUnicode"), resolve)
  if (!isStream(stream)) return undefined
  const bytes = decodeStream(stream.bytes, stream.dict, { maxBytes: MAX_CMAP_BYTES })
  const text = new TextDecoder("latin1").decode(bytes)
  return parseCMap(text)
}

/** Parses bfchar/bfrange blocks of a ToUnicode CMap into a code -> string map. */
export function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>()

  const charBlocks = text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)
  for (const block of charBlocks) {
    const pairs = block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)
    for (const pair of pairs) {
      const code = Number.parseInt(pair[1], 16)
      if (Number.isSafeInteger(code) && code >= 0 && code <= 0xffff) {
        setBoundedMap(map, code, hexToUtf16String(pair[2]))
      }
    }
  }

  const rangeBlocks = text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)
  for (const block of rangeBlocks) {
    const blockText = block[1]
    // Array-form ranges ("<lo> <hi> [<d0> <d1> ...]") must be located and
    // fenced off *before* the simple-range regex runs: the bracket contents
    // are themselves a run of hex tuples, and a naive <hex><hex><hex> scan
    // over the whole block will happily "discover" a bogus simple range
    // inside someone else's array destination list (e.g. the first three of
    // four bracketed values), silently corrupting unrelated code points that
    // happen to fall in that fake range. Every byte covered by an array
    // match is therefore excluded from the simple-range scan below.
    const consumedSpans: [number, number][] = []
    const arrayRanges = blockText.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)
    for (const range of arrayRanges) {
      const matchStart = range.index ?? 0
      consumedSpans.push([matchStart, matchStart + range[0].length])
      const start = Number.parseInt(range[1], 16)
      let offset = 0
      for (const value of range[3].matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const code = start + offset
        if (Number.isSafeInteger(code) && code >= 0 && code <= 0xffff) {
          setBoundedMap(map, code, hexToUtf16String(value[1]))
        }
        offset++
      }
    }
    const simpleRanges = blockText.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)
    for (const range of simpleRanges) {
      const matchStart = range.index ?? -1
      if (consumedSpans.some(([lo, hi]) => matchStart >= lo && matchStart < hi)) continue
      const start = Number.parseInt(range[1], 16)
      const end = Number.parseInt(range[2], 16)
      const dstStart = Number.parseInt(range[3], 16)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(dstStart)) continue
      const boundedStart = Math.max(0, start)
      const boundedEnd = Math.min(0xffff, end)
      for (let code = boundedStart; code <= boundedEnd; code++) {
        setBoundedMap(
          map,
          code,
          hexToUtf16String((dstStart + (code - start)).toString(16).padStart(range[3].length, "0")),
        )
      }
    }
  }
  return map
}

function setBoundedMap<T>(map: Map<number, T>, key: number, value: T): void {
  if (!map.has(key) && map.size >= MAX_FONT_MAP_ENTRIES) {
    throw new PdfStreamLimitError(`Font map exceeds entry budget (${MAX_FONT_MAP_ENTRIES})`)
  }
  map.set(key, value)
}

function hexToUtf16String(hex: string): string {
  const padded = hex.length % 4 === 0 ? hex : hex.padStart(hex.length + (4 - (hex.length % 4)), "0")
  let out = ""
  for (let i = 0; i < padded.length; i += 4) {
    out += String.fromCharCode(Number.parseInt(padded.slice(i, i + 4), 16))
  }
  return out
}
