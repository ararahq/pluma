/**
 * Layout reconstruction: turns a flat bag of positioned glyphs (device space,
 * y growing upward as in PDF) into an ordered sequence of blocks — headings,
 * paragraphs, list items, tables — the way a human would read the page.
 * Strategy: cluster glyphs into lines by baseline (y), split multi-column
 * pages by an x-gap histogram (a simplified XY-cut: one vertical cut per
 * page, which covers the common 2-column case honestly and is documented as
 * a known limitation for anything more complex), merge lines into
 * paragraphs, detect list markers, detect table-like grids of short aligned
 * lines, and classify heading level from a page-wide font-size clustering
 * (not a fixed threshold).
 */
import type { PositionedGlyph } from "./content.js"

export interface LineBox {
  y: number
  xStart: number
  xEnd: number
  /** Rendered text, with bold/italic Markdown markers already inserted. */
  text: string
  /**
   * Same content with style markers stripped. Every structural pattern match
   * (bullet/numbered-list markers, hierarchical section numbers, all-caps
   * detection, table column gaps) must run against this field, never
   * against `text` — a bold run starting at column 0 begins with "**",
   * and "*" is also a valid bullet character, so matching against the
   * styled text turns "**Section Title**" into a false bullet list item.
   */
  plain: string
  fontSize: number
  bold: boolean
  italic: boolean
}

export type Block =
  | { kind: "heading"; level: number; text: string; y: number }
  | { kind: "paragraph"; text: string; y: number }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }

const LINE_Y_TOLERANCE = 2.2
// Real space glyphs are present in the overwhelming majority of PDFs (the
// producer emits an actual space character), so this factor is only a
// fallback for the rarer case of a font with no space glyph in its subset.
// It must stay well above the widest common glyph advance relative to font
// size (an "m" or "w" can advance ~0.7-0.8x the font size on its own) or it
// starts inserting spurious spaces inside ordinary words.
const WORD_GAP_FACTOR = 1.05

export function glyphsToLines(glyphs: PositionedGlyph[]): LineBox[] {
  if (glyphs.length === 0) return []
  // Glyphs arrive in content-stream emission order, which is already the
  // correct reading order within a line (Typst — and virtually every writer —
  // draws left to right). We only need to bucket them by baseline; sorting by
  // x here would silently corrupt word order whenever kerning/justification
  // makes two glyphs' x-coordinates non-monotonic (common with tight kerning
  // or subscript/superscript runs), so each row keeps its natural order.
  const rows: PositionedGlyph[][] = []
  for (const glyph of glyphs) {
    const row = rows.find((r) => Math.abs(r[r.length - 1].y - glyph.y) <= LINE_Y_TOLERANCE)
    if (row) row.push(glyph)
    else rows.push([glyph])
  }
  rows.sort((a, b) => b[0].y - a[0].y)

  const lines: LineBox[] = []
  for (const row of rows) {
    let text = ""
    let prev: PositionedGlyph | undefined
    let minX = row[0].x
    let maxX = row[0].x
    let maxSize = 0
    let boldCount = 0
    let italicCount = 0
    let openBold = false
    let openItalic = false
    const closeMarkers = () => {
      // Trim any trailing space gathered *inside* the styled span before
      // closing it — Markdown emphasis markers must hug the text
      // ("**word** " not "**word **"). This must only run when a marker is
      // actually about to close: closeMarkers() is also called when a run
      // is merely *opening* (going from plain text into bold/italic), and
      // in that case the preceding space is a real word-boundary space
      // between two differently-styled words ("modalidade **PREGÃO") that
      // must be kept, not swallowed.
      if (openItalic || openBold) text = text.replace(/ +$/, "")
      // Italic marker must close before bold's when both are open (proper
      // nesting: **_x_** not **_x**_) and vice versa on open.
      if (openItalic) { text += "_"; openItalic = false }
      if (openBold) { text += "**"; openBold = false }
    }
    for (const g of row) {
      // Whitespace-only glyphs never carry meaningful style info (a space
      // glyph is frequently reported non-bold even mid-bold-run by some
      // producers) — skip style transitions on them so a bold run isn't
      // split into "**word** **word**" by every space inside it.
      const isWhitespace = g.text.trim() === ""
      const stylesDiffer = g.bold !== openBold || g.italic !== openItalic
      // Closing punctuation never has a space before it in normal prose —
      // without this guard, a comma/period/closing-bracket's own (often
      // slightly wider, kerning-adjusted) glyph advance can trip the gap
      // heuristics below and inject a bogus " ," or " ." mid-sentence.
      const isLeadingPunctuation = /^[,.;:!?)\]}»""'']/u.test(g.text)
      if (prev) {
        const gap = g.x - prev.x
        const threshold = Math.max(prev.fontSize, 1) * WORD_GAP_FACTOR
        // A gap wide enough to be a column separator (not just a word space)
        // is recorded as a double space so the table heuristic downstream can
        // tell "table cell boundary" apart from "word boundary" — collapsing
        // everything to a single space here would destroy that signal.
        if (gap > threshold * 1.8 && !text.endsWith("  ") && g.text !== " " && !isLeadingPunctuation) text += "  "
        else if (gap > threshold && !text.endsWith(" ") && g.text !== " " && !isLeadingPunctuation) text += " "
        else if (
          !isWhitespace &&
          stylesDiffer &&
          !isLeadingPunctuation &&
          gap > Math.max(prev.fontSize, 1) * 0.2 &&
          !text.endsWith(" ") &&
          g.text !== " "
        ) {
          // A bold/italic run boundary is a much more reliable word-break
          // signal than plain text: right at the point styles change, even
          // a gap well below the general word-gap threshold (real spaces
          // measured across a style change often come in narrower, e.g.
          // "modalidade" -> bold "PREGÃO" losing the space entirely without
          // this) is very likely a genuine space the general heuristic
          // would otherwise miss, gluing "modalidade**PREGÃO**" together —
          // besides being wrong, CommonMark also requires whitespace (or
          // punctuation) outside `**`/`_` delimiters to render as emphasis
          // at all, so an unwanted glued boundary can silently fail to
          // render as bold/italic in some renderers too.
          text += " "
        }
      }
      if (!isWhitespace && stylesDiffer) {
        // A trailing space at this point, while a style is still open, is
        // the real separator to the NEXT word (its own glyph was reported
        // in the closing run's style, which is how most producers emit the
        // space between a styled word and the next) — closeMarkers() must
        // strip it from *before* the closing delimiter (CommonMark: "word**"
        // not "word **"), but it cannot just vanish. Move it to *after* the
        // delimiter instead ("**word** next", not "**word**next").
        const hadRealSeparator = (openBold || openItalic) && / $/.test(text) && !isLeadingPunctuation
        closeMarkers()
        if (hadRealSeparator) text += " "
        if (g.bold) { text += "**"; openBold = true }
        if (g.italic) { text += "_"; openItalic = true }
      }
      text += g.text
      if (g.fontSize > maxSize) maxSize = g.fontSize
      if (g.bold) boldCount++
      if (g.italic) italicCount++
      if (g.x < minX) minX = g.x
      if (g.x > maxX) maxX = g.x
      prev = g
    }
    closeMarkers()
    text = collapseSpacedOutLetters(text.replace(/ {3,}/g, "  ").replace(/\s+$/, "").replace(/^\s+/, ""))
    text = text.replace(/\*\*\s+\*\*/g, " ").replace(/_\s+_/g, " ") // empty runs left by trailing whitespace
    const plain = stripStyleMarkers(text)
    if (!plain || /^[_\-–—\s]{6,}$/.test(plain)) continue
    lines.push({
      y: row[0].y,
      xStart: minX,
      xEnd: maxX,
      text,
      plain,
      fontSize: maxSize,
      bold: boldCount > row.length / 2,
      italic: italicCount > row.length / 2,
    })
  }
  return lines.sort((a, b) => b.y - a.y)
}

/**
 * Some PDF generators letter-space headings by emitting each glyph as its
 * own show-text with wide gaps ("A R A R A H Q"). Detect runs of single
 * uppercase letters separated by single spaces and collapse them.
 */
/** Strips the bold/italic markers layout.ts itself inserted, for pattern-matching purposes only. */
function stripStyleMarkers(text: string): string {
  return text.replace(/\*\*/g, "").replace(/_/g, "")
}

function collapseSpacedOutLetters(text: string): string {
  const tokens = text.split(" ")
  if (tokens.length < 4) return text
  const singleLetterRatio = tokens.filter((t) => t.length === 1 && /[A-Za-zÀ-ÿ0-9]/.test(t)).length / tokens.length
  if (singleLetterRatio < 0.7) return text
  return tokens.join("").replace(/ {2,}/g, "  ")
}

// Trailing whitespace after a BULLET marker is optional: many PDF producers
// place the bullet glyph directly adjacent to the first letter (the visual
// gap comes from layout/indentation, not an actual space character), so
// requiring `\s+` here would silently miss most real bullet lists. A bare
// bullet symbol appearing mid-sentence is vanishingly rare, so this laxness
// is safe.
const BULLET_PATTERN = /^[••●▪–\-*]\s*/
// NUMBERED markers are a different story: digits are common inside ordinary
// prose (a CNPJ, a law number, a clause reference wrapped onto a new line —
// "13.168.687/0001-10" or "13.747/2020" or "1.1.A abertura" all start a
// physical PDF line with what looks like "13." or "1."). The space here MUST
// be real (`\s+`, never `\s*`) and the text after it must not itself look
// like more of the same number (another digit right away, or a `.`/`/`
// glued on) — otherwise every wrapped CNPJ/law citation becomes a fake list
// item, silently mangling the number. Genuine numbered section headings
// ("1. JUSTIFICATIVA", "5.1 Implantação") are handled entirely by the
// separate, stricter HIER_NUMBER_PATTERN/classifyNumberedRuns path below;
// this one is only the fallback for letter/roman/parenthesized markers plus
// simple digit lists whose next line is NOT itself numeric.
const NUMBERED_PATTERN = /^(\d{1,3}[.)]|\([a-zA-Z0-9]+\)|[a-zA-Z][.)])\s*(?!\d)/

/** Hierarchical section numbering: "1.", "5.1", "5.1.1", each with 1-2 digit segments. */
const HIER_NUMBER_PATTERN = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$/

interface HierMatch {
  segments: number[]
  prefixRaw: string
  rest: string
}

/**
 * Word/LibreOffice auto-numbering fields are often followed by a tab, which
 * our glyph-gap heuristic renders as extra spacing — "5.1 Título" can come
 * through as "5. 1 Título" (space injected between the dot and the next
 * digit). Collapse that specific artifact before matching, without touching
 * spacing anywhere else in the line.
 */
function normalizeHierSpacing(text: string): string {
  let out = text
  for (let i = 0; i < 3; i++) out = out.replace(/^(\d{1,2}(?:\.\d{1,2}){0,2})\.\s+(\d{1,2})\b/, "$1.$2")
  return out
}

function matchHierNumber(text: string): HierMatch | null {
  const m = normalizeHierSpacing(text).match(HIER_NUMBER_PATTERN)
  if (!m) return null
  const segments = m[1].split(".").map((s) => Number.parseInt(s, 10))
  return { segments, prefixRaw: m[1], rest: m[2] }
}

function isAllCapsLine(text: string): boolean {
  const letters = text.match(/\p{L}/gu)
  if (!letters || letters.length < 3) return false
  return letters.every((l) => l === l.toUpperCase())
}

type NumberedLineTag =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list-item"; text: string }
  | { kind: "none" }

/**
 * Classifies every hierarchically-numbered line ("1.", "5.1", ...) in a
 * column as either a section heading or an ordered-list item, by looking at
 * its neighbors instead of judging each line in isolation — a single "1."
 * line is virtually always a numbered section header (Word/LibreOffice
 * outline numbering), while two or more *consecutive* lines whose numbers
 * increment by one at the same depth are a real list.
 */
function classifyNumberedRuns(lines: LineBox[], bodySize: number): Map<number, NumberedLineTag> {
  const result = new Map<number, NumberedLineTag>()
  const matches = lines.map((l) => matchHierNumber(l.plain))

  let i = 0
  while (i < lines.length) {
    const m = matches[i]
    if (!m) {
      i++
      continue
    }
    const depth = m.segments.length
    const last = m.segments[depth - 1]
    // Extend the run while subsequent hier-numbered lines sit at the same
    // depth and increment the last numeric segment by exactly one.
    let j = i + 1
    let expected = last + 1
    while (j < lines.length) {
      const next = matches[j]
      if (!next || next.segments.length !== depth || next.segments[depth - 1] !== expected) break
      expected++
      j++
    }
    const runLength = j - i
    // A numbered-looking line whose PREVIOUS line does not end in
    // terminal punctuation (or doesn't exist / is itself a heading) is
    // continuing a sentence, not opening a new clause or list — a wrapped
    // law citation ("...nos termos da Lei nº 6.404," / "15. de dezembro de
    // 1976, concorrendo entre si;") looks exactly like a short heading in
    // isolation, but the dangling comma before it is the tell. This guards
    // BOTH the list-item and the heading branches below.
    const prevLine = i > 0 ? lines[i - 1] : undefined
    const prevTag = i > 0 ? result.get(i - 1) : undefined
    const previousIsBreakPoint =
      !prevLine || prevTag?.kind === "heading" || /[.!?:;]["')\]]?$/.test(prevLine.plain.trimEnd())
    if (!previousIsBreakPoint) {
      result.set(i, { kind: "none" })
      i++
      continue
    }
    if (runLength >= 2) {
      for (let k = i; k < j; k++) {
        result.set(k, { kind: "list-item", text: matches[k]!.rest })
      }
    } else {
      const line = lines[i]
      // A short numbered line ("2. – DO OBJETO:") is a section heading; a
      // long one ("2.2. O pregão será realizado em grupo único, com
      // critério de julgamento pelo menor preço,") is a body clause even
      // though it also starts with a number — length alone must be BOTH
      // short in words and short in characters, or it needs an independent
      // style signal (bold/all-caps/larger font) to qualify as a heading.
      // Bold is deliberately NOT an independent trigger here: real editais
      // routinely carry bold formatting noise onto ordinary body clauses
      // (a whole clause bold from sloppy Word styling, not just its number),
      // and unlike a genuinely short heading, a long bold clause is still a
      // clause. All-caps and a distinctly larger font size are reliable on
      // their own; length is the deciding signal otherwise.
      const isShortLine = m.rest.length <= 70 && m.rest.split(/\s+/).length <= 10
      const headingLike = isAllCapsLine(m.rest) || line.fontSize > bodySize * 1.03 || isShortLine
      if (headingLike) {
        result.set(i, { kind: "heading", level: Math.min(6, depth), text: `${m.prefixRaw}. ${m.rest}`.trim() })
      } else {
        result.set(i, { kind: "none" })
      }
    }
    i = j
  }
  return result
}

function splitColumns(lines: LineBox[], pageWidth: number): LineBox[][] {
  if (lines.length < MIN_LINES_FOR_COLUMNS || pageWidth <= 0) return [lines]
  const min = Math.min(...lines.map((l) => l.xStart))
  const max = Math.max(...lines.map((l) => l.xEnd))
  const span = max - min
  if (span < pageWidth * 0.55) return [lines]

  const splitX = findGutter(lines, min, span)
  if (splitX === null) return [lines]

  // Linhas que cruzam a calha (título de largura total, abstract, legenda,
  // rodapé) são divisores horizontais: o corte em colunas só vale DENTRO de
  // cada faixa vertical entre elas. É o primeiro nível de um XY-cut — e o que
  // impede que uma página com lista + tabela (linhas curtas à esquerda) seja
  // lida como duas colunas e tenha um parágrafo inteiro jogado pro fim.
  const byY = [...lines].sort((a, b) => b.y - a.y)
  const segments: Array<{ crossing: boolean; lines: LineBox[] }> = []
  for (const line of byY) {
    const crossing = crossesGutter(line, splitX)
    const last = segments[segments.length - 1]
    if (last && last.crossing === crossing) last.lines.push(line)
    else segments.push({ crossing, lines: [line] })
  }
  const split = segments.map((seg) => (seg.crossing ? [seg.lines] : splitBand(seg.lines, splitX, span)))
  // Se nenhuma faixa se dividiu de verdade, a página é um fluxo só: devolver
  // em ordem de y, sem isolar as linhas de largura total (senão elas
  // quebram o parágrafo a que pertencem).
  const hasColumns = split.some((blocks, i) => !segments[i].crossing && blocks.length > 1)
  if (!hasColumns) return [byY]
  return split.flat()
}

function crossesGutter(line: LineBox, splitX: number): boolean {
  return line.xStart < splitX - GUTTER_SLACK && line.xEnd > splitX + GUTTER_SLACK
}

function findGutter(lines: LineBox[], min: number, span: number): number | null {
  const bucketCount = 40
  const bucketWidth = span / bucketCount
  const occupancy = new Array<number>(bucketCount).fill(0)
  for (const l of lines) {
    const startBucket = Math.floor((l.xStart - min) / bucketWidth)
    const endBucket = Math.floor((l.xEnd - min) / bucketWidth)
    for (let b = Math.max(0, startBucket); b <= Math.min(bucketCount - 1, endBucket); b++) occupancy[b]++
  }
  // Linhas de largura total (título, abstract) não impedem a calha: elas viram
  // divisores horizontais em splitColumns. Aqui só se exige que a calha seja
  // o vale mais vazio da região central e que poucas linhas a atravessem.
  const tolerance = Math.max(1, Math.floor(lines.length * 0.12))
  let bestBucket = -1
  let bestOccupancy = Infinity
  for (let b = Math.floor(bucketCount * 0.3); b <= Math.floor(bucketCount * 0.7); b++) {
    if (occupancy[b] <= tolerance && occupancy[b] < bestOccupancy) {
      bestOccupancy = occupancy[b]
      bestBucket = b
    }
  }
  if (bestBucket === -1) return null
  return min + bestBucket * bucketWidth + bucketWidth / 2
}

/**
 * Divide uma faixa vertical em duas colunas só quando os dois lados parecem
 * colunas de texto: muitas linhas cada, larguras de coluna (não células de
 * tabela nem bullets), e extensão vertical sobreposta. Um par de itens de
 * lista ou uma tabela de duas colunas não passa — e não deve passar.
 */
function splitBand(band: LineBox[], splitX: number, span: number): LineBox[][] {
  const left = band.filter((l) => (l.xStart + l.xEnd) / 2 < splitX)
  const right = band.filter((l) => (l.xStart + l.xEnd) / 2 >= splitX)
  if (left.length < MIN_LINES_PER_COLUMN || right.length < MIN_LINES_PER_COLUMN) return [band]
  if (!looksLikeColumn(left, span) || !looksLikeColumn(right, span)) return [band]
  if (!verticallyOverlap(left, right)) return [band]
  return [left, right]
}

function looksLikeColumn(lines: LineBox[], span: number): boolean {
  const widths = lines.map((l) => l.xEnd - l.xStart)
  const wide = widths.filter((w) => w >= span * MIN_COLUMN_LINE_FRACTION).length
  return wide >= lines.length * 0.6
}

function verticallyOverlap(a: LineBox[], b: LineBox[]): boolean {
  const top = (ls: LineBox[]) => Math.max(...ls.map((l) => l.y))
  const bottom = (ls: LineBox[]) => Math.min(...ls.map((l) => l.y))
  const overlap = Math.min(top(a), top(b)) - Math.max(bottom(a), bottom(b))
  const shorter = Math.min(top(a) - bottom(a), top(b) - bottom(b))
  return shorter > 0 && overlap >= shorter * 0.6
}

const MIN_LINES_FOR_COLUMNS = 8
const MIN_LINES_PER_COLUMN = 5
const MIN_COLUMN_LINE_FRACTION = 0.25
const GUTTER_SLACK = 2

function fontSizeToHeadingLevel(size: number, bodySize: number, sizeRank: Map<number, number>): number | null {
  if (size <= bodySize * 1.03) return null
  const rank = sizeRank.get(round1(size))
  if (rank === undefined) return null
  return Math.min(6, rank)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export interface PageLayoutOptions {
  pageWidth: number
  headings: boolean
  tables: boolean
}

export function buildBlocksForPage(lines: LineBox[], options: PageLayoutOptions): Block[] {
  if (lines.length === 0) return []

  // Weight by total character count, not line count: body text dominates any
  // real document by volume even when headings and body happen to appear an
  // equal number of *times* (short documents, single heading per page).
  const sizeWeights = new Map<number, number>()
  for (const l of lines) {
    const size = round1(l.fontSize)
    sizeWeights.set(size, (sizeWeights.get(size) ?? 0) + l.text.length)
  }
  let bodySize = lines[0].fontSize
  let bodyWeight = -1
  for (const [size, weight] of sizeWeights) {
    if (weight > bodyWeight || (weight === bodyWeight && size < bodySize)) {
      bodyWeight = weight
      bodySize = size
    }
  }
  const distinctLargerSizes = [...sizeWeights.keys()].filter((s) => s > bodySize * 1.03).sort((a, b) => b - a)
  const sizeRank = new Map<number, number>()
  distinctLargerSizes.forEach((s, i) => sizeRank.set(s, i + 1))

  const columns = splitColumns(lines, options.pageWidth)
  const blocks: Block[] = []
  for (const columnLines of columns) {
    blocks.push(...buildBlocksForColumn(columnLines, bodySize, sizeRank, options))
  }
  return blocks
}

function buildBlocksForColumn(
  lines: LineBox[],
  bodySize: number,
  sizeRank: Map<number, number>,
  options: PageLayoutOptions,
): Block[] {
  const blocks: Block[] = []
  let paragraphBuffer: string[] = []
  let listBuffer: { ordered: boolean; items: string[] } | null = null
  let tableBuffer: LineBox[] = []

  let paragraphStartY = 0
  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return
    const text = dehyphenateJoin(paragraphBuffer)
    if (text) blocks.push({ kind: "paragraph", text, y: paragraphStartY })
    paragraphBuffer = []
  }
  const flushList = () => {
    if (listBuffer && listBuffer.items.length > 0) blocks.push({ kind: "list", ...listBuffer })
    listBuffer = null
  }
  const flushTable = () => {
    // Two unrelated lines that both happen to have a wide internal gap —
    // the classic false positive being a two-column academic layout whose
    // column split failed, so each ROW actually holds one line from each
    // column glued side by side — already satisfy "length >= 2" without
    // being a real table (a real table almost never has exactly two rows;
    // it has a header plus several data rows). Requiring three raises the
    // bar enough to reject that pattern while still catching genuine small
    // tables, and linesToTable adds a second, structural check on top.
    if (tableBuffer.length >= 3 && options.tables) {
      const table = linesToTable(tableBuffer)
      if (table) blocks.push(table)
      else for (const l of tableBuffer) paragraphBuffer.push(l.text)
    } else {
      for (const l of tableBuffer) paragraphBuffer.push(l.text)
    }
    tableBuffer = []
  }

  const numberedTags = options.headings ? classifyNumberedRuns(lines, bodySize) : new Map<number, NumberedLineTag>()

  let prevLine: LineBox | undefined
  let paragraphStartX = 0
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    const numberedTag = numberedTags.get(idx)
    const headingLevel = options.headings ? fontSizeToHeadingLevel(line.fontSize, bodySize, sizeRank) : null
    const gapCount = countInternalGaps(line.plain)

    if (numberedTag?.kind === "heading") {
      flushTable()
      flushList()
      flushParagraph()
      blocks.push({ kind: "heading", level: numberedTag.level, text: numberedTag.text, y: line.y })
      prevLine = line
      continue
    }

    if (numberedTag?.kind === "list-item") {
      flushTable()
      flushParagraph()
      if (!listBuffer || !listBuffer.ordered) {
        flushList()
        listBuffer = { ordered: true, items: [] }
      }
      listBuffer.items.push(numberedTag.text)
      prevLine = line
      continue
    }

    if (headingLevel !== null) {
      flushTable()
      flushList()
      flushParagraph()
      // A heading's own "#" already conveys emphasis — most heading fonts are
      // bold/large by design, so re-wrapping the text in ** would be visual
      // noise (# **Title**) rather than useful signal.
      blocks.push({ kind: "heading", level: headingLevel, text: stripStyleMarkers(line.text), y: line.y })
      prevLine = line
      continue
    }

    if (gapCount >= 1 && options.tables) {
      flushList()
      flushParagraph()
      tableBuffer.push(line)
      prevLine = line
      continue
    }
    flushTable()

    // A hier-numbered line that failed both the "run" and the "heading-like"
    // test (numberedTag.kind === "none") falls through to plain paragraph
    // text below, number kept intact — better an unstyled line than a
    // silently dropped section number.
    const bulletMatch = numberedTag ? null : line.plain.match(BULLET_PATTERN)
    const numberedMatch = numberedTag ? null : line.plain.match(NUMBERED_PATTERN)
    if (bulletMatch || numberedMatch) {
      flushParagraph()
      const ordered = !!numberedMatch
      if (!listBuffer || listBuffer.ordered !== ordered) {
        flushList()
        listBuffer = { ordered, items: [] }
      }
      const marker = bulletMatch?.[0] ?? numberedMatch?.[0] ?? ""
      listBuffer.items.push(line.plain.slice(marker.length).trim())
      prevLine = line
      continue
    }
    flushList()

    // A new paragraph requires a POSITIVE signal — never just "this line
    // isn't identical to the last". Real single/1.15/1.5-line-spacing body
    // text (Word, LibreOffice, most DTP output) commonly sits at a gap/size
    // ratio of ~1.3-1.9 for lines that are still the SAME paragraph — a
    // justified Word document at 1.15 spacing measured ~1.83 on every single
    // line, paragraph break or not, so treating "ratio > 1.8" as the signal
    // misfired on every line. Three independent positive signals instead,
    // any one of which is enough:
    //   1. a genuinely large vertical gap (>= ~2.2x font size) — an actual
    //      blank line/extra spacing before a new paragraph, not just leading;
    //   2. an indent change relative to the PARAGRAPH's own margin (not the
    //      page's first line) bigger than normal x jitter — first-line
    //      indent or a dedent back to the page margin;
    //   3. the previous line ends in sentence-final punctuation AND this
    //      line opens with an uppercase letter or digit — the one signal
    //      that actually discriminates in the real-world case above, where
    //      gap and indent are identical across the whole page.
    // Small x jitter (justified text can vary by a few tenths of a point
    // between lines of the same paragraph) must NOT count — the tolerance
    // is relative to font size, not a fixed absolute pixel value.
    const gapRatio = prevLine ? (prevLine.y - line.y) / Math.max(line.fontSize, 1) : 0
    const bigGap = gapRatio >= 2.2
    const indentChanged = Math.abs(line.xStart - paragraphStartX) > line.fontSize * 1.2
    const prevEndsSentence = prevLine ? /[.!?:;]["')\]]?$/.test(prevLine.plain.trimEnd()) : false
    const startsNewSentence = /^[\p{Lu}\d]/u.test(line.plain.trimStart())
    const punctuationBreak = prevEndsSentence && startsNewSentence
    const isNewParagraph =
      prevLine !== undefined && paragraphBuffer.length > 0 && (bigGap || indentChanged || punctuationBreak)
    if (isNewParagraph) flushParagraph()
    if (paragraphBuffer.length === 0) {
      paragraphStartY = line.y
      paragraphStartX = line.xStart
    }
    paragraphBuffer.push(line.text)
    prevLine = line
  }
  flushTable()
  flushList()
  flushParagraph()
  return blocks
}

function countInternalGaps(text: string): number {
  const matches = text.match(/ {2,}/g)
  return matches ? matches.length : 0
}

function linesToTable(lines: LineBox[]): Block | null {
  const rows = lines.map((l) => l.plain.split(/ {2,}/).map((c) => c.trim()).filter(Boolean))
  const colCount = rows[0]?.length ?? 0
  if (colCount < 2) return null
  if (!rows.every((r) => Math.abs(r.length - colCount) <= 1)) return null
  // Real table columns repeat at roughly the same width down the page; a
  // two-column-layout collision (each "row" is really one line from the
  // left column and one from the right, unrelated to each other) produces
  // wildly inconsistent first-cell lengths since each column line just
  // wraps wherever its own text happened to end. Coefficient of variation
  // on the first cell's length is a cheap, effective proxy for "these gaps
  // are actually aligned columns" without re-deriving glyph x-positions.
  const firstCellLengths = rows.map((r) => r[0]?.length ?? 0)
  const mean = firstCellLengths.reduce((a, b) => a + b, 0) / firstCellLengths.length
  if (mean > 0) {
    const variance = firstCellLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / firstCellLengths.length
    const coefficientOfVariation = Math.sqrt(variance) / mean
    if (coefficientOfVariation > 0.6) return null
  }
  const header = rows[0]
  const dataRows = rows.slice(1).map((r) => {
    while (r.length < colCount) r.push("")
    return r
  })
  return { kind: "table", header, rows: dataRows }
}

function dehyphenateJoin(paragraphLines: string[]): string {
  let out = ""
  for (let i = 0; i < paragraphLines.length; i++) {
    let line = paragraphLines[i]
    if (out.endsWith("-") && /^[a-zà-ÿ]/.test(line)) {
      out = out.slice(0, -1) + line
    } else if (out.length > 0) {
      out += " " + line
    } else {
      out = line
    }
  }
  return out.replace(/\s+/g, " ").trim()
}
