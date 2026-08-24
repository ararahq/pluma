export interface CloudBrand {
  primaryColor?: string
  secondaryColor?: string
  paper?: "a4" | "letter"
  marginMm?: number
  footerText?: string
  bodyFont?: "geist"
  headingFont?: "geist"
  monoFont?: "geist-mono"
}

export interface Usage {
  units: number
}

export interface ReadResult {
  markdown: string
  meta: Record<string, unknown>
  warnings: string[]
  usage: Usage
  requestId: string
}

export interface RenderResult {
  pdf: Uint8Array
  units: number
  requestId: string
  contentType: "application/pdf"
}

export interface RequestOptions {
  signal?: AbortSignal
  idempotencyKey?: string
}

export interface PlumaOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  idempotencyKey?: () => string
}

export class PlumaError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly retryAfter?: number

  constructor(message: string, options: { status: number; code: string; requestId?: string; retryAfter?: number }) {
    super(message)
    this.name = "PlumaError"
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
    this.retryAfter = options.retryAfter
  }
}

type ErrorEnvelope = {
  error?: { code?: unknown; message?: unknown }
  request_id?: unknown
}

function defaultIdempotencyKey(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new TypeError("baseUrl must use HTTPS (HTTP is allowed only for localhost)")
  }
  url.pathname = url.pathname.replace(/\/$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

async function toBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(await input.arrayBuffer())
}

export class Pluma {
  readonly baseUrl: string
  #apiKey: string
  #fetch: typeof globalThis.fetch
  #idempotencyKey: () => string

  constructor(options: PlumaOptions) {
    if (!options.apiKey?.trim()) throw new TypeError("apiKey is required")
    const fetcher = options.fetch ?? globalThis.fetch
    if (typeof fetcher !== "function") throw new TypeError("A Fetch API implementation is required")
    this.#apiKey = options.apiKey.trim()
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.pluma.dev")
    this.#fetch = fetcher.bind(globalThis)
    this.#idempotencyKey = options.idempotencyKey ?? defaultIdempotencyKey
  }

  read(input: { url: string } | { html: string } | { pdf: Blob | ArrayBuffer | Uint8Array }, options: RequestOptions = {}): Promise<ReadResult> {
    if ("url" in input) return this.readUrl(input.url, options)
    if ("html" in input) return this.readHtml(input.html, options)
    return this.readPdf(input.pdf, options)
  }

  readUrl(url: string, options: RequestOptions = {}): Promise<ReadResult> {
    return this.#read("/v1/read/url", JSON.stringify({ url }), "application/json", options)
  }

  readHtml(html: string, options: RequestOptions = {}): Promise<ReadResult> {
    return this.#read("/v1/read/html", html, "text/html; charset=utf-8", options)
  }

  async readPdf(pdf: Blob | ArrayBuffer | Uint8Array, options: RequestOptions = {}): Promise<ReadResult> {
    const source = await toBytes(pdf)
    const body = new Uint8Array(source.byteLength)
    body.set(source)
    return this.#read("/v1/read/pdf", body.buffer, "application/pdf", options)
  }

  async render(input: { markdown: string; brand?: CloudBrand }, options: RequestOptions = {}): Promise<RenderResult> {
    const response = await this.#request("/v1/render", JSON.stringify(input), "application/json", options)
    const requestId = response.headers.get("X-Pluma-Request-Id") ?? ""
    return {
      pdf: new Uint8Array(await response.arrayBuffer()),
      units: numberHeader(response, "X-Pluma-Units"),
      requestId,
      contentType: "application/pdf",
    }
  }

  async #read(path: string, body: BodyInit, contentType: string, options: RequestOptions): Promise<ReadResult> {
    const response = await this.#request(path, body, contentType, options)
    const value = await response.json() as Partial<ReadResult> & { usage?: Partial<Usage>; request_id?: string }
    if (typeof value.markdown !== "string" || !Array.isArray(value.warnings) || !value.meta || typeof value.meta !== "object") {
      throw new PlumaError("Pluma returned an invalid read response", { status: 502, code: "invalid_response" })
    }
    return {
      markdown: value.markdown,
      meta: value.meta,
      warnings: value.warnings,
      usage: { units: value.usage?.units ?? numberHeader(response, "X-Pluma-Units") },
      requestId: response.headers.get("X-Pluma-Request-Id") ?? value.request_id ?? "",
    }
  }

  async #request(path: string, body: BodyInit, contentType: string, options: RequestOptions): Promise<Response> {
    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": contentType,
        "Idempotency-Key": options.idempotencyKey ?? this.#idempotencyKey(),
      },
      body,
      signal: options.signal,
    })
    if (!response.ok) throw await responseError(response)
    return response
  }
}

function numberHeader(response: Response, name: string): number {
  const value = Number(response.headers.get(name))
  return Number.isFinite(value) && value >= 0 ? value : 0
}

async function responseError(response: Response): Promise<PlumaError> {
  let envelope: ErrorEnvelope = {}
  try {
    envelope = await response.json() as ErrorEnvelope
  } catch {
    // A proxy can replace the structured API body. Preserve status and request ID.
  }
  const message = typeof envelope.error?.message === "string" ? envelope.error.message : `Pluma request failed with status ${response.status}`
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "request_failed"
  const retryAfterHeader = response.headers.get("Retry-After")
  const retryAfterValue = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader)
  return new PlumaError(message, {
    status: response.status,
    code,
    requestId: response.headers.get("X-Pluma-Request-Id") ?? (typeof envelope.request_id === "string" ? envelope.request_id : undefined),
    retryAfter: Number.isFinite(retryAfterValue) ? retryAfterValue : undefined,
  })
}
