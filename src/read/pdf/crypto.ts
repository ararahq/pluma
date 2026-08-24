/**
 * Standard Security Handler, empty user password only (the overwhelming
 * majority of "protected" PDFs found in the wild only restrict copy/print —
 * the owner password is not needed to read text). Supports RC4 40/128 and
 * AES-128/256 (revisions 2-6) via node:crypto. No external crypto library.
 */
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto"
import {
  dictGet,
  dictGetNum,
  isArray,
  isName,
  latin1BytesToString,
  stringToLatin1Bytes,
  type PdfDict,
} from "./objects.js"

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

export class PdfEncryptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfEncryptedError"
  }
}

export type CryptoAlgorithm = "RC4" | "AESV2" | "AESV3" | "Identity"

export interface DocCrypto {
  algorithm: CryptoAlgorithm
  fileKey: Uint8Array
  encryptMetadata: boolean
}

interface EncryptDict {
  V: number
  R: number
  O: Uint8Array
  U: Uint8Array
  P: number
  length: number
  OE?: Uint8Array
  UE?: Uint8Array
  encryptMetadata: boolean
  cfAlgorithm: CryptoAlgorithm
}

function readEncryptDict(dict: PdfDict): EncryptDict {
  const V = dictGetNum(dict, "V") ?? 0
  const R = dictGetNum(dict, "R") ?? 2
  const O = stringToLatin1Bytes(String(dictGet(dict, "O") ?? ""))
  const U = stringToLatin1Bytes(String(dictGet(dict, "U") ?? ""))
  const P = dictGetNum(dict, "P") ?? 0
  const length = (dictGetNum(dict, "Length") ?? 40) / 8
  const OE = dictGet(dict, "OE")
  const UE = dictGet(dict, "UE")
  const encryptMetadata = dictGet(dict, "EncryptMetadata") !== false

  let cfAlgorithm: CryptoAlgorithm = "RC4"
  if (V >= 4) {
    const cf = dictGet(dict, "CF")
    const stmF = dictGet(dict, "StmF")
    const cfmName =
      cf && typeof cf === "object" && "map" in cf && isName(stmF)
        ? (() => {
            const entry = (cf as PdfDict).map.get(stmF.name)
            if (entry && typeof entry === "object" && "map" in entry) {
              const cfm = (entry as PdfDict).map.get("CFM")
              return isName(cfm) ? cfm.name : undefined
            }
            return undefined
          })()
        : undefined
    if (cfmName === "AESV2") cfAlgorithm = "AESV2"
    else if (cfmName === "AESV3") cfAlgorithm = "AESV3"
    else if (isName(stmF) && stmF.name === "Identity") cfAlgorithm = "Identity"
  }
  if (V === 5) cfAlgorithm = "AESV3"

  return {
    V,
    R,
    O,
    U,
    P,
    length,
    OE: typeof OE === "string" ? stringToLatin1Bytes(OE) : undefined,
    UE: typeof UE === "string" ? stringToLatin1Bytes(UE) : undefined,
    encryptMetadata,
    cfAlgorithm,
  }
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
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

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("md5")
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest())
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest())
}

function int32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff)
}

/** Computes the RC4/AES-128 file key for revisions 2-4 from the empty user password (Algorithm 2). */
function computeFileKeyR234(enc: EncryptDict, idBytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [PAD, enc.O.subarray(0, 32), int32le(enc.P), idBytes]
  if (enc.R >= 4 && !enc.encryptMetadata) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))
  let hash = md5(...parts)
  const keyLength = enc.R === 2 ? 5 : enc.length
  if (enc.R >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLength))
  }
  return hash.subarray(0, keyLength)
}

function validateUserPasswordR234(enc: EncryptDict, idBytes: Uint8Array, fileKey: Uint8Array): void {
  if (enc.U.length < 32) throw new PdfEncryptedError("Encryption dictionary has a truncated /U entry")
  let expected: Uint8Array
  let actual: Uint8Array
  if (enc.R === 2) {
    expected = rc4(fileKey, PAD)
    actual = enc.U.subarray(0, 32)
  } else {
    let encrypted = rc4(fileKey, md5(PAD, idBytes))
    for (let i = 1; i <= 19; i++) {
      encrypted = rc4(fileKey.map((byte) => byte ^ i), encrypted)
    }
    expected = encrypted.subarray(0, 16)
    actual = enc.U.subarray(0, 16)
  }
  if (!safeEqual(actual, expected)) {
    throw new PdfEncryptedError("PDF requires a non-empty user password")
  }
}

/** Computes the AES-256 file key for R5/R6 from the empty user password (ISO 32000-2 Algorithm 2.A). */
function computeFileKeyR56(enc: EncryptDict): Uint8Array {
  if (enc.U.length < 48 || !enc.UE || enc.UE.length !== 32) {
    throw new PdfEncryptedError("Encryption dictionary has invalid AES-256 /U or /UE entries")
  }
  const password = new Uint8Array(0)
  const validationSalt = enc.U.subarray(32, 40)
  const keySalt = enc.U.subarray(40, 48)
  const hash = hash2B(password, validationSalt, new Uint8Array(0), enc.R)
  if (!safeEqual(enc.U.subarray(0, 32), hash)) {
    throw new PdfEncryptedError("PDF requires a non-empty user password")
  }
  const intermediateKey = hash2B(password, keySalt, new Uint8Array(0), enc.R)
  const decipher = createDecipheriv("aes-256-cbc", intermediateKey, new Uint8Array(16))
  decipher.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(enc.UE)), decipher.final()]))
}

/** ISO 32000-2 hash algorithm 2.B (used by R6; R5 is the plain SHA-256 round). */
function hash2B(password: Uint8Array, salt: Uint8Array, userKey: Uint8Array, revision: number): Uint8Array {
  let k = sha256(password, salt, userKey)
  if (revision < 6) return k
  let round = 0
  for (;;) {
    const k1Block = concatAll(password, k, userKey)
    let k1: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    for (let i = 0; i < 64; i++) k1 = concatAll(k1, k1Block)
    const cipher = createCipheriv("aes-128-cbc", Buffer.from(k.subarray(0, 16)), Buffer.from(k.subarray(16, 32)))
    cipher.setAutoPadding(false)
    const e = new Uint8Array(Buffer.concat([cipher.update(Buffer.from(k1)), cipher.final()]))
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    const mod = sum % 3
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e)
    round++
    if (round >= 64 && e[e.length - 1] <= round - 32) break
  }
  return k.subarray(0, 32)
}

function sha384(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha384").update(data).digest())
}
function sha512(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha512").update(data).digest())
}

function concatAll(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export function readDocCrypto(encryptDict: PdfDict, idFirst: string | undefined): DocCrypto {
  const enc = readEncryptDict(encryptDict)
  const idBytes = idFirst ? stringToLatin1Bytes(idFirst) : new Uint8Array(0)

  if (enc.R < 2 || enc.R > 6 || ![1, 2, 4, 5].includes(enc.V)) {
    throw new PdfEncryptedError(`Unsupported Standard Security Handler V=${enc.V}, R=${enc.R}`)
  }
  if (enc.O.length < 32 || enc.U.length < 32) {
    throw new PdfEncryptedError("Encryption dictionary has truncated /O or /U entries")
  }

  if (enc.V === 5 || enc.R >= 5) {
    return { algorithm: "AESV3", fileKey: computeFileKeyR56(enc), encryptMetadata: enc.encryptMetadata }
  }
  if (!Number.isSafeInteger(enc.length) || enc.length < 5 || enc.length > 16) {
    throw new PdfEncryptedError(`Invalid encryption key length (${enc.length * 8} bits)`)
  }
  const fileKey = computeFileKeyR234(enc, idBytes)
  validateUserPasswordR234(enc, idBytes, fileKey)
  const algorithm: CryptoAlgorithm = enc.cfAlgorithm === "Identity" ? "Identity" : enc.cfAlgorithm
  return { algorithm, fileKey, encryptMetadata: enc.encryptMetadata }
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function objectKey(crypto: DocCrypto, num: number, gen: number): Uint8Array {
  if (crypto.algorithm === "AESV3") return crypto.fileKey
  const extra = crypto.algorithm === "AESV2" ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0)
  const material = concatAll(
    crypto.fileKey,
    Uint8Array.of(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff),
    Uint8Array.of(gen & 0xff, (gen >> 8) & 0xff),
    extra,
  )
  const hash = md5(material)
  const keyLength = Math.min(16, crypto.fileKey.length + 5)
  return hash.subarray(0, keyLength)
}

export function decryptBytes(crypto: DocCrypto, num: number, gen: number, data: Uint8Array): Uint8Array {
  if (crypto.algorithm === "Identity") return data
  const key = objectKey(crypto, num, gen)
  if (crypto.algorithm === "RC4") return rc4(key, data)

  // AES: first 16 bytes are the IV, CBC mode, PKCS#7 padding.
  if (data.length < 16) return new Uint8Array(0)
  const iv = data.subarray(0, 16)
  const ciphertext = data.subarray(16)
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return new Uint8Array(0)
  try {
    const algo = crypto.algorithm === "AESV3" ? "aes-256-cbc" : "aes-128-cbc"
    const decipher = createDecipheriv(algo, key, iv)
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]))
  } catch {
    return new Uint8Array(0)
  }
}

export function decryptString(crypto: DocCrypto, num: number, gen: number, value: string): string {
  const bytes = decryptBytes(crypto, num, gen, stringToLatin1Bytes(value))
  return latin1BytesToString(bytes)
}

export function firstDocId(trailerId: unknown): string | undefined {
  if (isArray(trailerId as never)) {
    const first = (trailerId as { items: unknown[] }).items[0]
    return typeof first === "string" ? first : undefined
  }
  return undefined
}
