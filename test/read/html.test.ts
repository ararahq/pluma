import { describe, expect, it } from "bun:test"
import { marked } from "marked"
import { decodeEntities } from "../../src/read/html/entities.js"
import { parseHtml, textContent, findFirst } from "../../src/read/html/tree.js"
import { readHtml } from "../../src/read/html/index.js"
import { HtmlFetchError, HtmlLimitError, decodeHtmlBuffer } from "../../src/read/html/fetch.js"
import { truncateToTokens } from "../../src/read/html/markdown.js"

describe("entities", () => {
  it("should decode named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &mdash; caf&eacute;")).toBe("Tom & Jerry — café")
  })

  it("should decode decimal and hex numeric references", () => {
    expect(decodeEntities("&#65;&#x42;&#67;")).toBe("ABC")
  })

  it("should leave unknown entities untouched", () => {
    expect(decodeEntities("A&notarealentity;B")).toBe("A&notarealentity;B")
  })
})

describe("tree parser", () => {
  it("should tolerate unclosed and unquoted attributes", () => {
    const root = parseHtml(`<div class=box><p>hi<p>there</div>`)
    const div = findFirst(root, (el) => el.tag === "div")
    expect(div?.attrs.class).toBe("box")
    // two <p> auto-close each other
    expect(div?.children.filter((c) => c.type === "element" && c.tag === "p")).toHaveLength(2)
  })

  it("should build an implicit tbody for bare table rows", () => {
    const root = parseHtml(`<table><tr><td>a</td></tr></table>`)
    const table = findFirst(root, (el) => el.tag === "table")
    expect(table?.children[0].type === "element" && table.children[0].tag).toBe("tbody")
  })

  it("should treat li as implicitly closing a previous li", () => {
    const root = parseHtml(`<ul><li>one<li>two<li>three</ul>`)
    const ul = findFirst(root, (el) => el.tag === "ul")
    expect(ul?.children).toHaveLength(3)
  })

  it("should skip script and style content entirely from text extraction", () => {
    const root = parseHtml(`<div><script>var x = "<div>fake</div>";</script><style>.a{color:red}</style><p>real</p></div>`)
    const div = findFirst(root, (el) => el.tag === "div")
    expect(div && textContent(div).trim()).toBe("real")
  })

  it("should preserve pre content verbatim (no whitespace collapse at parse time)", () => {
    const root = parseHtml(`<pre>  line1\n    line2  </pre>`)
    const pre = findFirst(root, (el) => el.tag === "pre")
    expect(pre && textContent(pre)).toBe("  line1\n    line2  ")
  })

  it("should reconstruct active formatting elements across a block boundary (adoption agency)", () => {
    const root = parseHtml(`<b>1<p>2</b>3</p>`)
    const body = findFirst(root, (el) => el.tag === "body")
    expect(body && textContent(body)).toBe("123")
    const p = findFirst(root, (el) => el.tag === "p")
    const bInsideP = p && findFirst(p, (el) => el.tag === "b")
    expect(bInsideP?.tag).toBe("b")
  })

  it("should foster-parent misplaced content out of a table", () => {
    const root = parseHtml(`<table><tr><td>cell</td></tr>stray</table>`)
    const table = findFirst(root, (el) => el.tag === "table")
    const body = findFirst(root, (el) => el.tag === "body")
    expect(table && textContent(table)).toBe("cell")
    // "stray" text is foster-parented to just before the <table>, as a body-level sibling
    expect(body?.children.some((c) => c.type === "text" && c.text === "stray")).toBe(true)
  })

  it("should keep SVG content in its own namespace with corrected tag casing", () => {
    const root = parseHtml(`<svg><foreignObject></foreignObject></svg>`)
    const svg = findFirst(root, (el) => el.tag === "svg")
    expect(svg?.ns).toBe("svg")
    const fo = svg && findFirst(svg, (el) => el.ns === "svg" && el.tag === "foreignObject")
    expect(fo?.tag).toBe("foreignObject")
  })
})

describe("readHtml — article extraction", () => {
  const articlePage = `<!doctype html><html lang="pt-BR"><head>
<title>Título da Página</title>
<meta property="og:title" content="Como Fazer Café Coado">
<meta name="description" content="Guia completo de café coado.">
<meta name="author" content="Ana Souza">
<meta property="article:published_time" content="2026-01-15">
<link rel="canonical" href="https://blog.example.com/cafe-coado">
</head><body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li><a href="/sobre">Sobre</a></li></ul></nav>
<div class="cookie-banner">Usamos cookies para melhorar sua experiência. <a href="/privacidade">Saiba mais</a> <button>Aceitar</button></div>
<article>
<h1>Como Fazer Café Coado</h1>
<p>O café coado é um dos métodos mais simples de preparo e produz uma xícara limpa e equilibrada quando feito com atenção à proporção de água e café, à moagem e ao tempo total de extração.</p>
<h2>Ingredientes</h2>
<ul><li>30g de café moído médio-fino</li><li>500ml de água a 92-96°C</li></ul>
<h2>Passo a passo</h2>
<p>Despeje a água em movimentos circulares, começando pelo centro do filtro, respeitando o tempo de floração antes da extração principal.</p>
</article>
<footer class="site-footer"><div class="social-share">Compartilhe: <a href="#">Facebook</a> <a href="#">Twitter</a></div><p>© 2026 Blog Example. Todos os direitos reservados. Leia também nossos outros posts relacionados na seção de comentários abaixo.</p></footer>
</body></html>`

  it("should extract only the article, dropping nav/cookie-banner/footer/share", () => {
    const result = readHtml(articlePage, { baseUrl: "https://blog.example.com/cafe-coado" })
    expect(result.markdown).toContain("café coado é um dos métodos mais simples")
    expect(result.markdown).toContain("## Ingredientes")
    expect(result.markdown).not.toContain("Usamos cookies")
    expect(result.markdown).not.toContain("Compartilhe")
    expect(result.markdown).not.toContain("Home")
  })

  it("should extract title preferring og:title", () => {
    const result = readHtml(articlePage)
    expect(result.title).toBe("Como Fazer Café Coado")
  })

  it("should extract description, author, published date, canonical, lang", () => {
    const result = readHtml(articlePage, { baseUrl: "https://blog.example.com/cafe-coado" })
    expect(result.meta.description).toBe("Guia completo de café coado.")
    expect(result.meta.author).toBe("Ana Souza")
    expect(result.meta.published).toBe("2026-01-15")
    expect(result.meta.canonical).toBe("https://blog.example.com/cafe-coado")
    expect(result.meta.lang).toBe("pt-BR")
  })

  it("should not skip heading levels and should not rebase an already-h1-first doc", () => {
    const result = readHtml(articlePage)
    expect(result.markdown.split("\n").filter((l) => l.startsWith("# ")).length).toBeGreaterThan(0)
    expect(result.markdown).not.toContain("### ")
  })
})

describe("readHtml — docs page with sidebar and code", () => {
  const docsPage = `<!doctype html><html><head><title>API Reference</title></head><body>
<div class="sidebar"><nav><ul><li><a href="/docs/a">A</a></li><li><a href="/docs/b">B</a></li><li><a href="/docs/c">C</a></li></ul></nav></div>
<main role="main">
<h1>createWidget(options)</h1>
<p>Creates a new widget instance from the given options object and returns a handle you can use later to destroy it.</p>
<pre><code class="language-ts">function createWidget(options: WidgetOptions): Widget {
  return new WidgetImpl(options)
}</code></pre>
<h2>Parameters</h2>
<table>
<tr><th>Name</th><th>Type</th><th>Description</th></tr>
<tr><td>size</td><td>number</td><td>Widget size in pixels</td></tr>
</table>
</main>
</body></html>`

  it("should keep code fence with language and table, dropping sidebar nav", () => {
    const result = readHtml(docsPage)
    expect(result.markdown).toContain("```ts")
    expect(result.markdown).toContain("function createWidget")
    expect(result.markdown).toContain("| Name | Type | Description |")
    expect(result.markdown).not.toContain(">A</a")
    expect(result.markdown).not.toContain("[A](")
  })
})

describe("readHtml — tables with colspan and implicit thead/tbody", () => {
  it("should flatten colspan and infer header from first row without thead", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now ok.</p>
<table><tr><td colspan="2">Wide</td><td>C</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table></article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("| Wide |  | C |")
    expect(result.markdown).toContain("| 1 | 2 | 3 |")
  })
})

describe("readHtml — nested lists", () => {
  it("should render nested ordered/unordered lists with indentation", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now ok.</p>
<ol><li>first<ul><li>a</li><li>b</li></ul></li><li>second</li></ol></article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("1. first")
    expect(result.markdown).toContain("  - a")
    expect(result.markdown).toContain("2. second")
  })
})

describe("readHtml — broken HTML", () => {
  it("should recover from unclosed tags and produce valid markdown", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.
<p>Unclosed paragraph <b>bold text <i>italic too</p>
<div>Trailing div without proper close</article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("padding text")
    expect(result.markdown).toContain("**bold text")
  })
})

describe("readHtml — entities and charset", () => {
  it("should decode entities in the body", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p><p>Caf&eacute; &amp; Cr&ecirc;pe &mdash; R$ 10</p></article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("Café & Crêpe — R$ 10")
  })

  it("should decode a latin-1 buffer via decodeHtmlBuffer", () => {
    const latin1 = Buffer.from("<p>Caf\xe9</p>", "latin1")
    const html = decodeHtmlBuffer(new Uint8Array(latin1), "text/html; charset=iso-8859-1")
    expect(html).toContain("Café")
  })
})

describe("readHtml — landing page without article", () => {
  const html = `<!doctype html><html><body>
<header class="hero"><h1>Product Name</h1><p>Short tagline.</p><a href="/signup">Sign up</a></header>
<section><h2>Features</h2><p>Feature one description.</p></section>
<section><h2>Pricing</h2><p>Pricing description text.</p></section>
</body></html>`

  it("should keep heading hierarchy even without a single dominant article candidate", () => {
    const result = readHtml(html)
    expect(result.markdown).toContain("# Product Name")
    expect(result.markdown).toContain("## Features")
    expect(result.markdown).toContain("## Pricing")
  })

  it("should warn about the page-mode fallback when readability is disabled and nothing scores high", () => {
    const tiny = `<!doctype html><html><body><nav><a href="/">x</a></nav></body></html>`
    const result = readHtml(tiny, { readability: false })
    expect(result.warnings.some((w) => w.includes("page mode"))).toBe(true)
  })
})

describe("readHtml — JSON-LD Article", () => {
  it("should parse JSON-LD and surface it in meta.jsonLd", () => {
    const html = `<!doctype html><html><head>
<script type="application/ld+json">{"@type":"Article","headline":"Headline","author":{"name":"Jane Doe"},"datePublished":"2026-02-01"}</script>
</head><body><article><p>padding text so the article scores well above threshold for extraction purposes here now.</p></article></body></html>`
    const result = readHtml(html)
    expect(result.meta.jsonLd).toBeDefined()
    expect((result.meta.jsonLd as any[])[0]).toMatchObject({ headline: "Headline" })
    expect(result.meta.author).toBe("Jane Doe")
    expect(result.meta.published).toBe("2026-02-01")
  })
})

describe("readHtml — relative links with <base href>", () => {
  it("should resolve relative links and images against <base href>", () => {
    const html = `<!doctype html><html><head><base href="https://cdn.example.com/docs/"></head><body>
<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<p><a href="guide.html">Guide</a></p><img src="pic.png" alt="pic"></article></body></html>`
    const result = readHtml(html)
    expect(result.markdown).toContain("[Guide](https://cdn.example.com/docs/guide.html)")
    expect(result.markdown).toContain("![pic](https://cdn.example.com/docs/pic.png)")
  })
})

describe("readHtml — <pre> preserves internal spacing", () => {
  it("should not collapse whitespace inside pre/code blocks", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<pre><code>function foo() {
  return   1;
}</code></pre></article>`
    const result = readHtml(html, { mode: "article" })
    expect(result.markdown).toContain("function foo() {\n  return   1;\n}")
  })
})

describe("readHtml — size limits", () => {
  it("should still process a large synthetic document without throwing", () => {
    const paragraphs = Array.from({ length: 20000 }, (_, i) => `<p>Paragraph number ${i} with some filler text to pad it out.</p>`).join("\n")
    const html = `<article>${paragraphs}</article>`
    const result = readHtml(html)
    expect(result.wordCount).toBeGreaterThan(100000)
  })
})

describe("readHtml — options", () => {
  const base = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p><p><a href="/x">link</a></p><img src="/a.png" alt="a"></article>`

  it("should drop images when images:false", () => {
    const result = readHtml(base, { images: false })
    expect(result.markdown).not.toContain("![")
  })

  it("should keep link text but not markdown link syntax when links:false", () => {
    const result = readHtml(base, { links: false, images: false })
    expect(result.markdown).toContain("link")
    expect(result.markdown).not.toContain("](")
  })

  it("should prepend YAML front matter when frontMatter:true", () => {
    const html = `<!doctype html><html><head><title>T</title></head><body>${base}</body></html>`
    const result = readHtml(html, { frontMatter: true, baseUrl: "https://x.example/p" })
    expect(result.markdown.startsWith("---\n")).toBe(true)
    expect(result.markdown).toContain("url: https://x.example/p")
  })

  it("should truncate to roughly maxTokens tokens at a block boundary", () => {
    const long = Array.from({ length: 200 }, (_, i) => `<p>Sentence number ${i} in the article body.</p>`).join("")
    const result = readHtml(`<article>${long}</article>`, { maxTokens: 50 })
    expect(result.markdown.length).toBeLessThan(400)
    expect(result.warnings.some((w) => w.includes("Truncated"))).toBe(true)
  })

  it("should respect dropSelectors with class/id/attr/tag forms", () => {
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<div class="ad">buy now</div><div id="promo">promo</div><div data-x="1">tagged</div><span>keep me</span></article>`
    const result = readHtml(html, { dropSelectors: [".ad", "#promo", "[data-x]"] })
    expect(result.markdown).not.toContain("buy now")
    expect(result.markdown).not.toContain("promo")
    expect(result.markdown).not.toContain("tagged")
    expect(result.markdown).toContain("keep me")
  })
})

describe("HtmlFetchError / HtmlLimitError", () => {
  it("should carry status and url on HtmlFetchError", () => {
    const err = new HtmlFetchError("boom", "https://x.test", 500)
    expect(err.status).toBe(500)
    expect(err.url).toBe("https://x.test")
    expect(err.name).toBe("HtmlFetchError")
  })

  it("should be a distinct error type for limit violations", () => {
    const err = new HtmlLimitError("too big")
    expect(err.name).toBe("HtmlLimitError")
  })
})

describe("round-trip: markdown -> marked -> HTML -> readHtml -> markdown", () => {
  it("should preserve headings, lists, code, links, tables through a round trip", () => {
    const original = [
      "# Title",
      "",
      "A paragraph with **bold** and _italic_ text plus a [link](https://example.com/y).",
      "",
      "## Section",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ].join("\n")

    const html = marked.parse(original, { async: false }) as string
    const wrapped = `<article>${html}</article>`
    const result = readHtml(wrapped, { mode: "article" })

    expect(result.markdown).toContain("# Title")
    expect(result.markdown).toContain("## Section")
    expect(result.markdown).toContain("**bold**")
    expect(result.markdown).toContain("_italic_")
    expect(result.markdown).toContain("[link](https://example.com/y)")
    expect(result.markdown).toContain("- one")
    expect(result.markdown).toContain("```js")
    expect(result.markdown).toContain("const x = 1;")
    expect(result.markdown).toContain("| A | B |")
    expect(result.markdown).toContain("| 1 | 2 |")
  })
})

describe("truncateToTokens", () => {
  it("should return input unchanged when under the limit", () => {
    expect(truncateToTokens("hello world", 1000)).toBe("hello world")
  })

  it("should cut at a blank-line boundary when over the limit", () => {
    const text = "a".repeat(100) + "\n\n" + "b".repeat(100)
    const truncated = truncateToTokens(text, 26)
    expect(truncated.trim()).toBe("a".repeat(100))
  })
})
