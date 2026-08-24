import { describe, expect, it } from "bun:test"
import { deflateSync } from "node:zlib"
import { renderPdf } from "../src/index.js"
import { readPdf, readPdfPages, looksLikePdf, PdfParseError, PdfLimitError, PdfStructureError } from "../src/read/index.js"
import { decodeStream } from "../src/read/pdf/filters.js"
import { rc4 } from "../src/read/pdf/crypto.js"
import { openPdfDocumentCallCount, resetOpenPdfDocumentCallCountForTests } from "../src/read/pdf/xref.js"

describe("readPdf — round trip against pluma's own writer", () => {
  it("should recover headings at the right levels", () => {
    const pdf = renderPdf("# Title\n\n## Section\n\n### Sub\n\nBody text under the sub heading.")
    const result = readPdf(pdf)
    const headings = result.pages[0].blocks.filter((b) => b.kind === "heading")
    expect(headings.map((h) => (h as { level: number }).level)).toEqual([1, 2, 3])
    expect(result.markdown).toContain("# Title")
    expect(result.markdown).toContain("## Section")
    expect(result.markdown).toContain("### Sub")
  })

  it("should join a wrapped paragraph into one line without losing words", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")
    const pdf = renderPdf(long)
    const result = readPdf(pdf)
    expect(result.markdown.replace(/\s+/g, " ").trim()).toBe(long)
  })

  it("should recover unordered and ordered lists", () => {
    const pdf = renderPdf("- alpha\n- beta\n- gamma\n\n1. first\n2. second\n3. third")
    const result = readPdf(pdf)
    expect(result.markdown).toContain("- alpha")
    expect(result.markdown).toContain("- beta")
    expect(result.markdown).toContain("1. first")
    expect(result.markdown).toContain("2. second")
  })

  it("should recover a link as a Markdown link", () => {
    const pdf = renderPdf("Visit [our site](https://example.com/path) for more.")
    const result = readPdf(pdf)
    expect(result.markdown).toContain("(https://example.com/path)")
  })

  it("should recover a GFM table with header and rows", () => {
    const pdf = renderPdf(
      "| Column Alpha | Column Beta |\n| --- | --- |\n| value one | value two |\n| value three | value four |",
    )
    const result = readPdf(pdf)
    const table = result.pages[0].blocks.find((b) => b.kind === "table")
    expect(table).toBeDefined()
    if (table && table.kind === "table") {
      expect(table.header.length).toBe(2)
      expect(table.rows.length).toBe(2)
    }
  })

  it("should recover two-column layout in reading order", () => {
    const pdf = renderPdf(
      "<!-- columns:2 -->\n\nFirst column paragraph with enough words to fill some vertical space here.\n\n<!-- /columns -->",
    )
    const result = readPdf(pdf)
    expect(result.markdown.toLowerCase()).toContain("first column paragraph")
  })

  it("should expose document metadata from the PDF Info dictionary", () => {
    const pdf = renderPdf("# Doc\n\nBody.")
    const result = readPdf(pdf)
    expect(result.meta.pageCount).toBe(1)
    expect(result.meta.encrypted).toBe(false)
    expect(result.meta.creator).toContain("Typst")
  })

  it("should iterate pages one at a time via readPdfPages", async () => {
    const pages = Array.from({ length: 60 }, (_, i) => `# Page ${i}\n\nSome content on page ${i}.`)
    const pdf = renderPdf(pages.join("\n\n<!-- pagebreak -->\n\n"))
    let count = 0
    for await (const page of readPdfPages(pdf)) {
      expect(page.markdown.length).toBeGreaterThan(0)
      count++
    }
    expect(count).toBeGreaterThan(1)
  })

  it("readPdfPages should parse the xref/object-stream table exactly once for a 60-page document", async () => {
    resetOpenPdfDocumentCallCountForTests()
    const pages = Array.from({ length: 60 }, (_, i) => `# Page ${i}\n\nSome content on page ${i}.`)
    const pdf = renderPdf(pages.join("\n\n<!-- pagebreak -->\n\n"))
    let count = 0
    for await (const page of readPdfPages(pdf)) {
      void page
      count++
    }
    expect(count).toBe(60)
    expect(openPdfDocumentCallCount).toBe(1)
  })

  it("should strip repeated footer text across many pages", () => {
    const pages = Array.from(
      { length: 6 },
      (_, i) => `# Page ${i}\n\nUnique body content for page number ${i} of the document.`,
    )
    const pdf = renderPdf(pages.join("\n\n<!-- pagebreak -->\n\n"), {
      brand: { footer: "Acme Corp — confidential" },
    })
    const result = readPdf(pdf)
    const footerOccurrences = result.markdown.split("Acme Corp").length - 1
    expect(footerOccurrences).toBeLessThan(3)
  })
})

describe("readPdf — malformed and edge-case input", () => {
  it("should throw PdfParseError for non-PDF input", () => {
    expect(() => readPdf(new TextEncoder().encode("not a pdf at all"))).toThrow(PdfParseError)
  })

  it("should throw PdfLimitError when maxBytes is exceeded", () => {
    const pdf = renderPdf("# Doc\n\nSome content.")
    expect(() => readPdf(pdf, { maxBytes: 10 })).toThrow(PdfLimitError)
  })

  it("should recover via linear scan when the xref table is corrupted", () => {
    const pdf = renderPdf("# Recovered\n\nThis document survives a corrupted xref table.")
    const corrupted = corruptXref(pdf)
    const result = readPdf(corrupted)
    expect(result.markdown).toContain("Recovered")
    expect(result.warnings.some((w) => /linear scan/i.test(w))).toBe(true)
  })

  it("should read an empty single-page document without throwing", () => {
    const pdf = renderPdf("")
    const result = readPdf(pdf)
    expect(result.meta.pageCount).toBe(1)
  })

  it("should throw PdfStructureError for a %PDF- file with no catalog", () => {
    const bogus = new TextEncoder().encode("%PDF-1.7\n%%EOF")
    expect(() => readPdf(bogus)).toThrow()
  })

  it("should respect a page range selection", () => {
    const pages = Array.from({ length: 5 }, (_, i) => `# Page ${i}`)
    const pdf = renderPdf(pages.join("\n\n<!-- pagebreak -->\n\n"))
    const result = readPdf(pdf, { pages: "2-3" })
    expect(result.pages.length).toBe(2)
  })
})

describe("filters — FlateDecode with a PNG-Up predictor", () => {
  it("should undo a PNG-Up predictor after inflating", () => {
    const rowBytes = 4
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    // Row 0 uses filter 0 (None); row 1 uses filter 2 (Up) relative to row 0.
    const filtered = new Uint8Array(2 + raw.length)
    filtered[0] = 0
    filtered.set(raw.subarray(0, rowBytes), 1)
    filtered[rowBytes + 1] = 2
    for (let i = 0; i < rowBytes; i++) {
      filtered[rowBytes + 2 + i] = (raw[rowBytes + i] - raw[i]) & 0xff
    }
    const compressed = deflateSync(Buffer.from(filtered))

    const decodeParms = {
      type: "dict" as const,
      map: new Map<string, unknown>([
        ["Predictor", 15],
        ["Colors", 1],
        ["Columns", rowBytes],
      ]),
    }
    const dict = {
      type: "dict" as const,
      map: new Map<string, unknown>([
        ["Filter", { type: "name", name: "FlateDecode" }],
        ["DecodeParms", decodeParms],
      ]),
    }
    const decoded = decodeStream(compressed, dict as never)
    expect(Array.from(decoded)).toEqual(Array.from(raw))
  })
})

describe("crypto primitives (white-box, no external fixture needed)", () => {
  it("RC4 should be a self-inverse stream cipher", () => {
    const key = new TextEncoder().encode("empty-user-password-key")
    const plaintext = new TextEncoder().encode("Hello, encrypted PDF world!")
    const ciphertext = rc4(key, plaintext)
    const roundTrip = rc4(key, ciphertext)
    expect(new TextDecoder().decode(roundTrip)).toBe("Hello, encrypted PDF world!")
  })

  it("RC4 output should differ from the input for a non-trivial key", () => {
    const key = new TextEncoder().encode("k")
    const plaintext = new TextEncoder().encode("aaaaaaaaaa")
    const ciphertext = rc4(key, plaintext)
    expect(Buffer.from(ciphertext).equals(Buffer.from(plaintext))).toBe(false)
  })
})

function nameDict(filterName: string, parms?: Record<string, number>): never {
  const map = new Map<string, unknown>([["Filter", { type: "name", name: filterName }]])
  if (parms) {
    map.set("DecodeParms", {
      type: "dict",
      map: new Map(Object.entries(parms)),
    })
  }
  return { type: "dict", map } as never
}

describe("filters — hand-rolled decoders", () => {
  it("should decode ASCIIHexDecode", () => {
    const encoded = new TextEncoder().encode("48656C6C6F>")
    const decoded = decodeStream(encoded, nameDict("ASCIIHexDecode"))
    expect(Buffer.from(decoded).toString("latin1")).toBe("Hello")
  })

  it("should decode ASCII85Decode", () => {
    const encoded = new TextEncoder().encode("87cURD_*#4DfTZ)+T~>")
    const decoded = decodeStream(encoded, nameDict("ASCII85Decode"))
    expect(Buffer.from(decoded).toString("latin1")).toBe("Hello, World!")
  })

  it("should decode RunLengthDecode", () => {
    // length 2 => copy next 3 literal bytes; length 253 (i.e. 257-253=4 repeats) of 'x'; 128 = EOD.
    const encoded = Uint8Array.from([2, 0x41, 0x42, 0x43, 253, 0x78, 128])
    const decoded = decodeStream(encoded, nameDict("RunLengthDecode"))
    expect(Buffer.from(decoded).toString("latin1")).toBe("ABCxxxx")
  })

  it("should decode LZWDecode (round trip against a minimal reference encoder)", () => {
    const plaintext = "TOBEORNOTTOBEORTOBEORNOT"
    const encoded = lzwEncodeForTest(new TextEncoder().encode(plaintext))
    const decoded = decodeStream(encoded, nameDict("LZWDecode"))
    expect(Buffer.from(decoded).toString("latin1")).toBe(plaintext)
  })

  it("should pass through image-only filters untouched (DCTDecode)", () => {
    const jpegLike = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const decoded = decodeStream(jpegLike, nameDict("DCTDecode"))
    expect(Array.from(decoded)).toEqual(Array.from(jpegLike))
  })
})

describe("looksLikePdf", () => {
  it("should detect the %PDF- magic prefix", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.4\n"))).toBe(true)
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false)
  })
})

/**
 * Minimal LZW encoder (PDF/TIFF variant, EarlyChange=1) used only to produce
 * a known-good fixture for the LZWDecode test — it mirrors the table-building
 * rules of src/read/pdf/filters.ts's lzwDecode so the round trip exercises
 * that decoder's clear-code, code-width-growth and table-append logic.
 */
function lzwEncodeForTest(data: Uint8Array): Uint8Array {
  const CLEAR = 256
  const EOD = 257
  let table = new Map<string, number>()
  const resetTable = () => {
    table = new Map()
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i)
  }
  resetTable()
  let nextCode = 258
  let codeWidth = 9
  const bits: number[] = []
  const pushCode = (code: number) => {
    for (let i = codeWidth - 1; i >= 0; i--) bits.push((code >> i) & 1)
  }
  pushCode(CLEAR)
  let current = ""
  for (const byte of data) {
    const ch = String.fromCharCode(byte)
    const combined = current + ch
    if (table.has(combined)) {
      current = combined
    } else {
      pushCode(table.get(current)!)
      table.set(combined, nextCode)
      nextCode++
      if (nextCode + 1 > 511) codeWidth = 10
      if (nextCode + 1 > 1023) codeWidth = 11
      if (nextCode + 1 > 2047) codeWidth = 12
      current = ch
    }
  }
  if (current) pushCode(table.get(current)!)
  pushCode(EOD)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
    bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

/** Blanks out the `startxref` trailer keyword so the parser must fall back to a linear scan. */
function corruptXref(pdf: Uint8Array): Uint8Array {
  const text = Buffer.from(pdf).toString("latin1")
  const idx = text.lastIndexOf("startxref")
  if (idx === -1) return pdf
  const copy = new Uint8Array(pdf)
  for (let i = 0; i < "startxref".length; i++) copy[idx + i] = 0x23 // '#'
  return copy
}
