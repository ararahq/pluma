/**
 * Glue layer: walks the page tree, decodes each page's content stream(s)
 * into positioned glyphs, collects link annotations, resolves document
 * metadata and the outline (bookmarks), and produces per-page Markdown via
 * layout.ts + markdown.ts. Cross-page repeated lines (headers/footers) are
 * detected once all pages are laid out and stripped when requested.
 */
import {
  dictGet,
  dictGetName,
  isArray,
  isDict,
  isRef,
  isStream,
  parseIndirectObject,
  type PdfDict,
  type PdfValue,
} from "./objects.js"
import { decodeStream } from "./filters.js"
import { PdfEncryptedError } from "./crypto.js"
import { openPdfDocument, PdfLimitError, type PdfDocument } from "./xref.js"
import { createRunContext, runContentStream, type PositionedGlyph, type Resources } from "./content.js"
import { buildBlocksForPage, glyphsToLines, type Block } from "./layout.js"
import { joinPages, renderBlocksToMarkdown, type LinkAnnotation } from "./markdown.js"

export class PdfStructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfStructureError"
  }
}

export { PdfEncryptedError } from "./crypto.js"

export interface DocumentMeta {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
  created?: string
  modified?: string
  pageCount: number
  encrypted: boolean
  language?: string
  /**
   * "full": every page produced text. "none": no page produced any text —
   * almost always a scanned document with no OCR layer; downstream RAG
   * pipelines need OCR before this document is useful. "partial": a mix
   * (e.g. some pages are scanned inserts in an otherwise text document).
   */
  textLayer: "full" | "partial" | "none"
}

export interface OutlineItem {
  title: string
  pageIndex?: number
  children: OutlineItem[]
}

export interface PageResult {
  index: number
  markdown: string
  blocks: Block[]
  width: number
  height: number
  /** False when the page decoded zero glyphs — a scanned/image-only page has no text layer at all. */
  hasText: boolean
}

export interface ReadResult {
  markdown: string
  pages: PageResult[]
  meta: DocumentMeta
  outline?: OutlineItem[]
  warnings: string[]
}

export interface ReadPdfOptions {
  pageBreaks?: "none" | "rule" | "marker"
  pages?: string
  headings?: boolean
  tables?: boolean
  dropHeadersFooters?: boolean
  maxPages?: number
  maxBytes?: number
  onWarning?: (message: string) => void
}

const DEFAULT_MAX_OPS_PER_PAGE = 400_000
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_PAGES = 5000
const MAX_PAGE_TREE_DEPTH = 64
const MAX_PAGE_TREE_NODES = 50_000
const MAX_PAGE_CONTENT_BYTES = 64 * 1024 * 1024
const MAX_SINGLE_STREAM_BYTES = 16 * 1024 * 1024

function resolve(doc: PdfDocument, value: PdfValue | undefined): PdfValue | undefined {
  if (value === undefined) return undefined
  if (isRef(value)) return doc.getObject(value.num)
  return value
}

function resolveDict(doc: PdfDocument, value: PdfValue | undefined): PdfDict | undefined {
  const resolved = resolve(doc, value)
  return isDict(resolved) ? resolved : undefined
}

interface PageNode {
  dict: PdfDict
  inheritedResources?: PdfDict
  inheritedMediaBox?: number[]
}

interface PageTreeBudget {
  visited: Set<PdfDict>
  nodes: number
  maxNodes: number
  maxPages: number
}

function collectPages(
  doc: PdfDocument,
  node: PdfDict,
  acc: PageNode[],
  inherited: PageNode,
  budget: PageTreeBudget,
  depth = 0,
): void {
  if (depth > MAX_PAGE_TREE_DEPTH) {
    throw new PdfLimitError(`Page tree exceeds maximum depth (${MAX_PAGE_TREE_DEPTH})`)
  }
  if (budget.visited.has(node)) throw new PdfStructureError("Page tree contains a cycle or reused node")
  budget.visited.add(node)
  budget.nodes++
  if (budget.nodes > budget.maxNodes) {
    throw new PdfLimitError(`Page tree exceeds node budget (${budget.maxNodes})`)
  }
  const resourcesRaw = resolveDict(doc, dictGet(node, "Resources")) ?? inherited.inheritedResources
  const mediaBoxRaw = resolve(doc, dictGet(node, "MediaBox"))
  const mediaBox = isArray(mediaBoxRaw)
    ? mediaBoxRaw.items.map((v) => (typeof v === "number" ? v : 0))
    : inherited.inheritedMediaBox

  const type = dictGetName(node, "Type")
  if (type === "Pages" || dictGet(node, "Kids")) {
    const kids = resolve(doc, dictGet(node, "Kids"))
    if (isArray(kids)) {
      for (const kid of kids.items) {
        const kidDict = resolveDict(doc, kid)
        if (kidDict) {
          collectPages(
            doc,
            kidDict,
            acc,
            { dict: node, inheritedResources: resourcesRaw, inheritedMediaBox: mediaBox },
            budget,
            depth + 1,
          )
        }
      }
    }
    return
  }
  if (acc.length >= budget.maxPages) {
    throw new PdfLimitError(`Document exceeds maxPages (${budget.maxPages})`)
  }
  acc.push({ dict: node, inheritedResources: resourcesRaw, inheritedMediaBox: mediaBox })
}

function getPageContentBytes(doc: PdfDocument, page: PdfDict): Uint8Array {
  const contents = resolve(doc, dictGet(page, "Contents"))
  if (isStream(contents)) return decodeStream(contents.bytes, contents.dict, { maxBytes: MAX_SINGLE_STREAM_BYTES })
  if (isArray(contents)) {
    const parts: Uint8Array[] = []
    let total = 0
    for (const item of contents.items) {
      const streamValue = resolve(doc, item)
      if (isStream(streamValue)) {
        if (total >= MAX_PAGE_CONTENT_BYTES) {
          throw new PdfLimitError(`Page content exceeds byte budget (${MAX_PAGE_CONTENT_BYTES})`)
        }
        const decoded = decodeStream(streamValue.bytes, streamValue.dict, {
          maxBytes: Math.min(MAX_SINGLE_STREAM_BYTES, MAX_PAGE_CONTENT_BYTES - total),
        })
        total += decoded.length + 1
        if (total > MAX_PAGE_CONTENT_BYTES) {
          throw new PdfLimitError(`Page content exceeds byte budget (${MAX_PAGE_CONTENT_BYTES})`)
        }
        parts.push(decoded)
        parts.push(Uint8Array.of(0x0a))
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      out.set(p, offset)
      offset += p.length
    }
    return out
  }
  return new Uint8Array(0)
}

/** True if the page's own (non-inherited-through-Form) /Resources /XObject includes at least one Image. */
function hasImageXObject(doc: PdfDocument, resourcesDict: PdfDict | undefined): boolean {
  const xobjectDict = resolveDict(doc, dictGet(resourcesDict, "XObject"))
  if (!xobjectDict) return false
  for (const value of xobjectDict.map.values()) {
    const resolved = resolve(doc, value)
    if (isStream(resolved) && dictGetName(resolved.dict, "Subtype") === "Image") return true
  }
  return false
}

function collectLinkAnnotations(doc: PdfDocument, page: PdfDict, pageHeight: number): LinkAnnotation[] {
  const annotsRaw = resolve(doc, dictGet(page, "Annots"))
  const links: LinkAnnotation[] = []
  if (!isArray(annotsRaw)) return links
  for (const annotRef of annotsRaw.items) {
    const annot = resolveDict(doc, annotRef)
    if (!annot || dictGetName(annot, "Subtype") !== "Link") continue
    const action = resolveDict(doc, dictGet(annot, "A"))
    const uriValue = action ? dictGet(action, "URI") : undefined
    if (typeof uriValue !== "string") continue
    const rect = resolve(doc, dictGet(annot, "Rect"))
    if (!isArray(rect) || rect.items.length < 4) continue
    const [x0, y0, x1, y1] = rect.items.map((v) => (typeof v === "number" ? v : 0))
    links.push({ uri: uriValue, xStart: Math.min(x0, x1), xEnd: Math.max(x0, x1), y: (y0 + y1) / 2 })
  }
  void pageHeight
  return links
}

function parsePageRanges(spec: string | undefined, pageCount: number): Set<number> | undefined {
  if (!spec) return undefined
  const result = new Set<number>()
  for (const part of spec.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10)
      const end = Number.parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end && i <= pageCount; i++) result.add(i - 1)
    } else {
      const n = Number.parseInt(trimmed, 10)
      if (!Number.isNaN(n)) result.add(n - 1)
    }
  }
  return result
}

function textValue(doc: PdfDocument, dict: PdfDict | undefined, key: string): string | undefined {
  const value = resolve(doc, dictGet(dict, key))
  return typeof value === "string" ? value : undefined
}

function pdfDateToIso(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!match) return undefined
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = match
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
}

function buildOutline(doc: PdfDocument, root: PdfDict | undefined, pageNumberByRef: Map<number, number>): OutlineItem[] | undefined {
  const outlinesRoot = resolveDict(doc, dictGet(root, "Outlines"))
  if (!outlinesRoot) return undefined
  const first = dictGet(outlinesRoot, "First")
  if (!first) return []

  const visited = new Set<PdfDict>()
  let remaining = 20_000
  function walk(nodeRef: PdfValue | undefined, depth: number): OutlineItem[] {
    if (depth > 20) return []
    const items: OutlineItem[] = []
    let currentRef = nodeRef
    let guard = 0
    while (currentRef && guard++ < 5000) {
      const node = resolveDict(doc, currentRef)
      if (!node) break
      if (visited.has(node) || remaining-- <= 0) break
      visited.add(node)
      const title = textValue(doc, node, "Title") ?? ""
      const dest = resolve(doc, dictGet(node, "Dest"))
      const action = resolveDict(doc, dictGet(node, "A"))
      let pageIndex: number | undefined
      const destArray = isArray(dest) ? dest : isArray(resolve(doc, dictGet(action, "D"))) ? (resolve(doc, dictGet(action, "D")) as never) : undefined
      if (destArray && isArray(destArray) && isRef(destArray.items[0] as never)) {
        pageIndex = pageNumberByRef.get((destArray.items[0] as { num: number }).num)
      }
      const children = dictGet(node, "First") ? walk(dictGet(node, "First"), depth + 1) : []
      items.push({ title, pageIndex, children })
      currentRef = dictGet(node, "Next")
    }
    return items
  }
  return walk(first, 0)
}

/**
 * A PDF opened and its page tree walked exactly once — xref/object-stream
 * parsing happens here and only here. `decodePageAt` can then be called for
 * any subset of pages (once, or repeatedly, in any order) without ever
 * re-running `openPdfDocument`: readPdfDocument (all pages, sync) and
 * readPdfPages (one page at a time, streaming) both build on this so neither
 * pays the xref-parsing cost more than once per document.
 */
export interface ParsedPdf {
  doc: PdfDocument
  pageNodes: PageNode[]
  root: PdfDict
  warnings: string[]
  headings: boolean
  tables: boolean
  selection: Set<number> | undefined
}

export function openParsedPdf(buf: Uint8Array, options: ReadPdfOptions = {}): ParsedPdf {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (buf.length > maxBytes) {
    throw new PdfLimitError(`Input exceeds maxBytes (${buf.length} > ${maxBytes})`)
  }

  const warnings: string[] = []
  const emit = (message: string) => {
    warnings.push(message)
    options.onWarning?.(message)
  }

  const doc = openPdfDocument(buf, warnings)
  for (const w of doc.warnings) if (!warnings.includes(w)) emit(w)

  const encryptRef = dictGet(doc.trailer, "Encrypt")
  if (encryptRef) {
    const encryptDict = resolveDict(doc, encryptRef)
    const filter = dictGetName(encryptDict, "Filter")
    if (filter && filter !== "Standard") {
      throw new PdfEncryptedError(
        `Unsupported security handler "${filter}" — only the Standard handler with an empty user password is supported`,
      )
    }
  }

  const root = resolveDict(doc, dictGet(doc.trailer, "Root"))
  if (!root) throw new PdfStructureError("Could not locate document Catalog (/Root)")
  const pagesRoot = resolveDict(doc, dictGet(root, "Pages"))
  if (!pagesRoot) throw new PdfStructureError("Could not locate page tree (/Pages)")

  const requestedMaxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  if (!Number.isSafeInteger(requestedMaxPages) || requestedMaxPages <= 0) {
    throw new PdfLimitError("maxPages must be a positive integer")
  }
  const maxPages = Math.min(requestedMaxPages, DEFAULT_MAX_PAGES)
  const pageNodes: PageNode[] = []
  collectPages(doc, pagesRoot, pageNodes, { dict: pagesRoot }, {
    visited: new Set(),
    nodes: 0,
    maxNodes: Math.min(MAX_PAGE_TREE_NODES, Math.max(1024, maxPages * 8)),
    maxPages,
  })

  return {
    doc,
    pageNodes,
    root,
    warnings,
    headings: options.headings ?? true,
    tables: options.tables ?? true,
    selection: parsePageRanges(options.pages, pageNodes.length),
  }
}

/** Decodes exactly one page's content stream into a PageResult. No other page is touched. */
export function decodePageAt(parsed: ParsedPdf, index: number): PageResult {
  const { doc } = parsed
  const node = parsed.pageNodes[index]
  const mediaBox = node.inheritedMediaBox ?? [0, 0, 612, 792]
  const width = Math.abs((mediaBox[2] ?? 612) - (mediaBox[0] ?? 0))
  const height = Math.abs((mediaBox[3] ?? 792) - (mediaBox[1] ?? 0))

  let glyphs: PositionedGlyph[] = []
  try {
    const contentBytes = getPageContentBytes(doc, node.dict)
    const resources: Resources = { dict: node.inheritedResources }
    const ctx = createRunContext((v) => resolve(doc, v), DEFAULT_MAX_OPS_PER_PAGE)
    runContentStream(contentBytes, [1, 0, 0, 1, 0, 0], resources, ctx)
    glyphs = ctx.glyphs
    for (const w of ctx.warnings) parsed.warnings.push(`Page ${index + 1}: ${w}`)
  } catch (error) {
    parsed.warnings.push(`Page ${index + 1} content stream failed: ${(error as Error).message}`)
  }

  const hasText = glyphs.length > 0
  if (!hasText && hasImageXObject(doc, node.inheritedResources)) {
    parsed.warnings.push(`Page ${index + 1} has no text layer (image-only; likely scanned). OCR is not performed.`)
  }

  const lines = glyphsToLines(glyphs)
  const blocks = dropBottomMarginPageNumber(
    buildBlocksForPage(lines, { pageWidth: width, headings: parsed.headings, tables: parsed.tables }),
    height,
  )
  const links = collectLinkAnnotations(doc, node.dict, height)
  const markdown = renderBlocksToMarkdown(blocks, links)
  return { index, markdown, blocks, width, height, hasText }
}

export function readPdfDocument(buf: Uint8Array, options: ReadPdfOptions = {}): ReadResult {
  const parsed = openParsedPdf(buf, options)
  const { doc, pageNodes, root, selection } = parsed

  const pageNumberByRef = new Map<number, number>()
  // Best-effort ref->pageIndex map for outline destinations; rebuilt by identity below.
  pageNodes.forEach((_node, i) => pageNumberByRef.set(i, i))

  const pages: PageResult[] = []
  for (let i = 0; i < pageNodes.length; i++) {
    if (selection && !selection.has(i)) continue
    pages.push(decodePageAt(parsed, i))
  }

  let finalPages = pages
  if (options.dropHeadersFooters !== false) {
    finalPages = stripRepeatedHeaderFooterLines(pages)
  }

  const infoDict = resolveDict(doc, dictGet(doc.trailer, "Info"))
  const meta: DocumentMeta = {
    title: textValue(doc, infoDict, "Title"),
    author: textValue(doc, infoDict, "Author"),
    subject: textValue(doc, infoDict, "Subject"),
    keywords: textValue(doc, infoDict, "Keywords"),
    creator: textValue(doc, infoDict, "Creator"),
    producer: textValue(doc, infoDict, "Producer"),
    created: pdfDateToIso(textValue(doc, infoDict, "CreationDate")),
    modified: pdfDateToIso(textValue(doc, infoDict, "ModDate")),
    pageCount: pageNodes.length,
    encrypted: !!doc.crypto,
    language: textValue(doc, root, "Lang"),
    textLayer: classifyTextLayer(finalPages),
  }

  const outline = buildOutline(doc, root, pageNumberByRef)
  const markdown = joinPages(
    finalPages.map((p) => p.markdown),
    options.pageBreaks ?? "none",
  )

  return { markdown, pages: finalPages, meta, outline, warnings: parsed.warnings }
}

/**
 * Streams pages one at a time from a SINGLE parse of the document (xref,
 * object streams and the page tree are walked exactly once, by
 * `openParsedPdf`) — decoding page N does not re-open or re-scan the file,
 * and no earlier page's glyphs/blocks are retained once yielded. The one
 * feature this mode cannot offer is cross-page repeated header/footer
 * stripping (`dropHeadersFooters`'s "same line appears near-verbatim on N
 * pages" check needs every page's text up front); the per-page bottom-margin
 * page-number heuristic still applies since it only looks at one page.
 */
export function* iterateDecodedPages(parsed: ParsedPdf, maxPages?: number): Generator<PageResult> {
  const { pageNodes, selection } = parsed
  let yielded = 0
  for (let i = 0; i < pageNodes.length; i++) {
    if (selection && !selection.has(i)) continue
    if (maxPages !== undefined && yielded >= maxPages) break
    yield decodePageAt(parsed, i)
    yielded++
  }
}

/** Drops a lone page-number paragraph ("3", "- 3 -") sitting in the bottom margin of a page. */
function classifyTextLayer(pages: PageResult[]): "full" | "partial" | "none" {
  if (pages.length === 0) return "none"
  const withText = pages.filter((p) => p.hasText).length
  if (withText === 0) return "none"
  if (withText === pages.length) return "full"
  return "partial"
}

function dropBottomMarginPageNumber(blocks: Block[], pageHeight: number): Block[] {
  if (blocks.length === 0) return blocks
  const last = blocks[blocks.length - 1]
  if (last.kind !== "paragraph") return blocks
  const looksLikePageNumber = /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(last.text)
  const inBottomMargin = last.y < pageHeight * 0.12
  if (looksLikePageNumber && inBottomMargin) return blocks.slice(0, -1)
  return blocks
}

/** Detects lines that repeat verbatim near the top or bottom margin across most pages and drops them. */
function stripRepeatedHeaderFooterLines(pages: PageResult[]): PageResult[] {
  if (pages.length < 3) return pages
  const counts = new Map<string, number>()
  for (const page of pages) {
    const text = page.markdown
    const firstLine = text.split("\n").find(Boolean)
    const lastLine = [...text.split("\n")].reverse().find(Boolean)
    for (const candidate of [firstLine, lastLine]) {
      if (!candidate) continue
      const normalized = candidate.replace(/\d+/g, "#").trim()
      // A real address/phone footer line ("Av. ... Fone: (79) 3209-2400")
      // can easily run past 120 characters once street, neighborhood,
      // building and phone are all on one rendered line — 120 was rejecting
      // exactly the footer it was supposed to catch on a real document.
      if (normalized.length < 3 || normalized.length > 220) continue
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6))
  const repeated = new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([text]) => text))
  if (repeated.size === 0) return pages

  return pages.map((page) => {
    const lines = page.markdown.split("\n")
    const kept = lines.filter((line) => !repeated.has(line.replace(/\d+/g, "#").trim()))
    return { ...page, markdown: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() }
  })
}

// Re-exported for callers that need low-level object access without going through readPdfDocument.
export { parseIndirectObject }
