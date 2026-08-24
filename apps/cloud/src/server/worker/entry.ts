import type { WorkerFailure, WorkerRequest, WorkerResponse } from "./protocol.js";
import { readFile } from "node:fs/promises";

async function readStdin(maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBytes) throw new Error("Worker request exceeds its hard limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function failure(code: WorkerFailure["code"], message: string): WorkerFailure {
  return { version: 1, ok: false, code, message };
}

async function execute(request: WorkerRequest): Promise<WorkerResponse> {
  if (request.operation === "sandbox_probe") return sandboxProbe();
  const core = await import("@ararahq/pluma") as Record<string, unknown>;
  const input = Buffer.from(request.inputBase64, "base64");
  if (request.operation === "render") {
    const renderPdfCloudSafe = core.renderPdfCloudSafe;
    if (typeof renderPdfCloudSafe !== "function") return failure("internal_error", "Cloud-safe renderer is unavailable");
    const rendered = await renderPdfCloudSafe(input.toString("utf8"), { brand: mapCloudBrand(request.brand) }) as { pdf: Uint8Array; pageCount: number };
    const pdf = rendered.pdf;
    if (pdf.byteLength > request.limits.maxOutputBytes) return failure("document_too_large", "Generated PDF exceeds the output limit");
    const pageCount = rendered.pageCount;
    if (pageCount > request.limits.maxPages) return failure("document_too_large", "Generated PDF exceeds the page limit");
    return { version: 1, ok: true, outputBase64: Buffer.from(pdf).toString("base64"), contentType: "application/pdf", units: Math.max(1, pageCount), pageCount, warnings: [] };
  }
  const functionName = request.operation === "read_html" ? "readHtml" : "readPdf";
  const reader = core[functionName];
  if (typeof reader !== "function") return failure("internal_error", `${functionName} is unavailable`);
  const value = await reader(
    request.operation === "read_html" ? input.toString("utf8") : input,
    request.operation === "read_html" && request.sourceUrl ? { baseUrl: request.sourceUrl } : undefined,
  ) as {
    markdown?: unknown; meta?: Record<string, unknown>; warnings?: Array<string | { code?: string }>; pages?: unknown[];
  };
  if (typeof value.markdown !== "string") return failure("internal_error", "Reader returned an invalid result");
  const markdownBytes = Buffer.from(value.markdown, "utf8");
  if (markdownBytes.byteLength > request.limits.maxOutputBytes) return failure("document_too_large", "Generated Markdown exceeds the output limit");
  const warnings = [...new Set((value.warnings ?? []).map((warning) => warningCode(typeof warning === "string" ? warning : warning.code ?? "")))];
  const pageCount = Array.isArray(value.pages) ? value.pages.length : typeof value.meta?.pageCount === "number" ? value.meta.pageCount : undefined;
  if (request.operation === "read_pdf" && pageCount && pageCount > request.limits.maxPages) {
    return failure("document_too_large", "PDF page count exceeds the remaining quota");
  }
  if (warnings.includes("scanned_pdf") && value.markdown.trim().length === 0) return failure("scanned_pdf", "The PDF has no usable text layer");
  const units = request.operation === "read_html" ? Math.max(1, Math.ceil(input.byteLength / (100 * 1024))) : Math.max(1, pageCount ?? 1);
  return { version: 1, ok: true, outputBase64: markdownBytes.toString("base64"), contentType: "text/markdown; charset=utf-8", units, pageCount, warnings, meta: value.meta };
}

function warningCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("no text layer") || normalized.includes("image-only") || normalized.includes("scanned")) return "scanned_pdf";
  if (normalized.includes("xref") || normalized.includes("corrupt") || normalized.includes("linear scan")) return "recovered_pdf";
  if (normalized.includes("truncat")) return "truncated";
  if (normalized.includes("fallback") || normalized.includes("candidate scored")) return "extraction_fallback";
  return "document_warning";
}

async function sandboxProbe(): Promise<WorkerResponse> {
  let hostReadBlocked = false;
  let networkBlocked = false;
  try { await readFile("/etc/passwd"); } catch { hostReadBlocked = true; }
  try { await fetch("https://example.com", { signal: AbortSignal.timeout(1_000) }); } catch { networkBlocked = true; }
  const output = Buffer.from(JSON.stringify({ hostReadBlocked, networkBlocked }));
  return {
    version: 1, ok: true, outputBase64: output.toString("base64"), contentType: "application/json",
    units: 0, warnings: [], meta: { hostReadBlocked, networkBlocked },
  };
}

function mapCloudBrand(brand: WorkerRequest["brand"]): Record<string, unknown> | undefined {
  if (!brand) return undefined;
  const bodyFont = brand.bodyFont === "geist" ? "Geist" : undefined;
  const headingFont = brand.headingFont === "geist" ? "Geist" : undefined;
  const monoFont = brand.monoFont === "geist-mono" ? "Geist Mono" : undefined;
  return {
    colors: {
      ...(brand.primaryColor ? { accent: brand.primaryColor } : {}),
      ...(brand.secondaryColor ? { link: brand.secondaryColor } : {}),
    },
    page: {
      ...(brand.paper ? { paper: brand.paper === "letter" ? "us-letter" : brand.paper } : {}),
      ...(brand.marginMm ? { marginX: `${brand.marginMm}mm`, marginY: `${brand.marginMm}mm` } : {}),
    },
    fonts: {
      ...(bodyFont ? { body: bodyFont } : {}),
      ...(headingFont ? { heading: headingFont } : {}),
      ...(monoFont ? { mono: monoFont } : {}),
    },
    ...(brand.footerText ? { footer: brand.footerText } : {}),
  };
}

try {
  const raw = await readStdin(36 * 1024 * 1024);
  const request = JSON.parse(raw.toString("utf8")) as WorkerRequest;
  if (request.version !== 1 || typeof request.requestId !== "string" || typeof request.inputBase64 !== "string") {
    process.stdout.write(JSON.stringify(failure("invalid_input", "Invalid worker request")));
  } else {
    try {
      process.stdout.write(JSON.stringify(await execute(request)));
    } catch (error) {
      process.stdout.write(JSON.stringify(mapFailure(error, request.operation)));
    }
  }
} catch {
  process.stdout.write(JSON.stringify(failure("invalid_input", "Invalid worker request")));
}

function mapFailure(error: unknown, operation: WorkerRequest["operation"]): WorkerFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "UnsafeRenderInputError" || name === "InvalidBrandError") return failure("invalid_input", "Render input is not allowed in Pluma Cloud");
  if (name === "PdfLimitError" || name === "HtmlLimitError") return failure("document_too_large", "Document exceeds the hosted processing limit");
  if (name === "PdfEncryptedError" || name === "PdfParseError" || name === "PdfStructureError") return failure("unsupported_pdf", "PDF is encrypted, malformed, or unsupported");
  if (operation === "render") return failure("render_failure", "Document could not be rendered");
  return failure("internal_error", "Document could not be read");
}
