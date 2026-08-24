import type { ElementNode } from "./tree.js"

type AttrOp = "=" | "~=" | "^=" | "$=" | "*="

type SimplePart =
  | { kind: "tag"; name: string }
  | { kind: "class"; name: string }
  | { kind: "id"; name: string }
  | { kind: "attr"; name: string; op?: AttrOp; value?: string }
  | { kind: "not"; inner: SimplePart[] }
  | { kind: "first-child" }
  | { kind: "last-child" }
  | { kind: "nth-child"; a: number; b: number }

type Combinator = " " | ">" | "+" | "~" | null

interface Step {
  compound: SimplePart[]
  combinator: Combinator
}

export type CompiledSelector = Step[]

function splitTopLevel(selector: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of selector) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/** Inserts spaces around top-level combinator characters, leaving anything
 * inside `:pseudo(...)` parens untouched (so "+1" in nth-child args isn't
 * mistaken for a sibling combinator). */
function spaceOutCombinators(selector: string): string {
  let depth = 0
  let out = ""
  for (const ch of selector) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) out += ` ${ch} `
    else out += ch
  }
  return out
}

const ATOM_PATTERN = /\.[\w-]+|#[\w-]+|\[[^\]]*\]|:not\([^)]*\)|:nth-child\([^)]*\)|:first-child|:last-child|\*|[a-zA-Z][\w-]*/g

const ATTR_PATTERN = /^\[\s*([\w-]+)\s*(?:([~^$*]?=)\s*"?([^\]"]*)"?)?\s*\]$/

function parseNthArg(arg: string): { a: number; b: number } {
  const trimmed = arg.trim().toLowerCase()
  if (trimmed === "odd") return { a: 2, b: 1 }
  if (trimmed === "even") return { a: 2, b: 0 }
  const match = /^([+-]?\d*)n(?:\s*([+-]\s*\d+))?$/.exec(trimmed) ?? /^([+-]?\d+)$/.exec(trimmed)
  if (!match) return { a: 0, b: 0 }
  if (trimmed.includes("n")) {
    const aRaw = match[1]
    const a = aRaw === "" || aRaw === "+" ? 1 : aRaw === "-" ? -1 : Number.parseInt(aRaw, 10)
    const b = match[2] ? Number.parseInt(match[2].replace(/\s+/g, ""), 10) : 0
    return { a, b }
  }
  return { a: 0, b: Number.parseInt(match[1], 10) }
}

function parseCompound(token: string): SimplePart[] {
  const parts: SimplePart[] = []
  const matches = token.match(ATOM_PATTERN) ?? []
  for (const atom of matches) {
    if (atom === "*") continue
    if (atom.startsWith(".")) parts.push({ kind: "class", name: atom.slice(1) })
    else if (atom.startsWith("#")) parts.push({ kind: "id", name: atom.slice(1) })
    else if (atom.startsWith("[")) {
      const m = ATTR_PATTERN.exec(atom)
      if (m) parts.push({ kind: "attr", name: m[1].toLowerCase(), op: m[2] as AttrOp | undefined, value: m[3] })
    } else if (atom.startsWith(":not(")) {
      parts.push({ kind: "not", inner: parseCompound(atom.slice(5, -1)) })
    } else if (atom.startsWith(":nth-child(")) {
      parts.push({ kind: "nth-child", ...parseNthArg(atom.slice(11, -1)) })
    } else if (atom === ":first-child") {
      parts.push({ kind: "first-child" })
    } else if (atom === ":last-child") {
      parts.push({ kind: "last-child" })
    } else {
      parts.push({ kind: "tag", name: atom.toLowerCase() })
    }
  }
  return parts
}

/** Compiles a comma-separated CSS selector list (tag, `.class`, `#id`,
 * `[attr]`/`[attr=v]`/`[attr^=v]`/`[attr$=v]`/`[attr*=v]`, descendant/child/
 * adjacent-sibling/general-sibling combinators, `:not()`, `:first-child`,
 * `:last-child`, `:nth-child(an+b)`) into a matcher-ready form. */
export function compileSelector(selector: string): CompiledSelector[] {
  return splitTopLevel(selector, ",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const normalized = spaceOutCombinators(part).trim()
      const tokens = normalized.split(/\s+/).filter(Boolean)
      const steps: Step[] = []
      let pendingCombinator: Combinator = null
      for (const token of tokens) {
        if (token === ">" || token === "+" || token === "~") {
          pendingCombinator = token
          continue
        }
        steps.push({ compound: parseCompound(token), combinator: steps.length === 0 ? null : (pendingCombinator ?? " ") })
        pendingCombinator = null
      }
      return steps
    })
}

function elementSiblings(el: ElementNode): ElementNode[] {
  if (!el.parent) return [el]
  return el.parent.children.filter((c): c is ElementNode => c.type === "element")
}

function previousElementSibling(el: ElementNode): ElementNode | null {
  const siblings = elementSiblings(el)
  const idx = siblings.indexOf(el)
  return idx > 0 ? siblings[idx - 1] : null
}

function attrMatches(value: string | undefined, op: AttrOp | undefined, expected: string | undefined): boolean {
  if (value === undefined) return false
  if (op === undefined || expected === undefined) return true
  switch (op) {
    case "=":
      return value === expected
    case "~=":
      return value.split(/\s+/).includes(expected)
    case "^=":
      return value.startsWith(expected)
    case "$=":
      return value.endsWith(expected)
    case "*=":
      return value.includes(expected)
    default:
      return false
  }
}

function simplePartMatches(el: ElementNode, part: SimplePart): boolean {
  switch (part.kind) {
    case "tag":
      return el.tag === part.name
    case "class":
      return (el.attrs.class ?? "").split(/\s+/).includes(part.name)
    case "id":
      return el.attrs.id === part.name
    case "attr":
      return attrMatches(el.attrs[part.name], part.op, part.value)
    case "not":
      return !part.inner.every((p) => simplePartMatches(el, p))
    case "first-child":
      return elementSiblings(el)[0] === el
    case "last-child": {
      const siblings = elementSiblings(el)
      return siblings[siblings.length - 1] === el
    }
    case "nth-child": {
      const siblings = elementSiblings(el)
      const index = siblings.indexOf(el) + 1
      const { a, b } = part
      if (a === 0) return index === b
      const n = (index - b) / a
      return Number.isInteger(n) && n >= 0
    }
  }
}

function compoundMatches(el: ElementNode, compound: SimplePart[]): boolean {
  return compound.every((part) => simplePartMatches(el, part))
}

function matchesChainFrom(node: ElementNode, steps: Step[], i: number): boolean {
  if (!compoundMatches(node, steps[i].compound)) return false
  if (i === 0) return true
  const combinator = steps[i].combinator
  if (combinator === ">") {
    return node.parent ? matchesChainFrom(node.parent, steps, i - 1) : false
  }
  if (combinator === " ") {
    let p = node.parent
    while (p) {
      if (matchesChainFrom(p, steps, i - 1)) return true
      p = p.parent
    }
    return false
  }
  if (combinator === "+") {
    const sib = previousElementSibling(node)
    return sib ? matchesChainFrom(sib, steps, i - 1) : false
  }
  if (combinator === "~") {
    let sib = previousElementSibling(node)
    while (sib) {
      if (matchesChainFrom(sib, steps, i - 1)) return true
      sib = previousElementSibling(sib)
    }
    return false
  }
  return true
}

/** Tests an element against a pre-compiled selector list (any match wins). */
export function elementMatches(el: ElementNode, compiled: CompiledSelector[]): boolean {
  return compiled.some((steps) => steps.length > 0 && matchesChainFrom(el, steps, steps.length - 1))
}
