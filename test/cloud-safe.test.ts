import { describe, expect, it } from "bun:test"
import {
  renderPdf,
  renderPdfCloudSafe,
  UnsafeRenderInputError,
  countPdfPages,
} from "../src/index.js"

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
})
