import { describe, expect, it } from "bun:test"
import { escapeMarkup, escapeString } from "../src/escape.js"
import { extractFrontmatter } from "../src/frontmatter.js"
import { markdownToTypst } from "../src/md-to-typst.js"
import { markdownToTypstSource, renderPdf, normalizeInput, UnknownThemeError, createTheme, InvalidBrandError } from "../src/index.js"
import { parseArgs, resolveRun } from "../bin/pluma.js"
import { handleMcpRequest } from "../src/mcp.js"

describe("escape", () => {
  it("should escape typst markup specials", () => {
    expect(escapeMarkup("R$ 10 #tag *b* _i_ @ref [x]")).toBe(
      "R\\$ 10 \\#tag \\*b\\* \\_i\\_ \\@ref \\[x\\]",
    )
  })

  it("should escape quotes and backslashes in strings", () => {
    expect(escapeString('a "b" c\\d')).toBe('a \\"b\\" c\\\\d')
  })
})

describe("frontmatter", () => {
  it("should extract known keys and strip the block", () => {
    const { meta, body } = extractFrontmatter('---\ntitle: Oi\nauthor: "Ana"\nignored: x\n---\n# T')
    expect(meta).toEqual({ title: "Oi", author: "Ana" })
    expect(body).toBe("# T")
  })

  it("should return the document untouched without frontmatter", () => {
    const { meta, body } = extractFrontmatter("# T")
    expect(meta).toEqual({})
    expect(body).toBe("# T")
  })
})

describe("markdownToTypst", () => {
  it("should convert headings by depth", () => {
    expect(markdownToTypst("# A\n\n### B")).toBe("= A\n\n=== B\n")
  })

  it("should convert inline styles", () => {
    const out = markdownToTypst("**b** *i* ~~s~~ `c`")
    expect(out).toContain("*b*")
    expect(out).toContain("_i_")
    expect(out).toContain("#strike[s]")
    expect(out).toContain('#raw("c")')
  })

  it("should convert links and images", () => {
    const out = markdownToTypst("[x](https://a.io) ![alt](img.png)")
    expect(out).toContain('#link("https://a.io")[x]')
    expect(out).toContain('#image("img.png")')
  })

  it("should convert fenced code with language", () => {
    expect(markdownToTypst('```ts\nconst a = "b"\n```')).toBe(
      '#raw(block: true, lang: "ts", "const a = \\"b\\"")\n',
    )
  })

  it("should convert nested and ordered lists", () => {
    const out = markdownToTypst("1. um\n2. dois\n   - sub")
    expect(out).toContain("1. um")
    expect(out).toContain("2. dois")
    expect(out).toContain("  - sub")
  })

  it("should convert blockquotes", () => {
    expect(markdownToTypst("> citado")).toContain("#quote(block: true)[citado]")
  })

  it("should convert tables with alignment", () => {
    const out = markdownToTypst("| a | b |\n| :-- | --: |\n| 1 | 2 |")
    expect(out).toContain("columns: 2")
    expect(out).toContain("align: (left, right)")
    expect(out).toContain("table.header([*a*], [*b*])")
    expect(out).toContain("[1], [2]")
  })

  it("should convert horizontal rules and drop raw html", () => {
    const out = markdownToTypst("a\n\n---\n\n<div>x</div>\n\nb")
    expect(out).toContain("#divider()")
    expect(out).not.toContain("<div>")
  })

  it("should escape user text so typst markup cannot be injected", () => {
    expect(markdownToTypst("preço: R$ 99 #eval")).toContain("R\\$ 99 \\#eval")
  })
})

describe("markdownToTypstSource", () => {
  it("should prepend the theme preamble with frontmatter meta", () => {
    const src = markdownToTypstSource('---\ntitle: Doc "X"\n---\n# Oi')
    expect(src).toContain("#set page(")
    expect(src).toContain('"Doc \\"X\\""')
    expect(src).toContain("= Oi")
  })

  it("should reject unknown themes", () => {
    expect(() => markdownToTypstSource("# a", { theme: "nope" })).toThrow(UnknownThemeError)
  })

  it("should accept a custom theme object", () => {
    const src = markdownToTypstSource("# a", {
      theme: { name: "t", preamble: () => "#set text(red)" },
    })
    expect(src.startsWith("#set text(red)")).toBe(true)
  })
})

describe("renderPdf", () => {
  it("should produce a valid pdf from full-featured markdown", () => {
    const md = [
      "---",
      "title: Teste",
      "author: Pluma",
      "---",
      "# Título",
      "Par com **negrito**, [link](https://a.io) e `code`.",
      "> quote",
      "- a",
      "- b",
      "| c1 | c2 |",
      "| --- | --- |",
      "| x | y |",
      "```js",
      "1 + 1",
      "```",
    ].join("\n\n")
    const pdf = renderPdf(md)
    expect(pdf.length).toBeGreaterThan(1000)
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
  })
})

describe("cli parseArgs", () => {
  it("should parse input, output and theme", () => {
    expect(parseArgs(["a.md", "-o", "b.pdf", "--theme", "clean", "-f", "fonts"])).toEqual({
      input: "a.md",
      output: "b.pdf",
      theme: "clean",
      fontPaths: ["fonts"],
      watch: false,
      json: false,
      emitTypst: false,
      help: false,
    })
  })

  it("should parse flags", () => {
    expect(parseArgs(["--typst", "a.md"]).emitTypst).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  it("should reject unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow("Argumento desconhecido")
  })
})

describe("createTheme brand", () => {
  it("should apply fonts, colors, logo and footer to the preamble", () => {
    const src = markdownToTypstSource("# a", {
      brand: {
        fonts: { body: "Geist", mono: "Geist Mono" },
        colors: { accent: "#0e7490" },
        logo: { path: "logo.png", width: "3cm" },
        footer: "AraraHQ",
      },
      meta: { title: "Doc" },
    })
    expect(src).toContain('font: "Geist"')
    expect(src).toContain('#show raw: set text(font: "Geist Mono")')
    expect(src).toContain('rgb("#0e7490")')
    expect(src).toContain('#image("logo.png", width: 3cm)')
    expect(src).toContain('"AraraHQ"')
  })

  it("should reject invalid colors and lengths", () => {
    expect(() => createTheme({ colors: { accent: 'red")#eval' } }).preamble({})).toThrow(
      InvalidBrandError,
    )
    expect(() =>
      createTheme({ page: { marginX: '2cm")#eval' } }).preamble({}),
    ).toThrow(InvalidBrandError)
  })
})

describe("directives", () => {
  it("should convert pagebreak comments and ignore other html", () => {
    const out = markdownToTypst("a\n\n<!-- pagebreak -->\n\nb")
    expect(out).toContain("#pagebreak()")
    expect(markdownToTypst("<!-- qualquer coisa -->")).not.toContain("#")
  })
})

describe("layout avançado", () => {
  it("should pass typst fenced blocks through untouched", () => {
    const out = markdownToTypst('```typst\n#text(size: 16pt)[Grande]\n```')
    expect(out).toBe("#text(size: 16pt)[Grande]\n")
  })

  it("should wrap content between columns directives", () => {
    const out = markdownToTypst("<!-- columns:2 -->\n\ntexto\n\n<!-- /columns -->")
    expect(out).toContain("#columns(2, gutter: 16pt)[")
    expect(out.trim().endsWith("]")).toBe(true)
  })
})

describe("cli resolveRun (convenções)", () => {
  const dir = "/tmp/pluma-conv"
  it("should auto-discover brand.json and fonts dir next to the input", () => {
    require("node:fs").mkdirSync(dir + "/fonts", { recursive: true })
    require("node:fs").writeFileSync(dir + "/brand.json", '{"footer":"X"}')
    const { options, brandPath } = resolveRun(
      { fontPaths: [], watch: false, emitTypst: false, json: false, help: false },
      "# a",
      dir + "/doc.md",
    )
    expect(brandPath).toBe(dir + "/brand.json")
    expect(options.brand).toEqual({ footer: "X" })
    expect(options.fontPaths).toEqual([dir + "/fonts"])
  })

  it("should prefer frontmatter brand over convention", () => {
    require("node:fs").writeFileSync(dir + "/outra.json", '{"footer":"Y"}')
    const { options } = resolveRun(
      { fontPaths: [], watch: false, emitTypst: false, json: false, help: false },
      "---\nbrand: ./outra.json\n---\n# a",
      dir + "/doc.md",
    )
    expect(options.brand).toEqual({ footer: "Y" })
  })

  it("should let the --brand flag win over everything", () => {
    require("node:fs").writeFileSync(dir + "/flag.json", '{"footer":"Z"}')
    const { options } = resolveRun(
      { brandFile: dir + "/flag.json", fontPaths: [], watch: false, emitTypst: false, json: false, help: false },
      "---\nbrand: ./outra.json\n---\n# a",
      dir + "/doc.md",
    )
    expect(options.brand).toEqual({ footer: "Z" })
  })
})

describe("ai friendly", () => {
  it("should unwrap a document fenced as markdown by an llm", () => {
    const wrapped = '```markdown\n---\ntitle: Doc\n---\n# Oi\n```'
    const src = markdownToTypstSource(wrapped)
    expect(src).toContain("= Oi")
    expect(src).not.toContain("```")
  })

  it("should leave normal documents with inner fences untouched", () => {
    const md = "# a\n\n```ts\ncode\n```\n\ntexto depois"
    expect(normalizeInput(md)).toBe(md)
  })
})

describe("mcp server", () => {
  it("should answer initialize and list the render tool", () => {
    const init = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }) as any
    expect(init.result.serverInfo.name).toBe("pluma")
    const list = handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any
    expect(list.result.tools[0].name).toBe("render_pdf")
  })

  it("should render a pdf via tools/call", () => {
    const out = "/tmp/pluma-mcp-test.pdf"
    const res = handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "render_pdf", arguments: { markdown: "# MCP\n\nok", output_path: out } },
    }) as any
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0].text).toContain(out)
    const bytes = require("node:fs").readFileSync(out)
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-")
  })

  it("should return isError for bad arguments instead of crashing", () => {
    const res = handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "render_pdf", arguments: { markdown: 42 } },
    }) as any
    expect(res.result.isError).toBe(true)
  })

  it("should ignore notifications", () => {
    expect(handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull()
  })
})
