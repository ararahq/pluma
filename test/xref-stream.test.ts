import { describe, expect, it } from "bun:test"
import { deflateSync } from "node:zlib"
import { readPdf } from "../src/read/index.js"

/**
 * Hand-builds a minimal but structurally real PDF using the modern
 * cross-reference *stream* (no classic `xref` table at all) with the
 * Catalog/Pages/Page objects packed into a compressed object stream
 * (/ObjStm), plus a plain indirect content stream. Typst (pluma's own
 * writer) always emits the classic table, so this is the only way to
 * exercise xref.ts's stream + object-stream code paths with something
 * closer to what other real-world PDF producers (e.g. recent Ghostscript,
 * qpdf --object-streams=generate) write.
 */
function buildObjStmFixture(): Uint8Array {
  const catalog = "<< /Type /Catalog /Pages 3 0 R >>"
  const pages = "<< /Type /Pages /Kids [4 0 R] /Count 1 >>"
  const page = "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << >> >>"

  const objStmMembers = [
    { num: 2, body: catalog },
    { num: 3, body: pages },
    { num: 4, body: page },
  ]
  let header = ""
  let body = ""
  for (const m of objStmMembers) {
    header += `${m.num} ${body.length} `
    body += m.body + " "
  }
  const objStmContent = header.trimEnd() + "\n" + body
  const objStmCompressed = deflateSync(Buffer.from(objStmContent, "latin1"))

  const chunks: string[] = []
  const offsets = new Map<number, number>()
  let cursor = 0
  const push = (text: string) => {
    chunks.push(text)
    cursor += Buffer.byteLength(text, "latin1")
  }

  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")

  offsets.set(1, cursor)
  push(
    `1 0 obj\n<< /Type /ObjStm /N ${objStmMembers.length} /First ${header.trimEnd().length + 1} ` +
      `/Filter /FlateDecode /Length ${objStmCompressed.length} >>\nstream\n${objStmCompressed.toString(
        "latin1",
      )}\nendstream\nendobj\n`,
  )

  const contentBytes = "" // an empty content stream is enough to prove the page tree resolves
  offsets.set(6, cursor)
  push(`6 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${contentBytes}\nendstream\nendobj\n`)

  const xrefObjNum = 5
  offsets.set(xrefObjNum, cursor)
  const size = 7
  // W = [type(1 byte), field2(2 bytes), field3(1 byte)]
  const entries: number[][] = []
  entries.push([0, 0, 0]) // object 0, free list head
  entries.push([1, offsets.get(1)!, 0]) // object 1: the ObjStm itself
  entries.push([2, 1, 0]) // object 2: compressed in objstm 1, index 0
  entries.push([2, 1, 1]) // object 3: compressed in objstm 1, index 1
  entries.push([2, 1, 2]) // object 4: compressed in objstm 1, index 2
  entries.push([1, offsets.get(xrefObjNum)!, 0]) // object 5: this xref stream
  entries.push([1, offsets.get(6)!, 0]) // object 6: content stream
  const rows: number[] = []
  for (const [type, f2, f3] of entries) rows.push(type, (f2 >> 8) & 0xff, f2 & 0xff, f3)
  const xrefRaw = Uint8Array.from(rows)
  const xrefCompressed = deflateSync(Buffer.from(xrefRaw))

  push(
    `${xrefObjNum} 0 obj\n<< /Type /XRef /Size ${size} /Root 2 0 R /W [1 2 1] ` +
      `/Filter /FlateDecode /Length ${xrefCompressed.length} >>\nstream\n${xrefCompressed.toString(
        "latin1",
      )}\nendstream\nendobj\n`,
  )

  push(`startxref\n${offsets.get(xrefObjNum)}\n%%EOF`)

  return Uint8Array.from(Buffer.from(chunks.join(""), "latin1"))
}

describe("xref streams and object streams (hand-built fixture)", () => {
  it("should resolve the Catalog/Pages/Page tree entirely from compressed objects", () => {
    const pdf = buildObjStmFixture()
    const result = readPdf(pdf)
    expect(result.meta.pageCount).toBe(1)
    expect(result.pages.length).toBe(1)
  })
})
