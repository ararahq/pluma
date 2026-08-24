import { tokenize, type Token } from "./tokenizer.js"

export type Namespace = "svg" | "math"

export interface ElementNode {
  type: "element"
  tag: string
  ns?: Namespace
  attrs: Record<string, string>
  children: Node[]
  parent: ElementNode | null
}

export interface TextNode {
  type: "text"
  text: string
  parent: ElementNode | null
}

export interface CommentNode {
  type: "comment"
  text: string
  parent: ElementNode | null
}

export interface DoctypeNode {
  type: "doctype"
  name: string
  publicId?: string
  systemId?: string
  parent: ElementNode | null
}

export type Node = ElementNode | TextNode | CommentNode | DoctypeNode

export class HtmlTreeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HtmlTreeLimitError"
  }
}

export interface ParseHtmlOptions {
  maxNodes?: number
  maxDepth?: number
}

const DEFAULT_MAX_TREE_NODES = 250_000
const DEFAULT_MAX_TREE_DEPTH = 256

export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

const FORMATTING_TAGS = new Set([
  "a", "b", "big", "code", "em", "font", "i", "nobr",
  "s", "small", "strike", "strong", "tt", "u",
])

/** HTML5 "special" category — the elements that stop the adoption-agency
 * furthest-block search and bound scope lookups. */
const SPECIAL_TAGS = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont",
  "bgsound", "blockquote", "body", "br", "button", "caption", "center",
  "col", "colgroup", "dd", "details", "dir", "div", "dl", "dt", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr",
  "html", "iframe", "img", "input", "isindex", "li", "link", "listing",
  "main", "marquee", "menu", "meta", "nav", "noembed", "noframes",
  "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script",
  "section", "select", "source", "style", "summary", "table", "tbody",
  "td", "template", "textarea", "tfoot", "th", "thead", "title", "tr",
  "track", "ul", "wbr",
])

const DEFAULT_SCOPE_STOPPERS = new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"])
const LIST_ITEM_SCOPE_EXTRA = new Set(["ol", "ul"])
const BUTTON_SCOPE_EXTRA = new Set(["button"])
const TABLE_SCOPE_STOPPERS = new Set(["html", "table", "template"])

const IMPLIED_END_TAGS = new Set(["dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc"])

const HEAD_RAW_TAGS = new Set(["base", "basefont", "bgsound", "link", "meta", "noframes", "style", "title"])
const TABLE_VOID_START = new Set(["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"])

/** SVG tag names whose canonical casing our lowercase-only tokenizer loses. */
const SVG_TAG_CASING: Record<string, string> = {
  altglyph: "altGlyph", altglyphdef: "altGlyphDef", altglyphitem: "altGlyphItem",
  animatecolor: "animateColor", animatemotion: "animateMotion", animatetransform: "animateTransform",
  clippath: "clipPath", feblend: "feBlend", fecolormatrix: "feColorMatrix",
  fecomponenttransfer: "feComponentTransfer", fecomposite: "feComposite",
  feconvolvematrix: "feConvolveMatrix", fediffuselighting: "feDiffuseLighting",
  fedisplacementmap: "feDisplacementMap", fedistantlight: "feDistantLight",
  fedropshadow: "feDropShadow", feflood: "feFlood", fefunca: "feFuncA",
  fefuncb: "feFuncB", fefuncg: "feFuncG", fefuncr: "feFuncR",
  fegaussianblur: "feGaussianBlur", feimage: "feImage", femerge: "feMerge",
  femergenode: "feMergeNode", femorphology: "feMorphology", feoffset: "feOffset",
  fepointlight: "fePointLight", fespecularlighting: "feSpecularLighting",
  fespotlight: "feSpotLight", fetile: "feTile", feturbulence: "feTurbulence",
  foreignobject: "foreignObject", glyphref: "glyphRef",
  lineargradient: "linearGradient", radialgradient: "radialGradient", textpath: "textPath",
}

const BREAKOUT_TAGS = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt",
  "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li",
  "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span",
  "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var",
])

type Mode =
  | "initial" | "before html" | "before head" | "in head" | "after head" | "in body" | "text"
  | "in table" | "in caption" | "in column group" | "in table body" | "in row" | "in cell"
  | "in select" | "in select in table" | "after body" | "after after body"

const AFE_MARKER = Symbol("marker")
type AfeEntry = ElementNode | typeof AFE_MARKER

/** HTML5-ish tree construction: implements the insertion-mode state machine,
 * active-formatting-element reconstruction, the adoption agency algorithm,
 * foster parenting for misplaced table content, and enough foreign-content
 * handling (SVG/MathML namespaces + integration points) to keep those
 * subtrees intact for metadata extraction. Not a full spec implementation —
 * see README "Tree construction" for the documented gaps (templates,
 * <iframe>/<noembed>/<xmp> raw-text parsing, quirks-mode doctype details).
 */
class TreeBuilder {
  readonly root: ElementNode = { type: "element", tag: "#document", attrs: {}, children: [], parent: null }
  private stack: ElementNode[] = []
  private afe: AfeEntry[] = []
  private mode: Mode = "initial"
  private originalMode: Mode = "in body"
  private headElement: ElementNode | null = null
  private formElement: ElementNode | null = null
  private fosterParenting = false
  private skipNextLeadingNewline = false
  private pendingTableText: string[] = []
  private pendingTableHasNonWhitespace = false
  private nodeCount = 1
  private readonly maxNodes: number
  private readonly maxDepth: number

  constructor(options: ParseHtmlOptions = {}) {
    this.maxNodes = positiveLimit(options.maxNodes ?? DEFAULT_MAX_TREE_NODES, "maxNodes")
    this.maxDepth = positiveLimit(options.maxDepth ?? DEFAULT_MAX_TREE_DEPTH, "maxDepth")
  }

  private allocateNode(): void {
    this.nodeCount++
    if (this.nodeCount > this.maxNodes) {
      throw new HtmlTreeLimitError(`HTML tree exceeds maxNodes (${this.maxNodes})`)
    }
  }

  private pushOpenElement(el: ElementNode): void {
    if (this.stack.length >= this.maxDepth) {
      throw new HtmlTreeLimitError(`HTML tree exceeds maxDepth (${this.maxDepth})`)
    }
    this.stack.push(el)
  }

  private current(): ElementNode {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.root
  }

  private createElement(tag: string, attrs: Record<string, string>, ns?: Namespace): ElementNode {
    this.allocateNode()
    const canonicalTag = ns === "svg" ? (SVG_TAG_CASING[tag] ?? tag) : tag
    const adjustedAttrs = ns ? adjustForeignAttrs(ns === "math" ? adjustMathAttrs(attrs) : attrs) : attrs
    return { type: "element", tag: canonicalTag, ns, attrs: adjustedAttrs, children: [], parent: null }
  }

  private appendChild(parent: ElementNode, node: Node): void {
    node.parent = parent
    parent.children.push(node)
  }

  private lastElementOfTag(tags: Set<string>): ElementNode | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (!this.stack[i].ns && tags.has(this.stack[i].tag)) return this.stack[i]
    }
    return null
  }

  /** Foster-parenting-aware insertion point: table content misplaced by a
   * broken document gets inserted right before the nearest open <table>. */
  private insertionParent(): { parent: ElementNode; index?: number } {
    if (!this.fosterParenting) return { parent: this.current() }
    const currentTag = this.current().tag
    if (!TABLE_VOID_START.has(currentTag) && currentTag !== "table") return { parent: this.current() }
    const table = this.lastElementOfTag(new Set(["table"]))
    if (!table || !table.parent) return { parent: this.current() }
    const index = table.parent.children.indexOf(table)
    return { parent: table.parent, index }
  }

  private insertNode(node: Node): void {
    const { parent, index } = this.insertionParent()
    node.parent = parent
    if (index === undefined) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  }

  private insertElement(tag: string, attrs: Record<string, string>, ns?: Namespace): ElementNode {
    const el = this.createElement(tag, attrs, ns)
    this.insertNode(el)
    this.pushOpenElement(el)
    return el
  }

  private insertVoidElement(tag: string, attrs: Record<string, string>, ns?: Namespace): ElementNode {
    const el = this.createElement(tag, attrs, ns)
    this.insertNode(el)
    return el
  }

  private insertText(text: string): void {
    if (this.skipNextLeadingNewline) {
      this.skipNextLeadingNewline = false
      if (text.startsWith("\n")) text = text.slice(1)
    }
    if (!text) return
    const { parent, index } = this.insertionParent()
    const siblings = parent.children
    const target = index === undefined ? siblings[siblings.length - 1] : siblings[index - 1]
    if (target && target.type === "text" && (index === undefined || siblings[index - 1] === target)) {
      target.text += text
      return
    }
    const node: TextNode = { type: "text", text, parent }
    this.allocateNode()
    if (index === undefined) siblings.push(node)
    else siblings.splice(index, 0, node)
  }

  private insertComment(text: string, parent: ElementNode = this.current()): void {
    this.allocateNode()
    this.appendChild(parent, { type: "comment", text, parent: null })
  }

  // ---- scope -------------------------------------------------------------

  /** MathML/SVG elements that also bound scope per spec (in addition to the
   * HTML-namespace default stoppers). */
  private isForeignScopeStopper(node: ElementNode): boolean {
    if (node.ns === "math") return ["mi", "mo", "mn", "ms", "mtext", "annotation-xml"].includes(node.tag)
    if (node.ns === "svg") return ["foreignObject", "desc", "title"].includes(node.tag)
    return false
  }

  private hasInScope(tag: string, extraStoppers: Set<string> = new Set()): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i]
      if (!node.ns && node.tag === tag) return true
      if (this.isForeignScopeStopper(node)) return false
      if (node.ns) continue
      if (DEFAULT_SCOPE_STOPPERS.has(node.tag) || extraStoppers.has(node.tag)) return false
    }
    return false
  }

  private hasInButtonScope(tag: string): boolean {
    return this.hasInScope(tag, BUTTON_SCOPE_EXTRA)
  }

  private hasInListItemScope(tag: string): boolean {
    return this.hasInScope(tag, LIST_ITEM_SCOPE_EXTRA)
  }

  private hasInTableScope(tag: string): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i]
      if (!node.ns && node.tag === tag) return true
      if (!node.ns && TABLE_SCOPE_STOPPERS.has(node.tag)) return false
    }
    return false
  }

  private generateImpliedEndTags(except?: string): void {
    while (IMPLIED_END_TAGS.has(this.current().tag) && this.current().tag !== except) {
      this.stack.pop()
    }
  }

  private popUntilTagPopped(tag: string): void {
    while (this.stack.length > 0) {
      const popped = this.stack.pop()
      if (popped && popped.tag === tag) break
    }
  }

  private popUntilElementPopped(el: ElementNode): void {
    while (this.stack.length > 0) {
      const popped = this.stack.pop()
      if (popped === el) break
    }
  }

  private clearStackBackToTableContext(tags: Set<string>): void {
    while (this.stack.length > 0 && !tags.has(this.current().tag)) this.stack.pop()
  }

  // ---- active formatting elements ----------------------------------------

  private pushMarker(): void {
    this.afe.push(AFE_MARKER)
  }

  private pushFormatting(el: ElementNode): void {
    let countSinceMarker = 0
    for (let i = this.afe.length - 1; i >= 0; i--) {
      const entry = this.afe[i]
      if (entry === AFE_MARKER) break
      if (sameFormattingElement(entry, el)) {
        countSinceMarker++
        if (countSinceMarker === 3) {
          this.afe.splice(i, 1)
          break
        }
      }
    }
    this.afe.push(el)
  }

  private reconstructActiveFormatting(): void {
    if (this.afe.length === 0) return
    const last = this.afe[this.afe.length - 1]
    if (last === AFE_MARKER || this.stack.includes(last)) return

    let index = this.afe.length - 1
    for (;;) {
      if (index === 0) break
      index--
      const entry = this.afe[index]
      if (entry === AFE_MARKER || this.stack.includes(entry)) {
        index++
        break
      }
    }

    for (let i = index; i < this.afe.length; i++) {
      const entry = this.afe[i]
      if (entry === AFE_MARKER) continue
      const clone = this.createElement(entry.tag, { ...entry.attrs }, entry.ns)
      this.insertNode(clone)
      this.pushOpenElement(clone)
      this.afe[i] = clone
    }
  }

  private clearAfeToMarker(): void {
    while (this.afe.length > 0) {
      const entry = this.afe.pop()
      if (entry === AFE_MARKER) break
    }
  }

  /** The adoption agency algorithm (WHATWG 13.2.6.4.7), bounded per spec. */
  private adoptionAgency(subject: string): void {
    if (this.current().tag === subject && !this.current().ns && !this.afe.includes(this.current())) {
      this.stack.pop()
      return
    }

    for (let outer = 0; outer < 8; outer++) {
      let feIndex = -1
      for (let i = this.afe.length - 1; i >= 0; i--) {
        const entry = this.afe[i]
        if (entry === AFE_MARKER) break
        if (!entry.ns && entry.tag === subject) {
          feIndex = i
          break
        }
      }
      if (feIndex === -1) {
        this.closeViaAnyOtherEndTag(subject)
        return
      }
      const formattingElement = this.afe[feIndex] as ElementNode
      const feStackIndex = this.stack.indexOf(formattingElement)
      if (feStackIndex === -1) {
        this.afe.splice(feIndex, 1)
        return
      }
      if (!this.hasInScope(subject)) return

      let furthestBlock: ElementNode | null = null
      let furthestBlockIndex = -1
      for (let i = feStackIndex + 1; i < this.stack.length; i++) {
        if (SPECIAL_TAGS.has(this.stack[i].tag) && !this.stack[i].ns) {
          furthestBlock = this.stack[i]
          furthestBlockIndex = i
          break
        }
      }
      if (!furthestBlock) {
        this.stack.length = feStackIndex
        this.afe.splice(feIndex, 1)
        return
      }

      const commonAncestor = this.stack[feStackIndex - 1] ?? this.root
      let bookmark = feIndex + 1
      let node = furthestBlock
      let lastNode: ElementNode = furthestBlock
      let nodeIndex = furthestBlockIndex

      for (let inner = 0; inner < 3; inner++) {
        nodeIndex--
        if (nodeIndex < 0) break
        node = this.stack[nodeIndex]
        if (node === formattingElement) break
        const nodeAfeIndex = this.afe.indexOf(node)
        if (nodeAfeIndex === -1) {
          this.stack.splice(nodeIndex, 1)
          furthestBlockIndex--
          nodeIndex++
          continue
        }
        const clone = this.createElement(node.tag, { ...node.attrs }, node.ns)
        this.afe[nodeAfeIndex] = clone
        this.stack[nodeIndex] = clone
        node = clone
        if (lastNode === furthestBlock) bookmark = nodeAfeIndex + 1
        this.removeFromParent(lastNode)
        this.appendChild(node, lastNode)
        lastNode = node
      }

      this.removeFromParent(lastNode)
      if (this.fosterParenting && TABLE_VOID_START.has(commonAncestor.tag)) {
        const { parent, index } = this.insertionParent()
        lastNode.parent = parent
        if (index === undefined) parent.children.push(lastNode)
        else parent.children.splice(index, 0, lastNode)
      } else {
        this.appendChild(commonAncestor, lastNode)
      }

      const newFormatting = this.createElement(formattingElement.tag, { ...formattingElement.attrs }, formattingElement.ns)
      newFormatting.children = furthestBlock.children
      for (const child of newFormatting.children) child.parent = newFormatting
      furthestBlock.children = [newFormatting]
      newFormatting.parent = furthestBlock

      const removeAt = this.afe.indexOf(formattingElement)
      if (removeAt !== -1) this.afe.splice(removeAt, 1)
      this.afe.splice(Math.min(bookmark, this.afe.length), 0, newFormatting)

      const stackRemoveAt = this.stack.indexOf(formattingElement)
      if (stackRemoveAt !== -1) this.stack.splice(stackRemoveAt, 1)
      const blockIndex = this.stack.indexOf(furthestBlock)
      this.stack.splice(blockIndex + 1, 0, newFormatting)
    }
  }

  private removeFromParent(node: ElementNode): void {
    if (!node.parent) return
    const idx = node.parent.children.indexOf(node)
    if (idx !== -1) node.parent.children.splice(idx, 1)
  }

  private closeViaAnyOtherEndTag(tag: string): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i]
      if (node.tag === tag) {
        this.generateImpliedEndTags(tag)
        this.stack.length = i
        return
      }
      if (!node.ns && SPECIAL_TAGS.has(node.tag)) return
    }
  }

  private resetInsertionMode(): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i]
      if (node.ns) continue
      switch (node.tag) {
        case "select": {
          const inTable = this.stack.slice(0, i).some((n) => !n.ns && n.tag === "table")
          this.mode = inTable ? "in select in table" : "in select"
          return
        }
        case "td":
        case "th":
          this.mode = "in cell"
          return
        case "tr":
          this.mode = "in row"
          return
        case "tbody":
        case "thead":
        case "tfoot":
          this.mode = "in table body"
          return
        case "caption":
          this.mode = "in caption"
          return
        case "table":
          this.mode = "in table"
          return
        case "body":
          this.mode = "in body"
          return
        case "html":
          this.mode = this.headElement ? "after head" : "before head"
          return
      }
    }
    this.mode = "in body"
  }

  // ---- foreign content -----------------------------------------------------

  private isIntegrationPoint(node: ElementNode): boolean {
    if (node.ns === "svg") return node.tag === "foreignObject" || node.tag === "desc" || node.tag === "title"
    if (node.ns === "math") {
      if (["mi", "mo", "mn", "ms", "mtext"].includes(node.tag)) return true
      if (node.tag === "annotation-xml") {
        const encoding = (node.attrs.encoding ?? "").toLowerCase()
        return encoding === "text/html" || encoding === "application/xhtml+xml"
      }
    }
    return false
  }

  private processForeignStart(token: Extract<Token, { kind: "start" }>): void {
    // "svg"/"math" re-adjust the namespace even while already inside foreign
    // content (e.g. <math><annotation-xml><svg>...</svg></annotation-xml></math>).
    const ns: Namespace = token.tag === "svg" ? "svg" : token.tag === "math" ? "math" : (this.current().ns as Namespace)
    if (token.selfClosing) {
      this.insertVoidElement(token.tag, token.attrs, ns)
      return
    }
    this.insertElement(token.tag, token.attrs, ns)
  }

  private processForeignEnd(token: Extract<Token, { kind: "end" }>): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i]
      const matches = node.ns ? node.tag.toLowerCase() === token.tag : node.tag === token.tag
      if (matches) {
        this.stack.length = i
        return
      }
      if (!node.ns) {
        this.dispatchByMode(token)
        return
      }
    }
  }

  // ---- driver ---------------------------------------------------------------

  run(html: string): ElementNode {
    for (const token of tokenize(html)) this.dispatch(token)
    this.finalize()
    return this.root
  }

  /** EOF handling: a truncated document still gets its implied html/head/body
   * skeleton, matching what a real parser would have produced by now. */
  private finalize(): void {
    if (this.mode === "text") {
      this.stack.pop()
      this.mode = this.originalMode
    }
    if (this.stack.length === 0) {
      this.insertElement("html", {})
      this.mode = "before head"
    }
    if (this.mode === "before head") {
      this.headElement = this.insertElement("head", {})
      this.mode = "in head"
    }
    if (this.mode === "in head") {
      this.stack.pop()
      this.mode = "after head"
    }
    if (this.mode === "after head") {
      this.insertElement("body", {})
      this.mode = "in body"
    }
  }

  private dispatch(token: Token): void {
    const adjusted = this.current()
    if (adjusted.ns && !this.isIntegrationPoint(adjusted) && this.mode !== "text") {
      if (token.kind === "start" && !BREAKOUT_TAGS.has(token.tag) && !this.isBreakoutFont(token)) {
        this.processForeignStart(token)
        return
      }
      if (token.kind === "start") {
        while (this.stack.length > 0 && this.current().ns && !this.isIntegrationPoint(this.current())) {
          this.stack.pop()
        }
      } else if (token.kind === "end") {
        this.processForeignEnd(token)
        return
      }
    }

    this.dispatchByMode(token)
  }

  /** Insertion-mode switch, bypassing the foreign-content check — used both
   * by {@link dispatch} and by foreign-content fallbacks that must not
   * re-trigger that check against an unchanged current node (which would
   * recurse forever). */
  private dispatchByMode(token: Token): void {
    switch (this.mode) {
      case "initial": this.inInitial(token); return
      case "before html": this.inBeforeHtml(token); return
      case "before head": this.inBeforeHead(token); return
      case "in head": this.inHead(token); return
      case "after head": this.inAfterHead(token); return
      case "in body": this.inBody(token); return
      case "text": this.inText(token); return
      case "in table": this.inTable(token); return
      case "in caption": this.inCaption(token); return
      case "in column group": this.inColumnGroup(token); return
      case "in table body": this.inTableBody(token); return
      case "in row": this.inRow(token); return
      case "in cell": this.inCell(token); return
      case "in select": this.inSelect(token); return
      case "in select in table": this.inSelectInTable(token); return
      case "after body": this.inAfterBody(token); return
      case "after after body": this.inAfterAfterBody(token); return
    }
  }

  private isBreakoutFont(token: Extract<Token, { kind: "start" }>): boolean {
    return token.tag === "font" && ("color" in token.attrs || "face" in token.attrs || "size" in token.attrs)
  }

  private isWhitespaceText(token: Token): token is Extract<Token, { kind: "text" }> {
    return token.kind === "text" && /^[\t\n\f\r ]*$/.test(token.text)
  }

  // ---- insertion modes -------------------------------------------------------

  private inInitial(token: Token): void {
    if (token.kind === "doctype") {
      this.allocateNode()
      this.appendChild(this.root, {
        type: "doctype",
        name: token.name,
        publicId: token.publicId,
        systemId: token.systemId,
        parent: null,
      })
      this.mode = "before html"
      return
    }
    if (token.kind === "comment") { this.insertComment(token.text, this.root); return }
    if (this.isWhitespaceText(token)) return
    this.mode = "before html"
    this.dispatch(token)
  }

  private inBeforeHtml(token: Token): void {
    if (token.kind === "comment") { this.insertComment(token.text, this.root); return }
    if (this.isWhitespaceText(token)) return
    if (token.kind === "start" && token.tag === "html") {
      this.insertElement("html", token.attrs)
      this.mode = "before head"
      return
    }
    if (token.kind === "end" && !["head", "body", "html", "br"].includes(token.tag)) return
    this.insertElement("html", {})
    this.mode = "before head"
    this.dispatch(token)
  }

  private inBeforeHead(token: Token): void {
    if (this.isWhitespaceText(token)) return
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "start" && token.tag === "head") {
      this.headElement = this.insertElement("head", token.attrs)
      this.mode = "in head"
      return
    }
    if (token.kind === "end" && !["head", "body", "html", "br"].includes(token.tag)) return
    this.headElement = this.insertElement("head", {})
    this.mode = "in head"
    this.dispatch(token)
  }

  private inHead(token: Token): void {
    if (this.isWhitespaceText(token)) { this.insertText(token.text); return }
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "start") {
      if (["base", "basefont", "bgsound", "link", "meta"].includes(token.tag)) {
        this.insertVoidElement(token.tag, token.attrs)
        return
      }
      if (token.tag === "title") {
        this.insertElement("title", token.attrs)
        this.originalMode = "in head"
        this.mode = "text"
        return
      }
      if (token.tag === "noframes" || token.tag === "style" || token.tag === "script") {
        this.insertElement(token.tag, token.attrs)
        this.originalMode = "in head"
        this.mode = "text"
        return
      }
      if (token.tag === "head") return
      this.stack.pop()
      this.mode = "after head"
      this.dispatch(token)
      return
    }
    if (token.kind === "end") {
      if (token.tag === "head") {
        this.stack.pop()
        this.mode = "after head"
        return
      }
      if (["body", "html", "br"].includes(token.tag)) {
        this.stack.pop()
        this.mode = "after head"
        this.dispatch(token)
      }
      // any other end tag: parse error, ignore.
      return
    }
    // non-whitespace text, or a doctype: anything else.
    this.stack.pop()
    this.mode = "after head"
    this.dispatch(token)
  }

  private inAfterHead(token: Token): void {
    if (this.isWhitespaceText(token)) { this.insertText(token.text); return }
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "start") {
      if (token.tag === "body") {
        this.insertElement("body", token.attrs)
        this.mode = "in body"
        return
      }
      if (HEAD_RAW_TAGS.has(token.tag) && this.headElement) {
        this.pushOpenElement(this.headElement)
        this.inHead(token)
        const idx = this.stack.indexOf(this.headElement)
        if (idx !== -1) this.stack.splice(idx, 1)
        return
      }
      if (token.tag === "head") return
    }
    if (token.kind === "end" && !["body", "html", "br"].includes(token.tag)) return
    this.insertElement("body", {})
    this.mode = "in body"
    this.dispatch(token)
  }

  private closeP(): void {
    if (this.hasInButtonScope("p")) {
      this.generateImpliedEndTags("p")
      this.popUntilTagPopped("p")
    }
  }

  private closeListItem(tag: "li" | "dd" | "dt"): void {
    if (tag === "li") {
      if (this.hasInListItemScope("li")) {
        this.generateImpliedEndTags(tag)
        this.popUntilTagPopped(tag)
      }
      return
    }
    // dd/dt close each other: opening either one closes whichever is open.
    const openTag = this.hasInScope("dd") ? "dd" : this.hasInScope("dt") ? "dt" : null
    if (openTag) {
      this.generateImpliedEndTags(openTag)
      this.popUntilTagPopped(openTag)
    }
  }

  private inBody(token: Token): void {
    if (token.kind === "text") {
      if (token.text) this.reconstructActiveFormatting()
      this.insertText(token.text)
      return
    }
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "doctype") return

    if (token.kind === "start") return this.inBodyStart(token)
    this.inBodyEnd(token)
  }

  private inBodyStart(token: Extract<Token, { kind: "start" }>): void {
    const tag = token.tag
    if (tag === "html") return
    if (HEAD_RAW_TAGS.has(tag) || tag === "script" || tag === "template") {
      if (tag === "title" || tag === "noframes" || tag === "style" || tag === "script") {
        this.insertElement(tag, token.attrs)
        this.originalMode = "in body"
        this.mode = "text"
        return
      }
      this.insertVoidElement(tag, token.attrs)
      return
    }
    if (tag === "body") return

    if (["address", "article", "aside", "blockquote", "center", "details", "dialog",
      "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header",
      "hgroup", "main", "menu", "nav", "ol", "section", "summary", "ul"].includes(tag)) {
      this.closeP()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "p") {
      this.closeP()
      this.insertElement(tag, token.attrs)
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      this.closeP()
      if (/^h[1-6]$/.test(this.current().tag)) this.stack.pop()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "pre" || tag === "listing") {
      this.closeP()
      this.insertElement(tag, token.attrs)
      this.skipNextLeadingNewline = true
      return
    }
    if (tag === "form") {
      if (this.formElement) return
      this.closeP()
      this.formElement = this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "li") {
      this.closeListItem("li")
      this.closeP()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "dd" || tag === "dt") {
      this.closeListItem(tag)
      this.closeP()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "button") {
      if (this.hasInScope("button")) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped("button")
      }
      this.reconstructActiveFormatting()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "a") {
      for (let i = this.afe.length - 1; i >= 0; i--) {
        const entry = this.afe[i]
        if (entry === AFE_MARKER) break
        if (!entry.ns && entry.tag === "a") { this.adoptionAgency("a"); break }
      }
      this.reconstructActiveFormatting()
      const el = this.insertElement(tag, token.attrs)
      this.pushFormatting(el)
      return
    }
    if (tag === "nobr") {
      if (this.hasInScope("nobr")) this.adoptionAgency("nobr")
      this.reconstructActiveFormatting()
      const el = this.insertElement(tag, token.attrs)
      this.pushFormatting(el)
      return
    }
    if (FORMATTING_TAGS.has(tag)) {
      this.reconstructActiveFormatting()
      const el = this.insertElement(tag, token.attrs)
      this.pushFormatting(el)
      return
    }
    if (tag === "applet" || tag === "marquee" || tag === "object") {
      this.reconstructActiveFormatting()
      this.insertElement(tag, token.attrs)
      this.pushMarker()
      return
    }
    if (tag === "table") {
      this.closeP()
      this.insertElement(tag, token.attrs)
      this.mode = "in table"
      return
    }
    if (["area", "br", "embed", "img", "image", "keygen", "wbr", "input"].includes(tag)) {
      this.reconstructActiveFormatting()
      this.insertVoidElement(tag === "input" ? "input" : tag === "image" ? "img" : tag, token.attrs)
      return
    }
    if (["param", "source", "track"].includes(tag)) {
      this.insertVoidElement(tag, token.attrs)
      return
    }
    if (tag === "hr") {
      this.closeP()
      this.insertVoidElement(tag, token.attrs)
      return
    }
    if (tag === "textarea") {
      this.insertElement(tag, token.attrs)
      this.originalMode = "in body"
      this.mode = "text"
      this.skipNextLeadingNewline = true
      return
    }
    if (tag === "xmp") {
      this.closeP()
      this.reconstructActiveFormatting()
      this.insertElement(tag, token.attrs)
      this.originalMode = "in body"
      this.mode = "text"
      return
    }
    if (tag === "select") {
      this.reconstructActiveFormatting()
      const cameFromTable: Mode[] = ["in table", "in caption", "in table body", "in row", "in cell"]
      const nextMode: Mode = cameFromTable.includes(this.mode) ? "in select in table" : "in select"
      this.insertElement(tag, token.attrs)
      this.mode = nextMode
      return
    }
    if (tag === "optgroup" || tag === "option") {
      if (this.current().tag === "option") this.stack.pop()
      this.reconstructActiveFormatting()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "rb" || tag === "rtc") {
      if (this.hasInScope("ruby")) this.generateImpliedEndTags()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "rp" || tag === "rt") {
      if (this.hasInScope("ruby")) this.generateImpliedEndTags("rtc")
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "math") {
      this.reconstructActiveFormatting()
      if (token.selfClosing) this.insertVoidElement(tag, token.attrs, "math")
      else this.insertElement(tag, token.attrs, "math")
      return
    }
    if (tag === "svg") {
      this.reconstructActiveFormatting()
      if (token.selfClosing) this.insertVoidElement(tag, token.attrs, "svg")
      else this.insertElement(tag, token.attrs, "svg")
      return
    }
    if (["caption", "col", "colgroup", "frame", "frameset", "head", "tbody", "td", "tfoot", "th", "thead", "tr"].includes(tag)) {
      return
    }
    if (tag === "plaintext") {
      this.closeP()
      this.insertElement(tag, token.attrs)
      return
    }
    if (tag === "isindex") {
      if (this.formElement) return
      this.closeP()
      const { action, prompt, name: _name, ...rest } = token.attrs
      this.formElement = this.insertElement("form", action !== undefined ? { action } : {})
      this.insertVoidElement("hr", {})
      this.insertElement("label", {})
      this.insertText(prompt ?? "This is a searchable index. Enter search keywords: ")
      this.insertVoidElement("input", { ...rest, name: "isindex" })
      this.stack.pop() // label
      this.insertVoidElement("hr", {})
      this.stack.pop() // form
      this.formElement = null
      return
    }
    this.reconstructActiveFormatting()
    this.insertElement(tag, token.attrs)
  }

  private inBodyEnd(token: Extract<Token, { kind: "end" }>): void {
    const tag = token.tag
    if (tag === "body" || tag === "html") {
      if (this.hasInScope("body")) {
        this.mode = "after body"
        if (tag === "html") this.dispatch(token)
      }
      return
    }
    if (["address", "article", "aside", "blockquote", "button", "center", "details",
      "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer",
      "header", "hgroup", "listing", "main", "menu", "nav", "ol", "pre", "section",
      "summary", "ul"].includes(tag)) {
      if (this.hasInScope(tag)) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped(tag)
      }
      return
    }
    if (tag === "form") {
      const node = this.formElement
      this.formElement = null
      if (node && this.hasInScope("form")) {
        this.generateImpliedEndTags()
        this.popUntilElementPopped(node)
      }
      return
    }
    if (tag === "p") {
      if (!this.hasInButtonScope("p")) { this.insertElement("p", {}); }
      this.generateImpliedEndTags("p")
      this.popUntilTagPopped("p")
      return
    }
    if (tag === "li") {
      if (this.hasInListItemScope("li")) {
        this.generateImpliedEndTags("li")
        this.popUntilTagPopped("li")
      }
      return
    }
    if (tag === "dd" || tag === "dt") {
      if (this.hasInScope(tag)) {
        this.generateImpliedEndTags(tag)
        this.popUntilTagPopped(tag)
      }
      return
    }
    if (/^h[1-6]$/.test(tag)) {
      const anyHeading = ["h1", "h2", "h3", "h4", "h5", "h6"].some((h) => this.hasInScope(h))
      if (anyHeading) {
        this.generateImpliedEndTags()
        while (this.stack.length > 0) {
          const popped = this.stack.pop()
          if (popped && /^h[1-6]$/.test(popped.tag) && !popped.ns) break
        }
      }
      return
    }
    if (FORMATTING_TAGS.has(tag)) {
      this.adoptionAgency(tag)
      return
    }
    if (tag === "applet" || tag === "marquee" || tag === "object") {
      if (this.hasInScope(tag)) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped(tag)
        this.clearAfeToMarker()
      }
      return
    }
    if (tag === "br") return
    this.closeViaAnyOtherEndTag(tag)
  }

  private inText(token: Token): void {
    if (token.kind === "text") { this.insertText(token.text); return }
    if (token.kind === "end") {
      this.stack.pop()
      this.mode = this.originalMode
      return
    }
    this.mode = this.originalMode
    this.dispatch(token)
  }

  private flushPendingTableText(): void {
    if (this.pendingTableText.length === 0) return
    const text = this.pendingTableText.join("")
    this.pendingTableText = []
    if (this.pendingTableHasNonWhitespace) {
      this.fosterParenting = true
      this.reconstructActiveFormatting()
      this.insertText(text)
      this.fosterParenting = false
    } else {
      this.insertText(text)
    }
    this.pendingTableHasNonWhitespace = false
  }

  private inTable(token: Token): void {
    if (token.kind === "text" && TABLE_VOID_START.has(this.current().tag) || (token.kind === "text" && this.current().tag === "table")) {
      this.pendingTableText.push(token.text)
      if (!/^[\t\n\f\r ]*$/.test(token.text)) this.pendingTableHasNonWhitespace = true
      return
    }
    this.flushPendingTableText()
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "doctype") return

    if (token.kind === "start") {
      const tag = token.tag
      if (tag === "caption") {
        this.clearStackBackToTableContext(new Set(["table", "html"]))
        this.pushMarker()
        this.insertElement(tag, token.attrs)
        this.mode = "in caption"
        return
      }
      if (tag === "colgroup") {
        this.clearStackBackToTableContext(new Set(["table", "html"]))
        this.insertElement(tag, token.attrs)
        this.mode = "in column group"
        return
      }
      if (tag === "col") {
        this.clearStackBackToTableContext(new Set(["table", "html"]))
        this.insertElement("colgroup", {})
        this.mode = "in column group"
        this.dispatch(token)
        return
      }
      if (tag === "tbody" || tag === "tfoot" || tag === "thead") {
        this.clearStackBackToTableContext(new Set(["table", "html"]))
        this.insertElement(tag, token.attrs)
        this.mode = "in table body"
        return
      }
      if (tag === "td" || tag === "th" || tag === "tr") {
        this.clearStackBackToTableContext(new Set(["table", "html"]))
        this.insertElement("tbody", {})
        this.mode = "in table body"
        this.dispatch(token)
        return
      }
      if (tag === "table") {
        if (this.hasInTableScope("table")) {
          this.popUntilTagPopped("table")
          this.resetInsertionMode()
          this.dispatch(token)
        }
        return
      }
      if (tag === "style" || tag === "script" || tag === "template" || HEAD_RAW_TAGS.has(tag)) {
        this.inHead(token)
        return
      }
      if (tag === "input" && (token.attrs.type ?? "").toLowerCase() === "hidden") {
        this.insertVoidElement(tag, token.attrs)
        return
      }
      if (tag === "form") {
        if (!this.formElement) {
          this.formElement = this.insertElement(tag, token.attrs)
          this.stack.pop()
        }
        return
      }
    }
    if (token.kind === "end" && token.tag === "table") {
      if (this.hasInTableScope("table")) {
        this.popUntilTagPopped("table")
        this.resetInsertionMode()
      }
      return
    }
    if (token.kind === "end" && ["body", "caption", "col", "colgroup", "html", "tbody", "td", "tfoot", "th", "thead", "tr"].includes(token.tag)) {
      return
    }
    this.fosterParenting = true
    this.inBody(token)
    this.fosterParenting = false
  }

  private inCaption(token: Token): void {
    if (token.kind === "end" && token.tag === "caption") {
      if (this.hasInScope("caption")) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped("caption")
        this.clearAfeToMarker()
        this.mode = "in table"
      }
      return
    }
    if (token.kind === "start" && ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"].includes(token.tag)) {
      if (this.hasInScope("caption")) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped("caption")
        this.clearAfeToMarker()
        this.mode = "in table"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && token.tag === "table") {
      if (this.hasInScope("caption")) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped("caption")
        this.clearAfeToMarker()
        this.mode = "in table"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && ["body", "col", "colgroup", "html", "tbody", "td", "tfoot", "th", "thead", "tr"].includes(token.tag)) {
      return
    }
    this.inBody(token)
  }

  private inColumnGroup(token: Token): void {
    if (this.isWhitespaceText(token)) { this.insertText(token.text); return }
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "doctype") return
    if (token.kind === "start" && token.tag === "html") { this.inBody(token); return }
    if (token.kind === "start" && token.tag === "col") { this.insertVoidElement("col", token.attrs); return }
    if (token.kind === "end" && token.tag === "colgroup") {
      if (this.current().tag === "colgroup") this.stack.pop()
      this.mode = "in table"
      return
    }
    if (token.kind === "end" && token.tag === "col") return
    if (token.kind === "start" && (token.tag === "template" || HEAD_RAW_TAGS.has(token.tag))) { this.inHead(token); return }
    if (this.current().tag === "colgroup") {
      this.stack.pop()
      this.mode = "in table"
      this.dispatch(token)
    }
  }

  private inTableBody(token: Token): void {
    if (token.kind === "start" && token.tag === "tr") {
      this.clearStackBackToTableContext(new Set(["tbody", "thead", "tfoot", "html"]))
      this.insertElement("tr", token.attrs)
      this.mode = "in row"
      return
    }
    if (token.kind === "start" && (token.tag === "th" || token.tag === "td")) {
      this.clearStackBackToTableContext(new Set(["tbody", "thead", "tfoot", "html"]))
      this.insertElement("tr", {})
      this.mode = "in row"
      this.dispatch(token)
      return
    }
    if (token.kind === "start" && ["caption", "col", "colgroup", "tbody", "tfoot", "thead"].includes(token.tag)) {
      if (this.hasInTableScope("tbody") || this.hasInTableScope("thead") || this.hasInTableScope("tfoot")) {
        this.clearStackBackToTableContext(new Set(["tbody", "thead", "tfoot", "html"]))
        this.stack.pop()
        this.mode = "in table"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && token.tag === "table") {
      if (this.hasInTableScope("tbody") || this.hasInTableScope("thead") || this.hasInTableScope("tfoot")) {
        this.clearStackBackToTableContext(new Set(["tbody", "thead", "tfoot", "html"]))
        this.stack.pop()
        this.mode = "in table"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && (token.tag === "tbody" || token.tag === "thead" || token.tag === "tfoot")) {
      if (this.hasInTableScope(token.tag)) {
        this.clearStackBackToTableContext(new Set(["tbody", "thead", "tfoot", "html"]))
        this.stack.pop()
        this.mode = "in table"
      }
      return
    }
    if (token.kind === "end" && ["body", "caption", "col", "colgroup", "html", "td", "th", "tr"].includes(token.tag)) return
    this.inTable(token)
  }

  private inRow(token: Token): void {
    if (token.kind === "start" && (token.tag === "th" || token.tag === "td")) {
      this.clearStackBackToTableContext(new Set(["tr", "html"]))
      this.insertElement(token.tag, token.attrs)
      this.pushMarker()
      this.mode = "in cell"
      return
    }
    if (token.kind === "end" && token.tag === "tr") {
      if (this.hasInTableScope("tr")) {
        this.clearStackBackToTableContext(new Set(["tr", "html"]))
        this.stack.pop()
        this.mode = "in table body"
      }
      return
    }
    if (token.kind === "start" && ["caption", "col", "colgroup", "tbody", "tfoot", "thead", "tr"].includes(token.tag)) {
      if (this.hasInTableScope("tr")) {
        this.clearStackBackToTableContext(new Set(["tr", "html"]))
        this.stack.pop()
        this.mode = "in table body"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && (token.tag === "table" || token.tag === "tbody" || token.tag === "tfoot" || token.tag === "thead")) {
      if (this.hasInTableScope("tr")) {
        this.clearStackBackToTableContext(new Set(["tr", "html"]))
        this.stack.pop()
        this.mode = "in table body"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && ["body", "caption", "col", "colgroup", "html", "td", "th"].includes(token.tag)) return
    this.inTable(token)
  }

  private inCell(token: Token): void {
    if (token.kind === "end" && (token.tag === "td" || token.tag === "th")) {
      if (this.hasInTableScope(token.tag)) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped(token.tag)
        this.clearAfeToMarker()
        this.mode = "in row"
      }
      return
    }
    if (token.kind === "start" && ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"].includes(token.tag)) {
      const cellTag = this.hasInTableScope("td") ? "td" : this.hasInTableScope("th") ? "th" : null
      if (cellTag) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped(cellTag)
        this.clearAfeToMarker()
        this.mode = "in row"
        this.dispatch(token)
      }
      return
    }
    if (token.kind === "end" && ["body", "caption", "col", "colgroup", "html"].includes(token.tag)) return
    if (token.kind === "end" && ["table", "tbody", "tfoot", "thead", "tr"].includes(token.tag)) {
      const cellTag = this.hasInTableScope("td") ? "td" : this.hasInTableScope("th") ? "th" : null
      if (cellTag) {
        this.generateImpliedEndTags()
        this.popUntilTagPopped(cellTag)
        this.clearAfeToMarker()
        this.mode = "in row"
        this.dispatch(token)
      }
      return
    }
    this.inBody(token)
  }

  private inSelect(token: Token): void {
    if (token.kind === "text") { this.insertText(token.text); return }
    if (token.kind === "comment") { this.insertComment(token.text); return }
    if (token.kind === "doctype") return
    if (token.kind === "start") {
      if (token.tag === "option") {
        if (this.current().tag === "option") this.stack.pop()
        this.insertElement("option", token.attrs)
        return
      }
      if (token.tag === "optgroup") {
        if (this.current().tag === "option") this.stack.pop()
        if (this.current().tag === "optgroup") this.stack.pop()
        this.insertElement("optgroup", token.attrs)
        return
      }
      if (token.tag === "select") {
        if (this.hasInScope("select")) {
          this.popUntilTagPopped("select")
          this.resetInsertionMode()
        }
        return
      }
      if (["input", "keygen", "textarea"].includes(token.tag)) {
        if (this.hasInScope("select")) {
          this.popUntilTagPopped("select")
          this.resetInsertionMode()
          this.dispatch(token)
        }
        return
      }
      if (token.tag === "script" || token.tag === "template") { this.inHead(token); return }
      return
    }
    if (token.kind === "end") {
      if (token.tag === "optgroup") {
        const top = this.stack[this.stack.length - 1]
        const below = this.stack[this.stack.length - 2]
        if (top && top.tag === "option" && below && below.tag === "optgroup") this.stack.pop()
        if (this.current().tag === "optgroup") this.stack.pop()
        return
      }
      if (token.tag === "option") {
        if (this.current().tag === "option") this.stack.pop()
        return
      }
      if (token.tag === "select") {
        if (this.hasInScope("select")) {
          this.popUntilTagPopped("select")
          this.resetInsertionMode()
        }
      }
    }
  }

  private static readonly SELECT_IN_TABLE_BREAKOUT = new Set([
    "caption", "table", "tbody", "tfoot", "thead", "tr", "td", "th",
  ])

  private inSelectInTable(token: Token): void {
    const tag = token.kind === "start" || token.kind === "end" ? token.tag : undefined
    if (tag && TreeBuilder.SELECT_IN_TABLE_BREAKOUT.has(tag)) {
      if (this.hasInTableScope("select")) {
        this.popUntilTagPopped("select")
        this.resetInsertionMode()
        this.dispatch(token)
      }
      return
    }
    this.inSelect(token)
  }

  private inAfterBody(token: Token): void {
    if (this.isWhitespaceText(token) || token.kind === "comment") {
      const htmlEl = this.stack[0] ?? this.current()
      if (token.kind === "comment") this.insertComment(token.text, htmlEl)
      else {
        this.allocateNode()
        this.appendChild(htmlEl, { type: "text", text: token.text, parent: null })
      }
      return
    }
    if (token.kind === "doctype") return
    if (token.kind === "start" && token.tag === "html") { this.inBody(token); return }
    if (token.kind === "end" && token.tag === "html") {
      this.mode = "after after body"
      return
    }
    this.mode = "in body"
    this.dispatch(token)
  }

  private inAfterAfterBody(token: Token): void {
    if (token.kind === "comment") { this.insertComment(token.text, this.root); return }
    if (token.kind === "doctype" || this.isWhitespaceText(token) || (token.kind === "start" && token.tag === "html")) {
      this.inBody(token)
      return
    }
    this.mode = "in body"
    this.dispatch(token)
  }
}

/** MathML attribute-name adjustments (WHATWG "adjust MathML attributes"). */
const MATHML_ATTR_CASING: Record<string, string> = { definitionurl: "definitionURL" }

/** Attribute names the spec's "adjust foreign attributes" step reassigns a
 * (prefix, local name) pair to — the html5lib serializer renders these as
 * "prefix localname" instead of "prefix:localname". */
const FOREIGN_ATTR_PREFIXES = ["xlink:", "xml:", "xmlns:"]

function adjustForeignAttrs(attrs: Record<string, string>): Record<string, string> {
  let changed = false
  for (const key of Object.keys(attrs)) if (FOREIGN_ATTR_PREFIXES.some((p) => key.startsWith(p))) changed = true
  if (!changed) return attrs
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) {
    const prefix = FOREIGN_ATTR_PREFIXES.find((p) => key.startsWith(p))
    out[prefix ? key.replace(":", " ") : key] = value
  }
  return out
}

function adjustMathAttrs(attrs: Record<string, string>): Record<string, string> {
  let changed = false
  for (const key of Object.keys(attrs)) if (MATHML_ATTR_CASING[key]) changed = true
  if (!changed) return attrs
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) out[MATHML_ATTR_CASING[key] ?? key] = value
  return out
}

function sameFormattingElement(a: ElementNode, b: ElementNode): boolean {
  if (a.tag !== b.tag || a.ns !== b.ns) return false
  const aKeys = Object.keys(a.attrs)
  const bKeys = Object.keys(b.attrs)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => a.attrs[k] === b.attrs[k])
}

/** Parses tolerant HTML into an HTML5-ish tree (see {@link TreeBuilder}). The
 * returned node is the synthetic "#document" root; its children are the
 * doctype (if any) and the `<html>` element. */
export function parseHtml(html: string, options: ParseHtmlOptions = {}): ElementNode {
  return new TreeBuilder(options).run(html)
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HtmlTreeLimitError(`${name} must be a positive integer`)
  }
  return value
}

/** Tags whose descendant text is never "content" (script/style source, or a
 * client-side-only template) — excluded from scoring, word counts, and titles. */
const NON_TEXT_TAGS = new Set(["script", "style", "template"])

export function textContent(node: Node): string {
  if (node.type === "text") return node.text
  if (node.type !== "element") return ""
  if (NON_TEXT_TAGS.has(node.tag)) return ""
  return node.children.map(textContent).join("")
}

export function findAll(node: ElementNode, predicate: (n: ElementNode) => boolean): ElementNode[] {
  const out: ElementNode[] = []
  const walk = (n: Node) => {
    if (n.type === "element") {
      if (predicate(n)) out.push(n)
      for (const child of n.children) walk(child)
    }
  }
  for (const child of node.children) walk(child)
  return out
}

export function findFirst(node: ElementNode, predicate: (n: ElementNode) => boolean): ElementNode | null {
  if (predicate(node)) return node
  for (const child of node.children) {
    if (child.type === "element") {
      const found = findFirst(child, predicate)
      if (found) return found
    }
  }
  return null
}
