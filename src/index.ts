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

export interface CloudSafeRenderOptions {
  brand?: unknown
  meta?: unknown
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
  const source = markdownToTypstSource(markdown, options)
  const compiler = NodeCompiler.create({
    ...(options.root ? { workspace: options.root } : {}),
    ...(options.fontPaths?.length ? { fontArgs: [{ fontPaths: options.fontPaths }] } : {}),
  })
  try {
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

/**
 * Restricted wrapper intended for hosted/multi-tenant execution. The local
 * `renderPdf` API remains unrestricted and continues to support raw Typst,
 * custom themes, local assets and font directories.
 */
export function renderPdfCloudSafe(
  markdown: string,
  options: CloudSafeRenderOptions = {},
): CloudSafeRenderResult {
  let pdf: Uint8Array
  try {
    pdf = renderPdf(markdown, {
      brand: cloudSafeBrand(options.brand),
      meta: cloudSafeMeta(options.meta),
      allowRawTypst: false,
      allowImages: false,
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
