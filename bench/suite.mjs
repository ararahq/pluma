import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const profile = process.env.PLUMA_BENCH_PROFILE || "standard"
if (!["quick", "standard", "giant"].includes(profile)) throw new Error("PLUMA_BENCH_PROFILE must be quick, standard, or giant")
const date = new Date().toISOString().slice(0, 10)
const outputDirectory = join(root, "docs", "benchmarks", `suite-${profile}-${date}`)
mkdirSync(outputDirectory, { recursive: true })

const cases = [
  ...contextCases(profile),
  ...streamCases(profile),
  ...documentCases(profile),
]
const reports = []
for (const item of cases) {
  process.stderr.write(`[bench] ${item.id}\n`)
  const startedAt = new Date().toISOString()
  try {
    const report = await run(item)
    reports.push({ id: item.id, status: "passed", startedAt, report })
    writeFileSync(join(outputDirectory, `${item.id}.json`), JSON.stringify(report, null, 2) + "\n")
  } catch (error) {
    reports.push({ id: item.id, status: "failed", startedAt, error: error instanceof Error ? error.message : String(error) })
    writeFileSync(join(outputDirectory, `${item.id}.failure.json`), JSON.stringify(reports.at(-1), null, 2) + "\n")
    throw error
  }
}

const summary = { format: "pluma-benchmark-suite", version: 1, profile, createdAt: new Date().toISOString(), cases: reports }
writeFileSync(join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
writeFileSync(join(outputDirectory, "README.md"), markdownSummary(summary))
process.stdout.write(JSON.stringify({ outputDirectory, profile, passed: reports.length }) + "\n")

function contextCases(selected) {
  const tiers = selected === "quick" ? [["tiny", 10], ["small", 10_000]] : selected === "standard" ? [["tiny", 10], ["small", 10_000], ["medium", 1_000_000], ["large", 10_000_000]] : [["tiny", 10], ["small", 10_000], ["medium", 1_000_000], ["large", 10_000_000], ["giant", 100_000_000]]
  return tiers.map(([name, rows]) => ({ id: `context-${name}-${rows}`, script: "context.mjs", env: { PLUMA_BENCH_ROWS: String(rows) } }))
}

function streamCases(selected) {
  const cases = [{ id: "stream-formats-small-10000", script: "stream-export.mjs", env: { PLUMA_BENCH_ROWS: "10000", PLUMA_BENCH_FORMATS: "csv,xlsx,parquet" } }]
  if (selected !== "quick") cases.push({ id: "stream-formats-medium-1000000", script: "stream-export.mjs", env: { PLUMA_BENCH_ROWS: "1000000", PLUMA_BENCH_FORMATS: "csv,xlsx,parquet" } })
  if (selected === "giant") cases.push({ id: "stream-formats-large-10000000", script: "stream-export.mjs", env: { PLUMA_BENCH_ROWS: "10000000", PLUMA_BENCH_FORMATS: "csv,parquet" } })
  return cases
}

function documentCases(selected) {
  const cases = [{ id: "documents-small-10", script: "documents-json.mjs", env: { PLUMA_BENCH_PARAGRAPHS: "10", PLUMA_BENCH_RUNS: "5" } }]
  if (selected !== "quick") cases.push({ id: "documents-large-1000", script: "documents-json.mjs", env: { PLUMA_BENCH_PARAGRAPHS: "1000", PLUMA_BENCH_RUNS: "5" } })
  return cases
}

function run(item) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, item.script)], { cwd: root, env: { ...process.env, ...item.env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk) })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code !== 0) { reject(new Error(`${item.id} exited with ${signal ?? code}: ${stderr.slice(-4_000)}`)); return }
      try { resolve(JSON.parse(stdout.trim())) }
      catch (error) { reject(new Error(`${item.id} emitted invalid JSON: ${error instanceof Error ? error.message : error}`)) }
    })
  })
}

function markdownSummary(summary) {
  const lines = [`# Pluma benchmark suite — ${summary.profile}`, "", `Generated: ${summary.createdAt}`, "", "Every row below is backed by an unmodified JSON file in this directory. Peak RSS is the operating-system high-water mark of an isolated child process.", "", "| Case | Rows / input | Compile or render | Peak RSS | Correct |", "| --- | ---: | ---: | ---: | :---: |"]
  for (const item of summary.cases) {
    const report = item.report
    const input = report.input?.rows ?? report.input?.paragraphs ?? "—"
    const elapsed = report.compile?.elapsedMs ?? report.markdownToPdf?.warmMeanMs ?? "—"
    const correct = report.compile?.rowCountCorrect ?? report.markdownToPdf?.correct ?? report.outputs?.every((entry) => entry.correct) ?? false
    lines.push(`| ${item.id} | ${input} | ${elapsed} ms | ${formatBytes(report.processMaxRssBytes)} | ${correct ? "yes" : "no"} |`)
  }
  lines.push("", "## Scope", "", "The suite measures CSV package compilation, indexed/range/materialized/full-scan queries, fixed-token payloads, AsyncIterable/database-style input, CSV/XLSX/Parquet export and re-import, Markdown→PDF, PDF→Markdown, and HTML→Markdown. Unit and security suites separately cover cancellation, checkpoints, tamper detection, resource limits, spreadsheet injection, malformed files, and unsafe hosted input.", "")
  return lines.join("\n")
}

function formatBytes(value) { if (!Number.isFinite(value)) return "—"; return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB` }
