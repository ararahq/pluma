import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("container deployment contract", () => {
  it("uses the runtime PORT for health checks and ships license notices", async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, "../../../../Dockerfile"), "utf8");
    expect(dockerfile).toContain("ENV PORT=8787");
    expect(dockerfile).toContain("process.env.PORT||8787");
    expect(dockerfile).toContain("/app/LICENSE /app/NOTICE");
    expect(dockerfile).toContain("/app/THIRD_PARTY_LICENSES");
  });

  it("warms Stripe without coupling document availability to provider startup", async () => {
    const entry = await readFile(resolve(import.meta.dirname, "../../src/server/index.ts"), "utf8");
    expect(entry).toContain("void validateBillingCatalogAtStartup(billing).catch");
    expect(entry).not.toContain("await validateBillingCatalogAtStartup(billing)");
  });
});
