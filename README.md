# pluma

**Turn Markdown into a document people can send.** Pluma is an open-source document engine for generating branded, production-ready PDFs without Chromium or LaTeX.

Your application or agent already produces Markdown. Pluma turns it into the report, proposal, audit, invoice, or brief your customer actually receives. It renders through [Typst](https://typst.app) with real typography and needs no browser, LaTeX, Python process, external binary, or hosted dependency.

```bash
npm install @ararahq/pluma
```

Built for developers shipping customer-facing deliverables: invoices, proposals, reports, audits, contracts, changelogs — and LLM output, which is already Markdown.

On an M-series Mac, [the included wall-clock benchmark](bench/render.mjs) renders
the example document in about 25 ms after warm-up. Run `npm run bench` on the
machine that will execute your workload: results vary by document and hardware.
When Chrome is installed the script also reports a separate headless-print timing;
it does not claim output parity, process cold-start time, or memory measurements.

## Quickstart

```bash
pluma document.md
```

That's it. `document.pdf` comes out with sensible defaults: A4, justified paragraphs, ruled tables, highlighted code blocks, page numbers. Nothing to configure.

From Node:

```ts
import { renderPdf } from "@ararahq/pluma"
import { writeFileSync } from "node:fs"

const pdf = renderPdf("# Hello\n\nA **bold** start.")
writeFileSync("hello.pdf", pdf)
```

`renderPdf` is synchronous and returns a `Uint8Array` — write it to disk, stream it in an HTTP response, attach it to an email.

## Document metadata

YAML frontmatter becomes the document header:

```markdown
---
title: Commercial proposal
subtitle: Scope and pricing
author: Ana Silva
date: August 2026
---

## First section
```

`title` renders at 24 pt over an accent rule; `subtitle`, `author` and `date` compose the byline. All optional — omit the frontmatter and the document starts at your first heading.

## Your visual identity

Drop a `brand.json` next to your documents:

```json
{
  "$schema": "https://raw.githubusercontent.com/ararahq/pluma/main/schema/brand.schema.json",
  "fonts": { "body": "Geist", "mono": "Geist Mono" },
  "colors": { "accent": "#0e7490", "link": "#0e7490" },
  "logo": { "path": "assets/logo.png", "width": "3.2cm" },
  "footer": "Acme Corp — acme.com"
}
```

```bash
pluma proposal.md
```

No flags needed: pluma auto-discovers `brand.json` next to the input file, and a `fonts/` directory next to it (drop your `.ttf`/`.otf` files there). The logo lands at the top, the accent colors the title rule, the footer shows on every page with automatic page numbers, and the whole document uses your typeface.

Every token is optional and falls back to a clean default:

| Token | Controls |
| --- | --- |
| `fonts.body` / `fonts.heading` / `fonts.mono` | body, heading and code typefaces |
| `fonts.size` | base size in pt (default 10.5) |
| `colors.text` / `muted` / `faint` | text hierarchy |
| `colors.accent` | title rule |
| `colors.link` / `border` / `codeBackground` | links, rules, code blocks |
| `page.paper` / `marginX` / `marginY` | paper size (a4, us-letter, ...) and margins |
| `logo.path` / `logo.width` | header logo |
| `footer` | footer text (page number is automatic) |

The `$schema` line gives you validation and autocomplete in any editor.

Three ways to attach a brand, from most to least specific:

1. `--brand path.json` flag (or `brand:` option in the API)
2. `brand: ./path.json` in the document's frontmatter
3. `brand.json` sitting next to the `.md` file

## Iterating on a document

```bash
pluma proposal.md --watch
```

Recompiles on every save (~50 ms). Keep the PDF open in a viewer that auto-reloads (macOS Preview, most Linux viewers, VS Code) and write.

## Page control

Directives are HTML comments — invisible on GitHub, in editors, everywhere else Markdown renders:

```markdown
<!-- pagebreak -->

## This section starts on a fresh page

<!-- columns:2 -->
This content flows across two balanced columns. Still plain Markdown inside.
<!-- /columns -->
```

## Free-form layout: Typst islands

When Markdown can't express what you need — mixed font sizes in one line, callout boxes, grids — open a `typst` fenced block. Its content goes straight to the engine:

````markdown
```typst
#text(size: 18pt, weight: 700)[Big opener,]
#text(size: 8pt, style: "italic")[ small italic aside.]

#block(fill: rgb("#ecfeff"), radius: 6pt, inset: 12pt)[A callout box.]
```
````

Markdown covers 95% of a document; islands cover the rest with the full [Typst language](https://typst.app/docs). Islands execute layout code — only use them with documents from trusted authors. Regular Markdown text is always escaped and cannot inject code.

## For AI agents

pluma is designed to be driven by LLMs as much as by humans:

- **Built-in MCP server** — `pluma mcp` speaks MCP over stdio and exposes `render_pdf`, `read_pdf`, `read_html`, and `read_url`. Safe mode is the default: document paths stay inside the current working directory, and raw Typst, images, custom font paths, and filesystem roots are rejected. Use `pluma mcp --trusted-local` only for agents and documents you trust. Zero extra dependencies.
- **`--json`** — every completed CLI operation emits one JSON line with
  an `ok: true` envelope while preserving its useful fields. Rendering returns
  `output` and `bytes`; PDF/HTML/URL reads retain `markdown`, metadata, counts,
  links, and warnings; `--typst` returns `typst`. Failures use
  `{"ok":false,"error":{"message":"..."}}`. Watch mode emits one envelope per
  rebuild. Human status text stays on stderr.
- **Forgiving input** — a document wrapped in a ` ```markdown ` fence (a common LLM habit) is unwrapped automatically.
- **[llms.txt](llms.txt)** — the entire library documented in one page for models, shipped inside the npm package (`node_modules/@ararahq/pluma/llms.txt`).
- **[brand JSON Schema](schema/brand.schema.json)** — lets models (and editors) generate valid brand files first try.

Typical AI pipeline, three lines:

```ts
const markdown = await llm.generate(reportPrompt)   // LLMs speak Markdown natively
const pdf = renderPdf(markdown, { brand })          // ~50 ms, no browser
await send(pdf)
```

## Included document readers

PDF, HTML, and URL readers are included for workflows that also need source material as Markdown. They are local utilities, not a claim that Pluma replaces OCR or browser-based extraction platforms.

```ts
import { readPdf, readHtml, readUrl } from "@ararahq/pluma"

const report = readPdf("./report.pdf")
console.log(report.markdown)
console.log(report.meta.pageCount)

const page = readHtml(html, { baseUrl: "https://example.com/post" })
const remote = await readUrl("https://example.com/post", { maxTokens: 4_000 })
```

`readPdf` accepts a path, `Buffer`, or `Uint8Array`. It reconstructs headings, paragraphs, lists, links, tables, page order, and repeated headers/footers from the PDF text layer. `readPdfPages` offers an async page iterator for large files, and `countPdfPages` reads the page tree without decoding page contents.

`readHtml` and `readUrl` extract the main article or page content, preserve semantic structures such as code and tables, resolve relative links, and return title, canonical URL, author, dates, JSON-LD, links, word count, and warnings.

```bash
pluma report.pdf                         # writes report.md
pluma page.html -o page.md              # local HTML to Markdown
pluma https://example.com/post          # fetched page to stdout
pluma report.pdf --pages 1-3 --json     # structured result for an agent
```

Representative JSON results:

```json
{"ok":true,"output":"report.pdf","bytes":18422}
{"ok":true,"markdown":"# Report\n...","meta":{"pageCount":3},"warnings":[]}
{"ok":false,"error":{"message":"Input file does not exist"}}
```

PDF reading requires an existing text layer. It does not perform OCR, decode images, or accept non-empty passwords. Web fetching supports HTTP(S), explicit timeouts, redirect limits, and response-size limits. `readUrl` resolves every redirect hop and permits only public network addresses by default; trusted intranet callers must opt in explicitly with `{ networkPolicy: "any" }` (or `--trusted-local` in the CLI/MCP server).

### Safe hosted rendering

`renderPdf` remains the unrestricted local API, including custom themes, filesystem assets, fonts, and trusted raw Typst islands. Hosted or multi-tenant services should use `renderPdfCloudSafe`: it rejects raw Typst, Markdown images, and filesystem-backed brand fields, validates an allowlisted brand subset, and returns the generated PDF with its exact page count.

```ts
const { pdf, pageCount } = renderPdfCloudSafe(markdown, {
  brand: { colors: { accent: "#0e7490" }, footer: "Acme" },
})
```

## API

```ts
import {
  renderPdf,               // (markdown, options?) => Uint8Array
  renderPdfCloudSafe,      // restricted hosted wrapper => { pdf, pageCount }
  readPdf,                 // PDF path/bytes => Markdown + pages + metadata
  readPdfPages,            // async page iterator
  readHtml,                // HTML string => Markdown + metadata
  readUrl,                 // fetched web page => Markdown + metadata
  markdownToTypstSource,   // (markdown, options?) => string — inspect the generated Typst
  createTheme,             // (brand) => Theme
  normalizeInput,          // strips a wrapping ```markdown fence
} from "@ararahq/pluma"

renderPdf(markdown, {
  brand: { fonts: { body: "Geist" }, footer: "Acme" }, // same shape as brand.json
  fontPaths: ["./fonts"],  // directories with .ttf/.otf files
  root: "./docs",          // base dir for logo and image paths
  meta: { title: "Override frontmatter" },
})
```

Errors are typed: `InvalidBrandError` for bad hex colors or lengths (values are validated, never interpolated raw), `UnknownThemeError` for a bad theme name.

Full control when tokens aren't enough — a theme is just a Typst preamble:

```ts
renderPdf(markdown, {
  theme: {
    name: "compact",
    preamble: (meta) => `#set page(paper: "a5", margin: 1.5cm)\n#set text(size: 9pt)`,
  },
})
```

## CLI reference

```
pluma <input.md> [options]   Markdown -> PDF
pluma <input.pdf> [options] PDF -> Markdown
pluma <input.html> [options] HTML -> Markdown
pluma <https://...> [options] URL -> Markdown
pluma mcp [--trusted-local]  MCP server over stdio (safe by default)

-o, --output <file>          output path (default: <input>.pdf)
-w, --watch                  recompile on save
-b, --brand <file>           brand JSON (overrides discovery)
-f, --fonts <dir>            font directory, repeatable (overrides discovery)
-t, --theme <name>           built-in theme
    --typst                  print generated Typst source instead of compiling
    --pages <range>          PDF pages, for example 1-3,7
    --mode <mode>            HTML mode: article, page, or raw
    --no-images              omit images from HTML/URL Markdown
    --max-tokens <n>         truncate HTML/URL output at a block boundary
    --trusted-local          allow raw Typst/filesystem access in MCP
    --json                   {"ok":...} JSON envelopes on stdout
```

## Markdown support

Headings 1–6, paragraphs, bold / italic / strikethrough, inline and fenced code with syntax highlighting, links, images (paths resolve relative to the document), blockquotes, nested ordered and unordered lists, GFM tables with per-column alignment, horizontal rules. Raw HTML is dropped, except the directives above.

## Requirements

Node 20+ (or Bun). The Typst engine ships as a prebuilt native binding for macOS, Linux and Windows (x64 and arm64) — no install step, no runtime downloads.

## Pluma Cloud

The repository also contains the hosted product: REST API, typed TypeScript SDK, accounts, API keys, page-unit quotas, Stripe billing, dashboard, and an isolated Linux document worker. See the vendor-neutral [deployment runbook](docs/deployment.md). Pluma Cloud v1 deliberately runs as one application replica because admission and rate limits are process-local; Postgres may be managed separately.

## License

MIT © AraraHQ. The HTML article-extraction scoring includes a TypeScript adaptation of Mozilla Readability; see [NOTICE](NOTICE). Example fonts (Geist) are © Vercel under the SIL Open Font License 1.1 — see [examples/fonts/LICENSE-Geist.txt](examples/fonts/LICENSE-Geist.txt).
