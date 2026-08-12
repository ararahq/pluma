import type { DocumentMeta } from "./theme.js"

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/

const META_KEYS = new Set(["title", "author", "date", "subtitle"])

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value[0])
  return quoted ? value.slice(1, -1) : value
}

export interface Frontmatter {
  meta: DocumentMeta
  body: string
  brandPath?: string
}

export function extractFrontmatter(markdown: string): Frontmatter {
  const match = markdown.match(FRONTMATTER_PATTERN)
  if (!match) return { meta: {}, body: markdown }

  const meta: DocumentMeta = {}
  let brandPath: string | undefined
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":")
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    if (!value) continue
    if (key === "brand") brandPath = value
    else if (META_KEYS.has(key)) meta[key as keyof DocumentMeta] = value
  }
  return { meta, body: markdown.slice(match[0].length), brandPath }
}
