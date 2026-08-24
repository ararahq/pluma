import { describe, expect, it, afterAll } from "bun:test"
import { gzipSync } from "node:zlib"
import { readHtml } from "../../src/read/html/index.js"
import { fetchHtml, HtmlFetchError, HtmlLimitError } from "../../src/read/html/fetch.js"
import { tokenize } from "../../src/read/html/tokenizer.js"

describe("readHtml — dl/figure/details/sup/sub/hr", () => {
  it("should render definition lists, figures, details, and sup/sub", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<dl><dt>Term</dt><dd>Definition text</dd></dl>
<figure><img src="/x.png" alt="a photo"><figcaption>A caption</figcaption></figure>
<details><summary>More info</summary><p>Hidden content revealed.</p></details>
<p>E=mc<sup>2</sup> and H<sub>2</sub>O</p>
<hr>
</article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("**Term**")
    expect(result.markdown).toContain(": Definition text")
    expect(result.markdown).toContain("![a photo](/x.png)")
    expect(result.markdown).toContain("*A caption*")
    expect(result.markdown).toContain("**More info**")
    expect(result.markdown).toContain("Hidden content revealed.")
    expect(result.markdown).toContain("^2^")
    expect(result.markdown).toContain("~2~")
    expect(result.markdown).toContain("---")
  })

  it("should number ordered lists starting from a custom start attribute", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<ol start="5"><li>five</li><li>six</li></ol></article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("5. five")
    expect(result.markdown).toContain("6. six")
  })
})

describe("tokenizer — CDATA, comments, doctype", () => {
  it("should surface CDATA content as text and skip comments", () => {
    const tokens = [...tokenize(`<!doctype html><!-- hidden --><p><![CDATA[raw]]>text</p>`)]
    expect(tokens.some((t) => t.kind === "doctype")).toBe(true)
    expect(tokens.some((t) => t.kind === "comment")).toBe(true)
    const texts = tokens.filter((t) => t.kind === "text").map((t) => (t as { text: string }).text)
    expect(texts.join("")).toContain("raw")
    expect(texts.join("")).toContain("text")
  })

  it("should self-close void tags without consuming following siblings", () => {
    const tokens = [...tokenize(`<img src="a.png"/><p>after</p>`)]
    const start = tokens.find((t) => t.kind === "start" && t.tag === "img")
    expect(start && start.kind === "start" && start.selfClosing).toBe(true)
  })
})

describe("fetchHtml — local server", () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/plain") {
        return new Response("<html><body><article><p>hello from server padding text long enough here now.</p></article></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/plain" } })
      }
      if (url.pathname === "/redirect-loop") {
        return new Response(null, { status: 302, headers: { location: "/redirect-loop" } })
      }
      if (url.pathname === "/big") {
        return new Response("x".repeat(1024 * 1024), { headers: { "content-type": "text/html" } })
      }
      if (url.pathname === "/gzip") {
        const body = gzipSync(Buffer.from("<html><body><article><p>gzip content padding text long enough here now.</p></article></body></html>"))
        return new Response(body, { headers: { "content-type": "text/html", "content-encoding": "gzip" } })
      }
      if (url.pathname === "/slow") {
        return new Promise((resolve) => {
          setTimeout(() => resolve(new Response("<html></html>")), 500)
        })
      }
      if (url.pathname === "/error") {
        return new Response("nope", { status: 500 })
      }
      return new Response("not found", { status: 404 })
    },
  })

  afterAll(() => server.stop(true))

  const base = (path: string) => `http://localhost:${server.port}${path}`

  it("should fetch and decode a plain HTML page", async () => {
    const { html, url } = await fetchHtml(base("/plain"), { networkPolicy: "any" })
    expect(html).toContain("hello from server")
    expect(url).toContain("/plain")
  })

  it("should follow redirects", async () => {
    const { html } = await fetchHtml(base("/redirect"), { networkPolicy: "any" })
    expect(html).toContain("hello from server")
  })

  it("should throw HtmlFetchError after too many redirects", async () => {
    await expect(fetchHtml(base("/redirect-loop"), { maxRedirects: 2, networkPolicy: "any" })).rejects.toBeInstanceOf(HtmlFetchError)
  })

  it("should throw HtmlFetchError on non-2xx status", async () => {
    await expect(fetchHtml(base("/error"), { networkPolicy: "any" })).rejects.toBeInstanceOf(HtmlFetchError)
  })

  it("should throw HtmlLimitError when exceeding maxBytes", async () => {
    await expect(fetchHtml(base("/big"), { maxBytes: 1024, networkPolicy: "any" })).rejects.toBeInstanceOf(HtmlLimitError)
  })

  it("should decode gzip-compressed responses transparently", async () => {
    const { html } = await fetchHtml(base("/gzip"), { networkPolicy: "any" })
    expect(html).toContain("gzip content")
  })

  it("should abort with HtmlFetchError after the timeout elapses", async () => {
    await expect(fetchHtml(base("/slow"), { timeoutMs: 30, networkPolicy: "any" })).rejects.toBeInstanceOf(HtmlFetchError)
  })
})
