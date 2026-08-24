import { describe, expect, it } from "vitest";
import { parseRenderInput, parseUrlInput, validatePdf } from "../../src/server/validation.js";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("cloud input validation", () => {
  it("accepts only the bounded cloud brand contract", () => {
    const input = parseRenderInput(bytes(JSON.stringify({
      markdown: "# Report",
      brand: { primaryColor: "#e34824", paper: "a4", marginMm: 20, bodyFont: "geist" },
    })));
    expect(input.brand?.marginMm).toBe(20);
    expect(() => parseRenderInput(bytes(JSON.stringify({ markdown: "ok", root: "/etc" })))).toThrow(/Unknown field/);
    expect(() => parseRenderInput(bytes(JSON.stringify({ markdown: "ok", brand: { logo: "/etc/passwd" } })))).toThrow(/Unknown field/);
  });

  it("rejects raw Typst, unknown fonts, and invalid PDFs", () => {
    expect(() => parseRenderInput(bytes(JSON.stringify({ markdown: "```typst\n#read(\"/etc/passwd\")\n```" })))).toThrow(/Raw Typst/);
    expect(() => parseRenderInput(bytes(JSON.stringify({ markdown: "ok", brand: { bodyFont: "Comic Sans" } })))).toThrow(/bundled font/);
    expect(() => validatePdf(bytes("not a pdf"))).toThrow();
  });

  it("accepts URL as the only URL payload field", () => {
    expect(parseUrlInput(bytes('{"url":"https://example.com"}')).url).toBe("https://example.com");
    expect(() => parseUrlInput(bytes('{"url":"https://example.com","headers":{"X":"Y"}}'))).toThrow(/Unknown field/);
  });
});
