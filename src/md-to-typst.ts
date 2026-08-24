import { Lexer, type Token, type Tokens } from "marked"
import { escapeMarkup, escapeString } from "./escape.js"

export interface MarkdownToTypstOptions {
  allowRawTypst?: boolean
  allowImages?: boolean
}

export class DisabledMarkdownFeatureError extends Error {
  constructor(readonly feature: "raw_typst" | "image") {
    super(feature === "raw_typst" ? "Raw Typst blocks are disabled" : "Markdown images are disabled")
    this.name = "DisabledMarkdownFeatureError"
  }
}

export function markdownToTypst(markdown: string, options: MarkdownToTypstOptions = {}): string {
  const tokens = Lexer.lex(markdown, { gfm: true })
  return renderTokens(tokens, options).trim() + "\n"
}

function renderTokens(tokens: Token[], options: MarkdownToTypstOptions): string {
  return tokens.map((token) => renderToken(token, options)).join("")
}

function renderToken(token: Token, options: MarkdownToTypstOptions): string {
  switch (token.type) {
    case "heading":
      return renderHeading(token as Tokens.Heading, options)
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens, options) + "\n\n"
    case "text":
      return renderText(token as Tokens.Text, options)
    case "code":
      return renderCode(token as Tokens.Code, options)
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, options)
    case "list":
      return renderList(token as Tokens.List, options) + "\n"
    case "table":
      return renderTable(token as Tokens.Table, options)
    case "hr":
      return "#divider()\n\n"
    case "space":
      return ""
    case "html":
      return renderDirective((token as Tokens.HTML).text)
    default:
      return "raw" in token ? escapeMarkup(String(token.raw)) : ""
  }
}

const DIRECTIVES: Record<string, string> = {
  pagebreak: "#pagebreak()\n\n",
  "/columns": "]\n\n",
}

const COLUMNS_DIRECTIVE = /^columns:([1-4])$/

function renderDirective(html: string): string {
  const match = html.match(/^<!--\s*([a-z-/]+(?::[0-9]+)?)\s*-->\s*$/)
  if (!match) return ""
  const columns = match[1].match(COLUMNS_DIRECTIVE)
  if (columns) return `#columns(${columns[1]}, gutter: 16pt)[\n`
  return DIRECTIVES[match[1]] ?? ""
}

function renderHeading(token: Tokens.Heading, options: MarkdownToTypstOptions): string {
  const level = "=".repeat(Math.min(token.depth, 6))
  return `${level} ${renderInline(token.tokens, options)}\n\n`
}

function renderText(token: Tokens.Text, options: MarkdownToTypstOptions): string {
  if (token.tokens) return renderInline(token.tokens, options)
  return escapeMarkup(token.text)
}

function renderCode(token: Tokens.Code, options: MarkdownToTypstOptions): string {
  const language = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (language === "typst") {
    if (options.allowRawTypst === false) throw new DisabledMarkdownFeatureError("raw_typst")
    return token.text + "\n\n"
  }
  const lang = token.lang ? `, lang: "${escapeString(token.lang)}"` : ""
  return `#raw(block: true${lang}, "${escapeString(token.text)}")\n\n`
}

function renderBlockquote(token: Tokens.Blockquote, options: MarkdownToTypstOptions): string {
  const body = renderTokens(token.tokens, options).trim()
  return `#quote(block: true)[${body}]\n\n`
}

function renderList(token: Tokens.List, options: MarkdownToTypstOptions, depth = 0): string {
  const indent = "  ".repeat(depth)
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${Number(token.start || 1) + index}.` : "-"
      const body = renderListItem(item, options, depth)
      return `${indent}${marker} ${body}`
    })
    .join("")
}

function renderListItem(item: Tokens.ListItem, options: MarkdownToTypstOptions, depth: number): string {
  const parts: string[] = []
  for (const child of item.tokens) {
    if (child.type === "list") {
      parts.push("\n" + renderList(child as Tokens.List, options, depth + 1))
    } else if (child.type === "text" || child.type === "paragraph") {
      parts.push(renderInline((child as Tokens.Text).tokens ?? [], options))
    } else {
      parts.push(renderToken(child, options).trim())
    }
  }
  const text = parts.join(" ").trimEnd()
  return text.endsWith("\n") ? text : text + "\n"
}

function renderTable(token: Tokens.Table, options: MarkdownToTypstOptions): string {
  const columns = token.header.length
  const aligns = token.align
    .map((alignment) => (alignment === null ? "left" : alignment))
    .map((alignment) => `${alignment}`)
    .join(", ")
  const header = token.header
    .map((cell) => `[*${renderInline(cell.tokens, options)}*]`)
    .join(", ")
  const rows = token.rows
    .map((row) => row.map((cell) => `[${renderInline(cell.tokens, options)}]`).join(", "))
    .join(",\n  ")
  return [
    "#table(",
    `  columns: ${columns},`,
    `  align: (${aligns}),`,
    `  table.header(${header}),`,
    `  ${rows}`,
    ")",
    "",
    "",
  ].join("\n")
}

function renderInline(tokens: Token[], options: MarkdownToTypstOptions): string {
  return tokens.map((token) => renderInlineToken(token, options)).join("")
}

function renderInlineToken(token: Token, options: MarkdownToTypstOptions): string {
  switch (token.type) {
    case "text":
      return escapeMarkup((token as Tokens.Text).text)
    case "strong":
      return `*${renderInline((token as Tokens.Strong).tokens, options)}*`
    case "em":
      return `_${renderInline((token as Tokens.Em).tokens, options)}_`
    case "del":
      return `#strike[${renderInline((token as Tokens.Del).tokens, options)}]`
    case "codespan":
      return `#raw("${escapeString((token as Tokens.Codespan).text)}")`
    case "link": {
      const link = token as Tokens.Link
      return `#link("${escapeString(link.href)}")[${renderInline(link.tokens, options)}]`
    }
    case "image": {
      if (options.allowImages === false) throw new DisabledMarkdownFeatureError("image")
      const image = token as Tokens.Image
      return `#image("${escapeString(image.href)}")`
    }
    case "br":
      return " \\\n"
    case "escape":
      return escapeMarkup((token as Tokens.Escape).text)
    case "html":
      return ""
    default:
      return "raw" in token ? escapeMarkup(String(token.raw)) : ""
  }
}
