import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseCMap } from "../src/read/pdf/fonts/font.js"
import { glyphsToLines, buildBlocksForPage, type Block } from "../src/read/pdf/layout.js"
import type { PositionedGlyph } from "../src/read/pdf/content.js"
import { readPdf } from "../src/read/index.js"

const here = dirname(fileURLToPath(import.meta.url))
const LOCAL_FIXTURE = join(here, "fixtures/local/tr.pdf")

describe("real fixture on disk (test/fixtures/local/tr.pdf, not committed)", () => {
  if (!existsSync(LOCAL_FIXTURE)) {
    it.skip("skipped: test/fixtures/local/tr.pdf not present on this machine", () => {})
  } else {
    it("should join the wrapped sentence across three PDF lines into one contiguous paragraph", () => {
      const buf = new Uint8Array(readFileSync(LOCAL_FIXTURE))
      const result = readPdf(buf)
      expect(result.markdown).toContain("destinada à comunicação com pacientes")
    })
  }
})

/**
 * Regression fixtures distilled from a real Microsoft Word-exported PDF
 * (a public government procurement document, "Termo de Referência") that
 * exposed four defects the pluma-generated round-trip corpus could never
 * catch, because writer and reader shared the same conventions there. The
 * original PDF is not committed (kept locally at test/fixtures/local/,
 * gitignored) — only the minimal, content-free structures needed to prove
 * each fix are checked in.
 */
describe("real-world fixture regressions (Word/Calibri PDF)", () => {
  it("bfrange array-form destinations must not be re-parsed as a simple range (glyph substitution bug)", () => {
    // This is the exact ToUnicode CMap text extracted from the document's
    // embedded Calibri Type0 font. It contains, among ~100 other entries:
    //   <0355> <0358> [<002C> <003B> <003A> <002E>]   (array-form bfrange)
    //   <002F> <0049>                                  (bfchar: CID -> 'I')
    // A naive <hex><hex><hex> scan for simple ranges "discovers" a bogus
    // triple *inside* the array's own bracket contents (002C, 003B, 003A),
    // silently overwriting CID 0x002F's correct mapping to 'I' (0x0049)
    // with '=' (0x003D) — this is exactly how "SIRESP" became "S=RESP" and
    // "API" became "AP=" in the real document.
    const cmapText = readFileSync(join(here, "fixtures/real-word-tounicode-cmap.txt"), "utf8")
    const map = parseCMap(cmapText)
    expect(map.get(0x2f)).toBe("I")
    // The array-form destinations themselves must still resolve correctly.
    expect(map.get(0x355)).toBe(",")
    expect(map.get(0x356)).toBe(";")
    expect(map.get(0x357)).toBe(":")
    expect(map.get(0x358)).toBe(".")
  })

  it("should join wrapped body lines into one paragraph using baseline-gap ratio, not a fixed page-wide indent", () => {
    // Three lines of one paragraph at normal (~1.3x font size) leading,
    // starting at the SAME left margin as a differently-positioned first
    // page line (simulating a centered title above the paragraph) — the
    // original bug compared every line's x against the page's very first
    // line, so a centered title threw off every paragraph on the page.
    const fontSize = 11
    const leftMargin = 56
    const glyphs: PositionedGlyph[] = []
    const makeLine = (y: number, text: string, x: number) => {
      let cursor = x
      for (const ch of text) {
        glyphs.push({ text: ch, x: cursor, y, fontSize, bold: false, italic: false, fontKey: "F1" })
        cursor += fontSize * 0.5
      }
    }
    makeLine(800, "TITLE CENTERED", 220) // unrelated first line, far to the right
    makeLine(770, "primeira linha do paragrafo continua", leftMargin)
    makeLine(770 - fontSize * 1.3, "segunda linha do mesmo paragrafo", leftMargin)
    makeLine(770 - fontSize * 1.3 * 2, "terceira linha ainda do mesmo paragrafo.", leftMargin)

    const lines = glyphsToLines(glyphs)
    const blocks = buildBlocksForPage(lines, { pageWidth: 600, headings: true, tables: true })
    const paragraphs = blocks.filter((b): b is Extract<Block, { kind: "paragraph" }> => b.kind === "paragraph")
    const merged = paragraphs.find((p) => p.text.includes("primeira linha"))
    expect(merged?.text).toContain("segunda linha")
    expect(merged?.text).toContain("terceira linha")
  })

  it("an isolated hierarchical section number (\"1.\", \"5.1\") becomes a heading with the number preserved, not a renumbered list", () => {
    const fontSize = 11
    const glyphs: PositionedGlyph[] = []
    const makeLine = (y: number, text: string, bold: boolean) => {
      let cursor = 56
      for (const ch of text) {
        glyphs.push({ text: ch, x: cursor, y, fontSize, bold, italic: false, fontKey: "F1" })
        cursor += fontSize * 0.5
      }
    }
    makeLine(800, "1. JUSTIFICATIVA", true)
    makeLine(780, "Corpo do texto explicando a justificativa do contrato.", false)
    makeLine(750, "2. OBJETO", true)
    makeLine(730, "Corpo do texto explicando o objeto do contrato.", false)

    const lines = glyphsToLines(glyphs)
    const blocks = buildBlocksForPage(lines, { pageWidth: 600, headings: true, tables: true })
    const headings = blocks.filter((b): b is Extract<Block, { kind: "heading" }> => b.kind === "heading")
    expect(headings.map((h) => h.text)).toEqual(["1. JUSTIFICATIVA", "2. OBJETO"])
    expect(blocks.some((b) => b.kind === "list")).toBe(false)
  })

  it("consecutive sequentially-numbered plain-weight items become a real ordered list, not headings", () => {
    const fontSize = 11
    const glyphs: PositionedGlyph[] = []
    const makeLine = (y: number, text: string) => {
      let cursor = 56
      for (const ch of text) {
        glyphs.push({ text: ch, x: cursor, y, fontSize, bold: false, italic: false, fontKey: "F1" })
        cursor += fontSize * 0.5
      }
    }
    makeLine(
      800,
      "1. primeiro item da lista com texto suficientemente longo para nao parecer um titulo curto",
    )
    makeLine(
      780,
      "2. segundo item da lista com texto suficientemente longo para nao parecer um titulo curto",
    )
    makeLine(
      760,
      "3. terceiro item da lista com texto suficientemente longo para nao parecer um titulo curto",
    )

    const lines = glyphsToLines(glyphs)
    const blocks = buildBlocksForPage(lines, { pageWidth: 600, headings: true, tables: true })
    const list = blocks.find((b): b is Extract<Block, { kind: "list" }> => b.kind === "list")
    expect(list?.ordered).toBe(true)
    expect(list?.items.length).toBe(3)
    expect(blocks.some((b) => b.kind === "heading")).toBe(false)
  })

  it("bold text detected from font weight is rendered as **bold** Markdown, not silently dropped", () => {
    const fontSize = 11
    const glyphs: PositionedGlyph[] = []
    let cursor = 56
    for (const ch of "Normal ") {
      glyphs.push({ text: ch, x: cursor, y: 800, fontSize, bold: false, italic: false, fontKey: "F1" })
      cursor += fontSize * 0.5
    }
    for (const ch of "bold word") {
      glyphs.push({ text: ch, x: cursor, y: 800, fontSize, bold: true, italic: false, fontKey: "F2" })
      cursor += fontSize * 0.5
    }
    const lines = glyphsToLines(glyphs)
    expect(lines[0].text).toContain("**bold word**")
  })

  it("a footer rule made only of underscores or dashes is dropped, not kept as content", () => {
    const fontSize = 9
    const glyphs: PositionedGlyph[] = []
    let cursor = 56
    for (const ch of "_".repeat(40)) {
      glyphs.push({ text: ch, x: cursor, y: 60, fontSize, bold: false, italic: false, fontKey: "F1" })
      cursor += fontSize * 0.3
    }
    const lines = glyphsToLines(glyphs)
    expect(lines.length).toBe(0)
  })
})
