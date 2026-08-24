/**
 * Public read API: PDF → clean Markdown, no browser, no external
 * dependencies beyond Node's standard library. Mirrors the DX of the write
 * side (renderPdf/markdownToTypst): a synchronous `readPdf` for the common
 * case, plus `readPdfPages` for streaming page-by-page over very large
 * documents without holding every decoded page in memory at once.
 */
import { readFileSync, statSync } from "node:fs"
import { PdfParseError } from "./pdf/objects.js"
import { PdfLimitError } from "./pdf/xref.js"
import {
  PdfEncryptedError,
  PdfStructureError,
  iterateDecodedPages,
  openParsedPdf,
  readPdfDocument,
  type DocumentMeta,
  type OutlineItem,
  type PageResult,
  type ReadPdfOptions,
  type ReadResult,
} from "./pdf/document.js"

export { PdfParseError, PdfLimitError, PdfStructureError, PdfEncryptedError }
export type { DocumentMeta, OutlineItem, PageResult, ReadPdfOptions, ReadResult }

const PDF_MAGIC = "%PDF-"
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

function toBuffer(input: Uint8Array | Buffer | string, requestedMaxBytes = DEFAULT_MAX_BYTES): Uint8Array {
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
    throw new PdfLimitError("maxBytes must be a positive integer")
  }
  const maxBytes = requestedMaxBytes
  if (typeof input === "string") {
    const stats = statSync(input)
    if (!stats.isFile()) throw new PdfLimitError("PDF path must reference a regular file")
    const size = stats.size
    if (size > maxBytes) throw new PdfLimitError(`Input exceeds maxBytes (${size} > ${maxBytes})`)
    return new Uint8Array(readFileSync(input))
  }
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false
  }
  return true
}

/** Synchronously reads a PDF (path, Buffer, or bytes) into clean Markdown plus structured pages. */
export function readPdf(input: Uint8Array | Buffer | string, options: ReadPdfOptions = {}): ReadResult {
  const bytes = toBuffer(input, options.maxBytes)
  if (!looksLikePdf(bytes)) {
    throw new PdfParseError("Input does not start with the %PDF- magic bytes", 0)
  }
  return readPdfDocument(bytes, options)
}

/** Counts pages without decoding page content streams. */
export function countPdfPages(input: Uint8Array | Buffer | string): number {
  const bytes = toBuffer(input)
  if (!looksLikePdf(bytes)) {
    throw new PdfParseError("Input does not start with the %PDF- magic bytes", 0)
  }
  return openParsedPdf(bytes).pageNodes.length
}

/**
 * Iterates pages one at a time from a SINGLE parse of the document (xref
 * tables/streams, object streams and the page tree are walked exactly once
 * by `openParsedPdf`) — decoding page N never re-opens or re-scans the file,
 * and no earlier page's glyphs/blocks/text are retained once yielded, so
 * memory stays roughly constant across a large document instead of growing
 * with page count. The one feature unavailable in this mode is cross-page
 * repeated header/footer stripping, which needs every page's text up front
 * to find what repeats — see `dropHeadersFooters` in ReadPdfOptions.
 */
export async function* readPdfPages(
  input: Uint8Array | Buffer | string,
  options: ReadPdfOptions = {},
): AsyncGenerator<PageResult> {
  const bytes = toBuffer(input, options.maxBytes)
  if (!looksLikePdf(bytes)) {
    throw new PdfParseError("Input does not start with the %PDF- magic bytes", 0)
  }
  const parsed = openParsedPdf(bytes, options)
  let seenWarnings = parsed.warnings.length
  for (const page of iterateDecodedPages(parsed, options.maxPages)) {
    for (; seenWarnings < parsed.warnings.length; seenWarnings++) options.onWarning?.(parsed.warnings[seenWarnings])
    yield page
  }
}
