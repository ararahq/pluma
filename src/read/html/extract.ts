import { type ElementNode, type Node, findAll, findFirst, parseHtml, textContent } from "./tree.js"

export interface PageMeta {
  url?: string
  canonical?: string
  description?: string
  lang?: string
  author?: string
  published?: string
  modified?: string
  siteName?: string
  image?: string
  jsonLd?: unknown[]
}

export interface ExtractResult {
  title?: string
  meta: PageMeta
  content: ElementNode
  mode: "article" | "page"
}

const NEGATIVE_PATTERN =
  /nav|footer|sidebar|cookie|banner|shar(e|ing)|comment|related|promo|newsletter|modal|advert|breadcrumb|social|subscribe|popup|widget|masthead|menu|pagination|toolbar|disclaimer|consent/i

const POSITIVE_PATTERN = /(^|[\s_-])(content|article|post|entry|main|story)([\s_-]|\d|$)/i

const CANDIDATE_TAGS = new Set(["article", "main", "section", "div", "td"])
const SEMANTIC_TAGS = new Set(["article", "main"])
const STRUCTURAL_STRIP_TAGS = new Set([
  "nav", "footer", "aside", "form", "button", "iframe", "dialog",
  "script", "style", "template", "noscript",
])
const MIN_ARTICLE_SCORE = 80

function classAndId(el: ElementNode): string {
  return `${el.attrs.class ?? ""} ${el.attrs.id ?? ""}`
}

function isSemantic(el: ElementNode): boolean {
  if (SEMANTIC_TAGS.has(el.tag)) return true
  if (el.attrs.role === "main") return true
  if (el.attrs.itemprop === "articleBody") return true
  return false
}

function linkTextLength(el: ElementNode): number {
  return findAll(el, (n) => n.tag === "a").reduce((sum, a) => sum + textContent(a).length, 0)
}

function score(el: ElementNode): number {
  const text = textContent(el).trim()
  const textLength = text.length
  if (textLength < 25) return 0
  const linkLength = linkTextLength(el)
  const linkDensity = linkLength / Math.max(textLength, 1)
  let value = textLength * (1 - Math.min(linkDensity, 0.9))
  const marker = classAndId(el)
  if (POSITIVE_PATTERN.test(marker)) value *= 1.3
  if (NEGATIVE_PATTERN.test(marker)) value *= 0.4
  if (isSemantic(el)) value += 80
  const hasTableOrCode = findAll(el, (n) => n.tag === "table" || n.tag === "pre").length > 0
  if (hasTableOrCode) value += 40
  return value
}

/** Picks the element that best represents the page's primary content. */
export function findMainContent(body: ElementNode): { node: ElementNode; mode: "article" | "page" } {
  const candidates = findAll(body, (el) => CANDIDATE_TAGS.has(el.tag))
  let best: ElementNode | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const s = score(candidate)
    if (s > bestScore) {
      bestScore = s
      best = candidate
    }
  }
  if (best && bestScore >= MIN_ARTICLE_SCORE) {
    return { node: best, mode: "article" }
  }
  return { node: body, mode: "page" }
}

function isEmpty(el: ElementNode): boolean {
  return el.children.every((c) => {
    if (c.type === "text") return c.text.trim() === ""
    if (c.type !== "element") return true
    return isEmpty(c)
  })
}

/** Strips boilerplate (nav/footer/cookie banners/share widgets/etc.) from a
 * content subtree in place, keeping tables and code blocks even when they
 * would otherwise score as low-density noise. */
export function cleanContent(root: ElementNode): void {
  const walk = (el: ElementNode) => {
    el.children = el.children.filter((child) => {
      if (child.type !== "element") return true
      if (STRUCTURAL_STRIP_TAGS.has(child.tag)) return false
      const keepsStructure = findAll(child, (n) => n.tag === "table" || n.tag === "pre").length > 0
      if (!keepsStructure) {
        const marker = classAndId(child)
        if (NEGATIVE_PATTERN.test(marker)) {
          const text = textContent(child).trim()
          const density = linkTextLength(child) / Math.max(text.length, 1)
          if (text.length < 200 || density > 0.5) return false
        }
      }
      walk(child)
      if (isEmpty(child) && !VOID_LIKE.has(child.tag)) return false
      return true
    })
  }
  walk(root)
}

const VOID_LIKE = new Set(["img", "br", "hr", "td", "th"])

function metaContent(root: ElementNode, matcher: (name: string, value: string) => boolean): string | undefined {
  const metas = findAll(root, (el) => el.tag === "meta")
  for (const meta of metas) {
    const name = meta.attrs.name ?? meta.attrs.property ?? ""
    if (matcher(name.toLowerCase(), meta.attrs.content ?? "") && meta.attrs.content) return meta.attrs.content
  }
  return undefined
}

const JSON_LD_PATTERN = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/** Parses every `<script type="application/ld+json">` block from raw HTML.
 * Done directly on source text since script bodies are dropped from the tree. */
export function extractJsonLd(html: string): unknown[] {
  const results: unknown[] = []
  let match: RegExpExecArray | null
  JSON_LD_PATTERN.lastIndex = 0
  while ((match = JSON_LD_PATTERN.exec(html))) {
    const raw = match[1].trim()
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) results.push(...parsed)
      else results.push(parsed)
    } catch {
      continue
    }
  }
  return results
}

function jsonLdString(jsonLd: unknown[], key: string): string | undefined {
  for (const entry of jsonLd) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const value = record[key]
    if (typeof value === "string") return value
    if (key === "author" && value && typeof value === "object") {
      const name = (value as Record<string, unknown>).name
      if (typeof name === "string") return name
    }
  }
  return undefined
}

export function extractMeta(root: ElementNode, html: string, baseUrl?: string): PageMeta {
  const jsonLd = extractJsonLd(html)
  const htmlEl = findFirst(root, (el) => el.tag === "html")
  const canonicalLink = findFirst(root, (el) => el.tag === "link" && el.attrs.rel === "canonical")
  const author =
    metaContent(root, (n) => n === "author" || n === "article:author") ??
    jsonLdString(jsonLd, "author")
  const published =
    metaContent(root, (n) => n === "article:published_time" || n === "og:published_time") ??
    findFirst(root, (el) => el.tag === "time" && Boolean(el.attrs.datetime))?.attrs.datetime ??
    jsonLdString(jsonLd, "datePublished")
  const modified =
    metaContent(root, (n) => n === "article:modified_time" || n === "og:updated_time") ??
    jsonLdString(jsonLd, "dateModified")
  const image = metaContent(root, (n) => n === "og:image" || n === "twitter:image")
  return {
    url: baseUrl,
    canonical: canonicalLink?.attrs.href ? resolveUrl(canonicalLink.attrs.href, baseUrl) : undefined,
    description: metaContent(root, (n) => n === "description" || n === "og:description"),
    lang: htmlEl?.attrs.lang || undefined,
    author,
    published,
    modified,
    siteName: metaContent(root, (n) => n === "og:site_name"),
    image: image ? resolveUrl(image, baseUrl) : undefined,
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
  }
}

export function extractTitle(root: ElementNode, content: ElementNode): string | undefined {
  const ogTitle = metaContent(root, (n) => n === "og:title")
  if (ogTitle) return ogTitle.trim()
  const titleTag = findFirst(root, (el) => el.tag === "title")
  const titleText = titleTag ? textContent(titleTag).trim() : ""
  if (titleText) return titleText
  const h1 = findFirst(content, (el) => el.tag === "h1")
  const h1Text = h1 ? textContent(h1).trim() : ""
  return h1Text || undefined
}

export function resolveUrl(href: string, base?: string): string {
  if (!base) return href
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

export function findBaseHref(root: ElementNode): string | undefined {
  const base = findFirst(root, (el) => el.tag === "base" && Boolean(el.attrs.href))
  return base?.attrs.href
}

export { parseHtml }
export type { ElementNode, Node }
