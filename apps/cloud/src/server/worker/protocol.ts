import type { CloudBrand } from "../validation.js";

export type WorkerOperation = "render" | "read_html" | "read_pdf" | "sandbox_probe";

export interface WorkerRequest {
  version: 1;
  requestId: string;
  operation: WorkerOperation;
  inputBase64: string;
  sourceUrl?: string;
  brand?: CloudBrand;
  limits: {
    maxOutputBytes: number;
    maxPages: number;
  };
}

export interface WorkerSuccess {
  version: 1;
  ok: true;
  outputBase64: string;
  contentType: string;
  units: number;
  pageCount?: number;
  warnings: string[];
  meta?: Record<string, unknown>;
}

export interface WorkerFailure {
  version: 1;
  ok: false;
  code: "invalid_input" | "unsupported_pdf" | "scanned_pdf" | "document_too_large" | "render_failure" | "internal_error";
  message: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

export function parseWorkerResponse(output: Uint8Array): WorkerResponse {
  const parsed = JSON.parse(Buffer.from(output).toString("utf8")) as Record<string, unknown>;
  if (parsed.version !== 1 || typeof parsed.ok !== "boolean") throw new Error("Invalid worker response");
  if (parsed.ok) {
    if (typeof parsed.outputBase64 !== "string" || typeof parsed.contentType !== "string" || typeof parsed.units !== "number" || !Array.isArray(parsed.warnings)) {
      throw new Error("Invalid worker success response");
    }
  } else if (typeof parsed.code !== "string" || typeof parsed.message !== "string") {
    throw new Error("Invalid worker failure response");
  }
  return parsed as unknown as WorkerResponse;
}
