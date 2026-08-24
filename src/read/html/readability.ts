import { type ElementNode, findAll, textContent } from "./tree.js"

/**
 * A from-scratch TypeScript port of the core scoring algorithm from Mozilla's
 * Readability (Apache-2.0 — see NOTICE), reimplemented against pluma's own
 * tree instead of a DOM: unlikely-candidate stripping, byline detection,
 * per-tag base scores, class/id weighting, comma/length-based content
 * scoring with ancestor propagation, link-density-adjusted top-candidate
 * selection, and sibling gathering. Faithful to the original's formulas and
 * regexes; not a line-for-line port of the full ~2800-line file (no DOM
 * mutation quirks, no JSON-LD/metadata extraction — pluma's own extract.ts
 * already covers metadata via meta tags and JSON-LD).
 */

// Regexes copied verbatim from Readability.js (Apache-2.0, Mozilla and
// Contributors) — see NOTICE.
const REGEXPS = {
  unlikelyCandidates:
    /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
  okMaybeItsACandidate: /and|article|body|column|content|main|mathjax|shadow/i,
  positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
  negative:
    /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
  byline: /byline|author|dateline|writtenby|p-author/i,
  commas: /,|،|﹐|︐|︑|⹁|⸴|⸲|，/g,
}

const TAG_BASE_SCORE: Record<string, number> = {
  div: 5, pre: 3, td: 3, blockquote: 3,
  address: -3, ol: -3, ul: -3, dl: -3, dd: -3, dt: -3, li: -3, form: -3,
  h1: -5, h2: -5, h3: -5, h4: -5, h5: -5, h6: -5, th: -5,
}

const DEFAULT_TAGS_TO_SCORE = new Set(["section", "h2", "h3", "h4", "h5", "h6", "p", "td", "pre"])
const DIV_TO_P_BLOCK_CHILDREN = new Set(["blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul"])
const UNSTRIPPABLE_TAGS = new Set(["body", "a", "article", "main"])
const MAX_ANCESTOR_DEPTH = 5

function classAndId(el: ElementNode): string {
  return `${el.attrs.class ?? ""} ${el.attrs.id ?? ""}`
}

function getClassWeight(el: ElementNode): number {
  let weight = 0
  const cls = el.attrs.class
  if (cls) {
    if (REGEXPS.negative.test(cls)) weight -= 25
    if (REGEXPS.positive.test(cls)) weight += 25
  }
  const id = el.attrs.id
  if (id) {
    if (REGEXPS.negative.test(id)) weight -= 25
    if (REGEXPS.positive.test(id)) weight += 25
  }
  return weight
}

function getLinkDensity(el: ElementNode): number {
  const text = textContent(el)
  if (text.length === 0) return 0
  let linkLength = 0
  for (const a of findAll(el, (n) => n.tag === "a")) {
    const href = a.attrs.href
    const coefficient = href && /^#.+/.test(href) ? 0.3 : 1
    linkLength += textContent(a).length * coefficient
  }
  return linkLength / text.length
}

function isProbablyVisible(el: ElementNode): boolean {
  const style = el.attrs.style ?? ""
  if (/display:\s*none/i.test(style) || /visibility:\s*hidden/i.test(style)) return false
  if (el.attrs.hidden !== undefined) return false
  if (el.attrs["aria-hidden"] === "true" && !(el.attrs.class ?? "").includes("fallback-image")) return false
  return true
}

export interface ReadabilityResult {
  content: ElementNode
  byline?: string
}

/** Runs the Readability-style scoring pipeline against a `<body>` subtree,
 * mutating it in place (unlikely candidates and the detected byline node are
 * removed) and returning a synthetic container with the winning candidate
 * plus its qualifying siblings — or null if nothing scored highly enough to
 * call an "article". */
export function extractByReadability(body: ElementNode): ReadabilityResult | null {
  let byline: string | undefined

  const stripUnlikely = (el: ElementNode) => {
    el.children = el.children.filter((child) => {
      if (child.type !== "element") return true
      if (!isProbablyVisible(child)) return false
      const marker = classAndId(child)
      if (!byline && REGEXPS.byline.test(marker)) {
        const text = textContent(child).trim()
        if (text.length > 0 && text.length < 100) {
          byline = text
          return false
        }
      }
      if (
        !UNSTRIPPABLE_TAGS.has(child.tag) &&
        REGEXPS.unlikelyCandidates.test(marker) &&
        !REGEXPS.okMaybeItsACandidate.test(marker)
      ) {
        return false
      }
      stripUnlikely(child)
      return true
    })
  }
  stripUnlikely(body)

  const scorable: ElementNode[] = []
  const collect = (el: ElementNode) => {
    if (DEFAULT_TAGS_TO_SCORE.has(el.tag)) {
      scorable.push(el)
    } else if (el.tag === "div") {
      const hasBlockChild = el.children.some((c) => c.type === "element" && DIV_TO_P_BLOCK_CHILDREN.has(c.tag))
      if (!hasBlockChild) scorable.push(el)
    }
    for (const child of el.children) if (child.type === "element") collect(child)
  }
  collect(body)

  const scores = new Map<ElementNode, number>()
  const initialize = (el: ElementNode): void => {
    if (scores.has(el)) return
    scores.set(el, (TAG_BASE_SCORE[el.tag] ?? 0) + getClassWeight(el))
  }

  for (const el of scorable) {
    const text = textContent(el).trim()
    if (text.length < 25) continue

    const ancestors: ElementNode[] = []
    let ancestor = el.parent
    while (ancestor && ancestor.tag !== "#document" && ancestors.length < MAX_ANCESTOR_DEPTH) {
      ancestors.push(ancestor)
      ancestor = ancestor.parent
    }
    if (ancestors.length === 0) continue

    const commaCount = (text.match(REGEXPS.commas) ?? []).length
    const contentScore = 1 + commaCount + Math.min(Math.floor(text.length / 100), 3)

    ancestors.forEach((node, level) => {
      initialize(node)
      const divider = level === 0 ? 1 : level === 1 ? 2 : level * 3
      scores.set(node, (scores.get(node) ?? 0) + contentScore / divider)
    })
  }

  if (scores.size === 0) return null

  let topCandidate: ElementNode | null = null
  let topScore = -Infinity
  for (const [el, rawScore] of scores) {
    const adjusted = rawScore * (1 - getLinkDensity(el))
    if (adjusted > topScore) {
      topScore = adjusted
      topCandidate = el
    }
  }
  if (!topCandidate) return null

  const parent = topCandidate.parent ?? body
  const siblings = parent.children.filter((c): c is ElementNode => c.type === "element")
  const siblingThreshold = Math.max(10, topScore * 0.2)
  const content: ElementNode = { type: "element", tag: "div", attrs: {}, children: [], parent: null }

  for (const sibling of siblings) {
    let append = sibling === topCandidate
    if (!append) {
      let bonus = 0
      if (sibling.attrs.class && sibling.attrs.class === topCandidate.attrs.class) bonus = topScore * 0.2
      const siblingScore = scores.get(sibling)
      if (siblingScore !== undefined && siblingScore + bonus >= siblingThreshold) {
        append = true
      } else if (sibling.tag === "p") {
        const density = getLinkDensity(sibling)
        const nodeText = textContent(sibling)
        const len = nodeText.trim().length
        if (len > 80 && density < 0.25) append = true
        else if (len > 0 && len < 80 && density === 0 && /\.( |$)/.test(nodeText)) append = true
      }
    }
    if (append) {
      sibling.parent = content
      content.children.push(sibling)
    }
  }

  return { content, byline }
}
