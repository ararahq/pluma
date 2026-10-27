import { createHash } from "node:crypto"
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler"
import { DisabledMarkdownFeatureError, markdownToTypst } from "./md-to-typst.js"
import { extractFrontmatter } from "./frontmatter.js"
import { themes, cleanTheme, createTheme, type Brand, type Theme, type DocumentMeta } from "./theme.js"
import { countPdfPages } from "./read/index.js"

export interface RenderOptions {
  theme?: string | Theme
  brand?: Brand
  meta?: DocumentMeta
  fontPaths?: string[]
  root?: string
  /** Disable trusted raw Typst fences (used by hosted/multi-tenant wrappers). */
  allowRawTypst?: boolean
  /** Disable Markdown image references (used by hosted/multi-tenant wrappers). */
  allowImages?: boolean
}

export interface CloudSafeLogo {
  /** PNG or JPEG bytes, at most 2 MiB and 4096 pixels per side. */
  data: Uint8Array
  /** Display width, for example "2.8cm" (pt, mm, cm, in or em). */
  width?: string
}

export interface CloudSafeRenderOptions {
  brand?: unknown
  meta?: unknown
  /** Logo bytes ({@link CloudSafeLogo}). Mapped into a virtual workspace: nothing is read from disk. */
  logo?: unknown
}

export interface CloudSafeRenderResult {
  pdf: Uint8Array
  pageCount: number
}

export class UnsafeRenderInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeRenderInputError"
  }
}

export class UnknownThemeError extends Error {
  constructor(name: string) {
    super(`Unknown theme "${name}". Available: ${Object.keys(themes).join(", ")}`)
    this.name = "UnknownThemeError"
  }
}

function resolveTheme(options: RenderOptions): Theme {
  if (options.brand) return createTheme(options.brand)
  const { theme } = options
  if (!theme) return cleanTheme
  if (typeof theme !== "string") return theme
  const found = themes[theme]
  if (!found) throw new UnknownThemeError(theme)
  return found
}

const WRAPPING_FENCE = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/

export function normalizeInput(markdown: string): string {
  const match = markdown.match(WRAPPING_FENCE)
  return match ? match[1] : markdown
}

export function markdownToTypstSource(markdown: string, options: RenderOptions = {}): string {
  const { meta: frontmatter, body } = extractFrontmatter(normalizeInput(markdown))
  const meta = { ...frontmatter, ...options.meta }
  return resolveTheme(options).preamble(meta).trim() + "\n\n" + markdownToTypst(body, {
    allowRawTypst: options.allowRawTypst,
    allowImages: options.allowImages,
  })
}

export function renderPdf(markdown: string, options: RenderOptions = {}): Uint8Array {
  return compilePdf(markdownToTypstSource(markdown, options), options)
}

// A workspace that exists only in memory: files mapped into it are the only ones a document can reach.
const VIRTUAL_WORKSPACE = "/pluma-virtual"

function compilePdf(
  source: string,
  options: Pick<RenderOptions, "root" | "fontPaths"> & { virtualFiles?: Record<string, Uint8Array> },
): Uint8Array {
  const virtualFiles = Object.entries(options.virtualFiles ?? {})
  const workspace = virtualFiles.length ? VIRTUAL_WORKSPACE : options.root
  const compiler = NodeCompiler.create({
    ...(workspace ? { workspace } : {}),
    ...(options.fontPaths?.length ? { fontArgs: [{ fontPaths: options.fontPaths }] } : {}),
  })
  try {
    for (const [name, data] of virtualFiles) compiler.mapShadow(`${VIRTUAL_WORKSPACE}/${name}`, Buffer.from(data))
    return compiler.pdf({ mainFileContent: source })
  } finally {
    compiler.evictCache(0)
  }
}

const BRAND_KEYS = new Set(["fonts", "colors", "page", "footer"])
const FONT_KEYS = new Set(["body", "heading", "mono", "size"])
const COLOR_KEYS = new Set(["text", "muted", "faint", "accent", "link", "border", "codeBackground"])
const PAGE_KEYS = new Set(["paper", "marginX", "marginY"])
const META_KEYS = new Set(["title", "author", "date", "subtitle"])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnsafeRenderInputError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new UnsafeRenderInputError(`${field}.${unknown} is not allowed in cloud-safe rendering`)
}

function optionalStrings(value: unknown, allowed: Set<string>, field: string): Record<string, string> {
  const input = record(value, field)
  assertKnownKeys(input, allowed, field)
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") throw new UnsafeRenderInputError(`${field}.${key} must be a string`)
  }
  return input as Record<string, string>
}

function cloudSafeFonts(value: unknown): NonNullable<Brand["fonts"]> {
  const input = record(value, "brand.fonts")
  assertKnownKeys(input, FONT_KEYS, "brand.fonts")
  const fonts = optionalStringsWithout(input, "size", "brand.fonts")
  if (
    input.size !== undefined &&
    (typeof input.size !== "number" || !Number.isFinite(input.size) || input.size < 6 || input.size > 72)
  ) {
    throw new UnsafeRenderInputError("brand.fonts.size must be a finite number between 6 and 72")
  }
  return { ...fonts, ...(input.size === undefined ? {} : { size: input.size as number }) }
}

function optionalStringsWithout(
  input: Record<string, unknown>,
  excluded: string,
  field: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(input)) {
    if (key === excluded) continue
    if (typeof item !== "string") throw new UnsafeRenderInputError(`${field}.${key} must be a string`)
    result[key] = item
  }
  return result
}

function cloudSafeBrand(value: unknown): Brand | undefined {
  if (value === undefined) return undefined
  const input = record(value, "brand")
  assertKnownKeys(input, BRAND_KEYS, "brand")
  return {
    fonts: input.fonts === undefined ? undefined : cloudSafeFonts(input.fonts),
    colors: input.colors === undefined ? undefined : optionalStrings(input.colors, COLOR_KEYS, "brand.colors"),
    page: input.page === undefined ? undefined : optionalStrings(input.page, PAGE_KEYS, "brand.page"),
    footer: input.footer === undefined ? undefined : optionalText(input.footer, "brand.footer"),
  }
}

function optionalText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new UnsafeRenderInputError(`${field} must be a string`)
  return value
}

function cloudSafeMeta(value: unknown): DocumentMeta | undefined {
  if (value === undefined) return undefined
  return optionalStrings(value, META_KEYS, "meta") as DocumentMeta
}

const LOGO_KEYS = new Set(["data", "width"])
const LOGO_MAX_BYTES = 2 * 1024 * 1024
const LOGO_MAX_SIDE = 4096
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// JPEG start-of-frame markers carry the pixel size; C4, C8 and CC share the range but are not frames
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8])

interface ImageInfo {
  extension: "png" | "jpg"
  width: number
  height: number
}

const uint16 = (data: Uint8Array, at: number) => (data[at] << 8) | data[at + 1]
const uint32 = (data: Uint8Array, at: number) => ((data[at] << 24) >>> 0) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3]

function pngInfo(data: Uint8Array): ImageInfo | null {
  if (data.length < 24 || PNG_SIGNATURE.some((byte, i) => data[i] !== byte)) return null
  if (String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") return null
  return { extension: "png", width: uint32(data, 16), height: uint32(data, 20) }
}

function jpegInfo(data: Uint8Array): ImageInfo | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let at = 2
  while (at + 3 < data.length) {
    if (data[at] !== 0xff) return null
    const marker = data[at + 1]
    if (marker === 0xff) { at += 1; continue }
    if (JPEG_STANDALONE.has(marker)) { at += 2; continue }
    if (marker === 0xda || marker === 0xd9) return null
    if (JPEG_FRAMES.has(marker)) {
      return at + 8 < data.length ? { extension: "jpg", height: uint16(data, at + 5), width: uint16(data, at + 7) } : null
    }
    at += 2 + uint16(data, at + 2)
  }
  return null
}

function cloudSafeLogo(value: unknown): { name: string; data: Uint8Array; width?: string } | undefined {
  if (value === undefined) return undefined
  const input = record(value, "logo")
  assertKnownKeys(input, LOGO_KEYS, "logo")
  const { data } = input
  if (!(data instanceof Uint8Array)) throw new UnsafeRenderInputError("logo.data must be a Uint8Array")
  if (data.length === 0 || data.length > LOGO_MAX_BYTES) {
    throw new UnsafeRenderInputError(`logo.data must have between 1 and ${LOGO_MAX_BYTES} bytes`)
  }
  const image = pngInfo(data) ?? jpegInfo(data)
  if (!image) throw new UnsafeRenderInputError("logo.data must be a PNG or JPEG image")
  if (image.width < 1 || image.height < 1 || image.width > LOGO_MAX_SIDE || image.height > LOGO_MAX_SIDE) {
    throw new UnsafeRenderInputError(`logo.data must be at most ${LOGO_MAX_SIDE}x${LOGO_MAX_SIDE} pixels`)
  }
  const width = input.width === undefined ? undefined : optionalText(input.width, "logo.width")
  // named by content: two logos never share a path, not even in the compiler's memoization
  const name = `logo-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.${image.extension}`
  return { name, data, ...(width === undefined ? {} : { width }) }
}

/**
 * Restricted wrapper intended for hosted/multi-tenant execution. The local
 * `renderPdf` API remains unrestricted and continues to support raw Typst,
 * custom themes, local assets and font directories. A logo arrives as
 * validated bytes and is mapped into a virtual workspace, never as a path.
 */
export function renderPdfCloudSafe(
  markdown: string,
  options: CloudSafeRenderOptions = {},
): CloudSafeRenderResult {
  let pdf: Uint8Array
  try {
    const logo = cloudSafeLogo(options.logo)
    const brand = cloudSafeBrand(options.brand)
    const renderOptions: RenderOptions = {
      brand: logo ? { ...brand, logo: { path: `/${logo.name}`, ...(logo.width ? { width: logo.width } : {}) } } : brand,
      meta: cloudSafeMeta(options.meta),
      allowRawTypst: false,
      allowImages: false,
    }
    pdf = compilePdf(markdownToTypstSource(markdown, renderOptions), {
      virtualFiles: logo ? { [logo.name]: logo.data } : undefined,
    })
  } catch (error) {
    if (error instanceof DisabledMarkdownFeatureError) {
      throw new UnsafeRenderInputError(
        error.feature === "raw_typst"
          ? "Raw Typst blocks are not allowed in cloud-safe rendering"
          : "Markdown images are not allowed in cloud-safe rendering",
      )
    }
    throw error
  }
  return { pdf, pageCount: countPdfPages(pdf) }
}

export { readHtml, readUrl, HtmlFetchError, HtmlLimitError } from "./read/html/index.js"
export type {
  ReadHtmlOptions,
  ReadUrlOptions,
  ReadResult as ReadHtmlResult,
  LinkEntry,
  PageMeta,
  FetchDnsAddress,
  FetchDnsResolver,
  FetchUrlPolicy,
  FetchUrlPolicyContext,
} from "./read/html/index.js"
export { markdownToTypst } from "./md-to-typst.js"
export { extractFrontmatter } from "./frontmatter.js"
export { themes, cleanTheme, createTheme, InvalidBrandError } from "./theme.js"
export type { Theme, Brand, DocumentMeta } from "./theme.js"

export {
  readPdf,
  readPdfPages,
  countPdfPages,
  looksLikePdf,
  PdfParseError,
  PdfLimitError,
  PdfStructureError,
  PdfEncryptedError,
} from "./read/index.js"

export { compileContext, compileRows, ContextCompileJob, StreamContextCompileJob } from "./context/compile.js"
export type { CompileOptions, CompileRowsOptions } from "./context/compile.js"
export { openContext, PlumaContext, QueryResult, QueryStreamResult } from "./context/runtime.js"
export { ContextPackageReader, ContextPackageWriter } from "./context/package.js"
export { exportRows, exportData, exportWorkbook } from "./context/export.js"
export type { ExportFormat, ExportRowsOptions, ExportWorkbookOptions, WorkbookRelation, XlsxExportOptions } from "./context/export.js"
export { ContextError, PLUMA_CONTEXT_VERSION, PLUMA_CONTEXT_LEGACY_VERSION } from "./context/types.js"
export type {
  ContextManifest,
  ContextRelation,
  ContextField,
  ContextBlock,
  ContextRow,
  ContextBatch,
  ContextPayload,
  CompileEvent,
  CompileState,
  QueryPlan,
  QueryProvenance,
  TokenBudget,
  TokenizerSpec,
  ResourceBudget,
  ResolvedResourceBudget,
  ResumableRowSource,
  QueryExplanation,
  QueryStrategy,
  IndexDefinition,
  MaterializedAggregateDefinition,
} from "./context/types.js"
export type {
  ReadResult as ReadPdfResult,
  ReadPdfOptions,
  PageResult,
  OutlineItem,
  DocumentMeta as PdfDocumentMeta,
} from "./read/index.js"
