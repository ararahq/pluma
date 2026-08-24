import { lstatSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"
import { renderPdf, renderPdfCloudSafe, readPdf, readHtml, readUrl, type RenderOptions, type ReadPdfOptions, type ReadHtmlOptions } from "./index.js"

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_INFO = { name: "pluma", version: "0.2.0" }
const MAX_MCP_FRAME_BYTES = 2 * 1024 * 1024
const MAX_MCP_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_MCP_CONCURRENCY = 8
const MCP_MIN_TIMEOUT_MS = 1_000
const MCP_MAX_TIMEOUT_MS = 30_000
const MCP_DEFAULT_TIMEOUT_MS = 10_000
const MCP_MAX_FETCH_BYTES = 20 * 1024 * 1024
const MCP_DEFAULT_FETCH_BYTES = 20 * 1024 * 1024
const MCP_MAX_TOKENS = 1_000_000

const SAFE_RENDER_TOOL = {
  name: "render_pdf",
  description:
    "Convert Markdown into a professionally typeset PDF without a browser. " +
    "Supports frontmatter, GFM tables, highlighted code, and safe page/column directives. " +
    "Raw Typst, images, filesystem roots, and custom font paths are disabled by default.",
  inputSchema: {
    type: "object",
    properties: {
      markdown: { type: "string", description: "Complete Markdown document; frontmatter is optional" },
      output_path: { type: "string", description: "Absolute output PDF path" },
      brand: {
        type: "object",
        description:
          'Safe visual tokens, for example: {"colors":{"accent":"#0e7490"},"footer":"Acme"}',
      },
    },
    required: ["markdown", "output_path"],
  },
} as const

const TRUSTED_RENDER_TOOL = {
  ...SAFE_RENDER_TOOL,
  description:
    "Trusted-local Markdown to PDF. Allows raw Typst, local images, custom fonts, and a filesystem root. " +
    "Enable only for documents and agents you trust.",
  inputSchema: {
    ...SAFE_RENDER_TOOL.inputSchema,
    properties: {
      ...SAFE_RENDER_TOOL.inputSchema.properties,
      fonts_dir: { type: "string", description: "Directory containing trusted .ttf/.otf fonts" },
      root: { type: "string", description: "Trusted base directory for local logo and image paths" },
    },
  },
} as const

export interface McpOptions {
  trustedLocal?: boolean
}

const READ_TOOL = {
  name: "read_pdf",
  description:
    "Convert a PDF text layer into clean Markdown for LLM/RAG pipelines without a browser or PDFBox. " +
    "Reconstructs reading order, headings, lists, and tables from glyph positions, and removes " +
    "repeated headers, footers, and page numbers by default.",
  inputSchema: {
    type: "object",
    properties: {
      pdf_path: { type: "string", description: "Absolute input PDF path" },
      pages: { type: "string", description: 'Page range, for example "1-3,7"' },
      page_breaks: { type: "string", enum: ["none", "rule", "marker"], description: "Page-break representation" },
      drop_headers_footers: { type: "boolean", description: "Remove repeated headers and footers (default: true)" },
    },
    required: ["pdf_path"],
  },
} as const

const READ_OPTIONS_SCHEMA = {
  mode: { type: "string", enum: ["article", "page", "raw"], description: "article (default) extracts main content; page keeps hierarchy without chrome; raw returns the full body" },
  images: { type: "boolean", description: "Set false to omit images (default: true)" },
  links: { type: "boolean", description: "Set false to emit link text without Markdown link syntax (default: true)" },
  front_matter: { type: "boolean", description: "Prepend YAML title/url/date metadata" },
  max_tokens: {
    type: "integer",
    minimum: 1,
    maximum: MCP_MAX_TOKENS,
    description: "Truncate near this token count at a block boundary",
  },
} as const

const READ_HTML_TOOL = {
  name: "read_html",
  description:
    "Convert an HTML string into clean Markdown for an LLM. Extracts the main content without " +
    "runtime dependencies, preserves tables, code, lists, and links, and returns page metadata. " +
    "This tool performs no network request.",
  inputSchema: {
    type: "object",
    properties: {
      html: { type: "string", description: "Complete HTML document or fragment" },
      base_url: { type: "string", description: "Base URL for relative links and images" },
      ...READ_OPTIONS_SCHEMA,
    },
    required: ["html"],
  },
} as const

const READ_URL_TOOL = {
  name: "read_url",
  description:
    "Fetch an HTTP(S) URL and convert its HTML into clean Markdown using the read_html pipeline. " +
    "Enforces the configured timeout, byte limit, redirect limit, and public-network-only policy. " +
    "Trusted-local mode may access private networks.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP(S) page URL" },
      timeout_ms: {
        type: "integer",
        minimum: MCP_MIN_TIMEOUT_MS,
        maximum: MCP_MAX_TIMEOUT_MS,
        default: MCP_DEFAULT_TIMEOUT_MS,
        description: "Request timeout in milliseconds (default: 10000)",
      },
      max_bytes: {
        type: "integer",
        minimum: 1,
        maximum: MCP_MAX_FETCH_BYTES,
        default: MCP_DEFAULT_FETCH_BYTES,
        description: "Maximum response-body size (default: 20 MiB)",
      },
      ...READ_OPTIONS_SCHEMA,
    },
    required: ["url"],
  },
} as const

function readOptionsFromArgs(args: Record<string, unknown>): ReadHtmlOptions {
  return {
    mode: args.mode as ReadHtmlOptions["mode"],
    images: typeof args.images === "boolean" ? args.images : undefined,
    links: typeof args.links === "boolean" ? args.links : undefined,
    frontMatter: typeof args.front_matter === "boolean" ? args.front_matter : undefined,
    maxTokens: optionalBoundedInteger(args, "max_tokens", 1, MCP_MAX_TOKENS),
    baseUrl: typeof args.base_url === "string" ? args.base_url : undefined,
  }
}

function optionalBoundedInteger(
  args: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = Record<string, unknown>

export async function handleMcpRequest(request: JsonRpcRequest, options: McpOptions = {}): Promise<JsonRpcResponse | null> {
  if (request.id === undefined || request.id === null) return null

  switch (request.method) {
    case "initialize":
      return reply(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case "tools/list":
      return reply(request.id, { tools: [options.trustedLocal ? TRUSTED_RENDER_TOOL : SAFE_RENDER_TOOL, READ_TOOL, READ_HTML_TOOL, READ_URL_TOOL] })
    case "tools/call":
      return handleToolCall(request, options)
    case "ping":
      return reply(request.id, {})
    default:
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      }
  }
}

async function handleToolCall(request: JsonRpcRequest, options: McpOptions): Promise<JsonRpcResponse> {
  const id = request.id as number | string
  const params = request.params ?? {}
  const name = params.name as string
  const args = (params.arguments ?? {}) as Record<string, unknown>

  switch (name) {
    case SAFE_RENDER_TOOL.name:
      return handleRenderPdf(id, args, options)
    case READ_TOOL.name:
      return handleReadCall(id, args, options)
    case READ_HTML_TOOL.name:
      return handleReadHtml(id, args)
    case READ_URL_TOOL.name:
      return handleReadUrl(id, args, options)
    default:
      return toolError(
        id,
        `Unknown tool: ${name}. Available: ${SAFE_RENDER_TOOL.name}, ${READ_TOOL.name}, ${READ_HTML_TOOL.name}, ${READ_URL_TOOL.name}`,
      )
  }
}

function withinRoot(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

function safeOutputPath(input: string): string {
  const root = realpathSync(process.cwd())
  const output = resolve(input)
  const parent = realpathSync(dirname(output))
  if (!withinRoot(parent, root) || extname(output).toLowerCase() !== ".pdf") {
    throw new Error("Safe MCP mode writes only .pdf files inside the current working directory")
  }
  try {
    if (lstatSync(output).isSymbolicLink()) throw new Error("Safe MCP mode does not write through symbolic links")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return output
}

function safeInputPath(input: string): string {
  const root = realpathSync(process.cwd())
  const path = realpathSync(resolve(input))
  if (!withinRoot(path, root)) throw new Error("Safe MCP mode reads only files inside the current working directory")
  return path
}

function handleRenderPdf(id: number | string, args: Record<string, unknown>, mcpOptions: McpOptions): JsonRpcResponse {
  if (typeof args.markdown !== "string" || typeof args.output_path !== "string") {
    return toolError(id, "markdown and output_path are required strings")
  }
  try {
    const output = mcpOptions.trustedLocal ? resolve(args.output_path) : safeOutputPath(args.output_path)
    const pdf = mcpOptions.trustedLocal
      ? renderPdf(args.markdown, {
          brand: args.brand as RenderOptions["brand"],
          fontPaths: typeof args.fonts_dir === "string" ? [resolve(args.fonts_dir)] : undefined,
          root: typeof args.root === "string" ? resolve(args.root) : undefined,
        })
      : renderPdfCloudSafe(args.markdown, { brand: args.brand }).pdf
    writeFileSync(output, pdf)
    return reply(id, {
      content: [{ type: "text", text: `PDF generated at ${output} (${(pdf.length / 1024).toFixed(1)} KB)` }],
    })
  } catch (error) {
    return toolError(id, (error as Error).message)
  }
}

function handleReadCall(id: number | string, args: Record<string, unknown>, mcpOptions: McpOptions): JsonRpcResponse {
  if (typeof args.pdf_path !== "string") {
    return toolError(id, "pdf_path is a required string")
  }
  try {
    const options: ReadPdfOptions = {
      pages: typeof args.pages === "string" ? args.pages : undefined,
      pageBreaks: args.page_breaks as ReadPdfOptions["pageBreaks"],
      dropHeadersFooters: typeof args.drop_headers_footers === "boolean" ? args.drop_headers_footers : undefined,
    }
    const result = readPdf(mcpOptions.trustedLocal ? resolve(args.pdf_path) : safeInputPath(args.pdf_path), options)
    return reply(id, { content: [{ type: "text", text: result.markdown }] })
  } catch (error) {
    return toolError(id, (error as Error).message)
  }
}

function handleReadHtml(id: number | string, args: Record<string, unknown>): JsonRpcResponse {
  if (typeof args.html !== "string") {
    return toolError(id, "html is a required string")
  }
  try {
    const result = readHtml(args.html, readOptionsFromArgs(args))
    return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] })
  } catch (error) {
    return toolError(id, (error as Error).message)
  }
}

async function handleReadUrl(id: number | string, args: Record<string, unknown>, mcpOptions: McpOptions): Promise<JsonRpcResponse> {
  if (typeof args.url !== "string") {
    return toolError(id, "url is a required string")
  }
  try {
    const result = await readUrl(args.url, {
      ...readOptionsFromArgs(args),
      timeoutMs: optionalBoundedInteger(args, "timeout_ms", MCP_MIN_TIMEOUT_MS, MCP_MAX_TIMEOUT_MS),
      maxBytes: optionalBoundedInteger(args, "max_bytes", 1, MCP_MAX_FETCH_BYTES),
      networkPolicy: mcpOptions.trustedLocal ? "any" : "public",
    })
    return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] })
  } catch (error) {
    return toolError(id, (error as Error).message)
  }
}

function reply(id: number | string, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function toolError(id: number | string | null | undefined, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text: message }], isError: true },
  }
}

export function serveMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, options: McpOptions = {}): void {
  let buffer = ""
  let active = 0
  const send = (response: JsonRpcResponse): void => {
    let serialized = JSON.stringify(response)
    if (Buffer.byteLength(serialized) > MAX_MCP_OUTPUT_BYTES) {
      serialized = JSON.stringify(toolError(response.id as number | string | null | undefined, "MCP response exceeds the 8 MiB limit"))
    }
    output.write(serialized + "\n")
  }
  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > MAX_MCP_FRAME_BYTES) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP frame exceeds the 2 MiB limit" } })
        continue
      }
      if (active >= MAX_MCP_CONCURRENCY) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many concurrent MCP requests" } })
        continue
      }
      active += 1
      void (async () => {
        let response: JsonRpcResponse | null
        try {
          response = await handleMcpRequest(JSON.parse(line) as JsonRpcRequest, options)
        } catch {
          response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
        }
        if (response) send(response)
      })().finally(() => { active -= 1 })
    }
    if (Buffer.byteLength(buffer) > MAX_MCP_FRAME_BYTES) {
      buffer = ""
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP frame exceeds the 2 MiB limit" } })
    }
  })
}
