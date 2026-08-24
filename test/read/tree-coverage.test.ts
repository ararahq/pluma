import { describe, expect, it } from "bun:test"
import { parseHtml, findAll, findFirst, textContent } from "../../src/read/html/tree.js"

describe("tree parser — table caption/colgroup edge modes", () => {
  it("should close a dangling caption when a table-section tag interrupts it", () => {
    const root = parseHtml("<table><caption>Cap<tbody><tr><td>x</td></tr></table>")
    const caption = findFirst(root, (el) => el.tag === "caption")
    const tbody = findFirst(root, (el) => el.tag === "tbody")
    expect(caption && textContent(caption)).toBe("Cap")
    expect(tbody).not.toBeNull()
  })

  it("should parse an explicit colgroup with col children", () => {
    const root = parseHtml("<table><colgroup><col><col></colgroup><tr><td>x</td></tr></table>")
    const colgroup = findFirst(root, (el) => el.tag === "colgroup")
    expect(colgroup?.children.filter((c) => c.type === "element" && c.tag === "col")).toHaveLength(2)
  })

  it("should implicitly close a colgroup when non-col content follows", () => {
    const root = parseHtml("<table><colgroup><col><tbody><tr><td>x</td></tr></tbody></table>")
    const table = findFirst(root, (el) => el.tag === "table")
    const tags = table?.children.filter((c) => c.type === "element").map((c: any) => c.tag)
    expect(tags).toContain("colgroup")
    expect(tags).toContain("tbody")
  })

  it("should treat an end tag col as a no-op", () => {
    const root = parseHtml("<table><colgroup><col></col></colgroup></table>")
    const colgroup = findFirst(root, (el) => el.tag === "colgroup")
    expect(colgroup?.children).toHaveLength(1)
  })
})

describe("tree parser — select inside table", () => {
  it("should close the select when a table cell boundary tag appears (in select in table mode)", () => {
    const root = parseHtml("<table><tr><td><select><option>a</select><td>b</table>")
    const cells = findAll(root, (el) => el.tag === "td")
    expect(cells).toHaveLength(2)
    const select = findFirst(root, (el) => el.tag === "select")
    expect(select).not.toBeNull()
  })

  it("should ignore a nested select start tag by closing the outer one", () => {
    const root = parseHtml("<select><option>a<select><option>b</select>")
    const selects = findAll(root, (el) => el.tag === "select")
    expect(selects).toHaveLength(1)
  })

  it("should close select and reprocess on input/keygen/textarea", () => {
    const root = parseHtml("<select><option>a</option><input><p>after</p>")
    const select = findFirst(root, (el) => el.tag === "select")
    const input = findFirst(root, (el) => el.tag === "input")
    const p = findFirst(root, (el) => el.tag === "p")
    expect(select).not.toBeNull()
    expect(input).not.toBeNull()
    expect(p && textContent(p)).toBe("after")
  })
})

describe("tree parser — misc constructs", () => {
  it("should parse dd/dt implicit closing inside dl", () => {
    const root = parseHtml("<dl><dt>Term<dd>Def<dt>Term2<dd>Def2</dl>")
    const dl = findFirst(root, (el) => el.tag === "dl")
    const tags = dl?.children.filter((c) => c.type === "element").map((c: any) => c.tag)
    expect(tags).toEqual(["dt", "dd", "dt", "dd"])
  })

  it("should handle optgroup auto-closing option", () => {
    const root = parseHtml("<select><optgroup><option>a<option>b</optgroup></select>")
    const optgroup = findFirst(root, (el) => el.tag === "optgroup")
    const options = optgroup?.children.filter((c) => c.type === "element" && c.tag === "option")
    expect(options).toHaveLength(2)
  })

  it("should parse rp/rt inside ruby", () => {
    const root = parseHtml("<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>")
    const rt = findFirst(root, (el) => el.tag === "rt")
    expect(rt && textContent(rt)).toBe("kan")
  })
})
