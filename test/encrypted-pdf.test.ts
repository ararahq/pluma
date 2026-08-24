import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readPdf } from "../src/read/index.js"

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

function md5(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("md5")
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = new Uint8Array(data.length)
  let a = 0
  let b = 0
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff
    b = (b + s[a]) & 0xff
    ;[s[a], s[b]] = [s[b], s[a]]
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff]
  }
  return out
}

function int32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff)
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function latin1String(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function octalEscape(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b)
    else if (b < 0x20 || b > 0x7e) out += "\\" + b.toString(8).padStart(3, "0")
    else out += String.fromCharCode(b)
  }
  return out
}

/**
 * Hand-builds a classic-xref-table PDF encrypted with the Standard Security
 * Handler, RC4 40-bit (V=1 R=2), empty user password — the simplest and most
 * common "protected against copying" case found in the wild. Independently
 * re-derives the file key (Algorithm 2) and the O entry the same way a real
 * writer would, then RC4-encrypts the content stream's literal string with
 * the per-object key (Algorithm 1), so the fixture only passes if pluma's
 * crypto.ts computes the identical key and decrypts back to plaintext.
 */
function buildEncryptedFixture(): Uint8Array {
  const id = latin1Bytes("0123456789ABCDEF")
  const permissions = -44 // arbitrary valid /P value (copy/print restricted)
  const keyLength = 5 // 40-bit RC4

  // Owner password entry: since the owner password is also empty here, O is
  // RC4(md5(pad(ownerPw)), pad(userPw)) — both padded empty passwords.
  const ownerKey = md5(PAD).subarray(0, keyLength)
  const o = rc4(ownerKey, PAD)

  // Algorithm 2: file key from the empty user password.
  const fileKey = md5(PAD, o, int32le(permissions), id).subarray(0, keyLength)

  // Algorithm 4 (R2): U = RC4(fileKey, PAD).
  const u = rc4(fileKey, PAD)

  function objectKey(num: number, gen: number): Uint8Array {
    const material = new Uint8Array(fileKey.length + 5)
    material.set(fileKey, 0)
    material[fileKey.length] = num & 0xff
    material[fileKey.length + 1] = (num >> 8) & 0xff
    material[fileKey.length + 2] = (num >> 16) & 0xff
    material[fileKey.length + 3] = gen & 0xff
    material[fileKey.length + 4] = (gen >> 8) & 0xff
    const hash = md5(material)
    return hash.subarray(0, Math.min(16, fileKey.length + 5))
  }

  const plaintext = "(Hello encrypted world)Tj"
  const streamText = `BT /F1 24 Tf 20 750 Td ${plaintext} ET`
  const encryptedStream = rc4(objectKey(4, 0), latin1Bytes(streamText))

  const objects: string[] = []
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ` +
    `/Resources << /Font << /F1 5 0 R >> >> >>`
  objects[4] = `STREAM:${encryptedStream.length}`
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`
  objects[6] =
    `<< /Filter /Standard /V 1 /R 2 /O (${octalEscape(o)}) /U (${octalEscape(u)}) /P ${permissions} >>`

  let out = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (let i = 1; i <= 6; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1")
    if (objects[i].startsWith("STREAM:")) {
      out += `${i} 0 obj\n<< /Length ${encryptedStream.length} >>\nstream\n${latin1String(
        encryptedStream,
      )}\nendstream\nendobj\n`
    } else {
      out += `${i} 0 obj\n${objects[i]}\nendobj\n`
    }
  }
  const xrefOffset = Buffer.byteLength(out, "latin1")
  out += `xref\n0 7\n0000000000 65535 f \n`
  for (let i = 1; i <= 6; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  out +=
    `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [(${octalEscape(id)}) (${octalEscape(id)})] >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`

  return Uint8Array.from(Buffer.from(out, "latin1"))
}

describe("Standard Security Handler — RC4 40-bit, empty password (hand-built fixture)", () => {
  it("should decrypt the content stream and read the plaintext back", () => {
    const pdf = buildEncryptedFixture()
    const result = readPdf(pdf)
    expect(result.meta.encrypted).toBe(true)
    expect(result.markdown).toContain("Hello encrypted world")
  })
})
