/**
 * Renders the block list produced by layout.ts into clean GFM Markdown:
 * heading markers, list markers, GFM tables, and inline link substitution.
 * No blank-line runs beyond one, no trailing whitespace.
 */
import type { Block } from "./layout.js"

export interface LinkAnnotation {
  uri: string
  xStart: number
  xEnd: number
  y: number
}

/**
 * Escapes Markdown metacharacters in text extracted from a PDF. `*` and `_`
 * are deliberately NOT escaped here: layout.ts inserts them itself to mark
 * bold/italic runs it detected from font weight/style, and by the time text
 * reaches this function those markers are already meaningful Markdown, not
 * literal PDF glyphs. A PDF that legitimately contains a bare `*` or `_`
 * character in its body text will render as emphasis — a known, documented
 * tradeoff of recovering bold/italic without a separate out-of-band channel.
 */
function escapeMarkdownInline(text: string): string {
  return text.replace(/([\\`[\]])/g, "\\$1")
}

/** Substitutes a link annotation whose rect matches the line's text into a Markdown link. */
function applyLinks(text: string, y: number, links: LinkAnnotation[]): string {
  const escaped = escapeMarkdownInline(text)
  const match = links.find((l) => Math.abs(l.y - y) < 4)
  if (!match) return escaped
  return `[${escaped}](${match.uri})`
}

export function renderBlocksToMarkdown(blocks: (Block & { y?: number })[], links: LinkAnnotation[] = []): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        parts.push(`${"#".repeat(block.level)} ${applyLinks(block.text, block.y ?? -1, links)}`)
        break
      case "paragraph":
        parts.push(applyLinks(block.text, block.y ?? -1, links))
        break
      case "list": {
        const lines = block.items.map((item, i) =>
          block.ordered ? `${i + 1}. ${escapeMarkdownInline(item)}` : `- ${escapeMarkdownInline(item)}`,
        )
        parts.push(lines.join("\n"))
        break
      }
      case "table": {
        const header = `| ${block.header.map(escapeCell).join(" | ")} |`
        const divider = `| ${block.header.map(() => "---").join(" | ")} |`
        const rows = block.rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
        parts.push([header, divider, ...rows].join("\n"))
        break
      }
    }
  }
  return parts.join("\n\n")
}

function escapeCell(text: string): string {
  return escapeMarkdownInline(text).replace(/\|/g, "\\|")
}

export function joinPages(pageMarkdowns: string[], pageBreaks: "none" | "rule" | "marker"): string {
  const separator = pageBreaks === "rule" ? "\n\n---\n\n" : pageBreaks === "marker" ? "\n\n" : "\n\n"
  const filtered = pageMarkdowns.map((p) => p.trim()).filter(Boolean)
  if (pageBreaks === "marker") {
    return filtered.map((p, i) => `<!-- page ${i + 1} -->\n\n${p}`).join("\n\n").trim() + "\n"
  }
  return filtered.join(separator).replace(/\n{3,}/g, "\n\n").trim() + "\n"
}

export { escapeMarkdownInline }
