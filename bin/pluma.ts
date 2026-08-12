#!/usr/bin/env node
import { existsSync, readFileSync, statSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { serveMcp } from "../src/mcp.js"
import {
  renderPdf,
  markdownToTypstSource,
  extractFrontmatter,
  themes,
  type Brand,
  type RenderOptions,
} from "../src/index.js"

const HELP = `pluma — markdown para PDF, sem browser

Uso:
  pluma <entrada.md> [opções]
  pluma mcp                  sobe um servidor MCP (stdio) com a tool render_pdf

Opções:
  -o, --output <arquivo>   caminho do PDF (padrão: <entrada>.pdf)
  -w, --watch              recompila a cada salvamento
  -t, --theme <nome>       tema embutido (${Object.keys(themes).join(", ")})
  -b, --brand <arquivo>    identidade em JSON (fontes, cores, logo, footer)
  -f, --fonts <dir>        diretório de fontes (repetível)
      --typst              emite o fonte Typst em vez de compilar
      --json               resultado em JSON no stdout (pra agentes/scripts)
  -h, --help               mostra esta ajuda

Convenções (zero flag):
  brand.json ao lado do .md é usado automaticamente; o frontmatter pode
  apontar outro com "brand: ./caminho.json". Um diretório fonts/ ao lado
  do .md (ou do brand.json) entra sozinho como fonte de fontes.
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
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { fontPaths: [], watch: false, emitTypst: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") args.help = true
    else if (arg === "-w" || arg === "--watch") args.watch = true
    else if (arg === "--typst") args.emitTypst = true
    else if (arg === "--json") args.json = true
    else if (arg === "-o" || arg === "--output") args.output = argv[++i]
    else if (arg === "-t" || arg === "--theme") args.theme = argv[++i]
    else if (arg === "-b" || arg === "--brand") args.brandFile = argv[++i]
    else if (arg === "-f" || arg === "--fonts") args.fontPaths.push(argv[++i])
    else if (!arg.startsWith("-") && !args.input) args.input = arg
    else throw new Error(`Argumento desconhecido: ${arg}`)
  }
  return args
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
    throw new Error(`Não consegui ler a identidade em ${path}: ${(error as Error).message}`)
  }
}

function compileOnce(args: CliArgs, inputPath: string): string {
  const markdown = readFileSync(inputPath, "utf8")
  const { options } = resolveRun(args, markdown, inputPath)

  if (args.emitTypst) {
    process.stdout.write(markdownToTypstSource(markdown, options))
    return ""
  }

  const output = args.output ?? inputPath.replace(/\.(md|markdown)$/i, "") + ".pdf"
  const pdf = renderPdf(markdown, options)
  writeFileSync(output, pdf)
  process.stderr.write(`${basename(output)} (${(pdf.length / 1024).toFixed(1)} KB)\n`)
  return output
}

function watchLoop(args: CliArgs, inputPath: string): void {
  const recompile = () => {
    try {
      compileOnce(args, inputPath)
    } catch (error) {
      process.stderr.write(`erro: ${(error as Error).message}\n`)
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
  process.stderr.write(`observando ${watched.size} arquivo(s) — ctrl+c pra sair\n`)
}

export function run(argv: string[]): number {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`)
    return 2
  }
  if (args.help || !args.input) {
    process.stdout.write(HELP)
    return args.help ? 0 : 2
  }

  if (args.input === "mcp") {
    serveMcp(process.stdin, process.stdout)
    return -1
  }

  try {
    if (args.watch) {
      watchLoop(args, args.input)
      return -1
    }
    const output = compileOnce(args, args.input)
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, output }) + "\n")
    return 0
  } catch (error) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: { message: (error as Error).message } }) + "\n")
    } else {
      process.stderr.write(`${(error as Error).message}\n`)
    }
    return 1
  }
}

if (process.argv[1] && /pluma(\.[cm]?[jt]s)?$/.test(process.argv[1])) {
  const code = run(process.argv.slice(2))
  if (code >= 0) process.exit(code)
}
