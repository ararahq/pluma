import {
  cleanContent,
  extractMeta,
  extractTitle,
  findBaseHref,
  findMainContent,
  parseHtml,
  resolveUrl,
  type ElementNode,
  type PageMeta,
} from "./extract.js"
import { findAll, findFirst, textContent } from "./tree.js"
import { MarkdownSerializer, truncateToTokens, type LinkEntry } from "./markdown.js"
import { fetchHtml, HtmlFetchError, HtmlLimitError, type FetchHtmlOptions } from "./fetch.js"
import { compileSelector, elementMatches } from "./selector.js"
import { extractByReadability } from "./readability.js"

export interface ReadHtmlOptions {
  baseUrl?: string
  mode?: "article" | "page" | "raw"
  images?: boolean
  links?: boolean
  frontMatter?: boolean
  maxTokens?: number
  keepSelectors?: string[]
  dropSelectors?: string[]
  /** Maximum UTF-16 input characters accepted for direct HTML reads. */
  maxInputChars?: number
  /** Maximum Markdown characters returned before block-boundary truncation. */
  maxOutputChars?: number
  /** Maximum nodes and open-element depth used by the tolerant HTML parser. */
  maxTreeNodes?: number
  maxTreeDepth?: number
  /** Bounds table flattening so hostile colspan/rowspan values cannot amplify output. */
  maxTableRows?: number
  maxTableColumns?: number
  /** Use the Readability-style scorer (default true) as the primary
   * candidate-selection engine for "article" mode. Set false to fall back
   * to pluma's own lighter heuristic (semantic tags + density scoring). */
  readability?: boolean
}

const DEFAULT_MAX_INPUT_CHARS = 20 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_CHARS = 16 * 1024 * 1024

export interface ReadUrlOptions extends ReadHtmlOptions, FetchHtmlOptions {
  maxBytes?: number
}

export interface ReadResult {
  markdown: string
  title?: string
  meta: PageMeta
  links: LinkEntry[]
  wordCount: number
  warnings: string[]
}

function applySelectors(root: ElementNode, keep: string[], drop: string[]): void {
  const dropSelectors = drop.map(compileSelector).flat()
  const keepSelectors = keep.map(compileSelector).flat()
  const shouldDrop = (el: ElementNode): boolean => elementMatches(el, dropSelectors)
  const shouldKeep = (el: ElementNode): boolean => keepSelectors.length === 0 || elementMatches(el, keepSelectors)

  const walk = (el: ElementNode) => {
    el.children = el.children.filter((child) => {
      if (child.type !== "element") return true
      if (shouldDrop(child)) return false
      if (!shouldKeep(child) && keep.length > 0 && findAll(child, (n) => shouldKeep(n)).length === 0) return false
      walk(child)
      return true
    })
  }
  walk(root)
}

function buildFrontMatter(title: string | undefined, meta: PageMeta): string {
  const lines = ["---"]
  if (title) lines.push(`title: ${yamlScalar(title)}`)
  if (meta.url) lines.push(`url: ${yamlScalar(meta.url)}`)
  if (meta.published) lines.push(`date: ${yamlScalar(meta.published)}`)
  lines.push("---")
  return lines.join("\n")
}

function yamlScalar(value: string): string {
  if (/^[\w\s.,!?()/:'-]*$/.test(value) && !value.includes(": ")) return value
  return JSON.stringify(value)
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/** Converts an HTML string into clean, LLM-ready Markdown: extracts the main
 * content (readability-like scoring), resolves metadata, and serializes
 * tables/code/lists/links deterministically. Synchronous, zero runtime deps. */
export function readHtml(html: string, options: ReadHtmlOptions = {}): ReadResult {
  const maxInputChars = positiveLimit(options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS, "maxInputChars")
  const maxOutputChars = positiveLimit(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, "maxOutputChars")
  if (html.length > maxInputChars) {
    throw new HtmlLimitError(`HTML input exceeds maxInputChars (${html.length} > ${maxInputChars})`)
  }
  const warnings: string[] = []
  const root = parseHtml(html, { maxNodes: options.maxTreeNodes, maxDepth: options.maxTreeDepth })
  const baseHref = findBaseHref(root)
  const baseUrl = baseHref ? resolveUrl(baseHref, options.baseUrl) : options.baseUrl

  const bodyEl = findFirst(root, (el) => el.tag === "body") ?? root
  const meta = extractMeta(root, html, baseUrl)

  const useReadability = options.readability !== false
  let byline: string | undefined

  const selectArticle = (): ElementNode => {
    if (useReadability) {
      const result = extractByReadability(bodyEl)
      if (result) {
        byline = result.byline
        return result.content
      }
    }
    return findMainContent(bodyEl).node
  }

  let contentNode: ElementNode
  if (options.mode === "raw") {
    contentNode = bodyEl
  } else if (options.mode === "page") {
    contentNode = bodyEl
    cleanContent(contentNode)
  } else if (options.mode === "article") {
    contentNode = selectArticle()
    cleanContent(contentNode)
  } else {
    const before = bodyEl
    contentNode = selectArticle()
    cleanContent(contentNode)
    if (contentNode === before) warnings.push("No article-like candidate scored high enough; used page mode fallback.")
  }

  if (options.keepSelectors?.length || options.dropSelectors?.length) {
    applySelectors(contentNode, options.keepSelectors ?? [], options.dropSelectors ?? [])
  }

  const title = extractTitle(root, contentNode)
  const serializer = new MarkdownSerializer({
    baseUrl,
    images: options.images,
    links: options.links,
    maxOutputChars,
    maxTableRows: options.maxTableRows,
    maxTableColumns: options.maxTableColumns,
  })
  const { markdown: body, links, truncated: outputTruncated } = serializer.serializeDocument(contentNode)
  if (outputTruncated) warnings.push(`Markdown output truncated to maxOutputChars (${maxOutputChars}).`)

  let markdown = body
  if (options.maxTokens) {
    const truncated = truncateToTokens(markdown, options.maxTokens)
    if (truncated.length < markdown.length) warnings.push(`Truncated to ~${options.maxTokens} tokens.`)
    markdown = truncated
  }
  if (options.frontMatter) {
    markdown = `${buildFrontMatter(title, { ...meta, url: baseUrl })}\n\n${markdown}`
  }
  if (markdown.length > maxOutputChars) {
    markdown = truncateToChars(markdown, maxOutputChars)
    if (!warnings.some((warning) => warning.includes("maxOutputChars"))) {
      warnings.push(`Markdown output truncated to maxOutputChars (${maxOutputChars}).`)
    }
  }

  return {
    markdown,
    title,
    meta: { ...meta, url: baseUrl, author: meta.author ?? byline },
    links,
    wordCount: countWords(textContent(contentNode)),
    warnings,
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HtmlLimitError(`${name} must be a positive integer`)
  return value
}

function truncateToChars(markdown: string, maxChars: number): string {
  if (maxChars === 1) return "\n"
  const truncated = markdown.slice(0, maxChars - 1)
  const boundary = truncated.lastIndexOf("\n\n")
  return (boundary > 0 ? truncated.slice(0, boundary) : truncated).trimEnd() + "\n"
}

/** Fetches a URL and converts it to Markdown via {@link readHtml}. */
export async function readUrl(url: string, options: ReadUrlOptions = {}): Promise<ReadResult> {
  const fetched = await fetchHtml(url, options)
  return readHtml(fetched.html, { ...options, baseUrl: options.baseUrl ?? fetched.url })
}

export { HtmlFetchError, HtmlLimitError }
export type { FetchDnsAddress, FetchDnsResolver, FetchUrlPolicy, FetchUrlPolicyContext } from "./fetch.js"
export type { LinkEntry } from "./markdown.js"
export type { PageMeta } from "./extract.js"
