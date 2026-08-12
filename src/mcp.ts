import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderPdf, type RenderOptions } from "./index.js"

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_INFO = { name: "pluma", version: "0.1.0" }

const RENDER_TOOL = {
  name: "render_pdf",
  description:
    "Converte Markdown em um PDF com tipografia profissional, sem browser. " +
    "Aceita frontmatter (title, subtitle, author, date), tabelas GFM, código com highlight, " +
    "diretivas <!-- pagebreak --> e <!-- columns:2 -->...<!-- /columns -->, e blocos ```typst " +
    "para layout livre. A identidade visual (fontes, cores, logo, footer) vai no objeto brand.",
  inputSchema: {
    type: "object",
    properties: {
      markdown: { type: "string", description: "Documento Markdown completo, frontmatter opcional" },
      output_path: { type: "string", description: "Caminho absoluto do PDF de saída" },
      brand: {
        type: "object",
        description:
          'Identidade visual, ex.: {"fonts":{"body":"Geist"},"colors":{"accent":"#0e7490"},' +
          '"logo":{"path":"logo.png"},"footer":"Minha Empresa"}',
      },
      fonts_dir: { type: "string", description: "Diretório com .ttf/.otf das fontes usadas" },
      root: { type: "string", description: "Diretório base para resolver logo e imagens" },
    },
    required: ["markdown", "output_path"],
  },
} as const

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = Record<string, unknown>

export function handleMcpRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  if (request.id === undefined || request.id === null) return null

  switch (request.method) {
    case "initialize":
      return reply(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case "tools/list":
      return reply(request.id, { tools: [RENDER_TOOL] })
    case "tools/call":
      return handleToolCall(request)
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

function handleToolCall(request: JsonRpcRequest): JsonRpcResponse {
  const id = request.id as number | string
  const params = request.params ?? {}
  const name = params.name as string
  if (name !== RENDER_TOOL.name) {
    return toolError(id, `Unknown tool: ${name}. Available: ${RENDER_TOOL.name}`)
  }

  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (typeof args.markdown !== "string" || typeof args.output_path !== "string") {
    return toolError(id, "markdown e output_path são obrigatórios e devem ser strings")
  }

  try {
    const options: RenderOptions = {
      brand: args.brand as RenderOptions["brand"],
      fontPaths: typeof args.fonts_dir === "string" ? [resolve(args.fonts_dir)] : undefined,
      root: typeof args.root === "string" ? resolve(args.root) : undefined,
    }
    const pdf = renderPdf(args.markdown, options)
    const output = resolve(args.output_path)
    writeFileSync(output, pdf)
    return reply(id, {
      content: [{ type: "text", text: `PDF gerado em ${output} (${(pdf.length / 1024).toFixed(1)} KB)` }],
    })
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

export function serveMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  let buffer = ""
  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let response: JsonRpcResponse | null
      try {
        response = handleMcpRequest(JSON.parse(line) as JsonRpcRequest)
      } catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
      }
      if (response) output.write(JSON.stringify(response) + "\n")
    }
  })
}
