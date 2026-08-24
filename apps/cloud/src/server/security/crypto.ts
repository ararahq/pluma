import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import type { StoredResponse } from "../types.js";

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateIdempotencyKey(value: string | undefined): string {
  if (!value || value.length < 22 || value.length > 200 || !/^[A-Za-z0-9._~+\-/=]+$/.test(value)) {
    throw new AppError("idempotency_required", "Idempotency-Key must contain at least 128 bits of caller-generated entropy", 400);
  }
  const isHex128 = /^(?:[a-fA-F0-9]{32,})$/.test(value);
  const isUuid128 = /^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12})$/.test(value);
  const isBase64Url128 = /^[A-Za-z0-9_-]{22,}={0,2}$/.test(value);
  if ((!isHex128 && !isUuid128 && !isBase64Url128) || new Set(value.replaceAll("-", "")).size < 8) {
    throw new AppError("idempotency_required", "Idempotency-Key must contain at least 128 bits of caller-generated entropy", 400);
  }
  return value;
}

interface EncryptedEnvelope {
  version: 1;
  keyId: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class ReplayCipher {
  private readonly keys: Buffer[];

  constructor(base64Keys: string[]) {
    this.keys = base64Keys.map((value) => {
      const decoded = Buffer.from(value, "base64");
      return decoded.byteLength === 32 ? decoded : createHash("sha256").update(value).digest();
    });
    if (this.keys.length === 0) throw new AppError("misconfigured", "At least one replay key is required", 500);
  }

  encrypt(response: StoredResponse): Uint8Array {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.keys[0]!, iv);
    const plaintext = Buffer.from(JSON.stringify({
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("base64"),
    }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      keyId: 0,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope));
  }

  decrypt(data: Uint8Array): StoredResponse {
    try {
      const envelope = JSON.parse(Buffer.from(data).toString("utf8")) as EncryptedEnvelope;
      const candidates = envelope.keyId < this.keys.length
        ? [this.keys[envelope.keyId]!, ...this.keys.filter((_, index) => index !== envelope.keyId)]
        : this.keys;
      for (const key of candidates) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
          decipher.setAuthTag(Buffer.from(envelope.tag, "base64").subarray(0, GCM_TAG_BYTES));
          const decoded = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
          const parsed = JSON.parse(decoded.toString("utf8")) as { status: number; headers: Record<string, string>; body: string };
          return { status: parsed.status, headers: parsed.headers, body: Buffer.from(parsed.body, "base64") };
        } catch {
          continue;
        }
      }
    } catch {
      // The caller receives a generic error; replay content is never exposed.
    }
    throw new AppError("internal_error", "Stored response could not be replayed", 500);
  }
}
