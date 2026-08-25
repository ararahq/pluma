import { cpus, platform, release, totalmem } from "node:os"
import { readHtml, readPdf, renderPdf } from "../dist/src/index.js"

const paragraphs = Number(process.env.PLUMA_BENCH_PARAGRAPHS || 1_000)
const runs = Number(process.env.PLUMA_BENCH_RUNS || 5)
if (!Number.isSafeInteger(paragraphs) || paragraphs < 1 || !Number.isSafeInteger(runs) || runs < 1) throw new Error("Invalid document benchmark configuration")
const markdown = buildMarkdown(paragraphs)
const markdownBytes = Buffer.byteLength(markdown)

const coldStarted = performance.now()
const first = renderPdf(markdown)
const coldMs = performance.now() - coldStarted
const warm = []
for (let run = 0; run < runs; run++) { const started = performance.now(); renderPdf(markdown); warm.push(performance.now() - started) }
const pdfStarted = performance.now()
const recovered = readPdf(first)
const pdfReadMs = performance.now() - pdfStarted
const html = `<main><h1>Dataset report</h1>${Array.from({ length: paragraphs }, (_, index) => `<section><h2>Group ${index}</h2><p>Exact value ${index} with <strong>evidence</strong>.</p></section>`).join("")}</main>`
const htmlStarted = performance.now()
const htmlResult = readHtml(html)
const htmlReadMs = performance.now() - htmlStarted
if (!first.length || !recovered.markdown.includes("Dataset report") || !htmlResult.markdown.includes("Dataset report")) throw new Error("Document round-trip assertion failed")

process.stdout.write(JSON.stringify({
  format: "pluma-document-benchmark", version: 1, createdAt: new Date().toISOString(),
  hardware: { cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem(), platform: platform(), release: release(), node: process.version },
  input: { paragraphs, markdownBytes, htmlBytes: Buffer.byteLength(html) },
  markdownToPdf: { coldElapsedMs: rounded(coldMs), warmRuns: runs, warmMeanMs: rounded(mean(warm)), warmP95Ms: rounded(percentile(warm, .95)), outputBytes: first.byteLength, correct: true },
  pdfToMarkdown: { elapsedMs: rounded(pdfReadMs), outputBytes: Buffer.byteLength(recovered.markdown), pages: recovered.meta.pages, correct: true },
  htmlToMarkdown: { elapsedMs: rounded(htmlReadMs), outputBytes: Buffer.byteLength(htmlResult.markdown), correct: true },
  processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
}) + "\n")

function buildMarkdown(count) { return `---\ntitle: "Dataset report"\nauthor: "Pluma benchmark"\n---\n\n# Dataset report\n\n${Array.from({ length: count }, (_, index) => `## Group ${index}\n\nExact value **${index}** with evidence and a short table.\n\n| id | amount |\n|---:|---:|\n| ${index} | ${(index / 100).toFixed(2)} |`).join("\n\n")}` }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length }
function percentile(values, quantile) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] }
function rounded(value) { return Math.round(value * 100) / 100 }
