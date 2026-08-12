import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderPdf } from "../dist/src/index.js"

const here = dirname(fileURLToPath(import.meta.url))
const markdown = readFileSync(join(here, "../examples/exemplo.md"), "utf8")
const RUNS = 10

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6

let start = process.hrtime.bigint()
renderPdf(markdown)
const cold = ms(start)

const warm = []
for (let i = 0; i < RUNS; i++) {
  start = process.hrtime.bigint()
  renderPdf(markdown)
  warm.push(ms(start))
}
const warmAvg = warm.reduce((a, b) => a + b) / RUNS

console.log(`pluma cold start:      ${cold.toFixed(0)} ms`)
console.log(`pluma warm (avg/${RUNS}):  ${warmAvg.toFixed(1)} ms`)

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
]
const chrome = CHROME_PATHS.find(existsSync)

if (!chrome) {
  console.log("chrome:                not found, skipping comparison")
  process.exit(0)
}

const html = `<html><body><h1>bench</h1><p>Equivalent document with <b>bold</b>, a table and code.</p>
<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><pre>const a = 1</pre></body></html>`
const htmlPath = join(here, "bench.html")
const { writeFileSync } = await import("node:fs")
writeFileSync(htmlPath, html)

const chromeTimes = []
for (let i = 0; i < 3; i++) {
  start = process.hrtime.bigint()
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--print-to-pdf=${join(here, "bench-chrome.pdf")}`,
    htmlPath,
  ], { stdio: "ignore" })
  chromeTimes.push(ms(start))
}
const chromeAvg = chromeTimes.reduce((a, b) => a + b) / chromeTimes.length

console.log(`chrome headless (avg/3): ${chromeAvg.toFixed(0)} ms`)
console.log(`speedup (warm vs chrome): ${(chromeAvg / warmAvg).toFixed(0)}x`)
