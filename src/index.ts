import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler"
import { markdownToTypst } from "./md-to-typst.js"
import { extractFrontmatter } from "./frontmatter.js"
import { themes, cleanTheme, createTheme, type Brand, type Theme, type DocumentMeta } from "./theme.js"

export interface RenderOptions {
  theme?: string | Theme
  brand?: Brand
  meta?: DocumentMeta
  fontPaths?: string[]
  root?: string
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
  return resolveTheme(options).preamble(meta).trim() + "\n\n" + markdownToTypst(body)
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

export { markdownToTypst } from "./md-to-typst.js"
export { extractFrontmatter } from "./frontmatter.js"
export { themes, cleanTheme, createTheme, InvalidBrandError } from "./theme.js"
export type { Theme, Brand, DocumentMeta } from "./theme.js"
