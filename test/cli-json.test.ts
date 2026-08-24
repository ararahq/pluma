import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CLI = resolve(import.meta.dir, "../bin/pluma.ts")
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pluma-cli-contract-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function runCli(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function jsonLine(output: string): Record<string, any> {
  const lines = output.trim().split("\n")
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, any>
}

describe("CLI JSON contract", () => {
  it("wraps Markdown render and PDF read successes in ok envelopes", async () => {
    const cwd = temporaryDirectory()
    writeFileSync(join(cwd, "document.md"), "# JSON contract\n\nHello from the Pluma CLI.")

    const rendered = await runCli(["document.md", "--json"], cwd)
    expect(rendered.exitCode).toBe(0)
    expect(jsonLine(rendered.stdout)).toMatchObject({
      ok: true,
      output: "document.pdf",
      bytes: expect.any(Number),
    })
    expect(existsSync(join(cwd, "document.pdf"))).toBe(true)

    const read = await runCli(["document.pdf", "--json"], cwd)
    expect(read.exitCode).toBe(0)
    const envelope = jsonLine(read.stdout)
    expect(envelope.ok).toBe(true)
    expect(envelope.markdown).toContain("JSON contract")
    expect(envelope.meta.pageCount).toBe(1)
    expect(envelope.warnings).toBeArray()
  })

  it("wraps HTML and URL reads while preserving extraction fields", async () => {
    const cwd = temporaryDirectory()
    const html = "<html><head><title>Agent input</title></head><body><main><h1>Agent input</h1><p>Clean document content for an AI agent pipeline.</p></main></body></html>"
    writeFileSync(join(cwd, "page.html"), html)

    const local = await runCli(["page.html", "--json"], cwd)
    expect(local.exitCode).toBe(0)
    expect(jsonLine(local.stdout)).toMatchObject({
      ok: true,
      markdown: expect.stringContaining("Agent input"),
      wordCount: expect.any(Number),
      warnings: expect.any(Array),
    })

    const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) })
    try {
      const remote = await runCli([server.url.toString(), "--trusted-local", "--json"], cwd)
      expect(remote.exitCode).toBe(0)
      expect(jsonLine(remote.stdout)).toMatchObject({
        ok: true,
        markdown: expect.stringContaining("Agent input"),
        wordCount: expect.any(Number),
      })
    } finally {
      server.stop(true)
    }
  })

  it("puts emitted Typst and help inside a single JSON value", async () => {
    const cwd = temporaryDirectory()
    writeFileSync(join(cwd, "source.md"), "# Typeset me")

    const typst = await runCli(["source.md", "--typst", "--json"], cwd)
    expect(typst.exitCode).toBe(0)
    expect(jsonLine(typst.stdout)).toMatchObject({ ok: true, typst: expect.stringContaining("= Typeset me") })

    const help = await runCli(["--help", "--json"], cwd)
    expect(help.exitCode).toBe(0)
    expect(jsonLine(help.stdout)).toMatchObject({ ok: true, help: expect.stringContaining("document I/O") })
  })

  it("keeps errors machine-readable and human file summaries in English", async () => {
    const cwd = temporaryDirectory()
    const invalid = await runCli(["--unknown", "--json"], cwd)
    expect(invalid.exitCode).toBe(2)
    expect(jsonLine(invalid.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining("Unknown argument") } })

    writeFileSync(join(cwd, "page.html"), "<main><p>One two three four.</p></main>")
    const written = await runCli(["page.html", "--output", "page.md"], cwd)
    expect(written.exitCode).toBe(0)
    expect(written.stderr).toMatch(/\(\d+ words\)/)
    expect(written.stderr).not.toContain("palavras")
    expect(readFileSync(join(cwd, "page.md"), "utf8")).toContain("One two three four")
  })
})
