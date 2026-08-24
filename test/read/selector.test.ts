import { describe, expect, it } from "bun:test"
import { parseHtml, findAll, findFirst, type ElementNode } from "../../src/read/html/tree.js"
import { compileSelector, elementMatches } from "../../src/read/html/selector.js"

function selectAll(html: string, selector: string): ElementNode[] {
  const root = parseHtml(html)
  const compiled = compileSelector(selector)
  return findAll(root, (el) => elementMatches(el, compiled))
}

describe("selector — simple selectors", () => {
  it("should match by tag", () => {
    const root = parseHtml("<div><p>a</p><span>b</span></div>")
    const compiled = compileSelector("p")
    const matches = findAll(root, (el) => elementMatches(el, compiled))
    expect(matches).toHaveLength(1)
    expect(matches[0].tag).toBe("p")
  })

  it("should match by class", () => {
    const matches = selectAll(`<div class="a b"></div><div class="c"></div>`, ".a")
    expect(matches).toHaveLength(1)
  })

  it("should match by id", () => {
    const matches = selectAll(`<div id="x"></div><div id="y"></div>`, "#y")
    expect(matches).toHaveLength(1)
    expect(matches[0].attrs.id).toBe("y")
  })

  it("should match [attr] presence", () => {
    const matches = selectAll(`<a href="/x"></a><a></a>`, "[href]")
    expect(matches).toHaveLength(1)
  })

  it("should match [attr=value]", () => {
    const matches = selectAll(`<input type="hidden"><input type="text">`, '[type="hidden"]')
    expect(matches).toHaveLength(1)
    expect(matches[0].attrs.type).toBe("hidden")
  })

  it("should match [attr^=value] (prefix)", () => {
    const matches = selectAll(`<a href="/docs/a"></a><a href="/blog/b"></a>`, '[href^="/docs"]')
    expect(matches).toHaveLength(1)
  })

  it("should match [attr$=value] (suffix)", () => {
    const matches = selectAll(`<a href="/x.pdf"></a><a href="/x.html"></a>`, '[href$=".pdf"]')
    expect(matches).toHaveLength(1)
  })

  it("should match [attr*=value] (contains)", () => {
    const matches = selectAll(`<div class="ad-banner"></div><div class="content"></div>`, '[class*="ad"]')
    expect(matches).toHaveLength(1)
  })

  it("should combine multiple simple parts on one compound (tag.class#id)", () => {
    const matches = selectAll(`<div class="x" id="y"></div><span class="x"></span>`, "div.x#y")
    expect(matches).toHaveLength(1)
    expect(matches[0].tag).toBe("div")
  })
})

describe("selector — combinators", () => {
  it("should match descendant combinator (space)", () => {
    const matches = selectAll(`<article><div><p>a</p></div></article><p>b</p>`, "article p")
    expect(matches).toHaveLength(1)
  })

  it("should match child combinator (>)", () => {
    const matches = selectAll(`<article><p>a</p></article><article><div><p>b</p></div></article>`, "article > p")
    expect(matches).toHaveLength(1)
  })

  it("should match adjacent sibling combinator (+)", () => {
    const matches = selectAll(`<h2>t</h2><p>a</p><p>b</p>`, "h2 + p")
    expect(matches).toHaveLength(1)
  })

  it("should match general sibling combinator (~)", () => {
    const matches = selectAll(`<h2>t</h2><div></div><p>a</p><p>b</p>`, "h2 ~ p")
    expect(matches).toHaveLength(2)
  })

  it("should support comma-separated selector lists", () => {
    const matches = selectAll(`<div class="ad"></div><div class="promo"></div><div class="ok"></div>`, ".ad, .promo")
    expect(matches).toHaveLength(2)
  })

  it("should support nested combinators (descendant + child)", () => {
    const html = `<main><section><ul><li class="x">a</li></ul></section></main><ul><li class="x">b</li></ul>`
    const matches = selectAll(html, "main ul > li.x")
    expect(matches).toHaveLength(1)
  })
})

describe("selector — pseudo-classes", () => {
  it("should match :not()", () => {
    const matches = selectAll(`<div class="ad"></div><div class="content"></div>`, "div:not(.ad)")
    expect(matches).toHaveLength(1)
    expect(matches[0].attrs.class).toBe("content")
  })

  it("should match :first-child", () => {
    const root = parseHtml(`<ul><li>a</li><li>b</li><li>c</li></ul>`)
    const compiled = compileSelector("li:first-child")
    const matches = findAll(root, (el) => elementMatches(el, compiled))
    expect(matches).toHaveLength(1)
    expect((matches[0].children[0] as any).text).toBe("a")
  })

  it("should match :last-child", () => {
    const root = parseHtml(`<ul><li>a</li><li>b</li><li>c</li></ul>`)
    const compiled = compileSelector("li:last-child")
    const matches = findAll(root, (el) => elementMatches(el, compiled))
    expect(matches).toHaveLength(1)
    expect((matches[0].children[0] as any).text).toBe("c")
  })

  it("should match :nth-child(an+b) — odd", () => {
    const root = parseHtml(`<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>`)
    const compiled = compileSelector("li:nth-child(odd)")
    const matches = findAll(root, (el) => elementMatches(el, compiled))
    expect(matches.map((m) => (m.children[0] as any).text)).toEqual(["1", "3"])
  })

  it("should match :nth-child(an+b) — 2n+1 and even", () => {
    const root = parseHtml(`<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>`)
    const odd = findAll(root, (el) => elementMatches(el, compileSelector("li:nth-child(2n+1)")))
    const even = findAll(root, (el) => elementMatches(el, compileSelector("li:nth-child(even)")))
    expect(odd.map((m) => (m.children[0] as any).text)).toEqual(["1", "3"])
    expect(even.map((m) => (m.children[0] as any).text)).toEqual(["2", "4"])
  })

  it("should match :nth-child(3) exact index", () => {
    const root = parseHtml(`<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>`)
    const matches = findAll(root, (el) => elementMatches(el, compileSelector("li:nth-child(3)")))
    expect(matches).toHaveLength(1)
    expect((matches[0].children[0] as any).text).toBe("3")
  })
})

describe("selector — integration with readHtml keep/dropSelectors", () => {
  it("should drop elements matching a combinator selector", async () => {
    const { readHtml } = await import("../../src/read/html/index.js")
    const html = `<article><p>padding text so the article scores well above threshold for extraction purposes here now.</p>
<div class="promo"><p>Buy now</p></div><div class="content"><p>Real content</p></div></article>`
    const result = readHtml(html, { dropSelectors: [".promo"] })
    expect(result.markdown).not.toContain("Buy now")
    expect(result.markdown).toContain("Real content")
  })
})
