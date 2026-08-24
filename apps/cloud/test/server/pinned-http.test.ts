import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { requestPinnedOnce } from "../../src/server/security/pinned-http.js";

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test server address"));
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
    else reject(error);
  }));
}

const baseOptions = { redirects: 0, compressedBytes: 1024, decodedBytes: 1024, timeoutMs: 50 };

describe("pinned HTTP client", () => {
  it.each([
    { status: 302, headers: { Location: "/next", "Content-Type": "text/html" }, outcome: "redirect" },
    { status: 404, headers: { "Content-Type": "text/html" }, outcome: "error" },
  ])("closes discarded $status response bodies immediately", async ({ status, headers, outcome }) => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
    const server = createServer((request, response) => {
      response.writeHead(status, headers);
      const interval = setInterval(() => response.write("never-ending"), 5);
      request.socket.once("close", () => { clearInterval(interval); closed(); });
    });
    const port = await listen(server);
    try {
      const operation = requestPinnedOnce(new URL(`http://example.test:${port}/`), "127.0.0.1", 4, { ...baseOptions, timeoutMs: 500 });
      if (outcome === "redirect") await expect(operation).resolves.toEqual({ redirect: "/next" });
      else await expect(operation).rejects.toMatchObject({ status: 422 });
      await expect(Promise.race([
        connectionClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])).resolves.toBe(true);
    } finally {
      await close(server);
    }
  });

  it("enforces an absolute deadline against drip responses", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      const interval = setInterval(() => response.write("x"), 10);
      response.once("close", () => clearInterval(interval));
    });
    const port = await listen(server);
    try {
      await expect(requestPinnedOnce(new URL(`http://example.test:${port}/`), "127.0.0.1", 4, baseOptions)).rejects.toMatchObject({
        code: "upstream_timeout",
        status: 504,
      });
    } finally {
      await close(server);
    }
  });

  it("propagates caller cancellation and closes the pinned request", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write("waiting");
    });
    const port = await listen(server);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try {
      await expect(requestPinnedOnce(new URL(`http://example.test:${port}/`), "127.0.0.1", 4, {
        ...baseOptions,
        timeoutMs: 1_000,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "worker_unavailable", status: 499 });
    } finally {
      await close(server);
    }
  });
});
