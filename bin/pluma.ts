#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { serveMcp } from "../src/mcp.js"
import { createInterface } from "node:readline"
import {
  renderPdf,
  markdownToTypstSource,
  extractFrontmatter,
  themes,
  readPdf,
  readHtml,
  readUrl,
  compileContext,
  compileRows,
  openContext,
  exportWorkbook,
  type Brand,
  type RenderOptions,
  type ReadPdfOptions,
  type ReadHtmlOptions,
  type ContextRow,
  type ContextField,
  type XlsxExportOptions,
} from "../src/index.js"

const HELP = `pluma — document I/O without a browser

Usage:
  pluma <input.md> [options]                Markdown -> PDF
  pluma <input.pdf> [options]               PDF -> Markdown (<input>.md)
  pluma <input.html|.htm> [options]         HTML -> Markdown (stdout)
  pluma <https://...> [options]             URL -> Markdown (stdout)
  pluma mcp                  start an MCP server (stdio) with the tools
                             render_pdf, read_pdf, read_html, read_url
  pluma context compile <file> -o <dataset.pluma>
  pluma context compile-stream <schema.json> -o <dataset.pluma> < rows.ndjson
  pluma context inspect <dataset.pluma> [--view schema]
  pluma context explain <dataset.pluma> --plan <query.json>
  pluma context query <dataset.pluma> --plan <query.json>
  pluma context export <dataset.pluma> --format csv|xlsx|parquet -o <file>
  pluma workbook <descriptor.json> [-o workbook.xlsx]

Options (Markdown -> PDF):
  -o, --output <file>      PDF output path (default: <input>.pdf)
  -w, --watch              recompile on every save
  -t, --theme <name>       built-in theme (${Object.keys(themes).join(", ")})
  -b, --brand <file>       brand JSON (fonts, colors, logo, footer)
  -f, --fonts <dir>        font directory (repeatable)
      --typst              emit Typst source instead of compiling

Options (HTML/URL -> Markdown):
  -o, --output <file>      Markdown output path (default: stdout)
      --mode <mode>        article (default) | page | raw
      --no-images          omit images from Markdown
      --max-tokens <n>     truncate at a block boundary near n tokens

Options (PDF -> Markdown):
  -o, --output <file>      Markdown output path (default: <input>.md)
      --pages <range>      select pages (for example: 1-3,7)

Common:
      --json               machine-readable JSON envelopes on stdout
      --trusted-local      allow private-network URLs and raw Typst/filesystem access in MCP
  -h, --help               show this help

Input type is detected automatically from the extension or URL scheme.

Zero-config conventions:
  brand.json next to the Markdown input is discovered automatically; frontmatter
  can point to another file with "brand: ./path.json". A fonts/ directory next
  to the Markdown or brand file is discovered automatically.
`

const WATCH_DEBOUNCE_MS = 80

interface CliArgs {
  input?: string
  output?: string
  theme?: string
  brandFile?: string
  fontPaths: string[]
  watch: boolean
  emitTypst: boolean
  json: boolean
  help: boolean
  pages?: string
  mode?: "article" | "page" | "raw"
  noImages?: boolean
  maxTokens?: number
  trustedLocal?: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fontPaths: [],
    watch: false,
    emitTypst: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") args.help = true
    else if (arg === "-w" || arg === "--watch") args.watch = true
    else if (arg === "--typst") args.emitTypst = true
    else if (arg === "--json") args.json = true
    else if (arg === "--no-images") args.noImages = true
    else if (arg === "--trusted-local") args.trustedLocal = true
    else if (arg === "-o" || arg === "--output") args.output = argv[++i]
    else if (arg === "-t" || arg === "--theme") args.theme = argv[++i]
    else if (arg === "-b" || arg === "--brand") args.brandFile = argv[++i]
    else if (arg === "-f" || arg === "--fonts") args.fontPaths.push(argv[++i])
    else if (arg === "--pages") args.pages = argv[++i]
    else if (arg === "--mode") args.mode = argv[++i] as CliArgs["mode"]
    else if (arg === "--max-tokens") args.maxTokens = Number.parseInt(argv[++i], 10)
    else if (!arg.startsWith("-") && !args.input) args.input = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

export function isUrlInput(input: string): boolean {
  return /^https?:\/\//i.test(input)
}

export function isHtmlInput(input: string): boolean {
  return /\.html?$/i.test(input)
}

export function isPdfInput(input: string): boolean {
  return extname(input).toLowerCase() === ".pdf"
}

export type InputKind = "write" | "read-pdf" | "read-html"

export function detectInputKind(input: string): InputKind {
  if (isUrlInput(input) || isHtmlInput(input)) return "read-html"
  if (isPdfInput(input)) return "read-pdf"
  return "write"
}

export interface ResolvedRun {
  options: RenderOptions
  brandPath?: string
}

export function resolveRun(args: CliArgs, markdown: string, inputPath: string): ResolvedRun {
  const inputDir = dirname(resolve(inputPath))
  const { brandPath: frontmatterBrand } = extractFrontmatter(markdown)

  const brandPath = args.brandFile
    ? resolve(args.brandFile)
    : frontmatterBrand
      ? resolve(inputDir, frontmatterBrand)
      : firstExisting([join(inputDir, "brand.json")])

  const fontPaths = [...args.fontPaths.map((p) => resolve(p))]
  if (fontPaths.length === 0) {
    const conventionDirs = [join(inputDir, "fonts")]
    if (brandPath) conventionDirs.push(join(dirname(brandPath), "fonts"))
    for (const dir of conventionDirs) {
      if (isDirectory(dir) && !fontPaths.includes(dir)) fontPaths.push(dir)
    }
  }

  return {
    brandPath,
    options: {
      theme: args.theme,
      brand: brandPath ? loadBrand(brandPath) : undefined,
      fontPaths,
      root: brandPath ? dirname(brandPath) : inputDir,
    },
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p))
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

function loadBrand(path: string): Brand {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Brand
  } catch (error) {
    throw new Error(`Could not read brand file at ${path}: ${(error as Error).message}`)
  }
}

type WriteSuccess = { output: string; bytes: number } | { typst: string }

function compileOnce(args: CliArgs, inputPath: string): WriteSuccess {
  const markdown = readFileSync(inputPath, "utf8")
  const { options } = resolveRun(args, markdown, inputPath)

  if (args.emitTypst) {
    const typst = markdownToTypstSource(markdown, options)
    if (!args.json) process.stdout.write(typst)
    return { typst }
  }

  const output = args.output ?? inputPath.replace(/\.(md|markdown)$/i, "") + ".pdf"
  const pdf = renderPdf(markdown, options)
  writeFileSync(output, pdf)
  process.stderr.write(`${basename(output)} (${(pdf.length / 1024).toFixed(1)} KB)\n`)
  return { output, bytes: pdf.length }
}

function readPdfOnce(args: CliArgs, inputPath: string): void {
  const options: ReadPdfOptions = { pages: args.pages }
  const result = readPdf(inputPath, options)

  if (args.json) {
    writeJsonSuccess(result)
    return
  }

  const output = args.output ?? inputPath.replace(/\.pdf$/i, "") + ".md"
  writeFileSync(output, result.markdown, "utf8")
  process.stderr.write(
    `${basename(output)} (${result.meta.pageCount} page(s), ${result.warnings.length} warning(s))\n`,
  )
}

function readOptionsFrom(args: CliArgs): ReadHtmlOptions {
  return {
    mode: args.mode,
    images: args.noImages ? false : undefined,
    maxTokens: args.maxTokens,
    frontMatter: true,
  }
}

async function compileRead(args: CliArgs, input: string): Promise<void> {
  const options = readOptionsFrom(args)
  const result = isUrlInput(input)
    ? await readUrl(input, { ...options, networkPolicy: args.trustedLocal ? "any" : "public" })
    : readHtml(readFileSync(input, "utf8"), { ...options, baseUrl: `file://${resolve(input)}` })

  if (args.json) {
    writeJsonSuccess(result)
    return
  }
  if (args.output) {
    writeFileSync(args.output, result.markdown)
    process.stderr.write(`${basename(args.output)} (${result.wordCount} words)\n`)
  } else {
    process.stdout.write(result.markdown)
  }
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
}

function watchLoop(args: CliArgs, inputPath: string): void {
  const recompile = () => {
    try {
      const result = compileOnce(args, inputPath)
      if (args.json) writeJsonSuccess(result)
    } catch (error) {
      if (args.json) writeJsonError((error as Error).message)
      else process.stderr.write(`error: ${(error as Error).message}\n`)
    }
  }
  recompile()

  const watched = new Set([resolve(inputPath)])
  const { brandPath } = resolveRun(args, readFileSync(inputPath, "utf8"), inputPath)
  if (brandPath) watched.add(brandPath)

  let timer: ReturnType<typeof setTimeout> | undefined
  for (const file of watched) {
    watch(file, () => {
      clearTimeout(timer)
      timer = setTimeout(recompile, WATCH_DEBOUNCE_MS)
    })
  }
  process.stderr.write(`watching ${watched.size} file(s) — press ctrl+c to stop\n`)
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "context") return runContext(argv.slice(1))
  if (argv[0] === "workbook") return runWorkbook(argv.slice(1))
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (argv.includes("--json")) writeJsonError((error as Error).message)
    else process.stderr.write(`${(error as Error).message}\n\n${HELP}`)
    return 2
  }
  if (args.help) {
    if (args.json) writeJsonSuccess({ help: HELP })
    else process.stdout.write(HELP)
    return 0
  }
  if (!args.input) {
    if (args.json) writeJsonError("An input file, URL, or the mcp command is required")
    else process.stdout.write(HELP)
    return 2
  }

  if (args.input === "mcp") {
    if (args.json) {
      writeJsonError("--json cannot be combined with the MCP stdio server")
      return 2
    }
    serveMcp(process.stdin, process.stdout, { trustedLocal: args.trustedLocal })
    return -1
  }

  try {
    const kind = detectInputKind(args.input)
    if (kind === "read-pdf") {
      readPdfOnce(args, args.input)
      return 0
    }
    if (kind === "read-html") {
      await compileRead(args, args.input)
      return 0
    }
    if (args.watch) {
      watchLoop(args, args.input)
      return -1
    }
    const result = compileOnce(args, args.input)
    if (args.json) writeJsonSuccess(result)
    return 0
  } catch (error) {
    if (args.json) {
      writeJsonError((error as Error).message)
    } else {
      process.stderr.write(`${(error as Error).message}\n`)
    }
    return 1
  }
}

async function runWorkbook(argv: string[]): Promise<number> {
  const descriptorPath = argv[0]
  const outputIndex = Math.max(argv.indexOf("-o"), argv.indexOf("--output"))
  const json = argv.includes("--json")
  try {
    if (!descriptorPath) throw new Error("Usage: pluma workbook <descriptor.json> [-o workbook.xlsx]")
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { output?: unknown; relations?: unknown }
    if (!Array.isArray(descriptor.relations) || !descriptor.relations.length) throw new Error("descriptor.relations must be a non-empty array")
    const root = dirname(resolve(descriptorPath))
    const relations = descriptor.relations.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every workbook relation must be an object")
      const relation = value as { name?: unknown; fields?: unknown; source?: unknown; xlsx?: unknown }
      if (typeof relation.name !== "string" || !Array.isArray(relation.fields) || typeof relation.source !== "string") throw new Error("Every workbook relation requires name, fields, and an NDJSON source")
      return { name: relation.name, fields: relation.fields as ContextField[], rows: readNdjsonFile(resolve(root, relation.source)), xlsx: relation.xlsx as XlsxExportOptions | undefined }
    })
    const output = outputIndex >= 0 ? argv[outputIndex + 1] : typeof descriptor.output === "string" ? resolve(root, descriptor.output) : resolve(root, "workbook.xlsx")
    if (!output) throw new Error("Workbook output is required")
    await exportWorkbook({ relations, output })
    writeJsonSuccess({ output })
    return 0
  } catch (error) {
    if (json) writeJsonError((error as Error).message)
    else process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

async function* readNdjsonFile(path: string): AsyncGenerator<ContextRow> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Every NDJSON line in ${path} must be an object`)
    yield value as ContextRow
  }
}

async function runContext(argv: string[]): Promise<number> {
  const [command, input] = argv
  const value = (flag: string): string | undefined => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined }
  const json = argv.includes("--json")
  try {
    if (!command || !input) throw new Error("Usage: pluma context <compile|compile-stream|inspect|explain|query|export> <input>")
    const resourceBudget = {
      memoryBytes: optionalPositiveFlag(value("--memory-bytes")),
      spillBytes: optionalNonNegativeFlag(value("--spill-bytes")),
      timeoutMs: optionalPositiveFlag(value("--timeout-ms")),
    }
    if (command === "compile") {
      const output = value("-o") ?? value("--output") ?? `${resolve(input)}.pluma`
      const indexesPath = value("--indexes")
      const aggregatesPath = value("--aggregates")
      const job = compileContext(input, { output, resourceBudget, indexes: indexesPath ? JSON.parse(readFileSync(indexesPath, "utf8")) : undefined, materializedAggregates: aggregatesPath ? JSON.parse(readFileSync(aggregatesPath, "utf8")) : undefined })
      for await (const event of job.events()) if (!json) process.stderr.write(`${event.state}: ${event.rowsProcessed} rows\n`)
      const manifest = await job.result()
      writeJsonSuccess({ output, manifest })
      return 0
    }
    if (command === "compile-stream") {
      const output = value("-o") ?? value("--output")
      if (!output) throw new Error("--output is required")
      const relation = JSON.parse(readFileSync(input, "utf8"))
      const job = compileRows(readNdjsonRows(), { output, relation, resourceBudget })
      for await (const event of job.events()) if (!json) process.stderr.write(`${event.state}: ${event.rowsProcessed} rows\n`)
      writeJsonSuccess({ output, manifest: await job.result() }); return 0
    }
    const context = openContext(input, { resourceBudget })
    const tokenizerRaw = value("--tokenizer") ?? "o200k_base@1"
    const [id, version] = tokenizerRaw.split("@")
    if ((id !== "o200k_base" && id !== "cl100k_base") || (version ?? "1") !== "1") throw new Error("--tokenizer must be o200k_base@1 or cl100k_base@1")
    const tokenizerId: "o200k_base" | "cl100k_base" = id
    const tokenBudget = Number(value("--token-budget") ?? "8000")
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 256) throw new Error("--token-budget must be an integer of at least 256")
    const budget = { tokenBudget, tokenizer: { id: tokenizerId, version: "1" as const } }
    if (command === "inspect") {
      const payload = context.inspect({ view: value("--view") === "schema" ? "schema" : "overview", ...budget })
      writeJsonSuccess({ payload }); return 0
    }
    if (command === "query") {
      const planPath = value("--plan")
      if (!planPath) throw new Error("--plan <query.json> is required")
      const plan = JSON.parse(readFileSync(planPath, "utf8"))
      const format = value("--format") as "csv" | "xlsx" | "parquet" | undefined
      const output = value("-o") ?? value("--output")
      if (format || output) {
        if (!format || !output) throw new Error("--format and --output must be used together")
        const evidence = await context.exportQuery(plan, { format, output, resourceBudget })
        writeJsonSuccess({ output, evidence }); return 0
      }
      const result = context.query(plan)
      writeJsonSuccess({ payload: result.payload(budget) }); return 0
    }
    if (command === "explain") {
      const planPath = value("--plan")
      if (!planPath) throw new Error("--plan <query.json> is required")
      writeJsonSuccess({ explanation: context.explain(JSON.parse(readFileSync(planPath, "utf8"))) }); return 0
    }
    if (command === "export") {
      const format = value("--format") as "csv" | "xlsx" | "parquet" | undefined
      const output = value("-o") ?? value("--output")
      if (!format || !output) throw new Error("--format and --output are required")
      await context.export({ relation: value("--relation"), format, output })
      writeJsonSuccess({ output }); return 0
    }
    throw new Error(`Unknown context command: ${command}`)
  } catch (error) {
    if (json) writeJsonError((error as Error).message)
    else process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

async function* readNdjsonRows(): AsyncGenerator<ContextRow> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every NDJSON line must be an object")
    yield value as ContextRow
  }
}

function optionalPositiveFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Resource flags must be positive integers")
  return parsed
}

function optionalNonNegativeFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("--spill-bytes must be a non-negative integer")
  return parsed
}

function writeJsonSuccess<T extends object>(fields: T): void {
  process.stdout.write(JSON.stringify({ ok: true, ...fields }) + "\n")
}

function writeJsonError(message: string): void {
  process.stdout.write(JSON.stringify({ ok: false, error: { message } }) + "\n")
}

if (process.argv[1] && /pluma(\.[cm]?[jt]s)?$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code)
  })
}
