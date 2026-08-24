import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { ChildDocumentWorker } from "../../src/server/worker/launcher.js";

describe("child worker launcher", () => {
  it("turns a closed stdin pipe into a controlled worker failure", async () => {
    const config = loadConfig({ NODE_ENV: "test", PLUMA_UNSAFE_DEV_WORKER: "true", PLUMA_WORKER_TIMEOUT_MS: "1000" });
    config.workerEntry = fileURLToPath(new URL("./fixtures/closed-stdin-worker.mjs", import.meta.url));
    const worker = new ChildDocumentWorker(config);
    await expect(worker.run({
      version: 1,
      requestId: "epipe-test",
      operation: "read_html",
      inputBase64: Buffer.alloc(8 * 1024 * 1024, 65).toString("base64"),
      limits: { maxOutputBytes: 1024, maxPages: 1 },
    })).rejects.toMatchObject({ code: expect.stringMatching(/worker_unavailable|render_failure|internal_error/) });
    await worker.close();
  });
});
