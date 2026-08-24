import { describe, expect, it } from "vitest";
import { resolveClientIp } from "../../src/server/security/proxy.js";

describe("trusted proxy client IP", () => {
  it("ignores forwarded headers when no proxy is trusted", () => {
    expect(resolveClientIp("10.0.0.8", "198.51.100.10", 0)).toBe("10.0.0.8");
  });

  it("uses the final XFF address behind one trusted proxy", () => {
    expect(resolveClientIp("10.0.0.8", "198.51.100.10", 1)).toBe("198.51.100.10");
    expect(resolveClientIp("10.0.0.8", "203.0.113.9, 198.51.100.10", 1)).toBe("198.51.100.10");
  });

  it("falls back to the direct peer for missing or malformed addresses", () => {
    expect(resolveClientIp("10.0.0.8", "attacker-controlled", 1)).toBe("10.0.0.8");
    expect(resolveClientIp("10.0.0.8", "198.51.100.10", 2)).toBe("10.0.0.8");
  });
});
