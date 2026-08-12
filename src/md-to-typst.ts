import { Lexer, type Token, type Tokens } from "marked"
import { escapeMarkup, escapeString } from "./escape.js"

export function markdownToTypst(markdown: string): string {
  const tokens = Lexer.lex(markdown, { gfm: true })
  return renderTokens(tokens).trim() + "\n"
}

function renderTokens(tokens: Token[]): string {
  return tokens.map(renderToken).join("")
}

function renderToken(token: Token): string {
  switch (token.type) {
    case "heading":
      return renderHeading(token as Tokens.Heading)
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens) + "\n\n"
    case "text":
      return renderText(token as Tokens.Text)
    case "code":
      return renderCode(token as Tokens.Code)
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote)
    case "list":
      return renderList(token as Tokens.List) + "\n"
    case "table":
      return renderTable(token as Tokens.Table)
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
  "pagebreak": "#pagebreak()\n\n",
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

function renderHeading(token: Tokens.Heading): string {
  const level = "=".repeat(Math.min(token.depth, 6))
  return `${level} ${renderInline(token.tokens)}\n\n`
}

function renderText(token: Tokens.Text): string {
  if (token.tokens) return renderInline(token.tokens)
  return escapeMarkup(token.text)
}

function renderCode(token: Tokens.Code): string {
  if (token.lang === "typst") return token.text + "\n\n"
  const lang = token.lang ? `, lang: "${escapeString(token.lang)}"` : ""
  return `#raw(block: true${lang}, "${escapeString(token.text)}")\n\n`
}

function renderBlockquote(token: Tokens.Blockquote): string {
  const body = renderTokens(token.tokens).trim()
  return `#quote(block: true)[${body}]\n\n`
}

function renderList(token: Tokens.List, depth = 0): string {
  const indent = "  ".repeat(depth)
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${Number(token.start || 1) + index}.` : "-"
      const body = renderListItem(item, depth)
      return `${indent}${marker} ${body}`
    })
    .join("")
}

function renderListItem(item: Tokens.ListItem, depth: number): string {
  const parts: string[] = []
  for (const child of item.tokens) {
    if (child.type === "list") {
      parts.push("\n" + renderList(child as Tokens.List, depth + 1))
    } else if (child.type === "text" || child.type === "paragraph") {
      parts.push(renderInline((child as Tokens.Text).tokens ?? []))
    } else {
      parts.push(renderToken(child).trim())
    }
  }
  const text = parts.join(" ").trimEnd()
  return text.endsWith("\n") ? text : text + "\n"
}

function renderTable(token: Tokens.Table): string {
  const columns = token.header.length
  const aligns = token.align
    .map((a) => (a === null ? "left" : a))
    .map((a) => `${a}`)
    .join(", ")
  const header = token.header
    .map((cell) => `[*${renderInline(cell.tokens)}*]`)
    .join(", ")
  const rows = token.rows
    .map((row) => row.map((cell) => `[${renderInline(cell.tokens)}]`).join(", "))
    .join(",\n  ")
  return [
    `#table(`,
    `  columns: ${columns},`,
    `  align: (${aligns}),`,
    `  table.header(${header}),`,
    `  ${rows}`,
    `)`,
    ``,
    ``,
  ].join("\n")
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join("")
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return escapeMarkup((token as Tokens.Text).text)
    case "strong":
      return `*${renderInline((token as Tokens.Strong).tokens)}*`
    case "em":
      return `_${renderInline((token as Tokens.Em).tokens)}_`
    case "del":
      return `#strike[${renderInline((token as Tokens.Del).tokens)}]`
    case "codespan":
      return `#raw("${escapeString((token as Tokens.Codespan).text)}")`
    case "link": {
      const link = token as Tokens.Link
      return `#link("${escapeString(link.href)}")[${renderInline(link.tokens)}]`
    }
    case "image": {
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
