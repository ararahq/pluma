import { AppError } from "./errors.js";

const MAX_JSON_BYTES = 512 * 1024;
const MAX_MARKDOWN_BYTES = 500 * 1024;
const MAX_BRAND_BYTES = 16 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const TEXT_FONT_NAMES = new Set(["geist"]);
const MONO_FONT_NAMES = new Set(["geist-mono"]);
const PAPER_NAMES = new Set(["a4", "letter"]);
const COLOR = /^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;

export interface CloudBrand {
  primaryColor?: string;
  secondaryColor?: string;
  paper?: "a4" | "letter";
  marginMm?: number;
  footerText?: string;
  bodyFont?: string;
  headingFont?: string;
  monoFont?: string;
}

export interface RenderInput {
  markdown: string;
  brand?: CloudBrand;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new AppError("invalid_input", `Unknown field: ${unknown[0]}`, 400);
}

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
    throw new AppError("invalid_input", `${field} must be a non-empty string of at most ${max} bytes`, 400);
  }
  return value;
}

function font(value: unknown, field: string, allowed: Set<string>): string | undefined {
  const parsed = boundedString(value, field, 64);
  if (parsed !== undefined && !allowed.has(parsed)) throw new AppError("invalid_input", `${field} is not a bundled font`, 400);
  return parsed;
}

function parseBrand(value: unknown): CloudBrand | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw new AppError("invalid_input", "brand must be an object", 400);
  exactKeys(value, ["primaryColor", "secondaryColor", "paper", "marginMm", "footerText", "bodyFont", "headingFont", "monoFont"]);
  const primaryColor = boundedString(value.primaryColor, "brand.primaryColor", 9);
  const secondaryColor = boundedString(value.secondaryColor, "brand.secondaryColor", 9);
  if (primaryColor && !COLOR.test(primaryColor)) throw new AppError("invalid_input", "brand.primaryColor must be a hex color", 400);
  if (secondaryColor && !COLOR.test(secondaryColor)) throw new AppError("invalid_input", "brand.secondaryColor must be a hex color", 400);
  const paper = boundedString(value.paper, "brand.paper", 16);
  if (paper && !PAPER_NAMES.has(paper)) throw new AppError("invalid_input", "brand.paper must be a4 or letter", 400);
  if (value.marginMm !== undefined && (typeof value.marginMm !== "number" || !Number.isFinite(value.marginMm) || value.marginMm < 5 || value.marginMm > 50)) {
    throw new AppError("invalid_input", "brand.marginMm must be between 5 and 50", 400);
  }
  const brand: CloudBrand = {
    primaryColor,
    secondaryColor,
    paper: paper as CloudBrand["paper"],
    marginMm: value.marginMm as number | undefined,
    footerText: boundedString(value.footerText, "brand.footerText", 200),
    bodyFont: font(value.bodyFont, "brand.bodyFont", TEXT_FONT_NAMES),
    headingFont: font(value.headingFont, "brand.headingFont", TEXT_FONT_NAMES),
    monoFont: font(value.monoFont, "brand.monoFont", MONO_FONT_NAMES),
  };
  if (Buffer.byteLength(JSON.stringify(brand), "utf8") > MAX_BRAND_BYTES) throw new AppError("invalid_input", "brand exceeds 16 KiB", 400);
  return brand;
}

export function parseRenderInput(bytes: Uint8Array, demo = false): RenderInput {
  const maxJson = demo ? 24 * 1024 : MAX_JSON_BYTES;
  if (bytes.byteLength > maxJson) throw new AppError("document_too_large", `JSON body exceeds ${maxJson} bytes`, 413);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new AppError("invalid_input", "Request body must be valid JSON", 400);
  }
  if (!plainObject(value)) throw new AppError("invalid_input", "Request body must be an object", 400);
  exactKeys(value, ["markdown", "brand", "sample"]);
  const markdown = boundedString(value.markdown, "markdown", demo ? 20 * 1024 : MAX_MARKDOWN_BYTES);
  if (!markdown) throw new AppError("invalid_input", "markdown is required", 400);
  if (/^```\s*typst\b/im.test(markdown)) throw new AppError("invalid_input", "Raw Typst fences are not supported by the hosted renderer", 400);
  return { markdown, brand: parseBrand(value.brand) };
}

export function parseUrlInput(bytes: Uint8Array): { url: string } {
  if (bytes.byteLength > 4 * 1024) throw new AppError("invalid_input", "URL request is too large", 400);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new AppError("invalid_input", "Request body must be valid JSON", 400);
  }
  if (!plainObject(value)) throw new AppError("invalid_input", "Request body must be an object", 400);
  exactKeys(value, ["url"]);
  const url = boundedString(value.url, "url", 2_048);
  if (!url) throw new AppError("invalid_input", "url is required", 400);
  return { url };
}

export function validateHtml(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) throw new AppError("invalid_input", "HTML body is empty", 400);
  if (bytes.byteLength > MAX_HTML_BYTES) throw new AppError("document_too_large", "HTML body exceeds 5 MiB", 413);
  return bytes;
}

export function validatePdf(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) throw new AppError("invalid_input", "PDF body is empty", 400);
  if (bytes.byteLength > MAX_PDF_BYTES) throw new AppError("document_too_large", "PDF body exceeds 25 MiB", 413);
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new AppError("unsupported_pdf", "The body is not a supported PDF", 400);
  return bytes;
}

export async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maximumBytes) throw new AppError("document_too_large", "Request body exceeds the endpoint limit", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new AppError("document_too_large", "Request body exceeds the endpoint limit", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export const BODY_LIMITS = { json: MAX_JSON_BYTES, html: MAX_HTML_BYTES, pdf: MAX_PDF_BYTES } as const;
