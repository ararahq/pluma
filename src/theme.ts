import { escapeString } from "./escape.js"

export interface DocumentMeta {
  title?: string
  author?: string
  date?: string
  subtitle?: string
}

export interface Brand {
  fonts?: {
    body?: string
    heading?: string
    mono?: string
    size?: number
  }
  colors?: {
    text?: string
    muted?: string
    faint?: string
    accent?: string
    link?: string
    border?: string
    codeBackground?: string
  }
  page?: {
    paper?: string
    marginX?: string
    marginY?: string
  }
  logo?: {
    path: string
    width?: string
  }
  footer?: string
}

export interface Theme {
  name: string
  preamble: (meta: DocumentMeta) => string
}

const DEFAULTS = {
  fonts: { size: 10.5 },
  colors: {
    text: "#18181b",
    muted: "#71717a",
    faint: "#a1a1aa",
    accent: "#18181b",
    link: "#0e7490",
    border: "#d4d4d8",
    codeBackground: "#f4f4f5",
  },
  page: { paper: "a4", marginX: "2.2cm", marginY: "2.4cm" },
  logoWidth: "2.8cm",
} as const

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/
const PAPER_NAME = /^[a-z0-9-]+$/
const LENGTH = /^[0-9.]+(pt|mm|cm|in|em)$/

export class InvalidBrandError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid brand value for ${field}: "${value}"`)
    this.name = "InvalidBrandError"
  }
}

function color(field: string, value: string): string {
  if (!HEX_COLOR.test(value)) throw new InvalidBrandError(field, value)
  return `rgb("${value}")`
}

function length(field: string, value: string): string {
  if (!LENGTH.test(value)) throw new InvalidBrandError(field, value)
  return value
}

function fontList(font: string): string {
  return `"${escapeString(font)}"`
}

export function createTheme(brand: Brand = {}, name = "custom"): Theme {
  const colors = { ...DEFAULTS.colors, ...brand.colors }
  const page = { ...DEFAULTS.page, ...brand.page }
  const size = brand.fonts?.size ?? DEFAULTS.fonts.size

  if (!PAPER_NAME.test(page.paper)) throw new InvalidBrandError("page.paper", page.paper)

  const c = {
    text: color("colors.text", colors.text),
    muted: color("colors.muted", colors.muted),
    faint: color("colors.faint", colors.faint),
    accent: color("colors.accent", colors.accent),
    link: color("colors.link", colors.link),
    border: color("colors.border", colors.border),
    codeBackground: color("colors.codeBackground", colors.codeBackground),
  }

  const bodyFont = brand.fonts?.body ? `font: ${fontList(brand.fonts.body)}, ` : ""
  const headingFont = brand.fonts?.heading ?? brand.fonts?.body
  const headingFontRule = headingFont
    ? `#show heading: set text(font: ${fontList(headingFont)})`
    : ""
  const monoFontRule = brand.fonts?.mono
    ? `#show raw: set text(font: ${fontList(brand.fonts.mono)})`
    : ""

  return {
    name,
    preamble: (meta) => `
#set page(
  paper: "${page.paper}",
  margin: (x: ${length("page.marginX", page.marginX)}, y: ${length("page.marginY", page.marginY)}),
  footer: context grid(
    columns: (1fr, auto),
    align(left, text(size: 8pt, fill: ${c.faint}, "${escapeString(brand.footer ?? "")}")),
    align(right, text(size: 8pt, fill: ${c.faint}, counter(page).display("1"))),
  ),
)
#set text(${bodyFont}size: ${size}pt, fill: ${c.text})
#set par(justify: true, leading: 0.72em, spacing: 1.15em)
#set heading(numbering: none)
#show heading.where(level: 1): set text(size: 17pt, weight: 700)
#show heading.where(level: 2): set text(size: 13pt, weight: 700)
#show heading.where(level: 3): set text(size: 11pt, weight: 700)
#show heading: set block(above: 1.6em, below: 0.8em)
${headingFontRule}
${monoFontRule}
#let divider() = line(length: 100%, stroke: 0.5pt + ${c.border})

#show raw.where(block: true): it => block(
  width: 100%,
  fill: ${c.codeBackground},
  radius: 4pt,
  inset: 10pt,
  text(size: 8.5pt, it),
)
#show raw.where(block: false): it => box(
  fill: ${c.codeBackground},
  radius: 2pt,
  inset: (x: 3pt, y: 0pt),
  outset: (y: 3pt),
  it,
)
#show quote.where(block: true): it => block(
  width: 100%,
  stroke: (left: 2pt + ${c.border}),
  inset: (left: 12pt, y: 4pt),
  emph(it.body),
)
#show table: set table(
  stroke: (x, y) => if y == 0 { (bottom: 1pt + ${c.text}) } else { (bottom: 0.5pt + ${c.border}) },
  inset: 8pt,
)
#show link: set text(fill: ${c.link})

${titleBlock(meta, brand, c)}
`,
  }
}

function titleBlock(
  meta: DocumentMeta,
  brand: Brand,
  c: Record<"faint" | "muted" | "accent", string>,
): string {
  const lines: string[] = []
  if (brand.logo) {
    const width = length("logo.width", brand.logo.width ?? DEFAULTS.logoWidth)
    lines.push(`#image("${escapeString(brand.logo.path)}", width: ${width})`, `#v(14pt)`)
  }
  if (!meta.title) return lines.join("\n")

  lines.push(`#block(spacing: 0pt)[`, `  #text(size: 24pt, weight: 700, "${escapeString(meta.title)}")`)
  if (meta.subtitle) {
    lines.push(`  #v(6pt)`, `  #text(size: 12pt, fill: ${c.muted}, "${escapeString(meta.subtitle)}")`)
  }
  if (meta.author || meta.date) {
    const byline = [meta.author, meta.date].filter(Boolean).join(" · ")
    lines.push(`  #v(10pt)`, `  #text(size: 9pt, fill: ${c.faint}, "${escapeString(byline)}")`)
  }
  lines.push(`  #v(8pt)`, `  #line(length: 100%, stroke: 2pt + ${c.accent})`, `]`, `#v(18pt)`)
  return lines.join("\n")
}

export const cleanTheme: Theme = createTheme({}, "clean")

export const themes: Record<string, Theme> = {
  clean: cleanTheme,
}
