#!/usr/bin/env node
import { existsSync, readFileSync, statSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { serveMcp } from "../src/mcp.js"
import {
  renderPdf,
  markdownToTypstSource,
  extractFrontmatter,
  themes,
  readPdf,
  readHtml,
  readUrl,
  type Brand,
  type RenderOptions,
  type ReadPdfOptions,
  type ReadHtmlOptions,
} from "../src/index.js"

const HELP = `pluma — document I/O without a browser

Usage:
  pluma <input.md> [options]                Markdown -> PDF
  pluma <input.pdf> [options]               PDF -> Markdown (<input>.md)
  pluma <input.html|.htm> [options]         HTML -> Markdown (stdout)
  pluma <https://...> [options]             URL -> Markdown (stdout)
  pluma mcp                  start an MCP server (stdio) with the tools
                             render_pdf, read_pdf, read_html, read_url

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
