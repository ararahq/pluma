import { lstatSync, realpathSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"
import { renderPdf, renderPdfCloudSafe, readPdf, readHtml, readUrl, compileContext, openContext, type RenderOptions, type ReadPdfOptions, type ReadHtmlOptions } from "./index.js"

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_INFO = { name: "pluma", version: "0.4.2" }
const MAX_MCP_FRAME_BYTES = 2 * 1024 * 1024
const MAX_MCP_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_MCP_CONCURRENCY = 8
const MCP_MIN_TIMEOUT_MS = 1_000
const MCP_MAX_TIMEOUT_MS = 30_000
const MCP_DEFAULT_TIMEOUT_MS = 10_000
const MCP_MAX_FETCH_BYTES = 20 * 1024 * 1024
const MCP_DEFAULT_FETCH_BYTES = 20 * 1024 * 1024
const MCP_MAX_TOKENS = 1_000_000

const CONTEXT_TOOLS = [
  { name: "pluma_context_compile", description: "Compile CSV, XLSX, or Parquet into an open .pluma context package with bounded batches.", inputSchema: { type: "object", properties: { input_path: { type: "string" }, output_path: { type: "string" } }, required: ["input_path", "output_path"] } },
  { name: "pluma_context_compile_start", description: "Start a non-blocking local context compile job and return a job ID.", inputSchema: { type: "object", properties: { input_path: { type: "string" }, output_path: { type: "string" } }, required: ["input_path", "output_path"] } },
  { name: "pluma_context_job_inspect", description: "Inspect current state and progressive schema for a local compile job.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "pluma_context_job_cancel", description: "Cancel a running local context compile job.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "pluma_context_inspect", description: "Inspect a committed .pluma package within an exact token budget.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, view: { type: "string", enum: ["overview", "schema"] }, token_budget: { type: "integer", minimum: 256 }, tokenizer: { type: "string", enum: ["cl100k_base", "o200k_base"] } }, required: ["package_path", "token_budget", "tokenizer"] } },
  { name: "pluma_context_sample", description: "Return a deterministic bounded sample with context accounting.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, relation: { type: "string" }, rows: { type: "integer", minimum: 1, maximum: 1000 }, token_budget: { type: "integer", minimum: 256 }, tokenizer: { type: "string", enum: ["cl100k_base", "o200k_base"] } }, required: ["package_path", "token_budget", "tokenizer"] } },
  { name: "pluma_context_query", description: "Execute an exact structured query over a .pluma package and return block-level provenance.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, plan: { type: "object" }, token_budget: { type: "integer", minimum: 256 }, tokenizer: { type: "string", enum: ["cl100k_base", "o200k_base"] } }, required: ["package_path", "plan", "token_budget", "tokenizer"] } },
  { name: "pluma_context_explain", description: "Explain the exact execution strategy, index, candidate blocks, and estimated work before running a query.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, plan: { type: "object" } }, required: ["package_path", "plan"] } },
  { name: "pluma_context_query_export", description: "Execute a structured query directly into CSV, XLSX, or Parquet without materializing the complete result.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, plan: { type: "object" }, output_path: { type: "string" }, format: { type: "string", enum: ["csv", "xlsx", "parquet"] } }, required: ["package_path", "plan", "output_path", "format"] } },
  { name: "pluma_context_export", description: "Stream a committed .pluma relation to CSV, XLSX, or Parquet.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, output_path: { type: "string" }, relation: { type: "string" }, format: { type: "string", enum: ["csv", "xlsx", "parquet"] } }, required: ["package_path", "output_path", "format"] } },
  { name: "pluma_context_pin", description: "Pin a named context view for the current MCP process.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, id: { type: "string" }, value: {} }, required: ["package_path", "id"] } },
  { name: "pluma_context_release", description: "Release a pinned context view.", inputSchema: { type: "object", properties: { package_path: { type: "string" }, id: { type: "string" } }, required: ["package_path", "id"] } },
] as const

const CONTEXT_SESSIONS = new Map<string, ReturnType<typeof openContext>>()
const CONTEXT_JOBS = new Map<string, { job: ReturnType<typeof compileContext>; output: string }>()

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
      return reply(request.id, { tools: [options.trustedLocal ? TRUSTED_RENDER_TOOL : SAFE_RENDER_TOOL, READ_TOOL, READ_HTML_TOOL, READ_URL_TOOL, ...CONTEXT_TOOLS] })
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
    case "pluma_context_compile":
    case "pluma_context_compile_start":
    case "pluma_context_job_inspect":
    case "pluma_context_job_cancel":
    case "pluma_context_inspect":
    case "pluma_context_sample":
    case "pluma_context_query":
    case "pluma_context_explain":
    case "pluma_context_query_export":
    case "pluma_context_export":
    case "pluma_context_pin":
    case "pluma_context_release":
      return handleContextTool(id, name, args, options)
    default:
      return toolError(
        id,
        `Unknown tool: ${name}. Available: ${SAFE_RENDER_TOOL.name}, ${READ_TOOL.name}, ${READ_HTML_TOOL.name}, ${READ_URL_TOOL.name}`,
      )
  }
}

async function handleContextTool(id: number | string, name: string, args: Record<string, unknown>, options: McpOptions): Promise<JsonRpcResponse> {
  try {
    if (name === "pluma_context_job_inspect" || name === "pluma_context_job_cancel") {
      const jobId = String(args.job_id ?? "")
      const current = CONTEXT_JOBS.get(jobId)
      if (!current) throw new Error("Unknown context job_id")
      if (name === "pluma_context_job_cancel") await current.job.cancel()
      const event = await current.job.inspect()
      return reply(id, { content: [{ type: "text", text: JSON.stringify({ job_id: jobId, output: current.output, ...event }) }] })
    }
    const inputPath = typeof args.package_path === "string" ? args.package_path : typeof args.input_path === "string" ? args.input_path : undefined
    if (!inputPath) throw new Error("package_path or input_path is required")
    const packagePath = options.trustedLocal ? resolve(inputPath) : safeInputPath(inputPath)
    if (name === "pluma_context_compile" || name === "pluma_context_compile_start") {
      if (typeof args.output_path !== "string") throw new Error("output_path is required")
      const output = options.trustedLocal ? resolve(args.output_path) : safeNewPath(args.output_path, ".pluma")
      const job = compileContext(packagePath, { output })
      if (name === "pluma_context_compile_start") {
        const jobId = randomUUID()
        CONTEXT_JOBS.set(jobId, { job, output })
        void job.result().catch(() => undefined)
        return reply(id, { content: [{ type: "text", text: JSON.stringify({ job_id: jobId, output, state: "queued" }) }] })
      }
      const manifest = await job.result()
      return reply(id, { content: [{ type: "text", text: JSON.stringify({ output, manifest }) }] })
    }
    const context = CONTEXT_SESSIONS.get(packagePath) ?? openContext(packagePath)
    CONTEXT_SESSIONS.set(packagePath, context)
    const budget = { tokenBudget: Number(args.token_budget), tokenizer: { id: args.tokenizer as "o200k_base" | "cl100k_base", version: "1" as const } }
    let value: unknown
    if (name === "pluma_context_inspect") value = context.inspect({ ...budget, view: args.view === "schema" ? "schema" : "overview" })
    else if (name === "pluma_context_sample") value = context.sample({ ...budget, relation: typeof args.relation === "string" ? args.relation : undefined, rows: typeof args.rows === "number" ? args.rows : undefined })
    else if (name === "pluma_context_query") value = context.query((args.plan ?? {}) as never).payload(budget)
    else if (name === "pluma_context_explain") value = context.explain((args.plan ?? {}) as never)
    else if (name === "pluma_context_query_export") {
      if (typeof args.output_path !== "string" || !["csv", "xlsx", "parquet"].includes(String(args.format))) throw new Error("output_path and valid format are required")
      const output = options.trustedLocal ? resolve(args.output_path) : safeNewPath(args.output_path, `.${args.format}`)
      const evidence = await context.exportQuery((args.plan ?? {}) as never, { format: args.format as "csv" | "xlsx" | "parquet", output })
      value = { output, evidence }
    }
    else if (name === "pluma_context_export") {
      if (typeof args.output_path !== "string" || !["csv", "xlsx", "parquet"].includes(String(args.format))) throw new Error("output_path and valid format are required")
      const output = options.trustedLocal ? resolve(args.output_path) : safeNewPath(args.output_path, `.${args.format}`)
      await context.export({ relation: typeof args.relation === "string" ? args.relation : undefined, format: args.format as "csv" | "xlsx" | "parquet", output })
      value = { output }
    } else if (name === "pluma_context_pin") { context.pin(String(args.id), args.value); value = { pinned: String(args.id) } }
    else { value = { released: context.release(String(args.id)) } }
    return reply(id, { content: [{ type: "text", text: JSON.stringify(value) }] })
  } catch (error) { return toolError(id, error instanceof Error ? error.message : "Context operation failed") }
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

function safeNewPath(input: string, extension: string): string {
  const root = realpathSync(process.cwd())
  const output = resolve(input)
  const parent = realpathSync(dirname(output))
  if (!withinRoot(parent, root) || !output.toLowerCase().endsWith(extension)) throw new Error(`Safe MCP mode writes only ${extension} paths inside the current working directory`)
  return output
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
