/**
 * Stream filter decoders. FlateDecode uses node:zlib (native, no dependency).
 * LZWDecode, ASCIIHex, ASCII85 and RunLength are hand-rolled — they're small
 * and stable specs. DCTDecode/JPXDecode/CCITTFaxDecode (images) are not
 * decoded; callers should skip streams using those filters for text purposes.
 */
import { inflateSync } from "node:zlib"
import { dictGet, dictGetNum, isArray, isDict, isName, type PdfDict, type PdfValue } from "./objects.js"

export const IMAGE_ONLY_FILTERS = new Set(["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"])

export class PdfStreamLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfStreamLimitError"
  }
}

export interface DecodeStreamOptions {
  maxBytes?: number
  maxFilters?: number
}

const DEFAULT_MAX_DECODED_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_FILTERS = 8

export function decodeStream(bytes: Uint8Array, dict: PdfDict, options: DecodeStreamOptions = {}): Uint8Array {
  const maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_MAX_DECODED_BYTES, "maxBytes")
  const maxFilters = positiveLimit(options.maxFilters ?? DEFAULT_MAX_FILTERS, "maxFilters")
  const filters = filterNames(dictGet(dict, "Filter"))
  if (filters.length > maxFilters) {
    throw new PdfStreamLimitError(`Stream has ${filters.length} filters, exceeds maxFilters (${maxFilters})`)
  }
  const parmsList = decodeParmsList(dictGet(dict, "DecodeParms") ?? dictGet(dict, "DP"), filters.length)

  let data = bytes
  assertDecodedSize(data, maxBytes)
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]
    if (IMAGE_ONLY_FILTERS.has(filter)) return data
    data = applyFilter(filter, data, parmsList[i], maxBytes)
    assertDecodedSize(data, maxBytes)
  }
  return data
}

function filterNames(value: PdfValue | undefined): string[] {
  if (isName(value)) return [value.name]
  if (isArray(value)) return value.items.filter(isName).map((n) => n.name)
  return []
}

function decodeParmsList(value: PdfValue | undefined, count: number): (PdfDict | undefined)[] {
  if (isDict(value)) return [value]
  if (isArray(value)) return value.items.map((v) => (isDict(v) ? v : undefined))
  return new Array(count).fill(undefined)
}

function applyFilter(name: string, data: Uint8Array, parms: PdfDict | undefined, maxBytes: number): Uint8Array {
  switch (name) {
    case "FlateDecode":
    case "Fl":
      return applyPredictor(inflate(data, maxBytes), parms, maxBytes)
    case "LZWDecode":
    case "LZW":
      return applyPredictor(lzwDecode(data, dictGetNum(parms, "EarlyChange") ?? 1, maxBytes), parms, maxBytes)
    case "ASCIIHexDecode":
    case "AHx":
      return asciiHexDecode(data)
    case "ASCII85Decode":
    case "A85":
      return ascii85Decode(data)
    case "RunLengthDecode":
    case "RL":
      return runLengthDecode(data, maxBytes)
    default:
      return data
  }
}

function inflate(data: Uint8Array, maxBytes: number): Uint8Array {
  try {
    return inflateSync(data, { maxOutputLength: maxBytes })
  } catch (error) {
    if (isOutputLimitError(error)) {
      throw new PdfStreamLimitError(`Inflated stream exceeds maxBytes (${maxBytes})`)
    }
    // Some producers write raw deflate data or trailing garbage bytes; retry
    // tolerantly rather than surfacing a hard failure for the whole document.
    for (let trim = 1; trim <= 2 && trim < data.length; trim++) {
      try {
        return inflateSync(data.subarray(0, data.length - trim), { maxOutputLength: maxBytes })
      } catch (retryError) {
        if (isOutputLimitError(retryError)) {
          throw new PdfStreamLimitError(`Inflated stream exceeds maxBytes (${maxBytes})`)
        }
        continue
      }
    }
    return new Uint8Array(0)
  }
}

function applyPredictor(data: Uint8Array, parms: PdfDict | undefined, maxBytes: number): Uint8Array {
  const predictor = dictGetNum(parms, "Predictor") ?? 1
  if (predictor <= 1) return data
  const colors = dictGetNum(parms, "Colors") ?? 1
  const bpc = dictGetNum(parms, "BitsPerComponent") ?? 8
  const columns = dictGetNum(parms, "Columns") ?? 1
  if (!Number.isSafeInteger(colors) || colors <= 0 || colors > 256) {
    throw new PdfStreamLimitError(`Invalid predictor Colors (${colors})`)
  }
  if (![1, 2, 4, 8, 16].includes(bpc)) {
    throw new PdfStreamLimitError(`Invalid predictor BitsPerComponent (${bpc})`)
  }
  if (!Number.isSafeInteger(columns) || columns <= 0 || columns > 1_000_000) {
    throw new PdfStreamLimitError(`Invalid predictor Columns (${columns})`)
  }
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowBytes = Math.ceil((colors * bpc * columns) / 8)
  if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0 || rowBytes > maxBytes) {
    throw new PdfStreamLimitError(`Predictor row exceeds maxBytes (${rowBytes} > ${maxBytes})`)
  }

  if (predictor === 2) return tiffPredictor(data, colors, bpc, columns, maxBytes)
  return pngPredictor(data, rowBytes, bytesPerPixel, maxBytes)
}

function pngPredictor(data: Uint8Array, rowBytes: number, bpp: number, maxBytes: number): Uint8Array {
  const rows = Math.floor(data.length / (rowBytes + 1))
  const outputBytes = rows * rowBytes
  if (!Number.isSafeInteger(outputBytes) || outputBytes > maxBytes) {
    throw new PdfStreamLimitError(`Predicted stream exceeds maxBytes (${outputBytes} > ${maxBytes})`)
  }
  const out = new Uint8Array(outputBytes)
  let prevRow = new Uint8Array(rowBytes)
  let srcOffset = 0
  let dstOffset = 0
  for (let r = 0; r < rows; r++) {
    const tag = data[srcOffset]
    srcOffset++
    const row = data.subarray(srcOffset, srcOffset + rowBytes)
    const outRow = out.subarray(dstOffset, dstOffset + rowBytes)
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? outRow[i - bpp] : 0
      const b = prevRow[i]
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0
      let value: number
      switch (tag) {
        case 0: value = row[i]; break
        case 1: value = row[i] + a; break
        case 2: value = row[i] + b; break
        case 3: value = row[i] + ((a + b) >> 1); break
        case 4: value = row[i] + paeth(a, b, upLeft); break
        default: value = row[i]
      }
      outRow[i] = value & 0xff
    }
    prevRow = outRow
    srcOffset += rowBytes
    dstOffset += rowBytes
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function tiffPredictor(data: Uint8Array, colors: number, bpc: number, columns: number, maxBytes: number): Uint8Array {
  if (bpc !== 8) return data // 1/2/4-bit TIFF predictor is rare for text PDFs; pass through untouched
  const rowBytes = colors * columns
  assertDecodedSize(data, maxBytes)
  const out = new Uint8Array(data.length)
  const rows = Math.floor(data.length / rowBytes)
  for (let r = 0; r < rows; r++) {
    const offset = r * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= colors ? out[offset + i - colors] : 0
      out[offset + i] = (data[offset + i] + left) & 0xff
    }
  }
  return out
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const chars: number[] = []
  for (const byte of data) {
    if (byte === 0x3e) break
    if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)) {
      chars.push(byte)
    }
  }
  if (chars.length % 2 === 1) chars.push(0x30)
  const out = new Uint8Array(chars.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hex = String.fromCharCode(chars[i * 2], chars[i * 2 + 1])
    out[i] = Number.parseInt(hex, 16)
  }
  return out
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let tuple: number[] = []
  let i = 0
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2 // optional <~
  for (; i < data.length; i++) {
    const byte = data[i]
    if (byte === 0x7e /* ~ */) break
    if (byte === 0x7a /* z */ && tuple.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    if (byte < 0x21 || byte > 0x75) continue
    tuple.push(byte - 0x21)
    if (tuple.length === 5) {
      let value = 0
      for (const t of tuple) value = value * 85 + t
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      tuple = []
    }
  }
  if (tuple.length > 0) {
    const padCount = 5 - tuple.length
    for (let p = 0; p < padCount; p++) tuple.push(84)
    let value = 0
    for (const t of tuple) value = value * 85 + t
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, 4 - padCount))
  }
  return new Uint8Array(out)
}

function runLengthDecode(data: Uint8Array, maxBytes: number): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const length = data[i]
    i++
    if (length === 128) break
    if (length < 128) {
      for (let j = 0; j <= length && i < data.length; j++, i++) {
        ensureAppendFits(out.length, 1, maxBytes)
        out.push(data[i])
      }
    } else {
      const byte = data[i]
      i++
      const repeat = 257 - length
      ensureAppendFits(out.length, repeat, maxBytes)
      for (let j = 0; j < repeat; j++) out.push(byte)
    }
  }
  return new Uint8Array(out)
}

function lzwDecode(data: Uint8Array, earlyChange: number, maxBytes: number): Uint8Array {
  const CLEAR = 256
  const EOD = 257
  let bitBuffer = 0
  let bitCount = 0
  let pos = 0
  const out: number[] = []

  function nextCode(codeWidth: number): number | null {
    while (bitCount < codeWidth) {
      if (pos >= data.length) return null
      bitBuffer = (bitBuffer << 8) | data[pos]
      pos++
      bitCount += 8
    }
    const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1)
    bitCount -= codeWidth
    return code
  }

  let table: Uint8Array[] = []
  let codeWidth = 9

  function resetTable(): void {
    table = []
    for (let i = 0; i < 256; i++) table.push(Uint8Array.of(i))
    table.push(new Uint8Array(0)) // 256 clear
    table.push(new Uint8Array(0)) // 257 eod
    codeWidth = 9
  }
  resetTable()

  let prev: Uint8Array | null = null
  for (;;) {
    const code = nextCode(codeWidth)
    if (code === null || code === EOD) break
    if (code === CLEAR) {
      resetTable()
      prev = null
      continue
    }
    let entry: Uint8Array
    if (code < table.length) {
      entry = table[code]
    } else if (code === table.length && prev) {
      entry = concatBytes(prev, prev.subarray(0, 1))
    } else {
      break
    }
    ensureAppendFits(out.length, entry.length, maxBytes)
    for (const b of entry) out.push(b)
    if (prev) {
      table.push(concatBytes(prev, entry.subarray(0, 1)))
    }
    prev = entry
    const limit = table.length + earlyChange
    if (limit > 2047) codeWidth = 12
    else if (limit > 1023) codeWidth = 11
    else if (limit > 511) codeWidth = 10
    else codeWidth = 9
  }
  return new Uint8Array(out)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PdfStreamLimitError(`${name} must be a positive integer`)
  }
  return value
}

function assertDecodedSize(data: Uint8Array, maxBytes: number): void {
  if (data.length > maxBytes) {
    throw new PdfStreamLimitError(`Decoded stream exceeds maxBytes (${data.length} > ${maxBytes})`)
  }
}

function ensureAppendFits(current: number, additional: number, maxBytes: number): void {
  if (!Number.isSafeInteger(additional) || additional < 0 || current > maxBytes - additional) {
    throw new PdfStreamLimitError(`Decoded stream exceeds maxBytes (${maxBytes})`)
  }
}

function isOutputLimitError(error: unknown): boolean {
  const value = error as { code?: string; message?: string }
  return value?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(value?.message ?? "")
}
