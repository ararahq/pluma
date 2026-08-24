import { decodeEntities } from "./entities.js"

export type Token =
  | { kind: "start"; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "end"; tag: string }
  | { kind: "text"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "doctype"; name: string; publicId?: string; systemId?: string }

/** RAWTEXT: opaque to entity decoding (script/style content is never markup or text). */
const RAWTEXT_TAGS = new Set(["script", "style"])
/** RCDATA: entities decode, but no nested tags parse — matches spec title/textarea content model. */
const RCDATA_TAGS = new Set(["textarea", "title"])
const RAW_TEXT_TAGS = new Set([...RAWTEXT_TAGS, ...RCDATA_TAGS])

const ATTR_PATTERN =
  /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]*))?/g

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_PATTERN.exec(attrString))) {
    const name = match[1].toLowerCase()
    if (name === "/") continue
    let value = match[2] ?? ""
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1)
    }
    attrs[name] = decodeEntities(value)
  }
  return attrs
}

/**
 * Tolerant single-pass HTML tokenizer. Handles unquoted/unclosed attributes,
 * raw-text elements (script/style/textarea/title), comments, CDATA sections,
 * doctypes, and preserves <pre> content verbatim (caller decides whitespace
 * handling via the "text" tokens it emits).
 */
export function* tokenize(html: string): Generator<Token> {
  const length = html.length
  let i = 0

  while (i < length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) {
      if (i < length) yield { kind: "text", text: decodeEntities(html.slice(i)) }
      break
    }
    if (lt > i) yield { kind: "text", text: decodeEntities(html.slice(i, lt)) }

    if (html.startsWith("<!--", lt)) {
      const contentStart = lt + 4
      // "<!-->" and "<!--->" are parse errors per spec but yield an empty comment.
      if (html[contentStart] === ">") {
        yield { kind: "comment", text: "" }
        i = contentStart + 1
        continue
      }
      if (html.startsWith("->", contentStart)) {
        yield { kind: "comment", text: "" }
        i = contentStart + 2
        continue
      }
      const dashGt = html.indexOf("-->", contentStart)
      const dashBangGt = html.indexOf("--!>", contentStart)
      const hasDashBang = dashBangGt !== -1 && (dashGt === -1 || dashBangGt < dashGt)
      const end = hasDashBang ? dashBangGt : dashGt
      const stop = end === -1 ? length : end
      yield { kind: "comment", text: html.slice(contentStart, stop) }
      i = end === -1 ? length : end + (hasDashBang ? 4 : 3)
      continue
    }

    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9)
      const stop = end === -1 ? length : end
      yield { kind: "text", text: html.slice(lt + 9, stop) }
      i = end === -1 ? length : end + 3
      continue
    }

    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt)
      const close = end === -1 ? length : end
      if (/^<!doctype/i.test(html.slice(lt, lt + 9))) {
        yield parseDoctype(html.slice(lt, close))
      } else if (html.startsWith("<?", lt)) {
        // Bogus comment state: data is everything after "<" (the "?" included).
        yield { kind: "comment", text: html.slice(lt + 1, close) }
      } else {
        // Bogus comment state via markup-declaration-open: data excludes the "!".
        yield { kind: "comment", text: html.slice(lt + 2, close) }
      }
      i = end === -1 ? length : end + 1
      continue
    }

    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt)
      const nameMatch = /^[a-zA-Z]/.test(html[lt + 2] ?? "")
      if (nameMatch) {
        const tagMatch = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, end === -1 ? length : end + 1))
        if (tagMatch) yield { kind: "end", tag: tagMatch[1].toLowerCase() }
        i = end === -1 ? length : end + 1
        continue
      }
      if (lt + 2 >= length) {
        // "</" at EOF: emit the two characters as literal text.
        yield { kind: "text", text: "</" }
        i = length
        continue
      }
      // End-tag-open-state on a non-letter, non-">" char: bogus comment,
      // data starting right after "</".
      const close = end === -1 ? length : end
      yield { kind: "comment", text: html.slice(lt + 2, close) }
      i = end === -1 ? length : end + 1
      continue
    }

    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt))
    if (!tagMatch) {
      yield { kind: "text", text: decodeEntities("<") }
      i = lt + 1
      continue
    }

    const tag = tagMatch[1].toLowerCase()
    const tagEnd = findTagEnd(html, lt)
    if (tagEnd.close === -1) {
      yield { kind: "text", text: decodeEntities(html.slice(lt)) }
      i = length
      continue
    }
    const inner = html.slice(lt + 1 + tag.length, tagEnd.close)
    const selfClosing = inner.trimEnd().endsWith("/")
    const attrString = selfClosing ? inner.trimEnd().slice(0, -1) : inner
    yield { kind: "start", tag, attrs: parseAttrs(attrString), selfClosing }
    i = tagEnd.close + 1

    if (!selfClosing && tag === "plaintext") {
      // PLAINTEXT tokenizer state: everything until EOF is literal text, "<" included.
      if (i < length) yield { kind: "text", text: html.slice(i) }
      return
    }

    if (!selfClosing && RAW_TEXT_TAGS.has(tag)) {
      const found = findRawTextClose(html, tag, i)
      const rawEnd = found ? found.closeIdx : length
      const raw = html.slice(i, rawEnd)
      if (raw) yield { kind: "text", text: RCDATA_TAGS.has(tag) ? decodeEntities(raw) : raw }
      if (found) {
        yield { kind: "end", tag }
        i = found.gt + 1
      } else {
        i = length
      }
    }
  }
}

const DOCTYPE_PATTERN =
  /^<!doctype\s*([^\s>]*)(?:\s+(?:public\s*("[^"]*"|'[^']*')(?:\s*("[^"]*"|'[^']*'))?|system\s*("[^"]*"|'[^']*')))?/i

function unquote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.slice(1, -1)
}

function parseDoctype(raw: string): Extract<Token, { kind: "doctype" }> {
  const match = DOCTYPE_PATTERN.exec(raw)
  const name = (match?.[1] ?? "").toLowerCase()
  if (!match) return { kind: "doctype", name }
  const publicId = unquote(match[2])
  const systemId = unquote(match[3]) ?? unquote(match[4])
  if (publicId === undefined && systemId === undefined) return { kind: "doctype", name }
  return { kind: "doctype", name, publicId: publicId ?? "", systemId: systemId ?? "" }
}

const RAW_TEXT_END_DELIMS = new Set([" ", "\t", "\n", "\f", "\r", "/", ">"])

/** Finds the next *valid* `</tag` close for RAWTEXT/RCDATA content: the
 * character right after the name must be whitespace, "/" or ">", and a
 * terminating ">" must actually follow — otherwise (e.g. an unterminated
 * `</script` at EOF, or the "script data double escaped" nesting the real
 * tokenizer tracks) it's just literal content and we keep scanning. Not a
 * full port of the double-escaped state machine — see README. */
function findRawTextClose(html: string, tag: string, from: number): { closeIdx: number; gt: number } | null {
  const closeTag = `</${tag}`
  const lower = html.toLowerCase()
  let searchFrom = from
  for (;;) {
    const idx = lower.indexOf(closeTag, searchFrom)
    if (idx === -1) return null
    const after = html[idx + closeTag.length]
    if (after !== undefined && !RAW_TEXT_END_DELIMS.has(after)) {
      searchFrom = idx + closeTag.length
      continue
    }
    const gt = html.indexOf(">", idx)
    if (gt === -1) return null
    return { closeIdx: idx, gt }
  }
}

/** Finds the `>` that terminates a start tag, respecting quoted attribute values. */
function findTagEnd(html: string, start: number): { close: number } {
  let i = start + 1
  let inQuote: string | null = null
  while (i < html.length) {
    const c = html[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") {
      inQuote = c
    } else if (c === ">") {
      return { close: i }
    }
    i++
  }
  return { close: -1 }
}
