import { describe, expect, it } from "bun:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
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
 * Hand-builds a PDF encrypted with the Standard Security Handler using
 * AES-128 (V4/R4, /CFM AESV2), empty user password — same key-derivation
 * math as the RC4 case (Algorithm 2/1), just with the content stream AES-CBC
 * encrypted instead of RC4-streamed, proving crypto.ts's AES branch and the
 * V>=4 /CF /StmF lookup both work end to end.
 */
function buildAesFixture(): Uint8Array {
  const id = latin1Bytes("FEDCBA9876543210")
  const permissions = -44
  const keyLength = 16 // 128-bit

  const ownerKey = md5(PAD).subarray(0, keyLength)
  // Owner password entry with an empty owner password: RC4-derived per spec,
  // but since only its bytes (not its own decryption) feed Algorithm 2, a
  // simple RC4 with the owner key over the padded user password is enough.
  const o = rc4(ownerKey, PAD)

  let fileKey = md5(PAD, o, int32le(permissions), id).subarray(0, keyLength)
  for (let i = 0; i < 50; i++) fileKey = md5(fileKey).subarray(0, keyLength)

  const u = computeU(fileKey, id)

  function objectKey(num: number, gen: number): Uint8Array {
    const material = new Uint8Array(fileKey.length + 5 + 4)
    material.set(fileKey, 0)
    material[fileKey.length] = num & 0xff
    material[fileKey.length + 1] = (num >> 8) & 0xff
    material[fileKey.length + 2] = (num >> 16) & 0xff
    material[fileKey.length + 3] = gen & 0xff
    material[fileKey.length + 4] = (gen >> 8) & 0xff
    material.set(Uint8Array.of(0x73, 0x41, 0x6c, 0x54), fileKey.length + 5)
    const hash = md5(material)
    return hash.subarray(0, Math.min(16, fileKey.length + 5))
  }

  const plaintext = "(AES encrypted content)Tj"
  const streamText = `BT /F1 24 Tf 20 750 Td ${plaintext} ET`
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(objectKey(4, 0)), iv)
  const encryptedBody = Buffer.concat([cipher.update(Buffer.from(streamText, "latin1")), cipher.final()])
  const encryptedStream = Uint8Array.from(Buffer.concat([iv, encryptedBody]))

  const objects: string[] = []
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ` +
    `/Resources << /Font << /F1 5 0 R >> >> >>`
  objects[4] = "STREAM"
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`
  objects[6] =
    `<< /Filter /Standard /V 4 /R 4 /Length 128 ` +
    `/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF ` +
    `/O (${octalEscape(o)}) /U (${octalEscape(u)}) /P ${permissions} >>`

  let out = "%PDF-1.6\n"
  const offsets: number[] = [0]
  for (let i = 1; i <= 6; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1")
    if (objects[i] === "STREAM") {
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

/** Algorithm 5 (R3/R4 U entry): RC4/MD5-chained over pad+ID, iterated 19 more times with derived keys. */
function computeU(fileKey: Uint8Array, id: Uint8Array): Uint8Array {
  const hash = md5(PAD, id)
  let encrypted = rc4(fileKey, hash)
  for (let i = 1; i <= 19; i++) {
    const roundKey = fileKey.map((b) => b ^ i)
    encrypted = rc4(roundKey, encrypted)
  }
  const padded = new Uint8Array(32)
  padded.set(encrypted, 0)
  return padded
}

describe("Standard Security Handler — AES-128 (V4/R4), empty password (hand-built fixture)", () => {
  it("should decrypt the AES-CBC content stream and read the plaintext back", () => {
    const pdf = buildAesFixture()
    const result = readPdf(pdf)
    expect(result.meta.encrypted).toBe(true)
    expect(result.markdown).toContain("AES encrypted content")
  })
})
