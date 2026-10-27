import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  renderPdf,
  renderPdfCloudSafe,
  UnsafeRenderInputError,
  InvalidBrandError,
  countPdfPages,
} from "../src/index.js"

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)))
const hasImage = (pdf: Uint8Array) => /\/Subtype\s*\/Image/.test(Buffer.from(pdf).toString("latin1"))

describe("cloud-safe rendering", () => {
  it("should render safe Markdown and report the exact PDF page count", () => {
    const result = renderPdfCloudSafe("# One\n\n<!-- pagebreak -->\n\n# Two", {
      brand: { colors: { accent: "#0e7490" }, footer: "Acme" },
    })
    expect(Buffer.from(result.pdf.subarray(0, 5)).toString()).toBe("%PDF-")
    expect(result.pageCount).toBe(2)
    expect(countPdfPages(result.pdf)).toBe(2)
  })

  it("should reject raw Typst while keeping the local API unrestricted", () => {
    const markdown = "```typst\n#text(\"local\")\n```"
    expect(() => renderPdfCloudSafe(markdown)).toThrow(UnsafeRenderInputError)
    expect(() => renderPdf(markdown)).not.toThrow()
  })

  it("should reject raw Typst at every Markdown nesting and fence variant", () => {
    const inputs = [
      "> ```typst\n> #text(\"nested\")\n> ```",
      "- ~~~typst\n  #text(\"nested\")\n  ~~~",
      "````Typst\n#text(\"wide fence\")\n````",
      "```typst title=demo\n#text(\"metadata\")\n```",
    ]
    for (const markdown of inputs) {
      expect(() => renderPdfCloudSafe(markdown)).toThrow(/Raw Typst blocks/)
    }
  })

  it("should reject filesystem-backed and unknown brand fields", () => {
    expect(() => renderPdfCloudSafe("ok", { brand: { logo: { path: "/etc/passwd" } } })).toThrow(
      /brand\.logo is not allowed/,
    )
    expect(() => renderPdfCloudSafe("ok", { brand: { colors: { accent: 42 } } })).toThrow(
      /brand\.colors\.accent must be a string/,
    )
    expect(() => renderPdfCloudSafe("![secret](/etc/passwd)")).toThrow(
      /Markdown images are not allowed/,
    )
    expect(() => renderPdfCloudSafe("![secret]\n\n[secret]: /etc/passwd")).toThrow(
      /Markdown images are not allowed/,
    )
    expect(() => renderPdfCloudSafe("> ![secret](/etc/passwd)")).toThrow(
      /Markdown images are not allowed/,
    )
  })

  it("should render a PNG or JPEG logo passed as bytes, mapped into a virtual workspace", () => {
    for (const name of ["logo.png", "logo.jpg"]) {
      const result = renderPdfCloudSafe("Body text", {
        meta: { title: "Report" },
        brand: { footer: "Acme" },
        logo: { data: fixture(name), width: "2cm" },
      })
      expect(result.pageCount).toBe(1)
      expect(hasImage(result.pdf)).toBe(true)
    }
    expect(hasImage(renderPdfCloudSafe("Body text", { meta: { title: "Report" } }).pdf)).toBe(false)
  })

  it("should reject logo bytes that are not a small PNG or JPEG, and any logo path", () => {
    const png = fixture("logo.png")
    const wide = Uint8Array.from(png)
    new DataView(wide.buffer).setUint32(16, 5000)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>')
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000")
    expect(() => renderPdfCloudSafe("ok", { logo: { data: svg } })).toThrow(/logo\.data must be a PNG or JPEG image/)
    expect(() => renderPdfCloudSafe("ok", { logo: { data: gif } })).toThrow(/logo\.data must be a PNG or JPEG image/)
    expect(() => renderPdfCloudSafe("ok", { logo: { data: new Uint8Array() } })).toThrow(/between 1 and 2097152 bytes/)
    expect(() => renderPdfCloudSafe("ok", { logo: { data: new Uint8Array(2 * 1024 * 1024 + 1) } })).toThrow(
      /between 1 and 2097152 bytes/,
    )
    expect(() => renderPdfCloudSafe("ok", { logo: { data: wide } })).toThrow(/at most 4096x4096 pixels/)
    expect(() => renderPdfCloudSafe("ok", { logo: { data: "/etc/passwd" } })).toThrow(/logo\.data must be a Uint8Array/)
    expect(() => renderPdfCloudSafe("ok", { logo: { data: png, path: "/etc/passwd" } })).toThrow(
      /logo\.path is not allowed/,
    )
    expect(() => renderPdfCloudSafe("ok", { logo: { data: png, width: "huge" } })).toThrow(InvalidBrandError)
    expect(() => renderPdfCloudSafe("ok", { logo: "/etc/passwd" })).toThrow(UnsafeRenderInputError)
  })
})
