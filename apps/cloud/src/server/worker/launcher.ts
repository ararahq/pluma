import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type { DocumentResult } from "../types.js";
import { parseWorkerResponse, type WorkerRequest } from "./protocol.js";

const MAX_PROTOCOL_OUTPUT = 48 * 1024 * 1024;

export interface DocumentWorker {
  run(request: WorkerRequest, signal?: AbortSignal): Promise<DocumentResult>;
  selfTest(): Promise<void>;
  close(): Promise<void>;
}

interface WorkerCommand { command: string; args: string[]; cwd: string }

function productionCommand(config: AppConfig, workDirectory: string): WorkerCommand {
  const worker = resolve(config.workerEntry);
  const workerDirectory = dirname(worker);
  const compilerScope = resolve(process.cwd(), "node_modules/@myriaddreamin");
  const bundledFonts = resolve(process.cwd(), "examples/fonts");
  const bwrap = [
    "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--dir", "/runtime", "--ro-bind", workerDirectory, "/runtime",
    "--dir", "/node_modules", "--dir", "/node_modules/@myriaddreamin", "--ro-bind", compilerScope, "/node_modules/@myriaddreamin",
    "--dir", "/etc", "--ro-bind-try", "/etc/fonts", "/etc/fonts",
    "--dir", "/fonts", "--ro-bind-try", bundledFonts, "/fonts",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workDirectory, "/work", "--chdir", "/work",
    "--setenv", "NODE_ENV", "production", "--setenv", "NODE_PATH", "/node_modules",
    process.execPath, `/runtime/${basename(worker)}`,
  ];
  return {
    command: "prlimit",
    args: ["--as=805306368", "--cpu=20", "--nproc=32", "--fsize=50331648", "--nofile=64", "--", "bwrap", ...bwrap],
    cwd: "/",
  };
}

function developmentCommand(config: AppConfig): WorkerCommand {
  if (!config.unsafeDevWorker) throw new AppError("worker_unavailable", "Unsafe development worker mode is disabled", 503);
  const entry = resolve(config.workerEntry);
  return { command: process.execPath, args: entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry], cwd: process.cwd() };
}

export class ChildDocumentWorker implements DocumentWorker {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;

  constructor(private readonly config: AppConfig) {}

  async selfTest(): Promise<void> {
    if (this.config.environment !== "production") {
      if (!this.config.unsafeDevWorker) throw new AppError("worker_unavailable", "Set PLUMA_UNSAFE_DEV_WORKER=true for local document execution", 503);
      return;
    }
    for (const command of ["prlimit", "bwrap"]) {
      const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 });
      if (probe.status !== 0) throw new AppError("worker_unavailable", `${command} is required for production document isolation`, 503);
    }
    const result = await this.run({
      version: 1,
      requestId: "startup-self-test",
      operation: "render",
      inputBase64: Buffer.from("# Sandbox self-test").toString("base64"),
      limits: { maxOutputBytes: 1024 * 1024, maxPages: 2 },
    });
    if (result.contentType !== "application/pdf" || Buffer.from(result.body.subarray(0, 5)).toString("ascii") !== "%PDF-") {
      throw new AppError("worker_unavailable", "Production worker sandbox self-test failed", 503);
    }
    const probe = await this.run({
      version: 1,
      requestId: "startup-sandbox-probe",
      operation: "sandbox_probe",
      inputBase64: "",
      limits: { maxOutputBytes: 16 * 1024, maxPages: 1 },
    });
    if (probe.meta?.hostReadBlocked !== true || probe.meta?.networkBlocked !== true) {
      throw new AppError("worker_unavailable", "Production worker sandbox isolation is incomplete", 503);
    }
  }

  async run(request: WorkerRequest, signal?: AbortSignal): Promise<DocumentResult> {
    if (this.closing) throw new AppError("worker_unavailable", "Document workers are shutting down", 503);
    const workDirectory = await mkdtemp(resolve(tmpdir(), "pluma-job-"));
    try {
      const command = this.config.environment === "production" ? productionCommand(this.config, workDirectory) : developmentCommand(this.config);
      const output = await this.spawnOne(command, request, signal);
      let response: ReturnType<typeof parseWorkerResponse>;
      try {
        response = parseWorkerResponse(output);
      } catch (cause) {
        throw new AppError("worker_unavailable", "Document worker returned an invalid response", 503, { cause });
      }
      if (!response.ok) {
        const status = response.code === "invalid_input" ? 400
          : response.code === "document_too_large" ? 413
          : response.code === "internal_error" ? 500
          : 422;
        throw new AppError(response.code, response.message, status);
      }
      const body = Buffer.from(response.outputBase64, "base64");
      return { body, contentType: response.contentType, units: response.units, pageCount: response.pageCount, warnings: response.warnings, meta: response.meta };
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  private spawnOne(command: WorkerCommand, request: WorkerRequest, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_OPTIONS: "--max-old-space-size=512" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (error?: Error, data?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.children.delete(child);
        if (error) reject(error); else resolvePromise(data ?? new Uint8Array());
      };
      const abort = (): void => {
        child.kill("SIGKILL");
        finish(new AppError("worker_unavailable", "Document operation was cancelled", 499));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new AppError("upstream_timeout", "Document operation timed out", 504));
      }, this.config.workerTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_PROTOCOL_OUTPUT) {
          child.kill("SIGKILL");
          finish(new AppError("document_too_large", "Worker output exceeded the hard limit", 413));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > 64 * 1024) child.kill("SIGKILL");
      });
      child.once("error", (cause) => finish(new AppError("worker_unavailable", "Document worker could not start", 503, { cause })));
      child.once("exit", (code, signalName) => {
        if (settled) return;
        if (code !== 0) {
          finish(new AppError("render_failure", "Document worker failed", 422, { details: { exit_code: code, signal: signalName } }));
          return;
        }
        finish(undefined, Buffer.concat(stdout));
      });
      child.stdin.once("error", (cause) => {
        finish(new AppError("worker_unavailable", "Document worker input failed", 503, { cause }));
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const child of this.children) child.kill("SIGTERM");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    for (const child of this.children) child.kill("SIGKILL");
  }
}
