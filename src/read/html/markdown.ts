import type { ElementNode, Node } from "./tree.js"
import { resolveUrl } from "./extract.js"

export interface MarkdownOptions {
  baseUrl?: string
  images?: boolean
  links?: boolean
  maxOutputChars?: number
  maxTableRows?: number
  maxTableColumns?: number
}

export interface LinkEntry {
  href: string
  text: string
}

export interface MarkdownResult {
  markdown: string
  links: LinkEntry[]
  truncated?: boolean
}

const DEFAULT_MAX_OUTPUT_CHARS = 16 * 1024 * 1024
const DEFAULT_MAX_TABLE_ROWS = 10_000
const DEFAULT_MAX_TABLE_COLUMNS = 256

const INLINE_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "code", "span",
  "small", "sub", "sup", "abbr", "cite", "q", "mark", "time", "kbd", "samp", "var",
])

/** Never contributes visible Markdown, regardless of extraction mode. */
const NEVER_RENDER_TAGS = new Set(["script", "style", "template", "noscript", "head", "title"])

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ")
}

class HeadingLevelMapper {
  private stack: { orig: number; assigned: number }[] = []

  map(orig: number): number {
    while (this.stack.length > 0 && this.stack[this.stack.length - 1].orig >= orig) this.stack.pop()
    const assigned = this.stack.length === 0 ? 1 : this.stack[this.stack.length - 1].assigned + 1
    this.stack.push({ orig, assigned })
    return Math.min(assigned, 6)
  }
}

const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

function languageFromCode(el: ElementNode): string {
  const cls = el.attrs.class ?? ""
  const match =
    /(?:^|\s)language-([\w-]+)/.exec(cls) ??
    /(?:^|\s)lang-([\w-]+)/.exec(cls) ??
    /(?:^|\s)hljs-([\w-]+)/.exec(cls)
  if (match) return match[1]
  if (el.attrs["data-lang"]) return el.attrs["data-lang"]
  return ""
}

function findChild(el: ElementNode, tag: string): ElementNode | undefined {
  return el.children.find((c): c is ElementNode => c.type === "element" && c.tag === tag)
}

/** Serializes a cleaned content tree into GFM Markdown. Deterministic:
 * no triple blank lines, headings never skip a level, links resolve
 * against baseUrl. */
export class MarkdownSerializer {
  private readonly options: MarkdownOptions
  private readonly headingMapper = new HeadingLevelMapper()
  private readonly links: LinkEntry[] = []
  private readonly maxOutputChars: number
  private readonly maxTableRows: number
  private readonly maxTableColumns: number

  constructor(options: MarkdownOptions = {}) {
    this.options = options
    this.maxOutputChars = positiveLimit(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, "maxOutputChars")
    this.maxTableRows = positiveLimit(options.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS, "maxTableRows")
    this.maxTableColumns = positiveLimit(options.maxTableColumns ?? DEFAULT_MAX_TABLE_COLUMNS, "maxTableColumns")
  }

  serializeDocument(root: ElementNode): MarkdownResult {
    const blocks = this.renderChildren(root, 0)
    const rendered = normalizeBlankLines(blocks.join("\n\n")).trim() + "\n"
    const truncated = rendered.length > this.maxOutputChars
    const markdown = truncated ? truncateMarkdownChars(rendered, this.maxOutputChars) : rendered
    return { markdown, links: this.links, truncated: truncated || undefined }
  }

  private renderChildren(el: ElementNode, depth: number): string[] {
    const blocks: string[] = []
    for (const child of el.children) {
      const rendered = this.renderBlock(child, depth)
      if (rendered !== undefined && rendered !== "") blocks.push(rendered)
    }
    return blocks
  }

  private renderBlock(node: Node, depth: number): string | undefined {
    if (node.type === "text") {
      const text = collapseWhitespace(node.text).trim()
      return text || undefined
    }
    if (node.type !== "element") return undefined
    const el = node
    if (NEVER_RENDER_TAGS.has(el.tag)) return undefined
    if (el.tag in HEADING_TAGS) {
      const level = this.headingMapper.map(HEADING_TAGS[el.tag])
      const text = this.renderInline(el)
      return text ? `${"#".repeat(level)} ${text}` : undefined
    }
    switch (el.tag) {
      case "p":
        return this.renderInline(el) || undefined
      case "br":
      case "hr":
        return "---"
      case "blockquote": {
        const inner = this.renderChildren(el, depth).join("\n\n")
        return inner
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")
      }
      case "pre":
        return this.renderPre(el)
      case "ul":
      case "ol":
        return this.renderList(el, depth)
      case "table":
        return this.renderTable(el)
      case "dl":
        return this.renderDefinitionList(el)
      case "figure":
        return this.renderFigure(el)
      case "details":
        return this.renderDetails(el)
      case "img":
        return this.renderImage(el) || undefined
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "footer":
      case "body":
      case "#root":
        return this.renderChildren(el, depth).join("\n\n") || undefined
      default:
        if (INLINE_TAGS.has(el.tag)) return this.renderInline(el) || undefined
        return this.renderChildren(el, depth).join("\n\n") || undefined
    }
  }

  private renderPre(el: ElementNode): string {
    const codeEl = findChild(el, "code")
    const lang = codeEl ? languageFromCode(codeEl) : languageFromCode(el)
    const text = rawText(codeEl ?? el).replace(/\n+$/, "")
    const fence = "```"
    return `${fence}${lang}\n${text}\n${fence}`
  }

  private renderList(el: ElementNode, depth: number, ordered = el.tag === "ol"): string {
    const start = Number.parseInt(el.attrs.start ?? "1", 10) || 1
    const items = el.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "li")
    const lines: string[] = []
    items.forEach((item, index) => {
      const marker = ordered ? `${start + index}.` : "-"
      const nested = item.children.filter(
        (c): c is ElementNode => c.type === "element" && (c.tag === "ul" || c.tag === "ol"),
      )
      const inlineChildren = item.children.filter((c) => !(c.type === "element" && (c.tag === "ul" || c.tag === "ol")))
      const text = this.renderInlineNodes(inlineChildren).trim()
      const indent = "  ".repeat(depth)
      lines.push(`${indent}${marker} ${text}`)
      for (const list of nested) {
        const nestedText = this.renderList(list, depth + 1, list.tag === "ol")
        lines.push(nestedText)
      }
    })
    return lines.join("\n")
  }

  private renderTable(el: ElementNode): string {
    const thead = findChild(el, "thead")
    const bodies = el.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "tbody")
    const allRows: ElementNode[] = []
    if (thead) allRows.push(...thead.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "tr"))
    for (const body of bodies) {
      allRows.push(...body.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "tr"))
    }
    if (allRows.length === 0) {
      allRows.push(...el.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "tr"))
    }
    if (allRows.length === 0) return ""

    const boundedRows = allRows.slice(0, this.maxTableRows)
    const activeRowspans: number[] = []
    const expandRow = (row: ElementNode): string[] => {
      const cells: string[] = new Array(this.maxTableColumns)
      const occupied = activeRowspans.map((remaining) => remaining > 0)
      for (let i = 0; i < activeRowspans.length; i++) {
        if (activeRowspans[i] > 0) activeRowspans[i]--
      }
      let column = 0
      for (const cell of row.children) {
        if (cell.type !== "element" || (cell.tag !== "td" && cell.tag !== "th")) continue
        while (column < this.maxTableColumns && occupied[column]) {
          cells[column] = ""
          column++
        }
        if (column >= this.maxTableColumns) break
        const colspan = boundedSpan(cell.attrs.colspan, this.maxTableColumns - column)
        const rowspan = boundedSpan(cell.attrs.rowspan, this.maxTableRows)
        const text = this.renderInline(cell).replace(/\|/g, "\\|").trim()
        for (let offset = 0; offset < colspan && column < this.maxTableColumns; offset++, column++) {
          cells[column] = offset === 0 ? text : ""
          if (rowspan > 1) activeRowspans[column] = Math.max(activeRowspans[column] ?? 0, rowspan - 1)
        }
      }
      for (let i = 0; i < occupied.length && i < this.maxTableColumns; i++) {
        if (occupied[i] && cells[i] === undefined) cells[i] = ""
      }
      let last = cells.length - 1
      while (last >= 0 && cells[last] === undefined) last--
      return cells.slice(0, last + 1).map((cell) => cell ?? "")
    }

    const headerRow = boundedRows[0]
    const headerCells = expandRow(headerRow)
    const bodyRows = boundedRows.slice(1).map(expandRow)
    const columnCount = Math.min(
      this.maxTableColumns,
      Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 1),
    )
    const pad = (row: string[]): string[] => {
      const copy = row.slice(0, columnCount)
      while (copy.length < columnCount) copy.push("")
      return copy
    }

    const lines = [
      `| ${pad(headerCells).join(" | ")} |`,
      `| ${pad(headerCells).map(() => "---").join(" | ")} |`,
      ...bodyRows.map((row) => `| ${pad(row).join(" | ")} |`),
    ]
    return lines.join("\n")
  }

  private renderDefinitionList(el: ElementNode): string {
    const lines: string[] = []
    for (const child of el.children) {
      if (child.type !== "element") continue
      if (child.tag === "dt") lines.push(`**${this.renderInline(child)}**`)
      else if (child.tag === "dd") lines.push(`: ${this.renderInline(child)}`)
    }
    return lines.join("\n\n")
  }

  private renderFigure(el: ElementNode): string {
    const img = findFirstDescendant(el, "img")
    const figcaption = findChild(el, "figcaption")
    const parts: string[] = []
    if (img) {
      const rendered = this.renderImage(img)
      if (rendered) parts.push(rendered)
    }
    if (figcaption) {
      const caption = this.renderInline(figcaption).trim()
      if (caption) parts.push(`*${caption}*`)
    }
    return parts.join("\n\n")
  }

  private renderDetails(el: ElementNode): string {
    const summary = findChild(el, "summary")
    const rest = el.children.filter((c) => c !== summary)
    const summaryText = summary ? this.renderInline(summary).trim() : ""
    const bodyBlocks = rest.map((c) => this.renderBlock(c, 0)).filter((b): b is string => Boolean(b))
    return [summaryText ? `**${summaryText}**` : "", ...bodyBlocks].filter(Boolean).join("\n\n")
  }

  private renderImage(el: ElementNode): string {
    if (this.options.images === false) return ""
    const src = el.attrs.src ?? ""
    if (!src) return ""
    const alt = el.attrs.alt ?? ""
    const href = resolveUrl(src, this.options.baseUrl)
    return `![${collapseWhitespace(alt).trim()}](${href})`
  }

  private renderInline(el: ElementNode): string {
    return this.renderInlineNodes(el.children)
  }

  private renderInlineNodes(nodes: Node[]): string {
    return nodes.map((n) => this.renderInlineNode(n)).join("").trim().replace(/[ \t]+/g, " ")
  }

  private renderInlineNode(node: Node): string {
    if (node.type === "text") return collapseWhitespace(node.text)
    if (node.type !== "element" || NEVER_RENDER_TAGS.has(node.tag)) return ""
    const el = node
    switch (el.tag) {
      case "br":
        return "  \n"
      case "strong":
      case "b": {
        const inner = this.renderInlineNodes(el.children)
        return inner ? `**${inner}**` : ""
      }
      case "em":
      case "i": {
        const inner = this.renderInlineNodes(el.children)
        return inner ? `_${inner}_` : ""
      }
      case "s":
      case "strike":
      case "del": {
        const inner = this.renderInlineNodes(el.children)
        return inner ? `~~${inner}~~` : ""
      }
      case "code":
        return `\`${rawText(el).trim()}\``
      case "a": {
        const text = this.renderInlineNodes(el.children).trim() || el.attrs.href || ""
        if (this.options.links === false || !el.attrs.href) return text
        const href = resolveUrl(el.attrs.href, this.options.baseUrl)
        this.links.push({ href, text })
        return `[${text}](${href})`
      }
      case "img":
        return this.renderImage(el)
      case "sup":
        return `^${this.renderInlineNodes(el.children)}^`
      case "sub":
        return `~${this.renderInlineNodes(el.children)}~`
      default:
        return this.renderInlineNodes(el.children)
    }
  }
}

function rawText(node: Node): string {
  if (node.type === "text") return node.text
  if (node.type !== "element") return ""
  return node.children.map(rawText).join("")
}

function findFirstDescendant(el: ElementNode, tag: string): ElementNode | undefined {
  for (const child of el.children) {
    if (child.type === "element") {
      if (child.tag === tag) return child
      const found = findFirstDescendant(child, tag)
      if (found) return found
    }
  }
  return undefined
}

function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n")
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function boundedSpan(value: string | undefined, maximum: number): number {
  const parsed = Number.parseInt(value ?? "1", 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 1
  return Math.min(parsed, maximum)
}

function truncateMarkdownChars(markdown: string, maxChars: number): string {
  if (maxChars === 1) return "\n"
  const truncated = markdown.slice(0, maxChars - 1)
  const boundary = truncated.lastIndexOf("\n\n")
  return (boundary > 0 ? truncated.slice(0, boundary) : truncated).trimEnd() + "\n"
}

const CHARS_PER_TOKEN = 4

/** Truncates markdown to roughly maxTokens tokens, cutting at the nearest
 * preceding blank-line block boundary so structure stays intact. */
export function truncateToTokens(markdown: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (markdown.length <= maxChars) return markdown
  const truncated = markdown.slice(0, maxChars)
  const lastBoundary = truncated.lastIndexOf("\n\n")
  return (lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated).trimEnd() + "\n"
}
