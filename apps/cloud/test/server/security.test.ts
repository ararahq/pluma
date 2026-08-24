import { describe, expect, it } from "vitest";
import { ReplayCipher, constantTimeEqual, validateIdempotencyKey } from "../../src/server/security/crypto.js";
import { ApiKeyService, type ApiKeyStore } from "../../src/server/security/api-keys.js";
import type { ApiKeyRecord } from "../../src/server/types.js";
import { isPublicAddress, normalizeRemoteUrl, resolvePublicTarget } from "../../src/server/security/ssrf.js";

class MemoryApiKeys implements ApiKeyStore {
  records: ApiKeyRecord[] = [];
  async insert(record: ApiKeyRecord): Promise<void> { this.records.push(record); }
  async findByPrefix(prefix: string): Promise<ApiKeyRecord[]> { return this.records.filter((record) => record.prefix === prefix); }
  async list(accountId: string): Promise<ApiKeyRecord[]> { return this.records.filter((record) => record.accountId === accountId); }
  async revoke(accountId: string, keyId: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.accountId === accountId && candidate.id === keyId && !candidate.revokedAt);
    if (!record) return false;
    record.revokedAt = new Date();
    return true;
  }
  async touch(keyId: string, now: Date): Promise<void> { const record = this.records.find((candidate) => candidate.id === keyId); if (record) record.lastUsedAt = now; }
}

describe("API keys", () => {
  it("stores only a digest and immediately rejects a revoked key", async () => {
    const store = new MemoryApiKeys();
    const service = new ApiKeyService(store, "test-pepper");
    const issued = await service.issue("account-1", "Production", ["render"]);
    expect(issued.secret).toMatch(/^pluma_live_/);
    expect(store.records[0]?.digest).not.toContain(issued.secret);
    expect((await service.authenticate(`Bearer ${issued.secret}`, "render")).accountId).toBe("account-1");
    await service.revoke("account-1", issued.record.id);
    await expect(service.authenticate(`Bearer ${issued.secret}`, "render")).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("enforces operation scopes", async () => {
    const store = new MemoryApiKeys();
    const service = new ApiKeyService(store, "test-pepper");
    const issued = await service.issue("account-1", "Read only", ["read_pdf"]);
    await expect(service.authenticate(`Bearer ${issued.secret}`, "render")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("replay encryption", () => {
  it("encrypts binary responses and supports rotation", () => {
    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const newKey = Buffer.alloc(32, 2).toString("base64");
    const encrypted = new ReplayCipher([oldKey]).encrypt({ status: 200, headers: { "content-type": "application/pdf" }, body: Uint8Array.from([1, 2, 3]) });
    expect(Buffer.from(encrypted).toString()).not.toContain("AQID");
    const decrypted = new ReplayCipher([newKey, oldKey]).decrypt(encrypted);
    expect([...decrypted.body]).toEqual([1, 2, 3]);
  });

  it("requires high-entropy idempotency keys", () => {
    expect(() => validateIdempotencyKey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/128 bits/);
    expect(validateIdempotencyKey("f4d9f586-3832-4b9d-9460-c89b827ead7f")).toContain("f4d9");
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("short", "longer")).toBe(false);
  });
});

describe("SSRF policy", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "192.88.99.1",
    "::1", "100::1", "2001:20::1", "2001:db8::1", "4000::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("rejects credentials and unsafe schemes", () => {
    expect(() => normalizeRemoteUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeRemoteUrl("https://user:password@example.com/")).toThrow();
  });

  it("blocks encoded IPv4 and IPv4-mapped IPv6 literals", async () => {
    await expect(resolvePublicTarget("http://2130706433/")).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(resolvePublicTarget("http://[::ffff:7f00:1]/")).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("fails closed when any DNS answer is private", async () => {
    await expect(resolvePublicTarget("https://example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toMatchObject({ code: "unsafe_url" });
  });

  it("pins a validated public address", async () => {
    const target = await resolvePublicTarget("https://example.com", async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(target.address).toBe("93.184.216.34");
  });
});
