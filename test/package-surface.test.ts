import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

describe("published package surface", () => {
  it("should ship only JSON Schemas that the docs reference", () => {
    const docs = read("README.md") + read("llms.txt")
    const schemas = readdirSync(join(root, "schema"))
    expect(schemas.length).toBeGreaterThan(0)
    for (const schema of schemas) expect(docs).toContain(`schema/${schema}`)
  })

  it("should point every node script at a file that exists", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    for (const command of Object.values(scripts)) {
      for (const [, path] of command.matchAll(/\bnode ([\w./-]+\.m?js)\b/g)) {
        if (path.startsWith("dist/")) continue
        expect(existsSync(join(root, path))).toBe(true)
      }
    }
  })
})
