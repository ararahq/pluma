import { Buffer } from "node:buffer"
import { lookup as dnsLookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { BlockList, isIP } from "node:net"
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"

export class HtmlFetchError extends Error {
  readonly status?: number
  readonly url: string

  constructor(message: string, url: string, status?: number) {
    super(message)
    this.name = "HtmlFetchError"
    this.url = url
    this.status = status
  }
}

export class HtmlLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HtmlLimitError"
  }
}

export interface FetchHtmlOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  headers?: Record<string, string>
  userAgent?: string
  /**
   * Called before the initial request and before every redirect hop. Agent
   * hosts can use this to enforce an allowlist or a pinned-DNS/SSRF policy.
   * The built-in policy always rejects non-HTTP(S) URLs and URL credentials.
   */
  urlPolicy?: FetchUrlPolicy
  /**
   * User-supplied request headers are not forwarded to another origin by
   * default. Names listed here may be forwarded, except credential headers,
   * which are always stripped on a cross-origin redirect.
   */
  forwardHeadersOnCrossOriginRedirect?: string[]
  /** Public-only by default. Use "any" only for trusted local/intranet URLs. */
  networkPolicy?: "public" | "any"
  /** Injectable DNS resolver for deterministic hosts/tests. */
  resolver?: FetchDnsResolver
}

export interface FetchDnsAddress {
  address: string
  family: number
}

export type FetchDnsResolver = (hostname: string) => Promise<FetchDnsAddress[]>

export interface FetchUrlPolicyContext {
  redirectCount: number
  previousUrl?: URL
}

export type FetchUrlPolicy = (url: URL, context: FetchUrlPolicyContext) => void | Promise<void>

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = "pluma/read-html (+https://github.com/ararahq/pluma)"
const SAFE_CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent"])
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "x-auth-token",
])
const HOP_BY_HOP_REQUEST_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "upgrade"]

export interface FetchedHtml {
  html: string
  url: string
  contentType?: string
}

/** Fetches a URL and returns decoded HTML text, honoring timeout, byte, and
 * redirect limits, with charset resolved per the HTTP/HTML priority chain:
 * Content-Type header > <meta charset> > BOM > heuristic fallback. */
export async function fetchHtml(url: string, options: FetchHtmlOptions = {}): Promise<FetchedHtml> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes")
  const maxRedirects = nonNegativeInteger(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, "maxRedirects")
  const networkPolicy = options.networkPolicy ?? "public"
  if (networkPolicy !== "public" && networkPolicy !== "any") {
    throw new HtmlFetchError(`Unsupported networkPolicy "${String(networkPolicy)}"`, url)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let currentUrl = parseRequestUrl(url)
  let redirectCount = 0
  let policyContext: FetchUrlPolicyContext = { redirectCount: 0 }
  const requestHeaders = new Headers({
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    ...options.headers,
  })
  for (const name of HOP_BY_HOP_REQUEST_HEADERS) requestHeaders.delete(name)
  const userHeaderNames = new Set(Object.keys(options.headers ?? {}).map((name) => name.toLowerCase()))
  const allowedCrossOrigin = new Set(
    (options.forwardHeadersOnCrossOriginRedirect ?? []).map((name) => name.toLowerCase()),
  )
  try {
    for (;;) {
      await awaitWithSignal(enforceUrlPolicy(currentUrl, policyContext, options.urlPolicy), controller.signal, currentUrl)
      let response: Response
      try {
        response = networkPolicy === "public"
          ? await fetchPublicPinned(currentUrl, requestHeaders, controller.signal, maxBytes, options.resolver)
          : await fetch(currentUrl.href, {
              redirect: "manual",
              signal: controller.signal,
              headers: requestHeaders,
            })
      } catch (error) {
        if (error instanceof HtmlFetchError || error instanceof HtmlLimitError) throw error
        const message = (error as Error).name === "AbortError" ? `Timeout after ${timeoutMs}ms` : (error as Error).message
        throw new HtmlFetchError(message, currentUrl.href)
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location) throw new HtmlFetchError(`Redirect without Location header`, currentUrl.href, response.status)
        if (redirectCount >= maxRedirects) {
          throw new HtmlFetchError(`Too many redirects (> ${maxRedirects})`, currentUrl.href, response.status)
        }
        const previousUrl = currentUrl
        const nextUrl = parseRequestUrl(location, currentUrl)
        if (networkPolicy === "public" && previousUrl.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new HtmlFetchError("HTTPS redirects may not downgrade to HTTP", nextUrl.href, response.status)
        }
        if (nextUrl.origin !== previousUrl.origin) {
          stripCrossOriginHeaders(requestHeaders, userHeaderNames, allowedCrossOrigin)
        }
        redirectCount++
        currentUrl = nextUrl
        policyContext = { redirectCount, previousUrl }
        continue
      }

      if (!response.ok) {
        await response.body?.cancel()
        throw new HtmlFetchError(`HTTP ${response.status} fetching ${currentUrl.href}`, currentUrl.href, response.status)
      }

      const contentType = response.headers.get("content-type") ?? undefined
      const buffer = await readBodyWithLimit(response, maxBytes)
      const html = decodeHtmlBuffer(buffer, contentType)
      return { html, url: currentUrl.href, contentType }
    }
  } finally {
    clearTimeout(timer)
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HtmlLimitError(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new HtmlLimitError(`${name} must be a non-negative integer`)
  return value
}

function parseRequestUrl(value: string, base?: URL): URL {
  try {
    return new URL(value, base)
  } catch {
    throw new HtmlFetchError(`Invalid URL`, base?.href ?? value)
  }
}

async function enforceUrlPolicy(
  url: URL,
  context: FetchUrlPolicyContext,
  policy: FetchUrlPolicy | undefined,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HtmlFetchError(`Unsupported URL protocol "${url.protocol}"`, url.href)
  }
  if (url.username || url.password) {
    throw new HtmlFetchError(`URL credentials are not allowed`, url.href)
  }
  try {
    await policy?.(url, context)
  } catch (error) {
    if (error instanceof HtmlFetchError || error instanceof HtmlLimitError) throw error
    throw new HtmlFetchError(`URL rejected by policy: ${(error as Error).message}`, url.href)
  }
}

function stripCrossOriginHeaders(
  headers: Headers,
  userHeaderNames: Set<string>,
  allowedCrossOrigin: Set<string>,
): void {
  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase()
    if (CREDENTIAL_HEADERS.has(normalized)) {
      headers.delete(name)
      continue
    }
    if (
      userHeaderNames.has(normalized) &&
      !SAFE_CROSS_ORIGIN_HEADERS.has(normalized) &&
      !allowedCrossOrigin.has(normalized)
    ) {
      headers.delete(name)
    }
  }
}

const defaultResolver: FetchDnsResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal, url: URL): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new HtmlFetchError("Request timed out", url.href))
      return
    }
    const abort = () => reject(new HtmlFetchError("Request timed out", url.href))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

async function fetchPublicPinned(
  url: URL,
  headers: Headers,
  signal: AbortSignal,
  maxBytes: number,
  resolver: FetchDnsResolver = defaultResolver,
): Promise<Response> {
  const hostname = unbracketHostname(url.hostname)
  if (!hostname || hostname.endsWith(".")) throw new HtmlFetchError("URL hostname is invalid", url.href)
  const literalFamily = isIP(hostname)
  let addresses: FetchDnsAddress[]
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await awaitWithSignal(resolver(hostname), signal, url)
  } catch (error) {
    throw new HtmlFetchError(`URL hostname could not be resolved: ${(error as Error).message}`, url.href)
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => (family !== 4 && family !== 6) || !isPublicAddress(address))
  ) {
    throw new HtmlFetchError("URL resolves to a blocked network", url.href)
  }
  const target = addresses[0]
  return requestPinned(url, target.address, target.family as 4 | 6, headers, signal, maxBytes)
}

export function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  headers: Headers,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http
    const requestHeaders = Object.fromEntries(headers.entries())
    if (!("accept-encoding" in requestHeaders)) requestHeaders["accept-encoding"] = "gzip, br, deflate"
    const request = transport.request(url, {
      method: "GET",
      headers: requestHeaders,
      signal,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          ;(callback as unknown as (error: null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(null, [{ address, family }])
          return
        }
        ;(callback as unknown as (error: null, value: string, valueFamily: 4 | 6) => void)(null, address, family)
      },
      servername: url.protocol === "https:" ? unbracketHostname(url.hostname) : undefined,
    }, (response) => {
      const status = response.statusCode ?? 500
      const responseHeaders = incomingHeaders(response.headers)
      const discard = (outcome: () => void) => {
        outcome()
        response.destroy()
        request.destroy()
      }
      if (status < 200 || status >= 300) {
        discard(() => resolve(new Response(null, { status, headers: responseHeaders })))
        return
      }
      const declared = Number(response.headers["content-length"] ?? 0)
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(() => reject(new HtmlLimitError(`Compressed response exceeds maxBytes (${maxBytes})`)))
        return
      }
      const chunks: Buffer[] = []
      let compressedBytes = 0
      response.on("data", (chunk: Buffer) => {
        compressedBytes += chunk.byteLength
        if (compressedBytes > maxBytes) {
          response.destroy(new HtmlLimitError(`Compressed response exceeds maxBytes (${maxBytes})`))
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => {
        try {
          const decoded = decodeHttpBody(Buffer.concat(chunks), response.headers["content-encoding"], maxBytes, url)
          responseHeaders.delete("content-encoding")
          responseHeaders.delete("content-length")
          resolve(new Response(toArrayBuffer(decoded), { status, headers: responseHeaders }))
        } catch (error) {
          reject(error)
        }
      })
      response.on("error", reject)
    })
    request.on("error", reject)
    request.end()
  })
}

function incomingHeaders(values: http.IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}

function decodeHttpBody(
  bytes: Buffer,
  rawEncoding: string | string[] | undefined,
  maxBytes: number,
  url: URL,
): Uint8Array {
  const encoding = Array.isArray(rawEncoding) ? rawEncoding.join(",") : rawEncoding?.trim().toLowerCase()
  try {
    let decoded: Buffer
    if (!encoding || encoding === "identity") decoded = bytes
    else if (encoding === "gzip") decoded = gunzipSync(bytes, { maxOutputLength: maxBytes })
    else if (encoding === "br") decoded = brotliDecompressSync(bytes, { maxOutputLength: maxBytes })
    else if (encoding === "deflate") decoded = inflateSync(bytes, { maxOutputLength: maxBytes })
    else throw new HtmlFetchError(`Unsupported Content-Encoding "${encoding}"`, url.href)
    if (decoded.byteLength > maxBytes) throw new HtmlLimitError(`Response exceeds maxBytes (${maxBytes})`)
    return decoded
  } catch (error) {
    if (error instanceof HtmlFetchError || error instanceof HtmlLimitError) throw error
    const value = error as { code?: string; message?: string }
    if (value.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(value.message ?? "")) {
      throw new HtmlLimitError(`Decoded response exceeds maxBytes (${maxBytes})`)
    }
    throw new HtmlFetchError(`Could not decode compressed response: ${value.message ?? "unknown error"}`, url.href)
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

function inV4(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask)
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]

const PUBLIC_V6 = new BlockList()
PUBLIC_V6.addSubnet("2000::", 3, "ipv6")
const BLOCKED_V6 = new BlockList()
BLOCKED_V6.addSubnet("2001::", 32, "ipv6")
BLOCKED_V6.addSubnet("2001:2::", 48, "ipv6")
BLOCKED_V6.addSubnet("2001:10::", 28, "ipv6")
BLOCKED_V6.addSubnet("2001:20::", 28, "ipv6")
BLOCKED_V6.addSubnet("2001:db8::", 32, "ipv6")
BLOCKED_V6.addSubnet("2002::", 16, "ipv6")
BLOCKED_V6.addSubnet("3fff::", 20, "ipv6")

function mappedV4(address: string): string | null {
  const normalized = address.toLowerCase().split("%")[0]
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return dotted[1]
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const value = (Number.parseInt(hex[1], 16) << 16) | Number.parseInt(hex[2], 16)
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !BLOCKED_V4.some(([base, prefix]) => inV4(address, base, prefix))
  if (family !== 6) return false
  const mapped = mappedV4(address)
  if (mapped) return isPublicAddress(mapped)
  const value = address.toLowerCase().split("%")[0]
  return PUBLIC_V6.check(value, "ipv6") && !BLOCKED_V6.check(value, "ipv6")
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new HtmlLimitError(`Response exceeds maxBytes (${maxBytes})`)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HtmlLimitError(`Response exceeds maxBytes (${maxBytes})`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function charsetFromContentType(contentType?: string): string | undefined {
  if (!contentType) return undefined
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)
  return match?.[1]?.toLowerCase()
}

function charsetFromMetaTag(headBytes: Uint8Array): string | undefined {
  const ascii = Buffer.from(headBytes).toString("latin1")
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)["']?/i.exec(ascii)
  if (metaCharset) return metaCharset[1].toLowerCase()
  const httpEquiv = /<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(ascii)
  return httpEquiv?.[1]?.toLowerCase()
}

function detectBom(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  return undefined
}

const NORMALIZED_CHARSETS: Record<string, string> = {
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  "us-ascii": "windows-1252",
  ascii: "windows-1252",
}

/** Decodes an HTML byte buffer to a string using the priority chain
 * Content-Type header > BOM > `<meta charset>` sniffed from the head bytes
 * > UTF-8 fallback. */
export function decodeHtmlBuffer(bytes: Uint8Array, contentType?: string): string {
  const headerCharset = charsetFromContentType(contentType)
  const bom = detectBom(bytes)
  const sniffWindow = bytes.subarray(0, Math.min(bytes.length, 2048))
  const metaCharset = charsetFromMetaTag(sniffWindow)
  const chosen = headerCharset ?? bom ?? metaCharset ?? "utf-8"
  const normalized = NORMALIZED_CHARSETS[chosen] ?? chosen
  try {
    const decoder = new TextDecoder(normalized, { fatal: false })
    return decoder.decode(bytes)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }
}
