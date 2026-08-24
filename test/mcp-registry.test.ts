import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  mcpName: string;
  bin: Record<string, string>;
  files: string[];
};
const serverJson = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  packages: Array<Record<string, unknown>>;
};

describe("MCP Registry metadata", () => {
  test("stays aligned with the publishable npm package", () => {
    expect(serverJson.name).toBe(packageJson.mcpName);
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages).toHaveLength(1);
    expect(serverJson.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: packageJson.name,
      version: packageJson.version,
      transport: { type: "stdio" },
      packageArguments: [{ type: "positional", value: "mcp" }],
    });
    expect(packageJson.bin).toHaveProperty("pluma");
    expect(packageJson.files).toContain("server.json");
  });
});
