import http from "node:http";
import https from "node:https";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { AppError } from "../errors.js";
import { resolvePublicTarget, type Resolver } from "./ssrf.js";

export interface PinnedHttpOptions {
  redirects: number;
  compressedBytes: number;
  decodedBytes: number;
  timeoutMs: number;
  resolver?: Resolver;
  signal?: AbortSignal;
}

export interface FetchedHtml {
  bytes: Uint8Array;
  finalUrl: URL;
  redirects: number;
}

function boundedDecompress(
  fn: typeof gunzip,
  bytes: Buffer,
  maximumBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => fn(bytes, { maxOutputLength: maximumBytes }, (error, result) => error ? reject(error) : resolve(result)));
}

async function decode(bytes: Buffer, encoding: string | undefined, maximumBytes: number): Promise<Buffer> {
  if (!encoding || encoding === "identity") return bytes;
  if (encoding === "gzip") return boundedDecompress(gunzip, bytes, maximumBytes);
  if (encoding === "br") return boundedDecompress(brotliDecompress, bytes, maximumBytes);
  if (encoding === "deflate") return boundedDecompress(inflate, bytes, maximumBytes);
  throw new AppError("invalid_input", "Unsupported upstream content encoding", 415);
}

export async function fetchPinnedHtml(rawUrl: string, options: PinnedHttpOptions): Promise<FetchedHtml> {
  let current = rawUrl;
  const deadline = Date.now() + options.timeoutMs;
  for (let redirect = 0; redirect <= options.redirects; redirect += 1) {
    const beforeResolve = deadline - Date.now();
    if (beforeResolve <= 0) throw new AppError("upstream_timeout", "URL request timed out", 504);
    const target = await awaitWithDeadline(resolvePublicTarget(current, options.resolver), beforeResolve, options.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError("upstream_timeout", "URL request timed out", 504);
    const result = await requestPinnedOnce(target.url, target.address, target.family, { ...options, timeoutMs: remaining });
    if (result.redirect) {
      if (redirect === options.redirects) throw new AppError("unsafe_url", "URL exceeded the redirect limit", 400);
      const next = new URL(result.redirect, target.url);
      if (target.url.protocol === "https:" && next.protocol === "http:") throw new AppError("unsafe_url", "HTTPS redirects may not downgrade to HTTP", 400);
      current = next.href;
      continue;
    }
    return { bytes: result.bytes!, finalUrl: target.url, redirects: redirect };
  }
  throw new AppError("unsafe_url", "URL exceeded the redirect limit", 400);
}

function awaitWithDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError("worker_unavailable", "URL request was cancelled", 499));
      return;
    }
    const timeout = setTimeout(() => reject(new AppError("upstream_timeout", "URL request timed out", 504)), timeoutMs);
    const abort = (): void => reject(new AppError("worker_unavailable", "URL request was cancelled", 499));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); resolve(value); },
      (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function requestPinnedOnce(url: URL, address: string, family: 4 | 6, options: PinnedHttpOptions): Promise<{ bytes?: Uint8Array; redirect?: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AppError("worker_unavailable", "URL request was cancelled", 499));
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    let terminalError: AppError | undefined;
    const request = transport.request(url, {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, br, deflate", "User-Agent": "PlumaBot/1.0 (+https://pluma.dev)" },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          (callback as unknown as (error: null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(null, [{ address, family }]);
          return;
        }
        (callback as unknown as (error: null, value: string, valueFamily: 4 | 6) => void)(null, address, family);
      },
      servername: url.hostname,
      timeout: options.timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 500;
      const discard = (error?: unknown, value?: { bytes?: Uint8Array; redirect?: string }): void => {
        finish(error, value);
        response.destroy();
        request.destroy();
      };
      if (status >= 300 && status < 400 && response.headers.location) {
        discard(undefined, { redirect: response.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        discard(new AppError("invalid_input", `Upstream returned HTTP ${status}`, 422));
        return;
      }
      const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
        discard(new AppError("invalid_input", "URL did not return HTML", 415));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > options.compressedBytes) {
        discard(new AppError("document_too_large", "Compressed URL response exceeds the limit", 413));
        return;
      }
      const chunks: Buffer[] = [];
      let compressed = 0;
      response.on("data", (chunk: Buffer) => {
        compressed += chunk.byteLength;
        if (compressed > options.compressedBytes) {
          response.destroy(new AppError("document_too_large", "Compressed URL response exceeds the limit", 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", async () => {
        try {
          const decoded = await decode(Buffer.concat(chunks), response.headers["content-encoding"], options.decodedBytes);
          if (decoded.byteLength > options.decodedBytes) throw new AppError("document_too_large", "Decoded URL response exceeds the limit", 413);
          finish(undefined, { bytes: decoded });
        } catch (error) {
          finish(error);
        }
      });
      response.on("error", (error) => finish(error));
    });
    const absoluteTimeout = setTimeout(() => {
      const error = new AppError("upstream_timeout", "URL request timed out", 504);
      terminalError = error;
      request.destroy(error);
      finish(error);
    }, options.timeoutMs);
    const abort = (): void => {
      const error = new AppError("worker_unavailable", "URL request was cancelled", 499);
      terminalError = error;
      request.destroy(error);
      finish(error);
    };
    const finish = (error?: unknown, value?: { bytes?: Uint8Array; redirect?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimeout);
      options.signal?.removeEventListener("abort", abort);
      const effectiveError = terminalError ?? error;
      if (effectiveError) reject(effectiveError instanceof AppError ? effectiveError : new AppError("upstream_timeout", "URL request failed", 502, { cause: effectiveError }));
      else resolve(value ?? {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    request.once("timeout", () => {
      const error = new AppError("upstream_timeout", "URL request timed out", 504);
      terminalError = error;
      request.destroy(error);
      finish(error);
    });
    request.once("error", (error) => finish(error));
    request.end();
  });
}
