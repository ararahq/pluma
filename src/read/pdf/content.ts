/**
 * Content-stream interpreter. Walks BT/ET text objects and the graphics
 * state stack (q/Q, cm), tracks the text matrix (Tm/Td/TD/T*) and font state
 * (Tf/Tc/Tw/Tz/TL/Ts), and emits one PositionedGlyph per decoded character
 * with its device-space origin, font size and style — the raw material the
 * layout pass groups into lines, paragraphs and headings. Recurses into form
 * XObjects. Annotation /URI links are collected separately by the caller.
 */
import { dictGet, dictGetName, isArray, isDict, isRef, isStream, type PdfDict, type PdfValue } from "./objects.js"
import { decodeStream } from "./filters.js"
import { loadFont, type PdfFont } from "./fonts/font.js"

export interface PositionedGlyph {
  text: string
  x: number
  y: number
  fontSize: number
  bold: boolean
  italic: boolean
  fontKey: string
}

/**
 * An axis-aligned ruling line in device space — a table border or separator
 * drawn either as a stroked line (m/l/.../S) or, just as commonly, as a thin
 * filled rectangle (re/f). Used by layout.ts as a stronger, position-based
 * signal for "this region is a table" than the text-gap heuristic alone,
 * which misses tables whose columns happen to sit close together.
 */
export interface Ruling {
  kind: "h" | "v"
  pos: number // y for horizontal, x for vertical
  start: number // x0 for horizontal, y0 for vertical
  end: number // x1 for horizontal, y1 for vertical
}

type Matrix = [number, number, number, number, number, number]

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

interface TextState {
  charSpace: number
  wordSpace: number
  scale: number
  leading: number
  font?: PdfFont
  fontKey: string
  fontSize: number
  rise: number
}

export interface Resources {
  dict?: PdfDict
  parent?: Resources
}

type Resolver = (value: PdfValue) => PdfValue | undefined

interface RunContext {
  resolve: Resolver
  fontCache: Map<string, PdfFont>
  glyphs: PositionedGlyph[]
  maxOps: number
  maxGlyphs: number
  opCount: number
  warnings: string[]
  glyphLimitWarned: boolean
}

function resolveVal(v: PdfValue | undefined, resolve: Resolver): PdfValue | undefined {
  return v !== undefined && isRef(v) ? resolve(v) : v
}

function lookupResource(
  resources: Resources | undefined,
  category: string,
  name: string,
  resolve: Resolver,
): PdfValue | undefined {
  let cur = resources
  while (cur) {
    const categoryDict = resolveVal(dictGet(cur.dict, category), resolve)
    if (isDict(categoryDict)) {
      const found = categoryDict.map.get(name)
      if (found !== undefined) return resolveVal(found, resolve)
    }
    cur = cur.parent
  }
  return undefined
}

function getFont(ctx: RunContext, resources: Resources | undefined, name: string): PdfFont | undefined {
  const cached = ctx.fontCache.get(name)
  if (cached) return cached
  const fontDict = lookupResource(resources, "Font", name, ctx.resolve)
  if (!isDict(fontDict)) return undefined
  const font = loadFont(fontDict, ctx.resolve)
  ctx.fontCache.set(name, font)
  return font
}

export function createRunContext(resolve: Resolver, maxOps: number, maxGlyphs = 2_000_000): RunContext {
  return {
    resolve,
    fontCache: new Map(),
    glyphs: [],
    maxOps,
    maxGlyphs,
    opCount: 0,
    warnings: [],
    glyphLimitWarned: false,
  }
}

/** Tokenizes and executes a content stream, appending device-space glyphs to ctx.glyphs. */
export function runContentStream(
  bytes: Uint8Array,
  initialCtm: Matrix,
  resources: Resources | undefined,
  ctx: RunContext,
  depth = 0,
): void {
  if (depth > 12) return
  const tokens = tokenizeContent(bytes, Math.max(1024, Math.min(2_000_000, ctx.maxOps * 4)))
  const stack: Matrix[] = []
  let ctm: Matrix = initialCtm
  let textMatrix: Matrix = IDENTITY
  let lineMatrix: Matrix = IDENTITY
  const ts: TextState = { charSpace: 0, wordSpace: 0, scale: 100, leading: 0, fontKey: "", fontSize: 0, rise: 0 }
  const operands: ContentToken[] = []

  for (const token of tokens) {
    if (ctx.opCount++ > ctx.maxOps) break
    if (token.kind !== "op") {
      operands.push(token)
      continue
    }
    const op = token.value
    const nums = (): number[] => operands.filter((o) => o.kind === "num").map((o) => o.value as number)
    const strOperand = (): string | undefined => operands.find((o) => o.kind === "str")?.value as string | undefined
    const nameOperand = (): string | undefined => operands.find((o) => o.kind === "name")?.value as string | undefined

    // A single malformed/unexpected operand for one operator (a font that
    // fails to load, a matrix with the wrong operand count, ...) must not
    // discard everything decoded so far on this page — record it and keep
    // going with the next token instead of letting the exception propagate
    // out of runContentStream and abort the whole page.
    try {
    switch (op) {
      case "q":
        stack.push(ctm)
        break
      case "Q":
        ctm = stack.pop() ?? ctm
        break
      case "cm": {
        const [a, b, c, d, e, f] = nums()
        ctm = multiply([a, b, c, d, e, f], ctm)
        break
      }
      case "BT":
        textMatrix = IDENTITY
        lineMatrix = IDENTITY
        break
      case "ET":
        break
      case "Tf": {
        const name = nameOperand()
        const size = nums()[0]
        if (name) {
          ts.font = getFont(ctx, resources, name)
          ts.fontKey = name
        }
        if (size !== undefined) ts.fontSize = size
        break
      }
      case "Tc":
        ts.charSpace = nums()[0] ?? 0
        break
      case "Tw":
        ts.wordSpace = nums()[0] ?? 0
        break
      case "Tz":
        ts.scale = nums()[0] ?? 100
        break
      case "TL":
        ts.leading = nums()[0] ?? 0
        break
      case "Ts":
        ts.rise = nums()[0] ?? 0
        break
      case "Td": {
        const [tx, ty] = nums()
        lineMatrix = multiply([1, 0, 0, 1, tx ?? 0, ty ?? 0], lineMatrix)
        textMatrix = lineMatrix
        break
      }
      case "TD": {
        const [tx, ty] = nums()
        ts.leading = -(ty ?? 0)
        lineMatrix = multiply([1, 0, 0, 1, tx ?? 0, ty ?? 0], lineMatrix)
        textMatrix = lineMatrix
        break
      }
      case "Tm": {
        const [a, b, c, d, e, f] = nums()
        lineMatrix = [a, b, c, d, e, f]
        textMatrix = lineMatrix
        break
      }
      case "T*":
        lineMatrix = multiply([1, 0, 0, 1, 0, -ts.leading], lineMatrix)
        textMatrix = lineMatrix
        break
      case "Tj":
      case "'":
      case '"': {
        if (op !== "Tj") {
          lineMatrix = multiply([1, 0, 0, 1, 0, -ts.leading], lineMatrix)
          textMatrix = lineMatrix
        }
        const str = strOperand()
        if (str !== undefined) textMatrix = showText(str, ts, ctm, textMatrix, ctx)
        break
      }
      case "__KERN__": {
        const raw = nums()[0] ?? 0
        // pdfTeX/LaTeX output (Type1/CFF fonts) routinely has NO space
        // glyph at all: word spacing is encoded purely as a large negative
        // TJ array adjustment (typically -180 to -400/1000 em) — "raw" here
        // is already negated at tokenize time, so a large *positive* raw is
        // a large *negative* original TJ value, i.e. exactly that word
        // gap. Emit a real space glyph for it (same device-space placement
        // math as showText) so layout.ts's line-building — which already
        // trusts real space glyphs over its own gap heuristics — treats it
        // as the genuine word boundary it is, instead of silently gluing
        // "Provided" to "proper" into "Providedproper". Small intra-word
        // kerning pairs (10-30/1000, either sign) never cross this.
        // Word/LibreOffice (unlike pdfTeX) DO emit a real space glyph and
        // still add a large TJ kern on top of it for line-justification —
        // if one was just emitted, this gap is that justification spacing,
        // not a missing word-space, and inserting a second one produces a
        // double space that the table-column-gap heuristic downstream
        // mistakes for a cell boundary, misrouting whole paragraphs.
        const lastGlyph = ctx.glyphs[ctx.glyphs.length - 1]
        if (raw >= 180 && lastGlyph?.text !== " " && canAppendGlyph(ctx)) {
          const trm = multiply([ts.fontSize * (ts.scale / 100), 0, 0, ts.fontSize, 0, ts.rise], multiply(textMatrix, ctm))
          const [x, y] = apply(trm, 0, 0)
          ctx.glyphs.push({
            text: " ",
            x,
            y,
            fontSize: Math.hypot(trm[0], trm[1]) || ts.fontSize,
            bold: ts.font?.bold ?? false,
            italic: ts.font?.italic ?? false,
            fontKey: ts.fontKey,
          })
        }
        const adjust = (raw / 1000) * ts.fontSize * (ts.scale / 100)
        textMatrix = multiply([1, 0, 0, 1, adjust, 0], textMatrix)
        break
      }
      case "Do": {
        const name = nameOperand()
        if (name) runXObject(ctx, resources, name, ctm, depth)
        break
      }
      default:
        break
    }
    } catch (error) {
      ctx.warnings.push(`Operator "${op}" failed at token ${ctx.opCount}: ${(error as Error).message}`)
    }
    operands.length = 0
  }
  void lineMatrix
}

function showText(str: string, ts: TextState, ctm: Matrix, textMatrix: Matrix, ctx: RunContext): Matrix {
  if (!ts.font) return textMatrix
  const remaining = Math.max(0, ctx.maxGlyphs - ctx.glyphs.length)
  if (remaining === 0) {
    warnGlyphLimit(ctx)
    return textMatrix
  }
  const maxSourceLength = ts.font.isCID ? remaining * 2 : remaining
  const bounded = str.length > maxSourceLength ? str.slice(0, maxSourceLength) : str
  if (bounded.length < str.length) warnGlyphLimit(ctx)
  const glyphs = ts.font.decode(bounded)
  let tm = textMatrix
  for (const glyph of glyphs) {
    const trm = multiply([ts.fontSize * (ts.scale / 100), 0, 0, ts.fontSize, 0, ts.rise], multiply(tm, ctm))
    if (glyph.text) {
      if (!canAppendGlyph(ctx)) break
      const [x, y] = apply(trm, 0, 0)
      ctx.glyphs.push({
        text: glyph.text,
        x,
        y,
        fontSize: Math.hypot(trm[0], trm[1]) || ts.fontSize,
        bold: ts.font.bold,
        italic: ts.font.italic,
        fontKey: ts.fontKey,
      })
    }
    const isSpace = glyph.text === " " && !ts.font.isCID
    const advance = (glyph.width / 1000) * ts.fontSize + ts.charSpace + (isSpace ? ts.wordSpace : 0)
    tm = multiply([1, 0, 0, 1, advance * (ts.scale / 100), 0], tm)
  }
  return tm
}

function canAppendGlyph(ctx: RunContext): boolean {
  if (ctx.glyphs.length < ctx.maxGlyphs) return true
  warnGlyphLimit(ctx)
  return false
}

function warnGlyphLimit(ctx: RunContext): void {
  if (ctx.glyphLimitWarned) return
  ctx.glyphLimitWarned = true
  ctx.warnings.push(`Glyph output exceeded maxGlyphs (${ctx.maxGlyphs}); remaining text was skipped`)
}

function runXObject(ctx: RunContext, resources: Resources | undefined, name: string, ctm: Matrix, depth: number): void {
  const xobj = lookupResource(resources, "XObject", name, ctx.resolve)
  if (!isStream(xobj)) return
  if (dictGetName(xobj.dict, "Subtype") !== "Form") return
  const matrixArr = resolveVal(dictGet(xobj.dict, "Matrix"), ctx.resolve)
  const formMatrix: Matrix =
    isArray(matrixArr) && matrixArr.items.length === 6
      ? (matrixArr.items.map((v) => (typeof v === "number" ? v : 0)) as Matrix)
      : IDENTITY
  const childResourcesDict = resolveVal(dictGet(xobj.dict, "Resources"), ctx.resolve)
  const childResources: Resources = {
    dict: isDict(childResourcesDict) ? childResourcesDict : undefined,
    parent: resources,
  }
  const decoded = decodeStream(xobj.bytes, xobj.dict)
  runContentStream(decoded, multiply(formMatrix, ctm), childResources, ctx, depth + 1)
}

/**
 * Minimal content-stream tokenizer. Operands (numbers, names, strings) and
 * operators are tagged so the interpreter never confuses a text string with
 * an operator keyword. TJ arrays are expanded inline into Tj/__KERN__ pairs.
 */
type ContentToken =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string }

const MAX_CONTENT_STRING_BYTES = 8 * 1024 * 1024

function tokenizeContent(bytes: Uint8Array, maxTokens: number): ContentToken[] {
  const tokens: ContentToken[] = []
  const c = { pos: 0 }
  const len = bytes.length

  while (c.pos < len && tokens.length < maxTokens) {
    const byte = bytes[c.pos]
    if (byte <= 0x20) {
      c.pos++
      continue
    }
    if (byte === 0x25) {
      while (c.pos < len && bytes[c.pos] !== 0x0a && bytes[c.pos] !== 0x0d) c.pos++
      continue
    }
    if (byte === 0x2f) {
      const start = c.pos
      c.pos++
      while (c.pos < len && !isDelim(bytes[c.pos])) c.pos++
      tokens.push({
        kind: "name",
        value: latin1(bytes.subarray(start + 1, Math.min(c.pos, start + 1 + MAX_CONTENT_STRING_BYTES))),
      })
      continue
    }
    if (byte === 0x28) {
      tokens.push({ kind: "str", value: readLiteralString(bytes, c) })
      continue
    }
    if (byte === 0x3c && bytes[c.pos + 1] !== 0x3c) {
      tokens.push({ kind: "str", value: readHexString(bytes, c) })
      continue
    }
    if (byte === 0x5b) {
      c.pos++
      const parts: (string | number)[] = []
      while (c.pos < len && bytes[c.pos] !== 0x5d) {
        while (c.pos < len && bytes[c.pos] <= 0x20) c.pos++
        if (c.pos >= len) break
        const before = c.pos
        let part: string | number | undefined
        if (bytes[c.pos] === 0x28) part = readLiteralString(bytes, c)
        else if (bytes[c.pos] === 0x3c) part = readHexString(bytes, c)
        else if (bytes[c.pos] === 0x5d) break
        else part = readNumber(bytes, c)
        if (part !== undefined && parts.length < maxTokens) parts.push(part)
        // A malformed array (an unexpected byte that is neither a string
        // opener nor a valid number start) must never leave c.pos where it
        // found it — readNumber() returns 0 without advancing when the
        // current byte isn't a digit/sign/period, which otherwise spins
        // this loop forever, growing `parts` until it blows past the array
        // length limit (this is the concrete "Invalid array length" crash
        // seen on a real malformed content stream). Force progress.
        if (c.pos === before) c.pos++
      }
      c.pos++ // consume ']'
      for (const part of parts) {
        if (tokens.length >= maxTokens) break
        if (typeof part === "string") {
          tokens.push({ kind: "str", value: part })
          if (tokens.length < maxTokens) tokens.push({ kind: "op", value: "Tj" })
        } else if (part !== 0) {
          tokens.push({ kind: "num", value: -part })
          if (tokens.length < maxTokens) tokens.push({ kind: "op", value: "__KERN__" })
        }
      }
      continue
    }
    if (byte === 0x3c) {
      skipBalancedDict(bytes, c)
      continue
    }
    if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
      tokens.push({ kind: "num", value: readNumber(bytes, c) })
      continue
    }
    const start = c.pos
    while (c.pos < len && !isDelim(bytes[c.pos]) && bytes[c.pos] > 0x20) c.pos++
    // A stray top-level delimiter byte that isn't one of the cases handled
    // above (an unmatched ')' or '>' from a malformed/truncated stream, for
    // instance) makes this loop consume nothing — without a forced step the
    // outer tokenizer loop never advances either, spinning forever on the
    // same byte. Drop it as one garbage "operator" token and move on.
    if (c.pos === start) c.pos++
    tokens.push({ kind: "op", value: latin1(bytes.subarray(start, Math.min(c.pos, start + MAX_CONTENT_STRING_BYTES))) })
  }
  return tokens
}

function isDelim(byte: number): boolean {
  return (
    byte <= 0x20 ||
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x2f ||
    byte === 0x25
  )
}

function latin1(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

function readNumber(bytes: Uint8Array, c: { pos: number }): number {
  const start = c.pos
  if (bytes[c.pos] === 0x2b || bytes[c.pos] === 0x2d) c.pos++
  while (c.pos < bytes.length && ((bytes[c.pos] >= 0x30 && bytes[c.pos] <= 0x39) || bytes[c.pos] === 0x2e)) c.pos++
  return Number.parseFloat(latin1(bytes.subarray(start, c.pos))) || 0
}

function readLiteralString(bytes: Uint8Array, c: { pos: number }): string {
  c.pos++
  let depth = 1
  const out: number[] = []
  while (c.pos < bytes.length && depth > 0) {
    const byte = bytes[c.pos]
    if (byte === 0x5c) {
      c.pos++
      const esc = bytes[c.pos]
      if (esc === 0x6e && out.length < MAX_CONTENT_STRING_BYTES) out.push(0x0a)
      else if (esc === 0x72 && out.length < MAX_CONTENT_STRING_BYTES) out.push(0x0d)
      else if (esc === 0x74 && out.length < MAX_CONTENT_STRING_BYTES) out.push(0x09)
      else if (esc === 0x62 && out.length < MAX_CONTENT_STRING_BYTES) out.push(0x08)
      else if (esc === 0x66 && out.length < MAX_CONTENT_STRING_BYTES) out.push(0x0c)
      else if (esc === 0x0d) {
        c.pos++
        if (bytes[c.pos] === 0x0a) c.pos++
        continue
      } else if (esc === 0x0a) {
        c.pos++
        continue
      } else if (esc >= 0x30 && esc <= 0x37) {
        let octal = ""
        for (let i = 0; i < 3 && bytes[c.pos] >= 0x30 && bytes[c.pos] <= 0x37; i++) {
          octal += String.fromCharCode(bytes[c.pos])
          c.pos++
        }
        if (out.length < MAX_CONTENT_STRING_BYTES) out.push(Number.parseInt(octal, 8) & 0xff)
        continue
      } else if (out.length < MAX_CONTENT_STRING_BYTES) out.push(esc)
      c.pos++
      continue
    }
    if (byte === 0x28) depth++
    else if (byte === 0x29) {
      depth--
      if (depth === 0) {
        c.pos++
        break
      }
    }
    if (out.length < MAX_CONTENT_STRING_BYTES) out.push(byte)
    c.pos++
  }
  return latin1(Uint8Array.from(out))
}

function readHexString(bytes: Uint8Array, c: { pos: number }): string {
  c.pos++
  let hex = ""
  while (c.pos < bytes.length && bytes[c.pos] !== 0x3e) {
    const byte = bytes[c.pos]
    if (byte > 0x20 && hex.length < MAX_CONTENT_STRING_BYTES * 2) hex += String.fromCharCode(byte)
    c.pos++
  }
  c.pos++
  if (hex.length % 2 === 1) hex += "0"
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16) || 0)
  return latin1(Uint8Array.from(out))
}

function skipBalancedDict(bytes: Uint8Array, c: { pos: number }): void {
  c.pos += 2
  let depth = 1
  while (c.pos < bytes.length && depth > 0) {
    if (bytes[c.pos] === 0x3c && bytes[c.pos + 1] === 0x3c) {
      depth++
      c.pos += 2
      continue
    }
    if (bytes[c.pos] === 0x3e && bytes[c.pos + 1] === 0x3e) {
      depth--
      c.pos += 2
      continue
    }
    c.pos++
  }
}
