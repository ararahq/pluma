import { afterAll, describe, expect, it } from "bun:test"
import { deflateSync } from "node:zlib"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchHtml, HtmlFetchError, HtmlLimitError, isPublicAddress, requestPinned } from "../../src/read/html/fetch.js"
import { readHtml } from "../../src/read/html/index.js"
import { HtmlTreeLimitError, parseHtml } from "../../src/read/html/tree.js"
import { PdfEncryptedError, readDocCrypto } from "../../src/read/pdf/crypto.js"
import { decodeStream, PdfStreamLimitError } from "../../src/read/pdf/filters.js"
import { parseCMap } from "../../src/read/pdf/fonts/font.js"
import type { PdfDict, PdfValue } from "../../src/read/pdf/objects.js"
import { PdfLimitError } from "../../src/read/pdf/xref.js"
import { readPdf } from "../../src/read/index.js"

function dict(entries: Record<string, PdfValue>): PdfDict {
  return { type: "dict", map: new Map(Object.entries(entries)) }
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Missing server address"))
      resolve(address.port)
    })
  })
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe("fetchHtml redirect boundaries", () => {
  const target = Bun.serve({
    port: 0,
    fetch(request) {
      const headers = Object.fromEntries(request.headers.entries())
      return new Response(`<p>${JSON.stringify(headers)}</p>`, { headers: { "content-type": "text/html" } })
    },
  })
  const source = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/same") return Response.redirect(new URL("/capture", url), 302)
      if (url.pathname === "/capture") {
        return new Response(`<p>${JSON.stringify(Object.fromEntries(request.headers.entries()))}</p>`)
      }
      return Response.redirect(`http://localhost:${target.port}/capture`, 302)
    },
  })

  afterAll(() => {
    source.stop(true)
    target.stop(true)
  })

  it("strips credentials and unapproved custom headers across origins", async () => {
    const result = await fetchHtml(`http://localhost:${source.port}/cross`, {
      networkPolicy: "any",
      headers: { Authorization: "Bearer secret", Cookie: "session=secret", "X-Api-Key": "secret", "X-Trace": "trace" },
    })
    expect(result.html).not.toContain("Bearer secret")
    expect(result.html).not.toContain("session=secret")
    expect(result.html).not.toContain("x-api-key")
    expect(result.html).not.toContain("x-trace")
  })

  it("keeps same-origin headers and only forwards explicitly approved custom headers cross-origin", async () => {
    const same = await fetchHtml(`http://localhost:${source.port}/same`, {
      networkPolicy: "any",
      headers: { Authorization: "Bearer local" },
    })
    expect(same.html).toContain("Bearer local")

    const cross = await fetchHtml(`http://localhost:${source.port}/cross`, {
      networkPolicy: "any",
      headers: { Authorization: "Bearer secret", "X-Trace": "trace" },
      forwardHeadersOnCrossOriginRedirect: ["x-trace", "authorization"],
    })
    expect(cross.html).toContain("trace")
    expect(cross.html).not.toContain("Bearer secret")
  })

  it("applies URL policy once to the initial URL and every redirect hop", async () => {
    const seen: string[] = []
    await fetchHtml(`http://localhost:${source.port}/same`, {
      networkPolicy: "any",
      urlPolicy(url, context) {
        seen.push(`${context.redirectCount}:${url.pathname}`)
      },
    })
    expect(seen).toEqual(["0:/same", "1:/capture"])

    await expect(fetchHtml("data:text/html,hello")).rejects.toBeInstanceOf(HtmlFetchError)
  })

  it("applies one wall-clock timeout to URL policy and DNS resolution", async () => {
    const never = () => new Promise<never>(() => {})
    await expect(fetchHtml("https://example.com", { timeoutMs: 20, urlPolicy: never })).rejects.toThrow("timed out")
    await expect(fetchHtml("https://example.com", { timeoutMs: 20, resolver: never })).rejects.toThrow("timed out")
  })

  it.each([
    { status: 302, declared: 0 },
    { status: 404, declared: 0 },
    { status: 200, declared: 1024 },
  ])("closes discarded pinned HTTP $status bodies", async ({ status, declared }) => {
    let markClosed!: () => void
    const connectionClosed = new Promise<void>((resolve) => { markClosed = resolve })
    const server = createServer((request, response) => {
      response.writeHead(status, {
        "Content-Type": "text/html",
        ...(status === 302 ? { Location: "/next" } : {}),
        ...(declared ? { "Content-Length": String(declared) } : {}),
      })
      const interval = setInterval(() => response.write("drip"), 5)
      request.socket.once("close", () => { clearInterval(interval); markClosed() })
    })
    const port = await listen(server)
    try {
      const operation = requestPinned(
        new URL(`http://example.test:${port}/`), "127.0.0.1", 4, new Headers(), new AbortController().signal, 64,
      )
      if (declared) await expect(operation).rejects.toBeInstanceOf(HtmlLimitError)
      else await expect(operation).resolves.toMatchObject({ status })
      const closed = await Promise.race([
        connectionClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])
      expect(closed).toBe(true)
    } finally {
      await close(server)
    }
  })

  it("blocks private networks by default and requires an explicit trusted-local opt-in", async () => {
    await expect(fetchHtml(`http://127.0.0.1:${source.port}/capture`)).rejects.toThrow("blocked network")
    const result = await fetchHtml(`http://127.0.0.1:${source.port}/capture`, { networkPolicy: "any" })
    expect(result.html).toContain("<p>")
  })

  it("classifies private, mapped, transition, and documentation addresses as non-public", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1",
      "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::",
    ]) {
      expect(isPublicAddress(address)).toBe(false)
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true)
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
  })
})

describe("HTML amplification limits", () => {
  it("bounds colspan and rowspan flattening", () => {
    const result = readHtml(
      `<table><tr><th colspan="999999" rowspan="999999">wide</th></tr><tr><td>hidden</td></tr><tr><td>ignored</td></tr></table>`,
      { mode: "raw", maxTableColumns: 4, maxTableRows: 2 },
    )
    const tableLines = result.markdown.split("\n").filter((line) => line.startsWith("|"))
    expect(tableLines).toHaveLength(3)
    expect(tableLines.every((line) => (line.match(/\|/g) ?? []).length === 5)).toBe(true)
    expect(result.markdown).not.toContain("ignored")
  })

  it("enforces input, tree, and output budgets", () => {
    expect(() => readHtml("<p>too large</p>", { maxInputChars: 4 })).toThrow(HtmlLimitError)
    expect(() => parseHtml("<div><span>x</span></div>", { maxNodes: 3 })).toThrow(HtmlTreeLimitError)
    expect(() => parseHtml("<div><div><div>x</div></div></div>", { maxDepth: 2 })).toThrow(HtmlTreeLimitError)

    const result = readHtml(`<main><p>${"word ".repeat(1000)}</p></main>`, { mode: "raw", maxOutputChars: 120 })
    expect(result.markdown.length).toBeLessThanOrEqual(120)
    expect(result.warnings.some((warning) => warning.includes("maxOutputChars"))).toBe(true)
  })
})

describe("PDF parser resource limits", () => {
  it("checks a file path size before reading it into memory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pluma-hardening-"))
    const path = join(directory, "oversized.pdf")
    try {
      writeFileSync(path, Buffer.alloc(4096, 0x25))
      expect(() => readPdf(path, { maxBytes: 16 })).toThrow(PdfLimitError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects decompression bombs and run-length amplification", () => {
    const flate = dict({ Filter: { type: "name", name: "FlateDecode" } })
    const compressed = new Uint8Array(deflateSync(Buffer.from("x".repeat(128 * 1024))))
    expect(() => decodeStream(compressed, flate, { maxBytes: 1024 })).toThrow(PdfStreamLimitError)

    const runLength = dict({ Filter: { type: "name", name: "RunLengthDecode" } })
    expect(() => decodeStream(Uint8Array.of(129, 65, 128), runLength, { maxBytes: 64 })).toThrow(PdfStreamLimitError)
  })

  it("bounds xref entry loops before scanning attacker-controlled counts", () => {
    const prefix = "%PDF-1.4\n"
    const xrefOffset = Buffer.byteLength(prefix, "latin1")
    const pdf = Buffer.from(`${prefix}xref\n0 500001\nstartxref\n${xrefOffset}\n%%EOF`, "latin1")
    expect(() => readPdf(pdf)).toThrow(PdfLimitError)
  })

  it("detects page-tree cycles", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF",
      "latin1",
    )
    expect(() => readPdf(pdf)).toThrow("cycle")
  })

  it("caps malicious font ranges to the supported 16-bit code space", () => {
    const map = parseCMap("1 beginbfrange\n<0000> <ffffffff> <0000>\nendbfrange")
    expect(map.size).toBe(65_536)
  })

  it("rejects a Standard encryption dictionary when empty-password /U validation fails", () => {
    const encryption = dict({
      V: 1,
      R: 2,
      O: "o".repeat(32),
      U: "u".repeat(32),
      P: -44,
    })
    expect(() => readDocCrypto(encryption, "document-id")).toThrow(PdfEncryptedError)
  })
})
